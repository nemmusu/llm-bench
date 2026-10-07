/**
 * The tuner's search against a deterministic machine: the fake engine's own memory and speed models
 * (test/fakes/fake-engine/server.mjs memoryPlan/speeds), virtual time, no processes.
 */
import { describe, expect, it } from 'vitest';
import type { LaunchParams } from '../../../../src/contract/engines';
import type { FitEstimate } from '../../../../src/contract/models';
import { llamaSpace, vllmSpace } from '../../../../src/core/bench/tune-space';
import { BUDGETS, collapseLimit, collapsedAt, failureHint, memoryError, Tuner, variantKey } from '../../../../src/core/bench/tuner';
import type { FakeProfile } from '../../../fakes/fake-engine/server.mjs';
import { TUNE_PROFILE } from '../../../fakes/fake-engine/profiles.mjs';
import { point } from './tune-helpers';
import { brief, capacityOf, input, Lab, LINUX, optimistic, P, tune } from './tune-lab';

describe('helpers', () => {
  it('collapse limits loosen with the distance between depths', () => {
    expect(collapseLimit(1024, 4096)).toBe(0.4);
    expect(collapseLimit(1024, 65536)).toBeCloseTo(0.4 / 3, 9);
    expect(collapseLimit(0, 1)).toBe(0.4);
    expect(collapsedAt([point(1024, 100), point(4096, 90), point(8192, 30)])).toBe(8192);
    expect(collapsedAt([point(1024, 100), point(32768, 20)])).toBeUndefined();
    expect(collapsedAt([point(1024, 100)])).toBeUndefined();
  });

  it('memory errors and the capacity hint of a failed vLLM start', () => {
    expect(memoryError({ code: 'ENGINE_OOM', message: '' })).toBe(true);
    expect(memoryError({ code: 'MODEL_TOO_LARGE', message: '', params: { reason: 'kv-cache' } })).toBe(true);
    expect(memoryError({ code: 'MODEL_TOO_LARGE', message: '', params: { reason: 'context' } })).toBe(false);
    expect(memoryError({ code: 'ENGINE_EXITED', message: '' })).toBe(false);
    expect(failureHint({ code: 'MODEL_TOO_LARGE', message: '', params: { estimatedMaxModelLen: 12000 } })).toBe(12000);
    expect(failureHint({ code: 'MODEL_TOO_LARGE', message: '', params: { estimatedMaxModelLen: 0 } })).toBeUndefined();
    expect(failureHint({ code: 'ENGINE_OOM', message: '' })).toBeUndefined();
    expect(variantKey({ kv: 'f16', ub: 512, fa: 'on' }, 4096)).toBe('4096|fa=on,kv=f16,ub=512');
  });
});

