import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import type { LocalModel } from '../../../../src/contract/models';
import type { Clock } from '../../../../src/core/deps';
import { HubClient } from '../../../../src/core/models/hub';
import { DOWNLOAD_SIDECAR } from '../../../../src/core/models/scanner';
import {
  createUpdatesRoutes,
  ModelUpdatesService,
  UPDATE_CHECK_EVERY_MS,
  UPDATE_COOLDOWN_MS,
  UPDATE_FIRST_DELAY_MS,
  UPDATE_SPACING_MS,
  UPDATE_WAKE_MS,
} from '../../../../src/core/models/updates';
import { errorResponse } from '../../../../src/core/server/http-error';
import { startFakeHub, type FakeHub } from '../../../fakes/fake-hub';
import { memoryLogger, tempDir } from './helpers';

const UP = 'up/Up-GGUF';
const SAME = 'same/Same-GGUF';
const ST = 'st/Model-FP8';
const GONE = 'gone/Gone-GGUF';

/** A clock whose wall time the test moves; sleeps return at once and are recorded. */
function testClock(): Clock & { at: number; slept: number[] } {
  const c = {
    at: Date.parse('2026-10-13T10:00:00Z'),
    slept: [] as number[],
    now: () => c.at,
    wall: () => c.at,
    sleep: async (ms: number, signal?: AbortSignal) => {
      c.slept.push(ms);
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    },
  };
  return c;
}

