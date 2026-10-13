/**
 * A llama.cpp fork built from a git checkout: where its CMake build folder and its checkout are,
 * whether the upstream branch has new commits, and the update itself (`git pull --ff-only`, then
 * `cmake --build`). A checkout with uncommitted changes is never touched.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AppError } from '../../../contract/errors';
import type { ProcessRunner, RunOutput } from '../../deps';

export interface GitTools {
  proc: ProcessRunner;
  /** argv prefixes (["git"], or a fake in tests). */
  git: string[];
  cmake: string[];
}

export interface Checkout {
  /** The git checkout (its top folder). */
  repo: string;
  /** The CMake build folder (where CMakeCache.txt is). */
  buildDir: string;
  /** Multi-configuration generators (Visual Studio): the configuration the executable was built in. */
  config?: string;
}

const exists = (p: string) => fs.stat(p).then(
  () => true,
  () => false,
);

/** `dir` and every folder above it, nearest first. */
function* upwards(dir: string): Generator<string> {
  for (let d = dir; ; d = path.dirname(d)) {
    yield d;
    if (path.dirname(d) === d) return;
  }
}

/**
 * The CMake build folder above the executable (or the folder given) and the git checkout of its
 * sources (CMakeCache.txt names them; else the build folder's parent). Undefined when either is missing.
 */
export async function findCheckout(exePath: string): Promise<Checkout | undefined> {
  const st = await fs.stat(exePath).catch(() => undefined);
  if (!st) return undefined;
  const start = st.isDirectory() ? exePath : path.dirname(exePath);
  let buildDir: string | undefined;
  for (const d of upwards(start)) {
    if (await exists(path.join(d, 'CMakeCache.txt'))) {
      buildDir = d;
      break;
    }
  }
  if (buildDir === undefined) return undefined;
  const cache = await fs.readFile(path.join(buildDir, 'CMakeCache.txt'), 'utf8');
  const home = /^CMAKE_HOME_DIRECTORY:INTERNAL=(.+)$/m.exec(cache)?.[1]?.trim();
  const source = home ? path.resolve(home) : path.dirname(buildDir);
  let repo: string | undefined;
  for (const d of upwards(source)) {
    if (await exists(path.join(d, '.git'))) {
      repo = d;
      break;
    }
  }
  if (repo === undefined) return undefined;
  const types = (/^CMAKE_CONFIGURATION_TYPES:STRING=(.+)$/m.exec(cache)?.[1] ?? '').trim().split(';').filter(Boolean);
  if (types.length === 0) return { repo, buildDir };
  const here = path.basename(start);
  return { repo, buildDir, config: types.includes(here) ? here : types.includes('Release') ? 'Release' : (types[0] as string) };
}

/** The commands an update runs, as shown before it is confirmed. */
export function updateCommands(c: Checkout): string[][] {
  return [
    ['git', '-C', c.repo, 'pull', '--ff-only'],
    ['cmake', '--build', c.buildDir, '-j', ...(c.config !== undefined ? ['--config', c.config] : [])],
  ];
}

/** git never asks for a password in the background, and speaks English for the parsing. */
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };

function git(t: GitTools, repo: string, args: string[], timeoutMs = 30_000): Promise<RunOutput> {
  const [cmd, ...pre] = t.git as [string, ...string[]];
  return t.proc.run(cmd, [...pre, '-C', repo, ...args], { timeoutMs, env: GIT_ENV });
}

const lastLines = (out: RunOutput, n = 8) => `${out.stderr}\n${out.stdout}`.trim().split(/\r?\n/).slice(-n).join('\n');

export type GitState =
  | { kind: 'missing' }
  | { kind: 'detached'; head: string }
  | { kind: 'no-upstream'; branch: string; head: string }
  | { kind: 'ready'; branch: string; upstream: string; head: string; upstreamHead: string; changed: number; behind: number; ahead: number; fetchError?: string };

