import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AppError } from '../../../contract/errors';
import type { LlamaRelease } from '../../../contract/api';
import type { Platform } from '../../deps';
import { writeFileAtomic } from '../../store/atomic';

export type LlamaAsset = LlamaRelease['assets'][number];
export type Backend = 'cuda' | 'vulkan' | 'cpu';

/** Build tags are `b<number>`; other tags (e.g. `v0.6.0` source releases) carry no binaries. */
export const BUILD_TAG = /^b(\d+)$/;

interface GithubAsset {
  name?: unknown;
  size?: unknown;
  digest?: unknown;
  browser_download_url?: unknown;
}
interface GithubRelease {
  tag_name?: unknown;
  published_at?: unknown;
  draft?: unknown;
  assets?: unknown;
}

/** Maps GitHub's release list to our contract, keeping build tags only (newest first). */
export function parseReleases(json: unknown): LlamaRelease[] {
  if (!Array.isArray(json)) throw new AppError('NETWORK', 'Unexpected GitHub releases payload');
  const out: LlamaRelease[] = [];
  for (const r of json as GithubRelease[]) {
    if (typeof r.tag_name !== 'string' || !BUILD_TAG.test(r.tag_name) || r.draft === true) continue;
    const assets: LlamaAsset[] = [];
    for (const a of Array.isArray(r.assets) ? (r.assets as GithubAsset[]) : []) {
      if (typeof a.name !== 'string' || typeof a.browser_download_url !== 'string') continue;
      const asset: LlamaAsset = { name: a.name, url: a.browser_download_url, size: typeof a.size === 'number' ? a.size : 0 };
      if (typeof a.digest === 'string' && /^sha256:[0-9a-f]{64}$/i.test(a.digest)) asset.digest = a.digest.toLowerCase();
      assets.push(asset);
    }
    out.push({ tag: r.tag_name, publishedAt: typeof r.published_at === 'string' ? r.published_at : '', assets });
  }
  return out.sort((a, b) => buildNumber(b.tag) - buildNumber(a.tag));
}

export function buildNumber(tag: string): number {
  const m = BUILD_TAG.exec(tag);
  return m ? Number(m[1]) : -1;
}

/** Numeric dotted-version comparison ("12.10" > "12.4"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export interface AssetSelection {
  main: LlamaAsset;
  /** CUDA runtime DLLs/.so (no CUDA toolkit needed on the user's PC). */
  cudart?: LlamaAsset;
  backend: Backend;
  cudaVersion?: string;
  /** Folder-safe id: "cuda-13.4", "vulkan", "cpu". */
  variant: string;
}

