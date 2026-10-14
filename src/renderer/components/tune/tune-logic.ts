/**
 * "Trova le impostazioni migliori": the pure comparison logic behind the result and live screens.
 * Good performance = the highest number measured among the launch combinations of this run: no
 * absolute thresholds. Differences within the measurement noise count as ties.
 */
import { fullContextPoint, nominalDepth, type ConcurrencyPoint, type LatencyPoint, type RunStatus, type SessionsPoint, type Stat, type TuneAttempt, type TuneCombination, type TuneKvType, type Tuning } from '../../../contract/results';
import { kvPrecision } from '../../../contract/kv-cache';
import { prefillStat } from '../bench/format';

/**
 * More precise KV cache first (ties go to the more precise one): f16 / auto / bf16 0, 8-bit 1, k8v4 1.5,
 * 4-bit 2, a fork's smaller types after by size (the core's rule: contract/kv-cache.ts).
 */
export const KV_PRECISION = (kv: TuneKvType): number => kvPrecision(kv);

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
  return KV_PRECISION(a.kvType) - KV_PRECISION(b.kvType) || a.index - b.index;
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
  /**
   * The measurement it is compared on: at the compared depth, or ("Contesto massimo") with its own
   * largest context full; undefined when it was not measured there.
   */
  point?: LatencyPoint;
  /** 1-based position among those measured where they are compared. */
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

/** "Confronta a" → "Contesto massimo": every combination with its own largest context full (the default). */
export const AT_MAX = 'max';
/** What the ranking compares at: one depth for all, or each combination's own largest context full. */
export type CompareAt = number | typeof AT_MAX;

/**
 * The ranking with every combination at its own largest context full (fullContextPoint): the core's
 * recommendation first, then the largest context first, then {@link compareContenders}; those never
 * measured with their context full at the bottom (recommendation first, largest context first), unranked.
 * A tie is only marked between rows with the same context (speeds at different contexts do not compare).
 */
export function rankAtMax(tuning: Pick<Tuning, 'combinations' | 'recommended'>): RankRow[] {
  const ids = measuredCombinations(tuning);
  const rec = tuning.recommended;
  const ctx = (i: number) => tuning.combinations[i]!.maxContext;
  const first = (a: number, b: number) => (a === rec ? -1 : b === rec ? 1 : ctx(b) - ctx(a));
  const full: Contender[] = [];
  const short: number[] = [];
  for (const i of ids) {
    const combo = tuning.combinations[i]!;
    const point = fullContextPoint(combo);
    if (point) full.push({ index: i, kvType: combo.kvType, point });
    else short.push(i);
  }
  full.sort((a, b) => first(a.index, b.index) || compareContenders(a, b));
  short.sort((a, b) => first(a, b) || a - b);
  return [
    ...full.map((c, k) => {
      const above = full[k - 1];
      const tie = above !== undefined && ctx(above.index) === ctx(c.index) && sameWithinNoise(above.point.decodeTps, c.point.decodeTps);
      return { index: c.index, combo: tuning.combinations[c.index]!, point: c.point, rank: k + 1, ...(tie ? { tie: true } : {}) };
    }),
    ...short.map((i) => ({ index: i, combo: tuning.combinations[i]! })),
  ];
}

/** The rows whose speeds compare at "Contesto massimo": those with the largest context of the ranking. */
export function sameLargestContext(rows: readonly RankRow[]): RankRow[] {
  const top = Math.max(...rows.map((r) => r.combo.maxContext));
  return rows.filter((r) => r.combo.maxContext === top);
}

/**
 * A combination's points by the depth they are drawn at: each at its grid depth, except the one with
 * the context full, drawn at the context itself (a 256K context's 261 200 or 240 000 tokens sit on "256K").
 */
