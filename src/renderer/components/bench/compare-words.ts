/**
 * Differences in words, like a person would write them: "2,2 volte più veloce", "+16%", "−54%",
 * "2,2 volte di più", "prima riletto da capo, ora 1,00 s". Ratios of at least 2 (or at most ½) read
 * as "N volte", smaller changes as a percentage; whether it is good news depends on the metric.
 */
import { nominalDepth, type LatencyPoint, type RunResult, type SessionsPoint } from '../../../contract/results';
import type { Formatters } from '../../i18n';
import { deltaView, type DeltaView } from './delta';
import { prefillStat } from './format';
import { contextSweepOf, sessionsOf, soloPoint, writeStat } from './sessions-view';

/** What the number is: a speed (faster/slower), an amount (more/less) or a time (shorter/longer). */
export type DeltaKind = 'speed' | 'amount' | 'time';

/** Below this share of reused context, the later messages read everything again ("riletto da capo"). */
export const REREAD_SHARE = 0.01;

/** "2,2" (one decimal below 10, none from 10 on; "2" rather than "2,0"). */
function times(n: number, number: Formatters['number']): string {
  const rounded = n < 10 ? Math.round(n * 10) / 10 : Math.round(n);
  return number(rounded, Number.isInteger(rounded) ? 0 : 1);
}

export function deltaWords(
  a: number | undefined,
  b: number | undefined,
  o: { higherIsBetter: boolean; kind: DeltaKind },
  f: Pick<Formatters, 't' | 'number' | 'percent'>,
): DeltaView | undefined {
  const base = deltaView(a, b, o.higherIsBetter, f.percent);
  if (!base || base.direction === 'same') return base;
  const ratio = (b as number) / (a as number);
  if (!(ratio >= 2 || (ratio > 0 && ratio <= 0.5))) return base;
  const up = ratio > 1;
  const words = { speed: ['faster', 'slower'], amount: ['more', 'less'], time: ['longer', 'shorter'] } as const;
  const key = words[o.kind][up ? 0 : 1];
  return { ...base, text: f.t(`longConversations.compare.${key}`, { n: times(up ? ratio : 1 / ratio, f.number) }) };
}

/** A compare row about long conversations or KV capacity (same shape as MetricRow, plus how to word it). */
export interface WordsRow {
  id: string;
  label: string;
  a: number | undefined;
  b: number | undefined;
  higherIsBetter: boolean;
  kind: DeltaKind;
  format: (v: number) => string;
  /** The later messages read the whole context again (nothing reused) on that side. */
  reread?: { a: boolean; b: boolean };
}

/** Where a depth comes from: one conversation alone ("Conversazioni lunghe"), or the context sweep. */
type DepthSource = { depth: number; a: SessionsPoint; b: SessionsPoint } | { depth: number; a: LatencyPoint; b: LatencyPoint; sweep: true };

const sweepAt = (run: RunResult): Map<number, LatencyPoint> => new Map(contextSweepOf(run).map((p) => [nominalDepth(p.promptTokens), p]));

/**
 * The deepest context both runs measured at the same depth: a long conversation alone (same
 * first-message depth) or a point of both context sweeps. Never extrapolated.
 */
export function commonDepth(a: RunResult, b: RunResult): DepthSource | undefined {
  const sa = soloPoint(sessionsOf(a));
  const sb = soloPoint(sessionsOf(b));
  const sessions = sa && sb && nominalDepth(sa.depth) === nominalDepth(sb.depth) ? { depth: nominalDepth(sa.depth), a: sa, b: sb } : undefined;
  const wa = sweepAt(a);
  const wb = sweepAt(b);
  const shared = [...wa.keys()].filter((d) => wb.has(d)).sort((x, y) => y - x)[0];
  const sweep = shared === undefined ? undefined : { depth: shared, a: wa.get(shared) as LatencyPoint, b: wb.get(shared) as LatencyPoint, sweep: true as const };
  if (sessions && (!sweep || sessions.depth >= sweep.depth)) return sessions;
  return sweep;
}

const reread = (p: SessionsPoint): boolean => {
  const share = p.laterTurns?.cachedShare;
  return share !== undefined && share.n > 0 && share.median < REREAD_SHARE;
};

