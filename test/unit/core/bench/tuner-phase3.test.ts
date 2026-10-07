/**
 * Phase 3 of the single-user search on the deterministic machine (tune-lab.ts): three screening depths,
 * the biggest ubatch only where the estimate allows it, vLLM's memory share stepping down, its block
 * size and fp8 format, fewer CUDA graphs before eager, values that won before tried first.
 */
import { describe, expect, it } from 'vitest';
import type { LaunchParams } from '../../../../src/contract/engines';
import type { FitEstimate } from '../../../../src/contract/models';
import { llamaSpace, vllmSpace } from '../../../../src/core/bench/tune-space';
import { BUDGETS, screenDepths, startupRefused, Tuner } from '../../../../src/core/bench/tuner';
import { VLLM_TUNE_PROFILE } from '../../../fakes/fake-engine/profiles.mjs';
import type { FakeProfile } from '../../../fakes/fake-engine/server.mjs';
import { capacityOf, input, Lab, optimistic, P, tune } from './tune-lab';

const UB_FLAGS = new Set(['-ub', '--ubatch-size']);

describe('screening depths', () => {
  it('1K, the grid depth nearest to half the deepest prompt, the deepest prompt', () => {
    expect(screenDepths(40960, 128)).toEqual([1024, 16384, 40816]);
    expect(screenDepths(32768, 128)).toEqual([1024, 16384, 32624]);
    expect(screenDepths(16384, 128)).toEqual([1024, 8192, 16240]);
    expect(screenDepths(8192, 128)).toEqual([1024, 4096, 8048]);
    expect(screenDepths(4096, 128)).toEqual([1024, 3952]);
    expect(screenDepths(1000, 128)).toEqual([856]);
  });
});

describe('Tuner: the biggest ubatch ("Accurata")', () => {
  const thorough = { budget: 'thorough' as const, space: llamaSpace({ budget: 'thorough', params: P(), flags: UB_FLAGS }) };

  it('is tried when the build lists -ub and the estimate allows it at that context', async () => {
    const { t } = await tune(thorough);
    expect(t.dimensions.find((d) => d.key === 'ub')!.values).toEqual([512, 256, 1024, 2048, 4096]);
    const big = t.attempts.filter((a) => a.params.ubatchSize === 4096);
    expect(big.length).toBeGreaterThan(0);
    // b ≥ ub: llama.cpp would clamp ub to b.
    expect(big.every((a) => (a.params.batchSize as number) >= 4096)).toBe(true);
  });

  it('is skipped where the measured VRAM plus what the estimate adds would not fit', async () => {
    // The estimate says ub 4096 needs 50 GB more than the screened settings.
    const predict = (p: LaunchParams): FitEstimate => ({ ...optimistic(), needMiB: 1000 + (p.ubatchSize === 4096 ? 50_000 : 0), availableMiB: 30_000 });
    const { t } = await tune({ ...thorough, predict });
    expect(t.attempts.some((a) => a.params.ubatchSize === 4096)).toBe(false);
    // Without the VRAM of the screened launch, the estimate alone decides.
    const blind = await tune({ ...thorough, predict }, new Lab({ noVram: true }));
    expect(blind.t.attempts.some((a) => a.params.ubatchSize === 4096)).toBe(false);
    // No estimate at all: tried.
    const unknown = await tune({ ...thorough, predict: (p) => (p.ubatchSize === 4096 ? undefined : optimistic()) });
    expect(unknown.t.attempts.some((a) => a.params.ubatchSize === 4096)).toBe(true);
  });

  it('values that won before are tried first', async () => {
    const learned = { runs: 3, first: [{ key: 'ub', value: 2048 }] };
    const space = llamaSpace({ budget: 'thorough', params: P(), flags: UB_FLAGS, prefer: { ub: [2048], b: [4096] } });
    const { t } = await tune({ budget: 'thorough', space, learned });
    expect(t.learned).toEqual(learned);
    expect(t.dimensions.find((d) => d.key === 'ub')!.values).toEqual([2048, 512, 256, 1024, 4096]);
    // The first ubatch tried after the base settings is the one that won before.
    const firstUb = t.attempts.find((a) => a.stage === 'variant' && a.params.ubatchSize !== 512);
    expect(firstUb?.params.ubatchSize).toBe(2048);
  });
});

