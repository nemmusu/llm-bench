import path from 'node:path';
import { AppError } from '../../contract/errors';
import type { HubFile, HubModel } from '../../contract/models';
import { errorMessage, factsFromGguf, parseGgufHeader } from './gguf';
import { factsFromHfConfig } from './hf-config';
import { parseShard } from './paths';
import { paramsFromLabel, quantFromFilename, round3 } from './quant';
import type { ModelFactsEx, TokenFn } from './types';

export type HubFormat = 'gguf' | 'safetensors' | 'any';
export type HubSort = 'downloads' | 'likes' | 'lastModified' | 'trendingScore';

export interface SearchOptions {
  format?: HubFormat;
  sort?: HubSort;
  limit?: number;
}

export interface HubRepoInfo extends HubModel {
  /** Commit sha of the requested revision. */
  sha?: string;
  private: boolean;
}

export interface RemoteGgufFacts {
  facts: ModelFactsEx;
  /** Size of the file that was read (first shard for split models). */
  fileBytes?: number;
}

export interface HubClientOptions {
  fetch: typeof fetch;
  /** e.g. https://huggingface.co (tests: the fake hub). */
  baseUrl: string;
  getToken: TokenFn;
  now?: () => number;
  cacheTtlMs?: number;
  maxCacheEntries?: number;
}

/** Model card size cap: enough for any real README, bounded against hostile repos. */
export const README_MAX_BYTES = 256 * 1024;

const SEARCH_EXPAND = ['downloads', 'likes', 'lastModified', 'gated', 'cardData', 'safetensors', 'pipeline_tag', 'tags'];

/**
 * Maps an HF error response to an AppError. HF sends `X-Error-Code` (GatedRepo, RepoNotFound,
 * EntryNotFound, RevisionNotFound); a missing or private repo without a token is a bare 401.
 */
export function hubHttpError(res: Response, repo?: string): AppError {
  const code = res.headers.get('x-error-code') ?? '';
  const detail = res.headers.get('x-error-message') ?? undefined;
  const params: Record<string, string | number> = { status: res.status };
  if (repo) params.repo = repo;
  const opts = { params, ...(detail ? { detail } : {}) };
  if (code === 'GatedRepo' || res.status === 403) return new AppError('HF_GATED', `Access to ${repo ?? 'the repo'} requires accepting its license`, opts);
  if (res.status === 401) return new AppError('HF_AUTH_REQUIRED', 'Hugging Face requires a valid token for this repo', opts);
  if (res.status === 404) return new AppError('HF_NOT_FOUND', `Not found on Hugging Face (${code || 'HTTP 404'})`, opts);
  if (res.status === 429) return new AppError('HF_RATE_LIMITED', 'Hugging Face rate limit reached', opts);
  return new AppError('NETWORK', `Hugging Face returned HTTP ${res.status}`, opts);
}

