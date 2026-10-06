import { Link } from '@tanstack/react-router';
import { Check, Cpu, Download, Heart, Loader2, Lock, Search, X } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import type { HubModel } from '../../../contract/models';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/cn';
import { useAllRuns, useGpuSnapshot, useHubCatalog, useMainGpu, type CatalogParams, type CatalogSort } from '../../lib/queries-library';
import { useDebounced } from '../../lib/queries-runs';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Callout } from '../ui/callout';
import { EmptyState } from '../ui/empty-state';
import { FitBadge } from '../ui/fit-badge';
import { Input } from '../ui/input';
import { SegmentedControl } from '../ui/segmented-control';
import { Select } from '../ui/select';
import { Skeleton } from '../ui/skeleton';
import { TriedBadge } from '../ui/tried-badge';
import { CuratedList, type EngineFormat } from './curated-list';
import { ErrorCallout } from './error-callout';
import { bucketRange, triedModels, type SizeBucket, type TriedModel } from './helpers';

/** Authors offered in the filter, by format: the big GGUF quantizers and the labs that publish weights. */
export const CATALOG_AUTHORS: Record<EngineFormat, readonly string[]> = {
  gguf: ['unsloth', 'bartowski', 'lmstudio-community', 'ggml-org', 'mradermacher', 'Qwen', 'google'],
  safetensors: ['Qwen', 'google', 'meta-llama', 'mistralai', 'microsoft', 'nvidia', 'openai', 'deepseek-ai', 'RedHatAI'],
  any: ['unsloth', 'bartowski', 'lmstudio-community', 'Qwen', 'google', 'meta-llama', 'mistralai', 'microsoft', 'nvidia', 'openai', 'deepseek-ai'],
};

const SORTS: readonly CatalogSort[] = ['downloads', 'trendingScore', 'likes', 'createdAt', 'lastModified'];
const SIZES: readonly SizeBucket[] = ['any', 'small', 'medium', 'large', 'huge'];
/** Select value of "every author" (Radix selects cannot use an empty value). */
const ALL_AUTHORS = '*';

/** On/off filter drawn as a chip (a toggle button: screen readers announce "pressed"). */
function FilterChip({ pressed, onPressedChange, children }: { pressed: boolean; onPressedChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={() => onPressedChange(!pressed)}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-sm transition-colors focus-ring',
        pressed ? 'border-accent bg-accent-soft text-accent-text' : 'border-border-strong bg-surface text-fg-2 hover:border-fg-3 hover:text-fg',
      )}
    >
      {pressed && <Check aria-hidden className="size-3.5" />}
      {children}
    </button>
  );
}

function Monogram({ name }: { name: string }) {
  return (
    <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-2 text-sm font-semibold text-fg-2 uppercase ring-1 ring-border">
      {name.slice(0, 1)}
    </span>
  );
}

/** Model name as a link covering the whole card; other controls sit above it. */
function CardTitle({ owner, name }: { owner: string; name: string }) {
  return (
    <h3 className="text-sm leading-snug font-semibold break-words text-fg">
      <Link to="/models/hub/$owner/$name" params={{ owner, name }} className="rounded-sm after:absolute after:inset-0 after:rounded-xl focus-ring">
        {name}
      </Link>
    </h3>
  );
}

const cardClass =
  'group relative flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-xs transition-[border-color,box-shadow,transform] hover:-translate-y-px hover:border-border-strong hover:shadow-md has-[a:focus-visible]:border-accent';

function CatalogCard({ m, tried, onAuthor }: { m: HubModel; tried: TriedModel | undefined; onAuthor: (author: string) => void }) {
  const { t, number, integer, relative, bytes } = useI18n();
  const [owner, name] = m.repo.split('/') as [string, string];
  const mib = (n: number) => bytes(n * 1024 * 1024);
  return (
    <li className={cardClass}>
      <div className="flex items-start gap-3">
        <Monogram name={owner} />
        <div className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
          <CardTitle owner={owner} name={name} />
          <button
            type="button"
            onClick={() => onAuthor(owner)}
            aria-label={t('models.catalog.moreBy', { author: owner })}
            className="relative z-10 max-w-full truncate rounded-sm text-xs text-fg-3 hover:text-accent-text hover:underline focus-ring"
          >
            {owner}
          </button>
        </div>
      </div>
      <div className="relative z-10 flex flex-wrap gap-1.5 self-start">
        {m.fit ? (
          <FitBadge level={m.fit.level} size="sm" detail={t('models.catalog.fitDetail', { quant: m.fit.quant, need: mib(m.fit.needMiB), available: mib(m.fit.availableMiB) })} />
        ) : (
          <Badge size="sm" tone="neutral">
            {t('models.catalog.sizeUnknown')}
          </Badge>
        )}
        {m.paramsB !== undefined && (
          <Badge size="sm" tone="neutral">
            <Cpu aria-hidden />
            {t('models.params', { n: number(m.paramsB, 1) })}
          </Badge>
        )}
        {m.formats
          .filter((f) => f !== 'other')
          .map((f) => (
            <Badge key={f} size="sm" tone="outline">
              {f === 'gguf' ? 'GGUF' : 'safetensors'}
            </Badge>
          ))}
        {m.gated !== false && (
          <Badge size="sm" tone="warning">
            <Lock aria-hidden />
            {t('models.search.gated')}
          </Badge>
        )}
        {tried?.tps !== undefined && <TriedBadge tps={tried.tps} date={tried.date} size="sm" short />}
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-3 text-xs text-fg-3 tabular-nums">
        <span className="inline-flex items-center gap-1">
          <Download aria-hidden className="size-3" />
          {t('models.search.downloads', { n: integer(m.downloads) })}
        </span>
        <span className="inline-flex items-center gap-1">
          <Heart aria-hidden className="size-3" />
          {t('models.search.likes', { n: integer(m.likes) })}
        </span>
        {m.updatedAt && <span>{t('models.search.updated', { when: relative(m.updatedAt) })}</span>}
      </div>
    </li>
  );
}