describe('Tuner: llama.cpp, the user’s ladder (f16 → q8_0 → q4_0)', () => {
  it('largest context per KV type, top candidate first then binary search, descent and sweeps', async () => {
    const { t, lab, updates, phases } = await tune();
    expect(capacityOf(t)).toEqual({ f16: 16384, q8_0: 32768, q4_0: 40960 });
    expect(t.capacity.map((c) => c.predictedMax)).toEqual([40960, 40960, 40960]);
    const order = t.attempts.map(brief);
    // f16: the top (40K) runs out of memory, then a binary search between 4K and 40K, then 24K between 16K (loads) and 32K (does not).
    expect(order.slice(0, 5)).toEqual([
      'capacity f16@40960 on/512 oom',
      'capacity f16@8192 on/512 ok',
      'capacity f16@16384 on/512 ok',
      'capacity f16@32768 on/512 oom',
      'capacity f16@24576 on/512 oom',
    ]);
    // q8_0 starts above f16's 16K (known to fit): the top first, then 32K.
    expect(order.slice(5, 8)).toEqual(['capacity q8_0@40960 on/512 oom', 'capacity q8_0@32768 on/512 ok', 'capacity q4_0@40960 on/512 ok']);
    // A capacity launch is a quick check only: the 1K probe, never a deep prompt.
    expect(t.attempts.filter((a) => a.stage === 'capacity').every((a) => a.points.every((p) => p.promptTokens === 1024 && p.outputTokens === 32))).toBe(true);
    // The screening is its own launch: the probe, then 1K, the middle of the grid and the deepest prompt.
    expect(t.attempts.find((a) => a.stage === 'variant' && a.kvType === 'q8_0')!.points.map((p) => p.promptTokens)).toEqual([1024, 1024, 16384, 32624]);
    expect(t.capacity.map((c) => [c.kvType, c.bound, c.failedAt])).toEqual([
      ['f16', 'found', 24576],
      ['q8_0', 'found', 40960],
      ['q4_0', 'model', undefined],
    ]);
    expect(t.attempts.every((a) => a.kvType === 'f16' || a.params.flashAttention === 'on')).toBe(true);
    // The recommendation: q4_0 at the trained context with the faster ubatch.
    const rec = t.combinations[t.recommended!]!;
    expect(rec).toMatchObject({ kvType: 'q4_0', maxContext: 40960, params: { ubatchSize: 2048, parallel: 1, batchSize: 2048 } });
    expect(rec.sweep.map((p) => p.promptTokens)).toEqual([1024, 4096, 8192, 16384, 32768, 40816]);
    expect(t.combinations.map((c) => `${c.kvType}@${c.maxContext}`)).toEqual(['q4_0@40960', 'q8_0@32768', 'f16@16384']);
    // Flash attention off is only tried with f16, and loses (slower with depth).
    const faOff = t.attempts.filter((a) => a.params.flashAttention === 'off');
    expect(faOff.map((a) => [a.kvType, a.screen])).toEqual([['f16', 'lost']]);
    expect(t.dimensions).toEqual([
      { key: 'kv', values: ['f16', 'q8_0', 'q4_0'] },
      { key: 'fa', values: ['on', 'off'] },
      { key: 'ub', values: [512, 2048] },
    ]);
    expect(t.depths).toEqual([1024, 4096, 8192, 16384, 32768, 40960]);
    expect(t.fastestByDepth.at(-1)).toEqual({ depth: 40960, combination: 0 });
    expect(t.stoppedBy).toBeUndefined();
    expect(t.maxLaunches).toBe(BUDGETS.fast.maxLaunches);
    // Every launch was stopped; the live view saw each launch before its outcome.
    expect(lab.stopped).toHaveLength(t.attempts.filter((a) => a.outcome !== 'oom').length);
    expect(updates.some((u) => u.current !== undefined)).toBe(true);
    expect(phases[0]).toBe('tune-capacity');
    expect(phases).toContain('tune-variants');
    expect(phases).toContain('context-sweep');
  });

  it('a less precise KV type that cannot add context is not searched (its capacity is inferred)', async () => {
    const roomy: FakeProfile = { ...TUNE_PROFILE, memory: { ...TUNE_PROFILE.memory!, totalMiB: 60_000 } };
    const { t } = await tune({}, new Lab({ profile: roomy }));
    expect(t.capacity).toEqual([
      { kvType: 'f16', predictedMax: 40960, measuredMax: 40960, inferred: false, bound: 'model' },
      { kvType: 'q8_0', predictedMax: 40960, measuredMax: 40960, inferred: true, skipped: 'no-gain', bound: 'model' },
      { kvType: 'q4_0', predictedMax: 40960, measuredMax: 40960, inferred: true, skipped: 'no-gain', bound: 'model' },
    ]);
    expect(t.attempts.filter((a) => a.stage === 'capacity').map(brief)).toEqual(['capacity f16@40960 on/512 ok']);
    // Still measured (the fastest number wins), f16 first.
    expect(t.combinations.map((c) => c.kvType)).toEqual(['f16', 'q8_0', 'q4_0']);
    expect(t.combinations[t.recommended!]!.kvType).toBe('f16');
  });

  it('prunes what the estimate rules out; the most compact KV is still tried once', async () => {
    // Nothing fits per the estimate.
    const never = (): FitEstimate => ({ ...optimistic(), needMiB: 100_000 });
    const tiny: FakeProfile = { ...TUNE_PROFILE, memory: { totalMiB: 9000, weightsMiB: 6000, kvMiBPer1k: 600, computeMiBPer512: 300 } };
    const { t } = await tune({ predict: never }, new Lab({ profile: tiny }));
    expect(t.capacity.map((c) => [c.kvType, c.skipped, c.measuredMax])).toEqual([
      ['f16', 'estimate', undefined],
      ['q8_0', 'estimate', undefined],
      ['q4_0', undefined, 4096],
    ]);
    expect(t.capacity.map((c) => c.predictedMax)).toEqual([undefined, undefined, undefined]);
  });

  it('the estimate caps the candidates (binary search on its numbers, 10 % slack)', async () => {
    const byCtx = (p: LaunchParams): FitEstimate => {
      const share = { f16: 1, q8_0: 0.53, q4_0: 0.28 }[p.kvCacheType as 'f16'];
      return { ...optimistic(), needMiB: 6000 + 0.6 * share * (p.contextSize as number), availableMiB: 15000 };
    };
    const { t } = await tune({ predict: byCtx });
    const pred = Object.fromEntries(t.capacity.map((c) => [c.kvType, c.predictedMax]));
    expect(pred.f16).toBeGreaterThan(16384);
    expect(pred.f16).toBeLessThan(32768);
    expect(pred.q4_0).toBe(40960);
    // Above the prediction nothing is tried.
    expect(t.attempts.some((a) => a.kvType === 'f16' && a.contextSize > 16384)).toBe(false);
    // No estimate at all (no GPU reading): nothing is pruned, the trained context is the limit.
    const none = await tune({ predict: () => undefined });
    expect(none.t.capacity.every((c) => c.predictedMax === undefined)).toBe(true);
    const noPredict = await tune({ predict: undefined, modelContext: undefined });
    expect(noPredict.t.attempts[0]).toMatchObject({ contextSize: 131072, outcome: 'oom' });
  });
});

