/**
 * Data hooks of the setup & library screens (Benvenuto, Modelli, Motori, Monitor GPU,
 * Impostazioni) and of the shell status area. Every hook talks to the core through the shared
 * ApiClient; live progress arrives as server events and is folded into the query cache by
 * useLibraryEvents(), mounted once by the shell.
 *
 * Keys live under 'lib' so they never collide with the benchmark screens' hooks (lib/queries.ts).
 */
import { skipToken, useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { DownloadRequest, FitRequest, HealthResponse, LlamaRelease, SystemResponse } from '../../contract/api';
import type { EngineKind, EngineStatus } from '../../contract/engines';
import type { AppErrorData } from '../../contract/errors';
import type { ServerEvent } from '../../contract/events';
import type { GpuInfo, GpuSample } from '../../contract/hardware';
import type { DownloadJob, FitEstimate, HubFile, HubModel, HubSearchPage, LocalModel } from '../../contract/models';
import type { RunSummary } from '../../contract/results';
import type { Settings } from '../../contract/settings';
import type {
  ColdCacheStatus,
  CuratedResponse,
  DockerInstallPlan,
  DockerStatusDetail,
  GpuCheckResult,
  HubFitResult,
  HubTag,
  InstalledBuild,
  SetupJob,
  SystemCheckReport,
} from '../../contract/views';
import { translate, type Lang } from '../i18n';
import { ApiError, type ApiClient } from './api';
import { useApi, useServerEvents } from './api-context';
import { SETTINGS_QUERY_KEY } from './settings';

export type InstallEvent = Extract<ServerEvent, { type: 'engine.install' }>;

/** GET /api/engines/vllm/tags: Docker Hub tags plus what the core knows from engine-compat.json. */
export interface VllmTag extends HubTag {
  recommended?: boolean;
  supportsGpu?: boolean;
  cuda?: string;
}

export type CatalogSort = 'trendingScore' | 'downloads' | 'likes' | 'createdAt' | 'lastModified';

/** Filters of the model catalog (Modelli → Scarica). */
export interface CatalogParams {
  q: string;
  format: 'gguf' | 'safetensors' | 'any';
  sort: CatalogSort;
  /** Parameter-count range in billions; undefined ends are open. */
  minParamsB?: number | undefined;
  maxParamsB?: number | undefined;
  /** '' = every author. */
  author: string;
  onlyFits: boolean;
}

/** Results per catalog page (HF allows up to 100; 30 keeps the first paint quick). */
export const CATALOG_PAGE_SIZE = 30;

export const libKeys = {
  system: ['lib', 'system'] as const,
  snapshot: ['lib', 'snapshot'] as const,
  check: ['lib', 'setup', 'check'] as const,
  jobs: ['lib', 'setup', 'jobs'] as const,
  curated: ['lib', 'curated'] as const,
  local: ['lib', 'models', 'local'] as const,
  runs: ['lib', 'runs'] as const,
  tried: ['lib', 'tried'] as const,
  fit: ['lib', 'fit'] as const,
  hub: ['lib', 'hub'] as const,
  downloads: ['lib', 'downloads'] as const,
  engines: ['lib', 'engines'] as const,
  builds: ['lib', 'engines', 'builds'] as const,
  releases: ['lib', 'engines', 'releases'] as const,
  docker: ['lib', 'docker'] as const,
  volumes: ['lib', 'docker', 'volumes'] as const,
  vllmTags: ['lib', 'docker', 'vllm-tags'] as const,
  cold: ['lib', 'cache', 'cold'] as const,
  install: ['lib', 'install'] as const,
  installTick: ['lib', 'install-tick'] as const,
  panel: ['lib', 'ui', 'downloads-panel'] as const,
};

/** The core's error behind any failure (ApiError carries it, events carry it bare; anything else is INTERNAL). */
export function errorData(e: unknown): AppErrorData {
  if (e instanceof ApiError) return e.data;
  const d = e as Partial<AppErrorData> | undefined;
  if (typeof d?.code === 'string' && typeof d.message === 'string') return d as AppErrorData;
  return { code: 'INTERNAL', message: String(d?.message ?? e) };
}

const repoPath = (repo: string) => repo.split('/').map(encodeURIComponent).join('/');

// ---- system & telemetry ------------------------------------------------------------------------

/** GET /api/health: app version for "Informazioni". */
export function useAppHealth() {
  const api = useApi();
  return useQuery({ queryKey: ['lib', 'health'], queryFn: () => api.get<HealthResponse>('/api/health'), staleTime: Infinity });
}

/** GET /api/system. `refetchMs` keeps the list of other GPU users fresh on the monitor. */
export function useSystemInfo(refetchMs?: number) {
  const api = useApi();
  return useQuery({
    queryKey: libKeys.system,
    queryFn: () => api.get<SystemResponse>('/api/system'),
    staleTime: 30_000,
    ...(refetchMs ? { refetchInterval: refetchMs } : {}),
  });
}

/** The GPU benchmarks run on (first NVIDIA card). */
export function useMainGpu(): GpuInfo | undefined {
  return useSystemInfo().data?.gpus.find((g) => g.vendor === 'nvidia');
}

/** GET /api/telemetry/snapshot, polled. */
export function useGpuSnapshot(refetchMs: number) {
  const api = useApi();
  return useQuery({
    queryKey: [...libKeys.snapshot, refetchMs],
    queryFn: () => api.get<GpuSample[]>('/api/telemetry/snapshot'),
    refetchInterval: refetchMs,
    refetchIntervalInBackground: false,
  });
}

// ---- setup -----------------------------------------------------------------------------------

/** GET /api/setup/check: the "Controllo sistema" traffic lights. */
export function useSystemCheck() {
  const api = useApi();
  return useQuery({ queryKey: libKeys.check, queryFn: () => api.get<SystemCheckReport>('/api/setup/check'), staleTime: 60_000 });
}

/** Re-runs the check from scratch (GET ?fresh=1) and refreshes everything that depends on it. */
export function useRecheck() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.get<SystemCheckReport>('/api/setup/check?fresh=1'),
    onSuccess: (report) => {
      qc.setQueryData(libKeys.check, report);
      void qc.invalidateQueries({ queryKey: libKeys.engines });
      void qc.invalidateQueries({ queryKey: libKeys.docker });
      void qc.invalidateQueries({ queryKey: libKeys.system });
    },
  });
}

