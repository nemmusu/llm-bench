/**
 * The rename GPU Bench → LLM Bench (0.4.0): the first start of LLM Bench takes over GPU Bench's data, once.
 *
 * Electron keeps the data per app name (%APPDATA%\GPU Bench, ~/.config/GPU Bench). When LLM Bench's
 * folder has no settings.json and GPU Bench's exists, GPU Bench's folder is renamed (same parent:
 * instant and atomic). That must happen before anything opens a file in the new folder: Electron has
 * just created it empty, requestSingleInstanceLock puts its lock file there and Chromium reads its
 * "Local State" (on Windows the key of the encrypted secrets) right after the main script starts.
 * So moveLegacyData runs synchronously, first thing.
 *
 * A GPU Bench that is still open keeps its folder (Windows: its lockfile is busy and a rename fails
 * with EPERM; Linux: SingletonLock names a live process, and a rename would pull the folder from
 * under it). Then the data is copied instead (finishLegacyMove) and GPU Bench's folder is left as it
 * was; what describes its running engines and downloads is not copied (LLM Bench would stop the
 * former and resume the latter at the same time).
 *
 * After the move the absolute paths into the old folder follow it: in settings.json (a managed
 * llama.cpp build, a custom engine) and in the scripts of the managed Python environments (uv venvs
 * write their own path into bin/). Models are never moved (the core keeps GPU Bench's default models
 * folder: bootstrap.ts). The start at login follows (login-item.ts). The window says it once
 * (app-notices.json).
 */
import path from 'node:path';
import { APP_NOTICES_FILE, parseAppNotices, withAppNotices, type AppNotice } from '../contract/app-notices';

/** Chromium's file with the key of safeStorage (Windows): it must come along with the secrets. */
export const LOCAL_STATE = 'Local State';
/** Copied when the folder cannot be renamed. */
export const COPIED = ['settings.json', 'results', 'hf-token.bin', 'server-api-key.bin', 'shell.json'] as const;
/** Copied only when GPU Bench is closed: its running engines and downloads, its NInfer processes in WSL. */
export const LIVE_STATE = ['downloads.json', 'processes.json', 'ninfer-wsl.json'] as const;
/** The installed engines are copied up to this size; beyond it they stay where they are (the notice says where). */
export const ENGINES_COPY_LIMIT = 2 * 1024 ** 3;
/** Files in a venv's bin/ larger than this are programs, not scripts that embed the venv's path. */
const SCRIPT_MAX_BYTES = 1024 * 1024;

/** The synchronous part of node:fs that moveLegacyData uses (index.ts passes node:fs itself). */
export interface LegacySyncFs {
  existsSync(p: string): boolean;
  readdirSync(p: string): string[];
  rmdirSync(p: string): void;
  renameSync(from: string, to: string): void;
  mkdirSync(p: string, o: { recursive: true }): unknown;
  copyFileSync(from: string, to: string): void;
  readlinkSync(p: string): string;
  openSync(p: string, flags: string): number;
  closeSync(fd: number): void;
}

export interface LegacyStat {
  size: number;
  isFile(): boolean;
  isDirectory(): boolean;
}

/** The part of node:fs/promises that finishLegacyMove uses. */
export interface LegacyAsyncFs {
  readFile(p: string): Promise<Buffer>;
  writeFile(p: string, data: string): Promise<void>;
  readdir(p: string): Promise<string[]>;
  lstat(p: string): Promise<LegacyStat>;
  cp(from: string, to: string, o: { recursive: true; force: false; errorOnExist: false; verbatimSymlinks: true }): Promise<void>;
}

export interface LegacyMoveHost {
  platform: string;
  /** LLM Bench's data folder (Electron's userData). */
  userData: string;
  /** GPU Bench's. */
  legacy: string;
  fs: LegacySyncFs;
  hostname: string;
  /** process.kill: signal 0 only checks that the process exists. */
  kill(pid: number, signal: 0): unknown;
}

export type LegacyMove =
  | { kind: 'none' }
  | { kind: 'moved'; from: string; to: string }
  /** The rename was not possible: finishLegacyMove copies. `inUse`: GPU Bench is open. */
  | { kind: 'copy'; from: string; to: string; inUse: boolean };

