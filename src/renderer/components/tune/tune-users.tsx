/**
 * "Trova le impostazioni migliori", goal "Più utenti": the summary in numbers, the recommended
 * configuration (the most generation speed for each user with every user busy), the ranking of every
 * configuration measured, the conversations of the recommended one and the discarded launches.
 */
import { useMemo, type ReactNode } from 'react';
import type { EngineKind } from '../../../contract/engines';
import type { ConcurrencyPoint, RunResult, Tuning } from '../../../contract/results';
import { useI18n, type Formatters } from '../../i18n';
import { soloDecode, usersSentence } from '../bench/concurrency-users';
import { MIB_PER_GB } from '../bench/format';
import { LongConversations } from '../bench/result-sessions';
import { useConfigLabel } from '../presets/config-label';
import { Badge } from '../ui/badge';
import { Card } from '../ui/card';
import { HelpTip } from '../ui/help-tip';
import { comboText, depthLabel, kvName, type LabelFn } from './tune-format';
import { perUserContextOf, rankUsers, USERS_COLUMNS, usersLevel, type RankRow } from './tune-logic';
import { TuneRanking, type ColumnView } from './tune-ranking';
import { DiscardedAttempts, StoppedNote } from './tune-sections';

type TunedRun = RunResult & { tuning: Tuning };

type F = Pick<Formatters, 't' | 'number' | 'integer'>;

/** The columns of a "Più utenti" search, each with its unit in the header. */
export const USERS_VIEWS: readonly ColumnView[] = [
  { column: USERS_COLUMNS[0]!, header: 'tune.users.columns.perUser', format: (v, f) => f.number(v, 1) },
  { column: USERS_COLUMNS[1]!, header: 'tune.users.columns.total', format: (v, f) => f.integer(v) },
  { column: USERS_COLUMNS[2]!, header: 'tune.users.columns.ttftP95', format: (v, f) => f.duration(v) },
  { column: USERS_COLUMNS[3]!, header: 'tune.users.columns.perUserContext', format: (v, f) => f.integer(v) },
  { column: USERS_COLUMNS[4]!, header: 'tune.users.columns.vram', format: (v, f) => f.number(v / MIB_PER_GB, 1) },
];

/** "f16 8K, q8_0 16K, q4_0 32K": the largest context each user had with every KV cache that held them ("Massimo"). */
export function perKvList(tuning: Pick<Tuning, 'capacity'>, f: Pick<Formatters, 't' | 'number' | 'integer'>): string | undefined {
  const held = tuning.capacity.filter((c) => c.measuredMax !== undefined);
  return held.length ? held.map((c) => `${kvName(c.kvType, f)} ${depthLabel(c.measuredMax as number, f)}`).join(', ') : undefined;
}

/**
 * "Con 4 utenti da 8K a testa la più veloce per utente è …. Con 4 utenti ognuno legge a … e scrive a …"
 * (numbers only); the fewer users that fitted, or nothing measured, said first. "Massimo": how much
 * context each user can have (the recommended configuration's), and with every cache.
 */
export function usersSummary(tuning: Tuning, rows: readonly RankRow[], kind: EngineKind, label: LabelFn, f: F): string {
  const multi = tuning.multi as NonNullable<Tuning['multi']>;
  const top = rows[0];
  const max = multi.perUserContext === 'max';
  // "Massimo": the context of the recommended configuration (the largest), else the largest that held the users (none: nothing to say).
  const held = tuning.capacity.flatMap((c) => (c.measuredMax === undefined ? [] : [c.measuredMax]));
  const perUser = max ? (top?.combo.perUserContext ?? (held.length ? Math.max(...held) : undefined)) : (multi.perUserContext as number);
  const ctx = perUser === undefined ? '' : depthLabel(perUser, f);
  const parts: string[] = [];
  if (multi.fittingUsers !== undefined) parts.push(f.t('tune.users.fitting', { ctx, n: multi.fittingUsers, asked: multi.users }));
  if (!top?.users) {
    parts.push(max ? f.t('tune.users.noneMax', { users: multi.fittingUsers ?? multi.users }) : f.t('tune.users.none', { users: multi.fittingUsers ?? multi.users, ctx }));
    return parts.join(' ');
  }
  const settings = comboText(top.combo, kind, label);
  parts.push(f.t(max ? 'tune.users.bestMax' : 'tune.users.best', { users: top.users.level, ctx, settings }));
  const list = max && multi.fittingUsers === undefined ? perKvList(tuning, f) : undefined;
  if (list) parts.push(f.t('tune.users.perKv', { list }));
  // A row measured with every user busy has its levels.
  parts.push(usersSentence(top.users, soloDecode(top.combo.concurrency as ConcurrencyPoint[]), f));
  return parts.join(' ');
}

