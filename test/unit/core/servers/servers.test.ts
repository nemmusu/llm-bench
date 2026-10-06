import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { ExitInfo } from '../../../../src/core/deps';
import type { EngineAdapter, EngineInstance, LaunchPlan } from '../../../../src/core/engines/types';
import { systemClock } from '../../../../src/core/node-deps';
import { createServerRoutes } from '../../../../src/core/servers/routes';
import { ServeService, type ServeServiceDeps } from '../../../../src/core/servers/service';
import { AppError } from '../../../../src/contract/errors';
import { errorResponse } from '../../../../src/core/server/http-error';
import type { CoreContext } from '../../../../src/core/context';

function fakeInstance(opts: { failReady?: boolean; stopFails?: boolean } = {}) {
  let resolveExit!: (e: ExitInfo) => void;
  const exited = new Promise<ExitInfo>((r) => (resolveExit = r));
  let stopped = 0;
  const instance = {
    baseUrl: 'http://127.0.0.1:5555',
    t0: 0,
    logs: (async function* () {})(),
    waitReady: () => (opts.failReady ? Promise.reject(new Error('oom')) : Promise.resolve({ tReady: 1, phases: [] })),
    client: {} as never,
    stop: async () => {
      stopped++;
      if (opts.stopFails) throw new Error('already gone');
      resolveExit({ code: 0, signal: null });
      return { code: 0, signal: null };
    },
    exited,
    logTail: () => [],
  } satisfies EngineInstance;
  return { instance, stopped: () => stopped, crash: () => resolveExit({ code: 1, signal: null }) };
}

function setup(opts: { failReady?: boolean; stopFails?: boolean; build?: string; blocked?: AppError; contextSize?: number } = {}) {
  const made: ReturnType<typeof fakeInstance>[] = [];
  const markers: string[] = [];
  let changes = 0;
  const plan: LaunchPlan = {
    kind: 'llamacpp-native',
    argv: ['llama-server', '-m', 'm.gguf', '--api-key', 'secret'],
    env: { HF_TOKEN: 'hf_x' },
    host: '127.0.0.1',
    port: 5555,
    params: { extraArgs: [], env: {} },
    engine: { kind: 'llamacpp-native', name: 'llama.cpp', ...(opts.build ? { build: opts.build } : { version: '1.0' }) },
    modelFiles: [],
    modelBytes: 0,
    marker: 'x',
  };
  const adapter = {
    kind: 'llamacpp-native',
    start: async () => {
      const f = fakeInstance(opts);
      made.push(f);
      return f.instance;
    },
  } as unknown as EngineAdapter;
  const deps: ServeServiceDeps = {
    clock: systemClock,
    prepare: async (req, marker) => {
      // Like BenchService.prepareServer: external endpoints are already running.
      if (req.engine.kind === 'external') throw new AppError('VALIDATION', 'external', { params: { reason: 'external' } });
      markers.push(marker);
      return {
        model: { identity: { displayName: 'Qwen3 4B', format: 'gguf', source: 'local', files: [], weakKey: 'k' } },
        adapter,
        launch: plan,
        ...(opts.contextSize ? { contextSize: opts.contextSize } : {}),
      };
    },
    plan: async () => ({ command: { argv: ['llama-server'], powershell: 'llama-server', bash: 'llama-server' }, needs: [], params: { contextSize: 32768, extraArgs: [], env: {} }, contextSize: 32768, warnings: [] }),
    blockedBy: () => opts.blocked,
    displayCommand: (argv) => ({ powershell: `& ${argv.join(' ')}`, bash: argv.join(' ') }),
    redact: (argv, env) => ({ argv: argv.map((a) => (a === 'secret' ? '<API_KEY>' : a)), env: { ...env, HF_TOKEN: '<HF_TOKEN>' } }),
    onChange: () => changes++,
  };
  return { svc: new ServeService(deps), made, markers, changes: () => changes };
}

const req = { engine: { kind: 'llamacpp-native' as const }, model: { localId: 'a' } };

