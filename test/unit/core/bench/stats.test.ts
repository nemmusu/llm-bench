import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { mean, percentile, summarize } from '../../../../src/core/bench/stats';

describe('percentile', () => {
  it('interpolates linearly between ranks (numpy default)', () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([10, 20, 30, 40, 50], 95)).toBeCloseTo(48);
    expect(percentile([3, 1, 2], 0)).toBe(1);
    expect(percentile([3, 1, 2], 100)).toBe(3);
  });
  it('clamps p, ignores non-finite values, returns 0 when empty', () => {
    expect(percentile([1, 2], 150)).toBe(2);
    expect(percentile([1, 2], -5)).toBe(1);
    expect(percentile([NaN, 5, Infinity], 50)).toBe(5);
    expect(percentile([], 50)).toBe(0);
  });
  it('property: stays within [min, max] and is monotonic in p', () => {
    fc.assert(
      fc.property(fc.array(fc.double({ min: -1e6, max: 1e6, noNaN: true }), { minLength: 1 }), fc.double({ min: 0, max: 100, noNaN: true }), fc.double({ min: 0, max: 100, noNaN: true }), (xs, p1, p2) => {
        const lo = Math.min(...xs);
        const hi = Math.max(...xs);
        const a = percentile(xs, Math.min(p1, p2));
        const b = percentile(xs, Math.max(p1, p2));
        expect(a).toBeGreaterThanOrEqual(lo - 1e-9);
        expect(b).toBeLessThanOrEqual(hi + 1e-9);
        expect(a).toBeLessThanOrEqual(b + 1e-9);
      }),
    );
  });
});

describe('summarize', () => {
  it('computes sample statistics', () => {
    const s = summarize([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(s.n).toBe(8);
    expect(s.mean).toBe(5);
    expect(s.median).toBe(4.5);
    expect(s.min).toBe(2);
    expect(s.max).toBe(9);
    expect(s.stddev).toBeCloseTo(2.138, 3);
    expect(s.cv).toBeCloseTo(0.4276, 3);
    expect(s.values).toEqual([2, 4, 4, 4, 5, 5, 7, 9]);
  });
  it('handles n = 0, n = 1, zero mean and non-finite values', () => {
    expect(summarize([])).toEqual({ n: 0, median: 0, mean: 0, min: 0, max: 0, stddev: 0, cv: 0, values: [] });
    expect(summarize([7])).toMatchObject({ n: 1, median: 7, stddev: 0, cv: 0 });
    expect(summarize([-1, 1]).cv).toBe(0);
    expect(summarize([1, NaN, 3]).n).toBe(2);
  });
  it('does not overflow the stack on large inputs', () => {
    const s = summarize(Array.from({ length: 300_000 }, (_, i) => i));
    expect(s.max).toBe(299_999);
    expect(s.min).toBe(0);
  });
  it('property: min ≤ median ≤ max, stddev ≥ 0', () => {
    fc.assert(
      fc.property(fc.array(fc.double({ min: -1e6, max: 1e6, noNaN: true }), { minLength: 1, maxLength: 50 }), (xs) => {
        const s = summarize(xs);
        expect(s.min).toBeLessThanOrEqual(s.median + 1e-9);
        expect(s.median).toBeLessThanOrEqual(s.max + 1e-9);
        expect(s.stddev).toBeGreaterThanOrEqual(0);
        expect(s.n).toBe(xs.length);
      }),
    );
  });
});

describe('mean', () => {
  it('averages finite values, undefined when none', () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(mean([NaN])).toBeUndefined();
  });
});
