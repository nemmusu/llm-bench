import { randomBytes } from 'node:crypto';
import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { AppError } from '../../../contract/errors';
import { missingLibraryError } from '../../process/missing-library';
import type { Clock, Platform, ProcessRunner } from '../../deps';
import { writeFileAtomic } from '../../store/atomic';
import type { ProgressSink } from '../types';
import { extractArchive, type SymlinkFn } from '../archive';
import { downloadFile } from '../download';
import { buildNumber, type AssetSelection, type LlamaAsset } from './releases';
import { ignore } from '../util';

export const MANIFEST_FILE = 'install.json';
/** Managed builds live in enginesDir/llamacpp/<tag>-<variant>/. */
export const BUILD_ID = /^b\d+-[a-z0-9][a-z0-9.-]*$/;

const manifestSchema = z.object({
  schema: z.literal(1),
  tag: z.string(),
  variant: z.string(),
  backend: z.enum(['cuda', 'vulkan', 'cpu']),
  cudaVersion: z.string().optional(),
  /** Path of llama-server relative to the build folder (POSIX separators). */
  server: z.string(),
  files: z.array(z.string()),
  installedAt: z.string(),
  sources: z.array(z.object({ name: z.string(), url: z.string(), size: z.number(), sha256: z.string().optional() })),
  smoke: z
    .object({ ok: z.boolean(), code: z.number().nullable(), ms: z.number(), output: z.string() })
    .optional(),
});
export type InstallManifest = z.infer<typeof manifestSchema>;

export interface InstalledBuild extends InstallManifest {
  id: string;
  dir: string;
  serverPath: string;
}

export function llamaRoot(enginesDir: string): string {
  return path.join(enginesDir, 'llamacpp');
}

export function serverExeName(platform: Platform): string {
  return platform === 'win32' ? 'llama-server.exe' : 'llama-server';
}

/** Environment a managed build needs: the bundled CUDA runtime lives next to the binary on Linux. */
export function buildEnv(platform: Platform, exeDir: string, baseLdPath: string | undefined): Record<string, string> {
  if (platform !== 'linux') return {};
  return { LD_LIBRARY_PATH: baseLdPath ? `${exeDir}:${baseLdPath}` : exeDir };
}

export interface InstallDeps {
  fetch: typeof globalThis.fetch;
  proc: ProcessRunner;
  clock: Clock;
  platform: Platform;
  enginesDir: string;
  /** Inherited LD_LIBRARY_PATH (Linux smoke run). */
  ldLibraryPath?: string;
  chmod?: (p: string, mode: number) => Promise<void>;
  symlink?: SymlinkFn;
  rename?: RenameFn;
  /** Base delay between rename retries (antivirus locks). */
  renameDelayMs?: number;
  smokeTimeoutMs?: number;
  /** Minimum ms between download progress events. */
  progressIntervalMs?: number;
}

/**
 * Downloads, verifies and unpacks a llama.cpp release into enginesDir/llamacpp/<tag>-<variant>.
 * Everything happens in a hidden temp sibling folder that is renamed into place at the end, so
 * a crash or cancel never leaves a half-installed build that listInstalled() would pick up.
 */
