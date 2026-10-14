import { AppError } from '../../contract/errors';
import { isDockerHub, parseImageRef, type ImageRef } from './image-ref';

/** A tag as listed by Docker Hub (sizes are compressed download sizes for linux/amd64). */
export interface HubTag {
  name: string;
  lastUpdated?: string;
  sizeBytes?: number;
  digest?: string;
  /**
   * Every digest the tag is known by: the multi-platform index (`digest`) and each platform's manifest.
   * A local image matches the tag when Docker lists one of them (RepoDigests, or its id on the containerd store).
   */
  digests?: string[];
}

export interface DockerHubOptions {
  fetch: typeof globalThis.fetch;
  /** CoreEndpoints.dockerHub (https://hub.docker.com). */
  baseUrl: string;
  clock: { now(): number };
  /** In-memory cache lifetime (default 10 min): the tag list changes a few times a day. */
  ttlMs?: number;
  /** Pages followed when listing (100 tags each). */
  maxPages?: number;
}

interface HubTagJson {
  name?: unknown;
  last_updated?: unknown;
  full_size?: unknown;
  digest?: unknown;
  images?: { architecture?: unknown; os?: unknown; size?: unknown; digest?: unknown }[];
}

function toTag(r: HubTagJson): HubTag | undefined {
  if (typeof r.name !== 'string') return undefined;
  const out: HubTag = { name: r.name };
  if (typeof r.last_updated === 'string') out.lastUpdated = r.last_updated;
  // full_size is one of the platforms; the amd64 entry is what this PC downloads.
  const amd64 = (Array.isArray(r.images) ? r.images : []).find((i) => i.architecture === 'amd64' && (i.os ?? 'linux') === 'linux');
  const size = typeof amd64?.size === 'number' ? amd64.size : typeof r.full_size === 'number' ? r.full_size : undefined;
  if (size !== undefined) out.sizeBytes = size;
  if (typeof r.digest === 'string') out.digest = r.digest;
  const all = [r.digest, ...(Array.isArray(r.images) ? r.images.map((i) => i.digest) : [])].filter((d): d is string => typeof d === 'string' && d !== '');
  if (all.length) out.digests = [...new Set(all)];
  return out;
}

/** Docker Hub's public tag API (no auth needed for public repositories). */
export class DockerHubClient {
  private readonly cache = new Map<string, { at: number; value: Promise<HubTag[]> }>();

  constructor(private readonly o: DockerHubOptions) {}

  private base(): string {
    return this.o.baseUrl.replace(/\/+$/, '');
  }

  private async getJson(url: string, signal?: AbortSignal): Promise<unknown> {
    let res: Response;
    try {
      res = await this.o.fetch(url, { headers: { accept: 'application/json' }, ...(signal ? { signal } : {}) });
    } catch (e) {
      throw new AppError('NETWORK', `Docker Hub is not reachable: ${String(e)}`, { cause: e });
    }
    if (res.status === 404) return undefined;
    if (!res.ok) {
      throw new AppError('NETWORK', `Docker Hub answered ${res.status}`, {
        params: { status: res.status, service: 'dockerhub', reason: res.status === 429 ? 'rate-limited' : 'http' },
      });
    }
    return res.json();
  }

  /**
   * Tags of `namespace/repo` whose name contains `nameFilter` (Hub-side substring filter: nightly
   * builds would otherwise fill every page). Newest first.
   */
  listTags(repo: string, nameFilter = '', opts: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<HubTag[]> {
    const key = `${repo}|${nameFilter}`;
    const hit = this.cache.get(key);
    if (!opts.refresh && hit && this.o.clock.now() - hit.at < (this.o.ttlMs ?? 600_000)) return hit.value;
    const value = this.fetchTags(repo, nameFilter, opts.signal);
    this.cache.set(key, { at: this.o.clock.now(), value });
    value.catch(() => this.cache.delete(key));
    return value;
  }

  private async fetchTags(repo: string, nameFilter: string, signal?: AbortSignal): Promise<HubTag[]> {
    const q = new URLSearchParams({ page_size: '100', ordering: 'last_updated' });
    if (nameFilter) q.set('name', nameFilter);
    let url: string | undefined = `${this.base()}/v2/repositories/${repo}/tags?${q.toString()}`;
    const out: HubTag[] = [];
    for (let page = 0; url !== undefined && page < (this.o.maxPages ?? 2); page++) {
      const body = (await this.getJson(url, signal)) as { results?: HubTagJson[]; next?: unknown } | undefined;
      // An unknown repository simply has no tags to offer.
      if (!body) break;
      for (const r of body.results ?? []) {
        const t = toTag(r);
        if (t) out.push(t);
      }
      // Only follow pagination links that stay on the configured host (tests, proxies).
      url = typeof body.next === 'string' && body.next.startsWith(this.base()) ? body.next : undefined;
    }
    return out;
  }

  /** One Hub tag (its digest and download size), undefined for other registries or unknown tags. */
  async tagInfo(ref: string | ImageRef, signal?: AbortSignal): Promise<HubTag | undefined> {
    const r = typeof ref === 'string' ? parseImageRef(ref) : ref;
    if (!isDockerHub(r) || r.digest !== undefined) return undefined;
    const body = (await this.getJson(`${this.base()}/v2/repositories/${r.repository}/tags/${r.tag ?? 'latest'}`, signal)) as HubTagJson | undefined;
    return body ? toTag(body) : undefined;
  }

  /** Download size of one Hub image, undefined for other registries or unknown tags. */
  async imageSize(ref: string | ImageRef, signal?: AbortSignal): Promise<number | undefined> {
    return (await this.tagInfo(ref, signal))?.sizeBytes;
  }
}
