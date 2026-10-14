/**
 * NInfer's own routes (contract/ninfer.ts): WSL distros, its two builds, "Indica dove si trova", the
 * guided build. Its "Aggiorna" is the engines' own (GET/POST /api/engines/ninfer-native|ninfer-wsl/update,
 * NInfer-all's /api/engines/custom/<id>/update; core/engines/updates).
 *
 *   GET  /api/engines/ninfer/distros         -> NinferDistros
 *   GET  /api/engines/ninfer/builds?fresh=1  -> NinferBuilds (the official build and NInfer-all, each with its state)
 *   PUT  /api/engines/ninfer/builds/:build   (NinferBuildPath) -> NinferBuildPathResult ("Cambia cartella")
 *   POST /api/engines/ninfer/check           (EngineConfig of a NInfer kind) -> EngineStatus
 *   POST /api/engines/ninfer/build-plan      (NinferBuildRequest) -> NinferBuildPlan
 *   POST /api/engines/ninfer/build           (NinferBuildStart) -> { ok: true }; 'engine.install' events, the
 *        last one 'done' (result.ninferPath, saved as the build of that kind, or as the variant's custom
 *        engine: result.customEngineId) or 'error'.
 *   POST /api/engines/ninfer/build/cancel    -> { ok: true, cancelled }: the build running is stopped inside
 *        the distro (its own session), then reported as 'error' CANCELLED.
 *   GET  /api/engines/ninfer/builds/:build/remove -> NinferRemovePlan (delete, forget, or by hand)
 *   POST /api/engines/ninfer/builds/:build/remove -> { ok: true } (ENGINE_IN_USE while a test, a server or a build runs)
 */
import { customEngineIdFor, customEngineSchema, customEngineTemplate, type CustomEngine, type GitSource } from '../../../contract/custom-engines';
import { engineConfigSchema, type EngineConfig, type EngineStatus } from '../../../contract/engines';
import { AppError, toAppErrorData } from '../../../contract/errors';
import type { ServerEvent } from '../../../contract/events';
import {
  isNinferKind,
  NINFER_ALL_NAME,
  ninferBuildEventKind,
  ninferBuildIdSchema,
  ninferBuildPathSchema,
  ninferBuildRequestSchema,
  ninferBuildStartSchema,
  type NinferBuildId,
  type NinferBuildPath,
  type NinferBuildPathResult,
  type NinferBuildPlan,
  type NinferBuildRequest,
  type NinferBuilds,
  type NinferDistros,
  type NinferKind,
  type NinferRemovePlan,
  type NinferSettings,
  type NinferVariantTarget,
} from '../../../contract/ninfer';
import type { RouteModule } from '../../server/app';
import { parseBody } from '../../server/http-error';
import type { ProgressSink } from '../types';