export async function installLlamaBuild(
  deps: InstallDeps,
  tag: string,
  sel: AssetSelection,
  progress: ProgressSink,
  signal: AbortSignal,
): Promise<InstalledBuild> {
  const id = `${tag}-${sel.variant}`;
  if (!BUILD_ID.test(id)) throw new AppError('VALIDATION', `Invalid build id: ${id}`);
  const root = llamaRoot(deps.enginesDir);
  const work = path.join(root, `.tmp-${id}-${randomBytes(4).toString('hex')}`);
  const stage = path.join(work, 'stage');
  const assets: LlamaAsset[] = sel.cudart ? [sel.main, sel.cudart] : [sel.main];
  const total = assets.reduce((s, a) => s + a.size, 0);
  const interval = deps.progressIntervalMs ?? 200;

  try {
    await fs.mkdir(stage, { recursive: true });
    let before = 0;
    let lastEmit = -Infinity;
    const files: string[] = [];
    for (const asset of assets) {
      checkAbort(signal);
      const file = path.join(work, 'dl', path.basename(asset.name));
      await downloadFile({
        fetch: deps.fetch,
        url: asset.url,
        dest: file,
        signal,
        ...(asset.digest ? { sha256: asset.digest.replace(/^sha256:/, '') } : {}),
        onProgress: (done) => {
          const now = deps.clock.now();
          if (now - lastEmit < interval) return;
          lastEmit = now;
          progress({ stage: 'download', bytesDone: before + done, bytesTotal: total });
        },
      });
      before += asset.size;
      files.push(file);
    }
    progress({ stage: 'extract', bytesDone: total, bytesTotal: total });
    for (const [i, file] of files.entries()) {
      checkAbort(signal);
      const part = path.join(work, 'parts', String(i));
      await extractArchive(file, part, deps.symlink ? { symlink: deps.symlink } : {});
      await mergeMove(await contentRoot(part), stage);
    }

    const exeName = serverExeName(deps.platform);
    const serverRel = await findFile(stage, exeName, 4);
    if (serverRel === undefined) {
      throw new AppError('ENGINE_INSTALL_FAILED', `${exeName} not found in the archive`, {
        params: { reason: 'no-server-binary' },
      });
    }
    if (deps.platform === 'linux') await markExecutable(path.dirname(path.join(stage, serverRel)), deps.chmod);

    const manifest: InstallManifest = {
      schema: 1,
      tag,
      variant: sel.variant,
      backend: sel.backend,
      ...(sel.cudaVersion ? { cudaVersion: sel.cudaVersion } : {}),
      server: serverRel,
      files: await listFiles(stage),
      installedAt: new Date(deps.clock.wall()).toISOString(),
      sources: assets.map((a) => ({
        name: a.name,
        url: a.url,
        size: a.size,
        ...(a.digest ? { sha256: a.digest.replace(/^sha256:/, '') } : {}),
      })),
    };
    checkAbort(signal);
    const dir = path.join(root, id);
    await swapInto(stage, dir, work, deps.rename ?? ((a, b) => fs.rename(a, b)), deps.renameDelayMs ?? 100);

    // First run of a fresh binary: Windows Defender scans it now instead of during the first
    // measured cold load. Failure is recorded, not fatal (the engine status will show it).
    progress({ stage: 'smoke', bytesDone: total, bytesTotal: total });
    const serverPath = path.join(dir, serverRel);
    const t0 = deps.clock.now();
    const out = await deps.proc.run(serverPath, ['--version'], {
      timeoutMs: deps.smokeTimeoutMs ?? 120_000,
      env: buildEnv(deps.platform, path.dirname(serverPath), deps.ldLibraryPath),
      signal,
    });
    manifest.smoke = {
      ok: out.code === 0 && !out.timedOut,
      code: out.code,
      ms: Math.round(deps.clock.now() - t0),
      output: `${out.stderr}\n${out.stdout}`.trim().split(/\r?\n/).slice(0, 4).join('\n'),
    };
    await writeFileAtomic(path.join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
    // Installed, but it cannot run until the system has a library it links against: say which, now
    // (not after a model download). Once the user installs it, the build works without reinstalling.
    const missing = manifest.smoke.ok ? undefined : missingLibraryError(`${out.stderr}\n${out.stdout}`, serverPath);
    if (missing) throw missing;
    progress({ stage: 'done', bytesDone: total, bytesTotal: total });
    return { ...manifest, id, dir, serverPath };
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError('ENGINE_INSTALL_FAILED', `Install failed: ${String(e)}`, { params: { reason: 'io' }, cause: e });
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(ignore);
  }
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new AppError('CANCELLED', 'Install cancelled');
}

/** Archives are either flat (Windows zips) or wrap everything in one folder (Linux tarballs). */
export async function contentRoot(dir: string): Promise<string> {
  let current = dir;
  for (let depth = 0; depth < 4; depth++) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    if (entries.length !== 1) break;
    const only = entries[0] as Dirent;
    if (!only.isDirectory()) break;
    current = path.join(current, only.name);
  }
  return current;
}

/** Moves every entry of src into dst, merging folders (main archive + cudart share lib dirs). */
export async function mergeMove(src: string, dst: string): Promise<void> {
  await fs.mkdir(dst, { recursive: true });
  for (const e of await fs.readdir(src, { withFileTypes: true })) {
    const from = path.join(src, e.name);
    const to = path.join(dst, e.name);
    const existing = await fs.lstat(to).catch(ignore);
    if (existing?.isDirectory() && e.isDirectory()) {
      await mergeMove(from, to);
      continue;
    }
    if (existing) await fs.rm(to, { recursive: true, force: true });
    await fs.rename(from, to);
  }
}

