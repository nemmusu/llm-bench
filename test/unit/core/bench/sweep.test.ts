import { describe, expect, it } from 'vitest';
import { nominalDepth } from '../../../../src/contract/results';
import { CONTEXT_MARGIN, depthGrid, expectedMs, maxDepth, prefillRate, runSweep, sweepDepths } from '../../../../src/core/bench/sweep';
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
    expect(expectedMs(16384, last, { outputTokens: 0, reps: 2 })).toBeCloseTo(2 * 4000 * 2, 6);
    expect(prefillRate(point(1, 1, { prefill: 777, engine: true }))).toBe(777);
  });
});
