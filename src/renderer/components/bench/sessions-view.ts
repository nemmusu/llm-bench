/**
 * "Conversazioni lunghe" as words and tables: shared by the result page, the compare page and the
 * "Scheda da condividere". Numbers only, no verdicts: the reader decides what is good enough.
 */
import type { KvCapacity, LatencyPoint, Metrics, RunResult, SessionsPoint, Stat } from '../../../contract/results';
import type { Formatters } from '../../i18n';

export type SessionsFormatters = Pick<Formatters, 't' | 'integer' | 'number' | 'percent' | 'duration'>;

/** One level of the table, numbers only (undefined = not measured). */
export interface SessionsRow {
  sessions: number;
  /** Context read by the server as a whole, tokens/s. */
  read?: number;
  /** Wait for the first answer (median). */
  firstWaitMs?: number;
  /** The longest wait in the queue before a conversation's reading started. */
  queueMs?: number;
  queueEstimated: boolean;
  /** Wait for the answers from the second message on (median). */
  laterWaitMs?: number;
  /** Share of the prompt reused from the cache, 0..1 (median). */
  reuse?: number;
  /** Generation speed per conversation, tokens/s (median). */
  write?: number;
  errors: number;
}

const med = (s: Stat | undefined): number | undefined => (s && s.n > 0 ? s.median : undefined);

/** Generation speed of a level: the later messages (steady), else the first ones. */
export function writeStat(p: SessionsPoint): Stat {
  return p.laterTurns && p.laterTurns.decodeTps.n > 0 ? p.laterTurns.decodeTps : p.firstTurn.decodeTps;
}

export function sessionsRow(p: SessionsPoint): SessionsRow {
  const queue = p.firstTurn.queueWaitMs;
  const row: SessionsRow = { sessions: p.sessions, queueEstimated: p.queueEstimated, errors: p.errors };
  const set = <K extends keyof SessionsRow>(k: K, v: SessionsRow[K] | undefined) => {
    if (v !== undefined) row[k] = v;
  };
  set('read', p.aggregatePrefillTps);
  set('firstWaitMs', med(p.firstTurn.ttftMs));
  set('queueMs', queue.n > 0 ? queue.max : undefined);
  set('laterWaitMs', med(p.laterTurns?.ttftMs));
  set('reuse', med(p.laterTurns?.cachedShare));
  set('write', med(writeStat(p)));
  return row;
}

/** Levels in ascending order (1, 2, 3…). */
export function sessionsRows(points: readonly SessionsPoint[]): SessionsRow[] {
  return [...points].sort((a, b) => a.sessions - b.sessions).map(sessionsRow);
}

export const SESSIONS_COLUMNS = ['sessions', 'read', 'firstWait', 'queue', 'laterWait', 'reuse', 'write', 'errors'] as const;
export type SessionsColumn = (typeof SESSIONS_COLUMNS)[number];

export interface SessionsTable {
  columns: SessionsColumn[];
  head: string[];
  rows: string[][];
  /** First-message depth of the step (tokens). */
  depth: number;
  /** Some queue wait was estimated (no engine timings). */
  estimated: boolean;
}

/** Every level with units in the headers; a column empty for every level is left out. */
export function sessionsTable(points: readonly SessionsPoint[], f: SessionsFormatters): SessionsTable {
  const { t, integer, number, percent, duration } = f;
  const rows = sessionsRows(points);
  const depth = points[0]?.depth ?? 0;
  const estimated = rows.some((r) => r.queueEstimated && r.queueMs !== undefined);
  const value: Record<SessionsColumn, (r: SessionsRow) => string | undefined> = {
    sessions: (r) => integer(r.sessions),
    read: (r) => (r.read === undefined ? undefined : integer(r.read)),
    firstWait: (r) => (r.firstWaitMs === undefined ? undefined : duration(r.firstWaitMs)),
    queue: (r) => (r.queueMs === undefined ? undefined : `${duration(r.queueMs)}${r.queueEstimated ? ` (${t('longConversations.estimated')})` : ''}`),
    laterWait: (r) => (r.laterWaitMs === undefined ? undefined : duration(r.laterWaitMs)),
    reuse: (r) => (r.reuse === undefined ? undefined : percent(r.reuse, 1)),
    write: (r) => (r.write === undefined ? undefined : number(r.write, 1)),
    errors: (r) => integer(r.errors),
  };
  const columns = SESSIONS_COLUMNS.filter((c) => rows.some((r) => value[c](r) !== undefined));
  const head = columns.map((c) => t(`longConversations.columns.${c}`, { depth: integer(depth) }));
  return { columns, head, rows: rows.map((r) => columns.map((c) => value[c](r) ?? '–')), depth, estimated };
}

