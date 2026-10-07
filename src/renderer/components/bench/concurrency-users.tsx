/**
 * "Più utenti": what each user gets at every level (prompt, context, reading and writing speed, the
 * slowest user, first token) and the server as a whole, so people see how many users a setup holds.
 * Numbers only: no thresholds, no verdicts. Columns no row has (older runs) are left out.
 */
import type { ConcurrencyPoint } from '../../../contract/results';
import type { Formatters } from '../../i18n';
import { useI18n } from '../../i18n';
import { MeasureTable, type MeasureColumn, type MeasureRow } from './measure-table';

type F = Pick<Formatters, 't' | 'number' | 'integer'>;

interface UsersColumn {
  label: (f: F) => string;
  /** The cell text, or undefined when this point does not have it. */
  value: (p: ConcurrencyPoint, f: F, solo: number | undefined) => string | undefined;
  /** Always shown (old runs have it too). */
  always?: boolean;
}

/** Per-user generation speed with one user alone: the reference of "rispetto a 1 utente". */
export function soloDecode(points: readonly ConcurrencyPoint[]): number | undefined {
  return points.find((p) => p.level === 1)?.perRequestDecodeTpsP50;
}

const opt = (v: number | undefined, fmt: (n: number) => string) => (v === undefined ? undefined : fmt(v));

const COLUMNS: UsersColumn[] = [
  { label: (f) => f.t('users.columns.prompt'), value: (p, f) => opt(p.promptTokens, f.integer) },
  { label: (f) => f.t('users.columns.output'), value: (p, f) => opt(p.outputTokens, f.integer) },
  {
    label: (f) => f.t('users.columns.context'),
    value: (p, f) => opt(p.contextPerUser, (n) => (p.contextShared ? f.t('users.shared', { n: f.integer(n) }) : f.integer(n))),
  },
  { label: (f) => f.t('users.columns.prefill'), value: (p, f) => opt(p.perRequestPrefillTpsP50, f.integer) },
  { label: (f) => f.t('users.columns.decode'), value: (p, f) => f.number(p.perRequestDecodeTpsP50, 1), always: true },
  { label: (f) => f.t('users.columns.slowest'), value: (p, f) => opt(p.perRequestDecodeTpsP5, (n) => f.number(n, 1)) },
  { label: (f) => f.t('users.columns.vsSolo'), value: (p, f, solo) => (solo ? f.integer((100 * p.perRequestDecodeTpsP50) / solo) : undefined) },
  { label: (f) => f.t('users.columns.ttftP50'), value: (p, f) => f.integer(p.ttftP50Ms), always: true },
  { label: (f) => f.t('users.columns.ttftP95'), value: (p, f) => f.integer(p.ttftP95Ms), always: true },
  { label: (f) => f.t('users.columns.total'), value: (p, f) => f.integer(p.aggregateTps), always: true },
  { label: (f) => f.t('users.columns.totalPrefill'), value: (p, f) => opt(p.aggregatePrefillTps, f.integer) },
  { label: (f) => f.t('users.columns.requests'), value: (p) => String(p.requests), always: true },
  { label: (f) => f.t('users.columns.errors'), value: (p) => String(p.errors), always: true },
];

export interface UsersTableData {
  columns: string[];
  /** One row per level, ascending; the first cell is the level. */
  rows: { level: number; point?: ConcurrencyPoint; cells: string[] }[];
}

/**
 * Header and rows of the table: every level of `levels` and of the points, ascending; levels not
 * measured yet have dashes. Only the columns some point has.
 */
export function usersTable(points: readonly ConcurrencyPoint[], f: F, levels: readonly number[] = []): UsersTableData {
  const solo = soloDecode(points);
  const cols = COLUMNS.filter((c) => c.always || points.some((p) => c.value(p, f, solo) !== undefined));
  const all = [...new Set([...levels, ...points.map((p) => p.level)])].sort((a, b) => a - b);
  return {
    columns: [f.t('users.columns.users'), ...cols.map((c) => c.label(f))],
    rows: all.map((level) => {
      const point = points.find((p) => p.level === level);
      return { level, point, cells: [String(level), ...cols.map((c) => (point ? (c.value(point, f, solo) ?? '–') : '–'))] };
    }),
  };
}

/** The table, with the level in progress highlighted (live screen) and levels still to come muted. */
export function UsersTable({ caption, points, levels, current, framed }: { caption: string; points: readonly ConcurrencyPoint[]; levels?: readonly number[]; current?: number; framed?: boolean }) {
  const f = useI18n();
  const data = usersTable(points, f, levels);
  const columns: MeasureColumn[] = data.columns.map((label, i) => ({ label, numeric: i > 0 }));
  const rows: MeasureRow[] = data.rows.map((r) => ({ key: r.level, cells: r.cells, current: r.level === current, muted: r.point === undefined }));
  return <MeasureTable caption={caption} columns={columns} rows={rows} framed={framed} />;
}

/**
 * "Con 4 utenti ognuno legge a 1.900 tok/s e scrive a 43 tok/s (82% di quando è da solo); il primo
 * token arriva in 0,34 s (0,39 s nel caso peggiore). In tutto 155 tok/s."
 */
export function usersSentence(p: ConcurrencyPoint, solo: number | undefined, f: F): string {
  const { t, number, integer } = f;
  const write = number(p.perRequestDecodeTpsP50, 1);
  const one = p.level === 1;
  const parts = [
    p.perRequestPrefillTpsP50 === undefined
      ? t(one ? 'users.sentence.writeOne' : 'users.sentence.write', { n: p.level, write })
      : t(one ? 'users.sentence.readWriteOne' : 'users.sentence.readWrite', { n: p.level, read: integer(p.perRequestPrefillTpsP50), write }),
  ];
  if (solo && p.level > 1) parts.push(t('users.sentence.vsSolo', { pct: integer((100 * p.perRequestDecodeTpsP50) / solo) }));
  const first = t('users.sentence.firstToken', { p50: number(p.ttftP50Ms / 1000, 2), p95: number(p.ttftP95Ms / 1000, 2) });
  const total = t('users.sentence.total', { tps: integer(p.aggregateTps) });
  return `${parts.join(' ')}; ${first}. ${total}`;
}