/** Releases the connection of a response whose body we do not need. */
export async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    /* already closed */
  }
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
function strs(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** File role inside a repo, from its path. */
export function fileKind(p: string): HubFile['kind'] {
  const base = path.posix.basename(p).toLowerCase();
  if (base.endsWith('.gguf')) {
    if (base.includes('mmproj')) return 'mmproj';
    if (/(^|[-_.])mtp([-_.]|$)/.test(base) || /(^|\/)mtp\//i.test(p)) return 'mtp';
    // Speculative-decoding drafts (EAGLE heads, *-draft) are not standalone models.
    if (/(^|[-_.])(draft|eagle\d*)([-_.]|$)/.test(base)) return 'other';
    return 'weights';
  }
  if (base.endsWith('.safetensors') || /^pytorch_model.*\.bin$/.test(base)) return 'weights';
  if (['config.json', 'generation_config.json', 'params.json', 'preprocessor_config.json'].includes(base) || base.endsWith('.index.json')) return 'config';
  if (base.startsWith('tokenizer') || base.startsWith('chat_template') || ['vocab.json', 'merges.txt', 'special_tokens_map.json', 'added_tokens.json'].includes(base) || base.endsWith('.model')) return 'tokenizer';
  return 'other';
}

/** Split shards share the prefix as groupKey; single files use their own path. */
export function groupKeyFor(p: string): string {
  const shard = parseShard(path.posix.basename(p));
  return shard ? path.posix.join(path.posix.dirname(p), shard.prefix) : p;
}

export function toHubFile(entry: Record<string, unknown>): HubFile {
  const p = String(entry.path);
  const lfs = obj(entry.lfs);
  const oid = typeof lfs?.oid === 'string' && /^[0-9a-f]{64}$/.test(lfs.oid) ? lfs.oid : undefined;
  const kind = fileKind(p);
  const file: HubFile = { path: p, sizeBytes: Number(lfs?.size ?? entry.size ?? 0), kind };
  if (oid) file.sha256 = oid;
  if (p.toLowerCase().endsWith('.gguf')) {
    const quant = quantFromFilename(path.posix.basename(p));
    if (quant) file.quant = quant;
    if (kind === 'weights') file.groupKey = groupKeyFor(p);
  }
  return file;
}

export function toHubModel(raw: Record<string, unknown>): HubModel {
  const repo = String(raw.id ?? raw.modelId);
  const slash = repo.indexOf('/');
  const tags = strs(raw.tags);
  const card = obj(raw.cardData) ?? {};
  const formats: HubModel['formats'] = [];
  if (tags.includes('gguf') || obj(raw.gguf)) formats.push('gguf');
  if (tags.includes('safetensors') || obj(raw.safetensors)) formats.push('safetensors');
  const name = repo.slice(slash + 1);
  const totalParams = Number(obj(raw.safetensors)?.total ?? obj(raw.gguf)?.total ?? 0);
  const paramsB = totalParams > 0 ? round3(totalParams / 1e9) : paramsFromLabel(name);
  const baseCard = Array.isArray(card.base_model) ? strs(card.base_model)[0] : card.base_model;
  const baseTag = tags.find((t) => t.startsWith('base_model:') && t.split(':').length === 2)?.slice('base_model:'.length);
  const license = (typeof card.license === 'string' ? card.license : undefined) ?? tags.find((t) => t.startsWith('license:'))?.slice('license:'.length);
  const gated = raw.gated === 'auto' || raw.gated === 'manual' ? raw.gated : raw.gated === true;
  const model: HubModel = {
    repo,
    author: slash > 0 ? repo.slice(0, slash) : '',
    name,
    downloads: Number(raw.downloads ?? 0),
    likes: Number(raw.likes ?? 0),
    gated,
    formats,
    tags,
  };
  if (typeof raw.lastModified === 'string') model.updatedAt = raw.lastModified;
  if (license) model.license = license;
  if (paramsB) model.paramsB = paramsB;
  if (typeof raw.pipeline_tag === 'string') model.pipelineTag = raw.pipeline_tag;
  const baseModel = typeof baseCard === 'string' ? baseCard : baseTag;
  if (baseModel) model.baseModel = baseModel;
  return model;
}

interface CacheEntry {
  expires: number;
  value: Promise<unknown>;
}

/** Hugging Face Hub API client on the injected fetch, with a small in-memory TTL cache. */
export class HubClient {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly now: () => number;
  private readonly ttl: number;
  private readonly maxEntries: number;
  readonly baseUrl: string;

  constructor(private readonly opts: HubClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.now = opts.now ?? Date.now;
    this.ttl = opts.cacheTtlMs ?? 5 * 60_000;
    this.maxEntries = opts.maxCacheEntries ?? 200;
  }

  /** Authorization header, sent only to the hub's own origin (never to CDN redirect targets). */
  authHeaders(url: string): Record<string, string> {
    const token = this.opts.getToken();
    if (!token || new URL(url).origin !== new URL(this.baseUrl).origin) return {};
    return { authorization: `Bearer ${token}` };
  }

  resolveUrl(repo: string, revision: string, file: string): string {
    const encoded = file.split('/').map(encodeURIComponent).join('/');
    return `${this.baseUrl}/${repo}/resolve/${encodeURIComponent(revision)}/${encoded}`;
  }

  clearCache(): void {
    this.cache.clear();
  }

  /** GET with auth, network-error and HTTP-error mapping. */
  async request(url: string, repo?: string, init: RequestInit = {}): Promise<Response> {
    let res: Response;
    try {
      res = await this.opts.fetch(url, { ...init, headers: { ...this.authHeaders(url), ...(init.headers as Record<string, string>) } });
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      throw new AppError('NETWORK', `Cannot reach Hugging Face: ${errorMessage(e)}`, { cause: e });
    }
    if (!res.ok) {
      await discardBody(res);
      throw hubHttpError(res, repo);
    }
    return res;
  }

  private async getJson(url: string, repo?: string): Promise<unknown> {
    const res = await this.request(url, repo);
    try {
      return await res.json();
    } catch (e) {
      throw new AppError('NETWORK', `Hugging Face sent invalid JSON: ${errorMessage(e)}`, { cause: e });
    }
  }

  private cached<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
    const fullKey = `${this.opts.getToken() ? 'auth' : 'anon'} ${key}`;
    const hit = this.cache.get(fullKey);
    if (hit && hit.expires > this.now()) return hit.value as Promise<T>;
    const value = fn();
    this.cache.set(fullKey, { expires: this.now() + ttl, value });
    // Failures are not cached: the user may add a token or the network may come back.
    value.catch(() => this.cache.delete(fullKey));
    if (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value as string);
    return value;
  }

  search(q: string, opts: SearchOptions = {}): Promise<HubModel[]> {
    const p = new URLSearchParams();
    if (q.trim()) p.set('search', q.trim());
    if (opts.format === 'gguf' || opts.format === 'safetensors') p.append('filter', opts.format);
    return this.listModels(p, opts);
  }

  /**
   * GGUF conversions of a base model. HF tags quantized derivatives with
   * `base_model:quantized:<repo>` (filter is AND-ed with `gguf`); repos without card metadata are
   * found by a name search instead.
   */
  async related(baseRepo: string, opts: SearchOptions = {}): Promise<HubModel[]> {
    const p = new URLSearchParams();
    p.append('filter', `base_model:quantized:${baseRepo}`);
    p.append('filter', 'gguf');
    const tagged = await this.listModels(p, opts);
    if (tagged.length > 0) return tagged;
    const name = baseRepo.slice(baseRepo.indexOf('/') + 1);
    const found = await this.search(name, { ...opts, format: 'gguf' });
    return found.filter((m) => m.repo !== baseRepo);
  }

  private listModels(p: URLSearchParams, opts: SearchOptions): Promise<HubModel[]> {
    p.set('sort', opts.sort ?? 'downloads');
    p.set('direction', '-1');
    p.set('limit', String(Math.min(100, Math.max(1, Math.floor(opts.limit ?? 30)))));
    for (const e of SEARCH_EXPAND) p.append('expand[]', e);
    const url = `${this.baseUrl}/api/models?${p.toString()}`;
    return this.cached(url, this.ttl, async () => {
      const raw = await this.getJson(url);
      if (!Array.isArray(raw)) throw new AppError('NETWORK', 'Unexpected search response from Hugging Face');
      return raw.map((r) => toHubModel(obj(r) ?? {})).filter((m) => m.repo.includes('/'));
    });
  }

  info(repo: string, revision?: string): Promise<HubRepoInfo> {
    const url = revision ? `${this.baseUrl}/api/models/${repo}/revision/${encodeURIComponent(revision)}` : `${this.baseUrl}/api/models/${repo}`;
    return this.cached(url, this.ttl, async () => {
      const raw = obj(await this.getJson(url, repo)) ?? {};
      const info: HubRepoInfo = { ...toHubModel({ id: repo, ...raw }), private: raw.private === true };
      if (typeof raw.sha === 'string') info.sha = raw.sha;
      return info;
    });
  }

  /** Every file of a revision with sizes and LFS sha256 (follows `Link: rel="next"` pages). */
  files(repo: string, revision = 'main'): Promise<HubFile[]> {
    const first = `${this.baseUrl}/api/models/${repo}/tree/${encodeURIComponent(revision)}?recursive=true`;
    return this.cached(first, this.ttl, async () => {
      const out: HubFile[] = [];
      let url: string | undefined = first;
      for (let page = 0; url && page < 20; page++) {
        const res = await this.request(url, repo);
        const raw = (await res.json()) as unknown;
        if (!Array.isArray(raw)) throw new AppError('NETWORK', 'Unexpected file list from Hugging Face');
        for (const e of raw) {
          const entry = obj(e);
          if (entry?.type === 'file' && typeof entry.path === 'string') out.push(toHubFile(entry));
        }
        const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1];
        url = next ? new URL(next, this.baseUrl).toString() : undefined;
      }
      return out;
    });
  }

  /** Raw model card (README.md), capped at README_MAX_BYTES. */
  readme(repo: string, revision = 'main'): Promise<{ text: string; truncated: boolean }> {
    const url = `${this.baseUrl}/${repo}/raw/${encodeURIComponent(revision)}/README.md`;
    return this.cached(url, this.ttl, async () => {
      const res = await this.request(url, repo);
      const { bytes, truncated } = await readCapped(res, README_MAX_BYTES);
      return { text: new TextDecoder().decode(bytes), truncated };
    });
  }

  /** GGUF facts of a remote file via HTTP Range reads of its header only. */
  ggufFacts(repo: string, file: string, revision = 'main'): Promise<RemoteGgufFacts> {
    const url = this.resolveUrl(repo, revision, file);
    return this.cached(`gguf ${url}`, this.ttl * 6, async () => {
      const header = await parseGgufHeader(url, this.rangeFetch(repo));
      const shard = parseShard(path.posix.basename(file));
      // A shard holds only part of the tensors: let general.size_label give the parameter count.
      const whole = !shard || shard.total === 1;
      const facts = factsFromGguf(header.metadata, {
        fileName: path.posix.basename(file),
        ...(whole
          ? { parameterCount: header.parameterCount, fileBytes: header.fileSize, cpuOnlyBytes: header.hasOutputTensor ? header.tokenEmbdBytes : undefined }
          : {}),
      });
      return { facts, ...(header.fileSize !== undefined ? { fileBytes: header.fileSize } : {}) };
    });
  }

  /** Facts of a safetensors repo from config.json + the file list (for vLLM). */
  configFacts(repo: string, revision = 'main'): Promise<{ facts: ModelFactsEx; fileBytes: number }> {
    return this.cached(`config ${repo}@${revision}`, this.ttl, async () => {
      const [config, files, info] = await Promise.all([
        this.getJson(this.resolveUrl(repo, revision, 'config.json'), repo),
        this.files(repo, revision),
        this.info(repo),
      ]);
      const weights = files.filter((f) => f.kind === 'weights' && f.path.endsWith('.safetensors'));
      const fileBytes = weights.reduce((a, f) => a + f.sizeBytes, 0);
      const parameterCount = info.paramsB !== undefined && info.paramsB > 0 ? info.paramsB * 1e9 : undefined;
      return { facts: factsFromHfConfig(config, { name: repo, parameterCount, fileBytes }), fileBytes };
    });
  }

  /**
   * fetch for the GGUF parser: auth + error mapping, and protection against servers that ignore
   * Range (only the requested slice is read, so a 20 GB body is never buffered).
   */
  private rangeFetch(repo: string): typeof fetch {
    return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const res = await this.request(String(input), repo, init);
      if (res.status === 206) return res;
      const [start, end] = requestedRange(init);
      const { bytes } = await readCapped(res, end + 1, start);
      const total = res.headers.get('content-length');
      const headers: Record<string, string> = total ? { 'content-range': `bytes ${start}-${start + bytes.length - 1}/${total}` } : {};
      return new Response(bytes as Uint8Array<ArrayBuffer>, { status: 206, headers });
    }) as typeof fetch;
  }
}

/** [start, end] of a `Range: bytes=a-b` request header. */
export function requestedRange(init?: RequestInit): [number, number] {
  const m = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('range') ?? '');
  if (!m) throw new AppError('INTERNAL', 'GGUF header reads need an explicit byte range');
  return [Number(m[1]), Number(m[2])];
}

/** Reads body bytes [skip, limit) and cancels the rest of the stream. */
export async function readCapped(res: Response, limit: number, skip = 0): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let pos = 0;
  let truncated = false;
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const from = Math.max(0, skip - pos);
    const to = Math.min(value.length, limit - pos);
    if (to > from) chunks.push(value.subarray(from, to));
    pos += value.length;
    if (pos >= limit) {
      // Exactly at the cap: only one more read tells whether anything was left out.
      truncated = pos > limit || !(await reader.read()).done;
      await reader.cancel();
      break;
    }
  }
  const out = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return { bytes: out, truncated };
}