export function useSetupJobs() {
  const api = useApi();
  return useQuery({ queryKey: libKeys.jobs, queryFn: () => api.get<SetupJob[]>('/api/setup/jobs') });
}

export function useDockerPlan(enabled: boolean) {
  const api = useApi();
  return useQuery({ queryKey: ['lib', 'setup', 'docker-plan'], queryFn: () => api.get<DockerInstallPlan>('/api/setup/docker/plan'), enabled, staleTime: Infinity });
}

export function useLinuxScript(enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: ['lib', 'setup', 'linux-script'],
    queryFn: () => api.get<{ script: string; steps: string[] }>('/api/setup/docker/linux-script'),
    enabled,
    staleTime: Infinity,
  });
}

// ---- models ------------------------------------------------------------------------------------

/**
 * Curated list for this GPU's tier. nvidia-smi reports e.g. 32607 MiB (31.8 GiB) for a "32 GB" card,
 * so the VRAM is rounded to whole GB before the core compares it with the tiers. The total comes
 * from the live snapshot (fast) rather than /api/system (which also lists GPU users and is slower).
 */
export function useCurated() {
  const api = useApi();
  const snap = useGpuSnapshot(2000);
  const total = snap.data?.[0]?.memTotalMiB;
  const vram = total ? Math.round(total / 1024) : undefined;
  return useQuery({
    queryKey: [...libKeys.curated, vram],
    queryFn: () => api.get<CuratedResponse>(`/api/models/curated${vram ? `?vramGB=${vram}` : ''}`),
    enabled: !snap.isPending,
    staleTime: Infinity,
  });
}

export function useLibraryModels() {
  const api = useApi();
  return useQuery({ queryKey: libKeys.local, queryFn: () => api.get<LocalModel[]>('/api/models/local') });
}

export function useRescan() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<LocalModel[]>('/api/models/rescan'),
    onSuccess: (models) => {
      qc.setQueryData(libKeys.local, models);
      void qc.invalidateQueries({ queryKey: libKeys.check });
    },
  });
}