describe('Tuner: spills (Windows)', () => {
  it('a reference launch first; a spill is seen from the shared memory or a collapse of the generation speed', async () => {
    const shared = (p: LaunchParams) => (p.kvCacheType === 'q8_0' && p.contextSize === 40960 ? 3000 : 20);
    const { t } = await tune({ spillPossible: true }, new Lab({ shared, profile: TUNE_PROFILE }));
    expect(t.attempts[0]).toMatchObject({ stage: 'reference', kvType: 'f16', contextSize: 4096, outcome: 'ok', sharedPeakMiB: 20 });
    expect(t.attempts.find((a) => a.kvType === 'q8_0' && a.contextSize === 40960)).toMatchObject({ outcome: 'spill', spill: 'shared-memory', sharedPeakMiB: 3000 });
    expect(capacityOf(t)).toEqual({ f16: 16384, q8_0: 32768, q4_0: 40960 });
    // Without the counters the collapse gives it away.
    const blind = await tune({ spillPossible: true }, new Lab({ profile: TUNE_PROFILE }));
    expect(blind.t.attempts.find((a) => a.kvType === 'q8_0' && a.contextSize === 40960)).toMatchObject({ outcome: 'spill', spill: 'decode-collapse' });
  });

  it('shared memory that only grows while measuring still counts as a spill (and its sweep is not kept)', async () => {
    // q4_0 at 40K with ub 2048: fine after the probe, spilling once the deep prompts fill the KV cache.
    const shared = (p: LaunchParams, requests: number) => (p.kvCacheType === 'q4_0' && p.ubatchSize === 2048 && requests > 1 ? 4000 : 10);
    const { t } = await tune({ spillPossible: true }, new Lab({ shared }));
    expect(t.attempts.find((a) => a.kvType === 'q4_0' && a.params.ubatchSize === 2048)).toMatchObject({ outcome: 'spill', spill: 'shared-memory', sharedPeakMiB: 4000 });
    expect(t.combinations.find((c) => c.kvType === 'q4_0')?.params.ubatchSize).toBe(512);
    expect(t.combinations.every((c) => c.outcome === 'ok')).toBe(true);
  });

  it('the reference moves down the ladder when f16 does not load at 4K (or is pruned)', async () => {
    const lab = new Lab({ fail: (p) => (p.kvCacheType === 'f16' ? { code: 'ENGINE_OOM', message: 'oom' } : undefined) });
    const { t } = await tune({ spillPossible: true, predict: (p) => (p.kvCacheType === 'q8_0' ? { ...optimistic(), needMiB: 1e9 } : optimistic()) }, lab);
    expect(t.attempts.slice(0, 2).map(brief)).toEqual(['reference f16@4096 on/512 oom', 'reference q4_0@4096 on/512 ok']);
    // The time limit can end the reference phase (the next start would end past it).
    const short = await tune({ spillPossible: true, limitMs: BUDGETS.fast.minMs }, new Lab({ loadMs: BUDGETS.fast.minMs }));
    expect(short.t.attempts.map(brief)).toEqual(['reference f16@4096 on/512 ok']);
    expect(short.t.stoppedBy).toBe('budget');
    const failedRef = await tune({ spillPossible: true, limitMs: BUDGETS.fast.minMs }, new Lab({ loadMs: BUDGETS.fast.minMs, fail: () => ({ code: 'ENGINE_OOM', message: 'oom' }) }));
    expect(failedRef.t.attempts.map(brief)).toEqual(['reference f16@4096 on/512 oom']);
  });

  it('a spill of the deep prompts only: the base screen steps the context down, a sweep that collapses is not kept', async () => {
    // q4_0 at 40K spills (total lowered) but generation only collapses on deep prompts.
    const prof: FakeProfile = { ...TUNE_PROFILE, memory: { ...TUNE_PROFILE.memory!, totalMiB: 12_000, spillMiB: 6000 } };
    const { t } = await tune({ spillPossible: true }, new Lab({ profile: prof, deepSpillOnly: true }));
    const q4 = t.attempts.filter((a) => a.kvType === 'q4_0');
    expect(q4.some((a) => a.outcome === 'spill' && a.spill === 'decode-collapse')).toBe(true);
    expect(t.combinations.every((c) => c.sweep.every((p, i, all) => i === 0 || p.decodeTps.median > 0.4 * all[i - 1]!.decodeTps.median))).toBe(true);
    expect(t.combinations.every((c) => c.outcome === 'ok')).toBe(true);
  });

  it('a collapse between screening depths shows only in the full sweep: that variant is dropped', async () => {
    // q4_0 with ub 2048 slows down terribly around 8K only (screened at 1K, 16K and 40K, it looked fine).
    const decode = (p: LaunchParams, d: number) => (p.kvCacheType === 'q4_0' && p.ubatchSize === 2048 && d > 6000 && d < 12_000 ? 10 : undefined);
    const { t } = await tune({ spillPossible: true }, new Lab({ decode }));
    const bad = t.attempts.find((a) => a.kvType === 'q4_0' && a.params.ubatchSize === 2048 && a.stage === 'variant');
    expect(bad).toMatchObject({ outcome: 'spill', spill: 'decode-collapse' });
    // The base settings were measured instead.
    expect(t.combinations.find((c) => c.kvType === 'q4_0')?.params.ubatchSize).toBe(512);
  });

  it('when even the smallest context spills on deep prompts the KV type is given up', async () => {
    const decode = (p: LaunchParams, d: number) => (p.kvCacheType === 'q4_0' && d > 2000 ? 1 : undefined);
    const prof: FakeProfile = { ...LINUX, memory: { totalMiB: 9000, weightsMiB: 6000, kvMiBPer1k: 600, computeMiBPer512: 300 } };
    const { t } = await tune({ spillPossible: true, predict: (p) => ({ ...optimistic(), needMiB: p.kvCacheType === 'q4_0' ? 1 : 1e9 }) }, new Lab({ profile: prof, decode }));
    expect(t.capacity.find((c) => c.kvType === 'q4_0')?.measuredMax).toBeUndefined();
    expect(t.combinations).toEqual([]);
  });
});

