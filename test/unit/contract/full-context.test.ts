import { describe, expect, it } from 'vitest';
import { fillsContext, FULL_CONTEXT_SHARE, fullContextPoint, tuningSchema, type LatencyPoint } from '../../../src/contract/results';

const stat = (v: number) => ({ n: 2, median: v, mean: v, min: v, max: v, stddev: 0, cv: 0, values: [v, v] });
const point = (promptTokens: number): LatencyPoint => ({ promptTokens, outputTokens: 128, ttftMs: stat(100), prefillTps: stat(3000), decodeTps: stat(80) }) as LatencyPoint;

describe('the context full (every speed of a tune combination is read there)', () => {
  it('the deepest prompt of a sweep fills its context, a grid point below it does not', () => {
    expect(FULL_CONTEXT_SHARE).toBe(0.9);
    expect(fillsContext(262_000, 262_144)).toBe(true);
    // A text prompt refused as too long and sent again a few percent shorter still fills it.
    expect(fillsContext(255_000, 262_144)).toBe(true);
    expect(fillsContext(204_800, 262_144)).toBe(false);
    expect(fillsContext(65_392, 65_536)).toBe(true);
    expect(fillsContext(65_536, 262_144)).toBe(false);
    expect(fillsContext(100, 0)).toBe(false);
  });

  it("a combination's full-context point is its deepest one, when that fills the context", () => {
    expect(fullContextPoint({ maxContext: 262_144, sweep: [point(1024), point(262_000), point(65_536)] })?.promptTokens).toBe(262_000);
    // Cut by the time limit at 64K: not measured with the context full.
    expect(fullContextPoint({ maxContext: 262_144, sweep: [point(1024), point(65_536)] })).toBeUndefined();
    expect(fullContextPoint({ maxContext: 65_536, sweep: [] })).toBeUndefined();
  });

  it('a search records the start time it expected', () => {
    const t = tuningSchema.parse({ budget: 'fast', maxLaunches: 24, expectedLoadSeconds: 15 });
    expect(t.expectedLoadSeconds).toBe(15);
    expect(tuningSchema.safeParse({ budget: 'fast', maxLaunches: 24, expectedLoadSeconds: -1 }).success).toBe(false);
  });
});
