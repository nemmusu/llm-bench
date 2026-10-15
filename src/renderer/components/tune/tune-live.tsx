/**
 * Live screen of "Trova le impostazioni migliori": every launch so far as it happens (loaded, out of
 * memory, spilling into shared RAM, error) with the speed it measured and where, the largest context
 * per KV cache as it becomes known, and the speed-vs-context chart filling in.
 */
import { Check, CircleAlert, Loader, MemoryStick, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import type { EngineKind } from '../../../contract/engines';
import { fillsContext, TUNE_PROBE_DEPTH, type TuneAttempt, type Tuning } from '../../../contract/results';
import { useI18n, type Formatters } from '../../i18n';
import { cn } from '../../lib/cn';
import { contextShort, headerAt, tokensK } from '../../lib/speed-at';
import type { TuneCurrent } from '../bench/live-state';
import { MIB_PER_GB } from '../bench/format';
import { MeasureTable, type MeasureRow } from '../bench/measure-table';
import { useConfigLabel } from '../presets/config-label';
import { Card } from '../ui/card';
import { HelpTip } from '../ui/help-tip';
import { TuneChart } from './tune-chart';
import { depthLabel, kvName, launchPerUser, outcomeText, settingsText } from './tune-format';
import { lastPoint, measuredCombinations } from './tune-logic';
import { TuneGlossary } from './tune-sections';

const ICONS = { ok: Check, oom: MemoryStick, spill: TriangleAlert, error: CircleAlert } as const;
const TONES = { ok: 'text-success-text', oom: 'text-warning-text', spill: 'text-warning-text', error: 'text-danger-text' } as const;

function Outcome({ a }: { a: Pick<TuneAttempt, 'outcome' | 'screen' | 'error'> }) {
  const f = useI18n();
  const Icon = ICONS[a.outcome];
  return (
    <span className={cn('inline-flex items-center gap-1.5 font-medium', a.screen === 'lost' ? 'text-fg-3' : TONES[a.outcome])}>
      <Icon aria-hidden className="size-4 shrink-0" />
      {outcomeText(a, f)}
    </span>
  );
}

/**
 * The depth most attempts measured their speed at (the quick check after every start), said once in
 * the column's header; undefined when none was measured short of its context full.
 */
export function commonDepth(attempts: readonly Pick<TuneAttempt, 'points' | 'contextSize'>[]): number | undefined {
  const counts = new Map<number, number>();
  for (const a of attempts) {
    const p = lastPoint(a);
    if (p && !fillsContext(p.promptTokens, a.contextSize)) counts.set(p.promptTokens, (counts.get(p.promptTokens) ?? 0) + 1);
  }
  // The most frequent; in a tie the shallower (the quick check).
  return [...counts].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0]?.[0];
}

/**
 * The generation speed an attempt measured last. Measured at the header's depth (`depth`): the number
 * alone. Elsewhere, under it: "a 64K di contesto", or "a 256K, contesto pieno" when it filled the
 * launch's context (where a combination's speeds are read).
 */
export function attemptSpeed(a: Pick<TuneAttempt, 'points' | 'contextSize'>, f: Pick<Formatters, 't' | 'number' | 'integer'>, depth?: number): ReactNode {
  const p = lastPoint(a);
  if (!p) return '–';
  const full = fillsContext(p.promptTokens, a.contextSize);
  if (!full && p.promptTokens === depth) return f.number(p.decodeTps.median, 1);
  const at = full ? f.t('tune.live.atFull', { tokens: tokensK(a.contextSize, f) }) : contextShort({ kind: 'write', tokens: p.promptTokens, basis: 'depth' }, f);
  return (
    <span className="inline-flex flex-col items-end leading-5">
      <span>{f.number(p.decodeTps.median, 1)}</span>
      <span className="text-xs text-fg-3">{at}</span>
    </span>
  );
}

export interface TuneLiveProps {
  tuning: Tuning | undefined;
  current: TuneCurrent | undefined;
  engineKind: EngineKind;
}

/**
 * Attempts (newest first, the one in progress on top) and the largest context per cache: side by side
 * when the screen has room for both, else the capacity below the table. Then the chart.
 */
