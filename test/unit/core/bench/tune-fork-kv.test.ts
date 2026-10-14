/**
 * A llama.cpp fork's own KV caches (turbo4, turbo3…) in the VRAM estimate, the search space, the ranking
 * and a whole search against the fake engine's memory model (TURBO_PROFILE: upstream's types stop short
 * of the model's 40K, a fork type holds it).
 */
import { describe, expect, it } from 'vitest';
import type { FitEstimate, ModelFacts } from '../../../../src/contract/models';
import { kvPrecisionRank } from '../../../../src/core/bench/tune-rank';
import { llamaSpace } from '../../../../src/core/bench/tune-space';
import { estimateFit, FIT_NOTES, fitFixes, fitParamsFrom, kvElementBytes, kvSizeUnknown } from '../../../../src/core/models/fit';
import type { ModelFactsEx } from '../../../../src/core/models/types';
import { TURBO_PROFILE } from '../../../fakes/fake-engine/profiles.mjs';
import { capacityOf, Lab, P, tune } from './tune-lab';

const TURBO = ['f32', 'f16', 'bf16', 'q8_0', 'q4_0', 'q4_1', 'iq4_nl', 'q5_0', 'q5_1', 'turbo4', 'turbo3', 'turbo2', 'turbo1.5', 'turbo3_tcq'];
const GPU = { totalMiB: 32607, freeMiB: 30900 };
const MIB = 1024 * 1024;
/** Llama-3.1-8B-like facts (32 layers, 8 KV heads of 128). */
const llama8b: ModelFactsEx = {
  architecture: 'llama',
  paramsB: 8.03,
  quant: 'Q4_K_M',
  contextLength: 131072,
  blockCount: 32,
  headCount: 32,
  headCountKv: 8,
  keyLength: 128,
  valueLength: 128,
  embeddingLength: 4096,
  kv: { groups: [{ layers: 32, kvHeads: 8, keyLength: 128, valueLength: 128 }], recurrentLayers: 0, recurrentBytesPerSeq: 0 },
} as ModelFacts as ModelFactsEx;

describe('the VRAM estimate of a fork’s KV cache', () => {
  it('bytes per value from the type’s bits; an unknown type counts as f16 and says so', () => {
    expect(kvElementBytes('llamacpp', 'turbo3')).toBe(3.125 / 8);
    expect(kvElementBytes('llamacpp', 'turbo1.5')).toBe(0.25);
    expect(kvElementBytes('llamacpp', 'q8_0')).toBe(34 / 32);
    expect(kvElementBytes('llamacpp', 'fancy7')).toBe(2);
    expect(kvElementBytes('llamacpp', undefined)).toBe(2);
    // vLLM has none of them: its 8-bit cache for llama.cpp's q8_0 / q4_0, f16 otherwise.
    expect(kvElementBytes('vllm', 'turbo3')).toBe(2);
    expect(kvElementBytes('vllm', 'q4_0')).toBe(1);
    expect(['turbo3', 'fancy7', 'auto', 'fp8', undefined].map(kvSizeUnknown)).toEqual([false, true, false, false, false]);

    const at = (kv: string, engine: 'llamacpp-native' | 'vllm-docker' = 'llamacpp-native') =>
      estimateFit({ facts: llama8b, fileBytes: 4920 * MIB, gpu: GPU, engine, params: fitParamsFrom(P({ contextSize: 65536, kvCacheType: kv })) });
    const [f16, q4, t3, t2, unknown] = [at('f16'), at('q4_0'), at('turbo3'), at('turbo2'), at('fancy7')];
    // 64K of an 8B model: 8 GiB in f16; turbo3 is 3.125/16 of it.
    expect(f16.kvMiB).toBe(8192);
    expect(t3.kvMiB).toBe(1600);
    expect(t2.kvMiB).toBeLessThan(t3.kvMiB);
    expect(t3.kvMiB).toBeLessThan(q4.kvMiB);
    expect(unknown.kvMiB).toBe(f16.kvMiB);
    expect(unknown.notes).toContain(FIT_NOTES.kvTypeUnknown);
    expect(t3.notes).not.toContain(FIT_NOTES.kvTypeUnknown);
    // vLLM never says so (it has no such types to ask for).
    expect(at('fancy7', 'vllm-docker').notes).not.toContain(FIT_NOTES.kvTypeUnknown);
  });

  it('"Usa cache q4_0" is offered only for a cache larger than q4_0, not for a fork’s smaller one', () => {
    const estimate = (p: ReturnType<typeof P>): Pick<FitEstimate, 'level' | 'levelNow'> => ({ level: 'no', levelNow: p.kvCacheType === 'q4_0' ? 'good' : 'no' });
    const no = { level: 'no' as const, levelNow: 'no' as const, contextSize: 8192 };
    expect(fitFixes('llamacpp-native', P({ contextSize: 8192, kvCacheType: 'turbo3' }), no, estimate)).toBeUndefined();
    expect(fitFixes('llamacpp-native', P({ contextSize: 8192, kvCacheType: 'q8_0' }), no, estimate)).toEqual({ kvCacheType: 'q4_0' });
    // A type of unknown size is treated as f16: q4_0 may help.
    expect(fitFixes('llamacpp-native', P({ contextSize: 8192, kvCacheType: 'fancy7' }), no, estimate)).toEqual({ kvCacheType: 'q4_0' });
  });
});