/** Whether `pid` runs (EPERM: it does, as another user's). */
export function pidAlive(kill: LegacyMoveHost['kill'], pid: number): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Is GPU Bench open (its lock held)? */
export function legacyInUse(h: LegacyMoveHost): boolean {
  if (h.platform === 'win32') {
    // Chromium keeps "lockfile" open without sharing while the app runs, and deletes it at exit.
    const lock = path.join(h.legacy, 'lockfile');
    if (!h.fs.existsSync(lock)) return false;
    try {
      h.fs.closeSync(h.fs.openSync(lock, 'r+'));
      return false;
    } catch {
      return true;
    }
  }
  // Linux: SingletonLock is a link to "<hostname>-<pid>", left behind by a crash.
  let target: string;
  try {
    target = h.fs.readlinkSync(path.join(h.legacy, 'SingletonLock'));
  } catch {
    return false;
  }
  const m = /^(.+)-(\d+)$/.exec(target);
  if (!m) return false;
  // Another computer sharing this home folder: no way to tell, as Chromium itself says.
  if (m[1] !== h.hostname) return true;
  return pidAlive(h.kill, Number(m[2]));
}

/**
 * The synchronous part, first thing at start: rename GPU Bench's folder to LLM Bench's when LLM
 * Bench has no data yet. Never throws: anything unexpected leaves things as they are ('none').
 */
export function moveLegacyData(h: LegacyMoveHost): LegacyMove {
  const { fs } = h;
  try {
    if (fs.existsSync(path.join(h.userData, 'settings.json')) || !fs.existsSync(h.legacy)) return { kind: 'none' };
    const copy = (inUse: boolean): LegacyMove => {
      fs.mkdirSync(h.userData, { recursive: true });
      const state = path.join(h.legacy, LOCAL_STATE);
      if (!fs.existsSync(path.join(h.userData, LOCAL_STATE)) && fs.existsSync(state)) fs.copyFileSync(state, path.join(h.userData, LOCAL_STATE));
      return { kind: 'copy', from: h.legacy, to: h.userData, inUse };
    };
    if (legacyInUse(h)) return copy(true);
    if (fs.existsSync(h.userData)) {
      // Electron creates the folder empty at start; anything in it is not ours to replace.
      if (fs.readdirSync(h.userData).length > 0) return copy(false);
      fs.rmdirSync(h.userData);
    }
    try {
      fs.renameSync(h.legacy, h.userData);
    } catch {
      return copy(false);
    }
    return { kind: 'moved', from: h.legacy, to: h.userData };
  } catch {
    return { kind: 'none' };
  }
}

export interface LegacyFinishHost {
  platform: string;
  fs: LegacyAsyncFs;
  /** Problems on the way (best effort: the app starts anyway). */
  warn(msg: string): void;
}

export interface LegacyReport {
  /** The engines stayed in GPU Bench's folder (too large to copy). */
  enginesIn?: string;
  /** settings.json paths that now point into LLM Bench's folder. */
  rewritten: number;
  /** Scripts of the Python environments that now point into LLM Bench's folder. */
  scripts: number;
}

const isFile = (fs: LegacyAsyncFs, p: string) => fs.lstat(p).then(
  (s) => s.isFile(),
  () => false,
);

/** Bytes under `dir` (symlinks not followed), stopping once past `limit`. */
export async function sizeUpTo(fs: LegacyAsyncFs, dir: string, limit: number): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length && total <= limit) {
    const d = stack.pop() as string;
    for (const name of await fs.readdir(d).catch(() => [])) {
      const st = await fs.lstat(path.join(d, name)).catch(() => undefined);
      if (st?.isDirectory()) stack.push(path.join(d, name));
      else if (st) total += st.size;
    }
  }
  return total;
}

/** `p` inside `dir` (or `dir` itself)? Windows paths compare without case and with either slash. */
export function insideDir(p: string, dir: string, platform: string): boolean {
  const norm = (s: string) => (platform === 'win32' ? s.replaceAll('/', '\\').toLowerCase() : s).replace(/[\\/]+$/, '');
  const a = norm(p);
  const b = norm(dir);
  return a === b || a.startsWith(platform === 'win32' ? `${b}\\` : `${b}/`);
}

/** Every string of `value` that is a path inside `from`, moved into `to`; `count` says how many. */
export function movePaths(value: unknown, from: string, to: string, platform: string, count: { n: number }): unknown {
  if (typeof value === 'string') {
    if (!insideDir(value, from, platform)) return value;
    count.n++;
    return to + value.slice(from.replace(/[\\/]+$/, '').length);
  }
  if (Array.isArray(value)) return value.map((v) => movePaths(v, from, to, platform, count));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, movePaths(v, from, to, platform, count)]));
  return value;
}

