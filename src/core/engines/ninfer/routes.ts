/**
 * NInfer's own routes (contract/ninfer.ts): WSL distros, "Indica dove si trova", the guided build.
 *
 *   GET  /api/engines/ninfer/distros     -> NinferDistros
 *   POST /api/engines/ninfer/check       (EngineConfig of a NInfer kind) -> EngineStatus
 *   POST /api/engines/ninfer/build-plan  (NinferBuildRequest) -> NinferBuildPlan
 *   POST /api/engines/ninfer/build       (NinferBuildStart) -> { ok: true }; 'engine.install' events, the
 *        last one 'done' (result.ninferPath, saved as the build of that kind) or 'error'.
 *   POST /api/engines/ninfer/update-check (NinferUpdateRequest) -> NinferUpdateStatus
 *   POST /api/engines/ninfer/update      (NinferUpdateStart) -> { ok: true }; 'engine.install' events, the
 *        last one 'done' (result.ninferPath, result.commit) or 'error'.
 */
import { engineConfigSchema, type EngineConfig, type EngineStatus } from '../../../contract/engines';
import { AppError, toAppErrorData } from '../../../contract/errors';
import type { ServerEvent } from '../../../contract/events';
import {
  isNinferKind,
  ninferBuildRequestSchema,
  ninferBuildStartSchema,
  ninferUpdateRequestSchema,
  ninferUpdateStartSchema,
  type NinferBuildPlan,
  type NinferBuildRequest,
  type NinferDistros,
  type NinferKind,
  type NinferSettings,
  type NinferUpdateStatus,
} from '../../../contract/ninfer';
import type { RouteModule } from '../../server/app';
import { parseBody } from '../../server/http-error';
import type { ProgressSink } from '../types';

export interface NinferRouteDeps {
  distros(): Promise<NinferDistros>;
  check(kind: NinferKind, cfg: EngineConfig): Promise<EngineStatus>;
  builder(kind: NinferKind): { plan(req: NinferBuildRequest): Promise<NinferBuildPlan>; build(req: NinferBuildRequest, progress: ProgressSink, signal: AbortSignal): Promise<string> };
  /** settings.ninfer, updated after a successful build. */
  saveBuild(kind: NinferKind, where: { path: string; distro?: string }): Promise<void>;
  /** "Controlla aggiornamenti" / "Aggiorna" of the saved build of a kind. */
  updater(kind: NinferKind): {
    status(): Promise<NinferUpdateStatus>;
    update(progress: ProgressSink, signal: AbortSignal): Promise<{ serve: string; commit?: string }>;
  };
  /** After an update: the build is checked again (its commit changed). */
  updated(kind: NinferKind): void;
  publish(e: ServerEvent): void;
  shutdown?: AbortSignal;
}

type InstallEvent = Extract<ServerEvent, { type: 'engine.install' }>;

/** settings.ninfer with the build of `kind` set (the other kind's is kept). */
export function withBuild(saved: NinferSettings | undefined, kind: NinferKind, where: { path: string; distro?: string }): NinferSettings {
  const out: NinferSettings = { ...saved };
  if (kind === 'ninfer-wsl') out.wsl = { distro: where.distro as string, path: where.path };
  else out.native = { path: where.path };
  return out;
}

export function createNinferRoutes(d: NinferRouteDeps): RouteModule {
  // One build or update at a time (they share the checkout and the CPU).
  let building: Promise<void> | undefined;

  /** A build or an update in the background, as 'engine.install' events of its kind. */
  const job = (kind: NinferKind, work: (emit: ProgressSink, signal: AbortSignal) => Promise<Record<string, string>>): void => {
    if (building) throw new AppError('VALIDATION', 'A build is already running', { params: { reason: 'busy' } });
    const run = async () => {
      const ac = new AbortController();
      const onShutdown = () => ac.abort();
      d.shutdown?.addEventListener('abort', onShutdown, { once: true });
      // Build progress is steps (ninja's "[12/345]", git's percent), not bytes.
      const emit = (p: { stage: string; bytesDone: number; bytesTotal?: number }, extra: Partial<InstallEvent> = {}) =>
        d.publish({ type: 'engine.install', kind, stage: p.stage, bytesDone: p.bytesDone, ...(p.bytesTotal !== undefined ? { step: p.bytesDone, steps: p.bytesTotal } : {}), ...extra });
      try {
        emit({ stage: 'resolve', bytesDone: 0 });
        const result = await work(emit, ac.signal);
        emit({ stage: 'done', bytesDone: 0 }, { result });
      } catch (e) {
        emit({ stage: 'error', bytesDone: 0 }, { error: toAppErrorData(e) });
      } finally {
        d.shutdown?.removeEventListener('abort', onShutdown);
      }
    };
    building = run().finally(() => {
      building = undefined;
    });
  };

  const build = (req: NinferBuildRequest) =>
    job(req.kind, async (emit, signal) => {
      const serve = await d.builder(req.kind).build(req, emit, signal);
      await d.saveBuild(req.kind, { path: serve, ...(req.distro ? { distro: req.distro } : {}) });
      return { ninferPath: serve, ...(req.distro ? { distro: req.distro } : {}) };
    });

  const update = (kind: NinferKind) =>
    job(kind, async (emit, signal) => {
      const done = await d.updater(kind).update(emit, signal);
      d.updated(kind);
      return { ninferPath: done.serve, ...(done.commit ? { commit: done.commit } : {}) };
    });

  return (app) => {
    app.get('/api/engines/ninfer/distros', async (c) => c.json(await d.distros()));

    app.post('/api/engines/ninfer/check', async (c) => {
      const cfg = await parseBody(c, engineConfigSchema);
      if (!isNinferKind(cfg.kind)) throw new AppError('VALIDATION', 'Not a NInfer engine', { params: { reason: 'ninfer_kind', kind: cfg.kind } });
      return c.json(await d.check(cfg.kind, cfg));
    });

    app.post('/api/engines/ninfer/build-plan', async (c) => {
      const req = await parseBody(c, ninferBuildRequestSchema);
      return c.json(await d.builder(req.kind).plan(req));
    });

    app.post('/api/engines/ninfer/build', async (c) => {
      const { confirm: _confirm, ...req } = await parseBody(c, ninferBuildStartSchema);
      build(req);
      return c.json({ ok: true as const });
    });

    app.post('/api/engines/ninfer/update-check', async (c) => {
      const req = await parseBody(c, ninferUpdateRequestSchema);
      return c.json(await d.updater(req.kind).status());
    });

    app.post('/api/engines/ninfer/update', async (c) => {
      const req = await parseBody(c, ninferUpdateStartSchema);
      update(req.kind);
      return c.json({ ok: true as const });
    });
  };
}