/** Relative POSIX path of the first file called `name`, breadth-first, up to `maxDepth` levels. */
export async function findFile(root: string, name: string, maxDepth: number): Promise<string | undefined> {
  let level = [''];
  for (let depth = 0; depth <= maxDepth && level.length > 0; depth++) {
    const next: string[] = [];
    for (const rel of level) {
      for (const e of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isFile() && e.name === name) return childRel;
        if (e.isDirectory()) next.push(childRel);
      }
    }
    level = next;
  }
  return undefined;
}

export async function listFiles(root: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(root, childRel)));
    else out.push(childRel);
  }
  return out.sort();
}

/** Tarballs normally keep the exec bit; this makes sure extension-less binaries are runnable. */
async function markExecutable(dir: string, chmod?: (p: string, mode: number) => Promise<void>): Promise<void> {
  const doChmod = chmod ?? ((p: string, m: number) => fs.chmod(p, m));
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (!e.isFile() || e.name.includes('.')) continue;
    const p = path.join(dir, e.name);
    const st = await fs.stat(p);
    await doChmod(p, (st.mode & 0o777) | 0o755);
  }
}

export type RenameFn = (from: string, to: string) => Promise<void>;

const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** Windows Defender briefly locks freshly extracted binaries: retry transient rename failures. */
export async function renameWithRetry(rename: RenameFn, from: string, to: string, retries = 8, delayMs = 100): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (e) {
      if (!RETRYABLE.has(String((e as NodeJS.ErrnoException).code)) || attempt >= retries) throw e;
      await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
    }
  }
}

/** Renames stage → dir, replacing an existing build (moved aside first so it can be restored). */
async function swapInto(stage: string, dir: string, work: string, rename: RenameFn, delayMs: number): Promise<void> {
  const old = path.join(work, 'old');
  const hadOld = await fs.stat(dir).then(
    () => true,
    () => false,
  );
  if (hadOld) {
    try {
      await renameWithRetry(rename, dir, old, 8, delayMs);
    } catch (e) {
      // Windows: a running llama-server keeps its folder locked.
      throw new AppError('ENGINE_INSTALL_FAILED', 'The existing build is in use', {
        params: { reason: 'in-use', path: dir },
        cause: e,
      });
    }
  }
  try {
    await renameWithRetry(rename, stage, dir, 8, delayMs);
  } catch (e) {
    if (hadOld) await rename(old, dir).catch(ignore);
    throw new AppError('ENGINE_INSTALL_FAILED', `Cannot move the build into place: ${String(e)}`, {
      params: { reason: 'io', path: dir },
      cause: e,
    });
  }
}

export async function readManifest(dir: string): Promise<InstallManifest | undefined> {
  try {
    const parsed = manifestSchema.safeParse(JSON.parse(await fs.readFile(path.join(dir, MANIFEST_FILE), 'utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Managed builds, newest build number first. Folders without a valid manifest are ignored. */
export async function listInstalled(enginesDir: string): Promise<InstalledBuild[]> {
  const root = llamaRoot(enginesDir);
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const out: InstalledBuild[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !BUILD_ID.test(e.name)) continue;
    const dir = path.join(root, e.name);
    const m = await readManifest(dir);
    if (!m) continue;
    out.push({ ...m, id: e.name, dir, serverPath: path.join(dir, m.server) });
  }
  return out.sort((a, b) => buildNumber(b.tag) - buildNumber(a.tag) || a.variant.localeCompare(b.variant));
}

/** Deletes a managed build. Only folders that are managed builds inside enginesDir/llamacpp. */
export async function removeBuild(enginesDir: string, id: string): Promise<void> {
  const root = llamaRoot(enginesDir);
  const dir = path.join(root, id);
  // The id pattern has no separators and no '..' segment: the folder is always a direct child of root.
  if (!BUILD_ID.test(id)) throw new AppError('VALIDATION', `Invalid build id: ${id}`);
  if (!(await readManifest(dir))) throw new AppError('ENGINE_NOT_INSTALLED', `Build ${id} is not installed`, { params: { id } });
  await fs.rm(dir, { recursive: true, force: true });
}
