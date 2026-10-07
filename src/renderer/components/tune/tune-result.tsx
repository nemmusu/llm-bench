import { useMemo, useState, type ReactNode } from 'react';
import type { RunResult, Tuning } from '../../../contract/results';
import { useI18n } from '../../i18n';
import { MIB_PER_GB, prefillStat } from '../bench/format';
import { useConfigLabel } from '../presets/config-label';
import { PresetActions } from '../presets/preset-actions';
import { Badge } from '../ui/badge';
import { Callout } from '../ui/callout';
import { Card } from '../ui/card';
import { HelpTip } from '../ui/help-tip';
import { TuneChart } from './tune-chart';
import { capacitySentence, comboText, depthLabel, recommendedOf, speedSentence } from './tune-format';
import { deepestPoint, defaultDepth, depthOptions, rankAt } from './tune-logic';
import { TuneRanking } from './tune-ranking';
import { CapacityCard, DiscardedAttempts } from './tune-sections';

export type TunedRun = RunResult & { tuning: Tuning };

/**
 * Result of "Trova le impostazioni migliori", top to bottom: the summary sentence (numbers only) and
 * the recommended combination, speed against context per combination, the ranking table (the main
 * element), the discarded launches and the capacity per KV cache type.
 */
export function TuneOverview({ run, errorCard }: { run: TunedRun; errorCard?: ReactNode }) {
  const f = useI18n();
  const { t } = f;
  const tuning = run.tuning;
  const kind = run.engine.kind;
  const label = useConfigLabel();
  const depths = useMemo(() => depthOptions(tuning), [tuning]);
  const [picked, setPicked] = useState<number | undefined>(undefined);
  const depth = picked ?? defaultDepth(tuning, depths);
  const rows = useMemo(() => (depth === undefined ? [] : rankAt(tuning, depth)), [tuning, depth]);
  const rec = recommendedOf(tuning);
  const order = useMemo(() => rows.map((r) => r.index), [rows]);
  const sentences = [capacitySentence(tuning, f), speedSentence(tuning, kind, label, f)].filter(Boolean);

  return (
    <div className="flex flex-col gap-section">
      {errorCard}
      <Card className="hero-wash p-7 compact:p-5">
        <p className="text-xs font-semibold tracking-wide text-fg-3 uppercase">{t('tune.summary.title')}</p>
        <p className="mt-2 text-xl leading-8 font-medium tracking-[-0.01em] text-balance text-fg">{sentences.length ? sentences.join(' ') : t('tune.summary.none')}</p>
        {tuning.stoppedBy && (
          <Callout className="mt-4" tone="info" title={t(`tune.stopped.${tuning.stoppedBy}`)}>
            {t('tune.stopped.body', { n: tuning.attempts.length })}
          </Callout>
        )}
        {rec && <RecommendedCard run={run} index={rec.index} text={comboText(rec.combo, kind, label)} />}
      </Card>

      {rows.length > 0 && (
        <TuneChart
          tuning={tuning}
          engineKind={kind}
          order={order}
          {...(rec ? { recommended: rec.index } : {})}
          {...(depth === undefined ? {} : { marker: depth })}
          title={t('tune.chart.title')}
          help={t('tune.chart.help')}
        />
      )}

      {depth !== undefined && rows.length > 0 ? (
        <TuneRanking run={run} rows={rows} depth={depth} depths={depths} onDepth={setPicked} recommended={rec?.index} />
      ) : (
        <Card className="p-card text-sm text-fg-2">{t('tune.ranking.empty')}</Card>
      )}

      <DiscardedAttempts tuning={tuning} engineKind={kind} />
      <CapacityCard tuning={tuning} />
    </div>
  );
}

/** "Consigliata": the fastest of those reaching the largest context, its numbers and the two ways to use it. */
function RecommendedCard({ run, index, text }: { run: TunedRun; index: number; text: string }) {
  const f = useI18n();
  const { t, number, integer } = f;
  const combo = run.tuning.combinations[index]!;
  const deep = deepestPoint(combo);
  const stats = [
    { label: t('tune.rec.context'), value: depthLabel(combo.maxContext, f), help: t('tune.help.context') },
    ...(deep
      ? [
          { label: t('tune.rec.decodeAt', { depth: depthLabel(deep.promptTokens, f) }), value: `${number(deep.decodeTps.median, 1)} tok/s` },
          { label: t('tune.rec.prefillAt', { depth: depthLabel(deep.promptTokens, f) }), value: `${integer(prefillStat(deep).median)} tok/s` },
        ]
      : []),
    ...(combo.vramPeakMiB === undefined ? [] : [{ label: t('tune.rec.vram'), value: `${number(combo.vramPeakMiB / MIB_PER_GB, 1)} GB` }]),
  ];
  return (
    <section aria-label={t('tune.rec.title')} className="mt-5 flex flex-col gap-4 rounded-lg border border-accent/30 bg-surface/70 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="accent">{t('tune.recommended')}</Badge>
        <HelpTip term={t('tune.recommended')}>{t('tune.rec.help')}</HelpTip>
        <span className="text-md font-semibold text-fg">{text}</span>
      </div>
      <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2 xl:grid-cols-4">
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
      <div>
        <PresetActions run={run} combo={index} />
      </div>
    </section>
  );
}
