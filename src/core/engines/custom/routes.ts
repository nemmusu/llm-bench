/**
 * "Motori personalizzati" API (contract/custom-engines.ts): the saved engines with their check, and
 * create / update / duplicate / delete, plus "Prova" on an engine not saved yet.
 *
 * A check runs what the base would run to know a build: llama.cpp `--version` + `--help`, vLLM
 * `--version` + `serve --help`, SGLang `import sglang` + `--help` (Docker: in the image, when it is
 * there), a NInfer variant its ninfer-serve `--help` and commit (in its WSL distro on Windows). A
 * command template is only validated and its program looked up: nothing is executed.
 */
import { z } from 'zod';
import {
  customEngineConfigOf,
  customEngineDraftSchema,
  customEngineIdFor,
  customEngineKindOf,
  customEngineSchema,
  templatePlaceholders,
  type CustomEngine,
  type CustomEngineCheck,
  type CustomEngineInfo,
} from '../../../contract/custom-engines';
import { engineBaseOf } from '../../../contract/engines';
import { AppError } from '../../../contract/errors';
import type { Settings } from '../../../contract/settings';
import type { RouteModule } from '../../server/app';
import { parseBody } from '../../server/http-error';
import type { EngineRegistry } from '../registry';
import { missingStandardFlags, type FlagBase } from '../shared/standard-flags';
import type { EngineAdapter } from '../types';
import { CustomEngineAdapter, expandCustom } from './adapter';

export interface CustomEnginesDeps {
  settings: { get(): Promise<Pick<Settings, 'customEngines'>>; update(patch: Partial<Settings>): Promise<Pick<Settings, 'customEngines'>> };
  registry: EngineRegistry;
}

/** The base adapter of a kind (a registry entry may be wrapped for custom engines). */
function baseAdapter(registry: EngineRegistry, engine: CustomEngine): EngineAdapter {
  const a = registry.require(customEngineKindOf(engine));
  return a instanceof CustomEngineAdapter ? a.inner : a;
}

/** Runs, which version, which options its --help lists, which of LLM Bench's flags it lacks. */
export async function checkCustomEngine(registry: EngineRegistry, engine: CustomEngine): Promise<CustomEngineCheck> {
  const kind = customEngineKindOf(engine);
  const adapter = baseAdapter(registry, engine);
  const cfg = expandCustom(engine, { kind });
  const status = { ...(await adapter.detect(cfg)), customEngineId: engine.id };
  if (engine.run.mode === 'command') return { kind, status, flagCount: 0, missing: [], placeholders: templatePlaceholders(engine.run.template) };
  const caps = status.available ? await adapter.capabilities(cfg).catch(() => undefined) : undefined;
  const flags = caps?.flags ?? new Set<string>();
  if (flags.size === 0) return { kind, status, flagCount: 0, missing: [] };
  // A NInfer variant: the KV types its --help lists (its own, like rk8v4, among them).
  const kvDtypes = engine.base === 'ninfer' ? caps?.choices?.['--kv-dtype'] : undefined;
  return { kind, status, flagCount: flags.size, missing: missingStandardFlags(engineBaseOf(kind) as FlagBase, flags), ...(kvDtypes ? { kvDtypes } : {}) };
}

const duplicateSchema = z.object({ name: z.string().trim().min(1).max(60).optional() });

/**
 *   GET    /api/engines/custom                -> CustomEngineInfo[]
 *   POST   /api/engines/custom                (CustomEngineDraft) -> CustomEngine
 *   POST   /api/engines/custom/check          (CustomEngineDraft) -> CustomEngineCheck
 *   PUT    /api/engines/custom/:id            (CustomEngineDraft) -> CustomEngine
 *   POST   /api/engines/custom/:id/duplicate  ({ name? }) -> CustomEngine
 *   DELETE /api/engines/custom/:id            -> { ok: true }
 */
export function createCustomEngineRoutes(d: CustomEnginesDeps): RouteModule {
  const list = async (): Promise<CustomEngine[]> => [...(await d.settings.get()).customEngines];
  const save = (engines: CustomEngine[]) => d.settings.update({ customEngines: engines });
  const find = (engines: readonly CustomEngine[], id: string): CustomEngine => {
    const e = engines.find((x) => x.id === id);
    if (!e) throw new AppError('ENGINE_NOT_INSTALLED', `Custom engine not found: ${id}`, { params: { reason: 'custom_engine_missing', id } });
    return e;
  };

  return (app) => {
    app.get('/api/engines/custom', async (c) => {
      const engines = await list();
      const out: CustomEngineInfo[] = await Promise.all(
        engines.map(async (engine) => ({
          engine,
          kind: customEngineKindOf(engine),
          config: customEngineConfigOf(engine) as CustomEngineInfo['config'],
          check: await checkCustomEngine(d.registry, engine),
        })),
      );
      return c.json(out);
    });

    app.post('/api/engines/custom/check', async (c) => {
      const draft = await parseBody(c, customEngineDraftSchema);
      return c.json(await checkCustomEngine(d.registry, customEngineSchema.parse({ ...draft, id: 'draft' })));
    });

    app.post('/api/engines/custom', async (c) => {
      const draft = await parseBody(c, customEngineDraftSchema);
      const engines = await list();
      const engine = customEngineSchema.parse({ ...draft, id: customEngineIdFor(draft.name, engines.map((e) => e.id)) });
      await save([...engines, engine]);
      return c.json(engine);
    });

    app.put('/api/engines/custom/:id', async (c) => {
      const id = c.req.param('id');
      const draft = await parseBody(c, customEngineDraftSchema);
      const engines = await list();
      find(engines, id);
      const engine = customEngineSchema.parse({ ...draft, id });
      await save(engines.map((e) => (e.id === id ? engine : e)));
      return c.json(engine);
    });

    app.post('/api/engines/custom/:id/duplicate', async (c) => {
      const engines = await list();
      const source = find(engines, c.req.param('id'));
      const { name } = await parseBody(c, duplicateSchema);
      const copyName = name ?? `${source.name} (2)`.slice(0, 60);
      const engine = customEngineSchema.parse({ ...source, name: copyName, id: customEngineIdFor(copyName, engines.map((e) => e.id)) });
      await save([...engines, engine]);
      return c.json(engine);
    });

    app.delete('/api/engines/custom/:id', async (c) => {
      const id = c.req.param('id');
      const engines = await list();
      find(engines, id);
      await save(engines.filter((e) => e.id !== id));
      return c.json({ ok: true as const });
    });
  };
}
