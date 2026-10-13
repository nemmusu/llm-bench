/**
 * "Comandi per questo modello" in the renderer, the pure part: which model a recipe screen is about
 * (a local model, a Benchmark choice, a Hugging Face repo), and a recipe or an applied recipe said in
 * words ("YaRN 300K · MTP · Fork PrismML").
 */
import type { StartServerRequest } from '../../../contract/api';
import type { CustomEngine } from '../../../contract/custom-engines';
import type { EngineKind } from '../../../contract/engines';
import type { LocalModel } from '../../../contract/models';
import {
  DRAFT_AUTO,
  recipeCustomEngine,
  RECIPE_ARG_TARGETS,
  type AppliedRecipe,
  type ModelRecipe,
  type RecipeModel,
  type RecipeModelRef,
  type RecipeTemplateModel,
} from '../../../contract/recipes';
import type { Formatters } from '../../i18n';
import type { ModelOption } from '../bench/model-options';
import { depthLabel } from '../tune/tune-format';

/** What a recipe screen needs to know about one model. */
export interface RecipeTarget {
  /** "Qwen3 8B · Q4_K_M": the model in words. */
  label: string;
  /** What matching looks at. */
  ref: RecipeModelRef;
  /** What the built-in recipes look at. */
  template: RecipeTemplateModel;
  /** "Solo questo modello": the exact entry a new recipe names. */
  entry: RecipeModel;
  /** The model as a request names it (command previews). */
  request: StartServerRequest['model'];
  /** Engines a command preview is shown for (the first is the usual one). */
  engines: EngineKind[];
  /** Files the library groups with the model. */
  aux: LocalModel['auxiliary'];
}

/** The engines that read a format, the usual one first. */
export function previewEngines(format: string | undefined): EngineKind[] {
  if (format === 'safetensors') return ['vllm-docker', 'sglang-docker'];
  if (format === 'ninfer') return ['ninfer-native'];
  return ['llamacpp-native'];
}

const fileName = (p: string | undefined): string | undefined => p?.split(/[\\/]/).pop();

/** A model of the library ("Sul tuo PC"). */
export function targetOfLocal(m: LocalModel, label = m.identity.displayName): RecipeTarget {
  const id = m.identity;
  const ref: RecipeModelRef = { displayName: id.displayName, repo: id.repo, file: id.file, quant: id.quant, sha256: id.sha256, weakKey: id.weakKey };
  return {
    label,
    ref,
    template: { ...ref, format: id.format, trainedContext: id.facts?.contextLength, auxKinds: m.auxiliary.map((a) => a.kind) },
    entry: {
      label: [label, id.quant].filter(Boolean).join(' · '),
      weakKey: id.weakKey,
      ...(id.sha256 ? { sha256: id.sha256 } : {}),
      ...(id.repo ? { repo: id.repo } : {}),
      ...(id.repo && id.file ? { file: id.file } : {}),
    },
    request: { localId: m.id },
    engines: previewEngines(id.format),
    aux: m.auxiliary,
  };
}

/** A Benchmark choice: a model of the library, or a suggestion to download. */
export function targetOfOption(o: ModelOption): RecipeTarget {
  if (o.source === 'local') return targetOfLocal(o.local, o.name);
  const c = o.curated;
  const weakKey = c.file === undefined ? `${c.repo}@${c.revision}` : undefined;
  const ref: RecipeModelRef = { displayName: o.name, repo: c.repo, file: c.file, quant: c.quant, sha256: c.sha256, weakKey };
  const format = c.engine === 'vllm' ? 'safetensors' : 'gguf';
  return {
    label: o.name,
    ref,
    template: { ...ref, format },
    entry: { label: `${o.name} · ${c.quant}`, repo: c.repo, ...(c.file ? { file: c.file } : {}), ...(c.sha256 ? { sha256: c.sha256 } : {}) },
    request: c.file === undefined ? { repo: c.repo, revision: c.revision } : { repo: c.repo, file: c.file, revision: c.revision },
    engines: previewEngines(format),
    aux: [],
  };
}

export interface HubTargetInput {
  repo: string;
  /** The weights a preview starts (the preselected quant), when the repo has GGUF files. */
  file?: string | undefined;
  quant?: string | undefined;
  format: 'gguf' | 'safetensors' | 'ninfer';
  trainedContext?: number | undefined;
  /** Auxiliary files the repo has (mmproj, mtp, draft). */
  auxKinds?: readonly ('mmproj' | 'mtp' | 'draft' | 'other')[];
}

/** A Hugging Face repo (the model page): every file of the repo, so one recipe covers all its quants. */
export function targetOfHub(h: HubTargetInput): RecipeTarget {
  const name = h.repo.split('/').pop() as string;
  const ref: RecipeModelRef = { displayName: name, repo: h.repo, file: h.file, quant: h.quant };
  return {
    label: name,
    ref,
    template: { ...ref, format: h.format, trainedContext: h.trainedContext, auxKinds: h.auxKinds ?? [] },
    entry: { label: name, repo: h.repo },
    request: h.file && h.format === 'gguf' ? { repo: h.repo, file: h.file } : { repo: h.repo },
    engines: previewEngines(h.format),
    aux: [],
  };
}

type F = Pick<Formatters, 't' | 'integer' | 'number'>;

/** The custom engines and the model a recipe's engine is resolved against. */
export interface PartsContext {
  customEngines: readonly CustomEngine[];
  /** The model's auxiliary files: "MTP" when its draft file is an MTP one. */
  aux?: LocalModel['auxiliary'];
  ref?: RecipeModelRef | undefined;
}

