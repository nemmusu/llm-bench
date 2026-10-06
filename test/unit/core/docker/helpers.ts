import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Clock, ExitInfo, LogLine, Logger, ManagedProcess, ProcessRunner, RunOptions, RunOutput, SpawnSpec } from '../../../../src/core/deps';
import { AsyncQueue } from '../../../../src/core/process/runner';

export const FAKE_DOCKER = fileURLToPath(new URL('../../../fakes/fake-docker/fake-docker.mjs', import.meta.url));
export const FAKE_ENGINE = fileURLToPath(new URL('../../../fakes/fake-engine/cli.mjs', import.meta.url));
export const DOCKER_FIXTURES = fileURLToPath(new URL('../../../fixtures/docker/', import.meta.url));
export const VLLM_FIXTURES = fileURLToPath(new URL('../../../fixtures/vllm/', import.meta.url));
export const RESOURCES = fileURLToPath(new URL('../../../../resources/', import.meta.url));

export function tempDir(prefix = 'gb-docker-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

export const ok = (stdout = '', stderr = ''): RunOutput => ({ code: 0, stdout, stderr, timedOut: false });
export const fail = (code: number | null, stderr: string, stdout = ''): RunOutput => ({ code, stdout, stderr, timedOut: false });

export interface Call {
  cmd: string;
  args: string[];
  opts?: RunOptions;
}

/** ProcessRunner whose run() answers from a handler keyed on the args; spawn() from another handler. */
export function scriptedProc(
  run: (args: string[], cmd: string, opts?: RunOptions) => RunOutput | Promise<RunOutput>,
  spawn?: (spec: SpawnSpec) => ManagedProcess,
): ProcessRunner & { calls: Call[]; spawns: SpawnSpec[] } {
  const calls: Call[] = [];
  const spawns: SpawnSpec[] = [];
  return {
    calls,
    spawns,
    async run(cmd, args, opts) {
      calls.push({ cmd, args, ...(opts ? { opts } : {}) });
      return run(args, cmd, opts);
    },
    spawn(spec) {
      spawns.push(spec);
      if (!spawn) throw new Error('no spawn in this test');
      return spawn(spec);
    },
  };
}

/** A ManagedProcess fed by the test: push lines, then exit. */
export function manualProcess(startedAt = 0, pid = 4242) {
  const lines = new AsyncQueue<LogLine>();
  let resolveExit!: (e: ExitInfo) => void;
  const exited = new Promise<ExitInfo>((r) => (resolveExit = r));
  let stopped = 0;
  const mp: ManagedProcess & { push(text: string, t?: number, stream?: 'stdout' | 'stderr'): void; exit(e?: ExitInfo): void; stopped(): number } = {
    pid,
    startedAt,
    lines,
    exited,
    stop: async () => {
      stopped++;
      lines.close();
      resolveExit({ code: 0, signal: null });
      return exited;
    },
    push: (text, t = 0, stream = 'stdout') => lines.push({ t, stream, text }),
    exit: (e = { code: 0, signal: null }) => {
      lines.close();
      resolveExit(e);
    },
    stopped: () => stopped,
  };
  return mp;
}

/** Clock whose sleep() advances time instantly (deterministic polling loops). */
export function steppingClock(start = 1000): Clock & { t: number } {
  const c = {
    t: start,
    now: () => c.t,
    wall: () => 1_760_000_000_000 + c.t,
    sleep: async (ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      c.t += ms;
      await Promise.resolve();
    },
  };
  return c;
}

export const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

export function recordingLog(): Logger & { entries: { level: string; msg: string; data?: Record<string, unknown> }[] } {
  const entries: { level: string; msg: string; data?: Record<string, unknown> }[] = [];
  const at = (level: string) => (msg: string, data?: Record<string, unknown>) => {
    entries.push({ level, msg, ...(data ? { data } : {}) });
  };
  return { entries, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

/** A Response-returning fetch from a route table (offline). */
export function routeFetch(routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>): typeof globalThis.fetch & { urls: string[] } {
  const urls: string[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    for (const [prefix, h] of Object.entries(routes)) if (url.startsWith(prefix)) return h(init);
    throw new TypeError(`fetch failed: ${url}`);
  }) as typeof globalThis.fetch & { urls: string[] };
  f.urls = urls;
  return f;
}

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Removes every container a fake docker CLI knows (afterAll safety net when a test fails before stop()). */
export async function removeAllContainers(cli: { ps(f: readonly string[]): Promise<{ id: string }[]>; rm(id: string, force?: boolean): Promise<void> }): Promise<void> {
  try {
    for (const c of await cli.ps([])) await cli.rm(c.id, true).catch(() => undefined);
  } catch {
    /* state already gone */
  }
}