/**
 * Saves folder settings and rescans once the core has them (the scanner reads the folders from
 * settings, so the rescan must not start before the save landed).
 */
export function useSaveFoldersAndRescan() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: Partial<Pick<Settings, 'modelsDir' | 'extraModelDirs' | 'scanKnownLocations'>>) => {
      qc.setQueryData(SETTINGS_QUERY_KEY, await api.put<Settings>('/api/settings', patch));
      return api.post<LocalModel[]>('/api/models/rescan');
    },
    onSuccess: (models) => {
      qc.setQueryData(libKeys.local, models);
      void qc.invalidateQueries({ queryKey: libKeys.check });
    },
  });
}

/** Saves the engine the benchmark will use (custom executable, build, image) and re-detects engines with it. */
export function useSaveEngine() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (lastEngine: NonNullable<Settings['lastEngine']>) => {
      qc.setQueryData(SETTINGS_QUERY_KEY, await api.put<Settings>('/api/settings', { lastEngine }));
    },
    onSuccess: () => {
      for (const k of [libKeys.engines, libKeys.check]) void qc.invalidateQueries({ queryKey: k });
    },
  });
}

export function useDeleteModel() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<{ ok: true }>(`/api/models/local/${encodeURIComponent(id)}`),
    onSuccess: (_r, id) => {
      qc.setQueryData<LocalModel[]>(libKeys.local, (old) => old?.filter((m) => m.id !== id));
      void qc.invalidateQueries({ queryKey: libKeys.check });
    },
  });
}

