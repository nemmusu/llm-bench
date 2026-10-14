// KV cache types: sizes, precision, a fork's own types, the forms' choices and the tuner's ladder.
import { describe, expect, it } from 'vitest';
import { launchParamsSchema } from '../../../src/contract/engines';
import {
  FAST_FORK_KV,
  forkKvTypes,
  isFullPrecisionKv,
  KV_CACHE_TYPE,
  knownKvType,
  kvPrecision,
  LLAMA_KV_TYPES,
  llamaKvBits,
  llamaKvChoices,
  llamaKvLadder,
} from '../../../src/contract/kv-cache';
import { tuneKvTypeSchema } from '../../../src/contract/results';

/** What the TurboQuant-like fork's --help lists (test/fixtures/llamacpp/help-turbo.stdout.txt). */
const TURBO = [...LLAMA_KV_TYPES, 'turbo4', 'turbo3', 'turbo2', 'turbo1.5', 'turbo3_tcq'];

describe('KV cache types', () => {
  it('bits per value: ggml’s block sizes, the forks’ documented ones, unknown ones undefined', () => {
    expect(['f32', 'f16', 'bf16', 'q8_0', 'q5_1', 'q5_0', 'q4_1', 'q4_0', 'iq4_nl'].map(llamaKvBits)).toEqual([32, 16, 16, 8.5, 6, 5.5, 5, 4.5, 4.5]);
    expect(['turbo4', 'turbo3', 'turbo3_tcq', 'turbo2', 'turbo1.5'].map(llamaKvBits)).toEqual([4.25, 3.125, 3.125, 2.125, 2]);
    expect(llamaKvBits('fancy7')).toBeUndefined();
    expect(knownKvType('turbo3')).toBe(true);
    expect(knownKvType('fancy7')).toBe(false);
    expect(['f32', 'f16', 'bf16', 'q8_0', 'turbo3'].map(isFullPrecisionKv)).toEqual([true, true, true, false, false]);
  });

  it('any short type word is accepted by the launch parameters and the tune records; anything else is refused', () => {
    expect(KV_CACHE_TYPE.test('turbo1.5')).toBe(true);
    expect(launchParamsSchema.parse({ kvCacheType: 'turbo3' }).kvCacheType).toBe('turbo3');
    expect(tuneKvTypeSchema.parse('turbo3_tcq')).toBe('turbo3_tcq');
    for (const bad of ['', '-ctk', 'q4 0', 'x'.repeat(33)]) {
      expect(launchParamsSchema.safeParse({ kvCacheType: bad }).success).toBe(false);
      expect(tuneKvTypeSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('a fork’s own types are the ones upstream llama.cpp lacks, once each, in the build’s order', () => {
    expect(forkKvTypes(undefined)).toEqual([]);
    expect(forkKvTypes(LLAMA_KV_TYPES)).toEqual([]);
    expect(forkKvTypes([...TURBO, 'turbo3', 'bad value'])).toEqual(['turbo4', 'turbo3', 'turbo2', 'turbo1.5', 'turbo3_tcq']);
  });

  it('the forms offer f16, q8_0, q4_0, then the fork’s types larger first, unknown sizes last', () => {
    expect(llamaKvChoices(undefined)).toEqual(['f16', 'q8_0', 'q4_0']);
    expect(llamaKvChoices([...LLAMA_KV_TYPES, 'fancy7', 'turbo2', 'turbo4', 'turbo3', 'turbo3_tcq'])).toEqual(['f16', 'q8_0', 'q4_0', 'turbo4', 'turbo3', 'turbo3_tcq', 'turbo2', 'fancy7']);
  });

  it('the search’s ladder: upstream’s three, the fork’s known types by size; "Veloce" only the most compact', () => {
    expect(llamaKvLadder('fast')).toEqual(['f16', 'q8_0', 'q4_0']);
    expect(llamaKvLadder('thorough', LLAMA_KV_TYPES)).toEqual(['f16', 'q8_0', 'q4_0']);
    expect(llamaKvLadder('thorough', [...TURBO, 'fancy7'])).toEqual(['f16', 'q8_0', 'q4_0', 'turbo4', 'turbo3', 'turbo3_tcq', 'turbo2', 'turbo1.5']);
    expect(llamaKvLadder('recheck', TURBO)).toHaveLength(8);
    expect(FAST_FORK_KV).toBe(2);
    expect(llamaKvLadder('fast', TURBO)).toEqual(['f16', 'q8_0', 'q4_0', 'turbo2', 'turbo1.5']);
    // A fork with fewer types: both join; one of unknown size never does.
    expect(llamaKvLadder('fast', ['f16', 'q8_0', 'q4_0', 'turbo4', 'turbo3', 'fancy7'])).toEqual(['f16', 'q8_0', 'q4_0', 'turbo4', 'turbo3']);
  });

  it('precision: f16 0, q8_0 1, q4_0 2, a quarter point per bit below; vLLM / NInfer as before; unknown 2', () => {
    expect(['f16', 'auto', 'bf16', 'f32', 'q8_0', 'fp8', 'int8', 'k8v4', 'rk8v4', 'q4_0', 'nvfp4', 'iq4_nl'].map(kvPrecision)).toEqual([0, 0, 0, 0, 1, 1, 1, 1.5, 1.5, 2, 2, 2]);
    expect(kvPrecision('q5_0')).toBe(1.75);
    expect(kvPrecision('turbo4')).toBeCloseTo(2.0625, 9);
    expect(kvPrecision('turbo3')).toBeCloseTo(2.34375, 9);
    expect(kvPrecision('turbo2')).toBeCloseTo(2.59375, 9);
    expect(kvPrecision('turbo1.5')).toBe(2.625);
    expect(kvPrecision('fancy7')).toBe(2);
    // Between q8_0 and q4_0 in proportion.
    expect(kvPrecision('q5_1')).toBe(1.625);
  });
});
