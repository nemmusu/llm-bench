import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SystemResponse } from '../../contract/api';
import { AppError, isAppError, type ErrorCode } from '../../contract/errors';
import type { Clock, Logger, Platform } from '../deps';
import type { ContainerOwnership, OwnedRecord } from '../process/ownership';
import { classifyDockerError, envValue, GPUBENCH_LABEL, isOurs, WSL_SHIM, type DockerCli } from './cli';

export type DockerState = SystemResponse['docker']['state'];

export interface DockerStatusDetail {
  state: DockerState;
  /** Server version when reachable, else the CLI version. */
  version?: string;
  clientVersion?: string;
  serverVersion?: string;
  /** "Docker Desktop 4.47.0 (…)" when the daemon is Docker Desktop. */
  platform?: string;
  context?: string;
  /** Why the state is what it is: wsl-integration, podman, windows-containers, gpu-check-failed… */
  reason?: string;
  /** Raw CLI message (expert "Dettagli"). */
  detail?: string;
  /** How long a start we requested has been running (state "starting"). */
  startingForMs?: number;
}

export interface StartProgress {
  state: DockerState;
  elapsedMs: number;
  /** Starting for longer than usual: Docker Desktop may be waiting for the user (terms, sign-in, WSL update). */
  slow: boolean;
  method: 'cli' | 'exe';
}

export interface GpuCheckResult {
  image: string;
  /** "GPU 0: NVIDIA GeForce RTX 5090 (UUID: GPU-…)" lines from nvidia-smi -L inside the container. */
  gpus: string[];
}

export interface DockerEnvironmentOptions {
  cli: DockerCli;
  clock: Clock;
  platform: Platform;
  env: Record<string, string | undefined>;
  log?: Logger;
  /** Starts a GUI program without waiting for it (default: detached child_process.spawn). */
  launchDetached?: (cmd: string, args: string[]) => Promise<void>;
  exists?: (p: string) => Promise<boolean>;
  /** status() result reuse window (the system page polls). Default 2 s. */
  statusMaxAgeMs?: number;
  /** Docker Desktop takes 30–120 s to start; default 180 s. */
  startTimeoutMs?: number;
  startPollMs?: number;
  /** After this long "starting" is reported as slow (default 60 s). */
  slowStartMs?: number;
  gpuCheckTimeoutMs?: number;
}

/** Error code the UI maps to a "what to do" action for a non-running docker state. */
export function codeForState(state: DockerState): ErrorCode | undefined {
  switch (state) {
    case 'running':
      return undefined;
    case 'not-installed':
      return 'DOCKER_NOT_INSTALLED';
    case 'no-permission':
      return 'DOCKER_PERMISSION';
    case 'no-gpu':
      return 'DOCKER_NO_GPU';
    case 'unsupported':
      return 'DOCKER_UNSUPPORTED';
    default:
      return 'DOCKER_NOT_RUNNING';
  }
}

