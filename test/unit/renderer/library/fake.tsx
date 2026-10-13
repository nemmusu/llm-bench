/**
 * A fake core for the setup & library screens: every route those screens call, answered from
 * plain data a test can change, plus a controllable event stream. Unknown routes fail loudly.
 */
import { createMemoryHistory } from '@tanstack/react-router';
import { render, type RenderResult } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import { vi } from 'vitest';
import type { SystemResponse } from '../../../../src/contract/api';
import type { EngineStatus } from '../../../../src/contract/engines';
import type { AppErrorData } from '../../../../src/contract/errors';
import type { ServerEvent } from '../../../../src/contract/events';
import type { GpuSample } from '../../../../src/contract/hardware';
import type { DownloadJob, FitEstimate, HubFile, HubModel, LocalModel } from '../../../../src/contract/models';
import type { RunSummary } from '../../../../src/contract/results';
import { defaultSettings, type Settings } from '../../../../src/contract/settings';
import type { CheckItem, CuratedResponse, DockerStatusDetail, HubFitResult, InstalledBuild, SystemCheckReport } from '../../../../src/contract/views';
import { App } from '../../../../src/renderer/app';
import { ApiError, type ApiClient } from '../../../../src/renderer/lib/api';
import { createAppRouter } from '../../../../src/renderer/routes/router';
import { newQueryClient } from '../helpers';

MotionGlobalConfig.skipAnimations = true;
// Whole-app renders are slow under coverage with many test files in parallel.
vi.setConfig({ testTimeout: 30_000 });

export const GPU = {
  index: 0,
  uuid: 'GPU-5090',
  name: 'NVIDIA GeForce RTX 5090',
  vendor: 'nvidia' as const,
  memoryTotalMiB: 32607,
  memoryUsedMiB: 1600,
  driverVersion: '617.14',
  cudaVersion: '13.4',
  computeCapability: '12.0',
  powerLimitW: 575,
  pcieGenMax: 5,
  pcieWidthMax: 16,
};

export function system(over: Partial<SystemResponse> = {}): SystemResponse {
  return {
    gpus: [GPU],
    os: { platform: 'win32', release: '10.0.26300', arch: 'x64', name: 'Windows 11 Pro', isWsl: false },
    cpu: { model: 'AMD Ryzen 9 9950X3D', cores: 16, threads: 32 },
    ramBytes: 64 * 1024 ** 3,
    hostLabel: 'PC',
    hostId: 'host-1',
    nvidiaSmi: { found: true },
    otherGpuUsers: [
      { pid: 1234, name: 'llama-server.exe', knownLlm: true, memMiB: 2048, kind: 'llm' },
      { pid: 77, name: 'vmmem', knownLlm: false, kind: 'vm' },
      { pid: 8, name: 'chrome.exe', knownLlm: false },
      { pid: 9, name: 'ollama.exe', knownLlm: true },
    ],
    docker: { state: 'running', version: '29.8.0' },
    paths: { dataDir: 'C:\\Data\\GPU Bench', resultsDir: 'C:\\Data\\GPU Bench\\results', modelsDir: 'C:\\Models', enginesDir: 'C:\\Data\\GPU Bench\\engines' },
    ...over,
  };
}

export function sample(t: number, over: Partial<GpuSample> = {}): GpuSample {
  return {
    t,
    gpu: 0,
    utilPct: 12,
    memUsedMiB: 3072,
    memTotalMiB: 32607,
    powerW: 80,
    tempC: 45,
    smClockMHz: 1800,
    memClockMHz: 14000,
    pcieGen: 4,
    pcieWidth: 16,
    throttle: [],
    ...over,
  };
}

export function item(id: CheckItem['id'], over: Partial<CheckItem> = {}): CheckItem {
  return { id, state: 'ok', required: ['driver', 'gpu', 'llamacpp', 'models'].includes(id), params: {}, ...over };
}

export function report(items: CheckItem[], over: Partial<SystemCheckReport> = {}): SystemCheckReport {
  return { platform: 'win32', items, canBenchmark: true, checkedAt: new Date().toISOString(), ...over };
}

