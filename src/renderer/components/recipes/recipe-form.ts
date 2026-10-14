/**
 * The recipe editor's form ⇄ a recipe. Fields are text while the user types; empty means "not set";
 * an invalid field is reported and blocks saving. Arguments are split like a command line
 * (contract/custom-engines.ts splitCommandLine: quotes group, no shell). Also: which engines the editor
 * offers for a model, and the arguments it adds with one click.
 */
import { customBaseReads, splitCommandLine, type CustomEngineBase } from '../../../contract/custom-engines';
import type { EngineKind, RopeScaling } from '../../../contract/engines';
import { engineRunsFormat, FORMAT_ENGINE_BASES, type ModelFormatId } from '../../../contract/ninfer';
import {
  argGroups,
  DRAFT_AUTO,
  modelEntryRank,
  modelRecipeDraftSchema,
  RECIPE_ARG_TARGETS,
  SGLANG_MTP_ARGS,
  textMatcher,
  VLLM_MTP_ARGS,
  yarnScaling,
  YARN_TARGETS,
  type ModelRecipe,
  type ModelRecipeDraft,
  type RecipeArgTarget,
  type RecipeEngine,
  type RecipeModel,
} from '../../../contract/recipes';
import { parseEnv, parseInteger } from '../bench/expert-form';
import type { RecipeTarget } from './recipe-model';

export type ContextMode = 'auto' | 'yarn' | 'fixed';
export type DraftMode = 'none' | 'auto' | 'file';

export interface RecipeForm {
  name: string;
  scope: 'model' | 'pattern';
  pattern: string;
  quant: string;
  /** The exact models of an existing recipe (kept when the scope stays "this model"). */
  models: RecipeModel[];
  context: ContextMode;
  /** YaRN: the context to reach and the trained one it starts from, tokens. */
  yarnTarget: string;
  yarnOriginal: string;
  contextSize: string;
  draft: DraftMode;
  draftFile: string;
  mmproj: boolean;
  /** 'default' | 'builtin:<kind>' | 'custom:<id>' | 'template:<id>'. */
  engine: string;
  args: Record<RecipeArgTarget, string>;
  env: string;
  notes: string;
  link: string;
  from: string[];
}

export type RecipeField = 'name' | 'pattern' | 'yarnTarget' | 'yarnOriginal' | 'contextSize' | 'draftFile' | 'env' | 'notes' | 'link' | `args.${RecipeArgTarget}`;

/**
 * An argument as typed back: a JSON value (double quotes inside) between single quotes, one with spaces
 * or an apostrophe between double quotes; one holding both kinds of quote cannot be written back.
 */
