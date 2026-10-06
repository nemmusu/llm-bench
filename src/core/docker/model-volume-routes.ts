import { z } from 'zod';
import { toAppErrorData } from '../../contract/errors';
import type { LocalModel } from '../../contract/models';
import type { ServerEvent } from '../../contract/events';
import type { RouteModule } from '../server/app';
import { parseBody } from '../server/http-error';
import type { ModelVolumes } from './model-volumes';

export interface ModelVolumeRouteDeps {
  volumes: ModelVolumes;
  getLocal(id: string): Promise<LocalModel | undefined>;
  publish(e: ServerEvent): void;
  shutdown?: AbortSignal;
}

/**
 *   GET    /api/docker/model-volumes            -> { localIds: string[] } (models copied into Docker)
 *   POST   /api/docker/model-volumes            ({ localId }) -> { ok: true }; progress as 'engine.install'
 *                                                 events { kind: 'docker-volume', stage: 'copy' | 'done' | 'error' }
 *   DELETE /api/docker/model-volumes/:localId   -> { ok: true }
 */
export function createModelVolumeRoutes(d: ModelVolumeRouteDeps): RouteModule {
  return (app) => {
    let running = false;
    app.get('/api/docker/model-volumes', async (c) => c.json({ localIds: await d.volumes.list() }));
    app.post('/api/docker/model-volumes', async (c) => {
      const { localId } = await parseBody(c, z.object({ localId: z.string().min(1) }));
      const model = await d.getLocal(localId);
      if (!model) return c.json({ error: { code: 'MODEL_NOT_FOUND', message: 'Local model not found', params: { id: localId } } }, 404);
      if (running) return c.json({ error: { code: 'VALIDATION', message: 'A copy is already running', params: { reason: 'busy' } } }, 409);
      running = true;
      const ac = new AbortController();
      d.shutdown?.addEventListener('abort', () => ac.abort(), { once: true });
      void d.volumes
        .copy(model, (p) => d.publish({ type: 'engine.install', kind: 'docker-volume', stage: 'copy', bytesDone: p.bytesDone, bytesTotal: p.bytesTotal }), ac.signal)
        .then(
          () => d.publish({ type: 'engine.install', kind: 'docker-volume', stage: 'done', bytesDone: 0, result: { localId } }),
          (e: unknown) => d.publish({ type: 'engine.install', kind: 'docker-volume', stage: 'error', bytesDone: 0, error: toAppErrorData(e) }),
        )
        .finally(() => {
          running = false;
        });
      return c.json({ ok: true as const });
    });
    app.delete('/api/docker/model-volumes/:localId', async (c) => {
      await d.volumes.remove(c.req.param('localId'));
      return c.json({ ok: true as const });
    });
  };
}
