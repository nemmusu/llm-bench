/**
 * "Comandi per questo modello": per-model command recipes, saved in settings.modelRecipes.
 *
 * Some models need commands you only learn from their model card: a YaRN context extension, the MTP
 * file for speculative decoding, a fork of llama.cpp (PrismML Bonsai), the image projector… A recipe
 * says them once, for one model (its sha256, weak key, or hub repo + file) or for a whole family (a
 * name and/or quant pattern), and Benchmark, "Trova le impostazioni migliori" (as the base it varies
 * around) and "Avvia solo il server" use it by themselves.
 *
 * What a recipe holds:
 *   - structured settings: the context (with YaRN: the extended one), RoPE scaling, a draft/MTP file
 *     (llama.cpp), the image projector (llama.cpp --mmproj);
 *   - extra arguments per engine (llama.cpp, vLLM, SGLang, a command-template program) and environment;
 *   - an optional preferred engine (a built-in kind, a saved custom engine, or the custom engine made
 *     from a template such as 'prismml-bonsai');
 *   - notes and a link to the model card.
 *
 * Which recipe applies (recipeForModel): an exact identity beats a pattern; between patterns the more
 * specific (name and quant) wins; then the list order. A request (StartRunRequest / StartServerRequest
 * `recipe`) can turn it off ({ use: false }), name another one ({ id }) or carry an unsaved one
 * ({ inline }, the editor's live preview).
 *
 * Who wins (mergeRecipeParams): what the user sets in expert mode (context, RoPE scaling, a flag in the
 * extra arguments, an environment variable) replaces the recipe's same value, and the result says so
 * (AppliedRecipe.overridden). Recipe arguments come before the user's own.
 *
 * Built-in recipes (RECIPE_TEMPLATES) are read-only: "Usa" copies one into the model's own recipe.
 */
import { z } from 'zod';
import { customEngineForModel, templateForModel, type CustomEngine, type MatchableModel } from './custom-engines';
import { engineBaseOf, engineKindSchema, ropeScalingSchema, type EngineKind, type LaunchParams, type RopeScaling } from './engines';

export const MODEL_RECIPE_SCHEMA_VERSION = 1;

/** Largest context a recipe can ask for (4M tokens). */
export const MAX_RECIPE_CONTEXT = 4_194_304;

/**
 * Engines a recipe's own arguments are written for. 'command' = a program started from a command
 * template (custom engines of base 'openai-server'). A fork of llama.cpp / vLLM / SGLang takes its
 * base's arguments.
 */
export const RECIPE_ARG_TARGETS = ['llamacpp', 'vllm', 'sglang', 'command'] as const;
export const recipeArgTargetSchema = z.enum(RECIPE_ARG_TARGETS);
export type RecipeArgTarget = z.infer<typeof recipeArgTargetSchema>;

/** The arguments of a recipe an engine kind takes; undefined for external endpoints (never launched). */
export function recipeArgTargetOf(kind: EngineKind): RecipeArgTarget | undefined {
  if (kind === 'command') return 'command';
  const base = engineBaseOf(kind);
  // NInfer takes its own settings (contract/ninfer.ts), not a recipe's arguments.
  return base === 'external' || base === 'ninfer' ? undefined : base;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Lower-case slug ids ("qwen3-8b-yarn", "recipe-2"). */
export const RECIPE_ID = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

// ---- which models ---------------------------------------------------------------------------------

/**
 * One model, by identity: its sha256 (strongest), its weak key (repo/file/quant/size), or its hub
 * repo with or without the GGUF file inside it. `label` is what the user sees.
 */
export const recipeModelSchema = z
  .object({
    label: z.string().trim().min(1).max(200),
    sha256: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
    weakKey: z.string().min(1).max(600).optional(),
    repo: z.string().trim().min(1).max(200).optional(),
    /** Path of the GGUF inside `repo` (only its file name is compared). Absent = every file of the repo. */
    file: z.string().trim().min(1).max(600).optional(),
  })
  .refine((m) => m.sha256 !== undefined || m.weakKey !== undefined || m.repo !== undefined, { message: 'identity_missing', params: { reason: 'identity_missing' } });
export type RecipeModel = z.infer<typeof recipeModelSchema>;

/**
 * Models a recipe is for: the listed ones (exact), and/or every model whose repo, file or name
 * matches `name` and whose quantization matches `quant` (both when both are given). A pattern is
 * plain text (any case) or "/regex/".
 */
export const recipeMatchSchema = z.object({
  models: z.array(recipeModelSchema).max(50).default([]),
  name: z.string().trim().min(1).max(200).optional(),
  quant: z.string().trim().min(1).max(60).optional(),
});
export type RecipeMatch = z.infer<typeof recipeMatchSchema>;

// ---- what it sets ---------------------------------------------------------------------------------

/**
 * The engine to use for the model:
 *   builtin   one of GPU Bench's engines (the Benchmark page preselects it)
 *   custom    a saved custom engine (settings.customEngines) by id
 *   template  the saved custom engine made from (or matching) a built-in template, e.g.
 *             'prismml-bonsai'; none saved yet = the guided action "Indica dove si trova il fork"
 */
export const recipeEngineSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('builtin'), kind: engineKindSchema }),
  z.object({ type: z.literal('custom'), id: z.string().min(1).max(60) }),
  z.object({ type: z.literal('template'), template: z.string().min(1).max(60) }),
]);
export type RecipeEngine = z.infer<typeof recipeEngineSchema>;

