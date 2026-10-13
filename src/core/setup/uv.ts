import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { AppError } from '../../contract/errors';
import type { Clock, Platform, ProcessRunner } from '../deps';
import { extractArchive } from '../engines/archive';
import { downloadFile } from '../engines/download';
import { ignore, timeoutSignal } from '../engines/util';

/**
 * Standalone `uv` (astral-sh/uv GitHub releases): lets the vLLM-native installer create a
 * Python environment on Linux without any system Python. Layout: enginesDir/uv/<version>/uv.
 */
export const UV_REPO = 'astral-sh/uv';
/** Used when the GitHub API is unreachable or rate-limited (latest release on 2026-10-06). */
export const UV_FALLBACK_VERSION = '0.12.23';
/** Release tags are plain semver ("0.12.23"); anything else is refused (it becomes a folder name). */
export const UV_VERSION_RE = /^\d+\.\d+\.\d+$/;

/** Release asset for this OS/CPU: glibc tarballs on Linux, MSVC zips on Windows. */
export function uvAssetName(platform: Platform, arch: string): string | undefined {
  const cpu = arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'aarch64' : undefined;
  if (!cpu) return undefined;
  if (platform === 'linux') return `uv-${cpu}-unknown-linux-gnu.tar.gz`;
  if (platform === 'win32') return `uv-${cpu}-pc-windows-msvc.zip`;
  return undefined;
}

export function uvBinaryName(platform: Platform): string {
  return platform === 'win32' ? 'uv.exe' : 'uv';
}

/** "<sha256>  <file>" (sha256sum format, optional `*` binary marker); the file name must match when present. */
export function parseSha256File(text: string, asset: string): string | undefined {
  const m = /^([0-9a-fA-F]{64})(?:\s+\*?(\S+))?\s*$/m.exec(text.trim());
  if (!m) return undefined;
  if (m[2] !== undefined && m[2] !== asset) return undefined;
  return (m[1] as string).toLowerCase();
}

export interface UvPlan {
  version: string;
  asset: string;
  url: string;
  sha256Url: string;
  sizeBytes?: number;
  /** GitHub's own asset digest, cross-checked against the .sha256 file. */
  digest?: string;
}

export interface UvInstalled {
  version: string;
  path: string;
}

export interface UvProgress {
  stage: 'download' | 'verify' | 'extract' | 'done';
  bytesDone: number;
  bytesTotal?: number;
}

export interface UvInstallerOptions {
  fetch: typeof globalThis.fetch;
  proc: ProcessRunner;
  clock: Clock;
  platform: Platform;
  arch: string;
  enginesDir: string;
  githubApi: string;
  /** Where release files live when the API is skipped (default https://github.com). */
  downloadBase?: string;
  appVersion?: string;
  /** Pin a version instead of asking GitHub for the latest release. */
  version?: string;
  chmod?: (p: string, mode: number) => Promise<void>;
  progressIntervalMs?: number;
  apiTimeoutMs?: number;
  smokeTimeoutMs?: number;
}

const releaseSchema = z.object({
  tag_name: z.string(),
  assets: z.array(z.object({ name: z.string(), size: z.number(), browser_download_url: z.string(), digest: z.string().nullish() })),
});

function failed(reason: string, message: string, params: Record<string, string | number> = {}, detail?: string): AppError {
  return new AppError('ENGINE_INSTALL_FAILED', message, { params: { component: 'uv', reason, ...params }, ...(detail ? { detail } : {}) });
}

export class UvInstaller {
  constructor(private readonly o: UvInstallerOptions) {}

  root(): string {
    return path.join(this.o.enginesDir, 'uv');
  }

  private asset(): string {
    const asset = uvAssetName(this.o.platform, this.o.arch);
    if (!asset) throw failed('unsupported-platform', `No uv build for ${this.o.platform}/${this.o.arch}`, { platform: this.o.platform, arch: this.o.arch });
    return asset;
  }

