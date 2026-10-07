/**
 * "Trova le impostazioni migliori": the pure comparison logic behind the result and live screens.
 * Good performance = the highest number measured among the launch combinations of this run: no
 * absolute thresholds. Differences within the measurement noise count as ties.
 */
import { nominalDepth, type ConcurrencyPoint, type LatencyPoint, type SessionsPoint, type Stat, type TuneAttempt, type TuneCombination, type TuneKvType, type Tuning } from '../../../contract/results';
import { prefillStat } from '../bench/format';

/** More precise KV cache first (ties go to the more precise one). */
export const KV_PRECISION: Record<TuneKvType, number> = { f16: 0, auto: 0, q8_0: 1, fp8: 1, q4_0: 2 };

/** Smallest relative difference that is never noise (the core's ranking rule). */
export const TIE_MIN = 0.02;
/** Differences below this many coefficients of variation are noise. */
export const TIE_CV = 2;
/** Tail numbers (p95 of a handful of requests) are noisier: never decided below this difference (the core's rule). */
export const TIE_TAIL = 0.1;

/**
 * Equal within the noise, the same rule as the core: closer than max(floor, 2 × the larger CV) of the
 * larger median (floor 2 %, 10 % for tail numbers).
 */
export function sameWithinNoise(a: Stat, b: Stat, floor = TIE_MIN): boolean {
  const scale = Math.max(Math.abs(a.median), Math.abs(b.median));
  if (scale === 0) return true;
  return Math.abs(a.median - b.median) / scale < Math.max(floor, TIE_CV * Math.max(a.cv, b.cv));
}

/** The sweep point of a combination at this grid depth (a 32K context's deepest prompt counts as 32K). */
export function pointAt(combo: Pick<TuneCombination, 'sweep'>, depth: number): LatencyPoint | undefined {
  return combo.sweep.find((p) => nominalDepth(p.promptTokens) === depth);
}

/** The deepest point a combination measured. */
export function deepestPoint(combo: Pick<TuneCombination, 'sweep'>): LatencyPoint | undefined {
  return combo.sweep.reduce<LatencyPoint | undefined>((best, p) => (best === undefined || p.promptTokens > best.promptTokens ? p : best), undefined);
}

interface Contender {
  index: number;
  kvType: TuneKvType;
  point: LatencyPoint;
}

/**
 * Ranking order at one depth (the core's rule): higher generation speed; on a tie higher prompt
 * reading, then lower time to first token, then the more precise cache, then the earlier (cheaper,
 * default) configuration. Negative = `a` ranks first.
 */
export function compareContenders(a: Contender, b: Contender): number {
  const pa = a.point;
  const pb = b.point;
  if (!sameWithinNoise(pa.decodeTps, pb.decodeTps)) return pb.decodeTps.median - pa.decodeTps.median;
  if (!sameWithinNoise(prefillStat(pa), prefillStat(pb))) return prefillStat(pb).median - prefillStat(pa).median;
  if (!sameWithinNoise(pa.ttftMs, pb.ttftMs)) return pa.ttftMs.median - pb.ttftMs.median;
  return KV_PRECISION[a.kvType] - KV_PRECISION[b.kvType] || a.index - b.index;
}

/** The grid depth of a combination's deepest point ("32K" for 32 624 tokens). */
export function reachOf(combo: Pick<TuneCombination, 'sweep'>): number {
  return nominalDepth(deepestPoint(combo)!.promptTokens);
}

/** Combinations that loaded and were measured (the ones the ranking is about). */
export function measuredCombinations(tuning: Pick<Tuning, 'combinations'>): number[] {
  return tuning.combinations.flatMap((c, i) => (c.outcome === 'ok' && c.sweep.length > 0 ? [i] : []));
}

export interface RankRow {
  index: number;
  combo: TuneCombination;
  /** The measurement at the compared depth; undefined when the combination does not reach it. */
  point?: LatencyPoint;
  /** 1-based position among those reaching the depth. */
  rank?: number;
  /** Its generation speed is within the noise of the row above: the order came from the tie-breaks. */
  tie?: boolean;
  /** Goal "Più utenti": the level with every user busy (instead of a depth point). */
  users?: ConcurrencyPoint;
  /** Goal "Più utenti": the conversations measured with that many users. */
  sessions?: SessionsPoint;
}

