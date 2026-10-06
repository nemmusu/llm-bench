import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SystemResponse } from '../../contract/api';
import { AppError } from '../../contract/errors';
import type { Clock, Platform, ProcessRunner } from '../deps';
import { downloadFile } from '../engines/download';
import { ignore, timeoutSignal } from '../engines/util';
import {
  LINUX_SCRIPT,
  LINUX_STEPS,
  USER_NAME_RE,
  linuxDistroSupport,
  linuxInstallArgv,
  runLinuxInstall,
  type LinuxDistroSupport,
} from './docker-linux';
import { readOsRelease, type OsRelease } from './os-release';
import { detectWsl, type WslStatus } from './wsl';
import { launchInteractive, verifyAuthenticode } from './windows';

/** Official Docker Desktop installers (docs.docker.com/desktop/setup/install/windows-install/, tracking query removed). */
export const DOCKER_DESKTOP_URLS: Record<string, string> = {
  x64: 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe',
  arm64: 'https://desktop.docker.com/win/main/arm64/Docker%20Desktop%20Installer.exe',
};
export const INSTALLER_FILE = 'Docker Desktop Installer.exe';

export type DockerState = SystemResponse['docker']['state'];
export type DockerStatusLike = { state: DockerState; version?: string };

export type DockerInstallPlan =
  | { platform: 'win32'; kind: 'docker-desktop'; supported: true; url: string; sizeBytes?: number; wsl: WslStatus }
  | { platform: 'win32'; kind: 'docker-desktop'; supported: false; reason: 'unsupported-arch'; arch: string }
  | ({ platform: 'linux'; kind: 'docker-linux'; steps: readonly string[]; argv?: string[] } & LinuxDistroSupport)
  | { platform: Platform; kind: 'none'; supported: false; reason: 'unsupported-platform' };

export interface DockerInstallProgress {
  stage: string;
  bytesDone: number;
  bytesTotal?: number;
}

export interface DockerInstallResult {
  kind: 'docker-desktop' | 'docker-linux';
  /**
   * installed: done, docker can be started; reboot-maybe-required: the installer asked for a
   * restart or WSL was missing before (Docker enables it); relogin-required: Linux docker
   * group membership needs a new login session.
   */
  outcome: 'installed' | 'reboot-maybe-required' | 'relogin-required';
  exitCode?: number;
  /** Docker state re-checked right after the installer finished. */
  docker?: DockerStatusLike;
}

export interface DockerInstallerOptions {
  platform: Platform;
  arch: string;
  proc: ProcessRunner;
  fetch: typeof globalThis.fetch;
  clock: Clock;
  /** Installer downloads go to cacheDir/docker-installer/<random>/ and are deleted afterwards. */
  cacheDir: string;
  env: Record<string, string | undefined>;
  osRelease?: () => Promise<OsRelease | undefined>;
  /** Login name added to the docker group on Linux (default: os.userInfo()). */
  userName?: () => string;
  /** Re-check after installing (docker module); absent = no re-check. */
  dockerStatus?: () => Promise<DockerStatusLike>;
  /** Tests point this at a local server. */
  installerUrl?: string;
  progressIntervalMs?: number;
  headTimeoutMs?: number;
}

/** Windows installer exit codes that mean "done, restart to finish" (MSI conventions). */
const REBOOT_CODES = new Set([3010, 1641]);
/** User cancelled: ERROR_CANCELLED (UAC "No") and ERROR_INSTALL_USEREXIT. */
const CANCEL_CODES = new Set([1223, 1602]);

/** Guided Docker installation: Docker Desktop on Windows, Docker Engine + NVIDIA toolkit on Ubuntu/Debian. */
export class DockerInstaller {
  constructor(private readonly o: DockerInstallerOptions) {}

  private installerUrl(): string | undefined {
    return this.o.installerUrl ?? DOCKER_DESKTOP_URLS[this.o.arch];
  }

  private user(): string {
    return (this.o.userName ?? (() => os.userInfo().username))();
  }

  private async distro(): Promise<LinuxDistroSupport> {
    return linuxDistroSupport(await (this.o.osRelease ?? (() => readOsRelease()))());
  }

  /** The exact script runLinuxInstall() executes, for the "show commands" panel. */
  linuxScript(): { script: string; steps: readonly string[] } {
    return { script: LINUX_SCRIPT, steps: LINUX_STEPS };
  }

  wslStatus(): Promise<WslStatus> {
    return detectWsl(this.o.proc, this.o.env);
  }

  /** Download size via HEAD (redirects followed); undefined when the server does not say. */
  async installerSize(signal?: AbortSignal): Promise<number | undefined> {
    const url = this.installerUrl();
    if (!url) return undefined;
    const t = timeoutSignal(this.o.headTimeoutMs ?? 15_000, signal);
    try {
      const res = await this.o.fetch(url, { method: 'HEAD', redirect: 'follow', signal: t.signal });
      const n = Number(res.headers.get('content-length'));
      return res.ok && Number.isFinite(n) && n > 0 ? n : undefined;
    } finally {
      t.clear();
    }
  }

