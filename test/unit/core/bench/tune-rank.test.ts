import { describe, expect, it } from 'vitest';
import {
  comparePoints,
  fastestByDepth,
  kvPrecisionRank,
  measuredDepths,
  pointAt,
  recommendedCombination,
  screenBetter,
  tied,
} from '../../../../src/core/bench/tune-rank';
import { combo, point, stat } from './tune-helpers';

describe('noise-aware comparisons', () => {
  it('ties within max(2 %, 2 × CV)', () => {
    expect(tied(stat(100), stat(101.9))).toBe(true);
    expect(tied(stat(100), stat(103))).toBe(false);
    expect(tied(stat(100, 0.05), stat(109))).toBe(true);
    expect(tied(stat(0), stat(0))).toBe(true);
  });

  it('generation first, then prompt reading, then the first token; a full tie is 0', () => {
    expect(comparePoints(point(1024, 110), point(1024, 100))).toBeGreaterThan(0);
    expect(comparePoints(point(1024, 100, { prefill: 9000 }), point(1024, 101, { prefill: 5000 }))).toBeGreaterThan(0);
    expect(comparePoints(point(1024, 100, { prefill: 5000, ttft: 300 }), point(1024, 100, { prefill: 5000, ttft: 200 }))).toBeLessThan(0);
    expect(comparePoints(point(1024, 100), point(1024, 100))).toBe(0);
    // The engine's own reading speed counts when it reports one.
    expect(comparePoints(point(1024, 100, { prefill: 9000, engine: true }), point(1024, 100, { prefill: 5000 }))).toBeGreaterThan(0);
  });

  it('screening: the deepest points decide, then the shallow ones, a full tie keeps the current value', () => {
    const base = [point(1024, 100), point(32624, 60)];
    expect(screenBetter([point(1024, 90), point(32624, 70)], base)).toBe(true);
    expect(screenBetter([point(1024, 200), point(32624, 50)], base)).toBe(false);
    expect(screenBetter([point(1024, 110), point(32624, 60)], base)).toBe(true);
    expect(screenBetter([point(1024, 100), point(32624, 60)], base)).toBe(false);
  });

  it('KV precision: f16/auto before the 8-bit caches before q4_0', () => {
    expect(['q4_0', 'fp8', 'f16', 'q8_0', 'auto'].map((k) => kvPrecisionRank(k as 'f16'))).toEqual([2, 1, 0, 1, 0]);
  });
});

describe('fastest per depth and the recommendation', () => {
  const f16 = combo('f16', 16384, [point(1024, 150), point(4096, 140), point(16240, 120)]);
  const q8 = combo('q8_0', 32768, [point(1024, 150), point(4096, 139), point(16384, 125), point(32624, 90)]);
  const q4 = combo('q4_0', 65536, [point(1024, 140), point(4096, 135), point(16384, 118), point(32768, 95), point(65392, 70)]);
  const q4b = combo('q4_0', 65536, [point(1024, 141), point(65392, 80)], { params: { contextSize: 65536, ubatchSize: 2048, extraArgs: [], env: {} } });

  it('lines sweeps up on nominal depths, only fitting combinations', () => {
    expect(measuredDepths([f16, q8, q4, combo('f16', 4096, [point(2000, 1)], { outcome: 'spill' })])).toEqual([1024, 4096, 16384, 32768, 65536]);
    expect(pointAt(q8.sweep, 32768)?.promptTokens).toBe(32624);
    expect(pointAt(q8.sweep, 65536)).toBeUndefined();
  });

  it('at each depth the fastest; ties go to the more precise KV, then the earlier combination', () => {
    expect(fastestByDepth([f16, q8, q4])).toEqual([
      { depth: 1024, combination: 0 },
      { depth: 4096, combination: 0 },
      { depth: 16384, combination: 1 },
      { depth: 32768, combination: 2 },
      { depth: 65536, combination: 2 },
    ]);
    expect(fastestByDepth([q8, q8])[0]).toEqual({ depth: 1024, combination: 0 });
  });

  it('recommended: the fastest among those reaching the largest context (at its deepest point)', () => {
    expect(recommendedCombination([f16, q8, q4, q4b])).toBe(3);
    expect(recommendedCombination([f16, q8])).toBe(1);
    expect(recommendedCombination([combo('f16', 4096, [], { outcome: 'ok' }), combo('q8_0', 8192, [point(1, 1)], { outcome: 'oom' })])).toBeUndefined();
    expect(recommendedCombination([])).toBeUndefined();
    // Partly measured (the time ran out): compared at the deepest depth they all have, 64K here …
    const partQ8 = combo('q8_0', 262_144, [point(1024, 54.8), point(65_536, 46.5)], { partial: 'budget' });
    const partQ4 = combo('q4_0', 262_144, [point(1024, 50), point(16_384, 99), point(65_536, 40)], { partial: 'budget' });
    expect(recommendedCombination([partQ4, partQ8])).toBe(1);
    // … and nothing in common at all: the more precise cache, then the earlier one.
    const onlyDeep = combo('q4_0', 262_144, [point(65_536, 99)], { partial: 'budget' });
    const onlyProbe = combo('q8_0', 262_144, [point(1024, 50)], { partial: 'budget' });
    expect(recommendedCombination([onlyDeep, onlyProbe])).toBe(1);
    expect(recommendedCombination([onlyProbe, { ...onlyProbe, sweep: [point(2048, 1)] }])).toBe(0);
    // A screening cut by the time limit is compared on the depths both have.
    expect(screenBetter([point(1024, 60), point(65_536, 50)], [point(1024, 50), point(65_536, 40), point(262_000, 30)])).toBe(true);
    expect(screenBetter([point(2048, 60)], [point(1024, 50)])).toBe(false);
    // A sweep cut short is compared where both have a point.
    const short = combo('q4_0', 65536, [point(1024, 300), point(4096, 290)]);
    expect(recommendedCombination([q4, short])).toBe(1);
  });
});