function TriedCard({ m }: { m: TriedModel }) {
  const { t, relative } = useI18n();
  return (
    <li className={cardClass}>
      <div className="flex items-start gap-3">
        <Monogram name={m.owner} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <CardTitle owner={m.owner} name={m.name} />
          <span className="truncate text-xs text-fg-3">{m.owner}</span>
        </div>
      </div>
      <div className="relative z-10 flex flex-wrap gap-1.5 self-start">
        {m.tps !== undefined && <TriedBadge tps={m.tps} date={m.date} size="sm" short />}
        {m.quant && (
          <Badge size="sm" tone="outline">
            {m.quant}
          </Badge>
        )}
      </div>
      <p className="mt-auto border-t border-border pt-3 text-xs text-fg-3">{t('models.catalog.triedRuns', { n: m.runs, when: relative(m.date) })}</p>
    </li>
  );
}

function SkeletonGrid() {
  const { t } = useI18n();
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label={t('common.loading')} role="status">
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} className="h-40 rounded-xl" />
      ))}
    </div>
  );
}

/** Share of the card other programs may hold before the fit verdicts deserve an explanation. */
export const BUSY_VRAM_SHARE = 0.15;

/**
 * Verdicts count the VRAM that is free now. When other programs hold a good part of it (a VM, a
 * game, another LLM server), "partly fits" on a big card looks wrong without this note.
 */
function BusyVramNote() {
  const { t, bytes } = useI18n();
  const s = useGpuSnapshot(5000).data?.[0];
  const used = s?.memUsedMiB ?? 0;
  const total = s?.memTotalMiB ?? 0;
  if (used < total * BUSY_VRAM_SHARE || total === 0) return null;
  const mib = (n: number) => bytes(n * 1024 * 1024);
  return (
    <Callout tone="info" title={t('models.catalog.busyTitle', { used: mib(used), total: mib(total) })}>
      {t('models.catalog.busyBody', { free: mib(total - used) })}
    </Callout>
  );
}

/** Loads the next page when the end of the grid scrolls into view (and keeps going while it stays there). */
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
 * Modelli → Scarica: a store-like catalog of Hugging Face models. One big search box, filter chips,
 * the recommended models for this GPU on top, then every matching model page after page. Models
 * that do not fit stay visible, marked, unless the user asks for "only what fits".
 */
