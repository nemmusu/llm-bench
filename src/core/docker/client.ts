import http from 'node:http';
import { AppError, isAppError } from '../../contract/errors';
import type { DockerEndpoint } from './endpoint';
import { displayRepo, parseImageRef, refVersion } from './image-ref';
import { pullError, PullAggregator, type PullMessage, type PullProgress } from './pull-progress';

export interface ApiResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface RequestOptions {
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface DockerVersion {
  version: string;
  apiVersion?: string;
  os?: string;
  arch?: string;
  /** "Docker Desktop 4.47.0 (…)", "Docker Engine - Community"… */
  platform?: string;
  components: string[];
  /** Podman's Docker-compatible API (not supported in v1). */
  podman: boolean;
}

export interface DockerInfo {
  serverVersion?: string;
  osType?: string;
  operatingSystem?: string;
  ncpu?: number;
  memTotal?: number;
  runtimes: string[];
  /** CDI devices the daemon discovered (Docker ≥ 28 with CDI enabled), e.g. "nvidia.com/gpu=all". */
  cdiDevices: string[];
  /**
   * A static hint only: Docker Desktop exposes GPUs without an "nvidia" runtime, so the real
   * answer always comes from running nvidia-smi in a container (DockerEnvironment.gpuCheck).
   */
  gpuHint: 'nvidia-runtime' | 'cdi' | 'docker-desktop' | 'none';
}

export interface ImageInfo {
  id: string;
  repoTags: string[];
  repoDigests: string[];
  size: number;
}

export interface ContainerSummary {
  id: string;
  names: string[];
  image: string;
  labels: Record<string, string>;
  state: string;
  status: string;
}

export interface ContainerInfo {
  id: string;
  name: string;
  labels: Record<string, string>;
  running: boolean;
  status: string;
  exitCode?: number;
  oomKilled: boolean;
  startedAt?: string;
}

export interface VolumeInfo {
  name: string;
  mountpoint?: string;
  labels: Record<string, string>;
}

export const DEFAULT_API_TIMEOUT_MS = 10_000;

const NOT_RUNNING = new Set(['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ENOTFOUND', 'EHOSTUNREACH']);
const PERMISSION = new Set(['EACCES', 'EPERM']);

/** Maps a socket-level failure to the docker state the user can act on. */
export function connectionError(e: unknown, endpoint: string): AppError {
  const code = (e as { code?: unknown }).code;
  const c = typeof code === 'string' ? code : '';
  const detail = e instanceof Error ? e.message : String(e);
  if (PERMISSION.has(c)) {
    return new AppError('DOCKER_PERMISSION', `No permission to use ${endpoint}`, { params: { endpoint }, detail });
  }
  return new AppError('DOCKER_NOT_RUNNING', `Docker is not reachable at ${endpoint}`, {
    params: { endpoint, reason: NOT_RUNNING.has(c) ? c : c || 'error' },
    detail,
  });
}

function errorMessage(res: ApiResponse): string {
  try {
    const m = (JSON.parse(res.body) as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  } catch {
    /* not JSON */
  }
  return res.body.trim() || `HTTP ${res.status}`;
}

const asRecord = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (typeof x === 'string') out[k] = x;
  return out;
};
const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * Minimal Docker Engine API client on node:http. `socketPath` works for both Windows named pipes
 * and unix sockets, so no native module (dockerode, ssh2…) is needed. Paths are unversioned: the
 * daemon answers with its own API version, which every call here is compatible with.
 */
export class DockerApi {
  readonly label: string;

  constructor(
    readonly endpoint: DockerEndpoint,
    private readonly defaultTimeoutMs = DEFAULT_API_TIMEOUT_MS,
  ) {
    this.label = endpoint.kind === 'socket' ? endpoint.path : `${endpoint.host}:${endpoint.port}`;
  }

  private target(): http.RequestOptions {
    const e = this.endpoint;
    return e.kind === 'socket' ? { socketPath: e.path } : { host: e.host, port: e.port };
  }

  /** Buffered request. Socket errors become DOCKER_NOT_RUNNING / DOCKER_PERMISSION; HTTP errors are returned. */
  request(method: string, path: string, o: RequestOptions = {}): Promise<ApiResponse> {
    let body = '';
    return this.raw(method, path, o, (res, done) => {
      res.setEncoding('utf8');
      res.on('data', (d: string) => (body += d));
      res.on('end', () => done({ status: res.statusCode as number, headers: res.headers, body }));
    });
  }

