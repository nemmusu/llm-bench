/**
 * "Scelte da LLM Bench" for a NInfer test in the plan (BenchService.prepare → core/engines/ninfer/defaults.ts):
 * what it chose is in RunPlan.ninferAuto and in the launch; the user's own settings stay; a tune searches
 * them itself; other engines have none of it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { launchParamsSchema } from '../../../../src/contract/engines';
import type { FitEstimate } from '../../../../src/contract/models';
import type { Tuning } from '../../../../src/contract/results';
import { BenchService } from '../../../../src/core/bench/service';
import { makeRun, modelIdentity } from '../store/fixtures';
import { combo, point } from './tune-helpers';
import { request, serviceSetup, TempDirs } from './service-helpers';

const tmp = new TempDirs();
afterEach(() => tmp.cleanup());

const identity = modelIdentity({ displayName: 'qwen3_8_27b_nvfp4', format: 'ninfer', file: 'qwen3_8_27b_nvfp4.ninfer', weakKey: 'neroued/q38', facts: { contextLength: 262_144 } });
const fit = (level: FitEstimate['level']): FitEstimate => ({ level, needMiB: 1, availableMiB: 2, totalMiB: 32_000, contextSize: 8192, notes: [] }) as unknown as FitEstimate;

function setup(o: { fit?: (kv: string | undefined) => FitEstimate['level'] } = {}) {
  const s = serviceSetup(tmp, {
    adapter: { kind: 'ninfer-wsl' },
    deps: {
      resolveModel: async () => ({ identity }),
      ...(o.fit ? { fit: async (_req, _model, plan) => fit(o.fit!(plan.params.ninfer?.kvDtype)) } : {}),
    },
  });
  return new BenchService(s.deps);
}

const ninfer = (over: Record<string, unknown> = {}) => request({ engine: { kind: 'ninfer-wsl' }, ...over });

describe('LLM Bench’s choice of NInfer settings for a test', () => {
  it('the most precise KV type that fits, said in the plan', async () => {
    const plan = await setup({ fit: (kv) => (kv === 'bf16' ? 'no' : 'good') }).plan(ninfer());
    expect(plan.ninferAuto).toEqual({ source: 'fit', spec: 'off', kvDtype: 'int8', fits: true });
  });

  it('the user’s own settings stay; a tune and other engines have none of it', async () => {
    const own = await setup().plan(ninfer({ params: { ninfer: { spec: 'off', kvDtype: 'fp8' } } }));
    expect(own.ninferAuto).toBeUndefined();
    // No fit estimate: the first type is taken.
    expect((await setup().plan(ninfer({ params: { ninfer: { kvDtype: 'int8' } } }))).ninferAuto).toEqual({ source: 'fit', spec: 'off' });
    expect((await setup().plan(ninfer())).ninferAuto).toMatchObject({ kvDtype: 'bf16' });
    expect((await setup().plan(ninfer({ profile: 'tune' }))).ninferAuto).toBeUndefined();
    // Several users at once: the search for that many is the one asked for (none here).
    expect((await setup().plan(ninfer({ params: { parallel: 2 } }))).ninferAuto).toMatchObject({ source: 'fit' });
    expect((await setup().plan(request())).ninferAuto).toBeUndefined();
  });

  it('a build whose options cannot be read: the official KV types', async () => {
    const s = serviceSetup(tmp, { adapter: { kind: 'ninfer-wsl' }, deps: { resolveModel: async () => ({ identity }) } });
    const inner = s.adapter;
    s.deps.getAdapter = () => Object.assign(Object.create(inner) as typeof inner, { capabilities: () => Promise.reject(new Error('no help')) });
    expect((await new BenchService(s.deps).plan(ninfer())).ninferAuto).toMatchObject({ kvDtype: 'bf16' });
  });

  it('the latest "Trova le impostazioni migliori" of this model here decides, and the plan says when it ran', async () => {
    const s = serviceSetup(tmp, { adapter: { kind: 'ninfer-wsl' }, deps: { resolveModel: async () => ({ identity }) } });
    const params = launchParamsSchema.parse({ contextSize: 131_072, parallel: 1, ninfer: { kvCapacity: 131_072, kvDtype: 'nvfp4', spec: 'mtp', draftTokens: 4, lmHeadDraft: true } });
    const tuning: Tuning = {
      budget: 'fast',
      maxLaunches: 24,
      dimensions: [],
      capacity: [],
      depths: [1024],
      attempts: [],
      combinations: [combo('nvfp4', 131_072, [point(1024, 100)], { params })],
      recommended: 0,
      fastestByDepth: [{ depth: 1024, combination: 0 }],
    };
    const base = makeRun();
    await s.runs.save(makeRun({ id: 'TUNE-N', model: identity, engine: { ...base.engine, kind: 'ninfer-wsl' }, scenario: { profile: 'tune', seed: 42, steps: [] }, tuning, launch: { ...base.launch, params } }));
    const plan = await new BenchService(s.deps).plan(ninfer());
    expect(plan.ninferAuto).toMatchObject({ source: 'tuned', spec: 'mtp', draftTokens: 4, kvDtype: 'nvfp4' });
    expect(plan.ninferAuto?.createdAt).toBe(base.createdAt);
  });
});
