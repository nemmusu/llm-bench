/**
 * "Contesto per gradi": which context depths to measure and how to run them on one loaded engine.
 * Shared by the context-sweep step of normal runs and by the tuner, so their numbers compare.
 */
import type { LatencyPoint } from '../../contract/results';

/** Tokens kept free in the context besides prompt + output (BOS, server-side extras). */
export const CONTEXT_MARGIN = 16;
/** The grid: 1K, 4K, then doubling (8K, 16K, 32K, 64K…), or ×4 (16K, 64K, 256K…) for long contexts. */
export const FIRST_DEPTHS = [1024, 4096] as const;
/** Share of the context used for the optional 25/50/75/100 % points. */
export const DEPTH_FRACTIONS = [0.25, 0.5, 0.75, 1] as const;

/** How the grid grows after 4K: doubling, or ×4 (fewer deep points: "Veloce" on long contexts). */
export type GridStep = 2 | 4;

/** Deepest prompt a context of `ctx` tokens can take with `outputTokens` to generate. */
export function maxDepth(ctx: number, outputTokens: number): number {
  return ctx - outputTokens - CONTEXT_MARGIN;
}

/** 1K, 4K, then ×`step` (8K, 16K… or 16K, 64K…) up to `limit` (inclusive). */
export function depthGrid(limit: number, step: GridStep = 2): number[] {
  const out: number[] = [];
  for (const d of FIRST_DEPTHS) if (d <= limit) out.push(d);
  for (let d = 4096 * step; d <= limit; d *= step) out.push(d);
  return out;
}

/**
 * Depths of a sweep on a context of `ctx` tokens: the grid up to the deepest prompt that fits, that
 * exact maximum, and optionally 25/50/75/100 % of the context (each clamped to the maximum).
 * Ascending, without duplicates; empty when not even one token of prompt fits.
 */
export function sweepDepths(ctx: number, outputTokens: number, opts: { fractions?: boolean; step?: GridStep } = {}): number[] {
  const max = maxDepth(ctx, outputTokens);
  if (max < 1) return [];
  const all = [...depthGrid(max, opts.step), max];
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
 * Attention grows with the context: prompt reading is about half as fast at this depth as on a short
 * prompt, generation at the second one (an RTX 5090 with a 27B model read 1 810 tok/s at 1K, 1 450 at
 * 128K and 875 at 256K; generated 55.9, 40.2 and 27.9 tok/s).
 */
export const PREFILL_HALF_DEPTH = 131_072;
export const DECODE_HALF_DEPTH = 262_144;

/** Speeds measured at one depth, from which the time of a request at another depth is predicted. */
export interface SpeedAnchor {
  depth: number;
  prefillTps: number;
  decodeTps: number;
}

export function anchorOf(p: LatencyPoint): SpeedAnchor {
  return { depth: p.promptTokens, prefillTps: prefillRate(p), decodeTps: p.decodeTps.median };
}

/** A speed measured at `from` tokens, moved to `to` tokens: rate × (1 + from / half) / (1 + to / half). */
export function rateAt(rate: number, from: number, to: number, half: number): number {
  return (rate * (1 + from / half)) / (1 + to / half);
}

/** Expected ms of one request of `depth` prompt tokens and `outputTokens` answer tokens, from an anchor. */
export function requestMsAt(depth: number, outputTokens: number, a: SpeedAnchor): number {
  const read = Math.max(1, rateAt(a.prefillTps, a.depth, depth, PREFILL_HALF_DEPTH));
  const write = Math.max(0.1, rateAt(a.decodeTps, a.depth, depth, DECODE_HALF_DEPTH));
  return (depth / read) * 1000 + (outputTokens / write) * 1000;
}

/** Expected ms of one depth (all its repetitions) from the last point measured. */
export function expectedMs(depth: number, last: LatencyPoint, o: Pick<SweepOptions, 'outputTokens' | 'reps'>): number {
  return o.reps * requestMsAt(depth, o.outputTokens, anchorOf(last));
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
