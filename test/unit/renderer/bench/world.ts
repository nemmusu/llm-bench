/**
 * A fake core for the benchmark-flow screens: every route they call, backed by plain data the
 * tests can change, plus per-route overrides (errors, delays) and a controllable event stream.
 */
import { configure } from '@testing-library/react';
import { vi } from 'vitest';
import type { ActiveRun, RunPlan, ServerInfo, ServerPlan, StartServerRequest, SystemResponse } from '../../../../src/contract/api';
import type { CustomEngineInfo } from '../../../../src/contract/custom-engines';
import type { ServerApiKeyInfo, ServerNotice, ServerPreset } from '../../../../src/contract/servers';
import type { EngineStatus } from '../../../../src/contract/engines';
import type { AppErrorData } from '../../../../src/contract/errors';
import type { FitEstimate, LocalModel } from '../../../../src/contract/models';
import type { RunResult } from '../../../../src/contract/results';
import { configsQuerySchema } from '../../../../src/contract/configs';
import { mergeSources, queryConfigs, sourcesOf } from '../../../../src/core/store/configs-index';
import { parseRun } from '../../../../src/core/store/runs-repo';
import type { CuratedModel } from '../../../../src/contract/views';
import { ApiError, type ApiClient } from '../../../../src/renderer/lib/api';
import { fakeApi, type FakeApi } from '../helpers';
import { HOST, HOST_ID, seededRuns, summaries } from './fixtures';

// Whole-app renders are slow under coverage with many test files in parallel.
configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

export const ENGINES_DIR ='C:\\Users\\utente\\AppData\\Roaming\\GPU Bench\\engines';

export function apiError(code: AppErrorData['code'], params?: AppErrorData['params'], status = 400): ApiError {
  return new ApiError({ code, message: `${code} message`, ...(params ? { params } : {}) }, status);
}

export function localModel(id: string, over: Partial<LocalModel['identity']> = {}): LocalModel {
  return {
    id,
    identity: {
      displayName: `${id}-Q4_K_M`,
      format: 'gguf',
      source: 'local',
      file: `${id}.gguf`,
      files: [`${id}.gguf`],
      quant: 'Q4_K_M',
      sizeBytes: 5 * 1024 ** 3,
      weakKey: `local/${id}.gguf/Q4_K_M/5`,
      facts: { name: `${id} model`, paramsB: 8, blockCount: 36 },
      ...over,
    },
    paths: [`C:\\models\\${id}.gguf`],
    auxiliary: [],
    dir: 'C:\\models',
    origin: 'library',
    modifiedAt: '2026-10-01T00:00:00.000Z',
  };
}

export function curatedModel(id: string, over: Partial<CuratedModel> = {}): CuratedModel {
  return {
    id,
    label: `${id} · Q4_K_M`,
    engine: 'llamacpp',
    tier: 8,
    repo: `org/${id}-GGUF`,
    file: `${id}.gguf`,
    revision: 'b'.repeat(40),
    sizeBytes: 2_500_000_000,
    quant: 'Q4_K_M',
    paramsB: 4,
    license: 'apache-2.0',
    ...over,
  } as CuratedModel;
}

export const FIT: FitEstimate = {
  level: 'perfect',
  needMiB: 6000,
  weightsMiB: 4800,
  kvMiB: 800,
  overheadMiB: 400,
  availableMiB: 30000,
  utilization: 0.2,
  contextSize: 8192,
  basis: 'file-size',
  notes: [],
};

export function planFor(over: Partial<RunPlan> = {}): RunPlan {
  return {
    scenario: { profile: 'quick', seed: 42, steps: [{ kind: 'load', cache: 'warm', reps: 1 }, { kind: 'latency', promptTokens: [512], outputTokens: 128, warmup: 1, reps: 3 }] },
    command: { argv: ['llama-server', '-m', 'm.gguf'], powershell: 'llama-server -m m.gguf', bash: 'llama-server -m m.gguf' },
    needs: [],
    estimatedSeconds: 95,
    fit: FIT,
    warnings: [],
    ...over,
  };
}

