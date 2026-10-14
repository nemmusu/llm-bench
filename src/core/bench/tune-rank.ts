/**
 * Ranking rules of "Trova le impostazioni migliori", by measured numbers only. Two numbers count as
 * tied when they differ by less than max(2 %, 2 × the larger coefficient of variation of their
 * repetitions): a tie passes the decision to the next criterion, so noise never picks a winner.
 *
 *   goal 'single', at a depth: higher generation speed → higher prompt reading speed → lower time to
 *   first token → more precise KV cache → the earlier (cheaper, default) configuration. The
 *   recommendation is read with the largest context full (the depth every view shows).
 *   goal 'multi', with all N users busy: fewer failed requests → higher per-user generation speed (p50)
 *   → higher total tok/s → lower TTFT p95 → lower TTFT of the later messages (cache reuse) → more
 *   precise KV cache → the earlier configuration.
 */
import {
  fullContextPoint,
  nominalDepth,
  type ConcurrencyPoint,
  type LatencyPoint,
  type SessionsPoint,
  type Stat,
  type TuneCombination,
  type TuneKvType,
  type TuneRecheck,
  type Tuning,
} from '../../contract/results';

/** Smallest relative difference that is never noise. */
export const TIE_MIN = 0.02;
/** Differences below this many coefficients of variation are noise. */
export const TIE_CV = 2;
/** Tail numbers (p95 of a handful of requests) are noisier: never decided below this difference. */
export const TIE_TAIL = 0.1;

/** f16 / auto / bf16 are the most precise, then the 8-bit caches, then K 8-bit with V 4-bit, then the 4-bit ones. */
export function kvPrecisionRank(kv: TuneKvType): number {
  if (kv === 'f16' || kv === 'auto' || kv === 'bf16') return 0;
  if (kv === 'q8_0' || kv === 'fp8' || kv === 'int8') return 1;
  if (kv === 'k8v4' || kv === 'rk8v4') return 1.5;
  return 2;
}

/** Two plain numbers are tied within max(floor, TIE_CV × cv) of the larger one. */
export function tiedValues(a: number, b: number, cv = 0, floor = TIE_MIN): boolean {
  const scale = Math.max(Math.abs(a), Math.abs(b));
  if (scale === 0) return true;
  return Math.abs(a - b) / scale < Math.max(floor, TIE_CV * cv);
}

/** True when the two medians are within the noise of their repetitions. */
export function tied(a: Stat, b: Stat): boolean {
  return tiedValues(a.median, b.median, Math.max(a.cv, b.cv));
}

const prefill = (p: LatencyPoint): Stat => p.prefillTpsEngine ?? p.prefillTps;

/** > 0 when `a` is better than `b` at the same depth, < 0 when worse, 0 when tied on every number. */
export function comparePoints(a: LatencyPoint, b: LatencyPoint): number {
  if (!tied(a.decodeTps, b.decodeTps)) return a.decodeTps.median - b.decodeTps.median;
  if (!tied(prefill(a), prefill(b))) return prefill(a).median - prefill(b).median;
  if (!tied(a.ttftMs, b.ttftMs)) return b.ttftMs.median - a.ttftMs.median;
  return 0;
}

/** Nominal depths both lists measured, deepest first. */
function sharedDepths(a: readonly LatencyPoint[], b: readonly LatencyPoint[]): number[] {
  const mine = new Set(a.map((p) => nominalDepth(p.promptTokens)));
  return [...new Set(b.map((p) => nominalDepth(p.promptTokens)))].filter((d) => mine.has(d)).sort((x, y) => y - x);
}

/**
 * Coordinate descent: is the candidate's screening better than the current best's? Both were screened
 * at the same context; compared depth by depth on the depths both measured (a screening cut by the time
 * limit has fewer), the deepest first (that is where the context goal is, and prompt reading dominates
 * there), then the shallower ones in turn; a full tie keeps the current value.
 */
export function screenBetter(candidate: readonly LatencyPoint[], best: readonly LatencyPoint[]): boolean {
  for (const d of sharedDepths(candidate, best)) {
    const c = comparePoints(pointAt(candidate, d) as LatencyPoint, pointAt(best, d) as LatencyPoint);
    if (c !== 0) return c > 0;
  }
  return false;
}

/** The point of a sweep at a nominal depth (see nominalDepth), if it reached it. */
export function pointAt(sweep: readonly LatencyPoint[], depth: number): LatencyPoint | undefined {
  return sweep.find((p) => nominalDepth(p.promptTokens) === depth);
}

