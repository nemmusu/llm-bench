import { Check, Clock, Cpu, Download, Heart, Loader2, Lock, Search, X } from 'lucide-react';
import { RadioGroup as R } from 'radix-ui';
import { useEffect, useId, useState, type ReactNode } from 'react';
import type { GpuInfo } from '../../../contract/hardware';
import type { HubModel } from '../../../contract/models';
import { ninferGpuSupported } from '../../../contract/ninfer';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/cn';
import { useAllRuns, useCurated, useHubCatalog, useMainGpu, type CatalogParams, type CatalogSort } from '../../lib/queries-library';
import { useDebounced } from '../../lib/queries-runs';
import { DockerSearchNote } from '../docker/docker-note';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { EmptyState } from '../ui/empty-state';
import { FitBadge } from '../ui/fit-badge';
import { Input } from '../ui/input';
import { Select } from '../ui/select';
import { Skeleton } from '../ui/skeleton';
import { TriedHereBadge } from '../ui/tried-badge';
import { CatalogBusyNote } from './busy-note';
import type { CatalogState } from './catalog-search';
import { RowFacts, RowTitle, rowClass } from './catalog-rows';
import { CuratedRows, curatedFor } from './curated-list';
import { ErrorCallout } from './error-callout';
import { ENGINE_FILTERS, ForkBadge, FormatBadges, formatOfEngine, rowFormatOf, type CatalogFormat, type EngineFilter } from './formats';
import { bucketRange, triedModels, type SizeBucket, type TriedModel } from './helpers';

/** Authors offered in the filter, by format: the big GGUF quantizers, the labs that publish weights, NInfer's builders. */
export const CATALOG_AUTHORS: Record<CatalogFormat, readonly string[]> = {
  gguf: ['unsloth', 'bartowski', 'lmstudio-community', 'ggml-org', 'mradermacher', 'Qwen', 'google'],
  safetensors: ['Qwen', 'google', 'meta-llama', 'mistralai', 'microsoft', 'nvidia', 'openai', 'deepseek-ai', 'RedHatAI'],
  ninfer: ['neroued', 'nerkyor'],
  any: ['unsloth', 'bartowski', 'lmstudio-community', 'Qwen', 'google', 'meta-llama', 'mistralai', 'microsoft', 'nvidia', 'openai', 'deepseek-ai'],
};

/** What the list shows: every Hugging Face model, the verified suggestions, or what was already measured here. */
export type CatalogView = CatalogState['view'];

/** Hugging Face's own order of sort options, trending first (its default). */
const SORTS: readonly CatalogSort[] = ['trendingScore', 'downloads', 'createdAt', 'lastModified', 'likes'];
const SIZES: readonly SizeBucket[] = ['any', 'small', 'medium', 'large', 'huge'];
/** Radio value of "every author" (radio values cannot be empty). */
const ALL_AUTHORS = '*';

/** One-of-N filter drawn as wrapping chips: a radio group underneath (arrow keys, "1 of 5"). */
function ChipRadios<V extends string>({ label, value, onChange, options }: { label: string; value: V; onChange: (v: V) => void; options: readonly { value: V; label: string }[] }) {
  return (
    <R.Root aria-label={label} value={value} onValueChange={(v) => onChange(v as V)} className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <R.Item
          key={o.value}
          value={o.value}
          className="inline-flex h-7 items-center rounded-full border border-border-strong bg-surface px-2.5 text-xs text-fg-2 transition-colors hover:border-fg-3 hover:text-fg focus-ring data-[state=checked]:border-accent data-[state=checked]:bg-accent-soft data-[state=checked]:text-accent-text"
        >
          {o.label}
        </R.Item>
      ))}
    </R.Root>
  );
}

