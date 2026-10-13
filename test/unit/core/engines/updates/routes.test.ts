import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { EngineUpdateCheck } from '../../../../../src/contract/engine-updates';
import { AppError } from '../../../../../src/contract/errors';
import type { ServerEvent } from '../../../../../src/contract/events';
import type { CoreContext } from '../../../../../src/core/context';
import { createEngineUpdateRoutes } from '../../../../../src/core/engines/updates/routes';
import type { UpdateProgress } from '../../../../../src/core/engines/updates/service';
import { errorResponse } from '../../../../../src/core/server/http-error';

const check = (target: string): EngineUpdateCheck => ({ target, method: 'uv', state: 'available', commands: [], checkedAt: '2026-10-13T10:00:00.000Z' });

function setup(o: { update?: (target: string, p: (p: UpdateProgress) => void, signal: AbortSignal) => Promise<{ version?: string }>; busy?: boolean; shutdown?: AbortSignal } = {}) {
  const events: ServerEvent[] = [];
  const checks: { target: string; fetch?: boolean }[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const app = new Hono();
  app.onError((e, c) => errorResponse(c, e));
  createEngineUpdateRoutes({
    updates: {
      check: async (target, opts) => {
        checks.push({ target, ...opts });
        return check(target);
      },
      labelOf: async (target) => (target === 'custom:prism' ? 'PrismML' : 'vLLM'),
      update:
        o.update ??
        (async (_t, progress) => {
          progress({ stage: 'build', bytesDone: 0, step: 3, steps: 10 });
          await gate;
          return { version: '0.11.2' };
        }),
    },
    publish: (e) => events.push(e),
    ...(o.busy !== undefined ? { busy: () => o.busy as boolean } : {}),
    ...(o.shutdown ? { shutdown: o.shutdown } : {}),
  })(app, {} as CoreContext);
  const req = (method: string, url: string) => app.request(url, { method });
  return { req, events, checks, release };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('engine update API', () => {
  it('checks built-in and custom engines, asking the remote again on request', async () => {
    const s = setup();
    expect(await (await s.req('GET', '/api/engines/vllm-native/update')).json()).toMatchObject({ target: 'vllm-native' });
    await s.req('GET', '/api/engines/custom/prism/update?fetch=1');
    expect(s.checks).toEqual([
      { target: 'vllm-native', fetch: false },
      { target: 'custom:prism', fetch: true },
    ]);
  });

  it('runs an update with its progress events, one at a time per engine', async () => {
    const s = setup();
    expect(await (await s.req('POST', '/api/engines/custom/prism/update')).json()).toEqual({ ok: true });
    const again = await s.req('POST', '/api/engines/custom/prism/update');
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: { code: 'VALIDATION', params: { reason: 'busy' } } });
    s.release();
    await settle();
    expect(s.events).toEqual([
      { type: 'engine.install', kind: 'update:custom:prism', label: 'PrismML', stage: 'resolve', bytesDone: 0 },
      { type: 'engine.install', kind: 'update:custom:prism', label: 'PrismML', stage: 'build', bytesDone: 0, step: 3, steps: 10 },
      { type: 'engine.install', kind: 'update:custom:prism', label: 'PrismML', stage: 'done', bytesDone: 0, result: { version: '0.11.2' } },
    ]);
    // Finished: it can run again.
    expect((await s.req('POST', '/api/engines/custom/prism/update')).status).toBe(200);
  });

  it('a failure is the last event; no version, no result; refused while a benchmark runs', async () => {
    const failing = setup({
      update: async (_t, p) => {
        p({ stage: 'download', bytesDone: 1, bytesTotal: 2 });
        throw new AppError('ENGINE_UPDATE_FAILED', 'cmake failed', { params: { reason: 'cmake' } });
      },
    });
    await failing.req('POST', '/api/engines/vllm-native/update');
    await settle();
    expect(failing.events.map((e) => (e.type === 'engine.install' ? [e.stage, e.bytesTotal, e.error?.code] : []))).toEqual([
      ['resolve', undefined, undefined],
      ['download', 2, undefined],
      ['error', undefined, 'ENGINE_UPDATE_FAILED'],
    ]);
    const plain = setup({ update: async () => ({}) });
    await plain.req('POST', '/api/engines/sglang-docker/update');
    await settle();
    expect(plain.events.at(-1)).toEqual({ type: 'engine.install', kind: 'update:sglang-docker', label: 'vLLM', stage: 'done', bytesDone: 0 });
    const busy = setup({ busy: true });
    const res = await busy.req('POST', '/api/engines/vllm-docker/update');
    expect(await res.json()).toMatchObject({ error: { code: 'ENGINE_UPDATE_FAILED', params: { reason: 'busy' } } });
    expect(busy.events).toEqual([]);
    expect((await setup({ busy: false }).req('POST', '/api/engines/vllm-docker/update')).status).toBe(200);
  });

  it('the core shutting down cancels it', async () => {
    const ac = new AbortController();
    const s = setup({
      shutdown: ac.signal,
      update: (_t, _p, signal) =>
        new Promise((_r, reject) => signal.addEventListener('abort', () => reject(new AppError('CANCELLED', 'stop')))),
    });
    await s.req('POST', '/api/engines/vllm-native/update');
    ac.abort();
    await settle();
    expect(s.events.at(-1)).toMatchObject({ stage: 'error', error: { code: 'CANCELLED' } });
  });
});
