/**
 * Everything the core touches in the outside world goes through these interfaces, injected
 * into createCore(). Tests swap them for fakes, which is what makes Windows-only and
 * Linux-only branches testable on any OS.
 */

export interface Clock {
  /** Monotonic milliseconds (performance.now based). Use for every measurement. */
  now(): number;
  /** Wall clock, ms since epoch. Use only for timestamps shown to users. */
  wall(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface LogLine {
  /** Monotonic ms (Clock.now) when the line was read. */
  t: number;
  stream: 'stdout' | 'stderr';
  text: string;
}

export interface ExitInfo {
  code: number | null;
  signal: string | null;
}

export interface RunOptions {
  timeoutMs?: number;
  env?: Record<string, string>;
  cwd?: string;
  signal?: AbortSignal;
  /** Text written to stdin, then stdin is closed. */
  input?: string;
}

export interface RunOutput {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface SpawnSpec {
  cmd: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Ownership marker recorded in the registry: we only ever stop processes we started. */
  owner: { runId: string; marker: string };
}

export interface ManagedProcess {
  pid: number;
  /** Monotonic ms of spawn. */
  startedAt: number;
  /** Every stdout/stderr line, as it arrives. Ends when the process exits. */
  lines: AsyncIterable<LogLine>;
  exited: Promise<ExitInfo>;
  /** Graceful stop (SIGTERM / taskkill without /F), then force after graceMs. Only our own tree. */
  stop(opts?: { graceMs?: number }): Promise<ExitInfo>;
}

export interface ProcessRunner {
  run(cmd: string, args: string[], opts?: RunOptions): Promise<RunOutput>;
  spawn(spec: SpawnSpec): ManagedProcess;
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface CorePaths {
  /** Root of app data (settings.json, cache, engines, default results/models). */
  dataDir: string;
  cacheDir: string;
  enginesDir: string;
  /** Default results folder (settings.resultsDir overrides it). */
  resultsDir: string;
  /** Default models folder (settings.modelsDir overrides it). */
  modelsDir: string;
  /** The default models folder of GPU Bench (before 0.4.0), adopted while the user keeps the default (models/legacy-dir.ts). */
  legacyModelsDir?: string;
  /** Bundled read-only resources (corpus, curated models, compat tables). */
  resourcesDir: string;
  /** Built renderer to serve (undefined = API only). */
  uiDir?: string;
  home: string;
}

/**
 * External endpoints and tool locations. Production uses the defaults; tests point them at
 * local fakes (fake-hub, fake-nvidia-smi, fake docker…). A tool is an argv prefix so a fake
 * can be "node fake.mjs".
 */
export interface CoreEndpoints {
  githubApi: string;
  huggingface: string;
  dockerHub: string;
  nvidiaSmi?: string[];
  /** A stand-in for the per-process GPU memory monitor (Windows counters), speaking its protocol (tests, fakes). */
  gpuMemoryMonitor?: string[];
  docker?: string[];
  /** Docker Engine API endpoint override (named pipe or unix socket path, or tcp URL). */
  dockerHost?: string;
  /** Docker Desktop installer URL override (tests/E2E point it at a local server). */
  dockerInstaller?: string;
  /** PyPI (https://pypi.org): the newest vLLM / SGLang releases for the update check. */
  pypi?: string;
  /** git and cmake, to update an engine built from a git checkout (default from PATH). */
  git?: string[];
  cmake?: string[];
  /** wsl.exe stand-in (tests, E2E: a fake that runs the fake NInfer), as an argv prefix. */
  wsl?: string[];
  /**
   * Native NInfer (Linux), tests and E2E only: an argv placed before every program NInfer's support runs
   * (its checks, its builds, ninfer-serve), so a fake Linux host stands in for this one.
   */
  ninferHost?: string[];
}

export type Platform = 'win32' | 'linux' | 'darwin';

export interface CoreDeps {
  clock: Clock;
  proc: ProcessRunner;
  fetch: typeof globalThis.fetch;
  log: Logger;
  paths: CorePaths;
  endpoints: CoreEndpoints;
  platform: Platform;
  arch: string;
  env: Record<string, string | undefined>;
  appVersion: string;
}