export const okItems = (): CheckItem[] => [
  item('driver', { params: { driverVersion: '617.14', cudaVersion: '13.4' } }),
  item('gpu', { params: { name: 'NVIDIA GeForce RTX 5090', vramGb: 31.8, count: 1 } }),
  item('llamacpp', { params: { version: 'b10997', variant: 'cuda-13.4' } }),
  item('models', { params: { count: 2, dirs: ['C:\\Models'] } }),
  item('disk', { params: { freeGb: 120, path: 'C:\\', minFreeGb: 20 } }),
  item('docker', { params: { dockerState: 'running', version: '29.8.0' } }),
  item('vllm-native', { state: 'unsupported' }),
];

export function localModel(id: string, over: Omit<Partial<LocalModel>, 'identity'> & { identity?: Partial<LocalModel['identity']> } = {}): LocalModel {
  const { identity, ...rest } = over;
  return {
    id,
    identity: {
      displayName: `Model ${id}`,
      format: 'gguf',
      source: 'local',
      file: `${id}-Q4_K_M.gguf`,
      files: [],
      quant: 'Q4_K_M',
      sizeBytes: 4 * 1024 ** 3,
      weakKey: `local/${id}-Q4_K_M.gguf/Q4_K_M/4294967296`,
      facts: { paramsB: 8.2 },
      ...identity,
    },
    paths: [`C:\\Models\\${id}-Q4_K_M.gguf`],
    auxiliary: [],
    dir: 'C:\\Models',
    origin: 'library',
    modifiedAt: '2026-10-01T10:00:00.000Z',
    ...rest,
  };
}

export const REFERENCE = {
  id: 'ref-qwen3-4b-q4km',
  label: 'Qwen3 4B · Q4_K_M',
  engine: 'llamacpp' as const,
  repo: 'Qwen/Qwen3-4B-GGUF',
  file: 'Qwen3-4B-Q4_K_M.gguf',
  revision: 'bc640142c66e1fdd12af0bd68f40445458f3869b',
  sizeBytes: 2497280256,
  sha256: 'a'.repeat(64),
  quant: 'Q4_K_M',
  paramsB: 4.022,
  license: 'apache-2.0',
};

export function curated(models = 8): CuratedResponse {
  return {
    vramGB: 32,
    reference: REFERENCE,
    models: [
      { ...REFERENCE, id: 'qwen3-4b-q4km', tier: 8, reference: true, fit: { level: 'perfect', needMiB: 3_400, availableMiB: 30_000, quant: 'Q4_K_M', engine: 'llamacpp' } },
      { id: 'vllm-qwen3-0.6b', label: 'Qwen3 0.6B', engine: 'vllm', tier: 8, repo: 'Qwen/Qwen3-0.6B', revision: 'c'.repeat(40), sizeBytes: 1.4e9, quant: 'BF16', paramsB: 0.6, license: 'apache-2.0' },
      ...Array.from({ length: Math.max(0, models - 2) }, (_, i) => ({
        id: `extra-${i}`,
        label: `Extra ${i} · Q4_K_M`,
        engine: 'llamacpp' as const,
        tier: 16,
        repo: `org/Extra-${i}-GGUF`,
        file: `Extra-${i}-Q4_K_M.gguf`,
        revision: 'b'.repeat(40),
        sizeBytes: 5e9 + i,
        quant: 'Q4_K_M',
        paramsB: 8,
        license: 'mit',
      })),
    ],
  };
}

export function fit(level: FitEstimate['level'] = 'perfect'): FitEstimate {
  return { level, needMiB: 6000, weightsMiB: 4000, kvMiB: 1500, overheadMiB: 500, availableMiB: 30000, utilization: 0.2, contextSize: 8192, basis: 'file-size', notes: [] };
}

export function hubModel(repo: string, over: Partial<HubModel> = {}): HubModel {
  const [author, name] = repo.split('/') as [string, string];
  return { repo, author, name, downloads: 1200, likes: 30, gated: false, formats: ['gguf'], otherFormats: [], tags: [], paramsB: 8, updatedAt: '2026-09-01T00:00:00.000Z', ...over };
}