export function UsersOverview({ run, errorCard }: { run: TunedRun; errorCard?: ReactNode }) {
  const f = useI18n();
  const { t } = f;
  const tuning = run.tuning;
  const kind = run.engine.kind;
  const label = useConfigLabel();
  const rows = useMemo(() => rankUsers(tuning), [tuning]);
  const n = usersLevel(tuning) as number;
  const multi = tuning.multi as NonNullable<Tuning['multi']>;
  const top = rows[0]?.users ? rows[0] : undefined;
  return (
    <div className="flex flex-col gap-section">
      {errorCard}
      <Card className="hero-wash p-7 compact:p-5">
        <p className="text-xs font-semibold tracking-wide text-fg-3 uppercase">{t('tune.summary.title')}</p>
        <p className="mt-2 max-w-[72ch] text-lg leading-7 font-medium tracking-[-0.01em] text-pretty text-fg">{usersSummary(tuning, rows, kind, label, f)}</p>
        {tuning.stoppedBy && <StoppedNote tuning={tuning} />}
        {top && <UsersRecommended row={top} n={n} text={comboText(top.combo, kind, label)} max={multi.perUserContext === 'max'} />}
      </Card>
      {top ? (
        <TuneRanking
          run={run}
          rows={rows}
          depths={[]}
          recommended={tuning.recommended}
          views={USERS_VIEWS}
          subtitle={multi.promptTokens === undefined ? t('tune.users.subtitleMax', { n }) : t('tune.users.subtitle', { n, prompt: f.integer(multi.promptTokens) })}
          caption={t('tune.users.caption', { n })}
        />
      ) : (
        <Card className="p-card text-sm text-fg-2">{t('tune.ranking.empty')}</Card>
      )}
      {/* The run's own conversations are those of the recommended configuration. */}
      <LongConversations run={run} />
      <DiscardedAttempts tuning={tuning} engineKind={kind} />
    </div>
  );
}

/** "Consigliata" for every user busy: context per user, each one's generation, the total, the slowest first token, memory. */
function UsersRecommended({ row, n, text, max }: { row: RankRow; n: number; text: string; max: boolean }) {
  const f = useI18n();
  const { t, number, integer } = f;
  const p = row.users!;
  const context = perUserContextOf(row);
  const stats = [
    ...(context === undefined ? [] : [{ label: t('tune.users.perUserContext'), value: `${integer(context)} ${t('results.tokens')}`, help: t('tune.help.context') }]),
    { label: t('tune.users.perUser', { n }), value: `${number(p.perRequestDecodeTpsP50, 1)} tok/s` },
    { label: t('tune.users.total', { n }), value: `${integer(p.aggregateTps)} tok/s` },
    { label: t('tune.users.ttftP95', { n }), value: f.duration(p.ttftP95Ms) },
    ...(row.combo.vramPeakMiB === undefined ? [] : [{ label: t('tune.rec.vram'), value: `${number(row.combo.vramPeakMiB / MIB_PER_GB, 1)} GB` }]),
  ];
  return (
    <section aria-label={t('tune.rec.title')} className="mt-5 flex flex-col gap-4 rounded-lg border border-accent/30 bg-surface/70 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="accent">{t('tune.recommended')}</Badge>
        <HelpTip term={t('tune.recommended')}>{t(max ? 'tune.users.recHelpMax' : 'tune.users.recHelp')}</HelpTip>
        <span className="text-md font-semibold text-fg">{text}</span>
      </div>
      <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2 xl:grid-cols-5">
        {stats.map((s) => (
          <div key={s.label} className="flex flex-col gap-0.5">
            <dt className="inline-flex items-center gap-1 text-xs text-fg-3">
              {s.label}
              {s.help && <HelpTip term={s.label}>{s.help}</HelpTip>}
            </dt>
            <dd className="text-lg font-semibold text-fg tabular-nums">{s.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