const argList = z.array(z.string().min(1).max(4000)).max(100);

export const recipeArgsSchema = z
  .object({ llamacpp: argList.optional(), vllm: argList.optional(), sglang: argList.optional(), command: argList.optional() })
  .default({});
export type RecipeArgs = z.infer<typeof recipeArgsSchema>;

/** Draft value meaning "the MTP or draft file the library groups with the model". */
export const DRAFT_AUTO = 'auto';

const recipeShape = {
  name: z.string().trim().min(1).max(80),
  match: recipeMatchSchema,
  /** Context the model is started with, tokens (with RoPE scaling: the extended context). */
  contextSize: z.number().int().min(1024).max(MAX_RECIPE_CONTEXT).optional(),
  /** RoPE context extension (YaRN or linear), see yarnScaling. */
  ropeScaling: ropeScalingSchema.optional(),
  /**
   * Speculative decoding with llama.cpp (-md, and --spec-type when the build has it): DRAFT_AUTO = the
   * MTP or draft file the library groups with the model; else the path of the file. vLLM and SGLang
   * take their speculative settings in `args`.
   */
  draft: z.string().trim().min(1).max(1000).optional(),
  /** Images: load the projector the library groups with the model (llama.cpp --mmproj). */
  mmproj: z.boolean().optional(),
  engine: recipeEngineSchema.optional(),
  /** Extra arguments per engine, before the user's own (expert mode). */
  args: recipeArgsSchema,
  /** Added to the environment of every launch (the user's own variables win). */
  env: z.record(z.string().regex(ENV_NAME), z.string().max(4000)).default({}),
  notes: z.string().max(4000).default(''),
  /** The model card, or the page that documents these commands. */
  link: z.string().url().max(2000).optional(),
  /** Built-in recipes (RECIPE_TEMPLATES ids) it was made from, for their wording. */
  from: z.array(z.string().min(1).max(60)).max(10).default([]),
};

/** What makes a recipe usable: it names models, its patterns compile, its context fits its RoPE scaling. */
function refineRecipe(r: { match: RecipeMatch; contextSize?: number | undefined; ropeScaling?: RopeScaling | undefined }, ctx: z.RefinementCtx): void {
  const issue = (path: (string | number)[], reason: string) => ctx.addIssue({ code: 'custom', path, message: reason, params: { reason } });
  if (r.match.models.length === 0 && r.match.name === undefined && r.match.quant === undefined) issue(['match'], 'no_models');
  if (r.match.name !== undefined && textMatcher(r.match.name) === undefined) issue(['match', 'name'], 'bad_pattern');
  if (r.match.quant !== undefined && textMatcher(r.match.quant) === undefined) issue(['match', 'quant'], 'bad_pattern');
}

/** A recipe as the user writes it (editor, a request's inline recipe). */
export const modelRecipeDraftSchema = z.object(recipeShape).superRefine(refineRecipe);
export type ModelRecipeDraft = z.input<typeof modelRecipeDraftSchema>;

