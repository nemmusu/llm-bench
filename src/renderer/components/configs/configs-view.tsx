/**
 * Risultati → Configurazioni: every way a model was started on this card, fastest first. One row
 * per configuration (engine, model, settings), its numbers at the "Confronta a" depth (medians of
 * its tests), the tests behind it, and the preset to start it again in one click.
 */
import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { ALL_GPUS, type ConfigEntry, type ConfigsQuery, type DepthPoint } from '../../../contract/configs';
import type { EngineKind } from '../../../contract/engines';
import type { MessageKey } from '../../i18n';
import { useI18n } from '../../i18n';
import { useConfigs } from '../../lib/queries-configs';
import { apiErrorData, useRun } from '../../lib/queries-runs';
import { ErrorCard } from '../bench/error-card';
import { countKey, MIB_PER_GB, shortGpuName, summaryModelLabel } from '../bench/format';
import { SpillBadge } from '../bench/spill';
import { entryOfConfig } from '../compare/compare-entries';
import { CompareToggle } from '../compare/compare-tray';
import { headerAt } from '../../lib/speed-at';
import { configLabelOf } from '../presets/config-label';
import { shortDate, tokensShort } from '../presets/format';
import { PresetActions } from '../presets/preset-actions';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { columnHelper, DataTable, type DataTableColumn } from '../ui/data-table';
import { EmptyState } from '../ui/empty-state';
import { HelpTip } from '../ui/help-tip';
import { Select } from '../ui/select';
import { Skeleton } from '../ui/skeleton';
import { defaultDepth, depthChoices, pointAt, sourceFor } from './depths';
import { configEngineLabel } from './engine-label';
import { SourcesDialog } from './sources-dialog';
import { NUMERIC, UnitHeader } from './unit-header';

const ALL = 'all';
/** "Contesto almeno": the steps offered. */
const CONTEXT_STEPS = [8192, 16384, 32768, 65536, 131072] as const;

interface Filters {
  /** A card key, ALL_GPUS, or undefined = the core's default (this PC's card). */
  gpu?: string;
  model: string;
  engine: string;
  minContext: string;
}

const NO_FILTERS: Filters = { model: ALL, engine: ALL, minContext: ALL };

/** A table row: the configuration and its numbers at the compared depth (none when not measured there). */
interface Row {
  entry: ConfigEntry;
  point: DepthPoint | undefined;
}

/** "Usa questo preset" of a row: the newest test that measured the compared depth, loaded on demand. */
function RowPreset({ entry, depth }: { entry: ConfigEntry; depth: number | undefined }) {
  const { t } = useI18n();
  const source = sourceFor(entry, depth);
  const run = useRun(source.runId);
  if (run.isError) return <span className="text-fg-3">–</span>;
  if (!run.data) {
    return (
      <Button variant="primary" size="sm" disabled>
        {t('presets.use')}
      </Button>
    );
  }
  return <PresetActions run={run.data} combo={source.combo} at={depth} layout="compact" />;
}