/** The row was measured where it is compared (at the depth, or with every user busy). */
export function reaches(r: Pick<RankRow, 'point' | 'users'>): boolean {
  return r.point !== undefined || r.users !== undefined;
}

/**
 * The ranking at one depth: combinations reaching it first (the core's winner at that depth on top,
 * then by {@link compareContenders}), then those stopping earlier, deepest first.
 */
export function rankAt(tuning: Pick<Tuning, 'combinations' | 'fastestByDepth'>, depth: number): RankRow[] {
  const ids = measuredCombinations(tuning);
  const winner = tuning.fastestByDepth.find((f) => f.depth === depth)?.combination;
  const reaching: Contender[] = [];
  const short: number[] = [];
  for (const i of ids) {
    const combo = tuning.combinations[i]!;
    const point = pointAt(combo, depth);
    if (point) reaching.push({ index: i, kvType: combo.kvType, point });
    else short.push(i);
  }
  reaching.sort((a, b) => (a.index === winner ? -1 : b.index === winner ? 1 : compareContenders(a, b)));
  const reach = (i: number) => reachOf(tuning.combinations[i]!);
  short.sort((a, b) => reach(b) - reach(a) || a - b);
  return [
    ...reaching.map((c, k) => ({
      index: c.index,
      combo: tuning.combinations[c.index]!,
      point: c.point,
      rank: k + 1,
      ...(k > 0 && sameWithinNoise(reaching[k - 1]!.point.decodeTps, c.point.decodeTps) ? { tie: true } : {}),
    })),
    ...short.map((i) => ({ index: i, combo: tuning.combinations[i]! })),
  ];
}

/** Depths of the "Confronta a" selector: measured by at least two combinations (by one, when there is only one). */
export function depthOptions(tuning: Pick<Tuning, 'combinations'>): number[] {
  const count = new Map<number, number>();
  for (const i of measuredCombinations(tuning)) {
    for (const d of new Set(tuning.combinations[i]!.sweep.map((p) => nominalDepth(p.promptTokens)))) count.set(d, (count.get(d) ?? 0) + 1);
  }
  const all = [...count.keys()].sort((a, b) => a - b);
  const shared = all.filter((d) => count.get(d)! >= 2);
  return shared.length ? shared : all;
}

/** Default compared depth: the deepest option every measured combination reached (else the shallowest option). */
export function defaultDepth(tuning: Pick<Tuning, 'combinations'>, options: readonly number[]): number | undefined {
  const ids = measuredCombinations(tuning);
  const common = options.filter((d) => ids.every((i) => pointAt(tuning.combinations[i]!, d) !== undefined));
  return common.length ? common[common.length - 1] : options[0];
}

export type SortDir = 'asc' | 'desc';

/**
 * A metric column of the ranking, as data: the table, its sorting and its "best value" highlight
 * are all built from a list of these (another goal can bring its own list).
 */
export interface MetricColumn {
  key: string;
  /** First sort direction when its header is clicked: the better values first. */
  dir: SortDir;
  value: (row: RankRow) => number | undefined;
  /** Measured at the compared depth: blank for combinations that stop earlier. */
  atDepth: boolean;
  /**
   * Highlight the best value (ties within the noise included): the statistic of a row (undefined = the
   * row has none), which way is better, and the smallest difference that is never noise (default 2 %).
   */
  best?: { stat: (row: RankRow) => Stat | undefined; higher: boolean; floor?: number };
}

/** "Trova le impostazioni migliori" for one user: context, generation, prompt reading, first token, memory. */
export const CONTEXT_COLUMNS: readonly MetricColumn[] = [
  { key: 'maxContext', dir: 'desc', atDepth: false, value: (r) => r.combo.maxContext },
  { key: 'decode', dir: 'desc', atDepth: true, value: (r) => r.point?.decodeTps.median, best: { stat: (r) => r.point?.decodeTps, higher: true } },
  { key: 'prefill', dir: 'desc', atDepth: true, value: (r) => (r.point ? prefillStat(r.point).median : undefined), best: { stat: (r) => (r.point ? prefillStat(r.point) : undefined), higher: true } },
  { key: 'ttft', dir: 'asc', atDepth: true, value: (r) => r.point?.ttftMs.median, best: { stat: (r) => r.point?.ttftMs, higher: false } },
  { key: 'vram', dir: 'asc', atDepth: false, value: (r) => r.combo.vramPeakMiB },
];