  /**
   * Streams a newline-delimited JSON response (pull progress). `timeoutMs` is an idle timeout:
   * a 10 GB pull may take an hour but never stays silent for long.
   */
  streamJson(method: string, path: string, onMessage: (m: unknown) => void, o: RequestOptions = {}): Promise<ApiResponse> {
    return this.raw(method, path, o, (res, done, fail) => {
      res.setEncoding('utf8');
      if ((res.statusCode as number) >= 300) {
        let body = '';
        res.on('data', (d: string) => (body += d));
        res.on('end', () => done({ status: res.statusCode as number, headers: res.headers, body }));
        return;
      }
      let rest = '';
      const handle = (line: string) => {
        if (!line.trim()) return;
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        onMessage(msg);
      };
      res.on('data', (d: string) => {
        const parts = (rest + d).split('\n');
        rest = parts.pop() as string;
        try {
          for (const p of parts) handle(p);
        } catch (e) {
          fail(e);
        }
      });
      res.on('end', () => {
        try {
          handle(rest);
        } catch (e) {
          fail(e);
          return;
        }
        done({ status: res.statusCode as number, headers: res.headers, body: '' });
      });
    });
  }

  private raw(
    method: string,
    path: string,
    o: RequestOptions,
    onResponse: (res: http.IncomingMessage, done: (r: ApiResponse) => void, fail: (e: unknown) => void) => void,
  ): Promise<ApiResponse> {
    return new Promise((resolve, reject) => {
      if (o.signal?.aborted) {
        reject(new AppError('CANCELLED', 'Docker request cancelled'));
        return;
      }
      const payload = o.body === undefined ? undefined : JSON.stringify(o.body);
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        o.signal?.removeEventListener('abort', onAbort);
        fn();
      };
      const req = http.request({
        ...this.target(),
        method,
        path,
        headers: {
          host: 'docker',
          ...(payload !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        },
      });
      const onAbort = () => {
        finish(() => reject(new AppError('CANCELLED', 'Docker request cancelled')));
        req.destroy();
      };
      o.signal?.addEventListener('abort', onAbort, { once: true });
      req.setTimeout(o.timeoutMs ?? this.defaultTimeoutMs, () => {
        finish(() =>
          reject(new AppError('DOCKER_NOT_RUNNING', `Docker did not answer in time (${this.label})`, {
            params: { endpoint: this.label, reason: 'timeout' },
          })),
        );
        req.destroy();
      });
      req.on('error', (e) => finish(() => reject(connectionError(e, this.label))));
      req.on('response', (res) => {
        res.on('error', (e) => finish(() => reject(connectionError(e, this.label))));
        onResponse(
          res,
          (r) => finish(() => resolve(r)),
          (e) => {
            finish(() => reject(e));
            req.destroy();
          },
        );
      });
      req.end(payload);
    });
  }

  private async json<T>(method: string, path: string, o: RequestOptions = {}): Promise<{ status: number; data: T | undefined; res: ApiResponse }> {
    const res = await this.request(method, path, o);
    let data: T | undefined;
    try {
      data = JSON.parse(res.body) as T;
    } catch {
      data = undefined;
    }
    return { status: res.status, data, res };
  }

  private fail(what: string, res: ApiResponse): AppError {
    return new AppError('INTERNAL', `Docker ${what} failed: ${errorMessage(res)}`, {
      params: { status: res.status },
      detail: res.body.slice(0, 2000),
    });
  }

  /**
   * GET /_ping. Any HTTP answer means the endpoint exists; Docker Desktop answers 500 while its
   * backend is still starting, which `ok:false` reports.
   */
  async ping(o: RequestOptions = {}): Promise<{ ok: boolean; status: number; apiVersion?: string; osType?: string }> {
    const res = await this.request('GET', '/_ping', o);
    const out: { ok: boolean; status: number; apiVersion?: string; osType?: string } = {
      ok: res.status === 200,
      status: res.status,
    };
    const api = res.headers['api-version'];
    const os = res.headers.ostype;
    if (typeof api === 'string') out.apiVersion = api;
    if (typeof os === 'string') out.osType = os;
    return out;
  }

