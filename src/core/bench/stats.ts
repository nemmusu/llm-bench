import type { Stat } from '../../contract/results';

function finite(values: readonly number[]): number[] {
  return values.filter((v) => Number.isFinite(v));
}

/**
 * Percentile with linear interpolation between closest ranks (the "type 7" definition used by
 * numpy and Excel PERCENTILE.INC). `p` is 0..100 and is clamped. Non-finite values are ignored.
 * Returns 0 for an empty input: results are stored as JSON, where NaN cannot be represented, and
 * callers always store `n` next to it.
 */
export function percentile(values: readonly number[], p: number): number {
  const sorted = finite(values).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (b - a) * (rank - lo);
}

/**
 * Summary of repeated measurements. Uses the sample standard deviation (n − 1), and
 * cv = stddev / |mean| (0 when the mean is 0). Non-finite values (a failed repetition) are
 * dropped. n = 0 gives an all-zero Stat; n = 1 gives stddev = cv = 0.
 */
export function summarize(values: readonly number[]): Stat {
  const v = finite(values);
  const n = v.length;
  if (n === 0) return { n: 0, median: 0, mean: 0, min: 0, max: 0, stddev: 0, cv: 0, values: [] };
  const mean = v.reduce((s, x) => s + x, 0) / n;
  const variance = n > 1 ? v.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1) : 0;
  const stddev = Math.sqrt(variance);
  return {
    n,
    median: percentile(v, 50),
    mean,
    // reduce, not Math.min(...v): spreading a huge array overflows the stack.
    min: v.reduce((m, x) => (x < m ? x : m)),
    max: v.reduce((m, x) => (x > m ? x : m)),
    stddev,
    cv: mean !== 0 ? stddev / Math.abs(mean) : 0,
    values: v,
  };
}

/** Arithmetic mean of the finite values, undefined when there are none. */
export function mean(values: readonly number[]): number | undefined {
  const v = finite(values);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : undefined;
}