export const HUB_FILES: HubFile[] = [
  { path: 'Model-Q8_0.gguf', sizeBytes: 8e9, quant: 'Q8_0', kind: 'weights', sha256: 'f'.repeat(64) },
  { path: 'Q4/Model-Q4_K_M-00001-of-00002.gguf', sizeBytes: 3e9, quant: 'Q4_K_M', groupKey: 'Q4_K_M', kind: 'weights' },
  { path: 'Q4/Model-Q4_K_M-00002-of-00002.gguf', sizeBytes: 2e9, quant: 'Q4_K_M', groupKey: 'Q4_K_M', kind: 'weights' },
  { path: 'mmproj-F16.gguf', sizeBytes: 9e8, kind: 'mmproj' },
  { path: 'README.md', sizeBytes: 2000, kind: 'other' },
];

export function hubFit(): HubFitResult {
  return {
    choices: [
      { groupKey: 'Model-Q8_0.gguf', quant: 'Q8_0', files: [HUB_FILES[0] as HubFile], sizeBytes: 8e9, fit: fit('good'), weakKey: 'org/Model-GGUF/Model-Q8_0.gguf/Q8_0/8000000000' },
      { groupKey: 'Q4_K_M', quant: 'Q4_K_M', files: [HUB_FILES[2] as HubFile, HUB_FILES[1] as HubFile], sizeBytes: 5e9, fit: fit('perfect'), weakKey: 'org/Model-GGUF/Model-Q4_K_M-00001-of-00002.gguf/Q4_K_M/5000000000' },
    ],
    best: 'Q4_K_M',
    facts: { paramsB: 31, architecture: 'gemma4', contextLength: 131072 },
  };
}

export function job(id: string, over: Partial<DownloadJob> = {}): DownloadJob {
  return {
    id,
    label: `Download ${id}`,
    repo: 'org/Model-GGUF',
    files: [{ path: 'Model-Q8_0.gguf', sizeBytes: 8e9 }],
    dest: 'C:\\Models\\org\\Model-GGUF',
    state: 'running',
    bytesDone: 2e9,
    bytesTotal: 8e9,
    bytesPerSec: 50e6,
    etaSec: 120,
    createdAt: '2026-10-06T10:00:00.000Z',
    ...over,
  };
}

export function run(id: string, over: Partial<RunSummary> = {}): RunSummary {
  return {
    id,
    createdAt: '2026-09-12T10:00:00.000Z',
    status: 'completed',
    profile: 'quick',
    modelName: 'Model',
    modelWeakKey: 'org/Model-GGUF/Model-Q8_0.gguf/Q8_0/8000000000',
    engineKind: 'llamacpp-native',
    engineLabel: 'llama.cpp',
    gpuName: GPU.name,
    gpuUuid: GPU.uuid,
    hostId: 'h',
    hostLabel: 'PC',
    decodeTps: 142,
    validity: [],
    file: `${id}.json`,
    ...over,
  };
}

export const ENGINES = (): EngineStatus[] => [
  { kind: 'llamacpp-native', available: true, installed: true, version: 'b10997', variant: 'cuda-13.4', location: 'C:\\e\\llama-server.exe', problems: [], supported: true },
  { kind: 'llamacpp-docker', available: true, installed: true, problems: [], supported: true },
  { kind: 'vllm-docker', available: true, installed: true, problems: [], supported: true },
  { kind: 'vllm-native', available: false, installed: false, problems: [], supported: false },
  { kind: 'external', available: true, installed: true, problems: [], supported: true },
];

export const BUILDS = (): InstalledBuild[] => [
  {
    schema: 1,
    id: 'b11438-cuda-13.4',
    tag: 'b11438',
    variant: 'cuda-13.4',
    backend: 'cuda',
    cudaVersion: '13.4',
    server: 'llama-server.exe',
    files: [],
    installedAt: '2026-10-05T10:00:00.000Z',
    sources: [],
    dir: 'C:\\e\\b11438',
    serverPath: 'C:\\e\\b11438\\llama-server.exe',
  },
  {
    schema: 1,
    id: 'b10997-vulkan',
    tag: 'b10997',
    variant: 'vulkan',
    backend: 'vulkan',
    server: 'llama-server.exe',
    files: [],
    installedAt: '2026-09-05T10:00:00.000Z',
    sources: [],
    dir: 'C:\\e\\b10997',
    serverPath: 'C:\\e\\b10997\\llama-server.exe',
  },
];

