/**
 * Confronta, before there is anything to compare: pick two to four MODELS (LLM Bench takes the fastest
 * configuration measured on this card for each, or the one you choose), or pick tests one by one. What
 * is already picked (from Risultati, Configurazioni, a result…) is shown on top, ready to compare.
 */
import { Link, useNavigate } from '@tanstack/react-router';
import { Boxes, GitCompareArrows, ListChecks, Search, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { spilledRun, type RunSummary } from '../../../contract/results';
import type { ConfigEntry } from '../../../contract/configs';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/cn';
import { COMPARE_MAX, idsOf, oldestFirst, setCompareSelection, useCompareSelection, type CompareEntry } from '../../lib/compare-selection';
import { useConfigs } from '../../lib/queries-configs';
import { apiErrorData, useRuns } from '../../lib/queries-runs';
import { contextWords, speedAt } from '../../lib/speed-at';
import { ErrorCard } from '../bench/error-card';
import { countKey, prettyEngineLabel, shortGpuName, summaryModelLabel } from '../bench/format';
import { SpillBadge } from '../bench/spill';
import { configEngineLabel } from '../configs/engine-label';
import { configLabelOf } from '../presets/config-label';
import { Badge } from '../ui/badge';
import { Button, IconButton } from '../ui/button';
import { Card } from '../ui/card';
import { Checkbox } from '../ui/checkbox';
import { EmptyState } from '../ui/empty-state';
import { Input } from '../ui/input';
import { Select } from '../ui/select';
import { Skeleton } from '../ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { AT_MAX } from '../configs/depths';
import { configOption, configSpeedWords, modelsOf, type ModelConfigs } from './best-config';
import { entryOfConfig, entryOfSummary } from './compare-entries';
import { CompareToggle } from './compare-tray';

export type StartView = 'models' | 'runs';

/** What is picked so far, with "Confronta" once there are two. */
function Picked() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const sel = useCompareSelection();
  const n = sel.items.length;
  return (
    <Card className="sticky top-3 z-20 flex flex-wrap items-center gap-3 p-card shadow-md">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="text-sm font-semibold text-fg">{n ? t(n === 1 ? 'compare.start.pickedOne' : 'compare.start.picked', { n, max: COMPARE_MAX }) : t('compare.start.nothing')}</p>
        {n > 0 && (
          <ul className="flex flex-wrap gap-1.5" aria-label={t('compare.tray.items')}>
            {sel.items.map((e) => (
              <li key={`${e.runId}~${e.combo ?? ''}`} className="flex items-center gap-1 rounded-full bg-surface-2 py-0.5 pr-0.5 pl-3 text-sm text-fg">
                <span>{e.label}</span>
                <span className="text-xs text-fg-3">{[e.detail].filter(Boolean).map((d) => `· ${d}`)}</span>
                <IconButton size="sm" label={t('compare.tray.remove', { name: e.label })} icon={<X />} className="size-6" onClick={() => sel.remove(e)} />
              </li>
            ))}
          </ul>
        )}
      </div>
      <Button variant="primary" disabled={n < 2} onClick={() => void navigate({ to: '/compare', search: { ids: idsOf(oldestFirst(sel.items)) } })}>
        <GitCompareArrows aria-hidden />
        {n >= 2 ? t('compare.start.go', { n }) : t('compare.start.goDisabled')}
      </Button>
    </Card>
  );
}

/**
 * The model's best configuration's speed, with what it was measured on: "61,2 tok/s con il contesto
 * pieno a 256K" (ranked at the largest context), "54,6 tok/s · scrittura con 512 token già nel contesto".
 */
function bestLine(m: ModelConfigs, f: ReturnType<typeof useI18n>): string | undefined {
  const best = m.configs[0]!;
  // Ranked there because it was measured there: its speed with its context full.
  if (m.at === AT_MAX) return configSpeedWords(best, AT_MAX, f);
  const v = best.points.find((p) => p.depth === m.at)?.decodeTps;
  return v === undefined ? undefined : speedAt(v, { kind: 'write', tokens: m.at! }, f);
}