describe('the search space with a fork’s KV caches', () => {
  it('the ladder follows the build’s list; a fork type runs with flash attention only, K = V', () => {
    expect(llamaSpace({ budget: 'fast', params: P() }).kvLadder).toEqual(['f16', 'q8_0', 'q4_0']);
    expect(llamaSpace({ budget: 'fast', params: P(), cacheTypes: TURBO }).kvLadder).toEqual(['f16', 'q8_0', 'q4_0', 'turbo2', 'turbo1.5']);
    const space = llamaSpace({ budget: 'thorough', params: P(), cacheTypes: TURBO });
    expect(space.kvLadder).toEqual(['f16', 'q8_0', 'q4_0', 'turbo4', 'turbo3', 'turbo3_tcq', 'turbo2', 'turbo1.5']);
    const v = space.base('turbo3');
    expect(space.dimensions.find((d) => d.key === 'fa')!.values(v)).toEqual(['on']);
    expect(space.params(v, 65536)).toMatchObject({ kvCacheType: 'turbo3', flashAttention: 'on', contextSize: 65536 });
  });

  it('ranks a fork’s smaller caches after q4_0, by size', () => {
    expect(['f16', 'q8_0', 'q4_0', 'turbo4', 'turbo3', 'turbo2'].map(kvPrecisionRank)).toEqual([0, 1, 2, 2.0625, 2.34375, 2.59375]);
  });
});

describe('a whole search with a fork that lists turbo4 and turbo3 (fake engine memory model)', () => {
  it('finds more context with turbo3 than with q4_0 and recommends it', async () => {
    const space = llamaSpace({ budget: 'fast', params: P(), cacheTypes: ['f16', 'q8_0', 'q4_0', 'turbo4', 'turbo3'] });
    const { t } = await tune({ space }, new Lab({ profile: TURBO_PROFILE }));
    expect(t.dimensions[0]).toEqual({ key: 'kv', values: ['f16', 'q8_0', 'q4_0', 'turbo4', 'turbo3'] });
    const max = capacityOf(t);
    expect(max).toMatchObject({ f16: 8192, q8_0: 16384, q4_0: 32768, turbo3: 40960 });
    expect(max.turbo3).toBeGreaterThan(max.q4_0 as number);
    expect(t.attempts.filter((a) => a.kvType === 'turbo3').every((a) => a.params.kvCacheType === 'turbo3' && a.params.flashAttention === 'on')).toBe(true);
    expect(t.combinations[t.recommended!]).toMatchObject({ kvType: 'turbo3', maxContext: 40960 });
  });
});