/** POST /api/servers/plan of a llama.cpp server with 32.768 tokens of context. */
export function serverPlanFor(over: Partial<ServerPlan> = {}): ServerPlan {
  return {
    command: { argv: ['llama-server', '-m', 'm.gguf', '-c', '32768'], powershell: 'llama-server -m m.gguf -c 32768', bash: 'llama-server -m m.gguf -c 32768' },
    needs: [],
    params: { contextSize: 32768, extraArgs: [], env: {} },
    contextSize: 32768,
    fit: FIT,
    warnings: [],
    port: 8080,
    network: 'local',
    ...over,
  };
}

/** A server GPU Bench started (GET/POST /api/servers). */
export function serverInfo(id: string, over: Partial<ServerInfo> = {}): ServerInfo {
  const port = over.port ?? 5123;
  return {
    id,
    baseUrl: `http://127.0.0.1:${port}`,
    openaiUrl: `http://127.0.0.1:${port}/v1`,
    modelName: 'Qwen3 8B',
    modelLabel: 'Qwen3 8B',
    engineLabel: 'llama.cpp b11438',
    engineKind: 'llamacpp-native',
    startedAt: new Date().toISOString(),
    command: { argv: ['llama-server'], powershell: 'llama-server', bash: 'llama-server' },
    contextSize: 32768,
    params: { contextSize: 32768, extraArgs: [], env: {} },
    port,
    network: 'local',
    lanUrls: [],
    request: { engine: { kind: 'llamacpp-native' }, model: { localId: 'm1' }, port },
    ...over,
  };
}

export const SYSTEM: SystemResponse = {
  gpus: [
    {
      index: 0,
      uuid: 'GPU-3d36b2ac-a47c-233d-3308-4c71f3bc4a30',
      name: 'NVIDIA GeForce RTX 5090',
      vendor: 'nvidia',
      memoryTotalMiB: 32607,
      memoryUsedMiB: 1600,
      driverVersion: '617.14',
      cudaVersion: '13.4',
      powerLimitW: 575,
    },
  ],
  os: { platform: 'win32', release: '10', arch: 'x64', name: 'Windows 11 Pro', isWsl: false },
  cpu: { model: 'CPU', cores: 8, threads: 16 },
  ramBytes: 64 * 1024 ** 3,
  hostLabel: HOST,
  hostId: HOST_ID,
  nvidiaSmi: { found: true },
  otherGpuUsers: [],
  docker: { state: 'running' },
  paths: { dataDir: 'C:\\data', resultsDir: 'C:\\data\\results', modelsDir: 'C:\\models', enginesDir: ENGINES_DIR },
};

export const ENGINES: EngineStatus[] = [
  { kind: 'llamacpp-native', available: true, installed: true, version: 'b11438', problems: [], supported: true },
  { kind: 'llamacpp-docker', available: false, installed: false, problems: ['DOCKER_NOT_RUNNING'], supported: true, location: 'ghcr.io/ggml-org/llama.cpp:server-cuda' },
  { kind: 'vllm-docker', available: true, installed: true, version: 'v0.12.0', problems: [], supported: true, location: 'vllm/vllm-openai:v0.12.0' },
  { kind: 'vllm-native', available: false, installed: false, problems: [], supported: false },
  { kind: 'external', available: false, installed: true, problems: ['ENDPOINT_INVALID'], supported: true },
];

export type Handler = (body: unknown, path: string) => unknown;

export interface World {
  system: SystemResponse;
  engines: EngineStatus[];
  local: LocalModel[];
  curated: CuratedModel[];
  runs: RunResult[];
  servers: ServerInfo[];
  active: ActiveRun | null;
  /** Download size of llama.cpp in the plan's engine need (null: unknown). */
  installBytes: number | null;
  /** POST /api/runs/plan; by default planFor() with the needs the core would list for this world (see coreNeeds). */
  plan: (body: unknown) => RunPlan;
  /** POST /api/servers/plan; by default serverPlanFor() with the needs of coreNeeds. */
  serverPlan: (body: unknown) => ServerPlan;
  fit: FitEstimate;
  /** The Server page: saved presets, notices, the API key, custom engines. */
  presets: ServerPreset[];
  notices: ServerNotice[];
  apiKey: ServerApiKeyInfo;
  customEngines: CustomEngineInfo[];
  /** Server logs by id (GET /api/servers/:id/log). */
  logs: Record<string, string[]>;
  /** Overrides by "METHOD /path" (exact) or "METHOD /prefix*" (prefix); throw an ApiError to fail. */
  routes: Record<string, Handler>;
}

