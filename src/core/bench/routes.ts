import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { startRunRequestSchema } from '../../contract/api';
import type { RouteModule } from '../server/app';
import { parseBody } from '../server/http-error';
import type { RunsRepo } from '../store/runs-repo';
import type { BenchService } from './service';

const exportRequestSchema = z.object({ ids: z.array(z.string()).min(1) });

function notFound(c: Context, id: string): Response {
  return c.json({ error: { code: 'VALIDATION', message: 'Run not found', params: { id, reason: 'not_found' } } }, 404);
}

/**
 * Benchmark routes (see contract/api.ts):
 *
 *   GET    /api/runs?model=&gpu=             RunSummary[] (model = weak key or sha256, gpu = uuid or name)
 *   GET    /api/runs/tried?weakKey=&sha256=  RunSummary[] for a model, this PC + GPU first
 *   GET    /api/runs/active                  { active: { runId, phase, progress } | null }
 *   GET    /api/runs/:id                     RunResult
 *   DELETE /api/runs/:id                     { ok: true }
 *   POST   /api/runs                         StartRunRequest → { runId }
 *   POST   /api/runs/plan                    StartRunRequest → RunPlan
 *   POST   /api/runs/:id/cancel              { ok: true }
 *   POST   /api/runs/import                  export bundle → { imported, skipped }
 *   POST   /api/runs/export                  { ids } → export bundle
 *
 * Static paths are registered before `/:id` so they are never taken for an id.
 */
export function createBenchRoutes(svc: BenchService, runs: RunsRepo): RouteModule {
  return (app: Hono, ctx) => {
    app.get('/api/runs', async (c) => {
      const model = c.req.query('model');
      const gpu = c.req.query('gpu');
      const list = (await runs.list()).filter(
        (r) =>
          (!model || r.modelWeakKey === model || r.modelSha256 === model) &&
          (!gpu || r.gpuUuid === gpu || r.gpuName === gpu),
      );
      return c.json(list);
    });

    app.get('/api/runs/tried', async (c) => {
      const weakKey = c.req.query('weakKey');
      const sha256 = c.req.query('sha256');
      if (!weakKey) return c.json({ error: { code: 'VALIDATION', message: 'weakKey is required' } }, 400);
      return c.json(await runs.tried({ weakKey, ...(sha256 ? { sha256 } : {}) }, await svc.here()));
    });

    app.get('/api/runs/active', (c) => c.json({ active: svc.active() ?? null }));

    app.post('/api/runs/plan', async (c) => c.json(await svc.plan(await parseBody(c, startRunRequestSchema))));

    app.post('/api/runs/import', async (c) => {
      const result = await runs.importBundle(await parseBody(c, z.unknown()));
      if (result.imported > 0) ctx.hub.publish({ type: 'runs.changed' });
      return c.json(result);
    });

    app.post('/api/runs/export', async (c) => {
      const { ids } = await parseBody(c, exportRequestSchema);
      return c.json(await runs.exportRuns(ids));
    });

    app.post('/api/runs', async (c) => c.json(await svc.start(await parseBody(c, startRunRequestSchema))));

    app.get('/api/runs/:id', async (c) => {
      const id = c.req.param('id');
      const run = await runs.get(id);
      return run ? c.json(run) : notFound(c, id);
    });

    app.delete('/api/runs/:id', async (c) => {
      const id = c.req.param('id');
      if (!(await runs.delete(id))) return notFound(c, id);
      ctx.hub.publish({ type: 'runs.changed' });
      return c.json({ ok: true as const });
    });

    app.post('/api/runs/:id/cancel', (c) => {
      const id = c.req.param('id');
      return svc.cancel(id) ? c.json({ ok: true as const }) : notFound(c, id);
    });
  };
}