  async plan(signal?: AbortSignal): Promise<DockerInstallPlan> {
    const { platform } = this.o;
    if (platform === 'win32') {
      const url = this.installerUrl();
      if (!url) return { platform, kind: 'docker-desktop', supported: false, reason: 'unsupported-arch', arch: this.o.arch };
      const [size, wsl] = await Promise.all([this.installerSize(signal).catch(ignore), this.wslStatus()]);
      return { platform, kind: 'docker-desktop', supported: true, url, ...(size !== undefined ? { sizeBytes: size } : {}), wsl };
    }
    if (platform === 'linux') {
      const support = await this.distro();
      const user = this.user();
      return {
        platform,
        kind: 'docker-linux',
        steps: LINUX_STEPS,
        ...support,
        ...(support.supported && USER_NAME_RE.test(user) ? { argv: linuxInstallArgv(user) } : {}),
      };
    }
    return { platform, kind: 'none', supported: false, reason: 'unsupported-platform' };
  }

  install(progress: (p: DockerInstallProgress) => void, signal: AbortSignal): Promise<DockerInstallResult> {
    if (this.o.platform === 'win32') return this.installWindows(progress, signal);
    if (this.o.platform === 'linux') return this.installLinux(progress, signal);
    return Promise.reject(
      new AppError('DOCKER_UNSUPPORTED', 'Guided Docker install is only available on Windows and Linux', { params: { platform: this.o.platform } }),
    );
  }

  /**
   * Download → Authenticode check (Valid + Docker Inc) → interactive installer → re-check.
   * Nothing downloaded is executed before the signature check passes.
   */
  async installWindows(progress: (p: DockerInstallProgress) => void, signal: AbortSignal): Promise<DockerInstallResult> {
    const url = this.installerUrl();
    if (!url) throw new AppError('DOCKER_UNSUPPORTED', `No Docker Desktop installer for ${this.o.arch}`, { params: { arch: this.o.arch } });
    const wslBefore = await this.wslStatus();
    const dir = path.join(this.o.cacheDir, 'docker-installer', randomBytes(6).toString('hex'));
    const file = path.join(dir, INSTALLER_FILE);
    const interval = this.o.progressIntervalMs ?? 250;
    try {
      let last = -Infinity;
      progress({ stage: 'download', bytesDone: 0 });
      const dl = await downloadFile({
        fetch: this.o.fetch,
        url,
        dest: file,
        signal,
        onProgress: (done, total) => {
          const now = this.o.clock.now();
          if (now - last < interval) return;
          last = now;
          progress({ stage: 'download', bytesDone: done, ...(total !== undefined ? { bytesTotal: total } : {}) });
        },
      });
      progress({ stage: 'verify', bytesDone: dl.bytes, bytesTotal: dl.bytes });
      await verifyAuthenticode(this.o.proc, this.o.env, file);
      if (signal.aborted) throw new AppError('CANCELLED', 'Docker install cancelled');
      progress({ stage: 'installer', bytesDone: dl.bytes, bytesTotal: dl.bytes });
      const res = await launchInteractive(this.o.proc, this.o.env, file, signal);
      const code = res.exitCode ?? res.nativeErrorCode;
      if (code !== undefined && CANCEL_CODES.has(code)) {
        throw new AppError('CANCELLED', 'Docker installer cancelled by the user', { params: { reason: 'user-cancelled', exitCode: code } });
      }
      if (res.exitCode === undefined) {
        throw new AppError('ENGINE_INSTALL_FAILED', `Docker installer did not start: ${res.message ?? 'unknown error'}`, {
          params: { component: 'docker-desktop', reason: 'launch-failed', ...(code !== undefined ? { nativeErrorCode: code } : {}) },
        });
      }
      if (res.exitCode !== 0 && !REBOOT_CODES.has(res.exitCode)) {
        throw new AppError('ENGINE_INSTALL_FAILED', `Docker installer exited with ${res.exitCode}`, {
          params: { component: 'docker-desktop', reason: 'installer-failed', exitCode: res.exitCode },
        });
      }
      const reboot = REBOOT_CODES.has(res.exitCode) || !wslBefore.available;
      const docker = await this.recheck();
      return {
        kind: 'docker-desktop',
        outcome: reboot ? 'reboot-maybe-required' : 'installed',
        exitCode: res.exitCode,
        ...(docker ? { docker } : {}),
      };
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(ignore);
    }
  }

  async installLinux(progress: (p: DockerInstallProgress) => void, signal: AbortSignal): Promise<DockerInstallResult> {
    const support = await this.distro();
    if (!support.supported) {
      throw new AppError('DOCKER_UNSUPPORTED', 'Guided Docker install supports Ubuntu and Debian only', {
        params: { reason: support.reason, distro: support.distro ?? '', docs: support.docs },
      });
    }
    await runLinuxInstall(this.o.proc, this.user(), (p) => progress({ stage: p.stage, bytesDone: p.step, bytesTotal: p.total }), signal);
    const docker = await this.recheck();
    return { kind: 'docker-linux', outcome: 'relogin-required', ...(docker ? { docker } : {}) };
  }

  private async recheck(): Promise<DockerStatusLike | undefined> {
    return this.o.dockerStatus ? this.o.dockerStatus().catch(ignore) : undefined;
  }
}
