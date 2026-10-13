import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Download, GitCompareArrows, ListChecks, Search, SlidersHorizontal, Trash2, Upload } from 'lucide-react';
import { useCallback, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { toast } from 'sonner';
import { spilledRun, type RunSummary } from '../../contract/results';
import { ErrorCard } from '../components/bench/error-card';
import { SpillBadge } from '../components/bench/spill';
import { countKey, MIB_PER_GB, prettyEngineLabel, shortGpuName } from '../components/bench/format';
import { ALL, decodeHistory, distinct, filterRuns, NO_FILTERS, type RunFilters } from '../components/bench/history';
import { CompareToggle } from '../components/compare/compare-tray';
import { entryOfSummary } from '../components/compare/compare-entries';
import { ConfigsView } from '../components/configs/configs-view';
import { NUMERIC, UnitHeader } from '../components/configs/unit-header';
import { Page } from '../components/shell/page';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Checkbox } from '../components/ui/checkbox';
import { columnHelper, DataTable } from '../components/ui/data-table';
import { ConfirmDialog } from '../components/ui/dialog';
import { EmptyState } from '../components/ui/empty-state';
import { Input } from '../components/ui/input';
import { Select } from '../components/ui/select';
import { Skeleton } from '../components/ui/skeleton';
import { Sparkline } from '../components/ui/sparkline';
import { Switch } from '../components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { useI18n } from '../i18n';
import { useApi } from '../lib/api-context';
import { bundleRequest } from '../lib/export';
import { saveTextFile } from '../lib/export/save';
import { contextShort, tokensK } from '../lib/speed-at';
import { apiErrorData, RUNS_KEY, useBenchSystem, useRuns, useRunsLiveRefresh } from '../lib/queries-runs';

const col = columnHelper<RunSummary>();
const statusTone = { completed: 'success', failed: 'danger', cancelled: 'neutral' } as const;

