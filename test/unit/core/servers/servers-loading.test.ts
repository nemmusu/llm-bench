import { describe, expect, it } from 'vitest';
import { AppError } from '../../../../src/contract/errors';
import type { ExitInfo, LogLine } from '../../../../src/core/deps';
import type { EngineAdapter, EngineInstance, LaunchPlan } from '../../../../src/core/engines/types';
import { systemClock } from '../../../../src/core/node-deps';
import { AsyncQueue } from '../../../../src/core/process/runner';
import { ServeService, type ServeServiceDeps } from '../../../../src/core/servers/service';
import { fakePorts } from './helpers';

/** An engine that answers only when the test says so, with a log the test writes. */
function slowInstance(o: { logsFail?: boolean } = {}) {
  const logs = new AsyncQueue<LogLine>();
  let ready!: () => void;
  let fail!: (e: Error) => void;
  const readyP = new Promise<{ tReady: number; phases: [] }>((res, rej) => {
    ready = () => res({ tReady: 1, phases: [] });
    fail = rej;
  });
  let resolveExit!: (e: ExitInfo) => void;
  const exited = new Promise<ExitInfo>((r) => (resolveExit = r));
  let stops = 0;
  const instance: EngineInstance = {
    baseUrl: 'http://127.0.0.1:5555',
    t0: systemClock.now(),
    logs: o.logsFail
      ? {
          [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('log stream broke')) }),
        }
      : logs,
    waitReady: (signal) => {
      const cancel = () => fail(new AppError('CANCELLED', 'Engine start cancelled'));
      if (signal?.aborted) cancel();
      signal?.addEventListener('abort', cancel, { once: true });
      return readyP;
    },
    client: {} as never,
    stop: async () => {
      stops++;
      resolveExit({ code: 0, signal: null });
      return { code: 0, signal: null };
    },
    exited,
    logTail: () => [],
  };
  return { instance, log: (text: string) => logs.push({ t: systemClock.now(), stream: 'stderr', text }), ready: () => ready(), fail: (e: Error) => fail(e), stops: () => stops };
}

function setup(o: { startFails?: Error; logsFail?: boolean; expectedLoadMs?: number; kind?: LaunchPlan['kind'] } = {}) {
  const made: ReturnType<typeof slowInstance>[] = [];
  let changes = 0;
  const kind = o.kind ?? 'vllm-docker';
  const plan: LaunchPlan = {
    kind,
    argv: ['docker', 'run', 'vllm/vllm-openai'],
    env: {},
    host: '127.0.0.1',
    port: 5555,
    params: { extraArgs: [], env: {} },
    engine: { kind, name: 'vLLM', version: '0.12.0' },
    modelFiles: [],
    modelBytes: 0,
    marker: 'x',
  };
  const adapter = {
    kind,
    start: async () => {
      if (o.startFails) throw o.startFails;
      const s = slowInstance(o);
      made.push(s);
      return s.instance;
    },
  } as unknown as EngineAdapter;
  const deps: ServeServiceDeps = {
    clock: systemClock,
    prepare: async () => ({
      model: { identity: { displayName: 'Qwen3 4B', format: 'safetensors', source: 'hf', files: [], weakKey: 'k' } },
      adapter,
      launch: plan,
      ...(o.expectedLoadMs !== undefined ? { expectedLoadMs: o.expectedLoadMs } : {}),
    }),
    plan: async () => {
      throw new Error('unused');
    },
    blockedBy: () => undefined,
    displayCommand: (argv) => ({ powershell: argv.join(' '), bash: argv.join(' ') }),
    redact: (argv, env) => ({ argv, env }),
    onChange: () => changes++,
    ports: fakePorts(),
    lanUrls: () => [],
    secrets: () => [],
  };
  return { svc: new ServeService(deps), made, changes: () => changes };
}

const req = { engine: { kind: 'vllm-docker' as const }, model: { repo: 'Qwen/Qwen3-4B' } };
const tick = () => new Promise((r) => setTimeout(r, 5));

describe('ServeService while the engine starts', () => {
  it('lists the server at once with what it is doing, then without it once it answers', async () => {
    const { svc, made, changes } = setup({ expectedLoadMs: 45_000 });
    const started = svc.start(req, new AbortController().signal);
    await tick();
    expect(svc.busy()).toBe(true);
    expect(changes()).toBe(1);
    expect(svc.list()[0]?.loading).toMatchObject({ stage: 'container', expectedMs: 45_000 });
    made[0]!.log('Loading safetensors checkpoint shards:  50% Completed | 2/4 [00:02<00:02,  1.00it/s]');
    await tick();
    expect(svc.list()[0]?.loading).toMatchObject({ stage: 'weights', done: 2, total: 4, fraction: 0.5, expectedMs: 45_000 });
    made[0]!.ready();
    const info = await started;
    expect(info).not.toHaveProperty('loading');
    expect(svc.list()).toEqual([info]);
    // The log keeps being drained while the server runs, without touching the info.
    made[0]!.log('INFO:     127.0.0.1:5000 - "POST /v1/completions HTTP/1.1" 200 OK');
    await tick();
    expect(svc.list()).toEqual([info]);
    await svc.stop(info.id);
  });

  it('stopping a server that is still loading cancels its start', async () => {
    const { svc, made, changes } = setup({ kind: 'llamacpp-native' });
    const started = svc.start(req, new AbortController().signal);
    await tick();
    const id = svc.list()[0]!.id;
    expect(svc.list()[0]?.loading?.stage).toBe('starting');
    await svc.stop(id);
    await expect(started).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(svc.list()).toEqual([]);
    expect(svc.busy()).toBe(false);
    expect(made[0]!.stops()).toBeGreaterThanOrEqual(1);
    // Started (1) and stopped (2): the failed start does not count a third change.
    expect(changes()).toBe(2);
  });

  it('a start that fails is forgotten; a launch that fails never shows up; a shut-down app cancels at once', async () => {
    const failing = setup();
    const started = failing.svc.start(req, new AbortController().signal);
    await tick();
    failing.made[0]!.fail(new AppError('ENGINE_OOM', 'oom'));
    await expect(started).rejects.toMatchObject({ code: 'ENGINE_OOM' });
    expect(failing.svc.list()).toEqual([]);
    expect(failing.changes()).toBe(2);

    const noLaunch = setup({ startFails: new AppError('ENGINE_START_FAILED', 'docker') });
    await expect(noLaunch.svc.start(req, new AbortController().signal)).rejects.toMatchObject({ code: 'ENGINE_START_FAILED' });
    expect(noLaunch.changes()).toBe(0);

    const down = setup({ logsFail: true });
    await expect(down.svc.start(req, AbortSignal.abort())).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(down.svc.list()).toEqual([]);
  });
});
