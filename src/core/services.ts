import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { RunPlan, StartServerRequest } from '../contract/api';
import { AppError } from '../contract/errors';
import type { LocalModel } from '../contract/models';
import { BenchService } from './bench/service';
import { createBenchRoutes } from './bench/routes';
import { createLinuxEvictor, noEvictor, type CacheEvictor } from './cache/evictor';
import { createCacheRoutes } from './cache/routes';
import { createConfigRoutes } from './configs/routes';
import { createModelVolumeRoutes } from './docker/model-volume-routes';
import { ModelVolumes, modelVolumeName } from './docker/model-volumes';
import { createDockerRoutes } from './docker/routes';
import { createDockerServices, type DockerServices } from './docker/services';
import { LlamaDockerAdapter } from './engines/llamacpp-docker/adapter';
import { smFromComputeCap } from './engines/shared/compat';
import type { DockerLaunchPlan } from './engines/shared/docker-engine';
import { VllmDockerAdapter } from './engines/vllm-docker/adapter';
import { VllmNativeAdapter } from './engines/vllm-native/adapter';
import { SglangDockerAdapter } from './engines/sglang-docker/adapter';
import { SglangNativeAdapter } from './engines/sglang-native/adapter';
import { CommandAdapter } from './engines/command/adapter';
import { withCustomEngines, type CustomEngineAdapter, type CustomEngineSource } from './engines/custom/adapter';
import { createCustomEngineRoutes } from './engines/custom/routes';
import { createNinferRoutes } from './engines/ninfer/routes';
import { createNinferServices, type NinferServices } from './engines/ninfer/setup';
import { createEngineUpdateRoutes } from './engines/updates/routes';
import { EngineUpdates } from './engines/updates/service';
import { FitCalibrator, type ModelKey } from './models/calibration';
import { vllmRepoFiles } from './downloads/service';
import { createModelServices, type ModelServices } from './models/setup';
import type { PlannedGguf } from './models/service';
import { engineBaseOf, isDockerKind, type EngineKind } from '../contract/engines';
import { isNinferKind } from '../contract/ninfer';
import { createLlamaBench } from './engines/llama-bench/llama-bench';
import { DockerInstaller } from './setup/docker-installer';
import { readOsRelease } from './setup/os-release';
import { createSetupRoutes } from './setup/routes';
import { createSetupService, type SetupService } from './setup/service';
import { SystemCheck } from './setup/system-check';
import { UvInstaller } from './setup/uv';
import { WindowsStandbyEvictor } from './cache/windows-standby';
import type { CoreContext } from './context';
import { displayCommand, redactArgv, redactEnv } from './engines/command-display';
import { ExternalAdapter } from './engines/external/adapter';
import type { ClientFactory } from './engines/instance';
import { LlamaNativeAdapter } from './engines/llamacpp-native/adapter';
import { EngineRegistry } from './engines/registry';
import { createEnginesRoutes } from './engines/routes';
import type { ModelTarget } from './engines/types';
import { createInferenceClient } from './inference/client';
import { OwnershipRegistry } from './process/ownership';
import { pickFreePort } from './process/ports';
import type { RouteModule } from './server/app';
import { ConfigsIndex } from './store/configs-index';
import { RunsRepo } from './store/runs-repo';
import { createServerRoutes } from './servers/routes';
import { ServeService } from './servers/service';
import { createSystemRoutes } from './system/routes';
import { createSystemService } from './system/service';

/** Lookup of local models (the models module plugs in here). */
export interface ModelsLookup {
  getLocal(id: string): Promise<LocalModel | undefined>;
  /** A copy of this HF repo downloaded into the library (safetensors folder for vLLM). */
  findByRepo?(repo: string): Promise<LocalModel | undefined>;
  /** The library copy of a hub GGUF (repo + path of the file in the repo), when downloaded. */
  findGguf?(repo: string, file: string): Promise<LocalModel | undefined>;
  /** What the download of a hub GGUF will create (identity, paths, bytes), for plan previews. */
  plannedGguf?(repo: string, file: string, revision?: string): Promise<PlannedGguf>;
  /** The library copy of a hub .ninfer artifact (repo + its path in the repo), when downloaded. */
  findNinfer?(repo: string, file: string): Promise<LocalModel | undefined>;
}