/** History of every saved run: filters, sorting, "Confronta" on every row, import/export and delete. */
export function ResultsPage() {
  const f = useI18n();
  const { t, number, integer, dateTime } = f;
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const view = useSearch({ from: '/results' }).view ?? 'runs';
  const setView = (v: string) => void navigate({ to: '/results', search: v === 'configs' ? { view: 'configs' } : {}, replace: true });
  const runs = useRuns();
  const system = useBenchSystem();
  useRunsLiveRefresh();
  const [filters, setFilters] = useState<RunFilters>(NO_FILTERS);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const all = useMemo(() => runs.data ?? [], [runs.data]);
  const data = useMemo(() => filterRuns(all, filters, system.data?.hostId), [all, filters, system.data?.hostId]);
  const chosen = all.filter((r) => selected.has(r.id));
  const manyGpus = distinct(all, (r) => r.gpuName).length > 1;
  const set = (patch: Partial<RunFilters>) => setFilters((cur) => ({ ...cur, ...patch }));
  const toggle = useCallback(
    (id: string, on: boolean) =>
      setSelected((cur) => {
        const next = new Set(cur);
        if (on) next.add(id);
        else next.delete(id);
        return next;
      }),
    [],
  );

  const columns = useMemo(
    () => [
      col.display({
        id: 'select',
        header: () => <span className="sr-only">{t('results.select')}</span>,
        cell: (c) => (
          <span onClick={(e) => e.stopPropagation()} className="inline-flex">
            <Checkbox
              checked={selected.has(c.row.original.id)}
              onCheckedChange={(v) => toggle(c.row.original.id, v === true)}
              aria-label={t('results.selectRow', { model: c.row.original.modelName, date: dateTime(c.row.original.createdAt) })}
            />
          </span>
        ),
      }),
      col.accessor('createdAt', {
        header: t('results.columns.date'),
        cell: (c) => (
          <span className="flex flex-col leading-5">
            <span className="text-fg-2 tabular-nums">{dateTime(c.getValue())}</span>
            <span className="text-xs text-fg-3">
              {t(`benchmark.profiles.${c.row.original.profile}`)}
              {c.row.original.tunedCombinations !== undefined && ` · ${t(countKey(c.row.original.tunedCombinations, 'results.tuning.combosOne', 'results.tuning.combos'), { n: c.row.original.tunedCombinations })}`}
              {/* The LLM Bench score belongs to its profile (Standard): next to it, so the numbers fit. */}
              {c.row.original.score !== undefined && ` · ${t('results.score', { n: integer(c.row.original.score) })}`}
            </span>
          </span>
        ),
      }),
      // The model, what went wrong (failed, cancelled, shared memory), then engine and card: one column, so the numbers fit.
      col.accessor('modelName', {
        header: t('results.columns.model'),
        meta: { className: 'py-1.5' },
        cell: (c) => {
          const r = c.row.original;
          return (
            <span className="flex flex-col leading-5">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <Link
                  to="/results/$runId"
                  params={{ runId: r.id }}
                  onClick={(e) => e.stopPropagation()}
                  className="rounded-xs font-medium text-fg hover:text-accent-text focus-ring"
                >
                  {c.getValue()}
                  {r.quant && !c.getValue().includes(r.quant) && <span className="font-normal text-fg-3"> {r.quant}</span>}
                </Link>
                {r.status !== 'completed' ? (
                  <Badge tone={statusTone[r.status]} size="sm" dot>
                    {t(`result.status.${r.status}`)}
                  </Badge>
                ) : (
                  spilledRun(r) && <SpillBadge />
                )}
              </span>
              <span className="flex items-center gap-1.5 text-xs text-fg-3">
                {/* The card only when the history has more than one (most people have one: the numbers keep the room). */}
                {manyGpus ? `${prettyEngineLabel(r.engineLabel)} · ${shortGpuName(r.gpuName)}` : prettyEngineLabel(r.engineLabel)}
                {system.data && r.hostId !== system.data.hostId && (
                  <Badge tone="outline" size="sm" title={r.hostLabel}>
                    {t('results.otherPc')}
                  </Badge>
                )}
              </span>
            </span>
          );
        },
      }),
      // Missing measurements (failed or cancelled runs) always sort last. Every speed says what it was measured on.
      col.accessor('decodeTps', {
        header: () => <UnitHeader text={t('results.columns.decode')} />,
        meta: NUMERIC,
        sortUndefined: 'last',
        cell: (c) => {
          const v = c.getValue();
          if (v === undefined) return <span className="text-fg-3">–</span>;
          const r = c.row.original;
          const history = decodeHistory(r, all);
          return (
            <span className="inline-flex items-center justify-end gap-3">
              {history.length > 1 && (
                <span className="hidden 2xl:inline-flex">
                  <Sparkline values={history} width={44} height={18} endDot={false} />
                </span>
              )}
              <span className="flex flex-col items-end leading-5 whitespace-nowrap">
                <b className="font-semibold">{number(v, 1)}</b>
                {r.decodeTokens !== undefined && <span className="text-xs text-fg-3">{contextShort({ kind: 'write', tokens: r.decodeTokens, basis: r.speedBasis }, f)}</span>}
              </span>
            </span>
          );
        },
      }),
      col.accessor('prefillTps', {
        header: () => <UnitHeader text={t('results.columns.prefill')} />,
        meta: NUMERIC,
        sortUndefined: 'last',
        cell: (c) => {
          const v = c.getValue();
          const r = c.row.original;
          return v === undefined ? (
            <span className="text-fg-3">–</span>
          ) : (
            <span className="flex flex-col items-end leading-5 whitespace-nowrap">
              <span>{integer(v)}</span>
              {r.prefillTokens !== undefined && <span className="text-xs text-fg-3">{contextShort({ kind: 'read', tokens: r.prefillTokens, basis: r.speedBasis }, f)}</span>}
            </span>
          );
        },
      }),
      col.accessor('contextSize', {
        header: () => <UnitHeader text={t('results.columns.context')} />,
        meta: NUMERIC,
        sortUndefined: 'last',
        cell: (c) => {
          const v = c.getValue();
          const kv = c.row.original.kvCacheType;
          return v === undefined ? (
            <span className="text-fg-3">–</span>
          ) : (
            <span className="flex flex-col items-end leading-5 whitespace-nowrap">
              <span>{integer(v)}</span>
              {kv && <span className="text-xs text-fg-3">{t('results.tuning.kv', { kv })}</span>}
            </span>
          );
        },
      }),
      col.accessor('parallelUsers', {
        header: () => <UnitHeader text={t('results.columns.parallel')} />,
        meta: NUMERIC,
        sortUndefined: 'last',
        cell: (c) => {
          const v = c.getValue();
          const { parallelTps: tps, parallelPerUserTps: each, parallelPromptTokens: prompt } = c.row.original;
          if (v === undefined) return <span className="text-fg-3">–</span>;
          // "4 utenti · prompt da 512 token" / "43 ciascuno · 155 in tutto": what each user gets, then everyone together (older runs: what they have).
          const detail = [each !== undefined ? t('results.usersEach', { tps: integer(each) }) : undefined, tps !== undefined ? t('results.usersTotal', { tps: integer(tps) }) : undefined].filter(Boolean);
          return (
            <span className="flex flex-col items-end leading-5 whitespace-nowrap">
              {detail.length > 0 && <span>{detail.join(' · ')}</span>}
              <span className="text-xs text-fg-3">{prompt === undefined ? t('results.users', { n: v }) : t('results.usersPrompt', { n: v, prompt: tokensK(prompt, f) })}</span>
            </span>
          );
        },
      }),
      col.accessor('vramPeakMiB', {
        header: () => <UnitHeader text={t('results.columns.vram')} />,
        meta: NUMERIC,
        sortUndefined: 'last',
        cell: (c) => {
          const v = c.getValue();
          return v === undefined ? <span className="text-fg-3">–</span> : number(v / MIB_PER_GB, 1);
        },
      }),
      // "Confronta": always in sight at the end of the row (a failed run measured nothing to compare).
      col.display({
        id: 'compare',
        meta: { className: 'sticky right-0 bg-surface shadow-[-12px_0_12px_-12px_rgb(0_0_0/0.18)] group-hover:bg-surface-2' },
        header: t('results.columns.compare'),
        cell: (c) => (c.row.original.status === 'failed' ? null : <CompareToggle compact entry={entryOfSummary(c.row.original, f)} />),
      }),
    ],
    [t, f, number, integer, dateTime, selected, toggle, all, system.data, manyGpus],
  );

  const onImport = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    let json: unknown;
    try {
      json = JSON.parse(await file.text());
    } catch {
      toast.error(t('results.importInvalid'));
      return;
    }
    try {
      const r = await api.post<{ imported: number; skipped: number }>('/api/runs/import', json);
      toast.success(t(countKey(r.imported, 'results.importedOne', 'results.imported'), { n: r.imported, skipped: r.skipped }));
      await qc.invalidateQueries({ queryKey: RUNS_KEY });
    } catch (err) {
      const d = apiErrorData(err);
      toast.error(d.params?.reason === 'export_too_new' ? t('results.importTooNew') : d.code === 'VALIDATION' ? t('results.importInvalid') : t(`errors.${d.code}.title`));
    }
  };

  const onExport = async () => {
    try {
      const bundle = await api.post<unknown>('/api/runs/export', { ids: chosen.map((r) => r.id) });
      const where = await saveTextFile(bundleRequest(bundle, new Date()));
      if (where) toast.success(t(countKey(chosen.length, 'results.exportedOne', 'results.exported'), { n: chosen.length, file: where }));
    } catch (err) {
      toast.error(t(`errors.${apiErrorData(err).code}.title`));
    }
  };

  const onDelete = async () => {
    const ids = chosen.map((r) => r.id);
    const results = await Promise.allSettled(ids.map((id) => api.del(`/api/runs/${encodeURIComponent(id)}`)));
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed) toast.error(t(countKey(failed, 'results.deleteFailedOne', 'results.deleteFailed'), { n: failed }));
    else toast.success(t(countKey(ids.length, 'results.deletedOne', 'results.deleted'), { n: ids.length }));
    setSelected(new Set());
    await qc.invalidateQueries({ queryKey: RUNS_KEY });
  };

  const engines = distinct(all, (r) => r.engineKind);
  return (
    <Page
      title={t('results.title')}
      subtitle={t('results.subtitle')}
      width="wide"
      actions={
        // Import, export and delete work on tests: the Configurazioni view has its own actions per row.
        <>
          {view === 'runs' && (
            <>
              <input ref={fileRef} type="file" accept=".llmbench,.gpubench,.json,application/json" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => void onImport(e)} />
              <Button onClick={() => fileRef.current?.click()}>
                <Upload aria-hidden />
                {t('results.import')}
              </Button>
              <Button disabled={chosen.length === 0} onClick={() => void onExport()}>
                <Download aria-hidden />
                {chosen.length ? t('results.exportSelected', { n: chosen.length }) : t('results.export')}
              </Button>
              <Button disabled={chosen.length === 0} variant="danger-outline" onClick={() => setConfirmDelete(true)}>
                <Trash2 aria-hidden />
                {chosen.length ? t('results.deleteSelected', { n: chosen.length }) : t('results.delete')}
              </Button>
            </>
          )}
          {/* "Confronta modelli": the start screen, the models measured on this card with their fastest configuration. */}
          <Button asChild>
            <Link to="/compare" search={{ view: 'models' }}>
              <GitCompareArrows aria-hidden />
              {t('compare.openModels')}
            </Link>
          </Button>
        </>
      }
    >
      <Tabs value={view} onValueChange={setView}>
        <TabsList aria-label={t('configs.viewLabel')}>
          <TabsTrigger value="runs">
            <ListChecks aria-hidden />
            {t('configs.views.runs')}
          </TabsTrigger>
          <TabsTrigger value="configs">
            <SlidersHorizontal aria-hidden />
            {t('configs.views.configs')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="configs">
          <ConfigsView />
        </TabsContent>
        <TabsContent value="runs">
          {all.length > 0 && (
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <div className="relative w-64">
                <Search aria-hidden className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-3" />
                <Input value={filters.q} onChange={(e) => set({ q: e.target.value })} placeholder={t('results.searchPlaceholder')} aria-label={t('common.search')} className="pl-9" />
              </div>
              <Select
                aria-label={t('results.filterModel')}
                value={filters.model}
                onValueChange={(v) => set({ model: v })}
                className="w-52"
                options={[{ value: ALL, label: t('results.allModels') }, ...distinct(all, (r) => r.modelName).map((m) => ({ value: m, label: m }))]}
              />
              <Select
                aria-label={t('results.filterGpu')}
                value={filters.gpu}
                onValueChange={(v) => set({ gpu: v })}
                className="w-48"
                options={[{ value: ALL, label: t('results.allGpus') }, ...distinct(all, (r) => r.gpuName).map((g) => ({ value: g, label: shortGpuName(g) }))]}
              />
              <Select
                aria-label={t('results.filterEngine')}
                value={filters.engine}
                onValueChange={(v) => set({ engine: v })}
                className="w-48"
                options={[{ value: ALL, label: t('results.allEngines') }, ...engines.map((e) => ({ value: e, label: t(`benchmark.engines.${e as 'external'}`) }))]}
              />
              <Select
                aria-label={t('results.filterStatus')}
                value={filters.status}
                onValueChange={(v) => set({ status: v })}
                className="w-44"
                options={[
                  { value: ALL, label: t('results.allStatuses') },
                  ...(['completed', 'failed', 'cancelled'] as const).map((s) => ({ value: s, label: t(`result.status.${s}`) })),
                ]}
              />
              <label className="flex items-center gap-2 text-sm font-medium text-fg">
                <Switch checked={filters.thisPc} onCheckedChange={(v) => set({ thisPc: v })} />
                {t('results.thisPc')}
              </label>
              <span className="ml-auto text-sm text-fg-3 tabular-nums">
                {[
                  t(countKey(data.length, 'results.countOne', 'results.count'), { n: data.length }),
                  ...(chosen.length ? [t(countKey(chosen.length, 'results.selectedOne', 'results.selected'), { n: chosen.length })] : []),
                ].join(' · ')}
              </span>
            </div>
          )}
          {runs.isError ? (
            <ErrorCard error={apiErrorData(runs.error)} handlers={{ retry: () => void runs.refetch() }} />
          ) : (
            <Card className="overflow-hidden">
              {runs.isPending ? (
                <div className="flex flex-col gap-2 p-card">
                  {[0, 1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-9 w-full" />
                  ))}
                </div>
              ) : all.length === 0 ? (
                <EmptyState
                  title={t('results.emptyTitle')}
                  description={t('results.emptyBody')}
                  action={
                    <Button variant="primary" asChild>
                      <Link to="/">{t('results.emptyAction')}</Link>
                    </Button>
                  }
                />
              ) : data.length === 0 ? (
                <EmptyState
                  illustration="search"
                  title={t('results.noMatchTitle')}
                  description={t('results.noMatchBody')}
                  action={<Button onClick={() => setFilters(NO_FILTERS)}>{t('results.resetFilters')}</Button>}
                />
              ) : (
                <DataTable
                  caption={t('results.title')}
                  columns={columns}
                  data={data}
                  getRowId={(r) => r.id}
                  initialSorting={[{ id: 'createdAt', desc: true }]}
                  onRowClick={(r) => void navigate({ to: '/results/$runId', params: { runId: r.id } })}
                />
              )}
            </Card>
          )}
        </TabsContent>
      </Tabs>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t(countKey(chosen.length, 'results.deleteTitleOne', 'results.deleteTitle'), { n: chosen.length })}
        description={t('results.deleteBody')}
        cancelLabel={t('common.cancel')}
        confirmLabel={t('results.deleteConfirm')}
        onConfirm={() => void onDelete()}
      />
    </Page>
  );
}