export function ConfigsView() {
  const f = useI18n();
  const { t, number, integer, date } = f;
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [picked, setPicked] = useState<number | undefined>(undefined);
  const [open, setOpen] = useState<ConfigEntry | undefined>(undefined);
  const query: ConfigsQuery = {
    ...(filters.gpu ? { gpu: filters.gpu } : {}),
    ...(filters.model !== ALL ? { model: filters.model } : {}),
    ...(filters.engine !== ALL ? { engine: filters.engine as EngineKind } : {}),
    ...(filters.minContext !== ALL ? { minContext: Number(filters.minContext) } : {}),
  };
  const res = useConfigs(query);
  const data = res.data;
  const entries = useMemo(() => data?.configs ?? [], [data]);
  const choices = useMemo(() => depthChoices(entries), [entries]);
  const depth = picked !== undefined && choices.includes(picked) ? picked : defaultDepth(entries, choices);
  const set = (patch: Partial<Filters>) => setFilters((cur) => ({ ...cur, ...patch }));
  // New rows for every depth: the table caches cell values per row, so the numbers must come with them.
  const rows = useMemo(() => entries.map((entry): Row => ({ entry, point: pointAt(entry, depth) })), [entries, depth]);

  const columns = useMemo(() => {
    const col = columnHelper<Row>();
    const dash = <span className="text-fg-3">–</span>;
    // Every number of a speed column is measured at the compared depth: the header says which (a table
    // has configurations, each measured at least one depth, so there is one).
    const at = (label: string) => headerAt(label, depth as number, f);
    /** A number at the compared depth; the column only when some configuration has it. */
    const atDepth = (id: string, header: MessageKey, pick: (p: DepthPoint) => number | undefined, show: (v: number) => string): DataTableColumn<Row>[] =>
      rows.some((r) => r.point !== undefined && pick(r.point) !== undefined)
        ? [
            col.accessor(
              (r) => r.point && pick(r.point),
              {
                id,
                header: () => <UnitHeader text={at(t(header))} />,
                meta: NUMERIC,
                sortUndefined: 'last',
                cell: (c) => {
                  const v = c.getValue();
                  return v === undefined ? dash : show(v);
                },
              },
            ),
          ]
        : [];
    return [
      // The model and, under it, the engine (as in the Test list).
      col.accessor(({ entry: e }) => summaryModelLabel({ modelName: e.model.name, quant: e.model.quant }), {
        id: 'model',
        meta: { className: 'min-w-44 max-w-60 whitespace-normal py-2' },
        header: t('configs.columns.model'),
        cell: (c) => (
          <span className="flex flex-col items-start leading-5">
            <span className="font-medium text-fg">{c.getValue()}</span>
            <span className="text-xs whitespace-nowrap text-fg-3">{configEngineLabel(c.row.original.entry)}</span>
            {/* Its tests spilled to shared memory: these numbers are not the card's. */}
            {c.row.original.entry.spill && <SpillBadge className="mt-1" />}
          </span>
        ),
      }),
      // Only what differs from the engine's defaults; the context has its own column.
      col.accessor(({ entry: e }) => configLabelOf(e.engineKind, e.params, f, { context: false, kv: 'custom', capitalize: false, tags: e.tags }).text || t('configs.defaults'), {
        id: 'config',
        enableSorting: false,
        meta: { className: 'min-w-40 max-w-56 whitespace-normal py-2 leading-5' },
        header: () => (
          <span className="inline-flex items-center gap-1">
            {t('configs.columns.config')}
            <HelpTip term={t('configs.columns.config')}>{t('configs.configHelp')}</HelpTip>
          </span>
        ),
        cell: (c) => <span className="text-fg-2">{c.getValue()}</span>,
      }),
      ...(entries.some((e) => e.contextSize !== undefined)
        ? [
            col.accessor((r) => r.entry.contextSize, {
              id: 'context',
              header: () => <UnitHeader text={t('configs.columns.context')} />,
              meta: NUMERIC,
              sortUndefined: 'last',
              cell: (c) => {
                const v = c.getValue();
                return v === undefined ? dash : integer(v);
              },
            }),
          ]
        : []),
      col.accessor((r) => r.point?.decodeTps, {
        id: 'decode',
        header: () => <UnitHeader text={at(t('configs.columns.decode'))} />,
        meta: NUMERIC,
        sortUndefined: 'last',
        cell: (c) => {
          const v = c.getValue();
          return v === undefined ? (
            <span className="text-xs whitespace-normal text-fg-3 italic">{t('configs.notMeasured')}</span>
          ) : (
            <b className="font-semibold">{number(v, 1)}</b>
          );
        },
      }),
      ...atDepth('prefill', 'configs.columns.prefill', (p) => p.prefillTps, integer),
      ...atDepth('ttft', 'configs.columns.ttft', (p) => p.ttftMs, integer),
      ...(entries.some((e) => e.vramPeakMiB !== undefined)
        ? [
            col.accessor((r) => r.entry.vramPeakMiB, {
              id: 'vram',
              header: () => <UnitHeader text={t('configs.columns.vram')} />,
              meta: NUMERIC,
              sortUndefined: 'last',
              cell: (c) => {
                const v = c.getValue();
                return v === undefined ? dash : number(v / MIB_PER_GB, 1);
              },
            }),
          ]
        : []),
      // How many tests, and when the last one ran; the tests themselves (with users in parallel) open from here.
      col.accessor((r) => r.entry.latest, {
        id: 'tests',
        header: t('configs.columns.tests'),
        cell: (c) => {
          const e = c.row.original.entry;
          const n = e.sources.length;
          return (
            <span className="flex flex-col items-start leading-5">
              <Button size="sm" variant="link" onClick={() => setOpen(e)} aria-label={t(countKey(n, 'configs.openTestsOne', 'configs.openTests'), { n, model: e.model.name })}>
                {t(countKey(n, 'configs.testsOne', 'configs.tests'), { n })}
              </Button>
              <span className="text-xs text-fg-3 tabular-nums" title={date(c.getValue())}>
                {t('configs.lastTest', { date: shortDate(c.getValue(), f.locale) })}
              </span>
            </span>
          );
        },
      }),
      col.display({
        id: 'actions',
        // Always in sight: on a narrow window the numbers scroll under it.
        meta: { className: 'sticky right-0 bg-surface shadow-[-12px_0_12px_-12px_rgb(0_0_0/0.18)] group-hover:bg-surface-2' },
        header: () => <span className="sr-only">{t('configs.columns.actions')}</span>,
        cell: (c) => (
          <span className="flex items-start gap-2">
            <RowPreset entry={c.row.original.entry} depth={depth} />
            <CompareToggle compact entry={entryOfConfig(c.row.original.entry, depth, f)} also={c.row.original.entry.sources.map((s) => (s.combo === undefined ? { runId: s.runId } : { runId: s.runId, combo: s.combo }))} />
          </span>
        ),
      }),
    ] as DataTableColumn<Row>[];
  }, [rows, entries, depth, f, t, number, integer, date]);

  const gpuOptions = (data?.gpus ?? []).map((g) => ({
    value: g.key,
    label: g.here ? t('configs.thisGpu', { gpu: shortGpuName(g.name) }) : t('configs.otherGpu', { gpu: shortGpuName(g.name), host: g.hostLabel }),
  }));

  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-3xl text-sm text-fg-2">{t('configs.intro')}</p>
      {data && data.gpus.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          {data.gpus.length > 1 && (
            <Select
              aria-label={t('configs.filterGpu')}
              value={filters.gpu ?? data.gpu ?? ALL_GPUS}
              onValueChange={(v) => setFilters({ ...NO_FILTERS, gpu: v })}
              className="w-56"
              options={[{ value: ALL_GPUS, label: t('configs.allGpus') }, ...gpuOptions]}
            />
          )}
          <Select
            aria-label={t('configs.filterModel')}
            value={filters.model}
            onValueChange={(v) => set({ model: v })}
            className="w-56"
            options={[{ value: ALL, label: t('configs.allModels') }, ...data.models.map((m) => ({ value: m.key, label: summaryModelLabel({ modelName: m.name, quant: m.quant }) }))]}
          />
          <Select
            aria-label={t('configs.filterEngine')}
            value={filters.engine}
            onValueChange={(v) => set({ engine: v })}
            className="w-48"
            options={[{ value: ALL, label: t('configs.allEngines') }, ...data.engines.map((k) => ({ value: k, label: t(`benchmark.engines.${k}`) }))]}
          />
          <Select
            aria-label={t('configs.filterContext')}
            value={filters.minContext}
            onValueChange={(v) => set({ minContext: v })}
            className="w-44"
            options={[
              { value: ALL, label: t('configs.anyContext') },
              ...CONTEXT_STEPS.map((n) => ({ value: String(n), label: t('configs.contextAtLeast', { n: tokensShort(n, f) }) })),
            ]}
          />
          {depth !== undefined && (
            <span className="inline-flex items-center gap-2">
              <span aria-hidden className="text-sm font-medium text-fg">
                {t('configs.compareAt')}
              </span>
              <Select
                aria-label={t('configs.compareAt')}
                value={String(depth)}
                onValueChange={(v) => setPicked(Number(v))}
                className="w-36"
                options={choices.map((d) => ({ value: String(d), label: t('configs.depth', { n: tokensShort(d, f) }) }))}
              />
              <HelpTip term={t('configs.compareAt')}>{t('configs.compareAtHelp')}</HelpTip>
            </span>
          )}
          <span className="ml-auto text-sm text-fg-3 tabular-nums">{t(countKey(entries.length, 'configs.countOne', 'configs.count'), { n: entries.length })}</span>
        </div>
      )}
      {res.isError ? (
        <ErrorCard error={apiErrorData(res.error)} handlers={{ retry: () => void res.refetch() }} />
      ) : (
        <Card className="overflow-hidden">
          {!data ? (
            <div className="flex flex-col gap-2 p-card">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-9 w-full" />
              ))}
            </div>
          ) : data.gpus.length === 0 ? (
            <EmptyState
              title={t('configs.emptyTitle')}
              description={t('configs.emptyBody')}
              action={
                <Button variant="primary" asChild>
                  <Link to="/">{t('configs.emptyAction')}</Link>
                </Button>
              }
            />
          ) : entries.length === 0 ? (
            <EmptyState
              illustration="search"
              title={t('configs.noMatchTitle')}
              description={t('configs.noMatchBody')}
              action={<Button onClick={() => setFilters(NO_FILTERS)}>{t('configs.resetFilters')}</Button>}
            />
          ) : (
            <DataTable caption={t('configs.caption')} columns={columns} data={rows} getRowId={(r) => r.entry.id} initialSorting={[{ id: 'decode', desc: true }]} />
          )}
        </Card>
      )}
      {depth !== undefined && <SourcesDialog entry={open} depth={depth} onOpenChange={(v) => !v && setOpen(undefined)} />}
    </div>
  );
}
