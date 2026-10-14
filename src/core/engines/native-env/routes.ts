import type { RouteModule } from '../../server/app';
import { parseNativeEnvKind, type NativeEnvs } from './service';

/**
 *   GET    /api/engines/:kind/environment  -> NativeEnvPlan (vllm-native, sglang-native: LLM Bench's uv environment
 *            on Linux: its folder, size and files, the user's own environment if one is chosen, busy)
 *   DELETE /api/engines/:kind/environment  -> { ok: true }: deletes that folder (never the user's own environment);
 *            ENGINE_IN_USE while a benchmark, a server or an install of it runs, ENGINE_NOT_INSTALLED when it is not there
 */
export function createNativeEnvRoutes(envs: Pick<NativeEnvs, 'plan' | 'remove'>): RouteModule {
  return (app) => {
    app.get('/api/engines/:kind/environment', async (c) => c.json(await envs.plan(parseNativeEnvKind(c.req.param('kind')))));
    app.delete('/api/engines/:kind/environment', async (c) => {
      await envs.remove(parseNativeEnvKind(c.req.param('kind')));
      return c.json({ ok: true as const });
    });
  };
}