/** A saved recipe (settings.modelRecipes). */
export const modelRecipeSchema = z
  .object({
    /** Format version of this entry: an older app drops a newer one (never the whole settings file). */
    schema: z.literal(MODEL_RECIPE_SCHEMA_VERSION).default(MODEL_RECIPE_SCHEMA_VERSION),
    id: z.string().regex(RECIPE_ID),
    ...recipeShape,
    /** ISO time of the last change. */
    updatedAt: z.string().optional(),
  })
  .superRefine(refineRecipe);
export type ModelRecipe = z.infer<typeof modelRecipeSchema>;

/** settings.modelRecipes, read leniently: an entry that does not validate is dropped, never the whole file. */
export const modelRecipesSettingSchema = z
  .array(z.unknown())
  .default([])
  .transform((list) =>
    list.flatMap((raw) => {
      const p = modelRecipeSchema.safeParse(raw);
      return p.success ? [p.data] : [];
    }),
  );

/** Nothing to apply: saving it removes the recipe instead ("empty means delete"). */
export function recipeIsEmpty(r: Pick<ModelRecipe, 'contextSize' | 'ropeScaling' | 'draft' | 'mmproj' | 'engine' | 'args' | 'env'>): boolean {
  return (
    r.contextSize === undefined &&
    r.ropeScaling === undefined &&
    r.draft === undefined &&
    r.mmproj === undefined &&
    r.engine === undefined &&
    RECIPE_ARG_TARGETS.every((k) => (r.args[k] ?? []).length === 0) &&
    Object.keys(r.env).length === 0
  );
}

/** A free id for a new recipe named `name`: its slug, "-2", "-3"… when taken. */
export function recipeIdFor(name: string, taken: readonly string[]): string {
  const slug =
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'recipe';
  const used = new Set(taken);
  if (!used.has(slug)) return slug;
  let n = 2;
  while (used.has(`${slug}-${n}`)) n++;
  return `${slug}-${n}`;
}

// ---- matching -------------------------------------------------------------------------------------

/** A pattern as a matcher: "/re/flags" a regular expression (always case-insensitive), else a substring. */
export function textMatcher(rule: string): ((text: string) => boolean) | undefined {
  const re = /^\/(.+)\/([a-z]*)$/.exec(rule);
  if (!re) {
    const needle = rule.toLowerCase();
    return (text) => text.toLowerCase().includes(needle);
  }
  try {
    const compiled = new RegExp(re[1] as string, `${(re[2] as string).replace(/[gyi]/g, '')}i`);
    return (text) => compiled.test(text);
  } catch {
    return undefined;
  }
}

/** What matching looks at: the model's identity (local, hub or a run's). */
export interface RecipeModelRef extends MatchableModel {
  sha256?: string | undefined;
  weakKey?: string | undefined;
}

const baseName = (p: string): string => p.split(/[\\/]/).pop()?.toLowerCase() ?? '';

/**
 * How well `entry` names `model`: 4 = same sha256, 3 = same weak key or same repo + file, 2 = same
 * repo (every file), 0 = not this model. A known sha256 on both sides decides alone.
 */
export function modelEntryRank(entry: RecipeModel, model: RecipeModelRef): number {
  if (entry.sha256 !== undefined && model.sha256 !== undefined) return entry.sha256.toLowerCase() === model.sha256.toLowerCase() ? 4 : 0;
  if (entry.weakKey !== undefined && model.weakKey !== undefined && entry.weakKey === model.weakKey) return 3;
  if (entry.repo === undefined || model.repo === undefined || entry.repo.toLowerCase() !== model.repo.toLowerCase()) return 0;
  if (entry.file === undefined) return 2;
  return model.file !== undefined && baseName(entry.file) === baseName(model.file) ? 3 : 0;
}

/** The quantization of a model: its own, else a token of its file name ("Bonsai-8B-PQ2_0.gguf"). */
function quantTexts(model: RecipeModelRef): string[] {
  const tokens = (model.file ?? '').split(/[\\/]/).pop()?.split(/[^A-Za-z0-9_]+/) ?? [];
  return [...(model.quant !== undefined ? [model.quant] : []), ...tokens].filter(Boolean);
}

/**
 * How well a recipe fits a model (0 = not at all): exact identities rank 20 + their rank (see
 * modelEntryRank); patterns rank 10 for name and quant together, 5 for one of them.
 */
