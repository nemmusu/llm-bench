import { Link } from '@tanstack/react-router';
import { ArrowRight, BadgeCheck, Download, Heart, Lock, Search } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import type { HubModel } from '../../../contract/models';
import { useI18n } from '../../i18n';
import { useAllRuns, useHubSearch, useMainGpu, type HubSearchParams } from '../../lib/queries-library';
import { Badge } from '../ui/badge';
import { Card } from '../ui/card';
import { EmptyState } from '../ui/empty-state';
import { Input } from '../ui/input';
import { Select } from '../ui/select';
import { Skeleton } from '../ui/skeleton';
import { Switch } from '../ui/switch';
import type { EngineFormat } from './curated-list';
import { ErrorCallout } from './error-callout';
import { groupByBase, inBucket, triedRepos, type SizeBucket } from './helpers';

/** Waits for the user to stop typing before searching (one request per pause, not per key). */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

function ResultRow({ m, tried }: { m: HubModel; tried: boolean }) {
  const { t, number, integer, relative } = useI18n();
  const [owner, name] = m.repo.split('/') as [string, string];
  return (
    <li>
      <Link
        to="/models/hub/$owner/$name"
        params={{ owner, name }}
        className="group flex items-center gap-4 px-card py-3.5 transition-colors hover:bg-surface-2 focus-ring"
      >
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-semibold text-fg">{name}</span>
            <span className="text-sm text-fg-3">{owner}</span>
          </p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-3 tabular-nums">
            {m.paramsB !== undefined && <span>{t('models.params', { n: number(m.paramsB, 1) })}</span>}
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
          <div className="mt-0.5 flex flex-wrap gap-1.5">
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
            {tried && (
              <Badge size="sm" tone="accent">
                <BadgeCheck aria-hidden />
                {t('tried.label')}
              </Badge>
            )}
          </div>
        </div>
        <ArrowRight aria-hidden className="size-4 text-fg-3 transition-transform group-hover:translate-x-0.5" />
      </Link>
    </li>
  );
}

/** Live Hugging Face search with the filters a non-expert understands. */
export function HubSearch({ format }: { format: EngineFormat }) {
  const { t } = useI18n();
  const ids = { fits: useId(), tried: useId(), sort: useId(), size: useId() };
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<HubSearchParams['sort']>('downloads');
  const [size, setSize] = useState<SizeBucket>('any');
  const [onlyFits, setOnlyFits] = useState(false);
  const [onlyTried, setOnlyTried] = useState(false);
  const query = useDebounced(q.trim(), 350);
  const search = useHubSearch({ q: query, format, sort, onlyFits }, query.length >= 2);
  const runs = useAllRuns();
  const gpu = useMainGpu();
  const tried = triedRepos(runs.data, gpu);
  const results = (search.data ?? []).filter((m) => inBucket(m.paramsB, size) && (!onlyTried || tried.has(m.repo)));

  return (
    <section aria-labelledby="hub-search-title" className="flex flex-col gap-4">
      <h2 id="hub-search-title" className="text-lg font-semibold tracking-[-0.01em]">
        {t('models.search.title')}
      </h2>
      <div className="relative max-w-2xl">
        <Search aria-hidden className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-3" />
        <Input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('models.searchPlaceholder')}
          aria-label={t('models.search.label')}
          className="h-11 pl-9 text-md"
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm">
        <div className="flex items-center gap-2">
          <label htmlFor={ids.sort} className="text-fg-2">
            {t('models.search.sort')}
          </label>
          <Select
            id={ids.sort}
            className="w-44"
            value={sort}
            onValueChange={setSort}
            options={[
              { value: 'downloads', label: t('models.search.sortDownloads') },
              { value: 'likes', label: t('models.search.sortLikes') },
              { value: 'lastModified', label: t('models.search.sortNewest') },
              { value: 'trendingScore', label: t('models.search.sortTrending') },
            ]}
          />
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor={ids.size} className="text-fg-2">
            {t('models.search.size')}
          </label>
          <Select
            id={ids.size}
            className="w-44"
            value={size}
            onValueChange={setSize}
            options={(['any', 'small', 'medium', 'large', 'huge'] as const).map((v) => ({ value: v, label: t(`models.search.sizes.${v}`) }))}
          />
        </div>
        <div className="flex items-center gap-2">
          <Switch id={ids.fits} checked={onlyFits} onCheckedChange={setOnlyFits} />
          <label htmlFor={ids.fits}>{t('models.search.onlyFits')}</label>
        </div>
        <div className="flex items-center gap-2">
          <Switch id={ids.tried} checked={onlyTried} onCheckedChange={setOnlyTried} />
          <label htmlFor={ids.tried}>{t('models.search.onlyTried')}</label>
        </div>
      </div>
      {search.isError && <ErrorCallout error={search.error} action={{ label: t('common.retry'), onClick: () => void search.refetch() }} />}
      <Card>
        {query.length < 2 ? (
          <EmptyState illustration="search" title={t('models.searchEmptyTitle')} description={t('models.searchEmptyBody')} headingLevel={3} />
        ) : search.isPending ? (
          <div className="flex flex-col gap-3 p-card" aria-label={t('common.loading')}>
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
          </div>
        ) : results.length === 0 ? (
          <EmptyState illustration="search" title={t('models.search.noResults')} description={t('models.search.noResultsBody')} headingLevel={3} />
        ) : (
          <div className="divide-y divide-border">
            {groupByBase(results).map((g) => {
              // Conversions of one base model sit under a small header; everything else is a plain result.
              const grouped = g.base !== undefined && g.models.length > 1;
              return (
                <div key={(g.models[0] as HubModel).repo}>
                  {grouped && <p className="bg-surface-2 px-card py-1.5 text-xs font-medium text-fg-3">{t('models.search.basedOn', { base: g.base as string })}</p>}
                  <ul className="divide-y divide-border" aria-label={grouped ? t('models.search.basedOn', { base: g.base as string }) : t('models.search.results')}>
                    {g.models.map((m) => (
                      <ResultRow key={m.repo} m={m} tried={tried.has(m.repo)} />
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </section>
  );
}