export interface World {
  settings: Settings;
  system: SystemResponse;
  snapshot: GpuSample[];
  check: SystemCheckReport;
  local: LocalModel[];
  curated: CuratedResponse;
  runs: RunSummary[];
  tried: RunSummary[];
  search: HubModel[];
  files: HubFile[];
  readme: { text: string; truncated: boolean };
  related: HubModel[];
  hubFit: HubFitResult;
  downloads: DownloadJob[];
  engines: EngineStatus[];
  builds: InstalledBuild[];
  docker: DockerStatusDetail;
  volumes: string[];
  cold: { method: 'linux-fadvise' | 'windows-standby' | 'none'; automatic: boolean; windowsTaskInstalled?: boolean };
}

export function world(over: Partial<World> = {}): World {
  return {
    settings: { ...defaultSettings(), onboardingDone: true },
    system: system(),
    snapshot: [sample(1000)],
    check: report(okItems()),
    local: [localModel('m1'), localModel('m2', { origin: 'lmstudio', auxiliary: [{ kind: 'mmproj', path: 'C:\\x\\mmproj.gguf' }] })],
    curated: curated(),
    runs: [],
    tried: [],
    search: [hubModel('org/Model-GGUF')],
    files: HUB_FILES,
    readme: { text: '# Model\n\nHello **world**.', truncated: false },
    related: [],
    hubFit: hubFit(),
    downloads: [],
    engines: ENGINES(),
    builds: BUILDS(),
    docker: { state: 'running', version: '29.8.0' },
    volumes: [],
    cold: { method: 'windows-standby', automatic: false, windowsTaskInstalled: false },
    ...over,
  };
}

type Handler = (body: unknown, query: URLSearchParams, path: string) => unknown;

export interface LibApi extends ApiClient {
  w: World;
  calls: { method: string; path: string; body?: unknown }[];
  /** Overrides by "METHOD /path" (path without query; `*` matches one segment). */
  on(route: string, h: Handler): void;
  emit(e: ServerEvent): void;
  setConnected(ok: boolean): void;
}

export const fail = (code: AppErrorData['code'], status = 400, message: string = code): never => {
  throw new ApiError({ code, message }, status);
};