export function recipeRank(match: RecipeMatch, model: RecipeModelRef): number {
  const exact = Math.max(0, ...match.models.map((m) => modelEntryRank(m, model)));
  if (exact > 0) return 20 + exact;
  if (match.name === undefined && match.quant === undefined) return 0;
  if (match.name !== undefined) {
    const text = [model.repo, model.file, model.displayName].filter((s): s is string => s !== undefined).join('\n');
    if (textMatcher(match.name)?.(text) !== true) return 0;
  }
  if (match.quant !== undefined) {
    const q = textMatcher(match.quant);
    const quants = quantTexts(model);
    // A plain quant name is the whole token ("Q4_K_M" is not "Q4_K_M_L"); a regex is free.
    const plain = !/^\/.+\/[a-z]*$/.test(match.quant);
    if (!quants.some((t) => (plain ? t.toLowerCase() === match.quant!.toLowerCase() : q?.(t) === true))) return 0;
  }
  return match.name !== undefined && match.quant !== undefined ? 10 : 5;
}

/** The recipe for a model: the best ranked, the first in the list on a tie. */
export function recipeForModel<R extends Pick<ModelRecipe, 'match'>>(recipes: readonly R[], model: RecipeModelRef): R | undefined {
  let best: R | undefined;
  let bestRank = 0;
  for (const r of recipes) {
    const rank = recipeRank(r.match, model);
    if (rank > bestRank) {
      best = r;
      bestRank = rank;
    }
  }
  return best;
}

/** The match is this one model only (an exact entry, no pattern). */
export function recipeIsExactFor(match: RecipeMatch, model: RecipeModelRef): boolean {
  return match.name === undefined && match.quant === undefined && match.models.some((m) => modelEntryRank(m, model) > 0);
}

// ---- YaRN -----------------------------------------------------------------------------------------

/** "Contesto oltre il limite del modello (YaRN)": the targets offered (300K and 500K, K = 1024). */
export const YARN_TARGETS = [307_200, 512_000] as const;
/** The 200K step of context sweeps and filters (K = 1024: "200K", a nominal depth). */
export const CONTEXT_200K = 204_800;

/**
 * YaRN scaling that takes a model trained on `trained` tokens to `target` tokens: factor = target /
 * trained (6 decimals), original context = trained. Undefined when the target is not beyond the
 * trained context or needs more than the largest factor (64).
 */
export function yarnScaling(target: number, trained: number | undefined): RopeScaling | undefined {
  if (trained === undefined || !(trained > 0) || !(target > trained)) return undefined;
  const factor = Math.round((target / trained) * 1e6) / 1e6;
  return factor <= 64 ? { type: 'yarn', factor, originalContext: trained } : undefined;
}

/** The context a launch can use: the trained one, or with RoPE scaling factor × its original context. */
export function extendedContext(trained: number | undefined, rope: RopeScaling | undefined): number | undefined {
  if (!rope) return trained;
  return Math.max(trained ?? 0, Math.round(rope.factor * rope.originalContext));
}

// ---- applying -------------------------------------------------------------------------------------

/** Parts of a recipe, in the order they are said ("YaRN 300K · MTP · fork PrismML · 2 argomenti"). */
export const RECIPE_PARTS = ['engine', 'context', 'rope', 'draft', 'mmproj', 'args', 'env'] as const;
export const recipePartSchema = z.enum(RECIPE_PARTS);
export type RecipePart = z.infer<typeof recipePartSchema>;

/**
 * Why a part did not apply to a launch: 'no_file' (no MTP/draft or projector file next to the model),
 * 'engine' (not for this engine: a structured part of llama.cpp, arguments written only for other
 * engines), 'engine_missing' (the preferred custom engine is not saved), 'user' (the user's own value
 * replaced it: see overridden).
 */
export const recipeSkipSchema = z.object({ part: recipePartSchema, reason: z.enum(['no_file', 'engine', 'engine_missing', 'user']) });
export type RecipeSkip = z.infer<typeof recipeSkipSchema>;

/** Files the library groups with the model (LocalModel.auxiliary). */
export interface RecipeAuxFile {
  kind: 'mmproj' | 'mtp' | 'draft' | 'other';
  path: string;
}

