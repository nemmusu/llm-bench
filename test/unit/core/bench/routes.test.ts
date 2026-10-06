import { afterEach, describe, expect, it } from 'vitest';
import type { ServerEvent } from '../../../../src/contract/events';
import { createBenchRoutes } from '../../../../src/core/bench/routes';
import { BenchService } from '../../../../src/core/bench/service';
import type { CoreContext } from '../../../../src/core/context';
import type { CoreDeps } from '../../../../src/core/deps';
import { createApp } from '../../../../src/core/server/app';
import { EventHub } from '../../../../src/core/server/event-hub';
import { SettingsRepo } from '../../../../src/core/store/settings-repo';
import { hardware, makeRun, modelIdentity } from '../store/fixtures';
import { deferred } from './fakes';
import { request, serviceSetup, TempDirs } from './service-helpers';

const tmp = new TempDirs();
afterEach(() => tmp.cleanup());

const PORT = 4321;
const TOKEN = 'test-token';

function setup(opts: Parameters<typeof serviceSetup>[1] = {}) {
  const s = serviceSetup(tmp, opts);
  const svc = new BenchService(s.deps);
  const hub = new EventHub();
  const hubEvents: ServerEvent[] = [];
  hub.subscribe((e) => hubEvents.push(e));
  // Bench routes only use ctx.hub; the cast keeps this test independent of other services in the context.
  const ctx = {
    deps: { appVersion: '0.1.0-test', paths: {} } as unknown as CoreDeps,
    hub,
    settings: new SettingsRepo(tmp.make()),
    shutdown: new AbortController().signal,
    secrets: {},
  } as unknown as CoreContext;
  const app = createApp(ctx, { token: TOKEN, port: () => PORT, modules: [createBenchRoutes(svc, s.runs)] });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(`http://127.0.0.1:${PORT}${url}`, {
      method,
      headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as unknown };
  };
  const ids = async (url: string) => ((await call('GET', url)).body as { id: string }[]).map((r) => r.id);
  return { ...s, svc, call, ids, hubEvents };
}

describe('bench routes', () => {
  it('GET /api/runs lists and filters by model and GPU', async () => {
    const t = setup();
    await t.runs.save(makeRun({ id: 'a' }));
    await t.runs.save(makeRun({ id: 'b', model: modelIdentity({ weakKey: 'other', sha256: 'S1' }) }));
    await t.runs.save(makeRun({ id: 'c', hardware: hardware({ gpus: [{ ...hardware().gpus[0]!, uuid: 'GPU-x', name: 'RTX 3070' }] }) }));
    expect((await t.ids('/api/runs')).sort()).toEqual(['a', 'b', 'c']);
    expect(await t.ids('/api/runs?model=other')).toEqual(['b']);
    expect(await t.ids('/api/runs?model=S1')).toEqual(['b']);
    expect(await t.ids('/api/runs?gpu=RTX%203070')).toEqual(['c']);
    expect((await t.ids('/api/runs?gpu=GPU-aaaa')).sort()).toEqual(['a', 'b']);
  });

  it('GET /api/runs/tried needs weakKey and ranks this PC first', async () => {
    const t = setup();
    await t.runs.save(makeRun({ id: 'far', hardware: hardware({ hostId: 'x', gpus: [] }), createdAt: '2026-10-07T00:00:00.000Z' }));
    await t.runs.save(makeRun({ id: 'here' }));
    expect((await t.call('GET', '/api/runs/tried')).status).toBe(400);
    expect(await t.ids(`/api/runs/tried?weakKey=${encodeURIComponent(modelIdentity().weakKey)}&sha256=zzz`)).toEqual(['here', 'far']);
    const noSha = await t.call('GET', `/api/runs/tried?weakKey=${encodeURIComponent(modelIdentity().weakKey)}`);
    expect(noSha.body).toHaveLength(2);
  });

  it('GET/DELETE /api/runs/:id', async () => {
    const t = setup();
    await t.runs.save(makeRun({ id: 'r1' }));
    expect((await t.call('GET', '/api/runs/r1')).body).toMatchObject({ id: 'r1', status: 'completed' });
    const missing = await t.call('GET', '/api/runs/nope');
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ error: { code: 'VALIDATION', params: { id: 'nope', reason: 'not_found' } } });
    expect((await t.call('DELETE', '/api/runs/r1')).body).toEqual({ ok: true });
    expect(t.hubEvents).toEqual([{ type: 'runs.changed' }]);
    expect((await t.call('DELETE', '/api/runs/r1')).status).toBe(404);
  });

  it('POST /api/runs starts a run; active and cancel follow it', async () => {
    const gate = deferred();
    const t = setup({ adapter: { gate: gate.promise } });
    expect((await t.call('GET', '/api/runs/active')).body).toEqual({ active: null });
    const started = await t.call('POST', '/api/runs', request());
    expect(started.status).toBe(200);
    const runId = (started.body as unknown as { runId: string }).runId;
    expect((await t.call('GET', '/api/runs/active')).body).toMatchObject({ active: { runId } });
    expect((await t.call('POST', '/api/runs/other/cancel')).status).toBe(404);
    // A second start while one runs is refused with VALIDATION (400).
    const busy = await t.call('POST', '/api/runs', request());
    expect(busy.status).toBe(400);
    expect(busy.body).toMatchObject({ error: { code: 'VALIDATION', params: { reason: 'run_in_progress' } } });
    expect((await t.call('POST', `/api/runs/${runId}/cancel`)).body).toEqual({ ok: true });
    gate.resolve();
    await t.svc.whenIdle();
    expect((await t.call('GET', `/api/runs/${runId}`)).body).toMatchObject({ status: 'cancelled' });
  });

  it('validates request bodies', async () => {
    const t = setup();
    const bad = await t.call('POST', '/api/runs', { engine: { kind: 'nope' } });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ error: { code: 'VALIDATION' } });
    expect((await t.call('POST', '/api/runs/plan', '{not json')).status).toBe(400);
    expect((await t.call('POST', '/api/runs/export', { ids: [] })).status).toBe(400);
  });

  it('POST /api/runs/plan previews the run', async () => {
    const t = setup();
    const plan = await t.call('POST', '/api/runs/plan', request({ profile: 'standard' }));
    expect(plan.status).toBe(200);
    expect(plan.body).toMatchObject({
      command: { argv: expect.arrayContaining(['llama-server']) },
      needs: [],
      warnings: [{ code: 'concurrency_level_skipped', params: { level: 4, parallel: 1 } }],
    });
  });

  it('POST /api/runs/export and /api/runs/import round-trip', async () => {
    const a = setup();
    await a.runs.save(makeRun({ id: 'e1' }));
    const bundle = (await a.call('POST', '/api/runs/export', { ids: ['e1', 'missing'] })).body as unknown as { format: string; runs: unknown[] };
    expect(bundle.format).toBe('gpubench-export');
    expect(bundle.runs).toHaveLength(1);
    const b = setup();
    expect((await b.call('POST', '/api/runs/import', bundle)).body).toEqual({ imported: 1, skipped: 0 });
    expect(b.hubEvents).toEqual([{ type: 'runs.changed' }]);
    expect((await b.call('POST', '/api/runs/import', bundle)).body).toEqual({ imported: 0, skipped: 1 });
    expect(b.hubEvents).toHaveLength(1);
    const notExport = await b.call('POST', '/api/runs/import', { hello: true });
    expect(notExport.status).toBe(400);
  });
});
