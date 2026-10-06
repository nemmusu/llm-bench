import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { RunPlan, StartRunRequest } from '../contract/api';
import { AppError } from '../contract/errors';
import type { LocalModel } from '../contract/models';
import { BenchService } from './bench/service';
import { createBenchRoutes } from './bench/routes';
import { createLinuxEvictor, noEvictor, type CacheEvictor } from './cache/evictor';
import { createCacheRoutes } from './cache/routes';
import { createModelVolumeRoutes } from './docker/model-volume-routes';
import { ModelVolumes, modelVolumeName } from './docker/model-volumes';
import { createDockerRoutes } from './docker/routes';
import { createDockerServices, type DockerServices } from './docker/services';
import { LlamaDockerAdapter } from './engines/llamacpp-docker/adapter';
import { smFromComputeCap } from './engines/shared/compat';
import type { DockerLaunchPlan } from './engines/shared/docker-engine';
import { VllmDockerAdapter } from './engines/vllm-docker/adapter';
import { VllmNativeAdapter } from './engines/vllm-native/adapter';
import { createModelServices, type ModelServices } from './models/setup';
import type { PlannedGguf } from './models/service';
import type { EngineKind } from '../contract/engines';
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
}

const LLAMA_KINDS: ReadonlySet<EngineKind> = new Set<EngineKind>(['llamacpp-native', 'llamacpp-docker']);

export interface CoreServices {
  ownership: OwnershipRegistry;
  registry: EngineRegistry;
  llama: LlamaNativeAdapter;
  docker: DockerServices;
  vllmDocker: VllmDockerAdapter;
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
    if (!m || m.identity.sha256 || m.identity.format !== 'gguf' || !m.paths[0]) return m;
    const sha256 = await ms.models.hashes.enqueue(m.paths[0]).catch(() => undefined);
    if (sha256) m.identity.sha256 = sha256;
    return m;
  };
  return {
    getLocal,
    async findByRepo(repo) {
      const all = await ms.models.list().catch(() => []);
      return all.find((m) => m.identity.repo === repo && m.identity.format === 'safetensors');
    },
    async findGguf(repo, file) {
      const m = await ms.models.findGguf(repo, file).catch(() => undefined);
      // Through getLocal: a GGUF is hashed the first time it is benchmarked.
      return m ? getLocal(m.id) : undefined;
    },
    plannedGguf: (repo, file, revision) => ms.models.plannedGguf(repo, file, revision),
  };
}

/**
 * What a run benchmarks, resolved from the request. A hub GGUF (`repo` + `file`, llama.cpp engines)
 * is the library copy; before its download only a preview resolves it (to the pending download),
 * a real start fails with MODEL_NOT_FOUND so the UI downloads it first.
 */