export interface RecipeLaunchContext {
  /** The engine kind of the launch. */
  kind: EngineKind;
  auxiliary?: readonly RecipeAuxFile[] | undefined;
  /**
   * llama.cpp speculative arguments for a draft or MTP file (the core asks the build: --spec-type
   * draft-mtp…); undefined = the build cannot use it. Absent = plain ['-md', path].
   */
  draftArgs?: (file: { kind: 'mtp' | 'draft'; path: string }) => string[] | undefined;
}

/** What a recipe adds to one launch. */
export interface RecipePatch {
  /** llama.cpp contextSize, vLLM / SGLang maxModelLen, and RoPE scaling. */
  params: Partial<Pick<LaunchParams, 'contextSize' | 'maxModelLen' | 'ropeScaling'>>;
  /** Arguments for this engine: structured parts first (-md, --mmproj), then the recipe's own. */
  args: string[];
  env: Record<string, string>;
  /** Parts that set something on this launch. */
  parts: RecipePart[];
  skipped: RecipeSkip[];
}

const isMtpName = (p: string): boolean => /(^|[^a-z])mtp([^a-z]|$)/i.test(baseName(p));

/** The recipe's settings for one launch (the preferred engine is resolved separately: recipeEngineConfig). */
export function recipePatchFor(r: Pick<ModelRecipe, 'contextSize' | 'ropeScaling' | 'draft' | 'mmproj' | 'args' | 'env'>, ctx: RecipeLaunchContext): RecipePatch {
  const target = recipeArgTargetOf(ctx.kind);
  const out: RecipePatch = { params: {}, args: [], env: {}, parts: [], skipped: [] };
  if (target === undefined) {
    // An external endpoint is already running: nothing of a recipe reaches it.
    for (const part of partsOf(r)) out.skipped.push({ part, reason: 'engine' });
    return out;
  }
  const llama = target === 'llamacpp';
  if (r.contextSize !== undefined && target !== 'command') {
    if (llama) out.params.contextSize = r.contextSize;
    else out.params.maxModelLen = r.contextSize;
    out.parts.push('context');
  }
  if (r.ropeScaling !== undefined) {
    if (target === 'command') out.skipped.push({ part: 'rope', reason: 'engine' });
    else {
      out.params.ropeScaling = r.ropeScaling;
      out.parts.push('rope');
    }
  }
  if (r.draft !== undefined) {
    if (!llama) out.skipped.push({ part: 'draft', reason: 'engine' });
    else {
      const aux = r.draft === DRAFT_AUTO ? ctx.auxiliary?.find((a) => a.kind === 'mtp' || a.kind === 'draft') : { kind: isMtpName(r.draft) ? ('mtp' as const) : ('draft' as const), path: r.draft };
      const args = aux ? (ctx.draftArgs ? ctx.draftArgs(aux as { kind: 'mtp' | 'draft'; path: string }) : ['-md', aux.path]) : undefined;
      if (args) {
        out.args.push(...args);
        out.parts.push('draft');
      } else out.skipped.push({ part: 'draft', reason: aux ? 'engine' : 'no_file' });
    }
  }
  if (r.mmproj === true) {
    const file = ctx.auxiliary?.find((a) => a.kind === 'mmproj');
    if (!llama) out.skipped.push({ part: 'mmproj', reason: 'engine' });
    else if (!file) out.skipped.push({ part: 'mmproj', reason: 'no_file' });
    else {
      out.args.push('--mmproj', file.path);
      out.parts.push('mmproj');
    }
  }
  const own = r.args[target] ?? [];
  if (own.length) {
    out.args.push(...own);
    out.parts.push('args');
  } else if (RECIPE_ARG_TARGETS.some((k) => (r.args[k] ?? []).length > 0)) out.skipped.push({ part: 'args', reason: 'engine' });
  if (Object.keys(r.env).length) {
    out.env = { ...r.env };
    out.parts.push('env');
  }
  return out;
}

/** The parts a recipe sets at all (whatever the engine). */
export function partsOf(r: Pick<ModelRecipe, 'contextSize' | 'ropeScaling' | 'draft' | 'mmproj' | 'args' | 'env'> & { engine?: RecipeEngine | undefined }): RecipePart[] {
  const has: Record<RecipePart, boolean> = {
    engine: r.engine !== undefined,
    context: r.contextSize !== undefined,
    rope: r.ropeScaling !== undefined,
    draft: r.draft !== undefined,
    mmproj: r.mmproj === true,
    args: RECIPE_ARG_TARGETS.some((k) => (r.args[k] ?? []).length > 0),
    env: Object.keys(r.env).length > 0,
  };
  return RECIPE_PARTS.filter((p) => has[p]);
}