/** Launches a program detached from us (it must outlive the core) and returns once it was spawned. */
export function defaultLaunchDetached(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/** Docker Desktop executables, per-machine install first (both layouts exist in the wild). */
export function desktopExecutables(env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  const pf = envValue(env, 'ProgramFiles', 'win32');
  const local = envValue(env, 'LOCALAPPDATA', 'win32');
  if (pf) out.push(path.win32.join(pf, 'Docker', 'Docker', 'Docker Desktop.exe'));
  if (local) out.push(path.win32.join(local, 'Programs', 'DockerDesktop', 'Docker Desktop.exe'));
  return out;
}

const NO_DESKTOP_PLUGIN = /'desktop' is not a docker command|unknown command:? "?desktop/i;

/**
 * Docker state machine: not installed → stopped ([Start Docker Desktop]) → starting → running
 * → no GPU (guide) / Podman or Windows containers (unsupported in v1). Detection goes through
 * the docker CLI, which follows the same context/DOCKER_HOST rules as the user's terminal.
 */
export class DockerEnvironment {
  private cached: { at: number; value: DockerStatusDetail } | undefined;
  private inflight: Promise<DockerStatusDetail> | undefined;
  private starting: { since: number; promise: Promise<DockerStatusDetail> } | undefined;
  private gpu: { ok: boolean; image: string; detail?: string } | undefined;
  private readonly exists: (p: string) => Promise<boolean>;
  private readonly launch: (cmd: string, args: string[]) => Promise<void>;

  constructor(private readonly o: DockerEnvironmentOptions) {
    this.exists =
      o.exists ??
      ((p) =>
        fs.access(p).then(
          () => true,
          () => false,
        ));
    this.launch = o.launchDetached ?? defaultLaunchDetached;
  }

  get cli(): DockerCli {
    return this.o.cli;
  }

  async status(opts: { fresh?: boolean } = {}): Promise<DockerStatusDetail> {
    const now = this.o.clock.now();
    if (!opts.fresh && this.cached && now - this.cached.at < (this.o.statusMaxAgeMs ?? 2000)) return this.cached.value;
    this.inflight ??= this.compute().finally(() => {
      this.inflight = undefined;
    });
    const value = await this.inflight;
    this.cached = { at: now, value };
    return value;
  }

  /** SystemResponse['docker'] for the system service (`dockerStatus` option). */
  async dockerStatus(): Promise<SystemResponse['docker']> {
    const s = await this.status();
    return s.version !== undefined ? { state: s.state, version: s.version } : { state: s.state };
  }

  private async compute(): Promise<DockerStatusDetail> {
    const v = await this.o.cli.version();
    const text = `${v.stdout}\n${v.stderr}`;
    // In WSL the Windows shim answers (exit 0!) with a hint instead of a version.
    if (WSL_SHIM.test(text)) return { state: 'not-installed', reason: 'wsl-integration', detail: text.trim() };
    const base: DockerStatusDetail = { state: 'unknown' };
    if (v.client) {
      base.clientVersion = v.client.version;
      base.version = v.client.version;
      if (v.client.context !== undefined) base.context = v.client.context;
    }
    if (v.server) {
      base.serverVersion = v.server.version;
      base.version = v.server.version;
      if (v.server.platform !== undefined) base.platform = v.server.platform;
      if (v.server.podman) return { ...base, state: 'unsupported', reason: 'podman' };
      if (v.server.os === 'windows') return { ...base, state: 'unsupported', reason: 'windows-containers' };
      if (this.gpu && !this.gpu.ok) {
        return { ...base, state: 'no-gpu', reason: 'gpu-check-failed', ...(this.gpu.detail ? { detail: this.gpu.detail } : {}) };
      }
      return { ...base, state: 'running' };
    }
    const err = classifyDockerError(v);
    // classifyDockerError always sets the detail (the CLI output).
    const detail = (err.detail as string).slice(-1000);
    if (err.code === 'DOCKER_NOT_INSTALLED') return { ...base, state: 'not-installed', detail };
    if (err.code === 'DOCKER_PERMISSION') return { ...base, state: 'no-permission', detail };
    if (err.code === 'DOCKER_NOT_RUNNING') {
      const starting = err.params?.reason === 'starting' || this.starting !== undefined;
      const out: DockerStatusDetail = { ...base, state: starting ? 'starting' : 'stopped', detail };
      if (this.starting) out.startingForMs = this.o.clock.now() - this.starting.since;
      return out;
    }
    return { ...base, detail };
  }

  /**
   * Windows: starts Docker Desktop (`docker desktop start --detach`, Docker Desktop ≥ 4.37;
   * otherwise its executable) and waits until the engine answers. Concurrent calls share one start.
   * Linux has no desktop to start: the engine is a system service (DOCKER_NOT_RUNNING, reason manual-start).
   */
  startDesktop(signal: AbortSignal, onProgress?: (p: StartProgress) => void): Promise<DockerStatusDetail> {
    if (this.starting) return this.starting.promise;
    const since = this.o.clock.now();
    const promise = this.doStart(since, signal, onProgress).finally(() => {
      this.starting = undefined;
    });
    this.starting = { since, promise };
    return promise;
  }

  private async doStart(since: number, signal: AbortSignal, onProgress?: (p: StartProgress) => void): Promise<DockerStatusDetail> {
    // The status cache must not hide the transition we are about to cause.
    const first = await this.status({ fresh: true });
    if (first.state === 'running' || first.state === 'no-gpu' || first.state === 'unsupported') return first;
    if (first.state === 'not-installed') {
      throw new AppError('DOCKER_NOT_INSTALLED', 'Docker is not installed', { params: { reason: first.reason ?? 'missing' } });
    }
    if (first.state === 'no-permission') throw new AppError('DOCKER_PERMISSION', 'No permission to use Docker');
    if (this.o.platform !== 'win32') {
      throw new AppError('DOCKER_NOT_RUNNING', 'Start the Docker service manually', {
        params: { reason: 'manual-start', platform: this.o.platform },
      });
    }
    const method = await this.launchDesktop(signal);
    const timeoutMs = this.o.startTimeoutMs ?? 180_000;
    const slowMs = this.o.slowStartMs ?? 60_000;
    for (;;) {
      if (signal.aborted) throw new AppError('CANCELLED', 'Docker Desktop start cancelled');
      const s = await this.status({ fresh: true });
      const elapsedMs = this.o.clock.now() - since;
      onProgress?.({ state: s.state, elapsedMs, slow: elapsedMs > slowMs, method });
      if (s.state === 'running' || s.state === 'no-gpu' || s.state === 'unsupported') return s;
      if (elapsedMs > timeoutMs) {
        throw new AppError('DOCKER_NOT_RUNNING', 'Docker Desktop did not start in time', {
          params: { reason: 'start-timeout', timeoutMs },
          ...(s.detail ? { detail: s.detail } : {}),
        });
      }
      await this.o.clock.sleep(this.o.startPollMs ?? 2000, signal).catch(() => undefined);
    }
  }

  private async launchDesktop(signal: AbortSignal): Promise<'cli' | 'exe'> {
    const out = await this.o.cli.exec(['desktop', 'start', '--detach'], { timeoutMs: 60_000, signal });
    if (out.code === 0) return 'cli';
    if (!NO_DESKTOP_PLUGIN.test(`${out.stderr}\n${out.stdout}`)) {
      this.o.log?.warn('docker desktop start failed, launching the executable', { stderr: out.stderr.slice(0, 500) });
    }
    for (const exe of desktopExecutables(this.o.env)) {
      if (await this.exists(exe)) {
        await this.launch(exe, []);
        return 'exe';
      }
    }
    throw new AppError('DOCKER_NOT_INSTALLED', 'Docker Desktop was not found', { params: { reason: 'desktop-not-found' } });
  }

  /**
   * Runs nvidia-smi -L inside `image` with --gpus all. `--pull never`: a GPU check must never
   * start a multi-GB download. The outcome is remembered and reflected by status().
   */
  async gpuCheck(image: string, signal?: AbortSignal): Promise<GpuCheckResult> {
    const out = await this.o.cli.exec(['run', '--rm', '--pull', 'never', '--gpus', 'all', '--entrypoint', 'nvidia-smi', image, '-L'], {
      timeoutMs: this.o.gpuCheckTimeoutMs ?? 180_000,
      ...(signal ? { signal } : {}),
    });
    const gpus = out.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^GPU \d+:/.test(l));
    if (out.code === 0 && gpus.length > 0) {
      this.gpu = { ok: true, image };
      this.cached = undefined;
      return { image, gpus };
    }
    const err = out.code === 0 ? new AppError('DOCKER_NO_GPU', 'No GPU visible inside the container', { detail: out.stdout.slice(-2000) }) : classifyDockerError(out, 'DOCKER_NO_GPU');
    if (err.code === 'DOCKER_NO_GPU' || err.code === 'DRIVER_TOO_OLD') this.noteGpuFailure(image, err.detail);
    throw err;
  }

  /** A `docker run --gpus all` failed for lack of GPU support: status() reports "no-gpu" until a check succeeds. */
  noteGpuFailure(image: string, detail?: string): void {
    this.gpu = { ok: false, image, ...(detail ? { detail } : {}) };
    this.cached = undefined;
  }

  /**
   * Removes our leftover containers: label gpubench=1, a marker, and not one of `keep` (markers
   * of runs in progress). Containers without our label are never touched.
   */
  async cleanupOrphans(keep: Iterable<string> = []): Promise<{ removed: { id: string; name: string }[] }> {
    const keepSet = new Set(keep);
    const rows = await this.o.cli.ps([`${GPUBENCH_LABEL}=1`]);
    const removed: { id: string; name: string }[] = [];
    for (const r of rows) {
      const marker = r.labels['gpubench.marker'];
      if (!isOurs(r.labels) || marker === undefined || keepSet.has(marker)) continue;
      try {
        await this.o.cli.rm(r.id, true);
        removed.push({ id: r.id, name: r.name });
      } catch (e) {
        this.o.log?.warn('orphan container removal failed', { id: r.id, error: isAppError(e) ? e.code : String(e) });
      }
    }
    return { removed };
  }
}

/**
 * ContainerOwnership for the process registry: a record is ours only if the container still
 * carries our label and the same marker; stop() stops and removes exactly that container.
 */
export function containerOwnership(cli: DockerCli): ContainerOwnership {
  const target = (rec: OwnedRecord) => rec.containerId ?? `gpubench-${rec.marker}`;
  return {
    async verify(rec) {
      const info = await cli.inspect(target(rec)).catch(() => undefined);
      return info !== undefined && isOurs(info.labels, rec.marker);
    },
    async stop(rec) {
      await cli.stop(target(rec), 10).catch(() => undefined);
      await cli.rm(target(rec), true);
    },
  };
}