/** The list's three views as a compact vertical menu (a radio group, like the app's sidebar). */
function ViewList({ label, value, onChange, options }: { label: string; value: CatalogView; onChange: (v: CatalogView) => void; options: readonly { value: CatalogView; label: string; count?: number }[] }) {
  return (
    <R.Root aria-label={label} value={value} onValueChange={(v) => onChange(v as CatalogView)} className="flex flex-col gap-0.5">
      {options.map((o) => (
        <R.Item
          key={o.value}
          value={o.value}
          className="flex h-8 items-center justify-between rounded-md px-2.5 text-left text-sm text-fg-2 transition-colors hover:bg-surface-2 hover:text-fg focus-ring data-[state=checked]:bg-accent-soft data-[state=checked]:font-medium data-[state=checked]:text-accent-text"
        >
          {o.label}
          {o.count !== undefined && <span className="text-xs text-fg-3 tabular-nums">{o.count}</span>}
        </R.Item>
      ))}
    </R.Root>
  );
}

/** On/off filter drawn as a chip (a toggle button: screen readers announce "pressed"). */
function FilterChip({ pressed, onPressedChange, children }: { pressed: boolean; onPressedChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={() => onPressedChange(!pressed)}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors focus-ring',
        pressed ? 'border-accent bg-accent-soft text-accent-text' : 'border-border-strong bg-surface text-fg-2 hover:border-fg-3 hover:text-fg',
      )}
    >
      {pressed && <Check aria-hidden className="size-3" />}
      {children}
    </button>
  );
}

function FilterGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold tracking-wide text-fg-3 uppercase">{title}</h3>
      {children}
    </div>
  );
}

function HubRow({ m, tried, engine, gpu }: { m: HubModel; tried: TriedModel | undefined; engine: EngineFilter; gpu: GpuInfo | undefined }) {
  const { t, number, compact, relative, bytes } = useI18n();
  const ninferOnly = !m.formats.includes('gguf') && !m.formats.includes('safetensors') && m.formats.includes('ninfer');
  const [owner, name] = m.repo.split('/') as [string, string];
  const mib = (n: number) => bytes(n * 1024 * 1024);
  const gated = m.gated !== false && (
    <span className="relative z-10 inline-flex shrink-0 items-center gap-1 text-xs text-warning-text" title={t('models.search.gated')}>
      <Lock aria-hidden className="size-3" />
      <span className="sr-only">{t('models.search.gated')}</span>
    </span>
  );
  return (
    <li className={rowClass}>
      <RowTitle owner={owner} name={name} extra={gated} />
      {/* Each format the repo ships, with its engine: mixed repos show them side by side. */}
      <span className="flex min-w-0 flex-wrap items-center gap-1.5">
        <FormatBadges m={m} engine={engine} />
        <ForkBadge model={{ displayName: name, repo: m.repo, format: rowFormatOf(m.formats, engine) }} label={m.repo} />
        {(engine === 'ninfer' || ninferOnly) && m.formats.includes('ninfer') && gpu !== undefined && !ninferGpuSupported({ name: gpu.name, computeCapability: gpu.computeCapability, memTotalMiB: gpu.memoryTotalMiB }) && (
          <Badge tone="warning" size="sm" className="relative z-10">
            {t('models.needs5090')}
          </Badge>
        )}
      </span>
      <RowFacts>
        {[
          m.fit ? (
            // Above the row link, so its tooltip can be hovered.
            <span className="relative z-10">
              <FitBadge short level={m.fit.level} size="sm" detail={t('models.catalog.fitDetail', { quant: m.fit.quant, need: mib(m.fit.needMiB), available: mib(m.fit.availableMiB) })} />
            </span>
          ) : m.formats.length > 0 && m.formats.every((f) => f === 'other') ? undefined : (
            <span>{t('models.catalog.sizeUnknown')}</span>
          ),
          m.paramsB !== undefined && (
            <span className="inline-flex items-center gap-1">
              <Cpu aria-hidden className="size-3" />
              {t('models.paramsShort', { n: number(m.paramsB, Number.isInteger(m.paramsB) || m.paramsB >= 10 ? 0 : 1) })}
            </span>
          ),
          m.updatedAt && (
            <span className="inline-flex items-center gap-1" title={t('models.search.updated', { when: relative(m.updatedAt) })}>
              <Clock aria-hidden className="size-3" />
              {relative(m.updatedAt)}
            </span>
          ),
          <span className="inline-flex items-center gap-1" title={t('models.search.downloads', { n: compact(m.downloads) })}>
            <Download aria-hidden className="size-3" />
            {compact(m.downloads)}
            <span className="sr-only">{t('models.catalog.downloadsSr')}</span>
          </span>,
          <span className="inline-flex items-center gap-1" title={t('models.search.likes', { n: compact(m.likes) })}>
            <Heart aria-hidden className="size-3" />
            {compact(m.likes)}
            <span className="sr-only">{t('models.catalog.likesSr')}</span>
          </span>,
          tried && (tried.tps !== undefined || tried.spilled) && (
            <span className="relative z-10">
              <TriedHereBadge tried={tried} size="sm" short />
            </span>
          ),
        ]}
      </RowFacts>
    </li>
  );
}

