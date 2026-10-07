/**
 * "Trova le impostazioni migliori": the pure comparison logic behind the result and live screens.
 * Good performance = the highest number measured among the launch combinations of this run: no
 * absolute thresholds. Differences within the measurement noise count as ties.
 */
import { nominalDepth, type LatencyPoint, type Stat, type TuneAttempt, type TuneCombination, type TuneKvType, type Tuning } from '../../../contract/results';
import { prefillStat } from '../bench/format';

/** More precise KV cache first (ties go to the more precise one). */
export const KV_PRECISION: Record<TuneKvType, number> = { f16: 0, auto: 0, q8_0: 1, fp8: 1, q4_0: 2 };

/** Smallest relative difference that is never noise (the core's ranking rule). */
export const TIE_MIN = 0.02;
/** Differences below this many coefficients of variation are noise. */
export const TIE_CV = 2;

/** Equal within the noise, the same rule as the core: closer than max(2 %, 2 × the larger CV) of the larger median. */
export function sameWithinNoise(a: Stat, b: Stat): boolean {
  const scale = Math.max(Math.abs(a.median), Math.abs(b.median));
  if (scale === 0) return true;
  return Math.abs(a.median - b.median) / scale < Math.max(TIE_MIN, TIE_CV * Math.max(a.cv, b.cv));
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

export type SortKey = 'rank' | 'maxContext' | 'decode' | 'prefill' | 'ttft' | 'vram';
export type SortDir = 'asc' | 'desc';

/** Natural first direction of a column: bigger is better, except time to first token and memory. */
export function defaultDir(key: SortKey): SortDir {
  return key === 'rank' || key === 'ttft' || key === 'vram' ? 'asc' : 'desc';
}

function sortValue(row: RankRow, key: Exclude<SortKey, 'rank'>): number | undefined {
  switch (key) {
    case 'maxContext':
      return row.combo.maxContext;
    case 'vram':
      return row.combo.vramPeakMiB;
    case 'decode':
      return row.point?.decodeTps.median;
    case 'prefill':
      return row.point ? prefillStat(row.point).median : undefined;
    case 'ttft':
      return row.point?.ttftMs.median;
  }
}

/**
 * Rows re-sorted by a column. Those not reaching the compared depth always stay at the bottom;
 * missing values sort last; equal values keep the ranking order.
 */
export function sortRows(rows: readonly RankRow[], key: SortKey, dir: SortDir): RankRow[] {
  const order = new Map(rows.map((r, i) => [r.index, i]));
  const sign = dir === 'asc' ? 1 : -1;
  const by = (a: RankRow, b: RankRow): number => {
    if (key !== 'rank') {
      const va = sortValue(a, key);
      const vb = sortValue(b, key);
      if (va === undefined && vb !== undefined) return 1;
      if (vb === undefined && va !== undefined) return -1;
      if (va !== undefined && vb !== undefined && va !== vb) return sign * (va - vb);
      return order.get(a.index)! - order.get(b.index)!;
    }
    return sign * (order.get(a.index)! - order.get(b.index)!);
  };
  const reaching = rows.filter((r) => r.point).sort(by);
  const short = rows.filter((r) => !r.point).sort(by);
  return [...reaching, ...short];
}

export interface Best {
  decode: ReadonlySet<number>;
  prefill: ReadonlySet<number>;
  ttft: ReadonlySet<number>;
}

/** Per column, the combinations whose value ties (within the noise) with the best one at the compared depth. */
export function bestValues(rows: readonly RankRow[]): Best {
  const reaching = rows.filter((r): r is RankRow & { point: LatencyPoint } => r.point !== undefined);
  const pick = (stat: (p: LatencyPoint) => Stat, better: (a: number, b: number) => boolean): Set<number> => {
    if (!reaching.length) return new Set();
    const top = reaching.reduce((b, r) => (better(stat(r.point).median, stat(b.point).median) ? r : b));
    return new Set(reaching.filter((r) => sameWithinNoise(stat(r.point), stat(top.point))).map((r) => r.index));
  };
  return {
    decode: pick((p) => p.decodeTps, (a, b) => a > b),
    prefill: pick(prefillStat, (a, b) => a > b),
    ttft: pick((p) => p.ttftMs, (a, b) => a < b),
  };
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