/**
 * Rows of the pasted team page: context read speed, write speed, KV capacity, first-answer wait,
 * later-answers wait and context reused, at the deepest depth both runs measured (in the label).
 */
export function longConversationRows(a: RunResult, b: RunResult, f: Pick<Formatters, 't' | 'integer' | 'number' | 'percent' | 'duration'>): WordsRow[] {
  const { t, integer, number, percent, duration } = f;
  const tps0 = (v: number) => `${integer(v)} tok/s`;
  const tps1 = (v: number) => `${number(v, 1)} tok/s`;
  const rows: WordsRow[] = [];
  const kvA = a.metrics.kvCapacity?.tokens;
  const kvB = b.metrics.kvCapacity?.tokens;
  if (kvA !== undefined || kvB !== undefined) {
    rows.push({ id: 'kvCapacity', label: t('longConversations.compare.kvCapacity'), a: kvA, b: kvB, higherIsBetter: true, kind: 'amount', format: (v) => `${integer(v)} token` });
  }
  const at = commonDepth(a, b);
  if (!at) return rows;
  const depth = { depth: integer(at.depth) };
  if ('sweep' in at) {
    rows.unshift(
      { id: 'readAt', label: t('longConversations.compare.readAt', depth), a: prefillStat(at.a).median, b: prefillStat(at.b).median, higherIsBetter: true, kind: 'speed', format: tps0 },
      { id: 'writeAt', label: t('longConversations.compare.writeAt', depth), a: at.a.decodeTps.median, b: at.b.decodeTps.median, higherIsBetter: true, kind: 'speed', format: tps1 },
    );
    rows.push({ id: 'firstWaitAt', label: t('longConversations.compare.firstWaitAt', depth), a: at.a.ttftMs.median, b: at.b.ttftMs.median, higherIsBetter: false, kind: 'time', format: duration });
    return rows;
  }
  const later = (p: SessionsPoint) => (p.laterTurns && p.laterTurns.ttftMs.n > 0 ? p.laterTurns.ttftMs.median : undefined);
  const share = (p: SessionsPoint) => (p.laterTurns?.cachedShare && p.laterTurns.cachedShare.n > 0 ? p.laterTurns.cachedShare.median : undefined);
  rows.unshift(
    { id: 'readAt', label: t('longConversations.compare.readAt', depth), a: at.a.aggregatePrefillTps, b: at.b.aggregatePrefillTps, higherIsBetter: true, kind: 'speed', format: tps0 },
    { id: 'writeAt', label: t('longConversations.compare.writeAt', depth), a: writeStat(at.a).median, b: writeStat(at.b).median, higherIsBetter: true, kind: 'speed', format: tps1 },
  );
  rows.push(
    { id: 'firstWaitAt', label: t('longConversations.compare.firstWaitAt', depth), a: at.a.firstTurn.ttftMs.median, b: at.b.firstTurn.ttftMs.median, higherIsBetter: false, kind: 'time', format: duration },
    {
      id: 'laterWaitAt',
      label: t('longConversations.compare.laterWaitAt', depth),
      a: later(at.a),
      b: later(at.b),
      higherIsBetter: false,
      kind: 'time',
      format: duration,
      reread: { a: reread(at.a), b: reread(at.b) },
    },
    { id: 'reuseAt', label: t('longConversations.compare.reuseAt', depth), a: share(at.a), b: share(at.b), higherIsBetter: true, kind: 'amount', format: (v) => percent(v, 1) },
  );
  return rows.filter((r) => r.a !== undefined || r.b !== undefined);
}

/** The difference of a row in words, "prima riletto da capo, ora 1,00 s" included. */
export function rowWords(r: WordsRow, f: Pick<Formatters, 't' | 'number' | 'percent'>): DeltaView | undefined {
  if (r.reread && r.a !== undefined && r.b !== undefined && r.reread.a !== r.reread.b) {
    const before = r.reread.a;
    return {
      change: (r.b - r.a) / r.a,
      text: before ? f.t('longConversations.compare.rereadBefore', { value: r.format(r.b) }) : f.t('longConversations.compare.rereadNow', { value: r.format(r.a) }),
      direction: before ? 'down' : 'up',
      good: before,
    };
  }
  return deltaWords(r.a, r.b, r, f);
}
