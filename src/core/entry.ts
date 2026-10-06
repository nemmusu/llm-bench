/**
 * Core process entry. Runs either:
 *  - inside Electron as a utilityProcess (config via env, "ready" sent on process.parentPort), or
 *  - standalone with Node: `node out/core/index.cjs` (browser mode / tests), printing
 *    `{"ready":true,"port":…,"token":…}` on stdout.
 */
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createCore } from './index';
import { createLogger, systemClock } from './node-deps';
import { createProcessRunner } from './process/runner';
import type { CoreDeps, Platform } from './deps';
import { allModules } from './modules';
import v8 from 'node:v8';

declare const __APP_VERSION__: string;

interface ParentPort {
  postMessage(msg: unknown): void;
  on(ev: 'message', cb: (e: { data: unknown }) => void): void;
}

function argv(name: string): string | undefined {
  const pfx = `--${name}=`;
  return process.argv.find((a) => a.startsWith(pfx))?.slice(pfx.length);
}

function toolOverride(v: string | undefined): string[] | undefined {
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

async function main(): Promise<void> {
  const env = process.env;
  const home = os.homedir();
  const dataDir = env.GPUBENCH_DATA_DIR ?? argv('data-dir') ?? defaultDataDir(process.platform, env, home);
  const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;
  const log = createLogger((line) => process.stderr.write(line + '\n'), env.GPUBENCH_DEBUG ? 'debug' : 'info');
  const platform = (['win32', 'linux', 'darwin'].includes(process.platform) ? process.platform : 'linux') as Platform;

  const deps: CoreDeps = {
    clock: systemClock,
    proc: createProcessRunner({ clock: systemClock, platform, baseEnv: env }),
    fetch: globalThis.fetch.bind(globalThis),
    log,
    paths: {
      dataDir,
      cacheDir: path.join(dataDir, 'cache'),
      enginesDir: path.join(dataDir, 'engines'),
      resultsDir: path.join(dataDir, 'results'),
      modelsDir: env.GPUBENCH_MODELS_DIR ?? path.join(home, 'GPU Bench', 'models'),
      resourcesDir: env.GPUBENCH_RESOURCES_DIR ?? path.resolve(__dirname, '../../resources'),
      uiDir: env.GPUBENCH_UI_DIR ?? path.resolve(__dirname, '../renderer'),
      home,
    },
    endpoints: {
      githubApi: env.GPUBENCH_GITHUB_API ?? 'https://api.github.com',
      huggingface: env.GPUBENCH_HF_ENDPOINT ?? 'https://huggingface.co',
      dockerHub: env.GPUBENCH_DOCKERHUB ?? 'https://hub.docker.com',
      nvidiaSmi: toolOverride(env.GPUBENCH_NVIDIA_SMI),
      docker: toolOverride(env.GPUBENCH_DOCKER),
      dockerHost: env.GPUBENCH_DOCKER_HOST,
    },
    platform,
    arch: process.arch,
    env,
    appVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0',
  };

  const token = env.GPUBENCH_TOKEN ?? argv('token') ?? randomBytes(24).toString('base64url');
  const port = Number(env.GPUBENCH_PORT ?? argv('port') ?? 0);
  const core = await createCore(deps, { token, port, modules: allModules });

  const shutdown = async () => {
    await core.close();
    // Tests run with NODE_V8_COVERAGE: flush it explicitly before exiting.
    if (process.env.NODE_V8_COVERAGE) v8.takeCoverage();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  if (parentPort) {
    parentPort.on('message', (e) => {
      const msg = e.data as { type?: string; token?: string | null } | null;
      if (msg?.type === 'shutdown') void shutdown();
      if (msg?.type === 'hf-token') {
        if (msg.token) core.ctx.secrets.hfToken = msg.token;
        else delete core.ctx.secrets.hfToken;
      }
    });
    parentPort.postMessage({ type: 'ready', port: core.port });
  } else {
    process.stdout.write(JSON.stringify({ ready: true, port: core.port, token, url: `${core.url}/?token=${token}` }) + '\n');
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`core failed to start: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
