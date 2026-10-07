/**
 * Live screen of "Trova le impostazioni migliori": every launch so far as it happens (loaded, out of
 * memory, spilling into shared RAM, error), the largest context per KV cache as it becomes known,
 * and the speed-vs-context chart filling in.
 */
import { Check, CircleAlert, Loader, MemoryStick, TriangleAlert } from 'lucide-react';
import type { EngineKind } from '../../../contract/engines';
import type { TuneAttempt, Tuning } from '../../../contract/results';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/cn';
import type { TuneCurrent } from '../bench/live-state';
import { MIB_PER_GB } from '../bench/format';
import { MeasureTable, type MeasureRow } from '../bench/measure-table';
import { useConfigLabel } from '../presets/config-label';
import { Card } from '../ui/card';
import { HelpTip } from '../ui/help-tip';
import { TuneChart } from './tune-chart';
import { depthLabel, kvName, outcomeText, settingsText } from './tune-format';
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

export interface TuneLiveProps {
  tuning: Tuning | undefined;
  current: TuneCurrent | undefined;
  engineKind: EngineKind;
}

/** Attempts (newest first, the one in progress on top) and capacity side by side, then the chart. */
export function TuneLive({ tuning, current, engineKind }: TuneLiveProps) {
  const f = useI18n();
  const { t, number } = f;
  const label = useConfigLabel();
  const attempts = tuning?.attempts ?? [];
  const settings = (a: Pick<TuneAttempt, 'params'>) => settingsText(a.params, engineKind, label);
  const gb = (mib: number | undefined) => (mib === undefined ? '–' : number(mib / MIB_PER_GB, 1));
  const rows: MeasureRow[] = [
    ...(current
      ? [
          {
            key: 'current',
            current: true,
            cells: [
              <span key="o" className="inline-flex items-center gap-1.5 font-medium text-accent-text">
                <Loader aria-hidden className="size-4 animate-spin [animation-duration:2.4s]" />
                {t('tune.outcome.running')}
              </span>,
              depthLabel(current.contextSize, f),
              kvName(current.kvType, f),
              settings(current),
              gb(current.vramPeakMiB),
              '–',
            ],
          },
        ]
      : []),
    ...attempts
      .map((a, i) => {
        const p = lastPoint(a);
        return {
          key: i,
          muted: a.screen === 'lost',
          cells: [<Outcome key="o" a={a} />, depthLabel(a.contextSize, f), kvName(a.kvType, f), settings(a), gb(a.vramPeakMiB), p ? number(p.decodeTps.median, 1) : '–'],
        };
      })
      .reverse(),
  ];
  const combos = tuning ? measuredCombinations(tuning).length : 0;
  return (
    <div className="flex flex-col gap-section">
      <div className="grid gap-section xl:grid-cols-[minmax(0,1fr)_340px]">
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
                  { label: t('tune.columns.outcome') },
                  { label: t('tune.columns.context'), numeric: true },
                  { label: t('tune.columns.kv') },
                  { label: t('tune.columns.settings') },
                  { label: t('tune.columns.vram'), numeric: true },
                  { label: t('tune.columns.decode'), numeric: true },
                ]}
                rows={rows}
              />
            </div>
          ) : (
            <p className="px-card pb-card text-sm text-fg-3">{t('tune.live.noAttempts')}</p>
          )}
          <TuneGlossary className="border-t border-border px-card py-3" />
        </Card>
        <CapacityLive tuning={tuning} current={current} />
      </div>
      {tuning && combos > 0 && <TuneChart tuning={tuning} engineKind={engineKind} title={t('tune.chart.liveTitle')} help={t('tune.chart.help')} />}
    </div>
  );
}

/** The largest context per KV cache: measured, being searched now, estimated, or not tried (and why). */
function CapacityLive({ tuning, current }: { tuning: Tuning | undefined; current: TuneCurrent | undefined }) {
  const f = useI18n();
  const { t } = f;
  const list = tuning?.capacity ?? [];
  return (
    <Card className="flex flex-col overflow-hidden">
      <div className="flex items-center gap-1.5 px-card pt-card pb-3">
        <h2 className="text-md font-semibold tracking-[-0.01em]">{t('tune.capacity.liveTitle')}</h2>
        <HelpTip term={t('tune.help.kvTerm')}>{t('tune.help.kv')}</HelpTip>
      </div>
      {list.length ? (
        <ul className="flex flex-col divide-y divide-border border-t border-border">
          {list.map((c) => {
            const searching = current?.stage === 'capacity' && current.kvType === c.kvType;
            const status =
              c.measuredMax !== undefined
                ? depthLabel(c.measuredMax, f)
                : searching
                  ? t('tune.capacity.searching', { ctx: depthLabel(current.contextSize, f) })
                  : c.skipped
                    ? t(`tune.capacity.skipped.${c.skipped}`)
                    : t('tune.capacity.waiting');
            return (
              <li key={c.kvType} className="flex items-center justify-between gap-3 px-card py-3 text-sm">
                <span className="flex flex-col">
                  <span className="font-medium text-fg">{t('tune.capacity.cache', { kv: kvName(c.kvType, f) })}</span>
                  {c.predictedMax !== undefined && <span className="text-xs text-fg-3">{t('tune.capacity.estimate', { ctx: depthLabel(c.predictedMax, f) })}</span>}
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