export interface BenchApi extends FakeApi {
  world: World;
}

export function defaultWorld(): World {
  return {
    system: structuredClone(SYSTEM),
    engines: structuredClone(ENGINES),
    local: [localModel('qwen3-8b', { weakKey: seededRuns().find((r) => r.id === '01K6Y7Q2ZC4M8N3B5V9R1T0XWE')!.model.weakKey }), localModel('st', { format: 'safetensors', repo: 'Qwen/Qwen3-8B-FP8', file: undefined })],
    curated: [curatedModel('gemma-12b'), curatedModel('vllm-4b', { engine: 'vllm', file: undefined, repo: 'Qwen/Qwen3-4B-AWQ' } as Partial<CuratedModel>)],
    runs: seededRuns(),
    servers: [],
    active: null,
    installBytes: 480 * 1024 * 1024,
    plan: () => planFor(),
    serverPlan: () => serverPlanFor(),
    fit: FIT,
    presets: [],
    notices: [],
    apiKey: { key: 'gpub-test-key-0123456789abcdef', storage: 'encrypted' },
    customEngines: [],
    logs: {},
    routes: {},
  };
}

/** A saved server preset ("I tuoi preset"). */
export function serverPreset(id: string, over: Partial<ServerPreset> = {}): ServerPreset {
  return {
    id,
    name: `Preset ${id}`,
    engine: { kind: 'llamacpp-native' },
    model: { localId: 'qwen3-8b' },
    modelLabel: 'qwen3-8b model · Q4_K_M',
    params: { contextSize: 16384, kvCacheType: 'q8_0', extraArgs: [], env: {} },
    port: 8090,
    network: 'local',
    autoStart: false,
    createdAt: '2026-10-07T10:00:00.000Z',
    updatedAt: '2026-10-07T10:00:00.000Z',
    ...over,
  };
}

/** The server POST /api/servers (or a preset's start) returns for a request in this world. */
function startedServer(world: World, req: StartServerRequest): ServerInfo {
  const port = req.port ?? 8080;
  const preset = world.presets.find((p) => p.id === req.presetId);
  return serverInfo(`srv${world.servers.length + 1}`, {
    port,
    network: req.network ?? 'local',
    lanUrls: req.network === 'lan' ? [`http://192.168.1.20:${port}/v1`] : [],
    request: { ...req, port },
    ...(preset ? { presetId: preset.id, presetName: preset.name } : {}),
  });
}