  async version(): Promise<DockerVersion> {
    const { status, data, res } = await this.json<Record<string, unknown>>('GET', '/version');
    if (status !== 200 || !data) throw this.fail('version', res);
    const components = Array.isArray(data.Components)
      ? data.Components.map((c: unknown) => str((c as { Name?: unknown } | null)?.Name)).filter((n): n is string => n !== undefined)
      : [];
    const platform = str((data.Platform as { Name?: unknown } | undefined)?.Name);
    const out: DockerVersion = {
      version: str(data.Version) ?? '',
      components,
      podman: components.some((c) => /podman/i.test(c)) || /podman/i.test(String(platform)),
    };
    const api = str(data.ApiVersion);
    const os = str(data.Os);
    const arch = str(data.Arch);
    if (api !== undefined) out.apiVersion = api;
    if (os !== undefined) out.os = os;
    if (arch !== undefined) out.arch = arch;
    if (platform !== undefined) out.platform = platform;
    return out;
  }

  async info(): Promise<DockerInfo> {
    const { status, data, res } = await this.json<Record<string, unknown>>('GET', '/info');
    if (status !== 200 || !data) throw this.fail('info', res);
    const runtimes = data.Runtimes && typeof data.Runtimes === 'object' ? Object.keys(data.Runtimes) : [];
    const cdiDevices = Array.isArray(data.DiscoveredDevices)
      ? data.DiscoveredDevices.map((d: unknown) => str((d as { ID?: unknown } | null)?.ID)).filter((x): x is string => x !== undefined)
      : [];
    const operatingSystem = str(data.OperatingSystem);
    const gpuHint: DockerInfo['gpuHint'] = runtimes.includes('nvidia')
      ? 'nvidia-runtime'
      : cdiDevices.some((d) => d.startsWith('nvidia.com/gpu'))
        ? 'cdi'
        : /Docker Desktop/i.test(operatingSystem ?? '')
          ? 'docker-desktop'
          : 'none';
    const out: DockerInfo = { runtimes, cdiDevices, gpuHint };
    const sv = str(data.ServerVersion);
    const osType = str(data.OSType);
    const ncpu = num(data.NCPU);
    const mem = num(data.MemTotal);
    if (sv !== undefined) out.serverVersion = sv;
    if (osType !== undefined) out.osType = osType;
    if (operatingSystem !== undefined) out.operatingSystem = operatingSystem;
    if (ncpu !== undefined) out.ncpu = ncpu;
    if (mem !== undefined) out.memTotal = mem;
    return out;
  }

  /** undefined when the image is not present locally. */
  async imageInspect(ref: string): Promise<ImageInfo | undefined> {
    const { status, data, res } = await this.json<Record<string, unknown>>('GET', `/images/${encodeURIComponent(ref)}/json`);
    if (status === 404) return undefined;
    if (status !== 200 || !data) throw this.fail('image inspect', res);
    return {
      id: str(data.Id) ?? '',
      repoTags: asStrings(data.RepoTags),
      repoDigests: asStrings(data.RepoDigests),
      size: num(data.Size) ?? 0,
    };
  }

  /** Every image on this Docker (GET /images/json): the caller picks its repository's, by tag or digest. */
  async listImages(): Promise<ImageInfo[]> {
    const { status, data, res } = await this.json<unknown[]>('GET', '/images/json');
    if (status !== 200 || !Array.isArray(data)) throw this.fail('image list', res);
    return data.map((x) => {
      const d = (x ?? {}) as Record<string, unknown>;
      return { id: str(d.Id) ?? '', repoTags: asStrings(d.RepoTags), repoDigests: asStrings(d.RepoDigests), size: num(d.Size) ?? 0 };
    });
  }

  /**
   * DELETE /images/:ref (never forced): a tag of an image with others only loses that name. Gone
   * already is fine; one a container still uses is DOCKER_IMAGE_IN_USE (reason 'container').
   */
  async removeImage(ref: string): Promise<void> {
    const res = await this.request('DELETE', `/images/${encodeURIComponent(ref)}?force=false`);
    if (res.status === 404) return;
    if (res.status === 409) throw new AppError('DOCKER_IMAGE_IN_USE', `A container uses ${ref}`, { params: { image: ref, reason: 'container' }, detail: errorMessage(res) });
    if (res.status >= 300) throw this.fail('image remove', res);
  }