function TriedRow({ m }: { m: TriedModel }) {
  const { t, relative } = useI18n();
  return (
    <li className={rowClass}>
      <RowTitle owner={m.owner} name={m.name} />
      <RowFacts>
        {[
          (m.tps !== undefined || m.spilled) && (
            <span className="relative z-10">
              <TriedHereBadge tried={m} size="sm" short />
            </span>
          ),
          m.quant && <span>{m.quant}</span>,
          <span>{t('models.catalog.triedRuns', { n: m.runs, when: relative(m.date) })}</span>,
        ]}
      </RowFacts>
    </li>
  );
}

function SkeletonRows() {
  const { t } = useI18n();
  return (
    <div className="grid gap-2 @5xl/page:grid-cols-2 @[100rem]/page:grid-cols-3" aria-label={t('common.loading')} role="status">
      {Array.from({ length: 10 }, (_, i) => (
        <Skeleton key={i} className="h-[58px] rounded-lg" />
      ))}
    </div>
  );
}

/** Loads the next page when the end of the list scrolls into view (and keeps going while it stays there). */
function useNearEnd(onNear: () => Promise<unknown>, active: boolean): (el: HTMLDivElement | null) => void {
  // A callback ref: the end marker appears only once the first page is in.
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => setNear(entries.some((e) => e.isIntersecting)), { rootMargin: '600px 0px' });
    io.observe(el);
    return () => {
      io.disconnect();
      setNear(false);
    };
  }, [el]);
  useEffect(() => {
    if (near && active) void onNear();
  }, [near, active, onNear]);
  return setEl;
}

/**
 * Modelli → Scarica, laid out like huggingface.co/models: filters in a column on the left, then one
 * header line (what is shown, how many, filter by name, sort) and compact rows, page after page.
 * Models show up before anything is typed (trending first, like Hugging Face). Besides every model
 * on the hub, the same list can show the verified suggestions for this GPU or what was already
 * measured here. Models that do not fit stay visible, marked, unless "fits my GPU" is on. Every
 * choice lives in the URL (`state`, changed with `onChange`): back from a model page, all is as it was.
 */