/** Index of the best combination among `candidates` by the point `at` picks in each (all must have one). */
function bestBy(combos: readonly TuneCombination[], candidates: readonly number[], at: (c: TuneCombination) => LatencyPoint | undefined): number {
  let best = candidates[0] as number;
  for (const i of candidates.slice(1)) {
    const a = combos[i] as TuneCombination;
    const b = combos[best] as TuneCombination;
    const c = comparePoints(at(a) as LatencyPoint, at(b) as LatencyPoint) || kvPrecisionRank(b.kvType) - kvPrecisionRank(a.kvType);
    if (c > 0) best = i;
  }
  return best;
}

/** Index of the best combination among `candidates` at `depth` (all must have a point there). */
function bestAt(combos: readonly TuneCombination[], candidates: readonly number[], depth: number): number {
  return bestBy(combos, candidates, (c) => pointAt(c.sweep, depth));
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
 * fastest with that context full (fullContextPoint: the number every view shows; a combination
 * "misurata in parte" that never got there is left out when another did); when none got there, the
 * fastest at the deepest point they all measured. Undefined when no combination was measured.
 * `exclude`: a combination left out (the runner-up is the best of the others).
 */
export function recommendedCombination(combos: readonly TuneCombination[], exclude?: number): number | undefined {
  const ok = combos.map((c, i) => (c.outcome === 'ok' && c.sweep.length > 0 && i !== exclude ? i : -1)).filter((i) => i >= 0);
  if (ok.length === 0) return undefined;
  const largest = Math.max(...ok.map((i) => (combos[i] as TuneCombination).maxContext));
  const top = ok.filter((i) => (combos[i] as TuneCombination).maxContext === largest);
  const full = top.filter((i) => fullContextPoint(combos[i] as TuneCombination) !== undefined);
  if (full.length > 0) return bestBy(combos, full, fullContextPoint);
  const sets = top.map((i) => new Set((combos[i] as TuneCombination).sweep.map((p) => nominalDepth(p.promptTokens))));
  const deepest = Math.max(...[...(sets[0] as Set<number>)].filter((d) => sets.every((s) => s.has(d))));
  // Nothing measured by all of them (one only has its 1K check, another a sweep that started deeper): the more precise cache, then the earlier one.
  if (!Number.isFinite(deepest)) return [...top].sort((a, b) => kvPrecisionRank((combos[a] as TuneCombination).kvType) - kvPrecisionRank((combos[b] as TuneCombination).kvType) || a - b)[0];
  return bestAt(combos, top, deepest);
}

// ---- goal 'multi' --------------------------------------------------------------------------------

/** What one launch measured with `users` users at once: the concurrency level and the conversations. */
export interface UsersMeasure {
  point: ConcurrencyPoint;
  sessions?: SessionsPoint | undefined;
}

/** Per-user generation speed of a level as a statistic (its spread is the noise); old points only had the p50. */
export function perUserStat(p: ConcurrencyPoint): Stat {
  if (p.perRequestDecodeTps && p.perRequestDecodeTps.n > 0) return p.perRequestDecodeTps;
  const v = p.perRequestDecodeTpsP50;
  return { n: 1, median: v, mean: v, min: v, max: v, stddev: 0, cv: 0, values: [v] };
}

/**
 * Noise of a per-user median: its values are different users, not repetitions, so their spread is
 * partly real (the first user reads its prompt alone); the median's own noise is that spread over the
 * square root of the users.
 */
export function usersNoise(s: Stat): number {
  return s.n > 1 ? s.cv / Math.sqrt(s.n) : s.cv;
}

/** The point of a level, if measured. */
export function levelPoint(points: readonly ConcurrencyPoint[] | undefined, level: number): ConcurrencyPoint | undefined {
  return points?.find((p) => p.level === level);
}

/** > 0 when `a` serves its users better than `b` (same users, same prompts), < 0 when worse, 0 when tied. */
export function compareUsers(a: UsersMeasure, b: UsersMeasure): number {
  if (a.point.errors !== b.point.errors) return b.point.errors - a.point.errors;
  const ua = perUserStat(a.point);
  const ub = perUserStat(b.point);
  // Totals and tails have no repetitions of their own: the per-user noise stands for theirs too.
  const cv = Math.max(usersNoise(ua), usersNoise(ub));
  if (!tiedValues(ua.median, ub.median, cv)) return ua.median - ub.median;
  if (!tiedValues(a.point.aggregateTps, b.point.aggregateTps, cv)) return a.point.aggregateTps - b.point.aggregateTps;
  if (!tiedValues(a.point.ttftP95Ms, b.point.ttftP95Ms, cv, TIE_TAIL)) return b.point.ttftP95Ms - a.point.ttftP95Ms;
  const la = a.sessions?.laterTurns?.ttftMs;
  const lb = b.sessions?.laterTurns?.ttftMs;
  if (la && lb && la.n > 0 && lb.n > 0 && !tied(la, lb)) return lb.median - la.median;
  return 0;
}

const measureOf = (c: TuneCombination, users: number): UsersMeasure | undefined => {
  const point = levelPoint(c.concurrency, users);
  return point ? { point, sessions: c.sessions?.find((s) => s.sessions === users) ?? c.sessions?.[0] } : undefined;
};

/**
 * Goal 'multi': the combination that serves `users` users best (compareUsers, then the more precise
 * KV cache, then the earlier one). Undefined when none was measured at that level.
 */
export function recommendedForUsers(combos: readonly TuneCombination[], users: number, exclude?: number): number | undefined {
  let best: number | undefined;
  combos.forEach((c, i) => {
    if (c.outcome !== 'ok' || i === exclude || !measureOf(c, users)) return;
    if (best === undefined) {
      best = i;
      return;
    }
    const b = combos[best] as TuneCombination;
    const cmp = compareUsers(measureOf(c, users) as UsersMeasure, measureOf(b, users) as UsersMeasure) || kvPrecisionRank(b.kvType) - kvPrecisionRank(c.kvType);
    if (cmp > 0) best = i;
  });
  return best;
}

/** The users level a 'multi' tuning measured its combinations at (the most that fit, or the users asked). */
export function usersOf(t: Pick<Tuning, 'multi'>): number | undefined {
  return t.multi ? (t.multi.fittingUsers ?? t.multi.users) : undefined;
}

/** The second best combination of a finished tuning by its own goal's rule, if any. */
export function runnerUp(t: Tuning): number | undefined {
  if (t.recommended === undefined) return undefined;
  const users = usersOf(t);
  return users !== undefined ? recommendedForUsers(t.combinations, users, t.recommended) : recommendedCombination(t.combinations, t.recommended);
}

/** The most users (from 1, in order) served without a failed request. */
export function usersWithoutErrors(points: readonly ConcurrencyPoint[]): number {
  let n = 0;
  for (const p of [...points].sort((a, b) => a.level - b.level)) {
    if (p.errors > 0 || p.level !== n + 1) break;
    n = p.level;
  }
  return n;
}

// ---- "Ricontrollo rapido" -----------------------------------------------------------------------

type Moved = TuneRecheck['checks'][number]['moved'];

/** Depth by depth (nominal), the numbers of `now` that moved beyond noise against `before`. */
export function movedPoints(before: readonly LatencyPoint[], now: readonly LatencyPoint[]): Moved {
  const out: Moved = [];
  for (const p of now) {
    const at = nominalDepth(p.promptTokens);
    const q = pointAt(before, at);
    if (!q) continue;
    if (!tied(q.decodeTps, p.decodeTps)) out.push({ at, metric: 'decode', before: q.decodeTps.median, after: p.decodeTps.median });
    if (!tied(prefill(q), prefill(p))) out.push({ at, metric: 'prefill', before: prefill(q).median, after: prefill(p).median });
    if (!tied(q.ttftMs, p.ttftMs)) out.push({ at, metric: 'ttft', before: q.ttftMs.median, after: p.ttftMs.median });
  }
  return out;
}

/** Level by level, the numbers of `now` that moved beyond noise against `before`. */
export function movedLevels(before: readonly ConcurrencyPoint[], now: readonly ConcurrencyPoint[]): Moved {
  const out: Moved = [];
  for (const p of now) {
    const q = levelPoint(before, p.level);
    if (!q) continue;
    const a = perUserStat(q);
    const b = perUserStat(p);
    const cv = Math.max(usersNoise(a), usersNoise(b));
    if (!tiedValues(a.median, b.median, cv)) out.push({ at: p.level, metric: 'perUserDecode', before: a.median, after: b.median });
    if (!tiedValues(q.aggregateTps, p.aggregateTps, cv)) out.push({ at: p.level, metric: 'aggregate', before: q.aggregateTps, after: p.aggregateTps });
    if (!tiedValues(q.ttftP95Ms, p.ttftP95Ms, cv, TIE_TAIL)) out.push({ at: p.level, metric: 'ttftP95', before: q.ttftP95Ms, after: p.ttftP95Ms });
  }
  return out;
}