/** Flags with other spellings: the user's spelling replaces the recipe's. */
const FLAG_ALIASES: readonly (readonly string[])[] = [
  ['-c', '--ctx-size'],
  ['-md', '--model-draft', '--spec-draft-model'],
  ['-mm', '--mmproj'],
  ['-ngld', '--gpu-layers-draft', '--n-gpu-layers-draft'],
  ['-np', '--parallel'],
];
const flagKey = (flag: string): string => {
  const name = flag.includes('=') && flag.startsWith('--') ? flag.slice(0, flag.indexOf('=')) : flag;
  return FLAG_ALIASES.find((a) => a.includes(name))?.[0] ?? name;
};
const isFlag = (token: string): boolean => token.length > 1 && token.startsWith('-') && !/^-\d/.test(token);

/** Arguments as flag groups: each flag with the values that follow it (a leading value is its own group). */
export function argGroups(args: readonly string[]): string[][] {
  const groups: string[][] = [];
  for (const a of args) {
    if (isFlag(a) || groups.length === 0) groups.push([a]);
    else (groups[groups.length - 1] as string[]).push(a);
  }
  return groups;
}

/** What the user's own settings replaced, as said in the UI: 'context', 'rope', a flag ("--rope-scale"), "env:NAME". */
export type RecipeOverride = string;

/**
 * The launch params of a run or server: the user's (expert mode, a preset) over the recipe's.
 * Structured values the user set win (context, RoPE scaling); the recipe's arguments go first, but a
 * flag the user's arguments also give is left out (the user's wins); the user's environment wins.
 * Identical values are not "replaced".
 */
export function mergeRecipeParams(user: LaunchParams, patch: RecipePatch): { params: LaunchParams; overridden: RecipeOverride[] } {
  const overridden: RecipeOverride[] = [];
  const out: LaunchParams = { ...user, extraArgs: [], env: {} };
  const userCtx = user.contextSize ?? user.maxModelLen;
  const recipeCtx = patch.params.contextSize ?? patch.params.maxModelLen;
  if (recipeCtx !== undefined) {
    if (userCtx === undefined) {
      if (patch.params.contextSize !== undefined) out.contextSize = patch.params.contextSize;
      if (patch.params.maxModelLen !== undefined) out.maxModelLen = patch.params.maxModelLen;
    } else if (userCtx !== recipeCtx) overridden.push('context');
  }
  if (patch.params.ropeScaling !== undefined) {
    if (user.ropeScaling === undefined) out.ropeScaling = patch.params.ropeScaling;
    else if (JSON.stringify(user.ropeScaling) !== JSON.stringify(patch.params.ropeScaling)) overridden.push('rope');
  }
  const userGroups = argGroups(user.extraArgs);
  const userFlags = new Map(userGroups.map((g) => [flagKey(g[0] as string), g]));
  const kept: string[] = [];
  for (const g of argGroups(patch.args)) {
    const mine = userFlags.get(flagKey(g[0] as string));
    if (!mine || !isFlag(g[0] as string)) {
      kept.push(...g);
      continue;
    }
    if (mine.join('\u0000') !== g.join('\u0000')) overridden.push(g[0] as string);
  }
  out.extraArgs = [...kept, ...user.extraArgs];
  for (const [k, v] of Object.entries(patch.env)) if (user.env[k] !== undefined && user.env[k] !== v) overridden.push(`env:${k}`);
  out.env = { ...patch.env, ...user.env };
  return { params: out, overridden: [...new Set(overridden)] };
}

// ---- the preferred engine -------------------------------------------------------------------------

/**
 * The saved custom engine a recipe's engine names, or undefined (a built-in, or none saved yet). A
 * template means the engine made from it, else (for a model the template is for) the saved engine
 * whose own model rules match the model.
 */
export function recipeCustomEngine<E extends Pick<CustomEngine, 'id' | 'template' | 'match'>>(engine: RecipeEngine | undefined, engines: readonly E[], model?: RecipeModelRef): E | undefined {
  if (engine?.type === 'custom') return engines.find((e) => e.id === engine.id);
  if (engine?.type !== 'template') return undefined;
  const made = engines.find((e) => e.template === engine.template);
  if (made || !model || templateForModel(model)?.id !== engine.template) return made;
  return customEngineForModel(engines, model);
}