/** "la seconda" / "la terza" / "la quarta" / "l'ultima": the conversation that waits the longest. */
function lastOne(n: number, t: SessionsFormatters['t']): string {
  if (n === 2) return t('longConversations.who.second');
  if (n === 3) return t('longConversations.who.third');
  if (n === 4) return t('longConversations.who.fourth');
  return t('longConversations.who.last');
}

/**
 * Numbers in plain sentences, one per level: what the first message waits, what the cache saves,
 * how long the busiest conversation queues.
 */
export function sessionsSentences(points: readonly SessionsPoint[], f: SessionsFormatters): string[] {
  const { t, integer, percent, duration } = f;
  const out: string[] = [];
  for (const p of [...points].sort((a, b) => a.sessions - b.sessions)) {
    const r = sessionsRow(p);
    const later = r.laterWaitMs === undefined ? undefined : duration(r.laterWaitMs);
    if (p.sessions === 1) {
      if (r.firstWaitMs === undefined) continue;
      const base = { first: duration(r.firstWaitMs), depth: integer(p.depth) };
      if (later === undefined) out.push(t('longConversations.sentence.oneOnly', base));
      else if (r.reuse === undefined) out.push(t('longConversations.sentence.oneUnknown', { ...base, later }));
      else out.push(t('longConversations.sentence.one', { ...base, later, reuse: percent(r.reuse, 1) }));
      continue;
    }
    if (r.queueMs === undefined) continue;
    const many = { n: p.sessions, who: lastOne(p.sessions, t), queue: duration(r.queueMs), estimated: r.queueEstimated ? ` (${t('longConversations.estimated')})` : '' };
    out.push(later === undefined ? t('longConversations.sentence.manyOnly', many) : t('longConversations.sentence.many', { ...many, later }));
  }
  return out;
}

export const GLOSSARY_TERMS = ['read', 'firstWait', 'queue', 'reuse', 'write'] as const;

/** The short glossary under the table (and in the shared sheet). */
export function sessionsGlossary(f: Pick<Formatters, 't'>): { term: string; text: string }[] {
  return GLOSSARY_TERMS.map((k) => ({ term: f.t(`longConversations.glossary.${k}.term`), text: f.t(`longConversations.glossary.${k}.text`) }));
}

/** "889.820 token (bastano per 4 conversazioni da 200.000)". */
export function kvCapacityText(kv: KvCapacity, f: Pick<Formatters, 't' | 'integer'>): string {
  const { t, integer } = f;
  const tokens = integer(kv.tokens);
  const at = kv.maxConcurrencyAtTokens;
  if (!at) return t('longConversations.kv.value', { tokens });
  const n = Math.floor(at.concurrency);
  const size = integer(at.tokens);
  if (n < 1) return t('longConversations.kv.fitsNone', { tokens, size });
  return n === 1 ? t('longConversations.kv.fitsOne', { tokens, size }) : t('longConversations.kv.fits', { tokens, n, size });
}

/** The long-conversation levels of a run ([] for results saved before the step existed). */
export function sessionsOf(run: Pick<RunResult, 'metrics'>): SessionsPoint[] {
  return (run.metrics as Partial<Metrics>).sessions ?? [];
}

/** The context sweep of a run ([] for results saved before it existed). */
export function contextSweepOf(run: Pick<RunResult, 'metrics'>): LatencyPoint[] {
  return (run.metrics as Partial<Metrics>).contextSweep ?? [];
}

/** The level-1 point (one conversation alone), when measured. */
export function soloPoint(points: readonly SessionsPoint[]): SessionsPoint | undefined {
  return points.find((p) => p.sessions === 1);
}