describe('ModelUpdatesService', () => {
  let hub: FakeHub;
  let t: ReturnType<typeof tempDir>;
  let models: LocalModel[];
  let clock: ReturnType<typeof testClock>;
  let log: ReturnType<typeof memoryLogger>;

  beforeAll(async () => {
    hub = await startFakeHub({ repos: [] });
  });
  afterAll(() => hub.close());
  beforeEach(() => {
    t = tempDir('gb-updates-');
    clock = testClock();
    log = memoryLogger();
    hub.requests.length = 0;
    hub.behavior.rateLimitNext = 0;
    hub.addRepo({
      id: UP,
      files: [
        { path: 'GGUF/Up-Q4_K_M.gguf', size: 4096, seed: 11 },
        { path: 'GGUF/mmproj-Up-f32.gguf', size: 900 },
        { path: 'GGUF/mmproj-Up-bf16.gguf', size: 600 },
        { path: 'GGUF/mmproj-Up-f16.gguf', size: 700 },
        { path: 'GGUF/Up-MTP-Q8_0.gguf', size: 300 },
        { path: 'GGUF/Up-MTP-Q4_0.gguf', size: 200 },
        { path: 'mmproj-root-f16.gguf', size: 500 },
        { path: 'config.json', content: '{"a":1}' },
      ],
    });
    hub.addRepo({
      id: SAME,
      files: [
        { path: 'Same-Q8_0.gguf', size: 2048, seed: 3 },
        { path: 'mmproj-Same-q8_0.gguf', size: 100 },
        { path: 'mmproj-Same-x.gguf', size: 50 },
        { path: 'mmproj-Same-y.gguf', size: 40 },
      ],
    });
    hub.addRepo({
      id: ST,
      files: [
        { path: 'config.json', content: '{"b":2}' },
        { path: 'model.safetensors', size: 8192, seed: 5 },
      ],
    });
  });
  afterEach(() => t.cleanup());

  /** A model of the PC whose files are written to disk (`sizes` per repo path; `null` = listed but missing). */
  function local(repo: string | undefined, id: string, files: Record<string, number | null>, over: Partial<LocalModel> = {}, identity: Partial<LocalModel['identity']> = {}): LocalModel {
    // Each model in its own folder (two copies of a repo never share files).
    const repoDir = path.join(t.dir, id, ...(repo ?? 'loose/x').split('/'));
    const paths = Object.entries(files).map(([p, size]) => {
      const abs = path.join(repoDir, ...p.split('/'));
      if (size !== null) {
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, Buffer.alloc(size, 1));
      }
      return abs;
    });
    const first = Object.keys(files)[0] as string;
    return {
      id,
      identity: { displayName: id, format: first.endsWith('.gguf') ? 'gguf' : 'safetensors', source: 'hf', files: [], weakKey: id, ...(repo ? { repo } : {}), ...identity },
      paths,
      auxiliary: [],
      dir: path.dirname(paths[0] as string),
      origin: 'library',
      modifiedAt: '2026-10-01T00:00:00Z',
      repoDir,
      ...over,
    };
  }

  function service(file = path.join(t.dir, 'data', 'model-updates.json')): ModelUpdatesService {
    return new ModelUpdatesService({
      hub: new HubClient({ fetch: globalThis.fetch, baseUrl: hub.url, getToken: () => undefined }),
      list: async () => models,
      clock,
      log,
      file,
    });
  }
  const trees = () => hub.requests.filter((r) => r.url.includes('/tree/')).map((r) => decodeURIComponent(new URL(r.url, hub.url).pathname.split('/api/models/')[1] as string).replace(/\/tree\/.*$/, ''));

  it('finds changed files and the extras a GGUF repo has next to the model; the unchanged and the unrelated say nothing', async () => {
    const up = hub.file(UP, 'GGUF/Up-Q4_K_M.gguf');
    const upModel = local(UP, 'up', { 'GGUF/Up-Q4_K_M.gguf': up.size, 'config.json': hub.file(UP, 'config.json').size }, {}, { quant: 'Q4_K_M' });
    // The sidecar says what was downloaded: another sha256 than the hub's now (a new revision changed it).
    writeFileSync(path.join(upModel.repoDir as string, DOWNLOAD_SIDECAR), JSON.stringify({ repo: UP, files: { 'GGUF/Up-Q4_K_M.gguf': { sha256: 'a'.repeat(64), sizeBytes: up.size } } }));
    const same = hub.file(SAME, 'Same-Q8_0.gguf');
    const sameModel = local(SAME, 'same', { 'Same-Q8_0.gguf': same.size, 'mmproj-Same-q8_0.gguf': 100 }, { auxiliary: [{ kind: 'mmproj', path: 'x' }, { kind: 'mtp', path: 'y' }] }, { sha256: same.sha256 });
    // Safetensors: a weight of another size; config.json has no sha256 on the hub (kept in git): its size matches.
    const stModel = local(ST, 'st', { 'model.safetensors': 100, 'config.json': hub.file(ST, 'config.json').size, 'renamed.bin': 3 });
    // A copy of a repo outside any repo folder (an added folder with loose files).
    const nodir = local(UP, 'nodir', { 'GGUF/Up-Q4_K_M.gguf': 1 });
    delete nodir.repoDir;
    models = [
      upModel,
      sameModel,
      stModel,
      // Same GGUF size, no sha256 known: nothing to say.
      // (The repo has no MTP head to offer.)
      local(SAME, 'same-unknown', { 'Same-Q8_0.gguf': same.size }),
      // A file listed by the scan but gone from the disk; a model with no repo folder; a download stopped halfway.
      local(UP, 'missing', { 'GGUF/Up-Q4_K_M.gguf': null }, { auxiliary: [{ kind: 'mmproj', path: 'x' }, { kind: 'mtp', path: 'y' }] }),
      local(undefined, 'loose', { 'loose.gguf': 10 }),
      nodir,
      local(UP, 'half', { 'GGUF/Up-Q4_K_M.gguf': 10 }, { incomplete: { have: 1, total: 2 } }),
    ];
    const svc = service();
    expect(await svc.status()).toEqual({ checking: false, models: [] });
    await svc.check();
    // One listing per repo, a second between two of them.
    expect(trees().sort()).toEqual([SAME, ST, UP]);
    expect(clock.slept).toEqual([UPDATE_SPACING_MS, UPDATE_SPACING_MS]);
    const status = await svc.status();
    expect(status.checkedAt).toBe('2026-10-13T10:00:00.000Z');
    expect(status.models).toEqual([
      {
        modelId: 'up',
        repo: UP,
        changed: [{ path: 'GGUF/Up-Q4_K_M.gguf', label: 'Q4_K_M', oldBytes: up.size, newBytes: up.size }],
        // Next to the model only (not the root's mmproj): f16 first, then bf16, then q8.
        extras: [
          { kind: 'mmproj', path: 'GGUF/mmproj-Up-f16.gguf', sizeBytes: 700 },
          { kind: 'mtp', path: 'GGUF/Up-MTP-Q8_0.gguf', sizeBytes: 300 },
        ],
        checkedAt: '2026-10-13T10:00:00.000Z',
      },
      { modelId: 'st', repo: ST, changed: [{ path: 'model.safetensors', label: 'model.safetensors', oldBytes: 100, newBytes: 8192 }], extras: [], checkedAt: '2026-10-13T10:00:00.000Z' },
      // The same size and no sha256 known: unchanged; the mmproj it lacks (q8 before an unnamed one).
      {
        modelId: 'same-unknown',
        repo: SAME,
        changed: [],
        extras: [{ kind: 'mmproj', path: 'mmproj-Same-q8_0.gguf', sizeBytes: 100 }],
        checkedAt: '2026-10-13T10:00:00.000Z',
      },
    ]);
  });

  it('never hammers the hub: a check asked again too soon answers from the last one, rate limits stop a round', async () => {
    models = [local(UP, 'up', { 'GGUF/Up-Q4_K_M.gguf': 1 }), local(SAME, 'same', { 'Same-Q8_0.gguf': 1 })];
    const svc = service();
    await svc.check();
    expect(trees()).toHaveLength(2);
    await svc.check();
    await svc.check(UP);
    expect(trees()).toHaveLength(2);
    // Later: asked again, even though the hub client would still answer from its cache.
    clock.at += UPDATE_COOLDOWN_MS + 1;
    await svc.check(UP);
    expect(trees()).toHaveLength(3);
    expect(trees().filter((r) => r === UP)).toHaveLength(2);
    // After a download: the listing it just used, no new request.
    await svc.check(UP, { fresh: false });
    expect(trees()).toHaveLength(3);
    // Rate limited: the round stops at the first repo; a missing repo does not stop it.
    clock.at += UPDATE_COOLDOWN_MS + 1;
    hub.requests.length = 0;
    hub.behavior.rateLimitNext = 1;
    await svc.check();
    expect(trees()).toHaveLength(1);
    expect(log.entries.some((e) => e.level === 'warn' && e.msg === 'update check failed')).toBe(true);
    models.push(local(GONE, 'gone', { 'Gone-Q4_K_M.gguf': 1 }));
    clock.at += UPDATE_COOLDOWN_MS + 1;
    hub.requests.length = 0;
    await svc.check();
    expect(trees().sort()).toEqual([GONE, SAME, UP]);
  });

  it('shares a running check, keeps what it found on disk and forgets repos the PC no longer has', async () => {
    models = [local(UP, 'up', { 'GGUF/Up-Q4_K_M.gguf': 1 })];
    const file = path.join(t.dir, 'data', 'model-updates.json');
    const svc = service(file);
    const first = svc.check();
    expect(svc.check(SAME)).toBe(first);
    expect((await svc.status()).checking).toBe(true);
    await first;
    expect((await svc.status()).checking).toBe(false);
    // A new process reads the last check back.
    expect((await service(file).status()).models.map((m) => m.modelId)).toEqual(['up']);
    // The model is gone: its repo is forgotten at the next check.
    models = [];
    clock.at += UPDATE_COOLDOWN_MS + 1;
    await svc.check();
    expect((await service(file).status()).checkedAt).toBeDefined();
    models = [local(UP, 'up', { 'GGUF/Up-Q4_K_M.gguf': 1 })];
    expect((await service(file).status()).models).toEqual([]);
    // A broken file is a fresh start; a file that cannot be written is only logged.
    writeFileSync(file, '{"version":2}');
    expect(await service(file).status()).toEqual({ checking: false, models: [] });
    mkdirSync(path.join(t.dir, 'blocked', 'model-updates.json'), { recursive: true });
    await service(path.join(t.dir, 'blocked', 'model-updates.json')).check();
    expect(log.entries.some((e) => e.msg === 'cannot save update checks')).toBe(true);
  });

  it('checks in the background once a day, until the core shuts down', async () => {
    models = [local(UP, 'up', { 'GGUF/Up-Q4_K_M.gguf': 1 })];
    const svc = service();
    // Never checked: due. Checked a moment ago: not due. A day later: due again.
    await svc.maybeCheck();
    expect(trees()).toHaveLength(1);
    await svc.maybeCheck();
    expect(trees()).toHaveLength(1);
    clock.at += UPDATE_CHECK_EVERY_MS;
    await svc.maybeCheck();
    expect(trees()).toHaveLength(2);
    // The loop: a first delay, then a look every hour; a failing look is logged, the shutdown ends it.
    const shutdown = new AbortController();
    let wakes = 0;
    clock.sleep = async (ms, signal) => {
      clock.slept.push(ms);
      if (ms === UPDATE_WAKE_MS && ++wakes === 2) shutdown.abort();
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    };
    clock.slept.length = 0;
    clock.at += UPDATE_CHECK_EVERY_MS;
    const failing = new ModelUpdatesService({ hub: { files: async () => [] }, list: () => Promise.reject(new Error('scan failed')), clock, log, file: path.join(t.dir, 'bg.json') });
    await failing.runInBackground(shutdown.signal);
    expect(clock.slept).toEqual([UPDATE_FIRST_DELAY_MS, UPDATE_WAKE_MS, UPDATE_WAKE_MS]);
    expect(log.entries.filter((e) => e.msg === 'background update check failed')).toHaveLength(2);
  });

  it('routes: the status, a check of one repo or all, invalid repo ids refused', async () => {
    models = [local(UP, 'up', { 'GGUF/Up-Q4_K_M.gguf': 1 })];
    const app = new Hono();
    app.onError((e, c) => errorResponse(c, e));
    createUpdatesRoutes(service())(app, {} as never);
    expect(await (await app.request('/api/models/updates')).json()).toEqual({ checking: false, models: [] });
    const post = (body: unknown) => app.request('/api/models/updates/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const one = (await (await post({ repo: UP })).json()) as { models: { modelId: string }[]; checkedAt?: string };
    expect(one.models.map((m) => m.modelId)).toEqual(['up']);
    expect(one.checkedAt).toBeUndefined();
    expect(((await (await post({})).json()) as { checkedAt?: string }).checkedAt).toBeDefined();
    expect((await post({ repo: '../etc' })).status).toBe(400);
  });
});
