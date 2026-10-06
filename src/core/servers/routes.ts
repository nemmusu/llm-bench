import { startServerRequestSchema } from '../../contract/api';
import type { RouteModule } from '../server/app';
import { parseBody } from '../server/http-error';
import type { ServeService } from './service';

/**
 *   GET    /api/servers       -> ServerInfo[]
 *   POST   /api/servers/plan  (StartServerRequest) -> ServerPlan (command, needs, context chosen for this card)
 *   POST   /api/servers       (StartServerRequest) -> ServerInfo, once the engine is ready
 *   DELETE /api/servers/:id   -> { ok: true }
 */
export function createServerRoutes(svc: ServeService): RouteModule {
  return (app, ctx) => {
    ctx.shutdown.addEventListener('abort', () => void svc.stopAll(), { once: true });
    app.get('/api/servers', (c) => c.json(svc.list()));
    app.post('/api/servers/plan', async (c) => c.json(await svc.plan(await parseBody(c, startServerRequestSchema))));
    app.post('/api/servers', async (c) => {
      const req = await parseBody(c, startServerRequestSchema);
      return c.json(await svc.start(req, ctx.shutdown));
    });
    app.delete('/api/servers/:id', async (c) => {
      await svc.stop(c.req.param('id'));
      return c.json({ ok: true as const });
    });
  };
}
