/**
 * "Contesto per gradi": which context depths to measure and how to run them on one loaded engine.
 * Shared by the context-sweep step of normal runs and by the tuner, so their numbers compare.
 */
import type { LatencyPoint } from '../../contract/results';

/** Tokens kept free in the context besides prompt + output (BOS, server-side extras). */
export const CONTEXT_MARGIN = 16;
/** The grid: 1K, 4K, then doubling (8K, 16K, 32K, 64K…). */
export const FIRST_DEPTHS = [1024, 4096] as const;
/** Share of the context used for the optional 25/50/75/100 % points. */
export const DEPTH_FRACTIONS = [0.25, 0.5, 0.75, 1] as const;

/** Deepest prompt a context of `ctx` tokens can take with `outputTokens` to generate. */
export function maxDepth(ctx: number, outputTokens: number): number {
  return ctx - outputTokens - CONTEXT_MARGIN;
}

/** 1K, 4K, 8K, 16K… up to `limit` (inclusive). */
export function depthGrid(limit: number): number[] {
  const out: number[] = [];
  for (const d of FIRST_DEPTHS) if (d <= limit) out.push(d);
  for (let d = 8192; d <= limit; d *= 2) out.push(d);
  return out;
}

/**
 * Depths of a sweep on a context of `ctx` tokens: the grid up to the deepest prompt that fits, that
 * exact maximum, and optionally 25/50/75/100 % of the context (each clamped to the maximum).
 * Ascending, without duplicates; empty when not even one token of prompt fits.
 */
export function sweepDepths(ctx: number, outputTokens: number, opts: { fractions?: boolean } = {}): number[] {
  const max = maxDepth(ctx, outputTokens);
  if (max < 1) return [];
  const all = [...depthGrid(max), max];
  if (opts.fractions) for (const f of DEPTH_FRACTIONS) all.push(Math.max(1, Math.min(max, Math.round(ctx * f))));
  return [...new Set(all)].sort((a, b) => a - b);
}

export interface SweepRun {
  points: LatencyPoint[];
  /** First depth not measured because the time budget was spent (undefined = all measured). */
  skippedFrom?: number;
  /** A point's check asked to stop (e.g. the tuner saw a spill). */
  stopped?: boolean;
}

export interface SweepOptions {
  outputTokens: number;
  reps: number;
  /** Monotonic ms (Clock.now). */
  now: () => number;
  /** Time budget for the whole sweep; a depth that would not fit in what is left is skipped with the deeper ones. */
  maxMs?: number;
  /** Called after each point; false stops the sweep. */
  onPoint?: (p: LatencyPoint) => boolean;
}

/** Prompt reading speed of a point: the engine's figure when it reports one. */
export function prefillRate(p: LatencyPoint): number {
  return (p.prefillTpsEngine ?? p.prefillTps).median;
}

/**
 * Expected ms of one depth from the last point: prompt at the last reading speed (slowed in
 * proportion to the extra depth, attention grows with it) plus the answer at the last generation speed.
 */
export function expectedMs(depth: number, last: LatencyPoint, o: Pick<SweepOptions, 'outputTokens' | 'reps'>): number {
  const read = Math.max(1, prefillRate(last));
  const write = Math.max(0.1, last.decodeTps.median);
  const slowdown = Math.max(1, depth / Math.max(1, last.promptTokens));
  return o.reps * ((depth / read) * 1000 * Math.sqrt(slowdown) + (o.outputTokens / write) * 1000);
}

/** Measures `depths` in order (shallow first) with `measure`, within the optional time budget. */
export async function runSweep(depths: readonly number[], measure: (depth: number) => Promise<LatencyPoint>, o: SweepOptions): Promise<SweepRun> {
  const start = o.now();
  const points: LatencyPoint[] = [];
  for (const depth of depths) {
    const last = points[points.length - 1];
    if (o.maxMs !== undefined && last && o.now() - start + expectedMs(depth, last, o) > o.maxMs) return { points, skippedFrom: depth };
    const p = await measure(depth);
    points.push(p);
    if (o.onPoint && !o.onPoint(p)) return { points, stopped: true };
  }
  return { points };
}
