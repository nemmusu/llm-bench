import { customUpdateTarget, updateEventKind } from '../../../contract/engine-updates';
import { AppError, toAppErrorData, type AppErrorData } from '../../../contract/errors';
import type { ServerEvent } from '../../../contract/events';
import type { RouteModule } from '../../server/app';
import type { EngineUpdates, UpdateProgress } from './service';

export interface EngineUpdateRoutesDeps {
  updates: Pick<EngineUpdates, 'check' | 'update' | 'labelOf'>;
  publish(e: ServerEvent): void;
  /** A benchmark or a server is running: the engine must not change under it. */
  busy?: () => boolean;
  /** Core shutdown: aborts the updates still running. */
  shutdown?: AbortSignal;
}

type InstallEvent = Extract<ServerEvent, { type: 'engine.install' }>;

/**
 *   GET  /api/engines/:kind/update?fetch=1       -> EngineUpdateCheck (vllm-docker, sglang-docker, vllm-native, sglang-native)
 *   POST /api/engines/:kind/update               -> { ok: true }; progress as 'engine.install' events of kind `update:<kind>`
 *   GET  /api/engines/custom/:id/update?fetch=1  -> EngineUpdateCheck of a custom engine
 *   POST /api/engines/custom/:id/update          -> { ok: true }; events of kind `update:custom:<id>`
 * `fetch=1` asks the remote again (Docker Hub, PyPI without their cache; `git fetch`). The last event
 * of an update is stage 'done' (with `result.version`) or 'error'.
 */
export function createEngineUpdateRoutes(d: EngineUpdateRoutesDeps): RouteModule {
  const running = new Set<string>();

  const run = async (target: string, label: string): Promise<void> => {
    const ac = new AbortController();
    const onShutdown = () => ac.abort();
    d.shutdown?.addEventListener('abort', onShutdown, { once: true });
    const emit = (p: UpdateProgress, extra: Partial<InstallEvent> = {}) => {
      const ev: InstallEvent = { type: 'engine.install', kind: updateEventKind(target), label, stage: p.stage, bytesDone: p.bytesDone, ...extra };
      if (p.bytesTotal !== undefined) ev.bytesTotal = p.bytesTotal;
      if (p.step !== undefined) ev.step = p.step;
      if (p.steps !== undefined) ev.steps = p.steps;
      d.publish(ev);
    };
    try {
      emit({ stage: 'resolve', bytesDone: 0 });
      const out = await d.updates.update(target, (p) => emit(p), ac.signal);
      emit({ stage: 'done', bytesDone: 0 }, out.version !== undefined ? { result: { version: out.version } } : {});
    } catch (e) {
      const error: AppErrorData = toAppErrorData(e);
      emit({ stage: 'error', bytesDone: 0 }, { error });
    } finally {
      d.shutdown?.removeEventListener('abort', onShutdown);
      running.delete(target);
    }
  };

  const start = async (target: string) => {
    if (running.has(target)) throw new AppError('VALIDATION', `An update of ${target} is already running`, { params: { reason: 'busy' } });
    if (d.busy?.()) throw new AppError('ENGINE_UPDATE_FAILED', 'A benchmark or a server is using the engines', { params: { reason: 'busy' } });
    const label = await d.updates.labelOf(target);
    running.add(target);
    void run(target, label);
  };

  return (app) => {
    app.get('/api/engines/custom/:id/update', async (c) => c.json(await d.updates.check(customUpdateTarget(c.req.param('id')), { fetch: c.req.query('fetch') === '1' })));
    app.post('/api/engines/custom/:id/update', async (c) => {
      await start(customUpdateTarget(c.req.param('id')));
      return c.json({ ok: true as const });
    });
    app.get('/api/engines/:kind/update', async (c) => c.json(await d.updates.check(c.req.param('kind'), { fetch: c.req.query('fetch') === '1' })));
    app.post('/api/engines/:kind/update', async (c) => {
      await start(c.req.param('kind'));
      return c.json({ ok: true as const });
    });
  };
}
