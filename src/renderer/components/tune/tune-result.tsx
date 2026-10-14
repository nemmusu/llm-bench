import { useMemo, useState, type ReactNode } from 'react';
import { fullContextPoint, nominalDepth, type LatencyPoint, type RunResult, type Tuning } from '../../../contract/results';
import { useI18n } from '../../i18n';
import { tooltipHead } from '../../lib/speed-at';
import { MIB_PER_GB, prefillStat } from '../bench/format';
import { useConfigLabel } from '../presets/config-label';
import { Badge } from '../ui/badge';
import { Card } from '../ui/card';
import { HelpTip } from '../ui/help-tip';
import { TuneChart } from './tune-chart';
import { capacitySentence, comboText, depthLabel, recommendedOf, speedSentence } from './tune-format';
import { AT_MAX, deepestPoint, depthOptions, rankAt, rankAtMax, withRunEnd, type CompareAt } from './tune-logic';
import { RecheckOverview } from './tune-recheck';
import { TuneRanking } from './tune-ranking';
import { UsersOverview } from './tune-users';
import { CapacityCard, DiscardedAttempts, PartialBadge, StoppedNote } from './tune-sections';

export type TunedRun = RunResult & { tuning: Tuning };

export interface TuneOverviewProps {
  run: TunedRun;
  errorCard?: ReactNode;
  /** "Fai la ricerca completa" after a "Ricontrollo rapido" that found something different. */
  onFullSearch?: () => void;
}

/**
 * Result of "Trova le impostazioni migliori": a "Ricontrollo rapido" (before and now), goal
 * "Più utenti" (every user busy), else the one-user search with the largest context. A run cancelled
 * or failed before the search recorded why is read as the search records it now (withRunEnd).
 */
export function TuneOverview({ run: saved, errorCard, onFullSearch }: TuneOverviewProps) {
  const run = useMemo(() => ({ ...saved, tuning: withRunEnd(saved.tuning, saved.status) }), [saved]);
  const extra = errorCard ? { errorCard } : {};
  if (run.tuning.recheck) return <RecheckOverview run={run} {...extra} onFullSearch={onFullSearch} />;
  if (run.tuning.goal === 'multi') return <UsersOverview run={run} {...extra} />;
  return <ContextOverview run={run} {...extra} />;
}

/** "Nessuna combinazione…" in the words of how the search ended. */
const NONE = { cancelled: 'tune.summary.noneCancelled', failed: 'tune.summary.noneFailed' } as const;

/**
 * One user, the largest context, top to bottom: the summary sentence (numbers only) and the
 * recommended combination, speed against context per combination, the ranking table (the main
 * element; by default every combination with its own largest context full), the discarded launches
 * and the capacity per KV cache type.
 */
function ContextOverview({ run, errorCard }: { run: TunedRun; errorCard?: ReactNode }) {
  const f = useI18n();
  const { t } = f;
  const tuning = run.tuning;
  const kind = run.engine.kind;
  const label = useConfigLabel();
  const depths = useMemo(() => depthOptions(tuning), [tuning]);
  const [depth, setDepth] = useState<CompareAt>(AT_MAX);
  const rows = useMemo(() => (depth === AT_MAX ? rankAtMax(tuning) : rankAt(tuning, depth)), [tuning, depth]);
  const rec = recommendedOf(tuning);
  const order = useMemo(() => rows.map((r) => r.index), [rows]);
  const sentences = [capacitySentence(tuning, f), speedSentence(tuning, kind, label, f)].filter(Boolean);

  return (
    <div className="flex flex-col gap-section">
      {errorCard}
      <Card className="hero-wash p-7 compact:p-5">
        <p className="text-xs font-semibold tracking-wide text-fg-3 uppercase">{t('tune.summary.title')}</p>
        <p className="mt-2 max-w-[72ch] text-lg leading-7 font-medium tracking-[-0.01em] text-pretty text-fg">
          {sentences.length ? sentences.join(' ') : t(tuning.stoppedBy === 'cancelled' || tuning.stoppedBy === 'failed' ? NONE[tuning.stoppedBy] : 'tune.summary.none')}
        </p>
        {tuning.stoppedBy && <StoppedNote tuning={tuning} validity={run.validity} />}
        {rec && <RecommendedCard run={run} index={rec.index} text={comboText(rec.combo, kind, label)} />}
      </Card>

      {rows.length > 0 && (
        <TuneChart
          tuning={tuning}
          engineKind={kind}
          order={order}
          // Something was measured: there is a recommendation.
          recommended={rec!.index}
          // At "Contesto massimo" each combination is read at its own context: no single depth to mark.
          {...(depth === AT_MAX ? {} : { marker: depth })}
          title={t('tune.chart.title')}
          help={t('tune.chart.help')}
        />
      )}

      {rows.length > 0 ? (
        <TuneRanking run={run} rows={rows} depth={depth} depths={depths} onDepth={setDepth} recommended={rec?.index} />
      ) : (
        <Card className="p-card text-sm text-fg-2">{t('tune.ranking.empty')}</Card>
      )}

      <DiscardedAttempts tuning={tuning} engineKind={kind} />
      <CapacityCard tuning={tuning} />
    </div>
  );
}

