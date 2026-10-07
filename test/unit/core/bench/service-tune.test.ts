/** BenchService and "Trova le impostazioni migliori": plans, starts, the live state, the server recommendation. */
import { afterEach, describe, expect, it } from 'vitest';
import type { ActiveRun } from '../../../../src/contract/api';
import { launchParamsSchema } from '../../../../src/contract/engines';
import type { LivePoint } from '../../../../src/contract/events';
import type { RunResult, Tuning } from '../../../../src/contract/results';
import { BenchService, livePointKey } from '../../../../src/core/bench/service';
import { makeRun, modelIdentity } from '../store/fixtures';
import { modelTarget } from './fakes';
import { request, serviceSetup, TempDirs } from './service-helpers';
import { combo, point } from './tune-helpers';

const tmp = new TempDirs();
afterEach(() => tmp.cleanup());

/** A small model (trained on 8K) so the fake search is short. */
const small = () => modelTarget({ identity: modelIdentity({ facts: { contextLength: 8192, blockCount: 4 } }) });

describe('BenchService — tune runs', () => {
  it('plans a tune run for its time budget, its sweep template untouched', async () => {
    const s = serviceSetup(tmp, { deps: { resolveModel: async () => small() } });
    const svc = new BenchService(s.deps);
    const fast = await svc.plan(request({ profile: 'tune' }));
    expect(fast.estimatedSeconds).toBe(300);
    expect(fast.scenario).toEqual({ profile: 'tune', seed: 42, steps: [{ kind: 'context-sweep', depths: [], fractions: false, outputTokens: 128, reps: 2 }] });
    expect((await svc.plan(request({ profile: 'tune', tune: { budget: 'thorough' } }))).estimatedSeconds).toBe(1200);
  });

  it('an external endpoint cannot be tuned (nothing to relaunch)', async () => {
    const s = serviceSetup(tmp);
    const svc = new BenchService(s.deps);
    await expect(svc.plan(request({ profile: 'tune', engine: { kind: 'external', baseUrl: 'http://127.0.0.1:1' } }))).rejects.toMatchObject({
      code: 'VALIDATION',
      params: { reason: 'tune_external' },
    });
  });

  it('runs the search and shows it live: the search, the engine in use, the request in flight, the measurements so far', async () => {
    let seen: ActiveRun | undefined;
    const holder: { svc?: BenchService } = {};
    const s = serviceSetup(tmp, {
      deps: { resolveModel: async () => small() },
      adapter: { client: { onRequest: (n) => (n === 6 ? (seen = holder.svc!.active()) : undefined) } },
    });
    const svc = (holder.svc = new BenchService(s.deps));
    const { runId } = await svc.start(request({ profile: 'tune' }));
    await svc.whenIdle();
    expect(seen).toMatchObject({ runId, profile: 'tune', estimatedSeconds: 300 });
    expect(seen!.tuning!.attempts.length).toBeGreaterThan(0);
    expect(seen!.launch).toMatchObject({ engineLabel: 'llama.cpp b11438 (CUDA 13.4)' });
    expect(seen!.current).toMatchObject({ kind: expect.stringMatching(/^tune-|context-sweep/) });
    expect(seen!.points.length).toBeGreaterThan(0);
    const keys = seen!.points.map(livePointKey);
    expect(new Set(keys).size).toBe(keys.length);
    const run = (await s.runs.get(runId)) as RunResult;
    expect(run.status).toBe('completed');
    expect(run.tuning!.combinations.length).toBeGreaterThan(0);
    // Windows (the fixture's PC): the search starts with a reference launch.
    expect(run.tuning!.attempts[0]!.stage).toBe('reference');
  });

  it('livePointKey: one entry per prompt length / users / tune attempt', () => {
    const lat = (attempt?: number): LivePoint => ({ stepKind: 'tune-screen', point: point(1024, 10), ...(attempt !== undefined ? { attempt } : {}) });
    expect(livePointKey(lat(3))).toBe('tune-screen:1024:3');
    expect(livePointKey(lat())).toBe('tune-screen:1024:');
    expect(livePointKey({ stepKind: 'concurrency', point: { level: 4, requests: 16, aggregateTps: 1, perRequestDecodeTpsP50: 1, ttftP50Ms: 1, ttftP95Ms: 1, errors: 0 } })).toBe('concurrency:4');
  });
});

