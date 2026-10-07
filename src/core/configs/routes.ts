import { configsQuerySchema, type ConfigsResponse } from '../../contract/configs';
import type { RouteModule } from '../server/app';
import type { ConfigsIndex } from '../store/configs-index';
import type { HereIdentity } from '../store/runs-repo';

/**
 * Risultati → Configurazioni (see contract/configs.ts):
 *
 *   GET /api/configs?gpu=&model=&engine=&minContext=  ConfigsResponse
 *       gpu: a card key, or "all" (default: this PC's card, every card when it has none yet)
 *       model: a model key; engine: an engine kind; minContext: tokens
 *
 * An invalid filter is a 400 VALIDATION.
 */
export function createConfigRoutes(index: ConfigsIndex, here: () => Promise<HereIdentity>): RouteModule {
  return (app) => {
    app.get('/api/configs', async (c) => {
      const query = configsQuerySchema.parse(c.req.query());
      return c.json<ConfigsResponse>(await index.query(query, await here()));
    });
  };
}
