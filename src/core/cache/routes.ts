import type { CacheEvictor } from './evictor';
import type { WindowsStandbyEvictor } from './windows-standby';
import type { RouteModule } from '../server/app';

export interface ColdCacheStatus {
  /** How cold loads are made cold on this OS. */
  method: CacheEvictor['kind'];
  /** Eviction works without any setup (Linux). */
  automatic: boolean;
  /** Windows: the opt-in elevated task exists. */
  windowsTaskInstalled?: boolean;
}

/**
 *   GET    /api/cache/cold                 -> ColdCacheStatus
 *   POST   /api/cache/windows-task         -> ColdCacheStatus (shows the UAC prompt; 409 if declined)
 *   DELETE /api/cache/windows-task         -> ColdCacheStatus (UAC prompt as well)
 * The opt-in is mirrored in settings.coldCacheOptIn.
 */
export function createCacheRoutes(svc: { evictor: CacheEvictor; windowsStandby?: WindowsStandbyEvictor }): RouteModule {
  const status = async (): Promise<ColdCacheStatus> => ({
    method: svc.evictor.kind,
    automatic: svc.evictor.kind === 'linux-fadvise',
    ...(svc.windowsStandby ? { windowsTaskInstalled: (await svc.windowsStandby.info()).installed } : {}),
  });
  return (app, ctx) => {
    app.get('/api/cache/cold', async (c) => c.json(await status()));
    app.post('/api/cache/windows-task', async (c) => {
      if (!svc.windowsStandby) return c.json({ error: { code: 'VALIDATION', message: 'Windows only', params: { reason: 'not_supported' } } }, 400);
      const ok = await svc.windowsStandby.install();
      await ctx.settings.update({ coldCacheOptIn: ok });
      if (!ok) return c.json({ error: { code: 'CANCELLED', message: 'Elevation declined or task not registered' } }, 409);
      return c.json(await status());
    });
    app.delete('/api/cache/windows-task', async (c) => {
      if (!svc.windowsStandby) return c.json({ error: { code: 'VALIDATION', message: 'Windows only', params: { reason: 'not_supported' } } }, 400);
      const ok = await svc.windowsStandby.uninstall();
      if (ok) await ctx.settings.update({ coldCacheOptIn: false });
      if (!ok) return c.json({ error: { code: 'CANCELLED', message: 'Elevation declined or task still present' } }, 409);
      return c.json(await status());
    });
  };
}