// ---- requests and records -------------------------------------------------------------------------

/**
 * A request's choice (StartRunRequest.recipe, StartServerRequest.recipe). Absent = the recipe that
 * matches the model, if any. `use: false` = none ("Usa i comandi di questo modello" off); `id` = that
 * saved recipe; `inline` = an unsaved recipe (the editor's live preview).
 */
export const recipeChoiceSchema = z.object({
  use: z.boolean().default(true),
  id: z.string().min(1).max(60).optional(),
  inline: modelRecipeDraftSchema.optional(),
});
export type RecipeChoice = z.input<typeof recipeChoiceSchema>;

/** The recipe a run or server used (RunResult.recipe, RunPlan.recipe, ServerPlan.recipe). */
export const appliedRecipeSchema = z.object({
  /** The saved recipe's id ('inline' for an unsaved one). */
  id: z.string(),
  name: z.string(),
  /** Built-in recipes it was made from. */
  from: z.array(z.string()).default([]),
  /** Parts that set something on this launch. */
  parts: z.array(recipePartSchema).default([]),
  /** The arguments it added (this engine's, structured parts included). */
  args: z.array(z.string()).default([]),
  /** Environment variables it set (names only: values may be secrets). */
  envNames: z.array(z.string()).default([]),
  /** Context and RoPE scaling it set (as launched, unless the user replaced them). */
  contextSize: z.number().int().optional(),
  ropeScaling: ropeScalingSchema.optional(),
  /** The custom engine it chose for the launch. */
  engine: z.object({ customEngineId: z.string(), name: z.string() }).optional(),
  /** What the user's own settings replaced ('context', 'rope', a flag, "env:NAME"). */
  overridden: z.array(z.string()).default([]),
  skipped: z.array(recipeSkipSchema).default([]),
  /** Its preferred engine is a template with no saved custom engine yet ("Indica dove si trova il fork"). */
  missingTemplate: z.string().optional(),
});
export type AppliedRecipe = z.infer<typeof appliedRecipeSchema>;

// ---- built-in recipes -----------------------------------------------------------------------------

export const RECIPE_TEMPLATE_IDS = ['yarn', 'mtp', 'prismml-bonsai', 'vision'] as const;
export type RecipeTemplateId = (typeof RECIPE_TEMPLATE_IDS)[number];

/** What the built-in recipes look at to say whether they fit a model. */
export interface RecipeTemplateModel extends RecipeModelRef {
  format?: 'gguf' | 'safetensors' | 'remote' | undefined;
  /** The context the model was trained with (GGUF / config.json), tokens. */
  trainedContext?: number | undefined;
  /** Auxiliary files next to the model (local), or in its repo (hub). */
  auxKinds?: readonly ('mmproj' | 'mtp' | 'draft' | 'other')[] | undefined;
}

/** Why a built-in recipe does not fit a model: 'no_context' (trained context unknown), 'no_file', 'not_bonsai', 'format'. */
export type TemplateBlock = 'no_context' | 'no_file' | 'not_bonsai' | 'format';

export interface RecipeTemplate {
  id: RecipeTemplateId;
  /** Parts it sets (its card lists them). */
  parts: readonly RecipePart[];
  /** Where its commands are documented. */
  docs: readonly string[];
  /** undefined = it fits the model. */
  blocked(model: RecipeTemplateModel): TemplateBlock | undefined;
  /** What "Usa" copies into the model's recipe; `yarnTarget` = the YaRN context (default the first YARN_TARGETS above the trained context). */
  build(model: RecipeTemplateModel, opts?: { yarnTarget?: number }): Partial<Pick<ModelRecipe, 'contextSize' | 'ropeScaling' | 'draft' | 'mmproj' | 'engine' | 'args'>>;
}

/** vLLM MTP (the model's own multi-token-prediction head, no draft model): `vllm serve --speculative-config`. */
export const VLLM_MTP_ARGS = ['--speculative-config', '{"method":"mtp","num_speculative_tokens":1}'] as const;
/** SGLang MTP (docs: speculative decoding, MTP example): EAGLE with one step on the model's own head. */
export const SGLANG_MTP_ARGS = ['--speculative-algorithm', 'EAGLE', '--speculative-num-steps', '1', '--speculative-eagle-topk', '1', '--speculative-num-draft-tokens', '2'] as const;

