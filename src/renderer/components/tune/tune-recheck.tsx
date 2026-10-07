/**
 * "Ricontrollo rapido": the previous recommendation and its runner-up loaded again with the engine
 * version in use now. What happened in words, then for each one a "Prima / Ora" table per measure
 * (units in the headers), each difference worded as on the Compare page and marked beyond or within
 * the measurement noise (the core decides that). A full search is offered whenever anything changed.
 */
import type { ReactNode } from 'react';
import { nominalDepth, type ConcurrencyPoint, type LatencyPoint, type RunResult, type TuneCombination, type TuneRecheck, type Tuning } from '../../../contract/results';
import { useI18n, type Formatters, type MessageKey } from '../../i18n';
import { deltaWords, type DeltaKind } from '../bench/compare-words';
import { prefillStat } from '../bench/format';
import { MeasureTable } from '../bench/measure-table';
import { useConfigLabel } from '../presets/config-label';
import { Badge } from '../ui/badge';
import { Callout, type CalloutTone } from '../ui/callout';
import { Card } from '../ui/card';
import { HelpTip } from '../ui/help-tip';
import { buildLabel, comboText, depthLabel, outcomeText } from './tune-format';
import { DiscardedAttempts } from './tune-sections';

type Check = TuneRecheck['checks'][number];
type Metric = Check['moved'][number]['metric'];
type F = Pick<Formatters, 't' | 'number' | 'integer' | 'percent'>;

/** One "Prima / Ora" row: where, which measure (its unit in the label), both values, the difference in words. */
export interface RecheckRow {
  key: string;
  at: string;
  metric: string;
  before: string;
  after: string;
  change: string;
  /** Beyond the measurement noise (the core's rule). */
  moved: boolean;
}

interface MetricSpec {
  metric: Metric;
  higherIsBetter: boolean;
  kind: DeltaKind;
  /** Seconds for times, tok/s for speeds. */
  format: (v: number, f: F) => string;
}

const SINGLE: readonly (MetricSpec & { value: (p: LatencyPoint) => number })[] = [
  { metric: 'decode', higherIsBetter: true, kind: 'speed', value: (p) => p.decodeTps.median, format: (v, f) => f.number(v, 1) },
  { metric: 'prefill', higherIsBetter: true, kind: 'speed', value: (p) => prefillStat(p).median, format: (v, f) => f.integer(v) },
  { metric: 'ttft', higherIsBetter: false, kind: 'time', value: (p) => p.ttftMs.median, format: (v, f) => f.number(v / 1000, 2) },
];

const USERS: readonly (MetricSpec & { value: (p: ConcurrencyPoint) => number })[] = [
  { metric: 'perUserDecode', higherIsBetter: true, kind: 'speed', value: (p) => p.perRequestDecodeTpsP50, format: (v, f) => f.number(v, 1) },
  { metric: 'aggregate', higherIsBetter: true, kind: 'speed', value: (p) => p.aggregateTps, format: (v, f) => f.integer(v) },
  { metric: 'ttftP95', higherIsBetter: false, kind: 'time', value: (p) => p.ttftP95Ms, format: (v, f) => f.number(v / 1000, 2) },
];

/**
 * The "Prima / Ora" rows of a check: every depth (goal "Più utenti": every level) measured both times,
 * the measures in a fixed order. Empty when it was not measured again.
 */
export function recheckRows(check: Check, now: TuneCombination | undefined, f: F): RecheckRow[] {
  if (!now) return [];
  const moved = new Set(check.moved.map((m) => `${m.at}|${m.metric}`));
  const row = (at: number, atText: string, spec: MetricSpec, a: number, b: number): RecheckRow => ({
    key: `${at}|${spec.metric}`,
    at: atText,
    metric: f.t(`tune.recheck.metrics.${spec.metric}` as MessageKey),
    before: spec.format(a, f),
    after: spec.format(b, f),
    change: deltaWords(a, b, { higherIsBetter: spec.higherIsBetter, kind: spec.kind }, f)?.text ?? '–',
    moved: moved.has(`${at}|${spec.metric}`),
  });
  if (now.concurrency?.length) {
    return now.concurrency.flatMap((p) => {
      const q = check.previous.concurrency?.find((x) => x.level === p.level);
      return q ? USERS.map((spec) => row(p.level, String(p.level), spec, spec.value(q), spec.value(p))) : [];
    });
  }
  return now.sweep.flatMap((p) => {
    const at = nominalDepth(p.promptTokens);
    const q = check.previous.sweep.find((x) => nominalDepth(x.promptTokens) === at);
    return q ? SINGLE.map((spec) => row(at, depthLabel(at, f), spec, spec.value(q), spec.value(p))) : [];
  });
}