export interface NinferRouteDeps {
  distros(): Promise<NinferDistros>;
  check(kind: NinferKind, cfg: EngineConfig): Promise<EngineStatus>;
  builder(kind: NinferKind): { plan(req: NinferBuildRequest): Promise<NinferBuildPlan>; build(req: NinferBuildRequest, progress: ProgressSink, signal: AbortSignal): Promise<string> };
  /** A request of one of NInfer's own builds with its repository, folder and saved engine filled in (NInfer-all's). */
  normalize(req: NinferBuildRequest): Promise<NinferBuildRequest>;
  /**
   * After a successful build: settings.ninfer for the official NInfer; for a variant (req.variant), its
   * custom engine (created or updated), whose id it resolves with.
   */
  saveBuild(kind: NinferKind, where: { path: string; distro?: string }, req: NinferBuildRequest): Promise<string | undefined>;
  /** Both builds of this PC's NInfer, each with its state (`fresh`: asked again, not the cached probe). */
  builds(fresh: boolean): Promise<NinferBuilds>;
  /** "Cambia cartella": a build of the user's own, saved when it answers. */
  setBuildPath(build: NinferBuildId, body: NinferBuildPath): Promise<NinferBuildPathResult>;
  /** What removing a build does: its folder deleted (LLM Bench built it), forgotten (the user's), or by hand. */
  removePlan(build: NinferBuildId): Promise<NinferRemovePlan>;
  /** Removes it as its plan says ('manual' is refused). */
  remove(build: NinferBuildId): Promise<void>;
  /** A benchmark or a server runs: nothing is removed under it. */
  busy?: () => boolean;
  /** Shared with the update: a build is running (one compile of NInfer at a time), and how to stop it. */
  jobs: { building: boolean; cancel?: (() => void) | undefined };
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

/**
 * settings.customEngines with the variant a build made: the engine `variant.id` (else the one made from
 * `variant.template`) gets the new ninfer-serve, distro and source, the rest of it kept; with neither, a
 * new engine named `variant.name` (with the template's rules, when it came from one). Returns its id.
 */
export function withVariantBuild(
  engines: readonly CustomEngine[],
  variant: NinferVariantTarget,
  where: { path: string; distro?: string },
  source: GitSource | undefined,
): { engines: CustomEngine[]; id: string } {
  const run = { mode: 'ninfer' as const, path: where.path, ...(where.distro ? { distro: where.distro } : {}), ...(source ? { source } : {}) };
  const existing = engines.find((e) => e.id === variant.id) ?? engines.find((e) => e.base === 'ninfer' && variant.template !== undefined && e.template === variant.template);
  if (existing) {
    const updated = customEngineSchema.parse({ ...existing, run });
    return { engines: engines.map((e) => (e.id === existing.id ? updated : e)), id: existing.id };
  }
  const tpl = customEngineTemplate(variant.template);
  const id = customEngineIdFor(variant.name, engines.map((e) => e.id));
  const engine = customEngineSchema.parse({ id, name: variant.name, base: 'ninfer', run, ...(tpl ? { match: tpl.match, template: tpl.id } : {}) });
  return { engines: [...engines, engine], id };
}

/** The :build of a route, or VALIDATION. */
function buildOf(param: string): NinferBuildId {
  const id = ninferBuildIdSchema.safeParse(param);
  if (!id.success) throw new AppError('VALIDATION', 'Not a build of NInfer', { params: { reason: 'ninfer_build_id', build: param } });
  return id.data;
}

export function createNinferRoutes(d: NinferRouteDeps): RouteModule {
  /** The guided build in the background, as 'engine.install' events of its kind. */
  const build = (asked: NinferBuildRequest): void => {
    if (d.jobs.building) throw new AppError('VALIDATION', 'A build is already running', { params: { reason: 'busy' } });
    d.jobs.building = true;
    const ac = new AbortController();
    d.jobs.cancel = () => ac.abort();
    void (async () => {
      const onShutdown = () => ac.abort();
      d.shutdown?.addEventListener('abort', onShutdown, { once: true });
      // Build progress is steps (ninja's "[12/345]", git's percent), not bytes. NInfer-all and other variants have their own kind.
      const kind = ninferBuildEventKind(asked);
      let label: string | undefined = asked.variant?.name;
      const emit = (p: { stage: string; bytesDone: number; bytesTotal?: number; etaSec?: number }, extra: Partial<InstallEvent> = {}) =>
        d.publish({
          type: 'engine.install',
          kind,
          stage: p.stage,
          bytesDone: p.bytesDone,
          ...(p.bytesTotal !== undefined ? { step: p.bytesDone, steps: p.bytesTotal, etaSec: p.etaSec } : {}),
          ...(label ? { label } : {}),
          ...extra,
        });
      try {
        emit({ stage: 'resolve', bytesDone: 0 });
        const req = await d.normalize(asked);
        label = req.variant?.name;
        const serve = await d.builder(req.kind).build(req, emit, ac.signal);
        const id = await d.saveBuild(req.kind, { path: serve, ...(req.distro ? { distro: req.distro } : {}) }, req);
        emit({ stage: 'done', bytesDone: 0 }, { result: { ninferPath: serve, ...(req.distro ? { distro: req.distro } : {}), ...(id ? { customEngineId: id } : {}) } });
      } catch (e) {
        emit({ stage: 'error', bytesDone: 0 }, { error: toAppErrorData(e) });
      } finally {
        d.shutdown?.removeEventListener('abort', onShutdown);
        d.jobs.building = false;
        d.jobs.cancel = undefined;
      }
    })();
  };

  return (app) => {
    app.get('/api/engines/ninfer/distros', async (c) => c.json(await d.distros()));

    app.get('/api/engines/ninfer/builds', async (c) => c.json(await d.builds(c.req.query('fresh') === '1')));

    app.put('/api/engines/ninfer/builds/:build', async (c) => c.json(await d.setBuildPath(buildOf(c.req.param('build')), await parseBody(c, ninferBuildPathSchema))));

    app.get('/api/engines/ninfer/builds/:build/remove', async (c) => c.json(await d.removePlan(buildOf(c.req.param('build')))));

    app.post('/api/engines/ninfer/builds/:build/remove', async (c) => {
      const build = buildOf(c.req.param('build'));
      if (d.jobs.building || d.busy?.()) throw new AppError('ENGINE_IN_USE', 'NInfer is in use', { params: { engine: build === 'all' ? NINFER_ALL_NAME : 'NInfer' } });
      await d.remove(build);
      return c.json({ ok: true as const });
    });

    app.post('/api/engines/ninfer/check', async (c) => {
      const cfg = await parseBody(c, engineConfigSchema);
      if (!isNinferKind(cfg.kind)) throw new AppError('VALIDATION', 'Not a NInfer engine', { params: { reason: 'ninfer_kind', kind: cfg.kind } });
      return c.json(await d.check(cfg.kind, cfg));
    });

    app.post('/api/engines/ninfer/build-plan', async (c) => {
      const req = await parseBody(c, ninferBuildRequestSchema);
      return c.json(await d.builder(req.kind).plan(await d.normalize(req)));
    });

    app.post('/api/engines/ninfer/build', async (c) => {
      const { confirm: _confirm, ...req } = await parseBody(c, ninferBuildStartSchema);
      build(req);
      return c.json({ ok: true as const });
    });

    app.post('/api/engines/ninfer/build/cancel', (c) => {
      const cancel = d.jobs.cancel;
      cancel?.();
      return c.json({ ok: true as const, cancelled: cancel !== undefined });
    });
  };
}
