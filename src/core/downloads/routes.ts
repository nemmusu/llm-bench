import { downloadRequestSchema } from '../../contract/api';
import type { RouteModule } from '../server/app';
import { parseBody } from '../server/http-error';
import type { DownloadService } from './service';

/**
 *   GET  /api/downloads                    -> DownloadJob[]
 *   POST /api/downloads                    (DownloadRequest; files ["*"] = whole repo for vLLM) -> DownloadJob
 *   POST /api/downloads/:id/pause|resume|cancel -> DownloadJob
 */
export function createDownloadsRoutes(svc: DownloadService): RouteModule {
  return (app) => {
    app.get('/api/downloads', (c) => c.json(svc.list()));
    app.post('/api/downloads', async (c) => c.json(await svc.add(await parseBody(c, downloadRequestSchema))));
    app.post('/api/downloads/:id/pause', async (c) => c.json(await svc.pause(c.req.param('id'))));
    app.post('/api/downloads/:id/resume', async (c) => c.json(await svc.resume(c.req.param('id'))));
    app.post('/api/downloads/:id/cancel', async (c) => c.json(await svc.cancel(c.req.param('id'))));
  };
}
