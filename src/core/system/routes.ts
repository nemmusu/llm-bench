import type { CoreContext } from '../context';
import type { RouteModule } from '../server/app';
import type { SystemService } from './service';

/**
 *   GET /api/system              -> SystemResponse
 *   GET /api/telemetry/snapshot  -> GpuSample[] (t = Clock.now() at reading; [] without NVIDIA telemetry)
 *
 * Accepts the service or a factory receiving the CoreContext, because modules.ts builds the module
 * list before createCore() has created the context.
 */
export function createSystemRoutes(svc: SystemService | ((ctx: CoreContext) => SystemService)): RouteModule {
  return (app, ctx) => {
    const s = typeof svc === 'function' ? svc(ctx) : svc;
    app.get('/api/system', async (c) => c.json(await s.system()));
    app.get('/api/telemetry/snapshot', async (c) => c.json(await s.snapshot()));
  };
}