const LLAMA_KINDS: ReadonlySet<EngineKind> = new Set<EngineKind>(['llamacpp-native', 'llamacpp-docker']);

export interface CoreServices {
  ownership: OwnershipRegistry;
  registry: EngineRegistry;
  llama: LlamaNativeAdapter;
  docker: DockerServices;
  vllmDocker: VllmDockerAdapter;
  sglangDocker: SglangDockerAdapter;
  /** NInfer: both adapters, its WSL processes, the guided build (engines/ninfer). */
  ninfer: NinferServices;
  /** "Aggiorna" on the engine cards (vLLM, SGLang, custom engines). */
  updates: EngineUpdates;
  /** Models copied into Docker volumes (fast loads with Docker Desktop). */
  modelVolumes: ModelVolumes;
  models?: ModelsLookup;
  runs: RunsRepo;
  bench: BenchService;
  /** Engines started with "Avvia solo il server così". */
  serve: ServeService;
  /** "Controllo sistema" checklist and guided installs (Docker, uv). */
  setup: SetupService;
  systemCheck: SystemCheck;
  dockerInstaller: DockerInstaller;
  uv: UvInstaller;
  refreshDocker(): void;
  /** Local library, HF hub, fit estimates and downloads (absent only in narrow unit tests). */
  modelServices?: ModelServices;
  evictor: CacheEvictor;
  windowsStandby?: WindowsStandbyEvictor;
  /** PIDs of engine processes GPU Bench started (kept fresh for "other GPU users" checks). */
  ownPids(): number[];
  /** Ownership marker of the run in progress (its container must survive a cleanup). */
  activeMarker(): string | undefined;
}

export interface ServicesOptions {
  /** Overrides the local-model lookup (tests); by default the models module provides it. */
  models?: ModelsLookup;
  /** false = do not create the models/downloads module (narrow unit tests). */
  modelServices?: false;
  /**
   * Argv placed before the llama-server executable. Only for tests/dev (GPUBENCH_LLAMA_LAUNCHER),
   * so the fake engine script can stand in for a real binary.
   */
  llamaLauncherPrefix?: string[];
  /** Injected in tests; defaults to dataDir/processes.json. */
  ownership?: OwnershipRegistry;
}

export function parseArgvEnv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((x) => typeof x === 'string')) return parsed as string[];
  } catch {
    /* not JSON */
  }
  return undefined;
}

/**
 * Local models for runs. A GGUF is hashed (sha256, cached by path/size/mtime) the first time it is
 * benchmarked, so its results are recognized later, also when the same file shows up on HF.
 */
export function modelsLookup(ms: Pick<ModelServices, 'models'>): ModelsLookup {
  const getLocal = async (id: string): Promise<LocalModel | undefined> => {
    const m = await ms.models.get(id).catch(() => undefined);
    // A download stopped halfway is listed, never run: the engine would fail on the missing files.
    if (m?.incomplete) throw new AppError('MODEL_NOT_FOUND', 'The model is not complete yet', { params: { id, reason: 'incomplete', have: m.incomplete.have, total: m.incomplete.total } });
    if (!m || m.identity.sha256 || m.identity.format !== 'gguf' || !m.paths[0]) return m;
    const sha256 = await ms.models.hashes.enqueue(m.paths[0]).catch(() => undefined);
    if (sha256) m.identity.sha256 = sha256;
    return m;
  };
  return {
    getLocal,
    async findByRepo(repo) {
      const all = await ms.models.list().catch(() => []);
      return all.find((m) => m.identity.repo === repo && m.identity.format === 'safetensors' && !m.incomplete);
    },
    async findGguf(repo, file) {
      const m = await ms.models.findGguf(repo, file).catch(() => undefined);
      // Through getLocal: a GGUF is hashed the first time it is benchmarked.
      return m ? getLocal(m.id) : undefined;
    },
    plannedGguf: (repo, file, revision) => ms.models.plannedGguf(repo, file, revision),
    async findNinfer(repo, file) {
      const name = path.posix.basename(file);
      const all = await ms.models.list().catch(() => []);
      return all.find((m) => m.identity.format === 'ninfer' && !m.incomplete && m.identity.repo === repo && m.identity.file === name);
    },
  };
}

/**
 * What a run benchmarks, resolved from the request. A hub GGUF (`repo` + `file`, llama.cpp engines)
 * is the library copy; before its download only a preview resolves it (to the pending download),
 * a real start fails with MODEL_NOT_FOUND so the UI downloads it first.
 */