export function ModelCatalog({ format, onFormatChange }: { format: EngineFormat; onFormatChange: (f: EngineFormat) => void }) {
  const { t, integer } = useI18n();
  const ids = { sort: useId(), author: useId(), title: useId() };
  const [text, setText] = useState('');
  // Most downloaded first: proven models before this week's experiments.
  const [sort, setSort] = useState<CatalogSort>('downloads');
  const [size, setSize] = useState<SizeBucket>('any');
  const [author, setAuthor] = useState('');
  const [onlyFits, setOnlyFits] = useState(false);
  const [onlyTried, setOnlyTried] = useState(false);
  const q = useDebounced(text.trim(), 350);
  const params: CatalogParams = { q, format, sort, author, onlyFits, ...bucketRange(size) };
  const catalog = useHubCatalog(params, !onlyTried);
  const runs = useAllRuns();
  const gpu = useMainGpu();
  const tried = triedModels(runs.data, gpu);
  const triedByRepo = new Map(tried.map((m) => [m.repo, m]));
  const models = catalog.data?.pages.flatMap((p) => p.models) ?? [];
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = catalog;
  // fetchNextPage is stable (bound to the query observer), so the effect re-runs only when the state changes.
  const sentinel = useNearEnd(fetchNextPage, hasNextPage && !isFetchingNextPage && !catalog.isError);
  const filtered = author !== '' || size !== 'any' || onlyFits;
  const clear = () => {
    setAuthor('');
    setSize('any');
    setOnlyFits(false);
  };
  const authors = [...CATALOG_AUTHORS[format], ...(author && !CATALOG_AUTHORS[format].includes(author) ? [author] : [])];
  const triedShown = tried.filter((m) => m.repo.toLowerCase().includes(q.toLowerCase()));

  const count = onlyTried ? triedShown.length : models.length;
  const countText = count === 1 ? t('models.catalog.count1') : t(hasNextPage && !onlyTried ? 'models.catalog.countMore' : 'models.catalog.count', { n: integer(count) });
  const heading = onlyTried ? t('models.catalog.triedTitle') : q ? t('models.catalog.resultsFor', { q }) : t(`models.catalog.heading.${sort}`);

  return (
    <div className="flex flex-col gap-section">
      <section aria-labelledby={ids.title} className="hero-wash flex flex-col gap-4 rounded-2xl border border-border bg-surface p-6 shadow-sm">
        <div className="flex flex-col gap-1">
          <h2 id={ids.title} className="text-xl font-semibold tracking-[-0.015em]">
            {t('models.catalog.title')}
          </h2>
          <p className="text-sm text-fg-2">{t('models.catalog.subtitle')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-[18rem] flex-1">
            <Search aria-hidden className="absolute top-1/2 left-3.5 size-5 -translate-y-1/2 text-fg-3" />
            <Input
              type="search"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t('models.searchPlaceholder')}
              aria-label={t('models.search.label')}
              className="h-12 rounded-xl pl-11 text-md shadow-xs"
            />
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor={ids.sort} className="text-sm text-fg-2">
              {t('models.search.sort')}
            </label>
            <Select
              id={ids.sort}
              className="w-52"
              value={sort}
              onValueChange={setSort}
              disabled={onlyTried}
              options={SORTS.map((s) => ({ value: s, label: t(`models.catalog.sort.${s}`) }))}
            />
          </div>
        </div>
        <div className="flex flex-col gap-3 border-t border-border pt-4">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <div className="flex items-center gap-2">
              <span className="text-sm text-fg-2">{t('models.format.label')}</span>
              <SegmentedControl
                size="sm"
                label={t('models.format.label')}
                value={format}
                onValueChange={onFormatChange}
                options={[
                  { value: 'gguf', label: t('models.format.gguf') },
                  { value: 'safetensors', label: t('models.format.safetensors') },
                  { value: 'any', label: t('models.format.any') },
                ]}
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-fg-2">{t('models.search.size')}</span>
              <SegmentedControl size="sm" label={t('models.search.size')} value={size} onValueChange={setSize} options={SIZES.map((v) => ({ value: v, label: t(`models.catalog.sizes.${v}`) }))} />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor={ids.author} className="sr-only">
              {t('models.catalog.author')}
            </label>
            <Select
              id={ids.author}
              className="h-8 w-52 rounded-full"
              value={author || ALL_AUTHORS}
              onValueChange={(v) => setAuthor(v === ALL_AUTHORS ? '' : v)}
              options={[{ value: ALL_AUTHORS, label: t('models.catalog.allAuthors') }, ...authors.map((a) => ({ value: a, label: a }))]}
            />
            <FilterChip pressed={onlyFits} onPressedChange={setOnlyFits}>
              {t('models.catalog.onlyFits')}
            </FilterChip>
            <FilterChip pressed={onlyTried} onPressedChange={setOnlyTried}>
              {t('models.catalog.onlyTried')}
            </FilterChip>
            {filtered && (
              <Button variant="ghost" size="sm" onClick={clear}>
                <X aria-hidden />
                {t('models.catalog.clearFilters')}
              </Button>
            )}
          </div>
        </div>
      </section>

      {!onlyTried && <BusyVramNote />}

      {!q && !onlyTried && <CuratedList format={format} />}

      <section aria-labelledby={`${ids.title}-results`} className="flex flex-col gap-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 id={`${ids.title}-results`} className="text-lg font-semibold tracking-[-0.01em]">
            {heading}
          </h2>
          {(onlyTried || catalog.isSuccess) && (
            <p className="text-sm text-fg-3 tabular-nums" aria-live="polite">
              {countText}
            </p>
          )}
        </div>
        {onlyTried ? (
          triedShown.length === 0 ? (
            <EmptyState illustration="search" title={t('models.catalog.triedEmptyTitle')} description={t('models.catalog.triedEmptyBody')} headingLevel={3} className="rounded-xl border border-dashed border-border" />
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label={t('models.catalog.triedTitle')}>
              {triedShown.map((m) => (
                <TriedCard key={m.repo} m={m} />
              ))}
            </ul>
          )
        ) : catalog.isError && models.length === 0 ? (
          <ErrorCallout error={catalog.error} action={{ label: t('common.retry'), onClick: () => void catalog.refetch() }} />
        ) : catalog.isPending ? (
          <SkeletonGrid />
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
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label={t('models.catalog.results')}>
              {models.map((m) => (
                <CatalogCard key={m.repo} m={m} tried={triedByRepo.get(m.repo)} onAuthor={setAuthor} />
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
