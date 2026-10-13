import path from 'node:path';
import type { CoreContext } from '../context';
import { createDownloadsRoutes } from '../downloads/routes';
import { DownloadService, type DownloadServiceOptions } from '../downloads/service';
import type { RouteModule } from '../server/app';
import { createModelsRoutes } from './routes';
import { ModelsService, type ModelsServiceOptions } from './service';
import type { GpuInfoFn } from './types';
import { createUpdatesRoutes, ModelUpdatesService } from './updates';

export interface ModelServicesOptions {
  /** Total/free VRAM of the benchmark GPU (telemetry snapshot); undefined without an NVIDIA GPU. */
  gpuInfo: GpuInfoFn;
  /** Background sha256 of local models after scans (default true). Pause it during runs. */
  autoHash?: boolean;
  statfs?: DownloadServiceOptions['statfs'];
  /** Fit estimates corrected with the VRAM peaks measured on this GPU ("stima tarata su N misure"). */
  calibration?: ModelsServiceOptions['calibration'];
}

export interface ModelServices {
  models: ModelsService;
  downloads: DownloadService;
  /** "Aggiornamento disponibile": the PC's hub models against their repos (on demand, after downloads, daily). */
  updates: ModelUpdatesService;
  /** Route modules to append to createApp's modules. */
  routes: RouteModule[];
  /** Restores the persisted download queue and starts the daily update check; call once after createCore built the context. */
  init(): Promise<void>;
}

/**
 * Builds the models + downloads services from the shared context: HF token from
 * ctx.secrets.hfToken (read on every request, so a token pushed later is used), events through
 * ctx.hub, settings for modelsDir / extra folders, and a rescan after every finished download.
 */
export function createModelServices(ctx: CoreContext, opts: ModelServicesOptions): ModelServices {
  const getToken = () => ctx.secrets.hfToken;
  const models = new ModelsService({
    deps: ctx.deps,
    settings: () => ctx.settings.get(),
    getToken,
    gpuInfo: opts.gpuInfo,
    ...(opts.autoHash !== undefined ? { autoHash: opts.autoHash } : {}),
    ...(opts.calibration ? { calibration: opts.calibration } : {}),
  });
  const updates = new ModelUpdatesService({
    hub: models.hub,
    list: () => models.list(),
    clock: ctx.deps.clock,
    log: ctx.deps.log,
    file: path.join(ctx.deps.paths.dataDir, 'model-updates.json'),
  });
  const downloads = new DownloadService({
    fetch: ctx.deps.fetch,
    clock: ctx.deps.clock,
    log: ctx.deps.log,
    dataDir: ctx.deps.paths.dataDir,
    modelsDir: () => models.libraryDir(),
    hub: models.hub,
    publish: (e) => ctx.hub.publish(e),
    onComplete: async (job) => {
      await models.rescan();
      // The listing the download just used says what else the repo has (an mmproj not taken) and what changed.
      await updates.check(job.repo as string, { fresh: false });
    },
    repoFolders: (repo) => models.repoFolders(repo),
    knownSha: (file, sizeBytes, mtimeMs) => models.hashCache.get(file, sizeBytes, mtimeMs),
    signal: ctx.shutdown,
    ...(opts.statfs ? { statfs: opts.statfs } : {}),
  });
  return {
    models,
    downloads,
    updates,
    routes: [createModelsRoutes(models), createDownloadsRoutes(downloads), createUpdatesRoutes(updates)],
    init: async () => {
      await downloads.init();
      void updates.runInBackground(ctx.shutdown);
    },
  };
}