/** The YaRN target "Usa" proposes: the first offered target above the trained context, else twice it. */
export function defaultYarnTarget(trained: number): number {
  return YARN_TARGETS.find((t) => t > trained) ?? trained * 2;
}

const hasAux = (m: RecipeTemplateModel, kinds: readonly string[]): boolean => (m.auxKinds ?? []).some((k) => kinds.includes(k));

/**
 * The built-in library. Wording (title, what it does, when to use it) is localized by the renderer
 * (recipes.library.<id>). Flags checked against llama-server --help (b10997: --rope-scaling, --rope-scale,
 * --yarn-orig-ctx, -md, --spec-type draft-mtp, --mmproj), vLLM's speculative decoding docs (method
 * "mtp") and SGLang's (EAGLE on the model's MTP head).
 */
export const RECIPE_TEMPLATES: readonly RecipeTemplate[] = [
  {
    id: 'yarn',
    parts: ['context', 'rope'],
    docs: ['https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md', 'https://docs.vllm.ai/en/latest/configuration/engine_args.html'],
    blocked: (m) => (m.trainedContext === undefined ? 'no_context' : undefined),
    build: (m, o) => {
      const trained = m.trainedContext as number;
      const target = o?.yarnTarget ?? defaultYarnTarget(trained);
      const rope = yarnScaling(target, trained);
      return rope ? { contextSize: target, ropeScaling: rope } : {};
    },
  },
  {
    id: 'mtp',
    parts: ['draft', 'args'],
    docs: ['https://docs.vllm.ai/en/latest/features/speculative_decoding/', 'https://docs.sglang.io/docs/advanced_features/speculative_decoding'],
    // A GGUF needs its MTP / draft file next to it; safetensors models carry the MTP head themselves.
    blocked: (m) => (m.format === 'safetensors' || hasAux(m, ['mtp', 'draft']) ? undefined : 'no_file'),
    build: () => ({ draft: DRAFT_AUTO, args: { vllm: [...VLLM_MTP_ARGS], sglang: [...SGLANG_MTP_ARGS] } }),
  },
  {
    id: 'prismml-bonsai',
    parts: ['engine'],
    docs: ['https://huggingface.co/prism-ml'],
    blocked: (m) => (templateForModel(m)?.id === 'prismml-bonsai' ? undefined : 'not_bonsai'),
    build: () => ({ engine: { type: 'template', template: 'prismml-bonsai' } }),
  },
  {
    id: 'vision',
    parts: ['mmproj'],
    docs: ['https://github.com/ggml-org/llama.cpp/blob/master/docs/multimodal.md'],
    blocked: (m) => (m.format === 'safetensors' ? 'format' : hasAux(m, ['mmproj']) ? undefined : 'no_file'),
    build: () => ({ mmproj: true }),
  },
];

export function recipeTemplate(id: string): RecipeTemplate | undefined {
  return RECIPE_TEMPLATES.find((t) => t.id === id);
}

/**
 * A model's recipe with a built-in recipe's settings added ("Usa"): what the built-in sets replaces
 * the same setting, everything else stays; the built-in joins `from`.
 */
export function withTemplate<R extends Pick<ModelRecipe, 'contextSize' | 'ropeScaling' | 'draft' | 'mmproj' | 'engine' | 'args' | 'from'>>(
  recipe: R,
  template: RecipeTemplate,
  model: RecipeTemplateModel,
  opts?: { yarnTarget?: number },
): R {
  const add = template.build(model, opts);
  const args: RecipeArgs = { ...recipe.args };
  for (const k of RECIPE_ARG_TARGETS) {
    const extra = add.args?.[k];
    if (!extra?.length) continue;
    // Its flags replace the same flags of the recipe.
    const theirs = new Set(argGroups(extra).map((g) => flagKey(g[0] as string)));
    const mine = argGroups(recipe.args[k] ?? []).filter((g) => !theirs.has(flagKey(g[0] as string)));
    args[k] = [...mine.flat(), ...extra];
  }
  const { args: _args, ...rest } = add;
  return { ...recipe, ...rest, args, from: [...new Set([...recipe.from, template.id])] };
}