export async function resolveModelTarget(
  req: StartRunRequest,
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
  const registry = new EngineRegistry([
    llama,
    new ExternalAdapter({ fetch: deps.fetch, clock: deps.clock, createClient }),
    llamaDocker,
    vllmDocker,
    // uv is installed by the setup module when needed (no Python on the PC): resolved at install time.
    new VllmNativeAdapter({ deps, createClient, ownership, hfToken: () => ctx.secrets.hfToken, uv: uvArgv }),
  ]);
  const modelVolumes = new ModelVolumes({ cli: docker.cli, images: docker.images, clock: deps.clock, log: deps.log });
  // Containers left by a crashed session (label gpubench=1); never anyone else's. Docker may be off: best effort.
  void docker.env.cleanupOrphans().catch(() => undefined);

  let windowsStandby: WindowsStandbyEvictor | undefined;
  let evictor: CacheEvictor = noEvictor;
  if (deps.platform === 'linux') evictor = createLinuxEvictor(deps);
  else if (deps.platform === 'win32') evictor = windowsStandby = new WindowsStandbyEvictor(deps);

  const runs = new RunsRepo(async () => (await ctx.settings.get()).resultsDir || deps.paths.resultsDir);

  const modelServices =
    opts.modelServices === false
      ? undefined
      : createModelServices(ctx, {
          gpuInfo: async () => {
            const g = (await ctx.telemetry.snapshot().catch(() => []))[0];
            if (!g?.memTotalMiB) return undefined;
            return { totalMiB: g.memTotalMiB, freeMiB: g.memTotalMiB - (g.memUsedMiB ?? 0) };
          },
          // Hashing every local model at start-up would read tens of GB; models are hashed when benchmarked.
          autoHash: false,
        });
  if (modelServices) await modelServices.init();
  const models: ModelsLookup | undefined = opts.models ?? (modelServices ? modelsLookup(modelServices) : undefined);

  const needs = async (req: StartRunRequest, model?: ModelTarget): Promise<RunPlan['needs']> => {
    const out: RunPlan['needs'] = [];
    // A hub GGUF not downloaded yet (resolved for the preview as its pending download).
    if (model?.pending) out.push({ kind: 'model', label: `${model.pending.repo}/${model.pending.file}`, bytes: model.pending.bytes });
    if ((req.engine.kind === 'vllm-docker' || req.engine.kind === 'vllm-native') && req.model.repo && modelServices) {
      const local = await models?.findByRepo?.(req.model.repo);
      if (!local) {
        const files = await modelServices.models.hubFiles(req.model.repo, req.model.revision).catch(() => []);
        const bytes = files.filter((f) => !/\.(gguf|pth|pt|bin)$/i.test(f.path) && !f.path.startsWith('original/')).reduce((n, f) => n + f.sizeBytes, 0);
        out.push({ kind: 'model', label: req.model.repo, ...(bytes > 0 ? { bytes } : {}) });
      }
    }
    if (req.engine.kind === 'llamacpp-native' && !req.engine.executable) {
      const status = await llama.detect(req.engine);
      if (!status.installed) {
        const plan = await llama.planInstall({}).catch(() => undefined);
        out.push({ kind: 'engine', label: 'llama.cpp', ...(plan ? { bytes: plan.bytes } : {}) });
      }
    }
    if (req.engine.kind === 'llamacpp-docker' || req.engine.kind === 'vllm-docker') {
      const adapter = req.engine.kind === 'vllm-docker' ? vllmDocker : llamaDocker;
      const status = await adapter.detect(req.engine);
      // Docker answers but the image is not there yet: it is pulled before the run (never part of the load time).
      if (status.problems.includes('ENGINE_NOT_INSTALLED') && status.location) {
        const plan = await adapter.installPlan(req.engine).catch(() => undefined);
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

  const serve = new ServeService({
    clock: deps.clock,
    getAdapter: (kind) => registry.require(kind),
    resolveModel: (req) => resolveModelTarget({ ...req, profile: 'quick', allowSharedGpu: true }, models),
    pickPort: () => pickFreePort(),
    displayCommand,
    redact: (argv, env) => ({ argv: redactArgv(argv), env: redactEnv(env) }),
  });

  let lastMarker: string | undefined;
  const bench = new BenchService({
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
          fit: async (req: StartRunRequest, model: ModelTarget, plan: { params: StartRunRequest['params'] }) => {
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
  });

  return {
    ownership,
    registry,
    llama,
    docker,
    vllmDocker,
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
      activeMarkers: () => {
        const m = s.activeMarker();
        return m ? [m] : [];
      },
      shutdown: ctx.shutdown,
    })),
    (app, ctx) =>
      createEnginesRoutes({
        registry: s.registry,
        llama: s.llama,
        publish: (e) => ctx.hub.publish(e),
        configs: async () => {
          const last = (await ctx.settings.get()).lastEngine;
          return last ? { [last.kind]: last } : {};
        },
        shutdown: ctx.shutdown,
      })(app, ctx),
    createBenchRoutes(s.bench, s.runs),
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
