import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Download, GitCompareArrows, ListChecks, Search, SlidersHorizontal, Trash2, Upload } from 'lucide-react';
import { useCallback, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { toast } from 'sonner';
import { fillsContext, spilledRun, type RunSummary } from '../../contract/results';
import { ErrorCard } from '../components/bench/error-card';
import { SpillBadge } from '../components/bench/spill';
import { countKey, MIB_PER_GB, prettyEngineLabel, shortEngineLabel, shortGpuName } from '../components/bench/format';
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
import { cn } from '../lib/cn';
import { bundleRequest } from '../lib/export';
import { saveTextFile } from '../lib/export/save';
import { contextShort, tokensK, usersWords, type SpeedKind } from '../lib/speed-at';
import { apiErrorData, RUNS_KEY, useBenchSystem, useRuns, useRunsLiveRefresh } from '../lib/queries-runs';

const col = columnHelper<RunSummary>();
const statusTone = { completed: 'success', failed: 'danger', cancelled: 'neutral' } as const;

/**
 * Under a speed, what it was measured on: "a 512 token di contesto", "prompt da 4K"; a one-user search
 * reads every speed at its largest context with the context full ("a 256K di contesto", the Contesto
 * column), and one that stopped before filling it says so (its deepest measurement, marked, why on hover).
 */
function SpeedContext({ run, kind, tokens }: { run: RunSummary; kind: SpeedKind; tokens: number }) {
  const f = useI18n();
  const ctx = run.contextSize;
  const short = run.profile === 'tune' && run.tuneGoal !== 'multi' && ctx !== undefined && !fillsContext(tokens, ctx);
  return (
    <span className={cn(WRAP, 'text-xs', short ? 'text-warning-text' : 'text-fg-3')} title={short ? f.t('results.tuning.notFull', { depth: tokensK(tokens, f), ctx: tokensK(ctx, f) }) : undefined}>
      {contextShort({ kind, tokens, basis: run.speedBasis }, f)}
    </span>
  );
}

/**
 * A speed's second line that wraps while the page is under 72rem (a window up to about 1440 px with the sidebar open, nine columns):
 * "a 512 token" over "di contesto", so the whole table fits without scrolling sideways.
 */
const WRAP = 'max-w-20 whitespace-normal @6xl/page:max-w-none @6xl/page:whitespace-nowrap';

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
  /**
   * The profile under the date ("Standard · 1.104 punti"). A search: "Trova le impostazioni migliori · 6
   * combinazioni" is wider than the numbers leave room for, so "Impostazioni migliori" and the whole on hover.
   */
  const whenOf = useCallback((r: RunSummary): { text: string; title?: string } => {
    const profile = t(`benchmark.profiles.${r.profile}`);
    const combos = r.tunedCombinations === undefined ? undefined : t(countKey(r.tunedCombinations, 'results.tuning.combosOne', 'results.tuning.combos'), { n: r.tunedCombinations });
    // The LLM Bench score belongs to its profile (Standard): next to it, so the numbers fit.
    const text = `${combos ? t('results.tuning.short') : profile}${r.score !== undefined ? ` · ${t('results.score', { n: integer(r.score) })}` : ''}`;
    return combos ? { text, title: `${profile} · ${combos}` } : { text };
  }, [t, integer]);
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
        // On a narrow page (under 64rem: a window of 1024–1320 px with the sidebar open) the date and the profile go under the model, so the model's name has room.
        meta: { className: 'hidden @5xl/page:table-cell' },
        cell: (c) => {
          const when = whenOf(c.row.original);
          return (
            <span className="flex flex-col leading-5">
              <span className="text-fg-2 tabular-nums">{dateTime(c.getValue())}</span>
              <span className="text-xs text-fg-3" title={when.title}>
                {when.text}
              </span>
            </span>
          );
        },
      }),
      // The model, what went wrong (failed, cancelled, shared memory), then engine and card: one column, so the numbers fit.
      // It takes the room the numbers leave: a long name ends with "…" and shows whole on hover.
      col.accessor('modelName', {
        header: () => (
          <>
            {t('results.columns.model')}
            <span className="@5xl/page:hidden"> · {t('results.columns.date')}</span>
          </>
        ),
        meta: { fill: true, className: 'min-w-36 py-1.5 @5xl/page:min-w-40 @6xl/page:min-w-48' },
        cell: (c) => {
          const r = c.row.original;
          const quant = r.quant && !c.getValue().includes(r.quant) ? r.quant : undefined;
          // The card only when the history has more than one (most people have one: the numbers keep the room).
          const engine = manyGpus ? `${shortEngineLabel(r.engineLabel)} · ${shortGpuName(r.gpuName)}` : shortEngineLabel(r.engineLabel);
          return (
            <span className="flex flex-col leading-5">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <Link
                  to="/results/$runId"
                  params={{ runId: r.id }}
                  onClick={(e) => e.stopPropagation()}
                  title={quant ? `${c.getValue()} ${quant}` : c.getValue()}
                  className="min-w-0 truncate rounded-xs font-medium text-fg hover:text-accent-text focus-ring"
                >
                  {c.getValue()}
                  {quant && <span className="font-normal text-fg-3"> {quant}</span>}
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
                {/* The build's backend (CUDA 13.4) only on hover, with the card's full name. */}
                <span className="truncate" title={`${prettyEngineLabel(r.engineLabel)} · ${r.gpuName}`}>
                  {engine}
                </span>
                {system.data && r.hostId !== system.data.hostId && (
                  <Badge tone="outline" size="sm" title={r.hostLabel} className="shrink-0">
                    {t('results.otherPc')}
                  </Badge>
                )}
              </span>
              {/* The date column's words, here on a narrow page. */}
              <span className="text-xs whitespace-normal text-fg-3 tabular-nums @5xl/page:hidden" title={whenOf(r).title}>
                {dateTime(r.createdAt)} · {whenOf(r).text}
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
                <span className="hidden @6xl/page:inline-flex">
                  <Sparkline values={history} width={44} height={18} endDot={false} />
                </span>
              )}
              <span className="flex flex-col items-end leading-5 whitespace-nowrap">
                <b className="font-semibold">{number(v, 1)}</b>
                {r.decodeTokens !== undefined && <SpeedContext run={r} kind="write" tokens={r.decodeTokens} />}
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
              {r.prefillTokens !== undefined && <SpeedContext run={r} kind="read" tokens={r.prefillTokens} />}
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
          // "43 ciascuno · 4 utenti" over "prompt da 512 token": what each user gets, with how many and on what
          // prompt, like the other columns (older runs without it: everyone together). The whole sentence,
          // with everyone together, on hover.
          const head = each !== undefined ? t('results.usersEach', { tps: integer(each) }) : tps !== undefined ? t('results.usersTotal', { tps: integer(tps) }) : undefined;
          const users = t('results.users', { n: v });
          const speeds = [
            each !== undefined ? t('results.usersTipEach', { tps: number(each, 1) }) : undefined,
            tps !== undefined ? t('results.usersTipTotal', { tps: integer(tps) }) : undefined,
          ].filter((s): s is string => s !== undefined);
          return (
            <span
              className="flex min-w-24 flex-col items-end text-right leading-5 whitespace-normal @5xl/page:whitespace-nowrap"
              title={speeds.length ? t('results.usersTip', { users: usersWords(v, prompt, f), speeds: speeds.join(', ') }) : undefined}
            >
              <span>
                {head && `${head} · `}
                <span className="text-fg-3">{users}</span>
              </span>
              {prompt !== undefined && <span className="text-xs text-fg-3">{contextShort({ kind: 'read', tokens: prompt }, f)}</span>}
            </span>
          );
        },
      }),
      col.accessor('vramPeakMiB', {
        // "VRAM picco" may wrap like the other headers: its numbers are short, and the model column takes the rest.
        header: () => <UnitHeader text={t('results.columns.vram')} />,
        meta: NUMERIC,
        sortUndefined: 'last',
        cell: (c) => {
          const v = c.getValue();
          // A test that stopped before loading the model measured no memory: "–", not "0,0".
          return !v ? <span className="text-fg-3">–</span> : number(v / MIB_PER_GB, 1);
        },
      }),
      // "Confronta": always in sight at the end of the row (a failed run measured nothing to compare).
      col.display({
        id: 'compare',
        meta: { stickyEnd: true },
        // On a narrow page the button's icon stands for the word (the same icon as on every row).
        header: () => (
          <span title={t('results.columns.compare')} className="inline-flex">
            <GitCompareArrows aria-hidden className="size-4 @5xl/page:hidden" />
            <span className="sr-only @5xl/page:not-sr-only">{t('results.columns.compare')}</span>
          </span>
        ),
        cell: (c) => (c.row.original.status === 'failed' ? null : <CompareToggle compact entry={entryOfSummary(c.row.original, f)} />),
      }),
    ],
    [t, f, number, integer, dateTime, selected, toggle, all, system.data, manyGpus, whenOf],
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
      width="full"
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