// ---- "Più utenti" ---------------------------------------------------------------------------------

/** Per-user generation speed of a level as a statistic (old points only had the p50). */
export function perUserStat(p: ConcurrencyPoint): Stat {
  if (p.perRequestDecodeTps && p.perRequestDecodeTps.n > 0) return p.perRequestDecodeTps;
  const v = p.perRequestDecodeTpsP50;
  return { n: 1, median: v, mean: v, min: v, max: v, stddev: 0, cv: 0, values: [v] };
}

/**
 * The noise of numbers measured with every user busy (the core's rule): the spread between users
 * over the square root of their number; totals and tails have no repetitions of their own.
 */
export function usersNoise(p: ConcurrencyPoint): number {
  const s = perUserStat(p);
  return s.n > 1 ? s.cv / Math.sqrt(s.n) : s.cv;
}

/** A plain number as a statistic with the given noise (for the noise-aware comparisons). */
export function noisy(v: number, cv: number): Stat {
  return { n: 1, median: v, mean: v, min: v, max: v, stddev: v * cv, cv, values: [v] };
}

/** The users level a "Più utenti" run measured (the most that fit, else the users asked). */
export function usersLevel(tuning: Pick<Tuning, 'multi'>): number | undefined {
  return tuning.multi ? (tuning.multi.fittingUsers ?? tuning.multi.users) : undefined;
}

/**
 * Ranking order with every user busy (the core's rule): fewer failed requests, higher per-user
 * generation, higher total, lower TTFT p95, lower wait of the later messages, the more precise cache,
 * the earlier configuration. Negative = `a` ranks first.
 */
export function compareUsersRows(a: RankRow & { users: ConcurrencyPoint }, b: RankRow & { users: ConcurrencyPoint }): number {
  const ua = a.users;
  const ub = b.users;
  if (ua.errors !== ub.errors) return ua.errors - ub.errors;
  const cv = Math.max(usersNoise(ua), usersNoise(ub));
  if (!sameWithinNoise(noisy(ua.perRequestDecodeTpsP50, cv), noisy(ub.perRequestDecodeTpsP50, cv))) return ub.perRequestDecodeTpsP50 - ua.perRequestDecodeTpsP50;
  if (!sameWithinNoise(noisy(ua.aggregateTps, cv), noisy(ub.aggregateTps, cv))) return ub.aggregateTps - ua.aggregateTps;
  if (!sameWithinNoise(noisy(ua.ttftP95Ms, cv), noisy(ub.ttftP95Ms, cv), TIE_TAIL)) return ua.ttftP95Ms - ub.ttftP95Ms;
  const la = a.sessions?.laterTurns?.ttftMs;
  const lb = b.sessions?.laterTurns?.ttftMs;
  if (la && lb && la.n > 0 && lb.n > 0 && !sameWithinNoise(la, lb)) return la.median - lb.median;
  return KV_PRECISION[a.combo.kvType] - KV_PRECISION[b.combo.kvType] || a.index - b.index;
}

/**
 * The ranking of a "Più utenti" run: the combinations measured with every user busy (the core's
 * recommendation on top, then by {@link compareUsersRows}), then those measured otherwise.
 */
export function rankUsers(tuning: Pick<Tuning, 'combinations' | 'multi' | 'recommended'>): RankRow[] {
  const n = usersLevel(tuning);
  const measured = tuning.combinations.flatMap((combo, index) => (combo.outcome === 'ok' && combo.concurrency?.length ? [{ index, combo }] : []));
  const full: (RankRow & { users: ConcurrencyPoint })[] = [];
  const rest: RankRow[] = [];
  for (const m of measured) {
    const users = m.combo.concurrency!.find((p) => p.level === n);
    const sessions = m.combo.sessions?.find((s) => s.sessions === n) ?? m.combo.sessions?.[0];
    if (users) full.push({ ...m, users, ...(sessions ? { sessions } : {}) });
    else rest.push(m);
  }
  // The core's recommendation on top (it decided with the same rule), the others by the rule.
  const top = full.filter((r) => r.index === tuning.recommended);
  full.splice(0, full.length, ...top, ...full.filter((r) => r.index !== tuning.recommended).sort(compareUsersRows));
  return [
    ...full.map((r, k) => {
      const above = full[k - 1];
      const cv = above ? Math.max(usersNoise(above.users), usersNoise(r.users)) : 0;
      const tie = above !== undefined && sameWithinNoise(noisy(above.users.perRequestDecodeTpsP50, cv), noisy(r.users.perRequestDecodeTpsP50, cv));
      return { ...r, rank: k + 1, ...(tie ? { tie: true } : {}) };
    }),
    ...rest,
  ];
}