/** The name of a built-in template's engine ("Fork PrismML"). */
export function templateEngineName(template: string, f: Pick<Formatters, 't'>): string {
  return template === 'prismml-bonsai' ? f.t('recipes.templateNames.prismml-bonsai') : template;
}

/** A recipe in words, part by part: "YaRN 300K", "MTP", "Fork PrismML", "2 argomenti". */
export function recipeParts(r: Pick<ModelRecipe, 'contextSize' | 'ropeScaling' | 'draft' | 'mmproj' | 'engine' | 'args' | 'env'>, f: F, o: PartsContext): string[] {
  const { t } = f;
  const parts: string[] = [];
  if (r.engine?.type === 'builtin') parts.push(t('recipes.parts.engine', { name: t(`benchmark.engines.${r.engine.kind}`) }));
  else if (r.engine) {
    const custom = recipeCustomEngine(r.engine, o.customEngines, o.ref);
    const name = custom?.name ?? (r.engine.type === 'template' ? templateEngineName(r.engine.template, f) : r.engine.id);
    parts.push(t(custom ? 'recipes.parts.engine' : 'recipes.parts.engineMissing', { name }));
  }
  const rope = r.ropeScaling;
  if (rope && r.contextSize !== undefined) parts.push(t(rope.type === 'yarn' ? 'recipes.parts.yarn' : 'recipes.parts.linear', { ctx: depthLabel(r.contextSize, f), factor: f.number(rope.factor, 2) }));
  else if (rope) parts.push(t(rope.type === 'yarn' ? 'recipes.parts.ropeOnly' : 'recipes.parts.linear', { factor: f.number(rope.factor, 2) }));
  else if (r.contextSize !== undefined) parts.push(t('recipes.parts.context', { ctx: depthLabel(r.contextSize, f) }));
  if (r.draft !== undefined) {
    const mtp = r.draft === DRAFT_AUTO ? !(o.aux ?? []).some((a) => a.kind === 'draft') : /mtp/i.test(fileName(r.draft) ?? '');
    parts.push(t(mtp ? 'recipes.parts.mtp' : 'recipes.parts.draft'));
  }
  if (r.mmproj) parts.push(t('recipes.parts.mmproj'));
  const args = RECIPE_ARG_TARGETS.reduce((n, k) => n + (r.args[k] ?? []).length, 0);
  if (args) parts.push(args === 1 ? t('recipes.parts.args1') : t('recipes.parts.args', { n: args }));
  const env = Object.keys(r.env).length;
  if (env) parts.push(env === 1 ? t('recipes.parts.env1') : t('recipes.parts.env', { n: env }));
  return parts;
}

/** Who a recipe is for, in words. */
export function scopeText(r: Pick<ModelRecipe, 'match'>, f: Pick<Formatters, 't'>): string {
  const { name, quant, models } = r.match;
  if (name !== undefined && quant !== undefined) return f.t('recipes.scope.nameQuant', { name, quant });
  if (name !== undefined) return f.t('recipes.scope.name', { name });
  if (quant !== undefined) return f.t('recipes.scope.quant', { quant });
  return models.length === 1 ? f.t('recipes.scope.model') : f.t('recipes.scope.models', { n: models.length });
}

/** What a run or server applied, in words: "Usa i comandi «X»: YaRN 300K · MTP", and what was replaced or left out. */
export function appliedLines(a: AppliedRecipe, f: Pick<Formatters, 't' | 'integer' | 'number'>): { line: string; overridden?: string; skipped?: string } {
  const { t } = f;
  const partName = (p: AppliedRecipe['parts'][number]) => t(`recipes.applied.partNames.${p}`);
  const said: string[] = [];
  if (a.engine) said.push(a.engine.kind ? t(`benchmark.engines.${a.engine.kind}`) : a.engine.name);
  if (a.ropeScaling && a.contextSize !== undefined) said.push(t('recipes.parts.yarn', { ctx: depthLabel(a.contextSize, f) }));
  else if (a.ropeScaling) said.push(t('recipes.parts.ropeOnly', { factor: f.number(a.ropeScaling.factor, 2) }));
  else if (a.contextSize !== undefined) said.push(t('recipes.parts.context', { ctx: depthLabel(a.contextSize, f) }));
  for (const p of a.parts) if (p !== 'engine' && p !== 'context' && p !== 'rope') said.push(partName(p));
  const line = said.length ? t('recipes.applied.line', { name: a.name, parts: said.join(' · ') }) : t('recipes.applied.lineEmpty', { name: a.name });
  const replaced = a.overridden.map((o) => (o === 'context' || o === 'rope' ? partName(o) : o.startsWith('env:') ? o.slice(4) : o));
  const skipped = a.skipped.filter((s) => s.reason !== 'user').map((s) => t(`recipes.applied.skip.${s.reason}`, { part: partName(s.part) }));
  return {
    line,
    ...(replaced.length ? { overridden: t('recipes.applied.overridden', { list: replaced.join(', ') }) } : {}),
    ...(skipped.length ? { skipped: t('recipes.applied.skipped', { list: skipped.join(', ') }) } : {}),
  };
}

/** "/engines?customTemplate=…": the Engines page's dialog for a template's custom engine, filled in for this model. */
export function templateEngineLink(template: string, target: Pick<RecipeTarget, 'ref' | 'label'>): string {
  const q = new URLSearchParams({ customTemplate: template, ...(target.ref.weakKey ? { model: target.ref.weakKey } : {}), modelName: target.label });
  return `/engines?${q.toString()}`;
}