export function libApi(w: World = world()): LibApi {
  let onEvent: ((e: ServerEvent) => void) | undefined;
  let onStatus: ((ok: boolean) => void) | undefined;
  const overrides = new Map<string, Handler>();
  const routes: Record<string, Handler> = {
    'GET /api/health': () => ({ ok: true, version: '0.1.0', pid: 1 }),
    'GET /api/settings': () => ({ ...w.settings }),
    'PUT /api/settings': (b) => {
      w.settings = { ...w.settings, ...(b as Partial<Settings>) };
      return { ...w.settings };
    },
    'GET /api/system': () => w.system,
    'GET /api/telemetry/snapshot': () => w.snapshot,
    'GET /api/setup/check': () => w.check,
    'GET /api/setup/docker/plan': () => ({ platform: 'win32', kind: 'docker-desktop', supported: true, url: 'https://desktop.docker.com/x.exe', sizeBytes: 6e8, wsl: { available: true } }),
    'GET /api/setup/docker/linux-script': () => ({ script: '#!/bin/sh\napt-get install docker-ce', steps: ['prepare', 'docker-install'] }),
    'POST /api/setup/docker/install': () => ({ started: true }),
    'POST /api/setup/uv/install': () => ({ started: true }),
    'GET /api/models/local': () => w.local,
    'POST /api/models/rescan': () => w.local,
    'DELETE /api/models/local/*': (_b, _q, p) => {
      w.local = w.local.filter((m) => m.id !== decodeURIComponent(p.split('/').pop() as string));
      return { ok: true };
    },
    'GET /api/models/curated': () => w.curated,
    // What the card holds now, from the telemetry sample (no engine of ours running).
    'GET /api/models/vram': () => {
      const s = w.snapshot[0];
      return s?.memTotalMiB ? { totalMiB: s.memTotalMiB, freeMiB: s.memTotalMiB - (s.memUsedMiB ?? 0), busyMiB: s.memUsedMiB ?? 0, reserveMiB: 1024 } : null;
    },
    'POST /api/models/fit': () => fit(),
    'GET /api/runs/tried': () => w.tried,
    'GET /api/runs': () => w.runs,
    'POST /api/runs/export': () => ({ format: 'gpubench', version: 1, runs: [] }),
    'POST /api/runs/import': () => ({ imported: 2, skipped: 1 }),
    'GET /api/models/search': (_b, q) => {
      const all = w.search.filter((m) => m.repo.toLowerCase().includes((q.get('q') ?? '').toLowerCase()) && (!q.get('author') || m.author === q.get('author')));
      const limit = Number(q.get('limit') ?? 30);
      const at = Number(q.get('cursor') ?? 0);
      const models = all.slice(at, at + limit);
      return at + limit < all.length ? { models, nextCursor: String(at + limit) } : { models };
    },
    // Repo info: the hub model of that repo among the known ones (as the core's hub client), else not found.
    'GET /api/models/hub/*/*': (_b, _q, p) => {
      const repo = p.split('/').slice(4).map(decodeURIComponent).join('/');
      const m = w.search.find((x) => x.repo === repo);
      return m ? { ...m, private: false } : fail('HF_NOT_FOUND', 404);
    },
    'GET /api/models/hub/*/*/files': () => w.files,
    'GET /api/models/hub/*/*/readme': () => w.readme,
    'GET /api/models/hub/*/*/related': () => w.related,
    'POST /api/models/hub/*/*/fit': () => w.hubFit,
    'GET /api/downloads': () => w.downloads,
    'POST /api/downloads': (b) => {
      const req = b as { repo: string; files: string[]; label: string };
      const j = job(`dl-${w.downloads.length + 1}`, { repo: req.repo, label: req.label, state: 'queued', bytesDone: 0, files: req.files.map((path) => ({ path })) });
      w.downloads = [...w.downloads, j];
      return j;
    },
    'POST /api/downloads/*/*': (_b, _q, p) => {
      const [, , , id, action] = p.split('/');
      const state = { pause: 'paused', resume: 'queued', cancel: 'cancelled' }[action as 'pause'] as DownloadJob['state'];
      const j = { ...(w.downloads.find((d) => d.id === id) as DownloadJob), state };
      w.downloads = w.downloads.map((d) => (d.id === id ? j : d));
      return j;
    },
    'GET /api/engines': () => w.engines,
    'GET /api/engines/llamacpp/installed': () => w.builds,
    'DELETE /api/engines/llamacpp/installed/*': () => ({ ok: true }),
    'GET /api/engines/llamacpp/releases': () => [
      { tag: 'b11500', publishedAt: '2026-10-06T00:00:00Z', assets: [] },
      { tag: 'b11438', publishedAt: '2026-10-01T00:00:00Z', assets: [] },
    ],
    'POST /api/engines/*/install': () => ({ ok: true }),
    'GET /api/docker/status': () => w.docker,
    'POST /api/docker/start': () => ({ ok: true, state: 'starting' }),
    'POST /api/docker/gpu-check': () => ({ image: 'x', gpus: ['GPU 0: NVIDIA GeForce RTX 5090 (UUID: GPU-5090)'] }),
    'POST /api/docker/cleanup': () => ({ removed: [{ id: 'a', name: 'gpubench-1' }] }),
    'GET /api/engines/vllm/tags': () => [
      { name: 'v0.31.0', recommended: true, cuda: '13.0', sizeBytes: 9e9, lastUpdated: '2026-10-04T00:00:00Z' },
      { name: 'v0.9.0', supportsGpu: false },
      ...Array.from({ length: 6 }, (_, i) => ({ name: `v0.2${i}.0` })),
    ],
    'GET /api/docker/model-volumes': () => ({ localIds: w.volumes }),
    'POST /api/docker/model-volumes': () => ({ ok: true }),
    'DELETE /api/docker/model-volumes/*': (_b, _q, p) => {
      w.volumes = w.volumes.filter((v) => v !== decodeURIComponent(p.split('/').pop() as string));
      return { ok: true };
    },
    // "Avvia server": a llama.cpp server with 32.768 tokens of context, ready at once.
    'POST /api/servers/plan': (b) => ({
      command: { argv: ['llama-server'], powershell: 'llama-server', bash: 'llama-server' },
      needs: [],
      params: { contextSize: 32768, extraArgs: [], env: {}, ...(b as { params?: object }).params },
      contextSize: 32768,
      fit: fit(),
      warnings: [],
    }),
    'POST /api/servers': () => ({
      id: 'gpubench-srv',
      baseUrl: 'http://127.0.0.1:5123',
      openaiUrl: 'http://127.0.0.1:5123/v1',
      modelName: 'Model m1',
      engineLabel: 'llama.cpp b10997',
      startedAt: '2026-10-06T10:00:00.000Z',
      command: { argv: ['llama-server'], powershell: 'llama-server', bash: 'llama-server' },
      contextSize: 32768,
    }),
    'DELETE /api/servers/*': () => ({ ok: true }),
    'GET /api/cache/cold': () => w.cold,
    'POST /api/cache/windows-task': () => ({ ...w.cold, windowsTaskInstalled: true }),
    'DELETE /api/cache/windows-task': () => ({ ...w.cold, windowsTaskInstalled: false }),
  };
  const match = (method: string, path: string): Handler | undefined => {
    const key = `${method} ${path}`;
    for (const table of [overrides, new Map(Object.entries(routes))]) {
      if (table.has(key)) return table.get(key);
      for (const [pattern, h] of table) {
        const [m, p] = pattern.split(' ') as [string, string];
        if (m !== method || !p.includes('*')) continue;
        const re = new RegExp(`^${p.replace(/[.]/g, '\\.').replace(/\*/g, '[^/]+')}$`);
        if (re.test(path)) return h;
      }
    }
    return undefined;
  };
  const call = async <T,>(method: string, full: string, body?: unknown): Promise<T> => {
    const [path, qs] = full.split('?') as [string, string | undefined];
    api.calls.push({ method, path: full, ...(body === undefined ? {} : { body }) });
    const h = match(method, path);
    if (!h) throw new Error(`unexpected ${method} ${full}`);
    return (await h(body, new URLSearchParams(qs ?? ''), path)) as T;
  };
  const api: LibApi = {
    w,
    calls: [],
    on: (route, h) => overrides.set(route, h),
    get: vi.fn((p: string) => call('GET', p)) as ApiClient['get'],
    post: vi.fn((p: string, b?: unknown) => call('POST', p, b ?? {})) as ApiClient['post'],
    put: vi.fn((p: string, b?: unknown) => call('PUT', p, b ?? {})) as ApiClient['put'],
    del: vi.fn((p: string) => call('DELETE', p)) as ApiClient['del'],
    events: (e, s) => {
      onEvent = e;
      onStatus = s;
      s?.(true);
      return () => {
        onEvent = undefined;
      };
    },
    emit: (e) => onEvent?.(e),
    setConnected: (ok) => onStatus?.(ok),
  };
  return api;
}