/** Per-user context of a combination: what its users-at-once points say, else the launch context over the users. */
export function perUserContextOf(r: Pick<RankRow, 'combo' | 'users'>): number | undefined {
  return r.users?.contextPerUser;
}

/** "Più utenti": per-user generation, total, slowest first token, context per user, KV layout, cache reuse, memory. */
export const USERS_COLUMNS: readonly MetricColumn[] = [
  {
    key: 'perUser',
    dir: 'desc',
    atDepth: false,
    value: (r) => r.users?.perRequestDecodeTpsP50,
    best: { stat: (r) => (r.users ? noisy(r.users.perRequestDecodeTpsP50, usersNoise(r.users)) : undefined), higher: true },
  },
  { key: 'total', dir: 'desc', atDepth: false, value: (r) => r.users?.aggregateTps, best: { stat: (r) => (r.users ? noisy(r.users.aggregateTps, usersNoise(r.users)) : undefined), higher: true } },
  {
    key: 'ttftP95',
    dir: 'asc',
    atDepth: false,
    value: (r) => r.users?.ttftP95Ms,
    best: { stat: (r) => (r.users ? noisy(r.users.ttftP95Ms, usersNoise(r.users)) : undefined), higher: false, floor: TIE_TAIL },
  },
  { key: 'perUserContext', dir: 'desc', atDepth: false, value: perUserContextOf },
  // Split per user = 1, shared = 0: sorting groups them.
  { key: 'layout', dir: 'desc', atDepth: false, value: (r) => (r.combo.kvLayout === undefined ? undefined : r.combo.kvLayout === 'split' ? 1 : 0) },
  { key: 'reuse', dir: 'desc', atDepth: false, value: (r) => r.combo.cacheReuse ?? 0 },
  { key: 'vram', dir: 'asc', atDepth: false, value: (r) => r.combo.vramPeakMiB },
];

/**
 * Rows re-sorted by a column (none = the ranking itself). Those not reaching the compared depth
 * always stay at the bottom; missing values sort last; equal values keep the ranking order.
 */
export function sortRows(rows: readonly RankRow[], column: MetricColumn | undefined, dir: SortDir): RankRow[] {
  const order = new Map(rows.map((r, i) => [r.index, i]));
  const sign = dir === 'asc' ? 1 : -1;
  const by = (a: RankRow, b: RankRow): number => {
    if (column) {
      const va = column.value(a);
      const vb = column.value(b);
      if (va === undefined && vb !== undefined) return 1;
      if (vb === undefined && va !== undefined) return -1;
      if (va !== undefined && vb !== undefined && va !== vb) return sign * (va - vb);
      return order.get(a.index)! - order.get(b.index)!;
    }
    return sign * (order.get(a.index)! - order.get(b.index)!);
  };
  const reaching = rows.filter(reaches).sort(by);
  const short = rows.filter((r) => !reaches(r)).sort(by);
  return [...reaching, ...short];
}

/** Per highlighted column (by key), the combinations whose value ties (within the noise) with the best one. */
export function bestValues(rows: readonly RankRow[], columns: readonly MetricColumn[]): Map<string, ReadonlySet<number>> {
  const out = new Map<string, ReadonlySet<number>>();
  for (const c of columns) {
    if (!c.best) continue;
    const { stat, higher, floor } = c.best;
    // Rows not measured where they are compared have no statistic.
    const values = rows.flatMap((r) => {
      const s = stat(r);
      return s ? [{ index: r.index, s }] : [];
    });
    if (!values.length) continue;
    const top = values.reduce((b, v) => ((higher ? v.s.median > b.s.median : v.s.median < b.s.median) ? v : b));
    out.set(c.key, new Set(values.filter((v) => sameWithinNoise(v.s, top.s, floor)).map((v) => v.index)));
  }
  return out;
}