const RESULT_KEY: Record<TuneRecheck['result'], MessageKey> = {
  same: 'tune.recheck.same',
  changed: 'tune.recheck.changed',
  'no-longer-fits': 'tune.recheck.noLongerFits',
  incomplete: 'tune.recheck.incomplete',
};
const RESULT_TONE: Record<TuneRecheck['result'], CalloutTone> = { same: 'success', changed: 'info', 'no-longer-fits': 'warning', incomplete: 'warning' };

/** What the recheck found, in words (builds as people read them, the previous test's date). */
export function recheckSentence(r: TuneRecheck, f: Pick<Formatters, 't' | 'dateTime'>): string {
  return f.t(RESULT_KEY[r.result], { current: buildLabel(r.currentBuild, f), previous: buildLabel(r.previousBuild, f), date: f.dateTime(r.previousCreatedAt) });
}

export function RecheckOverview({ run, errorCard, onFullSearch }: { run: RunResult & { tuning: Tuning }; errorCard?: ReactNode; onFullSearch?: (() => void) | undefined }) {
  const f = useI18n();
  const { t } = f;
  const recheck = run.tuning.recheck as TuneRecheck;
  return (
    <div className="flex flex-col gap-section">
      {errorCard}
      <Card className="hero-wash p-7 compact:p-5">
        <p className="inline-flex items-center gap-1.5 text-xs font-semibold tracking-wide text-fg-3 uppercase">
          {t('tune.recheck.title')}
          <HelpTip term={t('tune.recheck.title')}>{t('tune.recheck.help')}</HelpTip>
        </p>
        <Callout
          className="mt-3"
          tone={RESULT_TONE[recheck.result]}
          title={recheckSentence(recheck, f)}
          {...(recheck.suggestFull && onFullSearch ? { action: { label: t('tune.recheck.fullSearch'), onClick: onFullSearch } } : {})}
        >
          {recheck.suggestFull ? t('tune.recheck.fullSearchHelp') : undefined}
        </Callout>
      </Card>
      {recheck.checks.map((c) => (
        <CheckCard key={c.role} check={c} run={run} />
      ))}
      <DiscardedAttempts tuning={run.tuning} engineKind={run.engine.kind} />
    </div>
  );
}

function CheckCard({ check, run }: { check: Check; run: RunResult & { tuning: Tuning } }) {
  const f = useI18n();
  const { t } = f;
  const label = useConfigLabel();
  const kind = run.engine.kind;
  const now = check.combination === undefined ? undefined : run.tuning.combinations[check.combination];
  const text = comboText(check.previous, kind, label);
  const rows = recheckRows(check, now, f);
  const users = Boolean((now ?? check.previous).concurrency?.length);
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 px-card pt-card">
        <Badge tone={check.role === 'recommended' ? 'accent' : 'neutral'}>{t(check.role === 'recommended' ? 'tune.recheck.recommended' : 'tune.recheck.runnerUp')}</Badge>
        <span className="text-md font-semibold text-fg">{text}</span>
        <span className="text-sm text-fg-2">{depthLabel(check.previous.maxContext, f)}</span>
      </div>
      {rows.length ? (
        <div className="mt-3">
          <MeasureTable
            caption={t('tune.recheck.caption', { settings: text })}
            columns={[
              { label: t(users ? 'tune.recheck.columns.atUsers' : 'tune.recheck.columns.at') },
              { label: t('tune.recheck.columns.metric') },
              { label: t('tune.recheck.columns.before'), numeric: true },
              { label: t('tune.recheck.columns.after'), numeric: true },
              { label: t('tune.recheck.columns.change'), numeric: true },
              { label: t('tune.recheck.columns.noise') },
            ]}
            rows={rows.map((r) => ({
              key: r.key,
              cells: [r.at, r.metric, r.before, r.after, r.change, <span key="n" className={r.moved ? 'font-medium text-fg' : 'text-fg-3'}>{t(r.moved ? 'tune.recheck.moved' : 'tune.recheck.withinNoise')}</span>],
            }))}
          />
          <p className="px-card py-3 text-xs text-fg-3">{t('tune.recheck.noiseHelp')}</p>
        </div>
      ) : (
        <p className="px-card py-4 text-sm text-fg-2">
          {check.outcome === undefined ? t('tune.recheck.notLaunched') : t('tune.recheck.notLoaded', { outcome: outcomeText({ outcome: check.outcome }, f) })}
        </p>
      )}
    </Card>
  );
}