function handle(world: World, method: string, path: string, body: unknown): unknown {
  const exact = world.routes[`${method} ${path}`];
  if (exact) return exact(body, path);
  for (const [k, h] of Object.entries(world.routes)) {
    if (k.endsWith('*') && `${method} ${path}`.startsWith(k.slice(0, -1))) return h(body, path);
  }
  const bare = path.split('?')[0]!;
  if (method === 'GET') {
    if (bare === '/api/system') return world.system;
    if (bare === '/api/engines') return world.engines;
    if (bare === '/api/models/local') return world.local;
    if (bare === '/api/models/curated') return { vramGB: 31.84, tierGB: 32, reference: world.curated[0], models: world.curated };
    if (bare === '/api/runs') return summaries(world.runs);
    if (bare === '/api/configs') {
      // The core's own index over this world's runs (parsed as the core reads them).
      const query = configsQuerySchema.parse(Object.fromEntries(new URLSearchParams(path.split('?')[1] ?? '')));
      const gpu = world.system.gpus[0];
      const sources = world.runs.map((r) => sourcesOf(parseRun(r)!)).filter((s) => s !== undefined);
      return queryConfigs(mergeSources(sources), query, { hostId: world.system.hostId, ...(gpu ? { gpuUuid: gpu.uuid, gpuName: gpu.name } : {}) });
    }
    if (bare === '/api/runs/active') return { active: world.active };
    if (bare === '/api/runs/tried') {
      const weakKey = new URLSearchParams(path.split('?')[1]).get('weakKey');
      return summaries(world.runs).filter((r) => r.modelWeakKey === weakKey);
    }
    if (bare === '/api/servers') return world.servers;
    if (bare === '/api/servers/presets') return world.presets;
    if (bare === '/api/servers/notices') return world.notices;
    if (bare === '/api/servers/api-key') return world.apiKey;
    if (bare === '/api/engines/custom') return world.customEngines;
    const log = /^\/api\/servers\/([^/]+)\/log$/.exec(bare);
    if (log) return { lines: world.logs[decodeURIComponent(log[1]!)] ?? [] };
    if (bare === '/api/setup/check') return { checkedAt: '2026-10-06T10:00:00.000Z', canBenchmark: true, platform: 'win32', items: [{ id: 'llamacpp', state: 'missing', required: true, params: {}, ...(world.installBytes === null ? {} : { action: { kind: 'install-llamacpp', bytes: world.installBytes } }) }] };
    const run = /^\/api\/runs\/([^/]+)$/.exec(bare);
    if (run) {
      const found = world.runs.find((r) => r.id === decodeURIComponent(run[1]!));
      if (!found) throw apiError('RUN_NOT_FOUND', { id: run[1]! }, 404);
      return found;
    }
  }
  if (method === 'POST') {
    if (bare === '/api/runs/plan') return world.plan(body);
    if (bare === '/api/servers/plan') return world.serverPlan(body);
    if (bare === '/api/servers') {
      const info = startedServer(world, body as StartServerRequest);
      world.servers = [...world.servers, info];
      return info;
    }
    if (bare === '/api/servers/presets') {
      const input = body as ServerPreset;
      if (world.presets.some((p) => p.name.toLowerCase() === input.name.toLowerCase())) throw apiError('VALIDATION', { reason: 'preset_name_taken', name: input.name });
      const saved = serverPreset(`p${world.presets.length + 1}`, { ...input, network: input.network ?? 'local', autoStart: input.autoStart ?? false });
      world.presets = [...world.presets, saved];
      return saved;
    }
    if (bare === '/api/servers/api-key/regenerate') {
      world.apiKey = { ...world.apiKey, key: `${world.apiKey.key}-new` };
      return world.apiKey;
    }
    const presetStart = /^\/api\/servers\/presets\/([^/]+)\/start$/.exec(bare);
    if (presetStart) {
      const p = world.presets.find((x) => x.id === decodeURIComponent(presetStart[1]!))!;
      const info = startedServer(world, { engine: p.engine, model: p.model, params: p.params, ...(p.port !== undefined ? { port: p.port } : {}), network: p.network, presetId: p.id });
      world.servers = [...world.servers, info];
      return info;
    }
    const restart = /^\/api\/servers\/([^/]+)\/restart$/.exec(bare);
    if (restart) {
      const old = world.servers.find((x) => x.id === decodeURIComponent(restart[1]!))!;
      const info = { ...old, id: `${old.id}-r` };
      world.servers = world.servers.map((x) => (x.id === old.id ? info : x));
      return info;
    }
    if (bare === '/api/models/fit') return world.fit;
    if (bare === '/api/runs') {
      world.active = activeRun('01M48PNN41KKD0ABVXTGK97Y6P');
      return { runId: world.active.runId };
    }
    if (bare === '/api/models/rescan') return world.local;
  }
  if (method === 'PUT') {
    const preset = /^\/api\/servers\/presets\/([^/]+)$/.exec(bare);
    if (preset) {
      const id = decodeURIComponent(preset[1]!);
      const next = { ...world.presets.find((p) => p.id === id)!, ...(body as Partial<ServerPreset>) };
      world.presets = world.presets.map((p) => (p.id === id ? next : p));
      return next;
    }
  }
  if (method === 'DELETE') {
    const notice = /^\/api\/servers\/notices\/([^/]+)$/.exec(bare);
    if (notice) {
      world.notices = world.notices.filter((n) => n.id !== decodeURIComponent(notice[1]!));
      return { ok: true };
    }
    const preset = /^\/api\/servers\/presets\/([^/]+)$/.exec(bare);
    if (preset) {
      world.presets = world.presets.filter((p) => p.id !== decodeURIComponent(preset[1]!));
      return { ok: true };
    }
    const server = /^\/api\/servers\/([^/]+)$/.exec(bare);
    if (server) {
      world.servers = world.servers.filter((x) => x.id !== decodeURIComponent(server[1]!));
      return { ok: true };
    }
    const run = /^\/api\/runs\/([^/]+)$/.exec(bare);
    if (run) {
      world.runs = world.runs.filter((r) => r.id !== decodeURIComponent(run[1]!));
      return { ok: true };
    }
  }
  throw new Error(`unexpected ${method} ${path}`);
}