export function showArg(a: string): string {
  if (a.includes('"')) return a.includes("'") ? a : `'${a}'`;
  return /[\s']/.test(a) ? `"${a}"` : a;
}
const showArgs = (args: readonly string[] | undefined): string => (args ?? []).map(showArg).join(' ');
const num = (n: number | undefined): string => (n === undefined ? '' : String(n));

export function engineValue(e: RecipeEngine | undefined): string {
  if (!e) return 'default';
  if (e.type === 'builtin') return `builtin:${e.kind}`;
  return e.type === 'custom' ? `custom:${e.id}` : `template:${e.template}`;
}

export function engineOfValue(v: string): RecipeEngine | undefined {
  const at = v.indexOf(':');
  const type = v.slice(0, at);
  const rest = v.slice(at + 1);
  if (type === 'builtin') return { type: 'builtin', kind: rest as Extract<RecipeEngine, { type: 'builtin' }>['kind'] };
  if (type === 'custom') return { type: 'custom', id: rest };
  if (type === 'template') return { type: 'template', template: rest };
  return undefined;
}

/** The form of a recipe being edited (or of a new one for `target`). */
export function formOfRecipe(r: Partial<ModelRecipe> | undefined, target: RecipeTarget): RecipeForm {
  const match = r?.match;
  const pattern = match !== undefined && (match.name !== undefined || match.quant !== undefined);
  const rope = r?.ropeScaling;
  const trained = target.template.trainedContext;
  const context: ContextMode = rope?.type === 'yarn' ? 'yarn' : r?.contextSize !== undefined ? 'fixed' : 'auto';
  const draft: DraftMode = r?.draft === undefined ? 'none' : r.draft === DRAFT_AUTO ? 'auto' : 'file';
  return {
    name: r?.name ?? target.label,
    scope: pattern ? 'pattern' : 'model',
    pattern: match?.name ?? '',
    quant: match?.quant ?? '',
    models: match?.models ?? [],
    context,
    // A YaRN recipe always has its RoPE scaling; without a context its target is factor × original.
    yarnTarget: context === 'yarn' ? num(r?.contextSize ?? Math.round((rope as RopeScaling).factor * (rope as RopeScaling).originalContext)) : String(YARN_TARGETS[0]),
    yarnOriginal: num(rope?.originalContext ?? trained),
    contextSize: context === 'fixed' ? num(r?.contextSize) : '',
    draft,
    draftFile: draft === 'file' ? (r?.draft as string) : '',
    mmproj: r?.mmproj === true,
    engine: engineValue(r?.engine),
    args: Object.fromEntries(RECIPE_ARG_TARGETS.map((k) => [k, showArgs(r?.args?.[k])])) as Record<RecipeArgTarget, string>,
    env: Object.entries(r?.env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
    notes: r?.notes ?? '',
    link: r?.link ?? '',
    from: r?.from ?? [],
  };
}

/** The form field of a recipe key the schema refused (anything else: the name). */
const SCHEMA_FIELDS: Readonly<Record<string, RecipeField>> = { match: 'pattern', env: 'env', notes: 'notes', draft: 'draftFile', link: 'link' };

function isUrl(text: string): boolean {
  try {
    const u = new URL(text);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * The recipe a form describes, or the fields that are not valid. "This model": the recipe's own exact
 * models when they include it, else the target alone.
 */
export function recipeOfForm(form: RecipeForm, target: RecipeTarget): { draft?: ModelRecipeDraft; invalid: RecipeField[] } {
  const invalid: RecipeField[] = [];
  const name = form.name.trim();
  if (!name) invalid.push('name');
  const pattern = form.pattern.trim();
  const quant = form.quant.trim();
  if (form.scope === 'pattern' && ((!pattern && !quant) || (pattern && !textMatcher(pattern)) || (quant && !textMatcher(quant)))) invalid.push('pattern');
  const keep = form.models.some((m) => modelEntryRank(m, target.ref) > 0);
  const models = form.scope === 'model' ? (keep ? form.models : [target.entry]) : [];
  const out: ModelRecipeDraft = {
    name,
    match: { models, ...(form.scope === 'pattern' && pattern ? { name: pattern } : {}), ...(form.scope === 'pattern' && quant ? { quant } : {}) },
    args: {},
    env: {},
    notes: form.notes.trim(),
    from: form.from,
  };
  if (form.context === 'yarn') {
    const ctx = parseInteger(form.yarnTarget);
    const orig = parseInteger(form.yarnOriginal);
    if (orig === null) invalid.push('yarnOriginal');
    const rope = ctx !== null && orig !== null ? yarnScaling(ctx, orig) : undefined;
    if (!rope) invalid.push('yarnTarget');
    else {
      out.contextSize = ctx as number;
      out.ropeScaling = rope;
    }
  } else if (form.context === 'fixed') {
    const ctx = parseInteger(form.contextSize, 1024);
    if (ctx === null) invalid.push('contextSize');
    else out.contextSize = ctx;
  }
  if (form.draft === 'auto') out.draft = DRAFT_AUTO;
  else if (form.draft === 'file') {
    if (!form.draftFile.trim()) invalid.push('draftFile');
    else out.draft = form.draftFile.trim();
  }
  if (form.mmproj) out.mmproj = true;
  const engine = engineOfValue(form.engine);
  if (engine) out.engine = engine;
  const args: NonNullable<ModelRecipeDraft['args']> = {};
  for (const k of RECIPE_ARG_TARGETS) {
    const list = splitCommandLine(form.args[k]);
    if (list === undefined) invalid.push(`args.${k}`);
    else if (list.length) args[k] = list;
  }
  out.args = args;
  const env = parseEnv(form.env);
  if (env.invalid.length) invalid.push('env');
  out.env = env.env;
  const link = form.link.trim();
  if (link && !isUrl(link)) invalid.push('link');
  else if (link) out.link = link;
  if (invalid.length) return { invalid };
  // The schema has the last word (lengths, names of variables…): what it refuses is said on its field.
  const parsed = modelRecipeDraftSchema.safeParse(out);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i): RecipeField => {
      const key = String(i.path[0]);
      if (key === 'args') return `args.${String(i.path[1])}` as RecipeField;
      return SCHEMA_FIELDS[key] ?? 'name';
    });
    return { invalid: [...new Set(fields)] };
  }
  return { draft: out, invalid };
}

// ---- which engines the editor offers ----------------------------------------------------------------

/** The engine base each target's arguments are written for (a program: an OpenAI-compatible server started from a command). */
const TARGET_BASE: Readonly<Record<RecipeArgTarget, CustomEngineBase>> = { llamacpp: 'llamacpp', vllm: 'vllm', sglang: 'sglang', ninfer: 'ninfer', command: 'openai-server' };

/**
 * An engine base is worth offering in the editor: it reads the model's format (unknown: any). A recipe
 * for a family offers every engine: its models can come in several formats.
 */
export function baseFits(base: CustomEngineBase, format: string | undefined, family: boolean): boolean {
  return family || customBaseReads(base, format);
}

/** The same for one of LLM Bench's own engines (TensorRT-LLM among them, which no custom engine is built on). */
export function kindFits(kind: EngineKind, format: string | undefined, family: boolean): boolean {
  return family || format === undefined || (format in FORMAT_ENGINE_BASES && engineRunsFormat(kind, format as ModelFormatId));
}

/**
 * The engines whose own arguments the editor offers: those that can run the model, "Programma" only
 * when a program is saved, and any that already has arguments (never hidden).
 */
export function argTargetsFor(form: Pick<RecipeForm, 'scope' | 'args'>, format: string | undefined, hasProgram: boolean): RecipeArgTarget[] {
  const family = form.scope === 'pattern';
  return RECIPE_ARG_TARGETS.filter((k) => form.args[k].trim() !== '' || ((k !== 'command' || hasProgram) && baseFits(TARGET_BASE[k], format, family)));
}

// ---- one-click arguments ----------------------------------------------------------------------------

export type ArgSuggestionId = 'jinja' | 'noThinking' | 'noMmap' | 'trustRemoteCode' | 'noCudaGraph' | 'mtp' | 'vision';

/**
 * An argument the editor adds with one click. Only flags LLM Bench does not set itself: the context,
 * the KV cache and the like stay with the tuner and expert mode (a recipe's arguments would win over them).
 */
export interface ArgSuggestion {
  id: ArgSuggestionId;
  args: readonly string[];
}

export const ARG_SUGGESTIONS: Readonly<Record<RecipeArgTarget, readonly ArgSuggestion[]>> = {
  llamacpp: [
    { id: 'jinja', args: ['--jinja'] },
    { id: 'noThinking', args: ['--chat-template-kwargs', '{"enable_thinking":false}'] },
    { id: 'noMmap', args: ['--no-mmap'] },
  ],
  vllm: [
    { id: 'trustRemoteCode', args: ['--trust-remote-code'] },
    { id: 'noCudaGraph', args: ['--enforce-eager'] },
    { id: 'mtp', args: VLLM_MTP_ARGS },
  ],
  sglang: [
    { id: 'trustRemoteCode', args: ['--trust-remote-code'] },
    { id: 'noCudaGraph', args: ['--disable-cuda-graph'] },
    { id: 'mtp', args: SGLANG_MTP_ARGS },
  ],
  ninfer: [
    { id: 'vision', args: ['--vision'] },
    { id: 'noThinking', args: ['--no-thinking'] },
  ],
  command: [],
};

/** The suggestion's flag is in the arguments (with any value); undefined while a quote is open. */
export function argPresent(text: string, s: ArgSuggestion): boolean | undefined {
  return splitCommandLine(text)?.includes(s.args[0] as string);
}

/**
 * The arguments with the suggestion added after the ones typed (kept as typed), or taken out when its
 * flag is there: the flag alone, or with the values after it when it takes some. Undefined while a
 * quote is open.
 */
export function toggleArg(text: string, s: ArgSuggestion): string | undefined {
  const list = splitCommandLine(text);
  if (list === undefined) return undefined;
  const flag = s.args[0] as string;
  if (!list.includes(flag)) return [text.trimEnd(), showArgs(s.args)].filter(Boolean).join(' ');
  return showArgs(argGroups(list).flatMap((g) => (g[0] !== flag ? g : s.args.length === 1 ? g.slice(1) : [])));
}