export interface SelectOptions {
  platform: Platform;
  arch: string;
  /** Highest CUDA version the installed driver supports (nvidia-smi header); undefined = no NVIDIA driver. */
  cudaVersion?: string;
  /** Backends to try, in order. */
  prefer?: Backend[];
  /** Exact variant requested by the user (expert mode), e.g. "cuda-12.4". */
  variant?: string;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Picks the archive(s) for this OS/arch. Real names (see test/fixtures/github):
 *   win:   llama-<tag>-bin-win-cuda-13.4-x64.zip + cudart-llama-bin-win-cuda-13.4-x64.zip,
 *          llama-<tag>-bin-win-vulkan-x64.zip, llama-<tag>-bin-win-cpu-x64.zip
 *   linux: llama-<tag>-bin-ubuntu-cuda-13.4-x64.tar.gz + cudart-llama-<tag>-bin-ubuntu-cuda-13.4-x64.tar.gz,
 *          llama-<tag>-bin-ubuntu-vulkan-x64.tar.gz, llama-<tag>-bin-ubuntu-x64.tar.gz
 * CUDA: the highest version ≤ the driver's, and only when its cudart archive exists too.
 */
export function selectAssets(release: LlamaRelease, opts: SelectOptions): AssetSelection | undefined {
  if (opts.platform === 'darwin') return undefined;
  const os = opts.platform === 'win32' ? 'win' : 'ubuntu';
  const ext = opts.platform === 'win32' ? 'zip' : 'tar\\.gz';
  const tag = esc(release.tag);
  const arch = esc(opts.arch);
  const find = (re: RegExp) => release.assets.find((a) => re.test(a.name));

  const candidates: AssetSelection[] = [];
  const cudaRe = new RegExp(`^llama-${tag}-bin-${os}-cuda-(\\d+(?:\\.\\d+)*)-${arch}\\.${ext}$`);
  for (const main of release.assets) {
    const ver = cudaRe.exec(main.name)?.[1];
    if (ver === undefined) continue;
    const cudart = find(new RegExp(`^cudart-llama-(?:${tag}-)?bin-${os}-cuda-${esc(ver)}-${arch}\\.${ext}$`));
    if (cudart) candidates.push({ main, cudart, backend: 'cuda', cudaVersion: ver, variant: `cuda-${ver}` });
  }
  candidates.sort((a, b) => compareVersions(b.cudaVersion as string, a.cudaVersion as string));
  const vulkan = find(new RegExp(`^llama-${tag}-bin-${os}-vulkan-${arch}\\.${ext}$`));
  if (vulkan) candidates.push({ main: vulkan, backend: 'vulkan', variant: 'vulkan' });
  const cpu = find(
    new RegExp(opts.platform === 'win32' ? `^llama-${tag}-bin-win-cpu-${arch}\\.zip$` : `^llama-${tag}-bin-ubuntu-${arch}\\.tar\\.gz$`),
  );
  if (cpu) candidates.push({ main: cpu, backend: 'cpu', variant: 'cpu' });

  if (opts.variant !== undefined) return candidates.find((c) => c.variant === opts.variant);
  const driverCuda = opts.cudaVersion;
  for (const backend of opts.prefer ?? ['cuda', 'vulkan', 'cpu']) {
    const pick = candidates.find(
      (c) =>
        c.backend === backend &&
        (backend !== 'cuda' || (driverCuda !== undefined && compareVersions(c.cudaVersion as string, driverCuda) <= 0)),
    );
    if (pick) return pick;
  }
  return undefined;
}

export interface ReleasesClientOptions {
  fetch: typeof globalThis.fetch;
  /** e.g. https://api.github.com (tests: the fake-github server). */
  githubApi: string;
  cacheDir: string;
  repo?: string;
  perPage?: number;
  appVersion?: string;
}

interface CacheEntry {
  url: string;
  etag: string;
  body: unknown;
}

/**
 * GitHub releases of ggml-org/llama.cpp. Uses `/releases` (every build is a prerelease, so
 * `/releases/latest` is useless) with an ETag cache: a 304 does not count against the 60 req/h
 * anonymous limit, and a stale cache is better than an error when offline or rate limited.
 */
export class LlamaReleasesClient {
  private readonly cacheFile: string;

  constructor(private readonly opts: ReleasesClientOptions) {
    this.cacheFile = path.join(opts.cacheDir, 'github-llamacpp-releases.json');
  }

  async list(signal?: AbortSignal): Promise<LlamaRelease[]> {
    const repo = this.opts.repo ?? 'ggml-org/llama.cpp';
    const url = `${this.opts.githubApi.replace(/\/+$/, '')}/repos/${repo}/releases?per_page=${this.opts.perPage ?? 30}`;
    const cached = await this.readCache(url);
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': `gpu-bench/${this.opts.appVersion ?? '0'}`,
    };
    if (cached) headers['if-none-match'] = cached.etag;

    let res: Response;
    try {
      res = await this.opts.fetch(url, { headers, ...(signal ? { signal } : {}) });
    } catch (e) {
      if (signal?.aborted) throw new AppError('CANCELLED', 'Release listing cancelled', { cause: e });
      if (cached) return parseReleases(cached.body);
      throw new AppError('NETWORK', `Cannot reach GitHub: ${String(e)}`, { cause: e });
    }
    if (res.status === 304 && cached) return parseReleases(cached.body);
    if (res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')) {
      if (cached) return parseReleases(cached.body);
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      const params: Record<string, string> = {};
      if (Number.isFinite(reset) && reset > 0) params.resetAt = new Date(reset * 1000).toISOString();
      throw new AppError('GITHUB_RATE_LIMITED', 'GitHub API rate limit reached', { params });
    }
    if (!res.ok) {
      if (cached) return parseReleases(cached.body);
      throw new AppError('NETWORK', `GitHub returned HTTP ${res.status}`, { params: { status: res.status } });
    }
    const body: unknown = await res.json();
    const releases = parseReleases(body);
    const etag = res.headers.get('etag');
    if (etag) await this.writeCache({ url, etag, body });
    return releases;
  }

  private async readCache(url: string): Promise<CacheEntry | undefined> {
    try {
      const entry = JSON.parse(await fs.readFile(this.cacheFile, 'utf8')) as Partial<CacheEntry>;
      if (entry.url === url && typeof entry.etag === 'string' && Array.isArray(entry.body)) return entry as CacheEntry;
    } catch {
      /* no cache yet, or unreadable: fetch fresh */
    }
    return undefined;
  }

  private async writeCache(entry: CacheEntry): Promise<void> {
    try {
      await writeFileAtomic(this.cacheFile, JSON.stringify(entry));
    } catch {
      /* the cache is an optimisation only */
    }
  }
}