describe('ServeService', () => {
  it('starts an engine, reports its URLs, context and the redacted command, and stops it', async () => {
    const { svc, made, markers, changes } = setup({ build: 'b11438', contextSize: 32768 });
    expect(svc.busy()).toBe(false);
    const info = await svc.start(req, new AbortController().signal);
    expect(info).toMatchObject({
      baseUrl: 'http://127.0.0.1:5555',
      openaiUrl: 'http://127.0.0.1:5555/v1',
      modelName: 'Qwen3 4B',
      engineLabel: 'llama.cpp b11438',
      contextSize: 32768,
      command: { argv: ['llama-server', '-m', 'm.gguf', '--api-key', '<API_KEY>'], bash: 'llama-server -m m.gguf --api-key <API_KEY>' },
    });
    // The server's id is the ownership marker its engine was prepared with.
    expect(info.id).toMatch(/^gpubench-/);
    expect(markers).toEqual([info.id]);
    expect(svc.busy()).toBe(true);
    expect(svc.list()).toEqual([info]);
    expect(changes()).toBe(1);
    await svc.stop(info.id);
    expect(made[0]!.stopped()).toBe(1);
    expect(svc.list()).toEqual([]);
    // Stopped by us: the exit is not counted as a second change.
    await new Promise((r) => setTimeout(r, 5));
    expect(changes()).toBe(2);
    await expect(svc.stop(info.id)).rejects.toMatchObject({ code: 'VALIDATION', params: { reason: 'not_found' } });
  });

  it('refuses to start while a benchmark runs (blockedBy), and plans through its dependency', async () => {
    const { svc, made, markers } = setup({ blocked: new AppError('RUN_IN_PROGRESS', 'busy', { params: { runId: 'r1' } }) });
    await expect(svc.start(req, new AbortController().signal)).rejects.toMatchObject({ code: 'RUN_IN_PROGRESS', params: { runId: 'r1' } });
    expect(made).toEqual([]);
    expect(markers).toEqual([]);
    expect(await svc.plan(req)).toMatchObject({ contextSize: 32768, params: { contextSize: 32768 } });
  });

  it('forgets an engine that exits on its own, and stops everything at shutdown', async () => {
    const { svc, made, changes } = setup();
    const a = await svc.start(req, new AbortController().signal);
    expect(a.engineLabel).toBe('llama.cpp 1.0');
    expect(a.contextSize).toBeUndefined();
    made[0]!.crash();
    await new Promise((r) => setTimeout(r, 5));
    expect(svc.list()).toEqual([]);
    expect(changes()).toBe(2);
    await svc.start(req, new AbortController().signal);
    await svc.start(req, new AbortController().signal);
    await svc.stopAll();
    expect(made.slice(1).map((m) => m.stopped())).toEqual([1, 1]);
    expect(svc.busy()).toBe(false);
  });

  it('stops the engine when it never gets ready, and refuses external endpoints', async () => {
    const { svc, made } = setup({ failReady: true });
    await expect(svc.start(req, new AbortController().signal)).rejects.toThrow('oom');
    expect(made[0]!.stopped()).toBe(1);
    await expect(svc.start({ engine: { kind: 'external', baseUrl: 'http://h:1' }, model: {} }, new AbortController().signal)).rejects.toMatchObject({
      code: 'VALIDATION',
      params: { reason: 'external' },
    });
  });
});

describe('ServeService when stopping fails', () => {
  it('still reports the start failure and never throws from stopAll', async () => {
    const failing = setup({ failReady: true, stopFails: true });
    await expect(failing.svc.start(req, new AbortController().signal)).rejects.toThrow('oom');
    const stuck = setup({ stopFails: true });
    await stuck.svc.start(req, new AbortController().signal);
    await expect(stuck.svc.stopAll()).resolves.toBeUndefined();
    expect(stuck.svc.busy()).toBe(false);
  });
});

describe('server routes', () => {
  it('lists, starts and stops servers, and stops them on shutdown', async () => {
    const { svc } = setup();
    const shutdown = new AbortController();
    const app = new Hono();
    app.onError((e, c) => errorResponse(c, e));
    createServerRoutes(svc)(app, { shutdown: shutdown.signal } as CoreContext);
    expect(await (await app.request('/api/servers')).json()).toEqual([]);
    const started = await app.request('/api/servers', { method: 'POST', body: JSON.stringify(req) });
    const info = (await started.json()) as { id: string };
    expect(info.id).toMatch(/^gpubench-/);
    expect(await (await app.request(`/api/servers/${info.id}`, { method: 'DELETE' })).json()).toEqual({ ok: true });
    expect((await app.request('/api/servers/nope', { method: 'DELETE' })).status).toBe(400);
    const plan = await app.request('/api/servers/plan', { method: 'POST', body: JSON.stringify(req) });
    expect(await plan.json()).toMatchObject({ contextSize: 32768 });
    expect((await app.request('/api/servers/plan', { method: 'POST', body: JSON.stringify({ model: {} }) })).status).toBe(400);
    await app.request('/api/servers', { method: 'POST', body: JSON.stringify(req) });
    shutdown.abort();
    await new Promise((r) => setTimeout(r, 5));
    expect(svc.busy()).toBe(false);
  });
});
