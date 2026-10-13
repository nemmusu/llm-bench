import type { CatalogSort } from '../../lib/queries-library';
import { ENGINE_FILTERS, type EngineFilter } from './formats';
import { SIZE_BUCKETS, type SizeBucket } from './helpers';

/**
 * Modelli's URL: the tab, and every choice of the catalog (view, text, engine, sort, size, author,
 * "fits my GPU"). Kept in the URL so opening a model and coming back finds the same list, the same
 * pages loaded (the query cache is keyed by these) and the same scroll position (router restoration).
 * Defaults are left out, so a plain /models stays plain.
 */
export interface ModelsSearch {
  tab?: 'download';
  view?: 'curated' | 'tried';
  q?: string;
  engine?: Exclude<EngineFilter, 'gguf'>;
  sort?: Exclude<CatalogSort, 'trendingScore'>;
  size?: Exclude<SizeBucket, 'any'>;
  author?: string;
  fits?: true;
}

/** The catalog's choices with the defaults filled in. */
export interface CatalogState {
  view: 'hub' | 'curated' | 'tried';
  q: string;
  engine: EngineFilter;
  sort: CatalogSort;
  size: SizeBucket;
  author: string;
  onlyFits: boolean;
}

const SORTS: readonly CatalogSort[] = ['trendingScore', 'downloads', 'likes', 'createdAt', 'lastModified'];
const AUTHOR_RE = /^[A-Za-z0-9][\w.-]{0,95}$/;

/** Router validateSearch of /models: anything unknown or malformed is dropped. */
export function validateModelsSearch(s: Record<string, unknown>): ModelsSearch {
  const out: ModelsSearch = {};
  if (s.tab === 'download') out.tab = 'download';
  if (s.view === 'curated' || s.view === 'tried') out.view = s.view;
  if (typeof s.q === 'string' && s.q.trim() !== '') out.q = s.q.slice(0, 200);
  if (typeof s.engine === 'string' && s.engine !== 'gguf' && (ENGINE_FILTERS as readonly string[]).includes(s.engine)) out.engine = s.engine as ModelsSearch['engine'];
  if (typeof s.sort === 'string' && s.sort !== 'trendingScore' && (SORTS as readonly string[]).includes(s.sort)) out.sort = s.sort as ModelsSearch['sort'];
  if (typeof s.size === 'string' && s.size in SIZE_BUCKETS) out.size = s.size as ModelsSearch['size'];
  if (typeof s.author === 'string' && AUTHOR_RE.test(s.author)) out.author = s.author;
  if (s.fits === true || s.fits === 'true') out.fits = true;
  return out;
}

export function catalogState(s: ModelsSearch): CatalogState {
  return {
    view: s.view ?? 'hub',
    q: s.q ?? '',
    engine: s.engine ?? 'gguf',
    sort: s.sort ?? 'trendingScore',
    size: s.size ?? 'any',
    author: s.author ?? '',
    onlyFits: s.fits === true,
  };
}

/** The URL search of a catalog state (Scarica tab), defaults left out. */
export function searchOf(c: Partial<CatalogState>): ModelsSearch {
  return validateModelsSearch({
    tab: 'download',
    ...(c.view && c.view !== 'hub' ? { view: c.view } : {}),
    q: c.q?.trim(),
    engine: c.engine,
    sort: c.sort,
    size: c.size,
    author: c.author,
    fits: c.onlyFits === true,
  });
}

declare module '@tanstack/history' {
  interface HistoryState {
    /** The model page was opened from the catalog: its back link is a history "back". */
    fromCatalog?: boolean;
  }
}

/** The last catalog the user looked at, for the model page's "← Modelli" when it was not opened from there. */
let lastCatalog: ModelsSearch | undefined;

export function rememberCatalog(s: ModelsSearch): void {
  lastCatalog = s;
}

export function lastCatalogSearch(): ModelsSearch {
  return lastCatalog ?? { tab: 'download' };
}