export function drawnPoints(combo: Pick<TuneCombination, 'maxContext' | 'sweep'>): Map<number, LatencyPoint> {
  const out = new Map(combo.sweep.map((p) => [nominalDepth(p.promptTokens), p] as const));
  const full = fullContextPoint(combo);
  if (full) {
    out.delete(nominalDepth(full.promptTokens));
    out.set(nominalDepth(combo.maxContext), full);
  }
  return out;
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
  return KV_PRECISION(a.combo.kvType) - KV_PRECISION(b.combo.kvType) || a.index - b.index;
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

/**
 * The recommended combination: the core's pick, else among those reaching the largest context the
 * fastest with its context full (those measured that far first; else the fastest at its deepest point).
 */
export function recommendedIndex(tuning: Pick<Tuning, 'combinations' | 'recommended'>): number | undefined {
  if (tuning.recommended !== undefined && tuning.combinations[tuning.recommended]) return tuning.recommended;
  const ids = measuredCombinations(tuning);
  if (!ids.length) return undefined;
  const top = Math.max(...ids.map((i) => tuning.combinations[i]!.maxContext));
  const contenders = ids
    .filter((i) => tuning.combinations[i]!.maxContext === top)
    .map((i) => {
      const combo = tuning.combinations[i]!;
      const full = fullContextPoint(combo);
      return { index: i, kvType: combo.kvType, point: full ?? deepestPoint(combo)!, full: full !== undefined };
    });
  return contenders.sort((a, b) => Number(b.full) - Number(a.full) || compareContenders(a, b))[0]!.index;
}

/** The search's precision for a KV type's limit (the core's): the context that did not fit is at most this far above the one that did. */
export function limitStep(measuredMax: number): number {
  return Math.max(8192, measuredMax / 8);
}

type Capacity = Tuning['capacity'][number];

/**
 * "Limite trovato": a larger context was tried and did not fit, close enough above the largest that did
 * (within {@link limitStep}). A wider gap (older runs) leaves the contexts in between untried; without
 * the context that failed (not saved), the core's word is taken.
 */
export function limitFound(c: Pick<Capacity, 'bound' | 'measuredMax' | 'failedAt'>): boolean {
  return c.bound === 'found' && (c.failedAt === undefined || c.failedAt - (c.measuredMax as number) <= limitStep(c.measuredMax as number));
}

/** A KV type's largest context is only a lower bound: larger ones left untried (estimate, time, a wide gap) or the search cut short. */
export function capacityAtLeast(c: Capacity): boolean {
  return c.measuredMax !== undefined && (c.bound === 'estimate' || c.bound === 'budget' || searchCut(c) || (c.bound === 'found' && !limitFound(c)));
}

/**
 * The capacity as its launches say it: a type marked "deduced without a launch" whose attempts did load
 * at that context (older runs launched it later on, e.g. to compare its settings) counts as launched.
 */
export function launchedCapacity(tuning: Pick<Tuning, 'capacity' | 'attempts'>): Tuning['capacity'] {
  return tuning.capacity.map((c) =>
    c.inferred && tuning.attempts.some((a) => a.kvType === c.kvType && a.contextSize === c.measuredMax && a.outcome === 'ok') ? { ...c, inferred: false } : c,
  );
}

/** The median engine start of the attempts that say how long they took (seconds); undefined when none does. */
export function medianLoadSeconds(attempts: readonly Pick<TuneAttempt, 'loadMs'>[]): number | undefined {
  const ms = attempts.flatMap((a) => (a.loadMs === undefined ? [] : [a.loadMs])).sort((a, b) => a - b);
  if (!ms.length) return undefined;
  const mid = Math.floor(ms.length / 2);
  return (ms.length % 2 ? ms[mid]! : (ms[mid - 1]! + ms[mid]!) / 2) / 1000;
}

export interface CapacityLead {
  best: { kvType: TuneKvType; max: number };
  /** The next KV type with a smaller measured maximum, when that maximum is exact (a lower bound would make the comparison say too much). */
  next?: { kvType: TuneKvType; max: number };
  /** Every measured type reached the same context. */
  allSame: boolean;
  /**
   * The run ended while some type was being searched: 'best' = the best one's maximum is only a lower
   * bound, 'other' = another one's is (comparisons with it would say too much).
   */
  unfinished?: 'best' | 'other';
  /** The best one's maximum is a lower bound for another reason (larger contexts left untried): "almeno". */
  atLeast?: true;
}

/** The run ended (cancelled / failed) while this type was being searched: its maximum is only "at least". */
export function searchCut(c: Pick<Tuning['capacity'][number], 'bound'>): boolean {
  return c.bound === 'cancelled' || c.bound === 'failed';
}

/** Which KV cache reaches the largest context, and against which one (from the measured maxima only). */
export function capacityLead(tuning: Pick<Tuning, 'capacity'>): CapacityLead | undefined {
  const measured = tuning.capacity
    .filter((c): c is typeof c & { measuredMax: number } => c.measuredMax !== undefined)
    .sort((a, b) => b.measuredMax - a.measuredMax || KV_PRECISION(a.kvType) - KV_PRECISION(b.kvType));
  const top = measured[0];
  if (!top) return undefined;
  const next = measured.find((c) => c.measuredMax < top.measuredMax);
  const unfinished = searchCut(top) ? 'best' : measured.some(searchCut) ? 'other' : undefined;
  return {
    best: { kvType: top.kvType, max: top.measuredMax },
    ...(next && !capacityAtLeast(next) ? { next: { kvType: next.kvType, max: next.measuredMax } } : {}),
    allSame: measured.length > 1 && next === undefined,
    ...(unfinished ? { unfinished } : {}),
    ...(capacityAtLeast(top) ? { atLeast: true as const } : {}),
  };
}

/**
 * A tune run that ended early (cancelled or failed) as the search now records it: runs saved before it
 * did get `stoppedBy` from their status, and each KV type with no maximum and no reason what its
 * reference and capacity launches say — at least the largest context that loaded (else the smallest
 * that did not, as a cut search), or "not tried" when it was never launched. Anything else is unchanged.
 */
export function withRunEnd(tuning: Tuning, status: RunStatus): Tuning {
  if (status === 'completed' || tuning.stoppedBy === 'cancelled' || tuning.stoppedBy === 'failed') return tuning;
  const why = status;
  const capacity = tuning.capacity.map((c) => {
    if (c.measuredMax !== undefined || c.skipped) return c;
    const launched = tuning.attempts.filter((a) => a.kvType === c.kvType && (a.stage === 'reference' || a.stage === 'capacity'));
    if (!launched.length) return { ...c, skipped: why };
    const ok = launched.filter((a) => a.outcome === 'ok').map((a) => a.contextSize);
    const max = ok.length ? Math.max(...ok) : undefined;
    const failed = launched.filter((a) => a.outcome !== 'ok' && (max === undefined || a.contextSize > max)).map((a) => a.contextSize);
    return { ...c, ...(max !== undefined ? { measuredMax: max } : {}), bound: why, ...(failed.length ? { failedAt: Math.min(...failed) } : {}) };
  });
  return { ...tuning, stoppedBy: why, capacity };
}

/** "il doppio" (2), "il triplo" (3), "N volte" (whole multiples ≥ 4), else "+N%". */
export type Ratio = { kind: 'double' } | { kind: 'triple' } | { kind: 'times'; n: number } | { kind: 'percent'; pct: number };

export function ratioOf(big: number, small: number): Ratio {
  const r = big / small;
  const whole = Math.round(r);
  if (whole >= 2 && Math.abs(r - whole) < 0.05) return whole === 2 ? { kind: 'double' } : whole === 3 ? { kind: 'triple' } : { kind: 'times', n: whole };
  return { kind: 'percent', pct: Math.round((r - 1) * 100) };
}

// ---- "In breve": the five answers of a one-user search ---------------------------------------------

/** One measured point of one combination: where it was measured (its grid depth) and how fast. */
export interface BriefPoint {
  index: number;
  combo: TuneCombination;
  point: LatencyPoint;
  /** Grid depth ("32K" for 32 624 tokens). */
  depth: number;
  /** It filled the combination's context. */
  full: boolean;
}

/** A combination read at its largest context: its point with the context full, or none (not measured that far). */
export interface BriefAtMax {
  index: number;
  combo: TuneCombination;
  point?: LatencyPoint;
}

export interface Brief {
  /** 1. The recommendation at its largest context, full. */
  atMax?: BriefAtMax;
  /** 2. The fastest prompt reading measured, anywhere. */
  read?: BriefPoint;
  /** 3. The fastest generation measured, anywhere. */
  write?: BriefPoint;
  /** 4. Best at both (BALANCE_RULE). */
  both?: BriefPoint;
  /** 5. The most precise KV cache that fits, at its largest context, full; `below8` = nothing of 8 bits or more fitted. */
  quality?: BriefAtMax & { below8: boolean };
}

/** KV caches of 8 bits or more ("q8 o superiori"): f16 / bf16 / auto, q8_0 / int8 / fp8. */
export const QUALITY_PRECISION = 1;

/**
 * Best at both reading and writing: each speed as a share of its best measured anywhere, then their
 * harmonic mean (a point is only as good as the weaker of its two shares lets it be); the highest wins.
 */
export function balanceScore(read: number, write: number, bestRead: number, bestWrite: number): number {
  const r = bestRead > 0 ? read / bestRead : 0;
  const w = bestWrite > 0 ? write / bestWrite : 0;
  return r + w > 0 ? (2 * r * w) / (r + w) : 0;
}

/**
 * The five answers of "In breve" from the measured sweeps (only what was measured: an answer the
 * search could not give is absent, or has no point when it was not measured that far).
 */
export function briefOf(tuning: Pick<Tuning, 'combinations' | 'recommended'>): Brief {
  const ids = measuredCombinations(tuning);
  const points: BriefPoint[] = ids.flatMap((index) => {
    const combo = tuning.combinations[index]!;
    const full = fullContextPoint(combo);
    return combo.sweep.filter((p) => p.decodeTps.n > 0).map((point) => ({ index, combo, point, depth: nominalDepth(point.promptTokens), full: point === full }));
  });
  const out: Brief = {};
  const rec = recommendedIndex(tuning);
  if (rec !== undefined) out.atMax = atMaxOf(tuning.combinations[rec]!, rec);
  if (!points.length) return out;
  // Ties go to the earlier point (the recommendation's combinations come first, shallower depths first).
  const best = (score: (p: BriefPoint) => number) => points.reduce((a, b) => (score(b) > score(a) ? b : a));
  out.read = best((p) => prefillStat(p.point).median);
  out.write = best((p) => p.point.decodeTps.median);
  const bestRead = prefillStat(out.read.point).median;
  const bestWrite = out.write.point.decodeTps.median;
  out.both = best((p) => balanceScore(prefillStat(p.point).median, p.point.decodeTps.median, bestRead, bestWrite));
  // The most precise KV type measured; among its combinations the largest context, then the fastest with it full.
  const precision = Math.min(...ids.map((i) => KV_PRECISION[tuning.combinations[i]!.kvType]));
  const own = ids.filter((i) => KV_PRECISION[tuning.combinations[i]!.kvType] === precision);
  const top = Math.max(...own.map((i) => tuning.combinations[i]!.maxContext));
  const candidates = own.filter((i) => tuning.combinations[i]!.maxContext === top).map((i) => atMaxOf(tuning.combinations[i]!, i));
  const q = candidates.reduce((a, b) => (b.point && (!a.point || b.point.decodeTps.median > a.point.decodeTps.median) ? b : a));
  out.quality = { ...q, below8: precision > QUALITY_PRECISION };
  return out;
}

function atMaxOf(combo: TuneCombination, index: number): BriefAtMax {
  const point = fullContextPoint(combo);
  return { index, combo, ...(point ? { point } : {}) };
}

/** Launches that did not make it: out of memory, spilled to shared memory, errors, and values lost in the screening. */
export function discardedAttempts(tuning: Pick<Tuning, 'attempts'>): { attempt: TuneAttempt; index: number }[] {
  return tuning.attempts.flatMap((attempt, index) => (attempt.outcome !== 'ok' || attempt.screen === 'lost' ? [{ attempt, index }] : []));
}

/** The latest point an attempt measured (its quick numbers). */
export function lastPoint(attempt: Pick<TuneAttempt, 'points'>): LatencyPoint | undefined {
  return attempt.points[attempt.points.length - 1];
}