  /**
   * POST /images/create with streamed progress. Errors inside the stream (auth, manifest unknown,
   * disk full) and HTTP errors both become DOCKER_PULL_FAILED (or DISK_FULL) with a reason param.
   */
  async pull(ref: string, onProgress: (p: PullProgress) => void, signal?: AbortSignal, expectedBytes?: number): Promise<{ digest?: string }> {
    const r = parseImageRef(ref);
    const repo = displayRepo(r);
    const q = new URLSearchParams({ fromImage: repo, tag: refVersion(r) });
    const agg = new PullAggregator(expectedBytes);
    const res = await this.streamJson(
      'POST',
      `/images/create?${q.toString()}`,
      (m) => onProgress(agg.push(m as PullMessage)),
      { timeoutMs: 5 * 60_000, ...(signal ? { signal } : {}) },
    ).catch((e: unknown) => {
      if (isAppError(e) && e.code === 'DOCKER_PULL_FAILED' && e.params) e.params.image = ref;
      throw e;
    });
    if (res.status !== 200) throw pullError(errorMessage(res), ref);
    onProgress({ ...agg.snapshot(), status: 'done' });
    return agg.digest !== undefined ? { digest: agg.digest } : {};
  }

  async listContainers(filter: { label?: string[] } = {}): Promise<ContainerSummary[]> {
    const filters = filter.label ? `&filters=${encodeURIComponent(JSON.stringify({ label: filter.label }))}` : '';
    const { status, data, res } = await this.json<unknown[]>('GET', `/containers/json?all=1${filters}`);
    if (status !== 200 || !Array.isArray(data)) throw this.fail('container list', res);
    return data.map((c) => {
      const x = c as Record<string, unknown>;
      return {
        id: str(x.Id) ?? '',
        names: asStrings(x.Names).map((n) => n.replace(/^\//, '')),
        image: str(x.Image) ?? '',
        labels: asRecord(x.Labels),
        state: str(x.State) ?? '',
        status: str(x.Status) ?? '',
      };
    });
  }

  async containerInspect(id: string): Promise<ContainerInfo | undefined> {
    const { status, data, res } = await this.json<Record<string, unknown>>('GET', `/containers/${encodeURIComponent(id)}/json`);
    if (status === 404) return undefined;
    if (status !== 200 || !data) throw this.fail('container inspect', res);
    return containerInfoFrom(data);
  }

  /** true when removed, false when it did not exist. */
  async removeContainer(id: string, force = false): Promise<boolean> {
    const res = await this.request('DELETE', `/containers/${encodeURIComponent(id)}?force=${force ? 'true' : 'false'}`);
    if (res.status === 404) return false;
    if (res.status >= 300) throw this.fail('container remove', res);
    return true;
  }

  async volumeInspect(name: string): Promise<VolumeInfo | undefined> {
    const { status, data, res } = await this.json<Record<string, unknown>>('GET', `/volumes/${encodeURIComponent(name)}`);
    if (status === 404) return undefined;
    if (status !== 200 || !data) throw this.fail('volume inspect', res);
    return volumeFrom(data);
  }

  /** Creates the volume when missing (idempotent, like the daemon itself). */
  async ensureVolume(name: string, labels: Record<string, string> = {}): Promise<VolumeInfo> {
    const existing = await this.volumeInspect(name);
    if (existing) return existing;
    const { status, data, res } = await this.json<Record<string, unknown>>('POST', '/volumes/create', { body: { Name: name, Labels: labels } });
    if (status >= 300 || !data) throw this.fail('volume create', res);
    return volumeFrom(data);
  }
}

function volumeFrom(data: Record<string, unknown>): VolumeInfo {
  const out: VolumeInfo = { name: str(data.Name) ?? '', labels: asRecord(data.Labels) };
  const mp = str(data.Mountpoint);
  if (mp !== undefined) out.mountpoint = mp;
  return out;
}

/** Shared by the API (GET /containers/:id/json) and the CLI (`docker container inspect`): same JSON. */
export function containerInfoFrom(data: Record<string, unknown>): ContainerInfo {
  const st = (data.State ?? {}) as Record<string, unknown>;
  const cfg = (data.Config ?? {}) as Record<string, unknown>;
  const out: ContainerInfo = {
    id: str(data.Id) ?? '',
    name: (str(data.Name) ?? '').replace(/^\//, ''),
    labels: asRecord(cfg.Labels),
    running: st.Running === true,
    status: str(st.Status) ?? '',
    oomKilled: st.OOMKilled === true,
  };
  const code = num(st.ExitCode);
  const started = str(st.StartedAt);
  if (code !== undefined) out.exitCode = code;
  if (started !== undefined) out.startedAt = started;
  return out;
}
