import { installEngineRequestSchema, type InstallEngineRequest, type LlamaRelease } from '../../contract/api';
import type { EngineConfig, EngineKind } from '../../contract/engines';
import { AppError, toAppErrorData, type AppErrorData } from '../../contract/errors';
import type { ServerEvent } from '../../contract/events';
import type { RouteModule } from '../server/app';
import { parseBody } from '../server/http-error';
import type { InstalledBuild } from './llamacpp-native/install';
import type { EngineRegistry } from './registry';
import type { InstallPlan, ProgressSink } from './types';

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
  /** Saved per-kind configuration (custom executable, endpoint URL…) used for detection. */
  configs?(): Promise<Partial<Record<EngineKind, EngineConfig>>>;
  /** Core shutdown: aborts a running install. */
  shutdown?: AbortSignal;
}

type InstallEvent = Extract<ServerEvent, { type: 'engine.install' }> & {
  /** Present on stage "error" (the contract event has no error field yet). */
  error?: AppErrorData;
};

/**
 *   GET    /api/engines                         -> EngineStatus[]
 *   GET    /api/engines/llamacpp/releases       -> LlamaRelease[]
 *   POST   /api/engines/:kind/install           (InstallEngineRequest) -> { ok: true }; progress as 'engine.install' events
 *   GET    /api/engines/llamacpp/installed      -> InstalledBuild[]
 *   DELETE /api/engines/llamacpp/installed/:id  -> { ok: true }
 */
export function createEnginesRoutes(svc: EnginesRouteDeps): RouteModule {
  let running: Promise<void> | undefined;

  const runInstall = async (kind: string, req: InstallEngineRequest): Promise<void> => {
    const ac = new AbortController();
    const onShutdown = () => ac.abort();
    svc.shutdown?.addEventListener('abort', onShutdown, { once: true });
    const emit = (stage: string, bytesDone: number, bytesTotal?: number, error?: AppErrorData) => {
      const ev: InstallEvent = { type: 'engine.install', kind, stage, bytesDone };
      if (bytesTotal !== undefined) ev.bytesTotal = bytesTotal;
      if (error) ev.error = error;
      svc.publish(ev);
    };
    try {
      emit('resolve', 0);
      const plan = await svc.llama.planInstall(req, ac.signal);
      await svc.llama.installBuild(plan, (p) => emit(p.stage, p.bytesDone, p.bytesTotal), ac.signal);
    } catch (e) {
      emit('error', 0, undefined, toAppErrorData(e));
    } finally {
      svc.shutdown?.removeEventListener('abort', onShutdown);
    }
  };

  return (app) => {
    app.get('/api/engines', async (c) => c.json(await svc.registry.detectAll(svc.configs ? await svc.configs() : {})));

    app.get('/api/engines/llamacpp/releases', async (c) => c.json(await svc.llama.releases()));

    app.post('/api/engines/:kind/install', async (c) => {
      const kind = c.req.param('kind');
      if (kind !== 'llamacpp-native') {
        throw new AppError('VALIDATION', `Engine ${kind} cannot be installed from the app`, { params: { kind } });
      }
      const req = await parseBody(c, installEngineRequestSchema);
      if (running) throw new AppError('VALIDATION', 'An engine install is already running', { params: { reason: 'busy' } });
      running = runInstall(kind, req).finally(() => {
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
