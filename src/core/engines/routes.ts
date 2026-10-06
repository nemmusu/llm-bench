import { installEngineRequestSchema, type InstallEngineRequest, type LlamaRelease } from '../../contract/api';
import { engineKindSchema, type EngineConfig, type EngineKind } from '../../contract/engines';
import { AppError, toAppErrorData, type AppErrorData } from '../../contract/errors';
import type { ServerEvent } from '../../contract/events';
import type { RouteModule } from '../server/app';
import { parseBody } from '../server/http-error';
import type { InstalledBuild } from './llamacpp-native/install';
import type { EngineRegistry } from './registry';
import type { EngineAdapter, InstallPlan, ProgressSink } from './types';

/** The parts of LlamaNativeAdapter the routes need (kept narrow so tests can fake it). */
export interface LlamaInstallService {
  releases(signal?: AbortSignal): Promise<LlamaRelease[]>;
  planInstall(req: InstallEngineRequest, signal?: AbortSignal): Promise<InstallPlan>;
  installBuild(plan: InstallPlan, progress: ProgressSink, signal: AbortSignal): Promise<InstalledBuild>;
  listInstalled(): Promise<InstalledBuild[]>;
  removeBuild(id: string): Promise<void>;
}

export interface EnginesRouteDeps {
  registry: EngineRegistry;
  llama: LlamaInstallService;
  /** EventHub.publish of the core. */
  publish(e: ServerEvent): void;
  /** Saved per-kind configuration (custom executable, endpoint URL, Docker image…) used for detection and installs. */
  configs?(): Promise<Partial<Record<EngineKind, EngineConfig>>>;
  /** Core shutdown: aborts a running install. */
  shutdown?: AbortSignal;
}

type InstallEvent = Extract<ServerEvent, { type: 'engine.install' }>;
type Installer = Required<Pick<EngineAdapter, 'installPlan' | 'install'>>;

/** An adapter that can install itself from the app (llama.cpp release, Docker image pull, vLLM via uv). */
function installerOf(a: EngineAdapter | undefined): Installer | undefined {
  return a?.installPlan && a.install ? (a as EngineAdapter & Installer) : undefined;
}

/**
 *   GET    /api/engines                         -> EngineStatus[]
 *   GET    /api/engines/llamacpp/releases       -> LlamaRelease[]
 *   POST   /api/engines/:kind/install           (InstallEngineRequest) -> { ok: true }; progress as 'engine.install' events
 *            llamacpp-native: release build (build/variant); llamacpp-docker / vllm-docker: image pull (image, else the
 *            saved or recommended one); vllm-native: uv venv (Linux). The last event is stage 'done', or 'error' with `error`.
 *   GET    /api/engines/llamacpp/installed      -> InstalledBuild[]
 *   DELETE /api/engines/llamacpp/installed/:id  -> { ok: true }
 */
export function createEnginesRoutes(svc: EnginesRouteDeps): RouteModule {
  let running: Promise<void> | undefined;

  const runInstall = async (kind: EngineKind, req: InstallEngineRequest, installer: Installer | undefined): Promise<void> => {
    const ac = new AbortController();
    const onShutdown = () => ac.abort();
    svc.shutdown?.addEventListener('abort', onShutdown, { once: true });
    let image: string | undefined;
    let last: { stage: string; bytesDone: number; bytesTotal?: number } = { stage: 'resolve', bytesDone: 0 };
    const emit = (p: { stage: string; bytesDone: number; bytesTotal?: number }, error?: AppErrorData) => {
      last = p;
      const ev: InstallEvent = { type: 'engine.install', kind, stage: p.stage, bytesDone: p.bytesDone };
      if (p.bytesTotal !== undefined) ev.bytesTotal = p.bytesTotal;
      if (image !== undefined) ev.image = image;
      if (error) ev.error = error;
      svc.publish(ev);
    };
    try {
      emit({ stage: 'resolve', bytesDone: 0 });
      if (installer) {
        const cfg: EngineConfig = { ...(svc.configs ? (await svc.configs())[kind] : undefined), kind, ...(req.image ? { image: req.image } : {}) };
        const plan = await installer.installPlan(cfg);
        if (typeof plan.data.image === 'string') image = plan.data.image;
        await installer.install(plan, emit, ac.signal);
      } else {
        const plan = await svc.llama.planInstall(req, ac.signal);
        await svc.llama.installBuild(plan, emit, ac.signal);
      }
      // Every install ends with a 'done' event, also when the installer did not send one.
      if (last.stage !== 'done') emit({ ...last, stage: 'done' });
    } catch (e) {
      emit({ stage: 'error', bytesDone: 0 }, toAppErrorData(e));
    } finally {
      svc.shutdown?.removeEventListener('abort', onShutdown);
    }
  };

  return (app) => {
    app.get('/api/engines', async (c) => c.json(await svc.registry.detectAll(svc.configs ? await svc.configs() : {})));

    app.get('/api/engines/llamacpp/releases', async (c) => c.json(await svc.llama.releases()));

    app.post('/api/engines/:kind/install', async (c) => {
      const param = c.req.param('kind');
      const kind = engineKindSchema.safeParse(param);
      // llama.cpp native installs through its release service (build/variant choice); the others through their adapter.
      const installer = kind.success && kind.data !== 'llamacpp-native' ? installerOf(svc.registry.get(kind.data)) : undefined;
      if (!kind.success || (kind.data !== 'llamacpp-native' && !installer)) {
        throw new AppError('VALIDATION', `Engine ${param} cannot be installed from the app`, { params: { kind: param } });
      }
      const req = await parseBody(c, installEngineRequestSchema);
      if (running) throw new AppError('VALIDATION', 'An engine install is already running', { params: { reason: 'busy' } });
      running = runInstall(kind.data, req, installer).finally(() => {
        running = undefined;
      });
      return c.json({ ok: true as const });
    });

    app.get('/api/engines/llamacpp/installed', async (c) => c.json(await svc.llama.listInstalled()));

    app.delete('/api/engines/llamacpp/installed/:id', async (c) => {
      await svc.llama.removeBuild(c.req.param('id'));
      return c.json({ ok: true as const });
    });
  };
}
