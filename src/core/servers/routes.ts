import { z } from 'zod';
import { startServerRequestSchema } from '../../contract/api';
import type { RouteModule } from '../server/app';
import { parseBody } from '../server/http-error';
import type { ServerKeys } from './api-key';
import type { ServerNotices } from './notices';
import type { ServerPresets } from './presets';
import type { ServeService } from './service';

export interface ServerRoutesDeps {
  serve: ServeService;
  presets: ServerPresets;
  keys: ServerKeys;
  notices: ServerNotices;
  /** A preset was saved, changed or removed (the UI and the tray read them again). */
  changed: () => void;
}

const ok = { ok: true as const };

/**
 *   GET    /api/servers                     -> ServerInfo[]
 *   POST   /api/servers/plan                (StartServerRequest) -> ServerPlan (command, needs, context, port)
 *   POST   /api/servers                     (StartServerRequest) -> ServerInfo, once the engine is ready
 *   DELETE /api/servers/:id                 -> { ok: true }
 *   POST   /api/servers/:id/restart         -> ServerInfo, once it is ready again
 *   GET    /api/servers/:id/log             -> ServerLog
 *   GET    /api/servers/presets             -> ServerPreset[]
 *   POST   /api/servers/presets             (ServerPresetInput) -> ServerPreset
 *   PUT    /api/servers/presets/:id         (Partial<ServerPresetInput>) -> ServerPreset
 *   DELETE /api/servers/presets/:id         -> { ok: true }
 *   POST   /api/servers/presets/:id/start   -> ServerInfo, once the engine is ready
 *   GET    /api/servers/api-key             -> ServerApiKeyInfo
 *   POST   /api/servers/api-key/regenerate  -> ServerApiKeyInfo
 *   GET    /api/servers/notices             -> ServerNotice[]
 *   DELETE /api/servers/notices/:id         -> { ok: true }
 */
export function createServerRoutes(d: ServerRoutesDeps): RouteModule {
  const { serve, presets, keys, notices } = d;
  return (app, ctx) => {
    ctx.shutdown.addEventListener('abort', () => void serve.stopAll(), { once: true });
    // Fixed paths first: "presets", "api-key" and "notices" are never server ids.
    app.get('/api/servers/presets', async (c) => c.json(await presets.list()));
    app.post('/api/servers/presets', async (c) => {
      const saved = await presets.create(await parseBody(c, z.unknown()));
      d.changed();
      return c.json(saved);
    });
    app.put('/api/servers/presets/:id', async (c) => {
      const saved = await presets.update(c.req.param('id'), await parseBody(c, z.record(z.string(), z.unknown())));
      d.changed();
      return c.json(saved);
    });
    app.delete('/api/servers/presets/:id', async (c) => {
      await presets.remove(c.req.param('id'));
      d.changed();
      return c.json(ok);
    });
    app.post('/api/servers/presets/:id/start', async (c) => c.json(await serve.startPreset(c.req.param('id'), ctx.shutdown)));
    app.get('/api/servers/api-key', (c) => c.json(keys.current()));
    app.post('/api/servers/api-key/regenerate', (c) => c.json(keys.regenerate()));
    app.get('/api/servers/notices', (c) => c.json(notices.list()));
    app.delete('/api/servers/notices/:id', (c) => {
      notices.dismiss(c.req.param('id'));
      return c.json(ok);
    });

    app.get('/api/servers', (c) => c.json(serve.list()));
    app.post('/api/servers/plan', async (c) => c.json(await serve.plan(await parseBody(c, startServerRequestSchema))));
    app.post('/api/servers', async (c) => {
      const req = await parseBody(c, startServerRequestSchema);
      return c.json(await serve.start(req, ctx.shutdown));
    });
    app.delete('/api/servers/:id', async (c) => {
      await serve.stop(c.req.param('id'));
      return c.json(ok);
    });
    app.post('/api/servers/:id/restart', async (c) => c.json(await serve.restart(c.req.param('id'), ctx.shutdown)));
    app.get('/api/servers/:id/log', (c) => c.json(serve.log(c.req.param('id'))));
  };
}