  private pinned(version: string, asset: string): UvPlan {
    if (!UV_VERSION_RE.test(version)) throw new AppError('VALIDATION', `Invalid uv version: ${version}`);
    const base = `${(this.o.downloadBase ?? 'https://github.com').replace(/\/+$/, '')}/${UV_REPO}/releases/download/${version}`;
    return { version, asset, url: `${base}/${asset}`, sha256Url: `${base}/${asset}.sha256` };
  }

  /** Latest release from the GitHub API; the pinned fallback when GitHub cannot answer. */
  async plan(signal?: AbortSignal): Promise<UvPlan> {
    const asset = this.asset();
    if (this.o.version) return this.pinned(this.o.version, asset);
    const t = timeoutSignal(this.o.apiTimeoutMs ?? 15_000, signal);
    try {
      const res = await this.o.fetch(`${this.o.githubApi.replace(/\/+$/, '')}/repos/${UV_REPO}/releases/latest`, {
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': `llm-bench/${this.o.appVersion ?? 'dev'}`,
        },
        signal: t.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rel = releaseSchema.parse(await res.json());
      const main = rel.assets.find((a) => a.name === asset);
      const sum = rel.assets.find((a) => a.name === `${asset}.sha256`);
      if (!UV_VERSION_RE.test(rel.tag_name) || !main || !sum) throw new Error('release without the expected assets');
      const digest = main.digest?.startsWith('sha256:') ? main.digest.slice('sha256:'.length).toLowerCase() : undefined;
      return {
        version: rel.tag_name,
        asset,
        url: main.browser_download_url,
        sha256Url: sum.browser_download_url,
        sizeBytes: main.size,
        ...(digest ? { digest } : {}),
      };
    } catch {
      if (signal?.aborted) throw new AppError('CANCELLED', 'uv install cancelled');
      return this.pinned(UV_FALLBACK_VERSION, asset);
    } finally {
      t.clear();
    }
  }

  /** Installed versions, newest first (only folders whose binary exists). */
  async installed(): Promise<UvInstalled[]> {
    const names = await fs.readdir(this.root()).catch((): string[] => []);
    const out: UvInstalled[] = [];
    for (const v of names.filter((n) => UV_VERSION_RE.test(n))) {
      const p = path.join(this.root(), v, uvBinaryName(this.o.platform));
      const st = await fs.stat(p).catch(ignore);
      if (st?.isFile()) out.push({ version: v, path: p });
    }
    const key = (v: string) => v.split('.').map(Number) as [number, number, number];
    return out.sort((a, b) => {
      const [x, y] = [key(a.version), key(b.version)];
      return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
    });
  }

  /** Path of the newest installed uv binary; undefined when none is installed. */
  async uvPath(): Promise<string | undefined> {
    return (await this.installed())[0]?.path;
  }

  /**
   * Downloads, verifies (release .sha256 file, cross-checked with GitHub's digest), extracts
   * (archive.ts refuses path traversal) and smoke-tests uv in a temp folder, then renames it
   * into place: a crash or cancel never leaves a half-installed version behind.
   */
  async install(progress: (p: UvProgress) => void, signal: AbortSignal, planned?: UvPlan): Promise<UvInstalled> {
    const plan = planned ?? (await this.plan(signal));
    const existing = (await this.installed()).find((i) => i.version === plan.version);
    if (existing) {
      progress({ stage: 'done', bytesDone: 0 });
      return existing;
    }
    const root = this.root();
    const work = path.join(root, `.tmp-${randomBytes(6).toString('hex')}`);
    const interval = this.o.progressIntervalMs ?? 250;
    try {
      await fs.mkdir(work, { recursive: true });
      const sha = await this.expectedSha(plan, signal);
      const file = path.join(work, 'dl', plan.asset);
      let last = -Infinity;
      progress({ stage: 'download', bytesDone: 0, ...(plan.sizeBytes ? { bytesTotal: plan.sizeBytes } : {}) });
      const dl = await downloadFile({
        fetch: this.o.fetch,
        url: plan.url,
        dest: file,
        signal,
        sha256: sha,
        onProgress: (done, total) => {
          const now = this.o.clock.now();
          if (now - last < interval) return;
          last = now;
          progress({ stage: 'download', bytesDone: done, ...(total !== undefined ? { bytesTotal: total } : {}) });
        },
      });
      progress({ stage: 'extract', bytesDone: dl.bytes, bytesTotal: dl.bytes });
      const stage = path.join(work, 'stage');
      await extractArchive(file, stage);
      const binDir = await this.findBinDir(stage);
      const exe = uvBinaryName(this.o.platform);
      if (this.o.platform !== 'win32') {
        const chmod = this.o.chmod ?? ((p: string, m: number) => fs.chmod(p, m));
        for (const name of ['uv', 'uvx']) {
          const p = path.join(binDir, name);
          if (await fs.stat(p).then(() => true, () => false)) await chmod(p, 0o755);
        }
      }
      progress({ stage: 'verify', bytesDone: dl.bytes, bytesTotal: dl.bytes });
      await this.smoke(path.join(binDir, exe), plan.version, signal);
      const dest = path.join(root, plan.version);
      await fs.rm(dest, { recursive: true, force: true });
      await fs.rename(binDir, dest);
      progress({ stage: 'done', bytesDone: dl.bytes, bytesTotal: dl.bytes });
      return { version: plan.version, path: path.join(dest, exe) };
    } finally {
      await fs.rm(work, { recursive: true, force: true }).catch(ignore);
    }
  }

  private async expectedSha(plan: UvPlan, signal: AbortSignal): Promise<string> {
    let text: string;
    try {
      const res = await this.o.fetch(plan.sha256Url, { redirect: 'follow', signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
    } catch (e) {
      if (signal.aborted) throw new AppError('CANCELLED', 'uv install cancelled', { cause: e });
      throw new AppError('DOWNLOAD_FAILED', `Cannot fetch ${plan.sha256Url}: ${String(e)}`, { params: { url: plan.sha256Url }, cause: e });
    }
    const sha = parseSha256File(text, plan.asset);
    if (!sha) throw failed('bad-checksum-file', `Unreadable checksum file for ${plan.asset}`);
    if (plan.digest && plan.digest !== sha) {
      throw new AppError('DOWNLOAD_CHECKSUM', `Checksum file and GitHub digest disagree for ${plan.asset}`, {
        params: { file: plan.asset, expected: plan.digest, actual: sha },
      });
    }
    return sha;
  }

  /** The archive holds uv at its root (Windows zip) or in one sub-folder (Linux tarball). */
  private async findBinDir(stage: string): Promise<string> {
    const exe = uvBinaryName(this.o.platform);
    const isFile = (p: string) => fs.stat(p).then((s) => s.isFile(), () => false);
    if (await isFile(path.join(stage, exe))) return stage;
    const entries = await fs.readdir(stage, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && (await isFile(path.join(stage, e.name, exe)))) return path.join(stage, e.name);
    }
    throw failed('binary-missing', `${exe} not found in the uv archive`);
  }

  /** `uv --version` → "uv 0.12.23 (…)": proves the binary runs here (and lets antivirus scan it now). */
  private async smoke(exe: string, version: string, signal: AbortSignal): Promise<void> {
    const out = await this.o.proc.run(exe, ['--version'], { timeoutMs: this.o.smokeTimeoutMs ?? 30_000, signal });
    if (signal.aborted) throw new AppError('CANCELLED', 'uv install cancelled');
    const m = /^uv (\S+)/m.exec(out.stdout);
    if (out.code !== 0 || m?.[1] !== version) {
      throw failed('smoke-failed', `uv --version failed (${String(out.code)})`, { exitCode: String(out.code) }, (out.stderr || out.stdout).slice(-500));
    }
  }
}