export async function resolveModelTarget(
  req: StartServerRequest,
  models: ModelsLookup | undefined,
  opts: { preview?: boolean } = {},
): Promise<ModelTarget> {
  if (req.engine.kind === 'external') {
    const name = req.model.name ?? 'default';
    return {
      identity: {
        displayName: req.model.name ?? req.engine.baseUrl ?? 'endpoint',
        format: 'remote',
        source: 'external',
        files: [],
        weakKey: `external/${req.engine.baseUrl ?? ''}/${name}`,
      },
      servedName: name,
    };
  }
  if (req.model.localId) {
    const local = await models?.getLocal(req.model.localId);
    if (!local) throw new AppError('MODEL_NOT_FOUND', 'Local model not found', { params: { id: req.model.localId } });
    return { identity: local.identity, local };
  }
  const { repo, file, revision } = req.model;
  // NInfer: the library copy of a hub .ninfer artifact (downloaded first: there is no preview of one).
  if (repo && file && isNinferKind(req.engine.kind)) {
    const local = await models?.findNinfer?.(repo, file);
    if (local) return { identity: local.identity, local };
    throw new AppError('MODEL_NOT_FOUND', 'The model is not downloaded yet', { params: { repo, file, reason: 'not_downloaded' } });
  }
  if (repo && file && LLAMA_KINDS.has(req.engine.kind)) {
    const local = await models?.findGguf?.(repo, file);
    if (local) return { identity: local.identity, local };
    if (!opts.preview || !models?.plannedGguf) {
      throw new AppError('MODEL_NOT_FOUND', 'The model is not downloaded yet', { params: { repo, file, reason: 'not_downloaded' } });
    }
    const planned = await models.plannedGguf(repo, file, revision);
    return { identity: planned.identity, pending: { repo, file: planned.file, paths: planned.paths, bytes: planned.bytes } };
  }
  if (req.model.repo) {
    // vLLM reads a downloaded copy when there is one: the cold load then measures loading, not downloading.
    const local = await models?.findByRepo?.(req.model.repo);
    if (local) return { identity: local.identity, local, repo: req.model.repo };
    const revision = req.model.revision ?? 'main';
    return {
      identity: {
        displayName: path.posix.basename(req.model.repo),
        format: 'safetensors',
        source: 'hf',
        repo: req.model.repo,
        revision,
        files: [],
        weakKey: `${req.model.repo}@${revision}`,
      },
      repo: req.model.repo,
    };
  }
  throw new AppError('VALIDATION', 'The request names no model', { params: { reason: 'model_required' } });
}

/** Inference clients for engine instances, sharing the core's fetch and clock. */
export function clientFactory(deps: Pick<CoreContext['deps'], 'fetch' | 'clock'>): ClientFactory {
  return (flavor, baseUrl, o) =>
    createInferenceClient(
      flavor,
      baseUrl,
      { fetch: deps.fetch, clock: deps.clock },
      { ...(o?.apiKey ? { apiKey: o.apiKey } : {}), ...(o?.model ? { model: o.model } : {}) },
    );
}