describe('Tuner: vLLM phase 3', () => {
  const vprof: FakeProfile = VLLM_TUNE_PROFILE;
  const flags = new Set(['--cuda-graph-sizes', '--block-size', '--kv-cache-dtype']);
  const choices = { '--block-size': ['8', '16', '32'], '--kv-cache-dtype': ['auto', 'fp8', 'fp8_e4m3', 'fp8_e5m2'] };

  it('the memory share steps down until vLLM starts; block size 32 wins, e5m2 ties; fewer CUDA graphs go beyond the largest context', async () => {
    const space = vllmSpace({ budget: 'thorough', params: P(), utilizations: [0.95, 0.9, 0.85], flags, choices });
    const { t } = await tune({ budget: 'thorough', space, modelContext: 131072 }, new Lab({ profile: vprof, flavor: 'vllm' }));
    // 0.95 × 24 000 > 22 000 free: refused, then 0.9 for everything.
    expect(t.attempts[0]).toMatchObject({ outcome: 'error', error: { code: 'VRAM_BUSY', params: { utilization: 0.95 } }, variant: { gmu: 0.95 } });
    expect(t.attempts.slice(1).every((a) => a.params.gpuMemoryUtilization === 0.9)).toBe(true);
    expect(t.dimensions).toEqual([
      { key: 'kv', values: ['auto', 'fp8'] },
      { key: 'gmu', values: [0.95, 0.9] },
      { key: 'bt', values: [2048, 8192, 16384] },
      { key: 'bs', values: [16, 32] },
      { key: 'fp8', values: ['fp8_e4m3', 'fp8_e5m2'] },
    ]);
    expect(capacityOf(t)).toEqual({ auto: 25600, fp8: 51200 });
    // fp8 is explicit: e4m3 (the default) unless e5m2 were faster.
    const fp8 = t.combinations.find((c) => c.kvType === 'fp8' && !c.variant?.graphs)!;
    expect(fp8.params.extraArgs).toEqual(expect.arrayContaining(['--block-size', '32', '--kv-cache-dtype', 'fp8_e4m3']));
    expect(t.attempts.some((a) => a.variant?.fp8 === 'fp8_e5m2' && a.screen === 'lost')).toBe(true);
    // Capture sizes 1·2·4 free graph memory: 56 320 tokens; eager cannot go further.
    const graphs = t.combinations.find((c) => c.variant?.graphs === 'small')!;
    expect(graphs).toMatchObject({ kvType: 'fp8', maxContext: 56320, tags: [] });
    // On the best settings found for fp8 (block size 32).
    expect(graphs.params.extraArgs).toEqual(['--cuda-graph-sizes', '1', '2', '4', '--block-size', '32', '--kv-cache-dtype', 'fp8_e4m3']);
    expect(t.combinations.some((c) => c.tags.includes('eager'))).toBe(false);
    expect(t.combinations[t.recommended!]).toBe(graphs);
  });

  it('a memory share no lower one can replace: the run fails with VRAM_BUSY', async () => {
    const space = vllmSpace({ budget: 'fast', params: P(), utilizations: [0.95] });
    await expect(tune({ space, modelContext: 131072 }, new Lab({ profile: vprof, flavor: 'vllm' }))).rejects.toMatchObject({ code: 'VRAM_BUSY' });
    expect(startupRefused({ code: 'VRAM_BUSY', message: '' })).toBe(false);
    expect(startupRefused({ code: 'VRAM_BUSY', message: '', params: { utilization: 0.9 } })).toBe(true);
    expect(startupRefused({ code: 'ENGINE_OOM', message: '', params: { utilization: 0.9 } })).toBe(false);
  });

  it('the budget ends before the descent: the extensions start from the base settings (and stop at once)', async () => {
    const space = vllmSpace({ budget: 'fast', params: P(), utilizations: [0.9], flags });
    const lab = new Lab({ profile: vprof, flavor: 'vllm' });
    const tuner = new Tuner(input({ space, modelContext: 131072 }), { lab, now: lab.now });
    // Capacity of auto (2 launches) and the top of fp8 (1): fp8 is left with the context auto proved, unscreened.
    (tuner as unknown as { rules: object }).rules = { ...BUDGETS.fast, maxLaunches: 3 };
    const t = await tuner.run();
    expect(t.stoppedBy).toBe('launches');
    expect(t.attempts).toHaveLength(3);
    expect(t.capacity.find((c) => c.kvType === 'fp8')).toMatchObject({ measuredMax: 25600, inferred: true, skipped: 'budget' });
    expect(t.combinations.filter((c) => c.variant?.graphs === 'small')).toEqual([]);
  });

  it('without a start-up ladder the variants keep vLLM’s default share', async () => {
    const space = vllmSpace({ budget: 'fast', params: P() });
    const free: FakeProfile = { ...vprof, memory: { ...vprof.memory!, freeMiB: 24_000 } };
    const { t } = await tune({ space, modelContext: 32768 }, new Lab({ profile: free, flavor: 'vllm' }));
    expect(t.attempts.every((a) => a.params.gpuMemoryUtilization === undefined)).toBe(true);
    expect(t.dimensions.map((d) => d.key)).toEqual(['kv', 'bt']);
  });
});