export function ModelCatalog({ state, onChange }: { state: CatalogState; onChange: (patch: Partial<CatalogState>) => void }) {
  const { t, integer } = useI18n();
  const ids = { sort: useId(), title: useId() };
  const { view, sort, size, author, onlyFits, engine } = state;
  const format = formatOfEngine(engine);
  // What is typed shows at once; the URL (and the search) follow once typing pauses.
  const [text, setText] = useState(state.q);
  const q = useDebounced(text.trim(), 350);
  useEffect(() => {
    if (q !== state.q) onChange({ q });
  }, [q, state.q, onChange]);
  const params: CatalogParams = { q: state.q, format, sort, author, onlyFits, ...bucketRange(size) };
  const catalog = useHubCatalog(params, view === 'hub');
  const curated = useCurated();
  const runs = useAllRuns();
  const gpu = useMainGpu();
  const tried = triedModels(runs.data, gpu);
  const triedByRepo = new Map(tried.map((m) => [m.repo, m]));
  const models = catalog.data?.pages.flatMap((p) => p.models) ?? [];
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = catalog;
  // fetchNextPage is stable (bound to the query observer), so the effect re-runs only when the state changes.
  const sentinel = useNearEnd(fetchNextPage, view === 'hub' && hasNextPage && !isFetchingNextPage && !catalog.isError);
  const filtered = author !== '' || size !== 'any' || onlyFits;
  const clear = () => onChange({ author: '', size: 'any', onlyFits: false });
  const authors = [...CATALOG_AUTHORS[format], ...(author && !CATALOG_AUTHORS[format].includes(author) ? [author] : [])];
  const byName = (repo: string, label = '') => `${repo} ${label}`.toLowerCase().includes(state.q.toLowerCase());
  const triedShown = tried.filter((m) => byName(m.repo));
  const curatedShown = curatedFor(curated.data?.models ?? [], format).filter((m) => byName(m.repo, m.label));

  const count = view === 'hub' ? models.length : view === 'curated' ? curatedShown.length : triedShown.length;
  const countText = count === 1 ? t('models.catalog.count1') : t(view === 'hub' && hasNextPage ? 'models.catalog.countMore' : 'models.catalog.count', { n: integer(count) });
  const heading =
    view === 'tried'
      ? t('models.catalog.triedTitle')
      : view === 'curated'
        ? t('models.curated.title')
        : state.q
          ? t('models.catalog.resultsFor', { q: state.q })
          : t(`models.catalog.heading.${sort}`);
  const showCount = view !== 'hub' || catalog.isSuccess;

  return (
    <div className="grid gap-6 @3xl/page:grid-cols-[220px_minmax(0,1fr)]">
      <aside aria-label={t('models.catalog.filters')} className="flex flex-col gap-5 @3xl/page:sticky @3xl/page:top-4 @3xl/page:self-start">
        {/* Keeps the outline valid: page h1, then this h2, then the filter groups' h3. */}
        <h2 className="sr-only">{t('models.catalog.filters')}</h2>
        <FilterGroup title={t('models.catalog.viewLabel')}>
          <ViewList
            label={t('models.catalog.viewLabel')}
            value={view}
            onChange={(v) => onChange({ view: v })}
            options={[
              { value: 'hub', label: t('models.catalog.views.hub') },
              { value: 'curated', label: t('models.catalog.views.curated'), count: curatedFor(curated.data?.models ?? [], format).length },
              { value: 'tried', label: t('models.catalog.views.tried'), count: tried.length },
            ]}
          />
        </FilterGroup>
        <FilterGroup title={t('models.format.label')}>
          <ChipRadios
            label={t('models.format.label')}
            value={engine}
            onChange={(e) => onChange({ engine: e })}
            options={ENGINE_FILTERS.map((e) => ({ value: e, label: t(`models.format.${e}`) }))}
          />
        </FilterGroup>
        {view === 'hub' && (
          <>
            <FilterGroup title={t('models.search.size')}>
              <ChipRadios label={t('models.search.size')} value={size} onChange={(v) => onChange({ size: v })} options={SIZES.map((v) => ({ value: v, label: t(`models.catalog.sizes.${v}`) }))} />
            </FilterGroup>
            <FilterGroup title={t('models.catalog.memory')}>
              <div>
                <FilterChip pressed={onlyFits} onPressedChange={(v) => onChange({ onlyFits: v })}>
                  {t('models.catalog.onlyFits')}
                </FilterChip>
              </div>
            </FilterGroup>
            <FilterGroup title={t('models.catalog.author')}>
              <ChipRadios
                label={t('models.catalog.author')}
                value={author || ALL_AUTHORS}
                onChange={(v) => onChange({ author: v === ALL_AUTHORS ? '' : v })}
                options={[{ value: ALL_AUTHORS, label: t('models.catalog.allAuthors') }, ...authors.map((a) => ({ value: a, label: a }))]}
              />
            </FilterGroup>
            {filtered && (
              <Button variant="ghost" size="sm" className="self-start" onClick={clear}>
                <X aria-hidden />
                {t('models.catalog.clearFilters')}
              </Button>
            )}
          </>
        )}
      </aside>

      <section aria-labelledby={ids.title} className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
          <div className="flex min-w-0 items-baseline gap-2.5">
            <h2 id={ids.title} className="truncate text-lg font-semibold tracking-[-0.01em]" title={heading}>
              {heading}
            </h2>
            {showCount && (
              <span className="shrink-0 text-sm text-fg-3 tabular-nums" aria-live="polite">
                {countText}
              </span>
            )}
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <div className="relative w-60">
              <Search aria-hidden className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-3" />
              <Input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder={t('models.catalog.filterPlaceholder')} aria-label={t('models.search.label')} className="h-9 pl-8" />
            </div>
            {view === 'hub' && (
              <>
                <label htmlFor={ids.sort} className="sr-only">
                  {t('models.search.sort')}
                </label>
                <Select id={ids.sort} className="h-9 w-48" value={sort} onValueChange={(s: CatalogSort) => onChange({ sort: s })} options={SORTS.map((s) => ({ value: s, label: t(`models.catalog.sort.${s}`) }))} />
              </>
            )}
          </div>
        </div>
        {view !== 'tried' && <CatalogBusyNote />}
        {/* vLLM and SGLang models need Docker: say it now if it is off or stuck, with the button. */}
        {(engine === 'vllm' || engine === 'sglang') && <DockerSearchNote />}

        {view === 'curated' ? (
          <CuratedRows models={curatedShown} showEngine={engine === 'any'} />
        ) : view === 'tried' ? (
          triedShown.length === 0 ? (
            <EmptyState illustration="search" title={t('models.catalog.triedEmptyTitle')} description={t('models.catalog.triedEmptyBody')} headingLevel={3} className="rounded-xl border border-dashed border-border" />
          ) : (
            <ul className="grid gap-2 @5xl/page:grid-cols-2 @[100rem]/page:grid-cols-3" aria-label={t('models.catalog.triedTitle')}>
              {triedShown.map((m) => (
                <TriedRow key={m.repo} m={m} />
              ))}
            </ul>
          )
        ) : catalog.isError && models.length === 0 ? (
          <ErrorCallout error={catalog.error} action={{ label: t('common.retry'), onClick: () => void catalog.refetch() }} />
        ) : catalog.isPending ? (
          <SkeletonRows />
        ) : models.length === 0 && !hasNextPage ? (
          <EmptyState
            illustration="search"
            title={t('models.search.noResults')}
            description={t('models.search.noResultsBody')}
            headingLevel={3}
            className="rounded-xl border border-dashed border-border"
            {...(filtered ? { action: <Button onClick={clear}>{t('models.catalog.clearFilters')}</Button> } : {})}
          />
        ) : (
          <>
            <ul className="grid gap-2 @5xl/page:grid-cols-2 @[100rem]/page:grid-cols-3" aria-label={t('models.catalog.results')}>
              {models.map((m) => (
                <HubRow key={m.repo} m={m} tried={triedByRepo.get(m.repo)} engine={engine} gpu={gpu} />
              ))}
            </ul>
            {catalog.isFetchNextPageError && <ErrorCallout error={catalog.error} action={{ label: t('common.retry'), onClick: () => void fetchNextPage() }} />}
            <div ref={sentinel} className="flex justify-center py-2">
              {hasNextPage ? (
                <Button onClick={() => void fetchNextPage()} disabled={isFetchingNextPage}>
                  {isFetchingNextPage && <Loader2 aria-hidden className="animate-spin" />}
                  {isFetchingNextPage ? t('models.catalog.loadingMore') : t('models.catalog.loadMore')}
                </Button>
              ) : (
                <p className="text-sm text-fg-3">{t('models.catalog.end')}</p>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