/** The recommended combination: the core's pick, else the fastest at its deepest point among those reaching the largest context. */
export function recommendedIndex(tuning: Pick<Tuning, 'combinations' | 'recommended'>): number | undefined {
  if (tuning.recommended !== undefined && tuning.combinations[tuning.recommended]) return tuning.recommended;
  const ids = measuredCombinations(tuning);
  if (!ids.length) return undefined;
  const top = Math.max(...ids.map((i) => tuning.combinations[i]!.maxContext));
  const contenders = ids
    .filter((i) => tuning.combinations[i]!.maxContext === top)
    .map((i) => ({ index: i, kvType: tuning.combinations[i]!.kvType, point: deepestPoint(tuning.combinations[i]!)! }));
  return contenders.sort(compareContenders)[0]!.index;
}

export interface CapacityLead {
  best: { kvType: TuneKvType; max: number };
  /** The next KV type with a smaller measured maximum. */
  next?: { kvType: TuneKvType; max: number };
  /** Every measured type reached the same context. */
  allSame: boolean;
}

/** Which KV cache reaches the largest context, and against which one (from the measured maxima only). */
export function capacityLead(tuning: Pick<Tuning, 'capacity'>): CapacityLead | undefined {
  const measured = tuning.capacity
    .filter((c): c is typeof c & { measuredMax: number } => c.measuredMax !== undefined)
    .sort((a, b) => b.measuredMax - a.measuredMax || KV_PRECISION[a.kvType] - KV_PRECISION[b.kvType]);
  const top = measured[0];
  if (!top) return undefined;
  const next = measured.find((c) => c.measuredMax < top.measuredMax);
  return {
    best: { kvType: top.kvType, max: top.measuredMax },
    ...(next ? { next: { kvType: next.kvType, max: next.measuredMax } } : {}),
    allSame: measured.length > 1 && next === undefined,
  };
}

/** "il doppio" (2), "il triplo" (3), "N volte" (whole multiples ≥ 4), else "+N%". */
export type Ratio = { kind: 'double' } | { kind: 'triple' } | { kind: 'times'; n: number } | { kind: 'percent'; pct: number };

export function ratioOf(big: number, small: number): Ratio {
  const r = big / small;
  const whole = Math.round(r);
  if (whole >= 2 && Math.abs(r - whole) < 0.05) return whole === 2 ? { kind: 'double' } : whole === 3 ? { kind: 'triple' } : { kind: 'times', n: whole };
  return { kind: 'percent', pct: Math.round((r - 1) * 100) };
}

export interface SpeedSegment {
  /** First and last depth where the same combination is the fastest. */
  from: number;
  to: number;
  combination: number;
  /** Generation speed of that combination at `to`. */
  decodeTps: number;
}

/** Winner per depth (the core's list, else computed), grouped into runs of the same combination. */
export function speedSegments(tuning: Pick<Tuning, 'combinations' | 'fastestByDepth'>): SpeedSegment[] {
  const winners = tuning.fastestByDepth.length
    ? [...tuning.fastestByDepth].sort((a, b) => a.depth - b.depth)
    : // Every option is a measured depth: the first of its ranking reaches it.
      depthOptions(tuning).map((depth) => ({ depth, combination: rankAt(tuning, depth)[0]!.index }));
  const out: SpeedSegment[] = [];
  for (const w of winners) {
    const point = pointAt(tuning.combinations[w.combination] ?? { sweep: [] }, w.depth);
    if (!point) continue;
    const last = out[out.length - 1];
    if (last && last.combination === w.combination) {
      last.to = w.depth;
      last.decodeTps = point.decodeTps.median;
    } else out.push({ from: w.depth, to: w.depth, combination: w.combination, decodeTps: point.decodeTps.median });
  }
  return out;
}

/** Launches that did not make it: out of memory, spilled to shared memory, errors, and values lost in the screening. */
export function discardedAttempts(tuning: Pick<Tuning, 'attempts'>): { attempt: TuneAttempt; index: number }[] {
  return tuning.attempts.flatMap((attempt, index) => (attempt.outcome !== 'ok' || attempt.screen === 'lost' ? [{ attempt, index }] : []));
}

/** The latest point an attempt measured (its quick numbers). */
export function lastPoint(attempt: Pick<TuneAttempt, 'points'>): LatencyPoint | undefined {
  return attempt.points[attempt.points.length - 1];
}