describe('Tuner: budget, errors and launch cap', () => {
  it('stops at the launch cap and keeps what it measured', async () => {
    const thorough = await tune({ budget: 'thorough', space: llamaSpace({ budget: 'thorough', params: P() }) });
    expect(thorough.t.maxLaunches).toBe(60);
    expect(thorough.t.dimensions.map((d) => d.key)).toEqual(['kv', 'fa', 'ub', 'b']);
    const capped = await tune({}, new Lab());
    expect(capped.t.attempts.length).toBeLessThanOrEqual(24);
    // A tiny cap: the capacity search itself is cut.
    const tiny = await new Tuner({ ...input(), budget: 'fast' }, { lab: new Lab(), now: () => 0 });
    (tiny as unknown as { rules: { maxLaunches: number } }).rules = { ...BUDGETS.fast, maxLaunches: 2 };
    const r = await tiny.run();
    expect(r.stoppedBy).toBe('launches');
    expect(r.attempts).toHaveLength(2);
    expect(r.capacity.map((c) => [c.skipped, c.measuredMax, c.inferred, c.bound])).toEqual([
      ['budget', 8192, false, 'budget'],
      ['budget', 8192, true, 'budget'],
      ['budget', 8192, true, 'budget'],
    ]);
    // What the 8K launch measured (its 1K check) is a combination "misurata in parte", and the recommendation.
    expect(r.combinations.map((c) => [c.kvType, c.maxContext, c.partial, c.sweep.map((p) => p.promptTokens)])).toEqual([['f16', 8192, 'launches', [1024]]]);
    expect(r.recommended).toBe(0);
    expect(r.attempts[1]!.combination).toBe(0);
  });

  it('runs out of time mid-descent: what each KV type measured at its largest context is kept, partly measured', async () => {
    const lab = new Lab({ loadMs: 30_000, requestMs: 4000 });
    const { t } = await tune({ limitMs: 300_000 }, lab);
    expect(t.stoppedBy).toBe('budget');
    expect(t.limitSeconds).toBe(300);
    // Nothing started that would have ended past the limit and its grace.
    expect(lab.t).toBeLessThanOrEqual(300_000 + 30_000);
    expect(t.combinations.length).toBeGreaterThan(0);
    expect(t.combinations.every((c) => c.partial === 'budget')).toBe(true);
    expect(t.combinations[t.recommended!]!.maxContext).toBe(Math.max(...t.combinations.map((c) => c.maxContext)));
  });

  it('failures that would repeat on every launch end the run; others count as "does not load"', async () => {
    const bad = new Lab({ fail: () => ({ code: 'ENGINE_BAD_FLAG', message: 'Rejected argument: -ub', params: { flag: '-ub' }, detail: 'log' }) });
    await expect(tune({}, bad)).rejects.toMatchObject({ code: 'ENGINE_BAD_FLAG', params: { flag: '-ub' }, detail: 'log' });
    await expect(tune({}, new Lab({ fail: () => ({ code: 'CANCELLED', message: 'x' }) }))).rejects.toMatchObject({ code: 'CANCELLED' });
    const flaky = await tune({}, new Lab({ fail: (p) => (p.contextSize === 40960 && p.kvCacheType === 'q4_0' ? { code: 'ENGINE_EXITED', message: 'crash' } : undefined) }));
    expect(flaky.t.attempts.find((a) => a.kvType === 'q4_0' && a.contextSize === 40960)).toMatchObject({ outcome: 'error', error: { code: 'ENGINE_EXITED' }, loadMs: 10 });
    expect(capacityOf(flaky.t).q4_0).toBe(32768);
  });

  it('errors during the measurements: out of memory, broken engine, cancellation', async () => {
    const oomLate = await tune({}, new Lab({ throwOn: (p, d) => (p.kvCacheType === 'f16' && p.flashAttention === 'off' && d > 1024 ? Object.assign(new Error('oom'), { name: 'X' }) : undefined) }));
    expect(oomLate.t.attempts.find((a) => a.params.flashAttention === 'off')).toMatchObject({ outcome: 'error', error: { code: 'INTERNAL' } });
    const { AppError } = await import('../../../../src/contract/errors');
    const runtimeOom = await tune({}, new Lab({ throwOn: (p) => (p.ubatchSize === 2048 && p.kvCacheType === 'q8_0' ? new AppError('ENGINE_OOM', 'oom') : undefined) }));
    expect(runtimeOom.t.attempts.find((a) => a.params.ubatchSize === 2048 && a.kvType === 'q8_0')).toMatchObject({ outcome: 'oom' });
    await expect(tune({}, new Lab({ throwOn: () => new AppError('CANCELLED', 'stop') }))).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});

describe('Tuner: last resorts and the fidelity check', () => {
  const nothingFits: FakeProfile = { ...TUNE_PROFILE, memory: { totalMiB: 5000, weightsMiB: 6000, kvMiBPer1k: 600, computeMiBPer512: 300, layers: 32 } };

  it('MoE: experts to the CPU (--n-cpu-moe), more each time, only when nothing fits at 4K', async () => {
    const { t } = await tune({ offload: { layers: 32, moe: true }, predict: () => ({ ...optimistic(), maxGpuLayers: 28 }) }, new Lab({ profile: nothingFits }));
    const off = t.attempts.filter((a) => a.stage === 'offload');
    expect(off.map((a) => a.params.extraArgs)).toEqual([
      ['--n-cpu-moe', '4'],
      ['--n-cpu-moe', '8'],
      ['--n-cpu-moe', '12'],
    ]);
    expect(t.combinations).toHaveLength(1);
    expect(t.combinations[0]).toMatchObject({ kvType: 'q4_0', maxContext: 4096, tags: ['cpu-offload'] });
  });

  it('dense: fewer GPU layers down to none, then gives up', async () => {
    const never: FakeProfile = { ...TUNE_PROFILE, memory: { totalMiB: 100, weightsMiB: 6000, kvMiBPer1k: 600, computeMiBPer512: 300, layers: 8 } };
    const { t } = await tune({ offload: { layers: 8, moe: false }, predict: undefined }, new Lab({ profile: never }));
    expect(t.attempts.filter((a) => a.stage === 'offload').map((a) => a.params.gpuLayers)).toEqual([4, 3, 2, 1, 0]);
    expect(t.combinations).toEqual([]);
    expect(t.recommended).toBeUndefined();
    // Time spent before any offload launch.
    const lab = new Lab({ profile: never, loadMs: BUDGETS.fast.minMs / 2 });
    expect((await tune({ offload: { layers: 8, moe: true }, predict: undefined, limitMs: BUDGETS.fast.minMs }, lab)).t.attempts.some((a) => a.stage === 'offload')).toBe(false);
    // MoE up to every layer.
    const moe = await tune({ offload: { layers: 2, moe: true }, predict: undefined }, new Lab({ profile: never }));
    expect(moe.t.attempts.filter((a) => a.stage === 'offload').map((a) => a.params.extraArgs)).toEqual([['--n-cpu-moe', '1'], ['--n-cpu-moe', '2']]);
  });

  it('fidelity: the same greedy tokens with f16 and the recommended cache; an indication only', async () => {
    const tokens = (p: LaunchParams) => (p.kvCacheType === 'f16' ? [1, 2, 3, 4, 5] : [1, 2, 9, 4]);
    const { t } = await tune({ fidelity: true }, new Lab({ tokens }));
    expect(t.fidelity).toEqual({ referenceKv: 'f16', comparedKv: 'q4_0', promptTokens: 1024, tokens: 4, identical: 3, firstDivergence: 2 });
    const fid = t.attempts.filter((a) => a.stage === 'fidelity');
    expect(fid.map((a) => [a.kvType, a.contextSize, a.params.contextSize, a.params.ubatchSize])).toEqual([
      ['f16', 4096, 4096, 512],
      ['q4_0', 4096, 4096, 2048],
    ]);
    const same = await tune({ fidelity: true }, new Lab({ tokens: () => ['a', 'b'] }));
    expect(same.t.fidelity).toMatchObject({ identical: 2, tokens: 2 });
    expect(same.t.fidelity).not.toHaveProperty('firstDivergence');
  });

  it('fidelity is skipped when the recommendation is already the most precise cache, or a launch fails', async () => {
    const roomy: FakeProfile = { ...TUNE_PROFILE, memory: { ...TUNE_PROFILE.memory!, totalMiB: 60_000 } };
    expect((await tune({ fidelity: true }, new Lab({ profile: roomy }))).t.fidelity).toBeUndefined();
    const refFails = new Lab({ fail: (p, n) => (p.contextSize === 4096 && n > 10 ? { code: 'ENGINE_EXITED', message: 'x' } : undefined) });
    expect((await tune({ fidelity: true }, refFails)).t.fidelity).toBeUndefined();
    const cmpFails = new Lab({ fail: (p, n) => (p.contextSize === 4096 && p.kvCacheType === 'q4_0' && n > 10 ? { code: 'ENGINE_EXITED', message: 'x' } : undefined) });
    expect((await tune({ fidelity: true }, cmpFails)).t.fidelity).toBeUndefined();
    // Only the offload combination: no reference KV that fits.
    const off = await tune({ fidelity: true, offload: { layers: 32, moe: true } }, new Lab({ profile: nothingFits }));
    expect(off.t.fidelity).toBeUndefined();
  });
});

describe('Tuner: vLLM', () => {
  const vprof: FakeProfile = { ...TUNE_PROFILE, memory: { totalMiB: 24_000, weightsMiB: 15_000, kvMiBPer1k: 200, computeMiBPer512: 0 } };
  const vspace = (budget: 'fast' | 'thorough' = 'fast') => vllmSpace({ budget, params: P(), utilizations: [0.9] });

  it('reads the KV capacity vLLM reports, tries the exact capacity, then --enforce-eager one step up', async () => {
    const { t, lab } = await tune({ space: vspace(), modelContext: 131072 }, new Lab({ profile: vprof, flavor: 'vllm' }));
    // auto: 0.9 × 24000 − 15000 − 1024 − 512 = 5064 MiB of KV = 25 927 tokens.
    expect(t.attempts[0]).toMatchObject({ kvType: 'auto', contextSize: 131072, outcome: 'oom', error: { params: { estimatedMaxModelLen: 25927 } } });
    expect(t.attempts[1]).toMatchObject({ kvType: 'auto', contextSize: 25600, outcome: 'ok' });
    expect(capacityOf(t)).toEqual({ auto: 25600, fp8: 51200 });
    expect(lab.started.every((p) => p.parallel === 1 && p.gpuMemoryUtilization === 0.9 && p.maxModelLen !== undefined)).toBe(true);
    // Eager: one step up does not fit, vLLM says 57 098 tokens do: measured there, on the same launch.
    const eagerTries = t.attempts.filter((a) => a.params.extraArgs.includes('--enforce-eager'));
    expect(eagerTries.map((a) => [a.contextSize, a.outcome])).toEqual([
      [102400, 'oom'],
      [56320, 'ok'],
    ]);
    const eager = t.combinations.find((c) => c.tags.includes('eager'));
    expect(eager).toMatchObject({ kvType: 'fp8', maxContext: 56320, params: { maxModelLen: 56320, extraArgs: ['--enforce-eager'] } });
    expect(t.combinations[t.recommended!]).toBe(eager);
    expect(t.dimensions).toEqual([
      { key: 'kv', values: ['auto', 'fp8'] },
      { key: 'gmu', values: [0.9] },
      { key: 'bt', values: [2048, 8192] },
    ]);
  });

  it('fidelity with vLLM: max-model-len set to the smallest context', async () => {
    const { t } = await tune({ space: vspace(), modelContext: 32768, fidelity: true }, new Lab({ profile: vprof, flavor: 'vllm', tokens: (p) => (p.kvCacheType === 'fp8' ? ['a', 'x'] : ['a', 'b']) }));
    expect(t.fidelity).toEqual({ referenceKv: 'auto', comparedKv: 'fp8', promptTokens: 1024, tokens: 2, identical: 1, firstDivergence: 1 });
    expect(t.attempts.filter((a) => a.stage === 'fidelity').map((a) => a.params.maxModelLen)).toEqual([4096, 4096]);
  });

  it('no eager attempt once the trained context is reached, nor when it does not fit', async () => {
    const small = await tune({ space: vspace(), modelContext: 16384 }, new Lab({ profile: vprof, flavor: 'vllm' }));
    expect(small.t.combinations.some((c) => c.tags.includes('eager'))).toBe(false);
    const tight: FakeProfile = { ...vprof, memory: { ...vprof.memory!, kvMiBPer1k: 2000 } };
    const no = await tune({ space: vspace('thorough'), budget: 'thorough', modelContext: 131072 }, new Lab({ profile: tight, flavor: 'vllm' }));
    expect(no.t.attempts.filter((a) => a.params.extraArgs.includes('--enforce-eager')).map((a) => a.outcome)).toEqual(['oom']);
  });
});

describe('Tuner: combinations', () => {
  it('a screened variant that is the fastest somewhere gets its own full sweep', async () => {
    // FA off is faster on short prompts here (no depth penalty, a better kernel at 1K).
    const prof: FakeProfile = { ...TUNE_PROFILE, speed: { ...TUNE_PROFILE.speed, faOffDepthFactor: 6 } };
    const lab = new Lab({ profile: prof });
    const orig = lab.prepare.bind(lab);
    lab.prepare = async (params) => {
      const r = await orig(params);
      return {
        ...r,
        start: async () => {
          const s = await r.start();
          if (!s.ok || params.flashAttention !== 'off') return s;
          const m = s.engine.measure;
          return { ...s, engine: { ...s.engine, measure: async (d, o, n, k) => (d <= 1024 ? point(d, 5000) : m(d, o, n, k)) } };
        },
      };
    };
    const { t } = await tune({}, lab);
    const off = t.combinations.find((c) => c.params.flashAttention === 'off');
    expect(off).toBeDefined();
    expect(t.fastestByDepth[0]).toEqual({ depth: 1024, combination: t.combinations.indexOf(off!) });
    expect(t.attempts.filter((a) => a.stage === 'sweep').length).toBeGreaterThan(0);
  });

  it('at most two extra sweeps of screened variants that win somewhere', async () => {
    // The base settings (ub 512) of every KV type are absurdly fast at 1K, each faster than the one before.
    const fast = { q8_0: 100_000, q4_0: 200_000, f16: 300_000 } as Record<string, number>;
    const decode = (p: LaunchParams, d: number) => (p.ubatchSize === 512 && d <= 1024 ? fast[p.kvCacheType as string] : undefined);
    const { t } = await tune({}, new Lab({ decode }));
    expect(t.attempts.filter((a) => a.stage === 'sweep')).toHaveLength(2);
    // Screened in the descent's order (q4_0 first: the largest context); q8_0's base is not faster than q4_0's at 1K.
    expect(t.combinations.filter((c) => c.params.ubatchSize === 512).map((c) => c.kvType)).toEqual(['q4_0', 'f16']);
    expect(t.fastestByDepth[0]).toEqual({ depth: 1024, combination: 4 });
    // Their sweeps reuse what their screening measured: the deepest prompt once per combination.
    const sweeps = t.attempts.filter((a) => a.stage === 'sweep');
    expect(sweeps.every((a) => a.points.every((p) => p.promptTokens !== 1024 || p.outputTokens === 32))).toBe(true);
  });

  it('a variant that runs out of memory at that context is dropped; vram unknown is left out', async () => {
    const tight: FakeProfile = { ...LINUX, memory: { ...LINUX.memory!, computeMiBPer512: 2000 } };
    const { t } = await tune({}, new Lab({ profile: tight, noVram: true }));
    expect(t.attempts.filter((a) => a.params.ubatchSize === 2048 && a.stage === 'variant').every((a) => a.outcome === 'oom')).toBe(true);
    expect(t.combinations.every((c) => c.params.ubatchSize === 512 && c.vramPeakMiB === undefined)).toBe(true);
  });
});