/** POST /api/models/fit; `req` undefined disables the query. */
export function useFit(req: FitRequest | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: [...libKeys.fit, req],
    queryFn: () => api.post<FitEstimate>('/api/models/fit', req),
    enabled: req !== undefined,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** GET /api/runs/tried for one model. */
export function useTried(weakKey: string, sha256?: string) {
  const api = useApi();
  return useQuery({
    queryKey: [...libKeys.tried, weakKey, sha256],
    queryFn: () => api.get<RunSummary[]>(`/api/runs/tried?${new URLSearchParams({ weakKey, ...(sha256 ? { sha256 } : {}) }).toString()}`),
    staleTime: 60_000,
  });
}

/** GET /api/runs: every saved result (for "solo già provati" and repo-level badges). */
export function useAllRuns() {
  const api = useApi();
  return useQuery({ queryKey: libKeys.runs, queryFn: () => api.get<RunSummary[]>('/api/runs'), staleTime: 60_000 });
}

/** The search query string of one catalog page. */
export function catalogQuery(p: CatalogParams, cursor: string): string {
  const qs = new URLSearchParams({ q: p.q, format: p.format, sort: p.sort, limit: String(CATALOG_PAGE_SIZE), onlyFits: String(p.onlyFits) });
  if (p.author) qs.set('author', p.author);
  if (p.minParamsB !== undefined) qs.set('minParamsB', String(p.minParamsB));
  if (p.maxParamsB !== undefined) qs.set('maxParamsB', String(p.maxParamsB));
  if (cursor) qs.set('cursor', cursor);
  return qs.toString();
}

/** Hugging Face catalog, page after page (each page carries the cursor of the next). */
export function useHubCatalog(p: CatalogParams, enabled: boolean) {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: [...libKeys.hub, 'catalog', p],
    queryFn: ({ pageParam, signal }) => api.get<HubSearchPage>(`/api/models/search?${catalogQuery(p, pageParam)}`, signal),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor,
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** Repo card data (downloads, likes, license…) of one hub repo. */
export function useHubModel(repo: string) {
  const api = useApi();
  return useQuery({
    queryKey: [...libKeys.hub, 'model', repo],
    queryFn: () => api.get<HubModel>(`/api/models/hub/${repoPath(repo)}`),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useHubFiles(repo: string) {
  const api = useApi();
  return useQuery({
    queryKey: [...libKeys.hub, 'files', repo],
    queryFn: () => api.get<HubFile[]>(`/api/models/hub/${repoPath(repo)}/files`),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useReadme(repo: string) {
  const api = useApi();
  return useQuery({
    queryKey: [...libKeys.hub, 'readme', repo],
    queryFn: () => api.get<{ text: string; truncated: boolean }>(`/api/models/hub/${repoPath(repo)}/readme`),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useRelated(repo: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: [...libKeys.hub, 'related', repo],
    queryFn: () => api.get<HubModel[]>(`/api/models/hub/${repoPath(repo as string)}/related`),
    enabled: repo !== undefined,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useHubFit(repo: string, engine: EngineKind | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: [...libKeys.hub, 'fit', repo, engine],
    queryFn: () => api.post<HubFitResult>(`/api/models/hub/${repoPath(repo)}/fit`, { engine }),
    enabled: engine !== undefined,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

// ---- downloads -------------------------------------------------------------------------------

export function useDownloadJobs() {
  const api = useApi();
  return useQuery({ queryKey: libKeys.downloads, queryFn: () => api.get<DownloadJob[]>('/api/downloads') });
}

function upsertJob(qc: QueryClient, job: DownloadJob): void {
  qc.setQueryData<DownloadJob[]>(libKeys.downloads, (old = []) =>
    old.some((j) => j.id === job.id) ? old.map((j) => (j.id === job.id ? job : j)) : [...old, job],
  );
}

export function useStartDownload() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: DownloadRequest) => api.post<DownloadJob>('/api/downloads', req),
    // Events may already have reported newer states of this job (small files finish fast): never go back.
    onSuccess: (job) => qc.setQueryData<DownloadJob[]>(libKeys.downloads, (old = []) => (old.some((j) => j.id === job.id) ? old : [...old, job])),
  });
}

export function useDownloadAction() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'pause' | 'resume' | 'cancel' }) =>
      api.post<DownloadJob>(`/api/downloads/${encodeURIComponent(id)}/${action}`),
    // A resumed download may finish before this answer arrives: a finished job never goes back.
    onSuccess: (job) => {
      if (qc.getQueryData<DownloadJob[]>(libKeys.downloads)?.find((j) => j.id === job.id)?.state !== 'done') upsertJob(qc, job);
    },
  });
}

/** Open state of the downloads drawer, shared by the title bar and the screens that start downloads. */
export function useDownloadsPanel(): [boolean, (open: boolean) => void] {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: libKeys.panel, queryFn: skipToken, initialData: false, staleTime: Infinity });
  return [data === true, (open) => qc.setQueryData(libKeys.panel, open)];
}

// ---- engines & docker ------------------------------------------------------------------------

export function useEngineStatuses() {
  const api = useApi();
  return useQuery({ queryKey: libKeys.engines, queryFn: () => api.get<EngineStatus[]>('/api/engines') });
}

export function useInstalledBuilds() {
  const api = useApi();
  return useQuery({ queryKey: libKeys.builds, queryFn: () => api.get<InstalledBuild[]>('/api/engines/llamacpp/installed') });
}

export function useLlamaReleases(enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: libKeys.releases,
    queryFn: () => api.get<LlamaRelease[]>('/api/engines/llamacpp/releases'),
    enabled,
    staleTime: 10 * 60_000,
    retry: false,
  });
}

export function useDockerStatus() {
  const api = useApi();
  return useQuery({ queryKey: libKeys.docker, queryFn: () => api.get<DockerStatusDetail>('/api/docker/status') });
}

export function useVllmTags(enabled: boolean) {
  const api = useApi();
  return useQuery({ queryKey: libKeys.vllmTags, queryFn: () => api.get<VllmTag[]>('/api/engines/vllm/tags'), enabled, staleTime: 10 * 60_000, retry: false });
}

export function useGpuCheck() {
  const api = useApi();
  // The core checks with the configured llama.cpp image (what a Docker benchmark would use).
  return useMutation({ mutationFn: () => api.post<GpuCheckResult>('/api/docker/gpu-check') });
}

export function useDockerCleanup() {
  const api = useApi();
  return useMutation({ mutationFn: () => api.post<{ removed: { id: string; name: string }[] }>('/api/docker/cleanup') });
}

export function useColdCache() {
  const api = useApi();
  return useQuery({ queryKey: libKeys.cold, queryFn: () => api.get<ColdCacheStatus>('/api/cache/cold') });
}

/**
 * Starts one of the long operations whose progress comes back as 'engine.install' events.
 * The pending marker is written at once so the UI shows progress before the first event.
 */
