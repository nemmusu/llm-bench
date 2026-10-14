/**
 * "Motori personalizzati" API (contract/custom-engines.ts): the saved engines with their check, and
 * create / update / duplicate / delete, plus "Prova" on an engine not saved yet.
 *
 * A check runs what the base would run to know a build: llama.cpp `--version` + `--help`, vLLM
 * `--version` + `serve --help`, SGLang `import sglang` + `--help` (Docker: in the image, when it is
 * there), a NInfer variant its ninfer-serve `--help` and commit (in its WSL distro on Windows). A
 * program with an OpenAI API has its commands validated and their programs looked up: nothing is executed.
 */
import { z } from 'zod';
import {
  customEngineConfigOf,
  customEngineDraftSchema,
  customEngineIdFor,
  customEngineKindOf,
  customEngineSchema,
  commandPlaceholders,
  type CustomEngine,
  type CustomEngineCheck,
  type CustomEngineFiles,
  type CustomEngineInfo,
  type CustomEngineRemovePlan,
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
  /** What LLM Bench added for an engine (custom/files.ts): absent, every engine is only forgotten. */
  files?: {
    plan(engine: CustomEngine, all: readonly CustomEngine[]): Promise<CustomEngineFiles | undefined>;
    remove(engine: CustomEngine, files: CustomEngineFiles): Promise<void>;
  };
  /** A test or a server runs: no files are removed under it. */
  busy?: () => boolean;
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
  if (engine.run.mode === 'command') return { kind, status, flagCount: 0, missing: [], placeholders: commandPlaceholders(engine.run) };
  const caps = status.available ? await adapter.capabilities(cfg).catch(() => undefined) : undefined;
  const flags = caps?.flags ?? new Set<string>();
  if (flags.size === 0) return { kind, status, flagCount: 0, missing: [] };
  // A NInfer variant: the KV types its --help lists (its own, like rk8v4, among them).
  const kvDtypes = engine.base === 'ninfer' ? caps?.choices?.['--kv-dtype'] : undefined;
  // A llama.cpp fork: the KV types its --help lists (its own, like turbo3, among them).
  const kvCacheTypes = engine.base === 'llamacpp' ? caps?.choices?.['--cache-type-k'] : undefined;
  return {
    kind,
    status,
    flagCount: flags.size,
    missing: missingStandardFlags(engineBaseOf(kind) as FlagBase, flags),
    ...(kvDtypes ? { kvDtypes } : {}),
    ...(kvCacheTypes ? { kvCacheTypes } : {}),
  };
}

const duplicateSchema = z.object({ name: z.string().trim().min(1).max(60).optional() });

/**
 *   GET    /api/engines/custom                -> CustomEngineInfo[]
 *   POST   /api/engines/custom                (CustomEngineDraft) -> CustomEngine
 *   POST   /api/engines/custom/check          (CustomEngineDraft) -> CustomEngineCheck
 *   PUT    /api/engines/custom/:id            (CustomEngineDraft) -> CustomEngine
 *   POST   /api/engines/custom/:id/duplicate  ({ name? }) -> CustomEngine
 *   GET    /api/engines/custom/:id/remove     -> CustomEngineRemovePlan
 *   DELETE /api/engines/custom/:id            -> { ok: true } (?files=1: its files too; ENGINE_IN_USE while a test or a server runs)
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
      const old = find(engines, id);
      // The image LLM Bench pulled stays its own while the engine still runs it.
      const pulled = old.pulledImage !== undefined && draft.run.mode === 'docker' && draft.run.image === old.pulledImage ? { pulledImage: old.pulledImage } : {};
      const engine = customEngineSchema.parse({ ...draft, id, ...pulled });
      await save(engines.map((e) => (e.id === id ? engine : e)));
      return c.json(engine);
    });

    app.post('/api/engines/custom/:id/duplicate', async (c) => {
      const engines = await list();
      // A copy runs the same files, but they were not added for it: deleting the copy only forgets it.
      const { pulledImage: _pulled, ...source } = find(engines, c.req.param('id'));
      const { name } = await parseBody(c, duplicateSchema);
      const copyName = name ?? `${source.name} (2)`.slice(0, 60);
      const engine = customEngineSchema.parse({ ...source, name: copyName, id: customEngineIdFor(copyName, engines.map((e) => e.id)) });
      await save([...engines, engine]);
      return c.json(engine);
    });

    app.get('/api/engines/custom/:id/remove', async (c) => {
      const id = c.req.param('id');
      const engines = await list();
      const engine = find(engines, id);
      const files = await d.files?.plan(engine, engines);
      const plan: CustomEngineRemovePlan = { id, ...(files ? { files } : {}) };
      return c.json(plan);
    });

    app.delete('/api/engines/custom/:id', async (c) => {
      const id = c.req.param('id');
      const engines = await list();
      const engine = find(engines, id);
      if (c.req.query('files') === '1') {
        const files = await d.files?.plan(engine, engines);
        if (!files) throw new AppError('VALIDATION', `No files of ${engine.name} for LLM Bench to remove`, { params: { reason: 'no-files', id } });
        if (d.busy?.()) throw new AppError('ENGINE_IN_USE', `${engine.name} is in use`, { params: { engine: engine.name } });
        await d.files!.remove(engine, files);
      }
      // Read again: removing the files took time, the list may have changed meanwhile.
      await save((await list()).filter((e) => e.id !== id));
      return c.json({ ok: true as const });
    });
  };
}
