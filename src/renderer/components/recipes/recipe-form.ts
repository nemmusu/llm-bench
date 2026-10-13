/**
 * The recipe editor's form ⇄ a recipe. Fields are text while the user types; empty means "not set";
 * an invalid field is reported and blocks saving. Arguments are split like a command line
 * (contract/custom-engines.ts splitCommandLine: quotes group, no shell).
 */
import { splitCommandLine } from '../../../contract/custom-engines';
import {
  DRAFT_AUTO,
  modelEntryRank,
  modelRecipeDraftSchema,
  RECIPE_ARG_TARGETS,
  textMatcher,
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

/** An argument shown back in its textarea: quoted when it holds spaces. */
const showArg = (a: string): string => (/\s/.test(a) ? `"${a}"` : a);
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
    yarnTarget: context === 'yarn' ? num(r?.contextSize ?? Math.round((rope?.factor ?? 1) * (rope?.originalContext ?? 0))) : String(YARN_TARGETS[0]),
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
      if (key === 'match') return 'pattern';
      if (key === 'args') return `args.${String(i.path[1])}` as RecipeField;
      return key === 'env' || key === 'notes' || key === 'draft' ? (key === 'draft' ? 'draftFile' : key) : 'name';
    });
    return { invalid: [...new Set(fields)] };
  }
  return { draft: out, invalid };
}