export async function createServices(ctx: CoreContext, opts: ServicesOptions = {}): Promise<CoreServices> {
  const { deps } = ctx;
  const ownership =
    opts.ownership ??
    new OwnershipRegistry({ file: path.join(deps.paths.dataDir, 'processes.json'), platform: deps.platform, proc: deps.proc });
  try {
    const report = await ownership.cleanupOrphans();
    if (report.stopped.length) deps.log.info('stopped leftover engines from a previous session', { pids: report.stopped.map((r) => r.pid) });
  } catch (e) {
    deps.log.warn('orphan cleanup failed', { error: String(e) });
  }

  let pidCache: number[] = [];
  const refreshPids = () =>
    ownership.list().then(
      (r) => {
        pidCache = r.filter((x) => x.kind === 'process').map((x) => x.pid);
      },
      () => {},
    );
  await refreshPids();
  ctx.hub.subscribe((e) => {
    if (e.type === 'run.phase' || e.type === 'run.done' || e.type === 'run.error') void refreshPids();
  });

  const createClient = clientFactory(deps);
  const uv = new UvInstaller({ ...deps, enginesDir: deps.paths.enginesDir, githubApi: deps.endpoints.githubApi });
  const uvArgv = async (): Promise<string[] | undefined> => {
    const p = await uv.uvPath();
    return p ? [p] : undefined;
  };

  const llama = new LlamaNativeAdapter({
    deps,
    ownership,
    createClient,
    cudaVersion: async () => (await ctx.telemetry.probe().catch(() => []))[0]?.cudaVersion,
    ...(opts.llamaLauncherPrefix ? { launcherPrefix: opts.llamaLauncherPrefix } : {}),
  });
  const docker = createDockerServices(deps);
  const dockerEngine = { deps, cli: docker.cli, environment: docker.env, images: docker.images, createClient };
  const vllmDocker = new VllmDockerAdapter({
    ...dockerEngine,
    hub: docker.hub,
    api: docker.api,
    hfToken: () => ctx.secrets.hfToken,
    gpuSm: async () => {
      const cc = (await ctx.telemetry.probe().catch(() => []))[0]?.computeCapability;
      return cc ? smFromComputeCap(cc) : undefined;
    },
  });
  const llamaDocker = new LlamaDockerAdapter(dockerEngine);
  const sglangDocker = new SglangDockerAdapter({ ...dockerEngine, hub: docker.hub, api: docker.api, hfToken: () => ctx.secrets.hfToken });
  // "Motori personalizzati": read from the settings on every use, so an edit applies to the next launch.
  const customEngines: CustomEngineSource = { list: async () => (await ctx.settings.get()).customEngines };
  const ninfer = createNinferServices({
    deps,
    createClient,
    ownership,
    settings: ctx.settings,
    gpus: async () =>
      (await ctx.telemetry.probe().catch(() => [])).map((g) => ({ name: g.name, memTotalMiB: g.memoryTotalMiB, ...(g.computeCapability ? { computeCapability: g.computeCapability } : {}) })),
    // The library is set up below; it is only read when an update is checked.
    models: () => modelServices?.models.list() ?? Promise.resolve([]),
  });
  // NInfer servers a crashed session left in WSL (checked by their marker); no record = WSL is not even asked.
  void ninfer.cleanupOrphans().catch((e: unknown) => deps.log.warn('NInfer WSL cleanup failed', { error: String(e) }));
  const registry = new EngineRegistry(
    withCustomEngines(
      [
        llama,
        new ExternalAdapter({ fetch: deps.fetch, clock: deps.clock, createClient }),
        llamaDocker,
        vllmDocker,
        // uv is installed by the setup module when needed (no Python on the PC): resolved at install time.
        new VllmNativeAdapter({ deps, createClient, ownership, hfToken: () => ctx.secrets.hfToken, uv: uvArgv }),
        sglangDocker,
        new SglangNativeAdapter({ deps, createClient, ownership, hfToken: () => ctx.secrets.hfToken, uv: uvArgv }),
        new CommandAdapter({ deps, createClient, ownership }),
        ninfer.native,
        ninfer.wsl,
      ],
      customEngines,
    ),
  );
  const updates = new EngineUpdates({
    registry,
    settings: ctx.settings,
    images: docker.images,
    hub: docker.hub,
    tags: { 'vllm-docker': (o) => vllmDocker.tags(o), 'sglang-docker': (o) => sglangDocker.tags(o) },
    tools: { proc: deps.proc, git: deps.endpoints.git ?? ['git'], cmake: deps.endpoints.cmake ?? ['cmake'] },
    fetch: deps.fetch,
    pypi: deps.endpoints.pypi ?? 'https://pypi.org',
    clock: deps.clock,
  });
  const modelVolumes = new ModelVolumes({ cli: docker.cli, images: docker.images, clock: deps.clock, log: deps.log });
  // Containers left by a crashed session (label gpubench=1); never anyone else's. Docker may be off: best effort.
  void docker.env.cleanupOrphans().catch(() => undefined);

  let windowsStandby: WindowsStandbyEvictor | undefined;
  let evictor: CacheEvictor = noEvictor;
  if (deps.platform === 'linux') evictor = createLinuxEvictor(deps);
  else if (deps.platform === 'win32') evictor = windowsStandby = new WindowsStandbyEvictor(deps);

  /**
   * VRAM held right now by engines GPU Bench started (a server left running): in use, but not by "other
   * programs" (the fit's busyMiB). Read only while one runs, and at most every 2 s.
   */
  let ownVram: { at: number; value: Promise<number> } | undefined;
  const ownVramMiB = (): Promise<number> => {
    const now = deps.clock.now();
    if (ownVram && now - ownVram.at < 2000) return ownVram.value;
    const value = (async () => {
      const pids = new Set((await ownership.list().catch(() => [])).filter((r) => r.kind === 'process').map((r) => r.pid));
      if (pids.size === 0) return 0;
      const users = await ctx.telemetry.otherGpuUsers([]).catch(() => []);
      return users.filter((u) => pids.has(u.pid)).reduce((a, u) => a + (u.memMiB ?? 0), 0);
    })();
    ownVram = { at: now, value };
    return value;
  };

  const runs = new RunsRepo(async () => (await ctx.settings.get()).resultsDir || deps.paths.resultsDir);
  // "Stima tarata su N misure": VRAM peaks of past runs on this GPU correct the fit estimates.
  const calibrator = new FitCalibrator(runs, () => bench.here());
  const calibration = (model: ModelKey, kind: EngineKind) => calibrator.for(model, kind);

  const modelServices =
    opts.modelServices === false
      ? undefined
      : createModelServices(ctx, {
          gpuInfo: async () => {
            const g = (await ctx.telemetry.snapshot().catch(() => []))[0];
            if (!g?.memTotalMiB) return undefined;
            const own = await ownVramMiB();
            return { totalMiB: g.memTotalMiB, freeMiB: g.memTotalMiB - (g.memUsedMiB ?? 0), ...(own > 0 ? { ownMiB: own } : {}) };
          },
          // Hashing every local model at start-up would read tens of GB; models are hashed when benchmarked.
          autoHash: false,
          calibration,
        });
  if (modelServices) await modelServices.init();
  const models: ModelsLookup | undefined = opts.models ?? (modelServices ? modelsLookup(modelServices) : undefined);

  const needs = async (req: StartServerRequest, model?: ModelTarget): Promise<RunPlan['needs']> => {
    const out: RunPlan['needs'] = [];
    // A hub GGUF not downloaded yet (resolved for the preview as its pending download).
    if (model?.pending) out.push({ kind: 'model', label: `${model.pending.repo}/${model.pending.file}`, bytes: model.pending.bytes });
    const base = engineBaseOf(req.engine.kind);
    if ((base === 'vllm' || base === 'sglang') && req.model.repo && modelServices) {
      const local = await models?.findByRepo?.(req.model.repo);
      if (!local) {
        const files = await modelServices.models.hubFiles(req.model.repo, req.model.revision).catch(() => []);
        // Exactly what the download will fetch (the root model folder's runtime files).
        const fetched = new Set(vllmRepoFiles(files));
        const bytes = files.filter((f) => fetched.has(f.path)).reduce((n, f) => n + f.sizeBytes, 0);
        out.push({ kind: 'model', label: req.model.repo, ...(bytes > 0 ? { bytes } : {}) });
      }
    }
    // A custom engine names its own executable: no managed build to install.
    if (req.engine.kind === 'llamacpp-native' && !req.engine.executable && req.engine.customEngineId === undefined) {
      const status = await llama.detect(req.engine);
      if (!status.installed) {
        const plan = await llama.planInstall({}).catch(() => undefined);
        out.push({ kind: 'engine', label: 'llama.cpp', ...(plan ? { bytes: plan.bytes } : {}) });
      }
    }
    if (isDockerKind(req.engine.kind)) {
      // Through the registry: a fork's image is the one to pull.
      const adapter = registry.require(req.engine.kind) as CustomEngineAdapter;
      const status = await adapter.detect(req.engine);
      // Docker answers but the image is not there yet: it is pulled before the run (never part of the load time).
      if (status.problems.includes('ENGINE_NOT_INSTALLED') && status.location) {
        // Docker adapters always pull their image (DockerEngineAdapter.installPlan).
        const installPlan = adapter.installPlan as NonNullable<CustomEngineAdapter['installPlan']>;
        const plan = await installPlan(req.engine).catch(() => undefined);
        out.push({ kind: 'image', label: status.location, ...(plan?.bytes ? { bytes: plan.bytes } : {}) });
      }
    }
    return out;
  };

  const llamaBench = createLlamaBench({
    proc: deps.proc,
    platform: deps.platform,
    ...(opts.llamaLauncherPrefix ? { launcherPrefix: opts.llamaLauncherPrefix } : {}),
  });

  const osRelease = () => readOsRelease();
  /** After a guided install, re-read Docker's state so the UI sees it at once. */
  const refreshDocker = (): void => void docker.env.dockerStatus().catch(() => undefined);
  const dockerInstaller = new DockerInstaller({
    ...deps,
    cacheDir: deps.paths.cacheDir,
    osRelease,
    ...(deps.endpoints.dockerInstaller ? { installerUrl: deps.endpoints.dockerInstaller } : {}),
  });

  const systemCheck = new SystemCheck({
    platform: deps.platform,
    arch: deps.arch,
    telemetryStatus: () => ctx.telemetry.status(),
    probeGpus: () => ctx.telemetry.probe(),
    isWsl: async () => (await ctx.sysinfo.getFingerprint()).os.isWsl,
    osRelease,
    llamacpp: () => llama.detect(),
    llamacppInstallBytes: async () => (await llama.planInstall({})).bytes,
    localModels: () => modelServices?.models.list() ?? Promise.resolve([]),
    modelsDir: () => modelServices?.models.libraryDir() ?? Promise.resolve(deps.paths.modelsDir),
    dockerStatus: () => docker.env.dockerStatus(),
    dockerInstallBytes: () => dockerInstaller.installerSize(),
    uvPath: () => uv.uvPath(),
    uvInstallBytes: async () => (await uv.plan()).sizeBytes,
    refresh: () => ctx.telemetry.refresh(),
  });
  const setup = createSetupService({
    platform: deps.platform,
    systemCheck,
    docker: dockerInstaller,
    uv,
    onInstalled: refreshDocker,
    publish: (e) => ctx.hub.publish(e),
    shutdown: ctx.shutdown,
    log: deps.log,
  });

  // Servers are planned like runs (same model resolution, engine tweaks, fit), with their own settings.
  const serve: ServeService = new ServeService({
    clock: deps.clock,
    prepare: (req, marker) => bench.prepareServer(req, { preview: false, marker }),
    plan: (req) => bench.planServer(req),
    blockedBy: () => {
      const run = bench.active();
      return run ? new AppError('RUN_IN_PROGRESS', 'A benchmark is running on the GPU', { params: { reason: 'run_in_progress', runId: run.runId } }) : undefined;
    },
    displayCommand,
    redact: (argv, env) => ({ argv: redactArgv(argv), env: redactEnv(env) }),
    // A native server is one of our engine processes: never reported as "another program on the GPU".
    onChange: () => void refreshPids(),
  });

  let lastMarker: string | undefined;
  const bench: BenchService = new BenchService({
    clock: deps.clock,
    runs,
    publish: (e) => ctx.hub.publish(e),
    telemetry: ctx.telemetry,
    fingerprint: () => ctx.sysinfo.getFingerprint(),
    displayCommand,
    redact: (argv, env) => ({ argv: redactArgv(argv), env: redactEnv(env) }),
    getAdapter: (kind) => registry.require(kind),
    resolveModel: (req, o) => resolveModelTarget(req, models, o),
    slowSharedFilesystem: (plan) => (plan as Partial<DockerLaunchPlan>).slowSharedFilesystem === true,
    // Docker Desktop (Windows/macOS) reads host folders slowly: use the model's volume copy when there is one.
    adjustEngine: async (req, model) =>
      req.engine.kind === 'llamacpp-docker' && deps.platform !== 'linux' && !req.engine.modelVolume && model.local && (await modelVolumes.exists(model.local.id).catch(() => false))
        ? { ...req.engine, modelVolume: modelVolumeName(model.local.id) }
        : undefined,
    newMarker: () => (lastMarker = `gpubench-${randomUUID()}`),
    ...(modelServices
      ? {
          // A local model, or a hub GGUF still to download (estimated from its remote header).
          fit: async (req: StartServerRequest, model: ModelTarget, plan: { params: StartServerRequest['params'] }) => {
            const which = model.local ? { localId: model.local.id } : model.pending ? { repo: model.pending.repo, file: model.pending.file } : undefined;
            if (!which) return undefined;
            return modelServices.models.fit({ ...which, engine: req.engine.kind, ...(plan.params ? { params: plan.params } : {}) }).catch(() => undefined);
          },
        }
      : {}),
    pickPort: () => pickFreePort(),
    needs,
    evictCache: async (files) => evictor.evict(files),
    llamaBench,
    appVersion: deps.appVersion,
    cacheDir: deps.paths.cacheDir,
    resourcesDir: deps.paths.resourcesDir,
    ownPids: () => pidCache,
    telemetryIntervalMs: async () => (await ctx.settings.get()).telemetryIntervalMs,
    shutdown: ctx.shutdown,
    blockedBy: () =>
      serve.busy() ? new AppError('VRAM_BUSY', 'A GPU Bench server is running on the GPU', { params: { reason: 'own_server' } }) : undefined,
    calibration: (model, kind) => {
      const id = model.identity;
      return calibration({ weakKey: id.weakKey, sha256: id.sha256, architecture: id.facts?.architecture }, kind);
    },
    // "Comandi per questo modello": recipes and custom engines are settings.
    recipes: async () => {
      const s = await ctx.settings.get();
      return { recipes: s.modelRecipes, customEngines: s.customEngines };
    },
  });

  return {
    ownership,
    registry,
    llama,
    docker,
    vllmDocker,
    sglangDocker,
    ninfer,
    updates,
    modelVolumes,
    ...(models ? { models } : {}),
    runs,
    bench,
    serve,
    setup,
    systemCheck,
    dockerInstaller,
    uv,
    refreshDocker,
    activeMarker: () => (bench.active() ? lastMarker : undefined),
    ...(modelServices ? { modelServices } : {}),
    evictor,
    ...(windowsStandby ? { windowsStandby } : {}),
    ownPids: () => pidCache,
  };
}

