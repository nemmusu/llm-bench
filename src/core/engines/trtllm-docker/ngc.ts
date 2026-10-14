/**
 * NVIDIA's container registry (NGC, nvcr.io) for TensorRT-LLM's image: its tags, and the download size and
 * digest of one tag. Public images are read with an anonymous token (no NGC account):
 *
 *   GET /proxy_auth?scope=repository:<repo>:pull        → { token }
 *   GET /v2/<repo>/tags/list                            → { tags: [...] } (Link: rel="next" pages)
 *   GET /v2/<repo>/manifests/<tag>                      → the image index (its digest is what `docker pull`
 *                                                         records), then the linux/amd64 manifest: the layer sizes.
 */
import { AppError } from '../../../contract/errors';

export interface NgcTag {
  name: string;
  /** Compressed download size for linux/amd64. */
  sizeBytes?: number;
  /** The tag's digest (its image index for a multi-platform image), as RepoDigests records it. */
  digest?: string;
}

export interface NgcRegistryOptions {
  fetch: typeof globalThis.fetch;
  /** https://nvcr.io (tests: a fake). */
  baseUrl: string;
  clock: { now(): number };
  /** In-memory cache lifetime (default 10 min). */
  ttlMs?: number;
  /** Tag list pages followed. */
  maxPages?: number;
}

const INDEX_TYPES = ['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json'];
const MANIFEST_TYPES = ['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'];

interface ManifestJson {
  manifests?: { digest?: unknown; platform?: { architecture?: unknown; os?: unknown } }[];
  layers?: { size?: unknown }[];
  config?: { size?: unknown };
}

const sizeOf = (x: { size?: unknown } | undefined): number => (typeof x?.size === 'number' ? x.size : 0);

export class NgcRegistry {
  private readonly cache = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(private readonly o: NgcRegistryOptions) {}

  private base(): string {
    return this.o.baseUrl.replace(/\/+$/, '');
  }

  /** One answer per key for ttlMs; failures are not kept. */
  private cached<T>(key: string, refresh: boolean, make: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (!refresh && hit && this.o.clock.now() - hit.at < (this.o.ttlMs ?? 600_000)) return hit.value as Promise<T>;
    const value = make();
    this.cache.set(key, { at: this.o.clock.now(), value });
    value.catch(() => this.cache.delete(key));
    return value;
  }

  private async get(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<Response> {
    let res: Response;
    try {
      res = await this.o.fetch(url, { headers, ...(signal ? { signal } : {}) });
    } catch (e) {
      throw new AppError('NETWORK', `NVIDIA's registry is not reachable: ${String(e)}`, { cause: e, params: { service: 'ngc' } });
    }
    if (!res.ok) {
      throw new AppError('NETWORK', `NVIDIA's registry answered ${res.status}`, { params: { status: res.status, service: 'ngc', reason: res.status === 429 ? 'rate-limited' : 'http' } });
    }
    return res;
  }

  /** An anonymous pull token for `repo` (e.g. "nvidia/tensorrt-llm/release"). */
  private token(repo: string, signal?: AbortSignal): Promise<string> {
    return this.cached(`token|${repo}`, false, async () => {
      const res = await this.get(`${this.base()}/proxy_auth?scope=${encodeURIComponent(`repository:${repo}:pull`)}`, { accept: 'application/json' }, signal);
      const body = (await res.json()) as { token?: unknown };
      if (typeof body.token !== 'string' || body.token === '') throw new AppError('NETWORK', "NVIDIA's registry gave no token", { params: { service: 'ngc', reason: 'no-token' } });
      return body.token;
    });
  }

  private async authed(repo: string, path: string, accept: string, signal?: AbortSignal): Promise<Response> {
    const token = await this.token(repo, signal);
    return this.get(`${this.base()}${path}`, { accept, authorization: `Bearer ${token}` }, signal);
  }

  /** Every tag of `repo` (registry order); `refresh` asks again. */
  listTags(repo: string, opts: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<string[]> {
    return this.cached(`tags|${repo}`, opts.refresh === true, async () => {
      const out: string[] = [];
      let path: string | undefined = `/v2/${repo}/tags/list`;
      for (let page = 0; path !== undefined && page < (this.o.maxPages ?? 5); page++) {
        const res = await this.authed(repo, path, 'application/json', opts.signal);
        const body = (await res.json()) as { tags?: unknown };
        if (Array.isArray(body.tags)) out.push(...body.tags.filter((t): t is string => typeof t === 'string'));
        // Link: </v2/<repo>/tags/list?last=…&n=…>; rel="next" (only a path on the same registry is followed).
        const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1];
        path = next?.startsWith('/v2/') ? next : undefined;
      }
      return out;
    });
  }

  /** The digest and linux/amd64 download size of `repo:tag`. */
  tagInfo(repo: string, tag: string, opts: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<NgcTag> {
    return this.cached(`tag|${repo}|${tag}`, opts.refresh === true, async () => {
      const res = await this.authed(repo, `/v2/${repo}/manifests/${encodeURIComponent(tag)}`, [...INDEX_TYPES, ...MANIFEST_TYPES].join(', '), opts.signal);
      const digest = res.headers.get('docker-content-digest') ?? undefined;
      let body = (await res.json()) as ManifestJson;
      if (Array.isArray(body.manifests)) {
        // linux/amd64 (an entry that names no OS is Linux's).
        const amd64 = body.manifests.find((m) => m.platform?.architecture === 'amd64' && [undefined, 'linux'].includes(m.platform.os as string | undefined));
        if (typeof amd64?.digest !== 'string') return { name: tag, ...(digest ? { digest } : {}) };
        body = (await (await this.authed(repo, `/v2/${repo}/manifests/${amd64.digest}`, MANIFEST_TYPES.join(', '), opts.signal)).json()) as ManifestJson;
      }
      const size = (body.layers ?? []).reduce((n, l) => n + sizeOf(l), 0) + sizeOf(body.config);
      return { name: tag, ...(size > 0 ? { sizeBytes: size } : {}), ...(digest ? { digest } : {}) };
    });
  }
}