describe('BenchService — "Avvia solo il server" after a tune run', () => {
  const tuneRun = (): RunResult => {
    const params = launchParamsSchema.parse({ contextSize: 40960, kvCacheType: 'q4_0', flashAttention: 'on', ubatchSize: 2048, parallel: 1 });
    const tuning: Tuning = {
      budget: 'fast',
      maxLaunches: 24,
      dimensions: [],
      capacity: [],
      depths: [1024],
      attempts: [],
      combinations: [combo('q4_0', 40960, [point(1024, 100)], { params })],
      recommended: 0,
      fastestByDepth: [{ depth: 1024, combination: 0 }],
    };
    return makeRun({ id: 'TUNE-1', scenario: { profile: 'tune', seed: 42, steps: [] }, tuning, launch: { ...makeRun().launch, params } });
  };

  it('takes the context and settings of the latest tune of this model here, and says so', async () => {
    const s = serviceSetup(tmp);
    await s.runs.save(tuneRun());
    const svc = new BenchService(s.deps);
    const plan = await svc.planServer({ engine: { kind: 'llamacpp-native' }, model: { localId: 'm1' } });
    expect(plan).toMatchObject({ contextSize: 40960, tuned: { runId: 'TUNE-1', contextSize: 40960, kvCacheType: 'q4_0' }, params: { kvCacheType: 'q4_0', ubatchSize: 2048 } });
    expect(s.adapter.plans.at(-1)!.params).toMatchObject({ contextSize: 40960, kvCacheType: 'q4_0', flashAttention: 'on' });
    // The user chose a context: theirs, no recommendation.
    const own = await svc.planServer({ engine: { kind: 'llamacpp-native' }, model: { localId: 'm1' }, params: launchParamsSchema.parse({ contextSize: 4096 }) });
    expect(own.contextSize).toBe(4096);
    expect(own).not.toHaveProperty('tuned');
  });

  it('prefers the tune made with the build in use; only an older build: marked; the build check never fails the plan', async () => {
    let adjusts = 0;
    // The first look at the engine (the build check) fails; the command itself is planned as usual.
    const s = serviceSetup(tmp, { deps: { adjustEngine: async () => (++adjusts === 1 ? Promise.reject(new Error('docker down')) : undefined) } });
    const old = tuneRun();
    await s.runs.save({ ...old, engine: { ...old.engine, build: 'b10000' } });
    const svc = new BenchService(s.deps);
    const req = { engine: { kind: 'llamacpp-native' as const }, model: { localId: 'm1' } };
    expect((await svc.planServer(req)).tuned).toMatchObject({ runId: 'TUNE-1', otherBuild: { build: 'b10000', current: 'b11438' } });
    // The build in use cannot be known: the latest tune, unmarked.
    const blind = Object.create(s.adapter) as typeof s.adapter;
    blind.plan = (cfg, model, params, opts) => (opts.marker === 'gpubench-build' ? Promise.reject(new Error('no exe')) : s.adapter.plan(cfg, model, params, opts));
    const plan = await new BenchService({ ...s.deps, getAdapter: () => blind }).planServer(req);
    expect(plan.tuned).toMatchObject({ runId: 'TUNE-1' });
    expect(plan.tuned?.otherBuild).toBeUndefined();
    // The same build: preferred over a newer tune with another one.
    await s.runs.save({ ...tuneRun(), id: 'TUNE-2', createdAt: '2026-10-06T11:00:00.000Z', engine: { ...old.engine, build: 'b11438' } });
    expect((await svc.planServer(req)).tuned).toMatchObject({ runId: 'TUNE-2' });
  });

  it('the plan of a tune says the previous tune of the same question and whether its build is the one in use', async () => {
    const s = serviceSetup(tmp, { deps: { resolveModel: async () => modelTarget({ identity: modelIdentity({ facts: { contextLength: 8192, blockCount: 4 } }) }) } });
    const old = tuneRun();
    await s.runs.save({ ...old, model: modelIdentity({ facts: { contextLength: 8192, blockCount: 4 } }), engine: { kind: 'llamacpp-native', name: 'llama.cpp' } });
    const svc = new BenchService(s.deps);
    const plan = await svc.plan(request({ profile: 'tune' }));
    expect(plan.previousTune).toEqual({ runId: 'TUNE-1', createdAt: old.createdAt, budget: 'fast', currentBuild: 'b11438', sameBuild: false });
    expect((await svc.plan(request({ profile: 'tune', tune: { budget: 'fast', goal: 'multi' } }))).previousTune).toBeUndefined();
    // The build in use unknown; where it runs unknown: no previous tune said.
    const unknown = Object.create(s.adapter) as typeof s.adapter;
    unknown.plan = async (cfg, model, params, opts) => {
      const p = await s.adapter.plan(cfg, model, params, opts);
      return { ...p, engine: { kind: p.engine.kind, name: p.engine.name } };
    };
    expect((await new BenchService({ ...s.deps, getAdapter: () => unknown }).plan(request({ profile: 'tune' }))).previousTune).toEqual({ runId: 'TUNE-1', createdAt: old.createdAt, budget: 'fast', sameBuild: true });
    expect((await new BenchService({ ...s.deps, fingerprint: () => Promise.reject(new Error('x')) }).plan(request({ profile: 'tune' }))).previousTune).toBeUndefined();
  });

  it('without knowing where it runs (no fingerprint) there is no recommendation', async () => {
    const s = serviceSetup(tmp, { deps: { fingerprint: () => Promise.reject(new Error('no fingerprint')) } });
    await s.runs.save(tuneRun());
    const plan = await new BenchService(s.deps).planServer({ engine: { kind: 'llamacpp-native' }, model: { localId: 'm1' } });
    expect(plan).not.toHaveProperty('tuned');
  });
});
