import { useNavigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { RunResult, Stat, ValidityFlag } from '../../../contract/results';
import { useI18n } from '../../i18n';
import { Callout } from '../ui/callout';
import { Card } from '../ui/card';
import { HelpTip } from '../ui/help-tip';
import { StatTile } from '../ui/stat-tile';
import { ContextSweepChart } from './context-sweep';
import { MIB_PER_GB } from './format';
import { kpisOf, READING_WORDS_PER_SEC, sentenceKey, type Kpis } from './kpis';
import { noteText } from './notes';
import { ConcurrencyChart, PromptChart, TimelineChart } from './result-charts';
import { LongConversations } from './result-sessions';
import { contextSweepOf } from './sessions-view';
import { validityBody } from './validity';

/** What each validity warning offers as a way forward. */
type FlagFix = 'rerun' | 'monitor' | 'settings' | 'engines';
const FLAG_FIX: Record<ValidityFlag, FlagFix> = {
  gpu_shared: 'rerun',
  throttling: 'monitor',
  cold_not_guaranteed: 'settings',
  cold_probably_cached: 'settings',
  output_not_exact: 'rerun',
  tokens_approximate: 'engines',
  slow_shared_filesystem: 'engines',
  energy_unavailable: 'monitor',
  unstable: 'rerun',
  vram_approximate: 'rerun',
};
const FLAG_TONE: Partial<Record<ValidityFlag, 'warning' | 'info'>> = { gpu_shared: 'warning', throttling: 'warning', unstable: 'warning', cold_probably_cached: 'warning' };

function ScoreCard({ k }: { k: Kpis }) {
  const { t, integer } = useI18n();
  const words = k.wordsPerSec;
  return (
    <Card className="hero-wash relative flex h-full flex-col overflow-hidden p-6 compact:p-5">
      <p className="flex items-center gap-1.5 text-sm font-medium text-fg-2">
        {t('metrics.score.label')}
        <HelpTip term={t('metrics.score.label')}>{t('metrics.score.help')}</HelpTip>
      </p>
      {k.score !== undefined ? (
        <p className="mt-1 flex items-baseline gap-3">
          <span className="bg-[linear-gradient(120deg,var(--fg)_30%,var(--accent-text))] bg-clip-text text-6xl font-semibold tracking-[-0.035em] text-transparent">
            {integer(k.score)}
          </span>
          <span className="text-sm text-fg-3">{t('result.scoreOf')}</span>
        </p>
      ) : (
        <p className="mt-2 text-sm text-fg-3">{t('result.noScore')}</p>
      )}
      {words === undefined ? (
        <p className="mt-3 text-lg leading-7 font-medium text-fg-2">{t('result.noSpeed')}</p>
      ) : (
        <>
          <p className="mt-3 text-lg leading-7 font-medium text-balance text-fg">{t(sentenceKey(words), { words: integer(words) })}</p>
          <div className="mt-4 flex flex-col gap-2.5" role="img" aria-label={t('result.readingCompare', { reading: READING_WORDS_PER_SEC, words: integer(words) })}>
            {[
              { label: t('result.you'), value: READING_WORDS_PER_SEC, cls: 'bg-fg-3' },
              { label: t('result.thisGpu'), value: words, cls: 'bg-[linear-gradient(90deg,var(--accent),var(--accent-2))]' },
            ].map((b) => (
              <div key={b.label} className="grid grid-cols-[84px_1fr_auto] items-center gap-3 text-xs">
                <span className="text-fg-2">{b.label}</span>
                <span className="h-2 overflow-hidden rounded-full bg-surface-3">
                  <span className={`block h-full rounded-full ${b.cls}`} style={{ width: `${Math.max(2, Math.min(100, (b.value / Math.max(words, READING_WORDS_PER_SEC)) * 100))}%` }} />
                </span>
                <span className="w-24 text-right font-medium text-fg tabular-nums">
                  {integer(b.value)} {t('units.wordsPerSec')}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
      {k.score !== undefined && <p className="mt-auto pt-4 text-xs text-fg-3">{t('result.scoreReference')}</p>}
    </Card>
  );
}

/** Duration, repetitions and stability: how much to trust the numbers, in plain words. */
function RunSummaryCard({ run }: { run: RunResult }) {
  const { t, duration, percent } = useI18n();
  const reps = run.scenario.steps.find((s) => s.kind === 'latency');
  // The same measurements the "unstable" flag looks at (generation and prompt reading), so the two never disagree.
  const cvs = run.metrics.latency.flatMap((p) => [p.decodeTps, p.prefillTps]).filter((s) => s.n > 1).map((s) => s.cv);
  const worst = cvs.length ? Math.max(...cvs) : undefined;
  const level = worst === undefined ? undefined : worst < 0.02 ? 'Good' : worst < 0.05 ? 'Ok' : 'Bad';
  const items: { label: string; value: ReactNode; help?: string }[] = [
    { label: t('result.summary.duration'), value: duration(Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.createdAt))) },
    { label: t('result.summary.repetitions'), value: reps?.kind === 'latency' ? t('result.summary.repetitionsValue', { n: reps.reps }) : '–' },
    {
      label: t('result.summary.stability'),
      help: t('result.summary.stabilityHelp'),
      value:
        level === undefined ? (
          '–'
        ) : (
          <span className={level === 'Good' ? 'text-success-text' : level === 'Ok' ? 'text-fg' : 'text-warning-text'}>
            {t(`result.summary.stability${level}`)} <span className="font-normal text-fg-3">· {percent(worst!, 1)}</span>
          </span>
        ),
    },
  ];
  return (
    <Card>
      <dl className="grid grid-cols-3 divide-x divide-border">
        {items.map((i) => (
          <div key={i.label} className="flex flex-col gap-1 px-card py-4">
            <dt className="flex items-center gap-1 text-xs text-fg-3">
              {i.label}
              {i.help && <HelpTip term={i.label}>{i.help}</HelpTip>}
            </dt>
            <dd className="text-md font-semibold text-fg tabular-nums">{i.value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function KpiGrid({ k, totalMiB }: { k: Kpis; totalMiB: number | undefined }) {
  const f = useI18n();
  const { t, number, integer, percent } = f;
  const cv = (s: Stat | undefined) => (s && s.n > 1 ? t('result.variation', { cv: percent(s.cv, 1) }) : undefined);
  const gb = (mib: number) => `${number(mib / MIB_PER_GB, 1)} GB`;
  const vramHint = [
    k.vram?.approximate ? t('result.vramApprox') : k.vram ? t('result.vramExact') : undefined,
    k.vramEstimateMiB !== undefined ? t('result.vramEstimate', { size: gb(k.vramEstimateMiB) }) : undefined,
    totalMiB ? t('result.vramOf', { size: gb(totalMiB) }) : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <section aria-label={t('result.kpis')} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatTile
        label={t('metrics.decode.label')}
        help={t('metrics.decode.help')}
        value={k.decode ? number(k.decode.median, 1) : '–'}
        unit="tok/s"
        hint={k.decode ? [`≈ ${integer(k.wordsPerSec!)} ${t('units.wordsPerSec')}`, cv(k.decode)].filter(Boolean).join(' · ') : undefined}
        {...(k.decode && k.decode.values.length > 1 ? { sparkline: k.decode.values } : {})}
      />
      <StatTile
        label={t('metrics.prefill.label')}
        help={t('metrics.prefill.help')}
        value={k.prefill ? integer(k.prefill.median) : '–'}
        unit="tok/s"
        hint={k.promptTokens === undefined ? undefined : t('result.promptOf', { n: integer(k.promptTokens) })}
        {...(k.prefill && k.prefill.values.length > 1 ? { sparkline: k.prefill.values } : {})}
      />
      <StatTile label={t('metrics.ttft.label')} help={t('metrics.ttft.help')} value={k.ttft ? integer(k.ttft.median) : '–'} unit="ms" hint={cv(k.ttft)} />
      <StatTile
        label={t('metrics.efficiency.label')}
        help={t('metrics.efficiency.help')}
        value={k.tokensPerJoule === undefined ? '–' : number(k.tokensPerJoule, 2)}
        unit="tok/J"
        hint={k.avgPowerW === undefined ? undefined : `${t('metrics.avgPower.label')} ${integer(k.avgPowerW)} W`}
      />
      <StatTile
        label={t('metrics.coldLoad.label')}
        help={t('metrics.coldLoad.help')}
        value={k.coldMs ? number(k.coldMs.median / 1000, 2) : '–'}
        unit="s"
        hint={k.coldReadBytesPerSec === undefined ? undefined : t('result.diskRead', { speed: `${f.bytes(k.coldReadBytesPerSec)}/s` })}
      />
      <StatTile label={t('metrics.warmLoad.label')} help={t('metrics.warmLoad.help')} value={k.warmMs ? number(k.warmMs.median / 1000, 2) : '–'} unit="s" hint={cv(k.warmMs)} />
      <StatTile
        label={t('metrics.vramPeak.label')}
        help={t('metrics.vramPeak.help')}
        value={k.vram ? number(k.vram.mib / MIB_PER_GB, 1) : '–'}
        unit="GB"
        hint={vramHint || undefined}
      />
      <StatTile
        label={t('metrics.concurrency.label')}
        help={t('metrics.concurrency.help')}
        value={k.concurrency ? integer(k.concurrency.aggregateTps) : '–'}
        unit="tok/s"
        hint={k.concurrency ? t('units.users', { n: k.concurrency.level }) : undefined}
      />
    </section>
  );
}

export interface OverviewProps {
  run: RunResult;
  onRerun: () => void;
  /** The failure card for failed/cancelled runs (rendered above everything). */
  errorCard?: ReactNode;
}

export function Overview({ run, onRerun, errorCard }: OverviewProps) {
  const f = useI18n();
  const { t } = f;
  const navigate = useNavigate();
  const k = kpisOf(run);
  const gpu = run.hardware.gpus[0];
  const fixes: Record<FlagFix, () => void> = {
    rerun: onRerun,
    monitor: () => void navigate({ to: '/monitor' }),
    settings: () => void navigate({ to: '/settings' }),
    engines: () => void navigate({ to: '/engines' }),
  };
  const hasWarnings = run.validity.length > 0 || run.notes.length > 0;
  return (
    <div className="flex flex-col gap-section">
      {errorCard}
      <div className={hasWarnings ? 'grid gap-section lg:grid-cols-12' : 'grid gap-section'}>
        <div className={hasWarnings ? 'flex flex-col gap-section lg:col-span-5' : 'grid gap-section lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]'}>
          <ScoreCard k={k} />
          <RunSummaryCard run={run} />
        </div>
        {hasWarnings && (
          <section aria-labelledby="validity-title" className="flex flex-col gap-3 lg:col-span-7">
            <h2 id="validity-title" className="text-md font-semibold tracking-[-0.01em]">
              {t('result.validityTitle')}
            </h2>
            {run.validity.map((flag) => (
              <Callout key={flag} tone={FLAG_TONE[flag] ?? 'info'} title={t(`validity.${flag}.title`)} action={{ label: t(`validity.${flag}.action`), onClick: fixes[FLAG_FIX[flag]] }}>
                {validityBody(run, flag, f)}
              </Callout>
            ))}
            {run.notes.map((n, i) => {
              const x = noteText(n, f);
              return (
                <Callout key={`${n.code}-${i}`} tone={x.tone === 'danger' ? 'warning' : x.tone} title={x.title}>
                  {x.body}
                </Callout>
              );
            })}
          </section>
        )}
      </div>
      <KpiGrid k={k} totalMiB={gpu?.memoryTotalMiB} />
      <LongConversations run={run} />
      {(run.metrics.latency.length > 0 || run.metrics.concurrency.length > 0) && (
        <div className="grid gap-section lg:grid-cols-2">
          {run.metrics.latency.length > 0 && <PromptChart points={run.metrics.latency} />}
          {run.metrics.concurrency.length > 0 && <ConcurrencyChart run={run} />}
        </div>
      )}
      {contextSweepOf(run).length > 0 && <ContextSweepChart points={contextSweepOf(run)} />}
      {run.telemetry && run.telemetry.t.length > 0 && <TimelineChart telemetry={run.telemetry} totalMiB={gpu?.memoryTotalMiB} powerLimitW={gpu?.powerLimitW} />}
    </div>
  );
}