/**
 * What the core's plan would list before a run in this world: llama.cpp when it is not installed,
 * a Docker image the status says is missing, a hub GGUF / vLLM repo that is not in the library
 * (sized like its suggestion). `pending` marks the placeholders in the command.
 */
export function coreNeeds(world: World, body: StartServerRequest): Pick<RunPlan, 'needs' | 'pending'> {
  const needs: RunPlan['needs'] = [];
  const pending: NonNullable<RunPlan['pending']> = [];
  const { repo, file } = body.model;
  const size = world.curated.find((c) => c.repo === repo && c.file === file)?.sizeBytes;
  if (repo && file && !world.local.some((m) => m.identity.file === file)) {
    needs.push({ kind: 'model', label: `${repo}/${file}`, ...(size === undefined ? {} : { bytes: size }) });
    pending.push('model');
  } else if (repo && !file && !world.local.some((m) => m.identity.repo === repo)) {
    needs.push({ kind: 'model', label: repo, ...(size === undefined ? {} : { bytes: size }) });
  }
  const status = world.engines.find((e) => e.kind === body.engine.kind);
  if (body.engine.kind === 'llamacpp-native' && !body.engine.executable && status?.installed === false) {
    needs.push({ kind: 'engine', label: 'llama.cpp', ...(world.installBytes === null ? {} : { bytes: world.installBytes }) });
    pending.push('engine');
  }
  if (status?.location && status.problems.includes('ENGINE_NOT_INSTALLED')) needs.push({ kind: 'image', label: status.location, bytes: 2_900_000_000 });
  return { needs, ...(pending.length ? { pending } : {}) };
}

/** The app's ApiClient over a fake world (settings and health from the shared fake). */
export function benchApi(patch: Partial<World> = {}, settings: Parameters<typeof fakeApi>[0] = { onboardingDone: true }): BenchApi {
  const base = fakeApi(settings);
  const world: World = { ...defaultWorld(), ...patch };
  if (!patch.plan) world.plan = (body) => planFor(coreNeeds(world, body as StartServerRequest));
  if (!patch.serverPlan) {
    world.serverPlan = (body) => {
      const req = body as StartServerRequest;
      const port = req.port ?? 8080;
      return serverPlanFor({
        ...coreNeeds(world, req),
        ...(req.params?.contextSize !== undefined ? { params: req.params, contextSize: req.params.contextSize } : {}),
        port,
        network: req.network ?? 'local',
        ...(req.network === 'lan' ? { lanUrls: [`http://192.168.1.20:${port}/v1`] } : {}),
      });
    };
  }
  const api = base as BenchApi;
  api.world = world;
  const baseGet = base.get;
  const call = async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
    api.calls.push({ method, path, ...(body === undefined ? {} : { body }) });
    return (await handle(world, method, path, body)) as T;
  };
  api.get = vi.fn(async <T,>(path: string) => {
    if (path === '/api/health' || path === '/api/settings') return baseGet<T>(path);
    return call<T>('GET', path);
  }) as ApiClient['get'];
  api.post = vi.fn(async <T,>(path: string, body?: unknown) => call<T>('POST', path, body)) as ApiClient['post'];
  api.del = vi.fn(async <T,>(path: string) => call<T>('DELETE', path)) as ApiClient['del'];
  const basePut = base.put;
  api.put = vi.fn(async <T,>(path: string, body?: unknown) => (path === '/api/settings' ? basePut<T>(path, body) : call<T>('PUT', path, body))) as ApiClient['put'];
  return api;
}

/** GET /api/runs/active of a run that just started (Quick, 95 s expected); `over` changes any field. */
export function activeRun(runId: string, over: Partial<ActiveRun> = {}): ActiveRun {
  return {
    runId,
    phase: 'prepare',
    progress: 0,
    startedAt: new Date(Date.now() - 1000).toISOString(),
    profile: 'quick',
    estimatedSeconds: 95,
    modelName: 'Qwen3 8B',
    engineLabel: 'llama.cpp b11438 (cuda-13.4)',
    scenario: planFor().scenario,
    points: [],
    ...over,
  };
}

/** A promise the test resolves or rejects later. */
export function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