/**
 * "Consigliata": the fastest of those reaching the largest context, its numbers with that context full
 * and the two ways to use it. Never measured that far: its speeds say so, and how far it was measured.
 */
function RecommendedCard({ run, index, text }: { run: TunedRun; index: number; text: string }) {
  const f = useI18n();
  const { t, number, integer } = f;
  const combo = run.tuning.combinations[index]!;
  const full = fullContextPoint(combo);
  const deep = deepestPoint(combo);
  const ctx = depthLabel(combo.maxContext, f);
  // A speed with the context full, its exact tokens on hover; undefined = not measured that far.
  const speed = (label: string, value: (p: LatencyPoint) => string) => ({ label, value: full && value(full), title: full && tooltipHead(full.promptTokens, 'depth', f) });
  const stats: { label: string; value: string | undefined; help?: string; title?: string | undefined }[] = [
    { label: t('tune.rec.context'), value: ctx, help: t('tune.help.context') },
    speed(t('tune.rec.decodeAtMax', { ctx }), (p) => `${number(p.decodeTps.median, 1)} tok/s`),
    speed(t('tune.rec.prefillAtMax', { ctx }), (p) => `${integer(prefillStat(p).median)} tok/s`),
    speed(t('tune.rec.ttftAtMax', { ctx }), (p) => `${number(p.ttftMs.median / 1000, 2)} s`),
    ...(combo.vramPeakMiB === undefined ? [] : [{ label: t('tune.rec.vram'), value: `${number(combo.vramPeakMiB / MIB_PER_GB, 1)} GB` }]),
  ];
  // Measured only below its context: how far, why, and what to do.
  const upTo = !full && deep ? { depth: depthLabel(nominalDepth(deep.promptTokens), f), ctx } : undefined;
  return (
    <section aria-label={t('tune.rec.title')} className="mt-5 flex flex-col gap-4 rounded-lg border border-accent/30 bg-surface/70 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="accent">{t('tune.recommended')}</Badge>
        <HelpTip term={t('tune.recommended')}>{t('tune.rec.help')}</HelpTip>
        <span className="text-md font-semibold text-fg">{text}</span>
        {combo.partial && <PartialBadge why={combo.partial} combo={combo} />}
      </div>
      <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2 xl:grid-cols-5">
        {stats.map((s) => (
          <div key={s.label} className="flex flex-col gap-0.5">
            <dt className="inline-flex items-center gap-1 text-xs text-fg-3">
              {s.label}
              {s.help && <HelpTip term={s.label}>{s.help}</HelpTip>}
            </dt>
            {s.value === undefined ? (
              <dd className="text-md font-medium text-fg-3 italic">{t('tune.rec.notMeasured')}</dd>
            ) : (
              <dd className="text-lg font-semibold text-fg tabular-nums" title={s.title}>
                {s.value}
              </dd>
            )}
          </div>
        ))}
      </dl>
      {upTo && (
        <p className="text-sm text-fg-2">{combo.partial ? t('tune.rec.onlyUpTo', { ...upTo, why: t(`tune.rec.why.${combo.partial}`) }) : t('tune.rec.onlyUpToNoWhy', upTo)}</p>
      )}
      {/* "Usa questo preset" for this combination is in the page header. */}
    </section>
  );
}