/** Where the checkout stands against its upstream branch (after `git fetch` when `fetch`). */
export async function gitState(t: GitTools, repo: string, opts: { fetch?: boolean } = {}): Promise<GitState> {
  const head = await git(t, repo, ['rev-parse', '--short', 'HEAD']);
  if (head.code === null) return { kind: 'missing' };
  if (head.code !== 0) throw new AppError('ENGINE_UPDATE_FAILED', `git rev-parse failed in ${repo}`, { params: { reason: 'git' }, detail: lastLines(head) });
  const short = head.stdout.trim();
  const branch = (await git(t, repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  if (branch === 'HEAD') return { kind: 'detached', head: short };
  const up = await git(t, repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (up.code !== 0) return { kind: 'no-upstream', branch, head: short };
  let fetchError: string | undefined;
  if (opts.fetch) {
    const f = await git(t, repo, ['fetch', '--quiet'], 120_000);
    if (f.code !== 0) fetchError = lastLines(f) || `exit ${String(f.code)}`;
  }
  const status = await git(t, repo, ['status', '--porcelain', '--untracked-files=no']);
  const count = async (range: string) => Number((await git(t, repo, ['rev-list', '--count', range])).stdout.trim()) || 0;
  return {
    kind: 'ready',
    branch,
    upstream: up.stdout.trim(),
    head: short,
    upstreamHead: (await git(t, repo, ['rev-parse', '--short', '@{u}'])).stdout.trim(),
    changed: status.stdout.split(/\r?\n/).filter((l) => l.trim() !== '').length,
    behind: await count('HEAD..@{u}'),
    ahead: await count('@{u}..HEAD'),
    ...(fetchError !== undefined ? { fetchError } : {}),
  };
}

export interface BuildProgress {
  stage: 'git-pull' | 'build';
  /** Build steps (Ninja "[12/345]", Make "[ 45%]" as 45 of 100). */
  step?: number;
  steps?: number;
}

/** Ninja "[12/345] Building CXX…", Make "[ 45%] Building CXX…". */
export function buildStep(line: string): { step: number; steps: number } | undefined {
  const ninja = /^\[(\d+)\/(\d+)\]/.exec(line.trim());
  if (ninja) return { step: Number(ninja[1]), steps: Number(ninja[2]) };
  const make = /^\[\s*(\d+)%\]/.exec(line.trim());
  return make ? { step: Number(make[1]), steps: 100 } : undefined;
}

const OWNER = { runId: 'engine-update', marker: 'engine-update' };

/** Runs one tool to its end, with each line to `onLine`; a failure is an ENGINE_UPDATE_FAILED with its last lines. */
async function runTool(t: GitTools, argv: string[], stage: string, onLine: (l: string) => void, signal: AbortSignal): Promise<void> {
  const [cmd, ...args] = argv as [string, ...string[]];
  const mp = t.proc.spawn({ cmd, args, env: GIT_ENV, owner: OWNER });
  const onAbort = () => void mp.stop();
  signal.addEventListener('abort', onAbort, { once: true });
  const tail: string[] = [];
  try {
    for await (const l of mp.lines) {
      tail.push(l.text);
      if (tail.length > 30) tail.shift();
      onLine(l.text);
    }
    const exit = await mp.exited;
    if (signal.aborted) throw new AppError('CANCELLED', 'Engine update cancelled');
    if (exit.code !== 0) {
      const missing = exit.code === null && /ENOENT/.test(tail.join('\n'));
      throw new AppError('ENGINE_UPDATE_FAILED', `${stage} failed`, { params: { reason: missing ? `${stage}-missing` : stage, code: String(exit.code) }, detail: tail.join('\n') });
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** `git pull --ff-only`, then `cmake --build`: refused on a checkout with uncommitted changes. */
export async function gitUpdate(t: GitTools, c: Checkout, progress: (p: BuildProgress) => void, signal: AbortSignal): Promise<void> {
  const state = await gitState(t, c.repo);
  if (state.kind === 'ready' && state.changed > 0) {
    throw new AppError('ENGINE_UPDATE_FAILED', `Uncommitted changes in ${c.repo}`, { params: { reason: 'dirty', changed: state.changed, repo: c.repo } });
  }
  progress({ stage: 'git-pull' });
  const [pull, build] = updateCommands(c) as [string[], string[]];
  await runTool(t, [...t.git, ...pull.slice(1)], 'git', () => undefined, signal);
  progress({ stage: 'build' });
  await runTool(
    t,
    [...t.cmake, ...build.slice(1)],
    'cmake',
    (line) => {
      const s = buildStep(line);
      if (s) progress({ stage: 'build', ...s });
    },
    signal,
  );
}