/** settings.json with its paths into `from` moved to `to`; the number of paths changed. */
export async function rewriteSettingsPaths(h: LegacyFinishHost, from: string, to: string): Promise<number> {
  const file = path.join(to, 'settings.json');
  const raw = await h.fs.readFile(file).then(String, () => undefined);
  if (raw === undefined) return 0;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return 0;
  }
  const count = { n: 0 };
  const moved = movePaths(json, from, to, h.platform, count);
  if (count.n > 0) await h.fs.writeFile(file, JSON.stringify(moved, null, 2));
  return count.n;
}

/**
 * The scripts in bin/ of every Python environment under engines/ (a folder with pyvenv.cfg) name
 * their interpreter by absolute path ("#!…/vllm-venv/bin/python", or an `exec '…'` line when the
 * path has spaces): `from` becomes `to`. Programs and links are left alone.
 */
export async function repairVenvScripts(h: LegacyFinishHost, enginesDir: string, from: string, to: string): Promise<number> {
  let n = 0;
  for (const env of await h.fs.readdir(enginesDir).catch(() => [])) {
    if (!(await isFile(h.fs, path.join(enginesDir, env, 'pyvenv.cfg')))) continue;
    const bin = path.join(enginesDir, env, 'bin');
    for (const name of await h.fs.readdir(bin).catch(() => [])) {
      const file = path.join(bin, name);
      const st = await h.fs.lstat(file).catch(() => undefined);
      if (!st?.isFile() || st.size > SCRIPT_MAX_BYTES) continue;
      const text = String(await h.fs.readFile(file));
      if (!text.includes(from)) continue;
      await h.fs.writeFile(file, text.split(from).join(to));
      n++;
    }
  }
  return n;
}

/**
 * The asynchronous part, before the core starts: the copy (when the folder could not be renamed)
 * and the paths that must follow the data. Each step is best effort.
 */
export async function finishLegacyMove(h: LegacyFinishHost, move: Exclude<LegacyMove, { kind: 'none' }>): Promise<LegacyReport> {
  const { from, to } = move;
  const report: LegacyReport = { rewritten: 0, scripts: 0 };
  const step = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      h.warn(`rename migration: ${what}: ${String(e)}`);
    }
  };
  const cp = (name: string) => h.fs.cp(path.join(from, name), path.join(to, name), { recursive: true, force: false, errorOnExist: false, verbatimSymlinks: true });
  let enginesHere = move.kind === 'moved';
  if (move.kind === 'copy') {
    for (const name of [...COPIED, ...(move.inUse ? [] : LIVE_STATE)]) {
      await step(`copy ${name}`, async () => {
        if (await h.fs.lstat(path.join(from, name)).then(() => true, () => false)) await cp(name);
      });
    }
    await step('copy engines', async () => {
      const engines = path.join(from, 'engines');
      if (!(await h.fs.lstat(engines).then((s) => s.isDirectory(), () => false))) return;
      if ((await sizeUpTo(h.fs, engines, ENGINES_COPY_LIMIT)) > ENGINES_COPY_LIMIT) {
        report.enginesIn = engines;
        return;
      }
      await cp('engines');
      enginesHere = true;
    });
  }
  // With the engines left behind, paths to them stay valid as they are.
  if (enginesHere) {
    await step('settings paths', async () => {
      report.rewritten = await rewriteSettingsPaths(h, from, to);
    });
    await step('python environments', async () => {
      report.scripts = await repairVenvScripts(h, path.join(to, 'engines'), from, to);
    });
  }
  return report;
}

/** The notice the window shows once. */
export function movedNotice(move: Exclude<LegacyMove, { kind: 'none' }>, report: LegacyReport): AppNotice {
  return {
    id: 'data-moved',
    kind: 'data-moved',
    mode: move.kind === 'moved' ? 'moved' : 'copied',
    from: move.from,
    ...(report.enginesIn !== undefined ? { enginesIn: report.enginesIn } : {}),
  };
}

/** Adds notices to <dataDir>/app-notices.json (read by the core, dismissed by the window). */
export async function addAppNotices(
  fs: { readFile(p: string): Promise<Buffer>; writeFile(p: string, data: string): Promise<void> },
  dataDir: string,
  notices: readonly AppNotice[],
): Promise<void> {
  if (notices.length === 0) return;
  const file = path.join(dataDir, APP_NOTICES_FILE);
  const raw = await fs.readFile(file).then(
    (b) => {
      try {
        return JSON.parse(String(b)) as unknown;
      } catch {
        return [];
      }
    },
    () => [],
  );
  await fs.writeFile(file, JSON.stringify(withAppNotices(parseAppNotices(raw), notices), null, 2));
}
