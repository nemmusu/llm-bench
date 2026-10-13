import { describe, expect, it } from 'vitest';
import { nominalDepth } from '../../../../src/contract/results';
import {
  anchorOf,
  CONTEXT_MARGIN,
  DECODE_HALF_DEPTH,
  depthGrid,
  expectedMs,
  maxDepth,
  PREFILL_HALF_DEPTH,
  prefillRate,
  rateAt,
  requestMsAt,
  runSweep,
  sweepDepths,
} from '../../../../src/core/bench/sweep';
import { point } from './tune-helpers';

describe('context sweep depths', () => {
  it('the deepest prompt leaves room for the answer and the margin', () => {
    expect(maxDepth(32768, 128)).toBe(32768 - 128 - CONTEXT_MARGIN);
  });

  it('grid: 1K, 4K, then doubling up to the limit', () => {
    expect(depthGrid(500)).toEqual([]);
    expect(depthGrid(4096)).toEqual([1024, 4096]);
    expect(depthGrid(70000)).toEqual([1024, 4096, 8192, 16384, 32768, 65536]);
  });

  it('adds the exact maximum, the optional fractions, sorted without duplicates', () => {
    expect(sweepDepths(32768, 128)).toEqual([1024, 4096, 8192, 16384, 32624]);
    expect(sweepDepths(65536 + 144, 128)).toEqual([1024, 4096, 8192, 16384, 32768, 65536]);
    expect(sweepDepths(16384, 128, { fractions: true })).toEqual([1024, 4096, 8192, 12288, 16240]);
    expect(sweepDepths(1000, 128)).toEqual([856]);
    expect(sweepDepths(144, 128)).toEqual([]);
    expect(sweepDepths(145, 128, { fractions: true })).toEqual([1]);
  });

  it('nominal depths line sweeps of different contexts up', () => {
    expect(nominalDepth(32624)).toBe(32768);
    expect(nominalDepth(40816)).toBe(40960);
    expect(nominalDepth(1024)).toBe(1024);
    expect(nominalDepth(856)).toBe(1024);
    expect(nominalDepth(700)).toBe(700);
    expect(nominalDepth(12000)).toBe(12000);
  });
});

describe('runSweep', () => {
  it('measures shallow first and stops early when a point asks so', async () => {
    const seen: number[] = [];
    const run = await runSweep([1024, 4096, 8192], async (d) => (seen.push(d), point(d, 100)), {
      outputTokens: 128,
      reps: 1,
      now: () => 0,
      onPoint: (p) => p.promptTokens < 4096,
    });
    expect(seen).toEqual([1024, 4096]);
    expect(run).toMatchObject({ stopped: true });
    expect(run.points).toHaveLength(2);
  });

  it('skips the depths that no longer fit in the time budget (estimated from the last point)', async () => {
    let t = 0;
    const run = await runSweep(
      [1024, 4096, 65536],
      async (d) => {
        t += 1000;
        return point(d, 100, { prefill: 4096 });
      },
      { outputTokens: 100, reps: 2, now: () => t, maxMs: 10_000 },
    );
    expect(run.points.map((p) => p.promptTokens)).toEqual([1024, 4096]);
    expect(run.skippedFrom).toBe(65536);
    expect(await runSweep([1, 2], async (d) => point(d, 1), { outputTokens: 1, reps: 1, now: () => 0 })).toEqual({ points: [point(1, 1), point(2, 1)] });
  });

  it('expected time grows with depth faster than linearly; the engine prefill rate wins', () => {
    const last = point(4096, 50, { prefill: 4096 });
    expect(expectedMs(4096, last, { outputTokens: 50, reps: 1 })).toBeCloseTo(2000, 6);
    // 16K: four times the tokens, read a little slower (attention grows with the context).
    const at16k = expectedMs(16384, last, { outputTokens: 0, reps: 2 });
    expect(at16k).toBeGreaterThan(2 * 4 * 1000);
    expect(at16k).toBeCloseTo(2 * (16384 / rateAt(4096, 4096, 16384, PREFILL_HALF_DEPTH)) * 1000, 6);
    expect(prefillRate(point(1, 1, { prefill: 777, engine: true }))).toBe(777);
  });
});

describe('time of a request at another depth (an RTX 5090 with a 27B Q4 model: real numbers)', () => {
  // Read 1 810 tok/s at 1K, 1 450 at 128K, 875 at 256K; generated 55.9, 40.2 and 27.9 tok/s.
  const at1k = { depth: 1024, prefillTps: 1810, decodeTps: 55.9 };
  const at128k = { depth: 131_072, prefillTps: 1450, decodeTps: 40.2 };

  it('speeds move with the depth: about half at the half depths', () => {
    expect(rateAt(1000, 0, PREFILL_HALF_DEPTH, PREFILL_HALF_DEPTH)).toBe(500);
    expect(rateAt(55.9, 1024, 262_144, DECODE_HALF_DEPTH)).toBeCloseTo(28.06, 1);
    expect(anchorOf(point(2048, 40, { prefill: 900 }))).toEqual({ depth: 2048, prefillTps: 900, decodeTps: 40 });
  });

  it('a 256K prompt takes minutes: from the 1K speeds 6 min (300 s measured), from the 128K ones 4.5 min', () => {
    const fromShallow = requestMsAt(262_144, 128, at1k);
    const fromDeep = requestMsAt(262_144, 128, at128k);
    expect(fromShallow / 1000).toBeGreaterThan(300);
    expect(fromShallow / 1000).toBeLessThan(450);
    expect(fromDeep / 1000).toBeGreaterThan(250);
    expect(fromDeep / 1000).toBeLessThan(300);
    // A 128K prompt from the 1K speeds: ~2 min (90 s measured).
    expect(requestMsAt(131_072, 128, at1k) / 1000).toBeGreaterThan(90);
  });

  it('the ×4 grid: 1K, 4K, 16K, 64K, 200K, 256K', () => {
    expect(depthGrid(262_000, 4)).toEqual([1024, 4096, 16384, 65536, 204_800]);
    expect(depthGrid(262_144, 4)).toEqual([1024, 4096, 16384, 65536, 204_800, 262_144]);
    expect(sweepDepths(262_144, 128, { step: 4 })).toEqual([1024, 4096, 16384, 65536, 204_800, 262_000]);
  });

  it('200K is a step of both grids once the context reaches it (the doubling one too), never below', () => {
    expect(depthGrid(204_799)).toEqual([1024, 4096, 8192, 16384, 32768, 65536, 131_072]);
    expect(depthGrid(204_800)).toEqual([1024, 4096, 8192, 16384, 32768, 65536, 131_072, 204_800]);
    expect(sweepDepths(524_288, 128)).toEqual([1024, 4096, 8192, 16384, 32768, 65536, 131_072, 204_800, 262_144, 524_144]);
    // A 300K YaRN launch: every step up to its own maximum.
    expect(sweepDepths(307_200, 128, { step: 4 })).toEqual([1024, 4096, 16384, 65536, 204_800, 262_144, 307_056]);
    expect(nominalDepth(204_800)).toBe(204_800);
  });
});
