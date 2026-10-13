/**
 * The model's command recipe for any screen: Benchmark (the chip), the model pages ("Comandi per questo
 * modello") and the Server page's slot. Recipes live in settings.modelRecipes; the core applies the
 * matching one by itself (a request without `recipe`), so a screen only has to say it and offer to
 * turn it off (`requestPart(false)`).
 *
 *   const r = useModelRecipe(localModel);   // or a RecipeTarget, or a bare RecipeModelRef
 *   r.recipe        the recipe that applies (undefined: none)
 *   r.label         "YaRN 300K · MTP · Fork PrismML"
 *   r.launchPatch(kind)   what the core will add for that engine (context, RoPE, args, env)
 *   r.engine        the engine it prefers, when saved (a custom engine's config, or a built-in kind)
 *   r.missingTemplate     'prismml-bonsai' when that custom engine is not set up yet
 *   r.requestPart(use)    {} when on, { recipe: { use: false } } when off
 */
import { useCallback } from 'react';
import type { StartServerRequest } from '../../../contract/api';
import { customEngineConfigOf } from '../../../contract/custom-engines';
import type { EngineConfig, EngineKind } from '../../../contract/engines';
import type { LocalModel } from '../../../contract/models';
import { recipeCustomEngine, recipeForModel, recipePatchFor, type ModelRecipe, type RecipeModelRef, type RecipePatch } from '../../../contract/recipes';
import { useI18n } from '../../i18n';
import { useSettings } from '../../lib/settings';
import { recipeParts, targetOfLocal, type RecipeTarget } from './recipe-model';

export interface ModelRecipeInfo {
  recipe: ModelRecipe | undefined;
  /** The recipe's parts in words, joined: "YaRN 300K · MTP". */
  label: string | undefined;
  parts: string[];
  /** What the recipe adds to a launch on `kind` (the core does the same). */
  launchPatch: (kind: EngineKind) => RecipePatch | undefined;
  /** The engine the recipe prefers: a saved custom engine's config, or a built-in kind. */
  engine: EngineConfig | undefined;
  /** Its preferred engine is a template whose custom engine is not set up yet. */
  missingTemplate: string | undefined;
  /** The request's recipe part: nothing when used (the core applies it), { use: false } when not. */
  requestPart: (use: boolean) => Pick<StartServerRequest, 'recipe'>;
}

/** A local model, a recipe screen's target or a bare identity, as a recipe target's parts. */
function partsOf(model: LocalModel | RecipeTarget | RecipeModelRef): { ref: RecipeModelRef; aux: LocalModel['auxiliary'] } {
  if ('identity' in model) {
    const t = targetOfLocal(model);
    return { ref: t.ref, aux: t.aux };
  }
  if ('ref' in model) return { ref: model.ref, aux: model.aux };
  return { ref: model, aux: [] };
}

export function useModelRecipe(model: LocalModel | RecipeTarget | RecipeModelRef | undefined): ModelRecipeInfo {
  const f = useI18n();
  const { settings } = useSettings();
  const { modelRecipes, customEngines } = settings;
  const target = model ? partsOf(model) : undefined;
  const recipe = target ? recipeForModel(modelRecipes, target.ref) : undefined;
  const parts = recipe && target ? recipeParts(recipe, f, { customEngines, aux: target.aux, ref: target.ref }) : [];
  const custom = recipe?.engine && recipe.engine.type !== 'builtin' && target ? recipeCustomEngine(recipe.engine, customEngines, target.ref) : undefined;
  const engine: EngineConfig | undefined = custom ? customEngineConfigOf(custom) : recipe?.engine?.type === 'builtin' ? { kind: recipe.engine.kind } : undefined;
  const missingTemplate = recipe?.engine?.type === 'template' && !custom ? recipe.engine.template : undefined;
  const launchPatch = (kind: EngineKind) => (recipe ? recipePatchFor(recipe, { kind, auxiliary: target?.aux }) : undefined);
  const requestPart = (use: boolean): Pick<StartServerRequest, 'recipe'> => (recipe && !use ? { recipe: { use: false } } : {});
  return { recipe, label: parts.length ? parts.join(' · ') : undefined, parts, launchPatch, engine, missingTemplate, requestPart };
}

/** Saving and removing recipes (settings.modelRecipes): a recipe with nothing in it is removed. */
export function useRecipeStore(): { recipes: readonly ModelRecipe[]; save: (r: ModelRecipe) => void; remove: (id: string) => void } {
  const { settings, update } = useSettings();
  const recipes = settings.modelRecipes;
  const save = useCallback(
    (r: ModelRecipe) => {
      const at = recipes.findIndex((x) => x.id === r.id);
      // A new recipe goes first: between equally specific ones the first wins, and it is the user's latest word.
      update({ modelRecipes: at < 0 ? [r, ...recipes] : recipes.map((x, i) => (i === at ? r : x)) });
    },
    [recipes, update],
  );
  const remove = useCallback((id: string) => update({ modelRecipes: recipes.filter((x) => x.id !== id) }), [recipes, update]);
  return { recipes, save, remove };
}
