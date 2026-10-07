import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import v8 from 'node:v8';
import { createCore, type CoreHandle } from './index';
import { createLogger, systemClock } from './node-deps';
import { createProcessRunner } from './process/runner';
import type { CoreDeps, Platform } from './deps';
import { parseArgvEnv } from './services';

/** Channel to the Electron main process when running as a utilityProcess. */
export interface ParentPort {
  postMessage(msg: unknown): void;
  on(ev: 'message', cb: (e: { data: unknown }) => void): void;
}

/** Everything the core process takes from its host process, injected so the start-up is testable. */
export interface BootEnv {
  env: NodeJS.ProcessEnv;
  argv: readonly string[];
  platform: string;
  arch: string;
  home: string;
  /** Folder of the bundled core (resources/ and renderer/ are found relative to it). */
  dirname: string;
  appVersion: string;
  /** Present when started by Electron (utilityProcess). */
  parentPort?: ParentPort;
  stdout(text: string): void;
  stderr(text: string): void;
  onSignal(signal: 'SIGTERM' | 'SIGINT', handler: () => void): void;
  exit(code: number): void;
  /** Flushes NODE_V8_COVERAGE data (tests) before exiting. */
  takeCoverage(): void;
}

/** The real process, for entry.ts. */
export function processBootEnv(dirname: string, appVersion: string): BootEnv {
  return {
    env: process.env,
    argv: process.argv,
    platform: process.platform,
    arch: process.arch,
    home: os.homedir(),
    dirname,
    appVersion,
    ...((process as unknown as { parentPort?: ParentPort }).parentPort ? { parentPort: (process as unknown as { parentPort: ParentPort }).parentPort } : {}),
    stdout: (t) => process.stdout.write(t),
    stderr: (t) => process.stderr.write(t),
    onSignal: (sig, h) => process.on(sig, h),
    exit: (code) => process.exit(code),
    takeCoverage: () => v8.takeCoverage(),
  };
}

/** `--name=value` from argv. */
export function argValue(argv: readonly string[], name: string): string | undefined {
  const pfx = `--${name}=`;
  return argv.find((a) => a.startsWith(pfx))?.slice(pfx.length);
}

/** A tool location override: a JSON argv prefix (e.g. ["node","fake.mjs"]) or a plain path. */
export function toolOverride(v: string | undefined): string[] | undefined {
  if (!v) return undefined;
  try {
    const parsed = JSON.parse(v) as unknown;
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) return parsed as string[];
  } catch {
    /* plain path */
  }
  return [v];
}

export function defaultDataDir(platform: string, env: NodeJS.ProcessEnv, home: string): string {
  if (platform === 'win32') return path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'GPU Bench');
  return path.join(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'gpu-bench');
}

/** Real dependencies of the core, configured from the environment (tests override endpoints and tools). */
export function buildDeps(b: BootEnv): CoreDeps {
  const env = b.env;
  const dataDir = env.GPUBENCH_DATA_DIR ?? argValue(b.argv, 'data-dir') ?? defaultDataDir(b.platform, env, b.home);
  const platform = (['win32', 'linux', 'darwin'].includes(b.platform) ? b.platform : 'linux') as Platform;
  return {
    clock: systemClock,
    proc: createProcessRunner({ clock: systemClock, platform, baseEnv: env }),
    fetch: globalThis.fetch.bind(globalThis),
    log: createLogger((line) => b.stderr(line + '\n'), env.GPUBENCH_DEBUG ? 'debug' : 'info'),
    paths: {
      dataDir,
      cacheDir: path.join(dataDir, 'cache'),
      enginesDir: path.join(dataDir, 'engines'),
      resultsDir: path.join(dataDir, 'results'),
      modelsDir: env.GPUBENCH_MODELS_DIR ?? path.join(b.home, 'GPU Bench', 'models'),
      resourcesDir: env.GPUBENCH_RESOURCES_DIR ?? path.resolve(b.dirname, '../../resources'),
      uiDir: env.GPUBENCH_UI_DIR ?? path.resolve(b.dirname, '../renderer'),
      home: b.home,
    },
    endpoints: {
      githubApi: env.GPUBENCH_GITHUB_API ?? 'https://api.github.com',
      huggingface: env.GPUBENCH_HF_ENDPOINT ?? 'https://huggingface.co',
      dockerHub: env.GPUBENCH_DOCKERHUB ?? 'https://hub.docker.com',
      nvidiaSmi: toolOverride(env.GPUBENCH_NVIDIA_SMI),
      gpuMemoryMonitor: toolOverride(env.GPUBENCH_GPU_MEMORY_MONITOR),
      docker: toolOverride(env.GPUBENCH_DOCKER),
      dockerHost: env.GPUBENCH_DOCKER_HOST,
      dockerInstaller: env.GPUBENCH_DOCKER_INSTALLER_URL,
    },
    platform,
    arch: b.arch,
    env,
    appVersion: b.appVersion,
  };
}

/**
 * Starts the core and connects it to its host: inside Electron it reports "ready" on the parent
 * port and listens for shutdown / HF-token messages; standalone (browser mode, tests) it prints
 * `{"ready":true,"port":…,"token":…,"url":…}` on stdout.
 */
export async function boot(b: BootEnv): Promise<CoreHandle> {
  const env = b.env;
  const deps = buildDeps(b);
  const token = env.GPUBENCH_TOKEN ?? argValue(b.argv, 'token') ?? randomBytes(24).toString('base64url');
  const port = Number(env.GPUBENCH_PORT ?? argValue(b.argv, 'port') ?? 0);
  const llamaLauncherPrefix = parseArgvEnv(env.GPUBENCH_LLAMA_LAUNCHER);
  const core = await createCore(deps, { token, port, services: llamaLauncherPrefix ? { llamaLauncherPrefix } : {} });

  let closing: Promise<void> | undefined;
  const shutdown = () =>
    (closing ??= (async () => {
      await core.close();
      // Tests run with NODE_V8_COVERAGE: flush it explicitly before exiting.
      if (env.NODE_V8_COVERAGE) b.takeCoverage();
      b.exit(0);
    })());
  b.onSignal('SIGTERM', () => void shutdown());
  b.onSignal('SIGINT', () => void shutdown());

  if (b.parentPort) {
    b.parentPort.on('message', (e) => {
      const msg = e.data as { type?: string; token?: string | null } | null;
      if (msg?.type === 'shutdown') void shutdown();
      if (msg?.type === 'hf-token') {
        if (msg.token) core.ctx.secrets.hfToken = msg.token;
        else delete core.ctx.secrets.hfToken;
      }
    });
    b.parentPort.postMessage({ type: 'ready', port: core.port });
  } else {
    b.stdout(JSON.stringify({ ready: true, port: core.port, token, url: `${core.url}/?token=${token}` }) + '\n');
  }
  return core;
}

/** What to do when the core cannot start: explain on stderr and exit with an error. */
export function onBootError(b: Pick<BootEnv, 'stderr' | 'exit'>): (e: unknown) => void {
  return (e) => {
    b.stderr(`core failed to start: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    b.exit(1);
  };
}
