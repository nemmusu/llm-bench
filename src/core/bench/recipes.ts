/**
 * "Comandi per questo modello" in the core (contract/recipes.ts): which recipe a run or a server
 * uses, the engine it chooses (a saved custom engine: the PrismML fork for Bonsai models) and the
 * launch params with the recipe's settings, the user's own winning. Runs, the tuner's base and
 * servers all come through here (BenchService.prepare / prepareServer).
 */
import type { StartServerRequest } from '../../contract/api';
import { customEngineConfigOf, type CustomEngine } from '../../contract/custom-engines';
import { launchParamsSchema, type EngineConfig, type EngineKind, type LaunchParams } from '../../contract/engines';
import { engineRunsFormat, isNinferKind, ninferKindFor } from '../../contract/ninfer';
import {
  mergeRecipeParams,
  modelRecipeDraftSchema,
  recipeCustomEngine,
  recipeForModel,
  recipePatchFor,
  type AppliedRecipe,
  type ModelRecipe,
  type RecipeModelRef,
  type RecipeSkip,
} from '../../contract/recipes';
import type { LlamaCaps } from '../engines/llamacpp-native/caps';
import type { ModelTarget } from '../engines/types';
import { speculativeArgs } from './tune-space';

/** Where recipes and the custom engines they name come from (settings). */
export interface RecipeSources {
  recipes: readonly ModelRecipe[];
  customEngines: readonly CustomEngine[];
}

/** The request as it is launched: its engine (maybe a custom one) and params (the recipe's merged in). */
export interface WithRecipe {
  engine: EngineConfig;
  params: LaunchParams;
  applied?: AppliedRecipe;
}

/** What matching looks at for a model target. */
export function recipeRefOf(model: ModelTarget): RecipeModelRef {
  const id = model.identity;
  return { displayName: id.displayName, repo: id.repo ?? model.repo, file: id.file, quant: id.quant, sha256: id.sha256, weakKey: id.weakKey };
}

/** The recipe a request asks for: an inline one, one by id, none, or the one matching the model. */
function chosenRecipe(req: Pick<StartServerRequest, 'recipe'>, model: ModelTarget, recipes: readonly ModelRecipe[]): ModelRecipe | undefined {
  const choice = req.recipe;
  if (choice?.use === false) return undefined;
  if (choice?.inline) return { schema: 1, id: 'inline', ...modelRecipeDraftSchema.parse(choice.inline) };
  if (choice?.id !== undefined) return recipes.find((r) => r.id === choice.id);
  return recipeForModel(recipes, recipeRefOf(model));
}

/**
 * The request's engine and params with the model's recipe applied. The preferred custom engine
 * replaces the request's engine unless the request already names a custom engine or is an external
 * endpoint; a template with no saved engine yet is reported (missingTemplate). A built-in preference
 * replaces only an engine that cannot read the model (a .ninfer artifact: NInfer, run as `platform`
 * runs it, in WSL on Windows). `caps` is asked only for a llama.cpp draft/MTP file (which
 * --spec-type the build knows).
 */
export async function withRecipe(
  req: Pick<StartServerRequest, 'engine' | 'params' | 'recipe'>,
  model: ModelTarget,
  sources: RecipeSources | undefined,
  caps: (engine: EngineConfig) => Promise<LlamaCaps | undefined>,
  platform?: string,
): Promise<WithRecipe> {
  const user = req.params ?? launchParamsSchema.parse({});
  const recipe = sources ? chosenRecipe(req, model, sources.recipes) : undefined;
  if (!recipe) return { engine: req.engine, params: user };
  let engine = req.engine;
  let chosen: AppliedRecipe['engine'];
  let missingTemplate: string | undefined;
  const skipped: RecipeSkip[] = [];
  const free = req.engine.kind !== 'external' && req.engine.customEngineId === undefined;
  if (recipe.engine?.type === 'builtin') {
    const kind = builtinKind(recipe.engine.kind, platform);
    if (free && kind !== req.engine.kind && !engineRunsFormat(req.engine.kind, model.identity.format)) {
      engine = { kind };
      chosen = { kind, name: kind };
    }
  } else if (recipe.engine) {
    const custom = recipeCustomEngine(recipe.engine, (sources as RecipeSources).customEngines, recipeRefOf(model));
    if (!custom) {
      skipped.push({ part: 'engine', reason: 'engine_missing' });
      if (recipe.engine.type === 'template') missingTemplate = recipe.engine.template;
    } else if (free) {
      engine = customEngineConfigOf(custom);
      chosen = { customEngineId: custom.id, name: custom.name };
    }
  }
  const llamaCaps = recipe.draft !== undefined ? await caps(engine).catch(() => undefined) : undefined;
  const patch = recipePatchFor(recipe, {
    kind: engine.kind,
    auxiliary: model.local?.auxiliary,
    // Without the build's help (not installed yet: a preview), the plain draft flag.
    ...(llamaCaps?.entries ? { draftArgs: (file: { kind: 'mtp' | 'draft'; path: string }) => speculativeArgs({ auxiliary: [file] }, llamaCaps) } : {}),
  });
  const { params, overridden } = mergeRecipeParams(user, patch);
  for (const o of overridden) if (o === 'context' || o === 'rope') skipped.push({ part: o, reason: 'user' });
  const ctx = overridden.includes('context') ? undefined : (patch.params.contextSize ?? patch.params.maxModelLen);
  const rope = overridden.includes('rope') ? undefined : patch.params.ropeScaling;
  const applied: AppliedRecipe = {
    id: recipe.id,
    name: recipe.name,
    from: recipe.from,
    parts: [...(chosen ? (['engine'] as const) : []), ...patch.parts],
    args: patch.args,
    envNames: Object.keys(patch.env),
    ...(ctx !== undefined ? { contextSize: ctx } : {}),
    ...(rope ? { ropeScaling: rope } : {}),
    ...(chosen ? { engine: chosen } : {}),
    overridden,
    skipped: [...skipped, ...patch.skipped],
    ...(missingTemplate ? { missingTemplate } : {}),
  };
  return { engine, params, applied };
}

/** A built-in engine as this platform runs it: NInfer natively on Linux, in WSL on Windows. */
function builtinKind(kind: EngineKind, platform: string | undefined): EngineKind {
  return isNinferKind(kind) ? (ninferKindFor(platform ?? '') ?? kind) : kind;
}

/** The recipe notes of a plan or run, for the renderer (RunResult.notes codes). */
export function recipeWarnings(applied: AppliedRecipe | undefined): { code: string; params?: Record<string, unknown> }[] {
  if (!applied) return [];
  const out: { code: string; params?: Record<string, unknown> }[] = [];
  if (applied.missingTemplate) out.push({ code: 'recipe_engine_missing', params: { template: applied.missingTemplate, recipe: applied.name } });
  for (const s of applied.skipped) if (s.reason === 'no_file') out.push({ code: 'recipe_file_missing', params: { part: s.part, recipe: applied.name } });
  return out;
}
