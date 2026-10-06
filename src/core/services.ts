import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { RunPlan, StartRunRequest } from '../contract/api';
import { AppError } from '../contract/errors';
import type { LocalModel } from '../contract/models';
import { BenchService } from './bench/service';
import { createBenchRoutes } from './bench/routes';
import { createLinuxEvictor, noEvictor, type CacheEvictor } from './cache/evictor';
import { createCacheRoutes } from './cache/routes';
import { createDockerRoutes } from './docker/routes';
import { createDockerServices, type DockerServices } from './docker/services';
import { LlamaDockerAdapter } from './engines/llamacpp-docker/adapter';
import { smFromComputeCap } from './engines/shared/compat';
import type { DockerLaunchPlan } from './engines/shared/docker-engine';
import { VllmDockerAdapter } from './engines/vllm-docker/adapter';
import { VllmNativeAdapter } from './engines/vllm-native/adapter';
import { createModelServices, type ModelServices } from './models/setup';
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
}

export interface CoreServices {
  ownership: OwnershipRegistry;
  registry: EngineRegistry;
  llama: LlamaNativeAdapter;
  docker: DockerServices;
  vllmDocker: VllmDockerAdapter;
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
  return {
    async getLocal(id) {
      const m = await ms.models.get(id).catch(() => undefined);
      if (!m || m.identity.sha256 || m.identity.format !== 'gguf' || !m.paths[0]) return m;
      const sha256 = await ms.models.hashes.enqueue(m.paths[0]).catch(() => undefined);
      if (sha256) m.identity.sha256 = sha256;
      return m;
    },
    async findByRepo(repo) {
      const all = await ms.models.list().catch(() => []);
      return all.find((m) => m.identity.repo === repo && m.identity.format === 'safetensors');
    },
  };
}

/** What a run benchmarks, resolved from the request. */
export async function resolveModelTarget(req: StartRunRequest, models: ModelsLookup | undefined): Promise<ModelTarget> {
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
  const registry = new EngineRegistry([
    llama,
    new ExternalAdapter({ fetch: deps.fetch, clock: deps.clock, createClient }),
    new LlamaDockerAdapter(dockerEngine),
    vllmDocker,
    // uv is installed by the setup module when needed (no Python on the PC): resolved at install time.
    new VllmNativeAdapter({ deps, createClient, ownership, hfToken: () => ctx.secrets.hfToken, uv: uvArgv }),
  ]);
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

  const needs = async (req: StartRunRequest): Promise<RunPlan['needs']> => {
    const out: RunPlan['needs'] = [];
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
    resolveModel: (req) => resolveModelTarget(req, models),
    slowSharedFilesystem: (plan) => (plan as Partial<DockerLaunchPlan>).slowSharedFilesystem === true,
    newMarker: () => (lastMarker = `gpubench-${randomUUID()}`),
    ...(modelServices
      ? {
          fit: async (req: StartRunRequest, model: ModelTarget, plan: { params: StartRunRequest['params'] }) =>
            model.local
              ? modelServices.models
                  .fit({ localId: model.local.id, engine: req.engine.kind, ...(plan.params ? { params: plan.params } : {}) })
                  .catch(() => undefined)
              : undefined,
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
    createServerRoutes(s.serve),
    createSetupRoutes(s.setup),
    createCacheRoutes(s),
    ...(s.modelServices?.routes ?? []),
  ];
}
