import { z } from 'zod';
import { AppError, toAppErrorData, type AppErrorData } from '../../contract/errors';
import type { ServerEvent } from '../../contract/events';
import type { CoreContext } from '../context';
import type { RouteModule } from '../server/app';
import { parseBody } from '../server/http-error';
import type { DockerEnvironment, DockerStatusDetail, GpuCheckResult } from './environment';
import type { ImageService } from './images';
import { parseImageRef } from './image-ref';

/** The parts of VllmDockerAdapter the routes need. */
export interface VllmTagSource {
  tags(opts?: { refresh?: boolean }): Promise<unknown[]>;
}

export interface DockerRoutesDeps {
  env: DockerEnvironment;
  images: ImageService;
  vllm: VllmTagSource;
  /** EventHub.publish of the core. */
  publish(e: ServerEvent): void;
  /** Image used by gpu-check when the request names none (e.g. the configured llama.cpp image). */
  defaultGpuImage(): Promise<string>;
  /** Markers of runs in progress: their containers are never removed by cleanup. */
  activeMarkers?(): Iterable<string>;
  /** Core shutdown: aborts a running pull or Docker Desktop start. */
  shutdown?: AbortSignal;
}

/** 'engine.install' event plus the extra fields this module adds (see the contract-change note). */
type DockerEvent = Extract<ServerEvent, { type: 'engine.install' }> & {
  image?: string;
  state?: string;
  slow?: boolean;
  error?: AppErrorData;
};

const pullSchema = z.object({ image: z.string().min(1), kind: z.string().optional() });
const gpuCheckSchema = z.object({ image: z.string().min(1).optional() });

/**
 *   GET  /api/docker/status        -> DockerStatusDetail
 *   POST /api/docker/start         -> { ok: true, state } at once; progress as 'engine.install'
 *                                     events { kind: 'docker-desktop', stage: 'starting' | 'running' | 'error',
 *                                     bytesDone: elapsed ms, state, slow }. GET /status reports
 *                                     "starting" meanwhile, so polling it works too.
 *   POST /api/docker/gpu-check     ({ image? }) -> GpuCheckResult (DOCKER_NO_GPU… as an error)
 *   POST /api/docker/pull          ({ image, kind? }) -> { ok: true }; progress as 'engine.install'
 *                                     events { kind, image, stage: 'download' | 'extract' | 'done' | 'error' }
 *   POST /api/docker/cleanup       -> { removed: { id, name }[] } (label gpubench=1 only)
 *   GET  /api/engines/vllm/tags?refresh=1 -> VllmTagInfo[]
 */
export function createDockerRoutes(svc: DockerRoutesDeps | ((ctx: CoreContext) => DockerRoutesDeps)): RouteModule {
  return (app, ctx) => {
    const s = typeof svc === 'function' ? svc(ctx) : svc;
    const pulls = new Set<string>();
    let starting = false;

    const linked = () => {
      const ac = new AbortController();
      const onShutdown = () => ac.abort();
      s.shutdown?.addEventListener('abort', onShutdown, { once: true });
      return { signal: ac.signal, dispose: () => s.shutdown?.removeEventListener('abort', onShutdown) };
    };

    app.get('/api/docker/status', async (c) => c.json(await s.env.status({ fresh: c.req.query('fresh') === '1' })));

    app.post('/api/docker/start', async (c) => {
      const now: DockerStatusDetail = await s.env.status({ fresh: true });
      if (now.state === 'running' || now.state === 'no-gpu' || now.state === 'unsupported') return c.json({ ok: true as const, state: now.state });
      if (!starting) {
        starting = true;
        const l = linked();
        const emit = (e: Omit<DockerEvent, 'type' | 'kind'>) => s.publish({ type: 'engine.install', kind: 'docker-desktop', ...e } as DockerEvent);
        void s.env
          .startDesktop(l.signal, (p) => emit({ stage: 'starting', bytesDone: p.elapsedMs, state: p.state, slow: p.slow }))
          .then(
            (r) => emit({ stage: 'running', bytesDone: 0, state: r.state }),
            (e: unknown) => emit({ stage: 'error', bytesDone: 0, error: toAppErrorData(e) }),
          )
          .finally(() => {
            starting = false;
            l.dispose();
          });
      }
      return c.json({ ok: true as const, state: 'starting' as const });
    });

    app.post('/api/docker/gpu-check', async (c) => {
      const body = await parseBody(c, gpuCheckSchema);
      const image = body.image ?? (await s.defaultGpuImage());
      parseImageRef(image);
      const res: GpuCheckResult = await s.env.gpuCheck(image);
      return c.json(res);
    });

    app.post('/api/docker/pull', async (c) => {
      const body = await parseBody(c, pullSchema);
      parseImageRef(body.image);
      if (pulls.has(body.image)) {
        throw new AppError('VALIDATION', 'This image is already being pulled', { params: { reason: 'busy', image: body.image } });
      }
      pulls.add(body.image);
      const l = linked();
      const kind = body.kind ?? 'docker-image';
      const emit = (e: Omit<DockerEvent, 'type' | 'kind' | 'image'>) =>
        s.publish({ type: 'engine.install', kind, image: body.image, ...e } as DockerEvent);
      void s.images
        .pull(
          body.image,
          (p) =>
            emit({
              stage: p.status === 'done' ? 'done' : p.status === 'extracting' ? 'extract' : 'download',
              bytesDone: p.bytesDone,
              ...(p.bytesTotal > 0 ? { bytesTotal: p.bytesTotal } : {}),
            }),
          l.signal,
        )
        .catch((e: unknown) => emit({ stage: 'error', bytesDone: 0, error: toAppErrorData(e) }))
        .finally(() => {
          pulls.delete(body.image);
          l.dispose();
        });
      return c.json({ ok: true as const });
    });

    app.post('/api/docker/cleanup', async (c) => c.json(await s.env.cleanupOrphans(s.activeMarkers?.() ?? [])));

    app.get('/api/engines/vllm/tags', async (c) => c.json(await s.vllm.tags({ refresh: c.req.query('refresh') === '1' })));
  };
}