export interface Bridge {
  platform: string;
  openExternal: ReturnType<typeof vi.fn>;
  revealPath: ReturnType<typeof vi.fn>;
  pickFolder: ReturnType<typeof vi.fn>;
  pickFile: ReturnType<typeof vi.fn>;
  saveHfToken: ReturnType<typeof vi.fn>;
  clearHfToken: ReturnType<typeof vi.fn>;
  saveFile: ReturnType<typeof vi.fn>;
  setTitleBarTheme: ReturnType<typeof vi.fn>;
}

/** Installs a fake window.gpubench (Electron bridge). */
export function bridge(over: Partial<Bridge> = {}): Bridge {
  const b: Bridge = {
    platform: 'win32',
    openExternal: vi.fn(async () => undefined),
    revealPath: vi.fn(async () => undefined),
    pickFolder: vi.fn(async () => 'D:\\Picked'),
    pickFile: vi.fn(async () => 'D:\\llama\\llama-server.exe'),
    saveHfToken: vi.fn(async () => ({ ok: true, secure: true })),
    clearHfToken: vi.fn(async () => undefined),
    saveFile: vi.fn(async () => 'D:\\export.gpubench'),
    setTitleBarTheme: vi.fn(async () => undefined),
    ...over,
  };
  (window as { gpubench?: unknown }).gpubench = b;
  return b;
}

export function renderLib(path: string, api: LibApi = libApi()): RenderResult & { api: LibApi; router: ReturnType<typeof createAppRouter> } {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  const result = render(<App api={api} router={router} queryClient={newQueryClient()} />);
  return Object.assign(result, { api, router });
}

/** Radix Select needs pointer-capture APIs happy-dom lacks. */
export function patchPointer(): void {
  Object.assign(Element.prototype, { hasPointerCapture: () => false, releasePointerCapture: () => undefined, scrollIntoView: () => undefined });
}
