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
    let svc!: BenchService;
    const s = serviceSetup(tmp, {
      deps: { resolveModel: async () => small() },
      adapter: { client: { onRequest: (n) => (n === 6 ? (seen = svc.active()) : undefined) } },
    });
    svc = new BenchService(s.deps);
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

  it('without knowing where it runs (no fingerprint) there is no recommendation', async () => {
    const s = serviceSetup(tmp, { deps: { fingerprint: () => Promise.reject(new Error('no fingerprint')) } });
    await s.runs.save(tuneRun());
    const plan = await new BenchService(s.deps).planServer({ engine: { kind: 'llamacpp-native' }, model: { localId: 'm1' } });
    expect(plan).not.toHaveProperty('tuned');
  });
});