/** HTTP routes of every service. */
export function serviceModules(s: CoreServices): RouteModule[] {
  return [
    createSystemRoutes((ctx) =>
      createSystemService({
        paths: ctx.deps.paths,
        clock: ctx.deps.clock,
        settings: ctx.settings,
        telemetry: ctx.telemetry,
        sysinfo: ctx.sysinfo,
        log: ctx.deps.log,
        ownPids: s.ownPids,
        dockerStatus: () => s.docker.env.dockerStatus(),
      }),
    ),
    createDockerRoutes((ctx) => ({
      env: s.docker.env,
      images: s.docker.images,
      vllm: s.vllmDocker,
      publish: (e) => ctx.hub.publish(e),
      defaultGpuImage: async () => (await ctx.settings.get()).lastEngine?.image ?? 'ghcr.io/ggml-org/llama.cpp:server-cuda',
      // The running benchmark's container and every server started from here survive a cleanup.
      activeMarkers: () => [s.activeMarker(), ...s.serve.list().map((x) => x.id)].filter((m): m is string => m !== undefined),
      shutdown: ctx.shutdown,
    })),
    (app, ctx) =>
      createEnginesRoutes({
        registry: s.registry,
        llama: s.llama,
        sglang: s.sglangDocker,
        publish: (e) => ctx.hub.publish(e),
        configs: async () => {
          const last = (await ctx.settings.get()).lastEngine;
          return last ? { [last.kind]: last } : {};
        },
        shutdown: ctx.shutdown,
      })(app, ctx),
    (app, ctx) => createCustomEngineRoutes({ settings: ctx.settings, registry: s.registry })(app, ctx),
    (app, ctx) => createNinferRoutes(s.ninfer.routes({ publish: (e) => ctx.hub.publish(e), shutdown: ctx.shutdown }))(app, ctx),
    (app, ctx) =>
      createEngineUpdateRoutes({
        updates: s.updates,
        publish: (e) => ctx.hub.publish(e),
        busy: () => s.bench.active() !== undefined || s.serve.busy(),
        shutdown: ctx.shutdown,
      })(app, ctx),
    createBenchRoutes(s.bench, s.runs),
    createConfigRoutes(new ConfigsIndex(s.runs), () => s.bench.here()),
    (app, ctx) =>
      createModelVolumeRoutes({
        volumes: s.modelVolumes,
        getLocal: async (id) => s.models?.getLocal(id),
        publish: (e) => ctx.hub.publish(e),
        shutdown: ctx.shutdown,
      })(app, ctx),
    createServerRoutes(s.serve),
    createSetupRoutes(s.setup),
    createCacheRoutes(s),
    ...(s.modelServices?.routes ?? []),
  ];
}
