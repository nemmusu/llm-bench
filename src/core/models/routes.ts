import type { Context } from 'hono';
import { z } from 'zod';
import { fitRequestSchema } from '../../contract/api';
import { engineKindSchema, launchParamsSchema } from '../../contract/engines';
import { AppError } from '../../contract/errors';
import type { RouteModule } from '../server/app';
import { parseBody } from '../server/http-error';
import { REPO_RE } from './paths';
import type { ModelsService } from './service';

const flag = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const searchQuerySchema = z.object({
  q: z.string().max(200).default(''),
  format: z.enum(['gguf', 'safetensors', 'any']).default('any'),
  sort: z.enum(['downloads', 'likes', 'lastModified', 'trendingScore']).default('downloads'),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  onlyFits: flag,
});

const revisionSchema = z.string().min(1).max(200).optional();

const hubFitBodySchema = z.object({
  engine: engineKindSchema,
  revision: revisionSchema,
  params: launchParamsSchema.optional(),
});

/** "owner/name" from the route params, validated so it cannot address other hub paths. */
function repoParam(c: Context): string {
  const repo = `${c.req.param('owner')}/${c.req.param('name')}`;
  if (!REPO_RE.test(repo)) throw new AppError('VALIDATION', 'Invalid repo id', { params: { repo } });
  return repo;
}

/**
 *   GET    /api/models/local                          -> LocalModel[]
 *   POST   /api/models/rescan                         -> LocalModel[]
 *   GET    /api/models/search?q=&format=&sort=&limit=&onlyFits= -> HubModel[]
 *   GET    /api/models/curated?vramGB=                -> CuratedResponse
 *   GET    /api/models/hub/:owner/:name/files?revision= -> HubFile[]
 *   GET    /api/models/hub/:owner/:name/readme        -> { text, truncated }
 *   GET    /api/models/hub/:owner/:name/gguf-facts?file=&revision= -> { facts, fileBytes }
 *   GET    /api/models/hub/:owner/:name/related       -> HubModel[] (GGUF conversions)
 *   POST   /api/models/hub/:owner/:name/fit           ({ engine, revision?, params? }) -> HubFitResult
 *   POST   /api/models/fit                            (FitRequest) -> FitEstimate
 *   DELETE /api/models/local/:id                      -> { ok: true }
 */
export function createModelsRoutes(svc: ModelsService): RouteModule {
  return (app) => {
    app.get('/api/models/local', async (c) => c.json(await svc.list()));
    app.post('/api/models/rescan', async (c) => c.json(await svc.rescan()));
    app.get('/api/models/search', async (c) => {
      const q = searchQuerySchema.parse(c.req.query());
      return c.json(await svc.search(q.q, q));
    });
    app.get('/api/models/curated', async (c) => {
      const vram = z.coerce.number().positive().max(4096).optional().parse(c.req.query('vramGB'));
      return c.json(await svc.curated(vram));
    });
    app.get('/api/models/hub/:owner/:name/files', async (c) => {
      const revision = revisionSchema.parse(c.req.query('revision'));
      return c.json(await svc.hubFiles(repoParam(c), revision));
    });
    app.get('/api/models/hub/:owner/:name/readme', async (c) => c.json(await svc.readme(repoParam(c))));
    app.get('/api/models/hub/:owner/:name/gguf-facts', async (c) => {
      const repo = repoParam(c);
      const file = z.string().min(1).max(512).regex(/\.gguf$/i).parse(c.req.query('file'));
      return c.json(await svc.remoteGgufFacts(repo, file, revisionSchema.parse(c.req.query('revision'))));
    });
    app.get('/api/models/hub/:owner/:name/related', async (c) => c.json(await svc.related(repoParam(c))));
    app.post('/api/models/hub/:owner/:name/fit', async (c) => {
      const repo = repoParam(c);
      const body = await parseBody(c, hubFitBodySchema);
      return c.json(await svc.hubFit(repo, body.engine, { ...(body.revision ? { revision: body.revision } : {}), ...(body.params ? { params: body.params } : {}) }));
    });
    app.post('/api/models/fit', async (c) => c.json(await svc.fit(await parseBody(c, fitRequestSchema))));
    app.delete('/api/models/local/:id', async (c) => {
      await svc.deleteLocal(c.req.param('id'));
      return c.json({ ok: true as const });
    });
  };
}