export function TuneLive({ tuning, current, engineKind }: TuneLiveProps) {
  const f = useI18n();
  const { t, number } = f;
  const label = useConfigLabel();
  const attempts = tuning?.attempts ?? [];
  // The configuration says the KV cache itself: no column of its own (the table fits a normal window).
  const settings = (a: Pick<TuneAttempt, 'params'>) => settingsText(a.params, engineKind, label);
  const gb = (mib: number | undefined) => (mib === undefined ? '–' : number(mib / MIB_PER_GB, 1));
  // Where most speeds were measured (the quick check after every start): said once, in the header.
  const depth = commonDepth(attempts);
  const decode = t('tune.columns.decode');
  const rows: MeasureRow[] = [
    ...(current
      ? [
          {
            key: 'current',
            current: true,
            cells: [
              <span key="o" className="inline-flex items-center gap-1.5 font-medium text-accent-text">
                <Loader aria-hidden className="size-4 shrink-0 animate-spin [animation-duration:2.4s]" />
                {t('tune.outcome.running')}
              </span>,
              depthLabel(current.contextSize, f),
              settings(current),
              gb(current.vramPeakMiB),
              '–',
            ],
          },
        ]
      : []),
    ...attempts
      .map((a, i) => ({
        key: i,
        muted: a.screen === 'lost',
        cells: [<Outcome key="o" a={a} />, depthLabel(a.contextSize, f), settings(a), gb(a.vramPeakMiB), attemptSpeed(a, f, depth)],
      }))
      .reverse(),
  ];
  const combos = tuning ? measuredCombinations(tuning).length : 0;
  return (
    <div className="flex flex-col gap-section">
      <div className="grid gap-section @6xl/page:grid-cols-[minmax(0,1fr)_320px]">
        <Card className="flex min-w-0 flex-col overflow-hidden">
          <div className="flex items-center gap-1.5 px-card pt-card pb-3">
            <h2 className="text-md font-semibold tracking-[-0.01em]">{t('tune.live.attempts')}</h2>
            <HelpTip term={t('tune.live.attempts')}>{t('tune.live.attemptsHelp')}</HelpTip>
            <span className="ml-auto text-sm text-fg-3 tabular-nums">{t('tune.live.count', { n: attempts.length, max: tuning?.maxLaunches ?? '–' })}</span>
          </div>
          {rows.length ? (
            <div className="border-t border-border">
              <MeasureTable
                className="max-h-96 overflow-y-auto"
                caption={t('tune.live.attempts')}
                columns={[
                  { label: t('tune.columns.outcome'), wrap: true },
                  { label: t('tune.columns.startContext'), numeric: true, help: t('tune.live.contextHelp') },
                  { label: t('tune.columns.settings'), wrap: true },
                  { label: t('tune.columns.vram'), numeric: true },
                  depth === undefined
                    ? { label: decode, numeric: true, help: t('tune.live.decodeHelpEach') }
                    : {
                        label: headerAt(decode, depth, f),
                        numeric: true,
                        help: t(depth === TUNE_PROBE_DEPTH ? 'tune.live.decodeHelpProbe' : 'tune.live.decodeHelpDepth', { tokens: tokensK(depth, f) }),
                      },
                ]}
                rows={rows}
              />
            </div>
          ) : (
            <p className="px-card pb-card text-sm text-fg-3">{t('tune.live.noAttempts')}</p>
          )}
          <TuneGlossary className="border-t border-border px-card py-3" engineKind={engineKind} tuning={tuning} />
        </Card>
        <CapacityLive tuning={tuning} current={current} engineKind={engineKind} />
      </div>
      {tuning && combos > 0 && <TuneChart tuning={tuning} engineKind={engineKind} title={t('tune.chart.liveTitle')} help={t('tune.chart.help')} />}
    </div>
  );
}

/**
 * The largest context per KV cache: measured, being searched now, estimated, or not tried (and why).
 * "Più utenti" with the context per user "Massimo": the context of each user ("32K a testa").
 */
function CapacityLive({ tuning, current, engineKind }: { tuning: Tuning | undefined; current: TuneCurrent | undefined; engineKind: EngineKind }) {
  const f = useI18n();
  const { t } = f;
  const list = tuning?.capacity ?? [];
  const perUser = tuning?.multi?.perUserContext === 'max';
  const ctxOf = (n: number) => (perUser ? t('tune.capacity.perUser', { ctx: depthLabel(n, f) }) : depthLabel(n, f));
  return (
    <Card className="flex flex-col self-start overflow-hidden">
      <div className="flex items-center gap-1.5 px-card pt-card pb-3">
        <h2 className="text-md font-semibold tracking-[-0.01em]">{t(perUser ? 'tune.capacity.liveTitlePerUser' : 'tune.capacity.liveTitle')}</h2>
        <HelpTip term={t('tune.help.kvTerm')}>{t('tune.help.kv')}</HelpTip>
      </div>
      {list.length ? (
        // Below the table (a narrower window): the caches side by side; beside it, one under the other.
        <ul className="grid @3xl/page:grid-cols-[repeat(auto-fit,minmax(14rem,1fr))] @6xl/page:grid-cols-1">
          {list.map((c) => {
            const searching = current?.stage === 'capacity' && current.kvType === c.kvType;
            const status =
              c.measuredMax !== undefined
                ? ctxOf(c.measuredMax)
                : searching
                  ? t('tune.capacity.searching', { ctx: perUser ? ctxOf(launchPerUser(engineKind, current.contextSize, current.params.parallel)) : depthLabel(current.contextSize, f) })
                  : c.skipped
                    ? t(`tune.capacity.skipped.${c.skipped}`)
                    : t('tune.capacity.waiting');
            return (
              <li key={c.kvType} className="flex items-center justify-between gap-3 border-t border-border px-card py-3 text-sm">
                <span className="flex flex-col">
                  <span className="font-medium text-fg">{t('tune.capacity.cache', { kv: kvName(c.kvType, f) })}</span>
                  {c.predictedMax !== undefined && <span className="text-xs text-fg-3">{t('tune.capacity.estimate', { ctx: ctxOf(c.predictedMax) })}</span>}
                </span>
                <span className={cn('text-right tabular-nums', c.measuredMax !== undefined ? 'text-md font-semibold text-fg' : searching ? 'text-accent-text' : 'text-fg-3')}>{status}</span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="px-card pb-card text-sm text-fg-3">{t('tune.capacity.liveWaiting')}</p>
      )}
    </Card>
  );
}