/** The picked item standing for one of these configurations (any of their tests), if any. */
function pickOf(m: ModelConfigs, items: readonly CompareEntry[]): { entry: CompareEntry; config: ConfigEntry } | undefined {
  for (const entry of items) {
    const config = m.configs.find((e) => e.sources.some((s) => s.runId === entry.runId && s.combo === entry.combo));
    if (config) return { entry, config };
  }
  return undefined;
}

/**
 * "Confronta modelli": the models measured on this card, each with its fastest configuration. Ticking
 * one picks that configuration (the same list as every "Confronta"); the chooser swaps it for another.
 */
function ModelsPicker() {
  const f = useI18n();
  const { t } = f;
  const res = useConfigs({});
  const models = useMemo(() => modelsOf(res.data?.configs ?? []), [res.data]);
  const sel = useCompareSelection();
  const gpu = res.data?.gpus.find((g) => g.key === res.data?.gpu);
  if (res.isError) return <ErrorCard error={apiErrorData(res.error)} handlers={{ retry: () => void res.refetch() }} />;
  if (!res.data) return <Skeleton className="h-48 w-full" />;
  if (models.length === 0) {
    return (
      <Card>
        <EmptyState
          title={t('compare.start.noModelsTitle')}
          description={t('compare.start.noModelsBody')}
          action={
            <Button variant="primary" asChild>
              <Link to="/">{t('configs.emptyAction')}</Link>
            </Button>
          }
        />
      </Card>
    );
  }
  // The context is always said, so the words are never empty.
  const words = (e: ConfigEntry) => [configEngineLabel(e), configLabelOf(e.engineKind, e.params, f, { tags: e.tags }).text].join(' · ');
  const toggle = (m: ModelConfigs, on: boolean) => {
    const pick = pickOf(m, sel.items);
    if (!on) sel.remove(pick!.entry);
    else if (sel.toggle(entryOfConfig(m.configs[0]!, m.at, f)) === 'full') toast(t('compare.toggle.full', { n: COMPARE_MAX }));
  };
  const swap = (m: ModelConfigs, id: string) => {
    const old = pickOf(m, sel.items)!.entry;
    const next = entryOfConfig(m.configs.find((e) => e.id === id)!, m.at, f);
    setCompareSelection(sel.items.map((e) => (e === old ? next : e)));
  };
  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-3xl text-sm text-fg-2">{t('compare.start.modelsIntro', { gpu: gpu ? shortGpuName(gpu.name) : '–' })}</p>
      <ul className="grid grid-cols-1 gap-3 @2xl/page:grid-cols-2 @5xl/page:grid-cols-3" aria-label={t('compare.start.modelsList')}>
        {models.map((m) => {
          const pick = pickOf(m, sel.items);
          const line = bestLine(m, f);
          const id = `compare-model-${m.key.replace(/[^a-zA-Z0-9]/g, '')}`;
          return (
            <li key={m.key}>
              <Card className={cn('flex h-full flex-col gap-3 p-card transition-colors', pick && 'border-accent ring-1 ring-accent')}>
                <label htmlFor={id} className="flex cursor-pointer items-start gap-3">
                  <Checkbox id={id} checked={!!pick} onCheckedChange={(v) => toggle(m, v === true)} className="mt-0.5" />
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="font-semibold text-fg">{summaryModelLabel({ modelName: m.name, quant: m.quant })}</span>
                    <span className="text-xs text-fg-3">{t(countKey(m.configs.length, 'compare.start.configsOne', 'compare.start.configs'), { n: m.configs.length })}</span>
                  </span>
                </label>
                <div className="flex flex-col gap-1 text-sm">
                  <span className="text-xs font-medium tracking-wide text-fg-3 uppercase">{t(m.at === AT_MAX ? 'compare.start.fastestMax' : 'compare.start.fastest')}</span>
                  <span className="text-fg-2">{words(m.configs[0]!)}</span>
                  {line ? <span className="font-medium text-fg tabular-nums">{line}</span> : <span className="text-fg-3">{t('compare.start.noSpeed')}</span>}
                  {m.configs[0]!.spill && <SpillBadge className="self-start" />}
                </div>
                {pick && m.configs.length > 1 && (
                  <Select
                    aria-label={t('compare.card.pickConfig', { name: m.name })}
                    value={pick.config.id}
                    onValueChange={(v) => swap(m, v)}
                    className="mt-auto h-8 text-xs [&>span]:truncate"
                    options={m.configs.map((e, i) => configOption(e, i === 0, words(e), m.at, f))}
                  />
                )}
              </Card>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** A test of the list: model, engine, date and its headline speed with what it was measured on. */
function RunRow({ r }: { r: RunSummary }) {
  const f = useI18n();
  const { t, number, dateTime } = f;
  return (
    <li className="flex items-center gap-4 border-b border-border px-card py-2.5 last:border-b-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex flex-wrap items-center gap-2">
          <Link to="/results/$runId" params={{ runId: r.id }} className="rounded-xs font-medium text-fg hover:text-accent-text focus-ring">
            {summaryModelLabel(r)}
          </Link>
          {spilledRun(r) && <SpillBadge />}
        </span>
        <span className="text-xs text-fg-3">{[prettyEngineLabel(r.engineLabel), shortGpuName(r.gpuName), t(`benchmark.profiles.${r.profile}`), dateTime(r.createdAt)].join(' · ')}</span>
      </div>
      {r.decodeTps !== undefined && (
        <span className="hidden flex-col items-end text-right sm:flex">
          <span className="text-sm font-semibold text-fg tabular-nums">{number(r.decodeTps, 1)} tok/s</span>
          {/* No column header here: the line says it is the writing speed, and on what. */}
          {r.decodeTokens !== undefined && <span className="text-xs text-fg-3">{contextWords({ kind: 'write', tokens: r.decodeTokens, basis: r.speedBasis }, f)}</span>}
        </span>
      )}
      <CompareToggle entry={entryOfSummary(r, f)} />
    </li>
  );
}

/** "Scegli i test": every completed test, newest first, with a search box. */
function RunsPicker() {
  const { t } = useI18n();
  const runs = useRuns();
  const [q, setQ] = useState('');
  if (runs.isError) return <ErrorCard error={apiErrorData(runs.error)} handlers={{ retry: () => void runs.refetch() }} />;
  if (!runs.data) return <Skeleton className="h-48 w-full" />;
  const completed = runs.data.filter((r) => r.status === 'completed');
  const needle = q.trim().toLowerCase();
  const shown = completed.filter((r) => !needle || `${r.modelName} ${r.quant ?? ''} ${r.engineLabel} ${r.gpuName}`.toLowerCase().includes(needle));
  if (completed.length === 0) {
    return (
      <Card>
        <EmptyState
          title={t('compare.start.noRunsTitle')}
          description={t('compare.start.noRunsBody')}
          action={
            <Button variant="primary" asChild>
              <Link to="/">{t('results.emptyAction')}</Link>
            </Button>
          }
        />
      </Card>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-72">
          <Search aria-hidden className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-3" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('results.searchPlaceholder')} aria-label={t('common.search')} className="pl-9" />
        </div>
        <span className="text-sm text-fg-3">{t('compare.start.runsHint')}</span>
      </div>
      <Card className="overflow-hidden">
        {shown.length === 0 ? (
          <p className="px-card py-6 text-center text-sm text-fg-3">{t('results.noMatchTitle')}</p>
        ) : (
          <ul aria-label={t('compare.start.runsList')} className="max-h-[560px] overflow-y-auto">
            {shown.map((r) => (
              <RunRow key={r.id} r={r} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

export function CompareStart({ view, onView }: { view: StartView; onView: (v: StartView) => void }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-section">
      <Picked />
      <Tabs value={view} onValueChange={(v) => onView(v as StartView)}>
        <TabsList aria-label={t('compare.start.how')}>
          <TabsTrigger value="models">
            <Boxes aria-hidden />
            {t('compare.start.models')}
          </TabsTrigger>
          <TabsTrigger value="runs">
            <ListChecks aria-hidden />
            {t('compare.start.runs')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="models">
          <ModelsPicker />
        </TabsContent>
        <TabsContent value="runs">
          <RunsPicker />
        </TabsContent>
      </Tabs>
      <p className="text-sm text-fg-3">
        {t('compare.start.elsewhere')}{' '}
        <Badge tone="outline" size="sm">
          <GitCompareArrows aria-hidden />
          {t('compare.toggle.text')}
        </Badge>
      </p>
    </div>
  );
}
