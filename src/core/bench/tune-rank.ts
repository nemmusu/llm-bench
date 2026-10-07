/**
 * Ranking rules of "Trova le impostazioni migliori", by measured numbers only. Two numbers count as
 * tied when they differ by less than max(2 %, 2 × the larger coefficient of variation of their
 * repetitions): a tie passes the decision to the next criterion, so noise never picks a winner.
 *
 *   at a depth: higher generation speed → higher prompt reading speed → lower time to first token →
 *   more precise KV cache → the earlier (cheaper, default) configuration.
 */
import { nominalDepth, type LatencyPoint, type Stat, type TuneCombination, type TuneKvType } from '../../contract/results';

/** Smallest relative difference that is never noise. */
export const TIE_MIN = 0.02;
/** Differences below this many coefficients of variation are noise. */
export const TIE_CV = 2;

/** f16 / auto are the most precise, then the 8-bit caches, then q4_0. */
export function kvPrecisionRank(kv: TuneKvType): number {
  if (kv === 'f16' || kv === 'auto') return 0;
  if (kv === 'q8_0' || kv === 'fp8') return 1;
  return 2;
}

/** True when the two medians are within the noise of their repetitions. */
export function tied(a: Stat, b: Stat): boolean {
  const scale = Math.max(Math.abs(a.median), Math.abs(b.median));
  if (scale === 0) return true;
  return Math.abs(a.median - b.median) / scale < Math.max(TIE_MIN, TIE_CV * Math.max(a.cv, b.cv));
}

const prefill = (p: LatencyPoint): Stat => p.prefillTpsEngine ?? p.prefillTps;

/** > 0 when `a` is better than `b` at the same depth, < 0 when worse, 0 when tied on every number. */
export function comparePoints(a: LatencyPoint, b: LatencyPoint): number {
  if (!tied(a.decodeTps, b.decodeTps)) return a.decodeTps.median - b.decodeTps.median;
  if (!tied(prefill(a), prefill(b))) return prefill(a).median - prefill(b).median;
  if (!tied(a.ttftMs, b.ttftMs)) return b.ttftMs.median - a.ttftMs.median;
  return 0;
}

/**
 * Coordinate descent: is the candidate's screening better than the current best's? The deepest
 * points decide first (that is where the context goal is), then the shallow ones; a full tie keeps
 * the current value.
 */
export function screenBetter(candidate: readonly LatencyPoint[], best: readonly LatencyPoint[]): boolean {
  const deep = (ps: readonly LatencyPoint[]) => ps[ps.length - 1] as LatencyPoint;
  const byDeep = comparePoints(deep(candidate), deep(best));
  if (byDeep !== 0) return byDeep > 0;
  return comparePoints(candidate[0] as LatencyPoint, best[0] as LatencyPoint) > 0;
}

/** The point of a sweep at a nominal depth (see nominalDepth), if it reached it. */
export function pointAt(sweep: readonly LatencyPoint[], depth: number): LatencyPoint | undefined {
  return sweep.find((p) => nominalDepth(p.promptTokens) === depth);
}

/** Index of the best combination among `candidates` at `depth` (all must have a point there). */
function bestAt(combos: readonly TuneCombination[], candidates: readonly number[], depth: number): number {
  let best = candidates[0] as number;
  for (const i of candidates.slice(1)) {
    const a = combos[i] as TuneCombination;
    const b = combos[best] as TuneCombination;
    const c = comparePoints(pointAt(a.sweep, depth) as LatencyPoint, pointAt(b.sweep, depth) as LatencyPoint) || kvPrecisionRank(b.kvType) - kvPrecisionRank(a.kvType);
    if (c > 0) best = i;
  }
  return best;
}

/** Nominal depths measured by at least one combination, ascending. */
export function measuredDepths(combos: readonly TuneCombination[]): number[] {
  const all = combos.filter((c) => c.outcome === 'ok').flatMap((c) => c.sweep.map((p) => nominalDepth(p.promptTokens)));
  return [...new Set(all)].sort((a, b) => a - b);
}

/** At every measured depth, the fastest combination (only fitting combinations with a point there). */
export function fastestByDepth(combos: readonly TuneCombination[]): { depth: number; combination: number }[] {
  return measuredDepths(combos).map((depth) => {
    const candidates = combos.map((c, i) => (c.outcome === 'ok' && pointAt(c.sweep, depth) ? i : -1)).filter((i) => i >= 0);
    return { depth, combination: bestAt(combos, candidates, depth) };
  });
}

/**
 * The default configuration: among the fitting combinations that reach the largest context, the
 * fastest at its deepest measured point. Undefined when no combination was measured.
 */
export function recommendedCombination(combos: readonly TuneCombination[]): number | undefined {
  const ok = combos.map((c, i) => (c.outcome === 'ok' && c.sweep.length > 0 ? i : -1)).filter((i) => i >= 0);
  if (ok.length === 0) return undefined;
  const largest = Math.max(...ok.map((i) => (combos[i] as TuneCombination).maxContext));
  const top = ok.filter((i) => (combos[i] as TuneCombination).maxContext === largest);
  // Same context: their deepest points are the same nominal depth, unless a sweep was cut short.
  const deepest = Math.min(...top.map((i) => nominalDepth((combos[i] as TuneCombination).sweep.at(-1)!.promptTokens)));
  return bestAt(combos, top, deepest);
}