export function useStartInstall() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ key, path, body }: { key: string; path: string; body?: unknown }) => {
      setInstall(qc, key, { type: 'engine.install', kind: key, stage: 'starting', bytesDone: 0 });
      try {
        return await api.post<unknown>(path, body);
      } catch (e) {
        setInstall(qc, key, { type: 'engine.install', kind: key, stage: 'error', bytesDone: 0, error: errorData(e) });
        throw e;
      }
    },
  });
}

function setInstall(qc: QueryClient, key: string, e: InstallEvent): void {
  qc.setQueryData([...libKeys.install, key], e);
  qc.setQueryData(libKeys.installTick, (n: number | undefined) => (n ?? 0) + 1);
}

/** Latest progress of an install / pull / Docker start, keyed by kind (pulls: "pull:<image>"). */
export function useInstallEvent(key: string): InstallEvent | undefined {
  const { data } = useQuery<InstallEvent | null>({ queryKey: [...libKeys.install, key], queryFn: skipToken, initialData: null, staleTime: Infinity });
  return data ?? undefined;
}

/** Stages after which nothing else happens for that operation. */
const FINAL_STAGES = new Set(['done', 'error', 'running', 'installed', 'reboot-maybe-required', 'relogin-required', 'failed', 'cancelled']);

/** The event if its operation is still running, else undefined. */
export function activeEvent(e: InstallEvent | undefined): InstallEvent | undefined {
  return e && !FINAL_STAGES.has(e.stage) ? e : undefined;
}

/** Every install-like operation still running (for the title bar indicator). */
export function useActiveInstalls(): InstallEvent[] {
  const qc = useQueryClient();
  // Re-render on any install event: the indicator subscribes to the whole 'install' prefix.
  useQuery({ queryKey: libKeys.installTick, queryFn: skipToken, initialData: 0, staleTime: Infinity });
  return qc
    .getQueriesData<InstallEvent | null>({ queryKey: libKeys.install })
    .map(([, e]) => activeEvent(e ?? undefined))
    .filter((e): e is InstallEvent => e !== undefined);
}

export function installKey(e: InstallEvent): string {
  return e.image ? `pull:${e.image}` : e.kind;
}

const ACTIVE_DOWNLOAD = new Set<DownloadJob['state']>(['queued', 'running', 'verifying']);

export function isDownloadActive(j: DownloadJob): boolean {
  return ACTIVE_DOWNLOAD.has(j.state);
}

/**
 * Folds server events into the cache and runs the follow-ups (rescans, rechecks, toasts).
 * Mounted once, by the app shell.
 */
export function useLibraryEvents(lang: Lang, onBenchmark: (job: DownloadJob) => void): void {
  const qc = useQueryClient();
  const api = useApi();
  useServerEvents((e) => handleLibraryEvent(e, { qc, api, lang, onBenchmark }));
}

export function handleLibraryEvent(
  e: ServerEvent,
  ctx: { qc: QueryClient; api: ApiClient; lang: Lang; onBenchmark: (job: DownloadJob) => void },
): void {
  const { qc, api, lang } = ctx;
  if (e.type === 'download.update') {
    const before = qc.getQueryData<DownloadJob[]>(libKeys.downloads)?.find((j) => j.id === e.job.id);
    upsertJob(qc, e.job);
    if (e.job.state === 'done' && before?.state !== 'done') {
      void api.post<LocalModel[]>('/api/models/rescan').then((models) => qc.setQueryData(libKeys.local, models), () => undefined);
      void qc.invalidateQueries({ queryKey: libKeys.check });
      toast.success(translate(lang, 'downloads.doneToast', { name: e.job.label }), {
        action: { label: translate(lang, 'models.benchmark'), onClick: () => ctx.onBenchmark(e.job) },
      });
    }
    return;
  }
  if (e.type === 'runs.changed') {
    void qc.invalidateQueries({ queryKey: libKeys.runs });
    void qc.invalidateQueries({ queryKey: libKeys.tried });
    return;
  }
  if (e.type !== 'engine.install') return;
  setInstall(qc, installKey(e), e);
  if (activeEvent(e)) return;
  // Something finished: everything derived from the machine state may have changed.
  for (const k of [libKeys.engines, libKeys.builds, libKeys.docker, libKeys.check, libKeys.jobs, libKeys.system]) void qc.invalidateQueries({ queryKey: k });
}
