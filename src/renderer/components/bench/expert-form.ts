/**
 * Expert mode form ⇄ LaunchParams / Scenario. Fields are kept as text while the user types;
 * an empty field means "let LLM Bench decide" (undefined), an invalid one is reported and ignored.
 */
import type { LaunchParams } from '../../../contract/engines';
import { yarnScaling } from '../../../contract/recipes';
import type { Scenario, Step } from '../../../contract/results';

export interface ParamsForm {
  contextSize: string;
  gpuLayers: string;
  flashAttention: 'default' | 'auto' | 'on' | 'off';
  /** 'default', f16 / q8_0 / q4_0, or a type the fork lists (turbo3…: kv-cache-options.ts). */
  kvCacheType: string;
  batchSize: string;
  ubatchSize: string;
  threads: string;
  parallel: string;
  gpuMemoryUtilization: string;
  maxModelLen: string;
  dtype: string;
  quantization: string;
  extraArgs: string;
  env: string;
  /**
   * "Contesto oltre il limite del modello (YaRN)": the context to reach, tokens ('' = no), and the
   * trained context it starts from ('' = the model's own).
   */
  yarnTarget: string;
  yarnOriginal: string;
}

export const EMPTY_PARAMS_FORM: ParamsForm = {
  contextSize: '',
  gpuLayers: '',
  flashAttention: 'default',
  kvCacheType: 'default',
  batchSize: '',
  ubatchSize: '',
  threads: '',
  parallel: '',
  gpuMemoryUtilization: '',
  maxModelLen: '',
  dtype: '',
  quantization: '',
  extraArgs: '',
  env: '',
  yarnTarget: '',
  yarnOriginal: '',
};

export type ParamsField = keyof ParamsForm;

/** Positive integer (thousand separators and spaces allowed), or null when invalid. */
export function parseInteger(text: string, min = 1): number | null {
  const clean = text.replace(/[\s.'’_]/g, '');
  if (!/^\d+$/.test(clean)) return null;
  const n = Number(clean);
  return n >= min ? n : null;
}

/** "0,9" / "0.9" / "90%" → 0.9 within 0.1..0.99, or null. */
export function parseRatio(text: string): number | null {
  const t = text.trim().replace(',', '.');
  const pct = t.endsWith('%');
  const n = Number(pct ? t.slice(0, -1) : t);
  if (!Number.isFinite(n) || t === '' || t === '%') return null;
  const v = pct || n > 1 ? n / 100 : n;
  return v >= 0.1 && v <= 0.99 ? Math.round(v * 100) / 100 : null;
}

/** One argument per line; a line may hold "--flag value" (split on spaces outside quotes). */
export function parseArgs(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    for (const m of line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]!);
  }
  return out;
}

/** "NAME=value" lines → record; returns the invalid lines too. */
export function parseEnv(text: string): { env: Record<string, string>; invalid: string[] } {
  const env: Record<string, string> = {};
  const invalid: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (m) env[m[1]!] = m[2]!.trim();
    else invalid.push(line.trim());
  }
  return { env, invalid };
}

export interface ParsedParams {
  params: LaunchParams;
  invalid: ParamsField[];
}

/**
 * The launch params of the form. YaRN sets the context (llama.cpp ctx-size and vLLM max-model-len) to
 * its target, and RoPE scaling at factor target / trained context (`trainedContext` = the model's).
 */
export function paramsFromForm(form: ParamsForm, opts: { trainedContext?: number | undefined } = {}): ParsedParams {
  const params: LaunchParams = { extraArgs: parseArgs(form.extraArgs), env: {} };
  const invalid: ParamsField[] = [];
  const int = (field: 'contextSize' | 'batchSize' | 'ubatchSize' | 'threads' | 'parallel' | 'maxModelLen', min = 1) => {
    const text = form[field].trim();
    if (!text) return;
    const n = parseInteger(text, min);
    if (n === null) invalid.push(field);
    else params[field] = n;
  };
  int('contextSize');
  int('batchSize');
  int('ubatchSize');
  int('threads');
  int('parallel');
  int('maxModelLen');
  const ngl = form.gpuLayers.trim();
  if (ngl) {
    const n = parseInteger(ngl, 0);
    if (n === null) invalid.push('gpuLayers');
    else params.gpuLayers = n;
  }
  if (form.flashAttention !== 'default') params.flashAttention = form.flashAttention;
  if (form.kvCacheType !== 'default') params.kvCacheType = form.kvCacheType;
  const util = form.gpuMemoryUtilization.trim();
  if (util) {
    const r = parseRatio(util);
    if (r === null) invalid.push('gpuMemoryUtilization');
    else params.gpuMemoryUtilization = r;
  }
  if (form.dtype.trim()) params.dtype = form.dtype.trim();
  if (form.quantization.trim()) params.quantization = form.quantization.trim();
  const env = parseEnv(form.env);
  params.env = env.env;
  if (env.invalid.length) invalid.push('env');
  if (form.yarnTarget.trim()) {
    const target = parseInteger(form.yarnTarget);
    const original = form.yarnOriginal.trim() ? parseInteger(form.yarnOriginal) : (opts.trainedContext ?? null);
    const rope = target !== null && original !== null ? yarnScaling(target, original) : undefined;
    if (!rope) invalid.push('yarnTarget');
    else {
      params.ropeScaling = rope;
      params.contextSize = target as number;
      params.maxModelLen = target as number;
    }
  }
  return { params, invalid };
}

/** Shows an argument back in the textarea, quoting it when it contains spaces. */
const showArg = (a: string) => (/\s/.test(a) ? `"${a}"` : a);

export function formFromParams(p: LaunchParams | undefined): ParamsForm {
  if (!p) return { ...EMPTY_PARAMS_FORM };
  const s = (n: number | undefined) => (n === undefined ? '' : String(n));
  // YaRN carries its own context: the context fields stay empty.
  const yarn = p.ropeScaling?.type === 'yarn' ? (p.contextSize ?? p.maxModelLen ?? Math.round(p.ropeScaling.factor * p.ropeScaling.originalContext)) : undefined;
  return {
    contextSize: yarn === undefined ? s(p.contextSize) : '',
    gpuLayers: s(p.gpuLayers),
    flashAttention: p.flashAttention ?? 'default',
    kvCacheType: p.kvCacheType ?? 'default',
    batchSize: s(p.batchSize),
    ubatchSize: s(p.ubatchSize),
    threads: s(p.threads),
    parallel: s(p.parallel),
    gpuMemoryUtilization: s(p.gpuMemoryUtilization),
    maxModelLen: yarn === undefined ? s(p.maxModelLen) : '',
    dtype: p.dtype ?? '',
    quantization: p.quantization ?? '',
    extraArgs: p.extraArgs.map(showArg).join('\n'),
    env: Object.entries(p.env)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
    yarnTarget: s(yarn),
    yarnOriginal: yarn === undefined ? '' : s(p.ropeScaling?.originalContext),
  };
}

/** True when the parameters say anything beyond the defaults (expert mode is needed to show them). */
export function hasCustomParams(p: LaunchParams | undefined): boolean {
  if (!p) return false;
  return Object.entries(p).some(([k, v]) => (k === 'extraArgs' ? (v as string[]).length > 0 : k === 'env' ? Object.keys(v as object).length > 0 : v !== undefined));
}

// ---- custom scenario ----------------------------------------------------------------------------

export interface ScenarioForm {
  coldReps: string;
  warmReps: string;
  promptTokens: string;
  outputTokens: string;
  warmup: string;
  reps: string;
  concurrency: string;
  requestsPerWorker: string;
  /** "Conversazioni lunghe": conversations at once ("2" = 1 and 2; empty = not measured), first-message depth (empty = the whole context), messages each. */
  sessions: string;
  sessionsDepth: string;
  sessionsTurns: string;
  llamaBench: boolean;
}

export type ScenarioField = keyof ScenarioForm;

export const DEFAULT_SCENARIO_FORM: ScenarioForm = {
  coldReps: '1',
  warmReps: '3',
  promptTokens: '512, 4096',
  outputTokens: '256',
  warmup: '1',
  reps: '5',
  concurrency: '4',
  requestsPerWorker: '4',
  sessions: '',
  sessionsDepth: '',
  sessionsTurns: '4',
  llamaBench: false,
};

/** New text of every later message and answer length of the long conversations made by the form. */
export const FORM_SESSIONS = { followupTokens: 256, outputTokens: 256 } as const;

/** "4096, 512" → [512, 4096]: smallest first, each once; null when any item is not a positive integer. */
export function parseList(text: string): number[] | null {
  const items = text.split(/[,;\s]+/).filter(Boolean);
  const nums = items.map((i) => parseInteger(i));
  return nums.some((n) => n === null) ? null : [...new Set(nums as number[])].sort((a, b) => a - b);
}

/** "4" → 1, 2, 3, 4 (every step up to that many users); a list is taken as written. */
export function parseUsers(text: string): number[] | null {
  const l = parseList(text);
  return l?.length === 1 ? Array.from({ length: l[0]! }, (_, i) => i + 1) : l;
}

/** 1, 2, 3, 4 shows back as "4"; any other set of levels as a list. */
export function showUsers(levels: readonly number[]): string {
  const upTo = levels.length > 1 && levels.every((l, i) => l === i + 1);
  return upTo ? String(levels.length) : levels.join(', ');
}

export function scenarioFromForm(form: ScenarioForm, seed = 42): { scenario: Scenario; invalid: ScenarioField[] } {
  const invalid: ScenarioField[] = [];
  const int = (field: ScenarioField, min: number): number | undefined => {
    const text = (form[field] as string).trim();
    if (!text) return undefined;
    const n = parseInteger(text, min);
    if (n === null) invalid.push(field);
    return n ?? undefined;
  };
  const list = (field: 'promptTokens' | 'concurrency' | 'sessions'): number[] => {
    const text = form[field].trim();
    if (!text) return [];
    const l = field === 'promptTokens' ? parseList(text) : parseUsers(text);
    if (!l) invalid.push(field);
    return l ?? [];
  };
  const steps: Step[] = [];
  const cold = int('coldReps', 0);
  const warm = int('warmReps', 0);
  if (cold) steps.push({ kind: 'load', cache: 'cold', reps: cold });
  if (warm) steps.push({ kind: 'load', cache: 'warm', reps: warm });
  const prompts = list('promptTokens');
  const output = int('outputTokens', 1) ?? 256;
  const warmup = int('warmup', 0) ?? 1;
  const reps = int('reps', 1) ?? 5;
  if (prompts.length) steps.push({ kind: 'latency', promptTokens: prompts, outputTokens: output, warmup, reps });
  const levels = list('concurrency');
  const perWorker = int('requestsPerWorker', 1) ?? 4;
  if (levels.length) steps.push({ kind: 'concurrency', levels, promptTokens: prompts[0] ?? 512, outputTokens: Math.min(output, 128), requestsPerWorker: perWorker });
  const sessions = list('sessions');
  const depth = int('sessionsDepth', 1) ?? 0;
  const turns = int('sessionsTurns', 1) ?? 4;
  if (sessions.length) steps.push({ kind: 'sessions', depth, levels: sessions, turns, ...FORM_SESSIONS });
  if (form.llamaBench) steps.push({ kind: 'llama-bench', pp: 512, tg: 128, reps: 5 });
  return { scenario: { profile: 'custom', seed, steps }, invalid };
}

export function formFromScenario(s: Scenario | undefined): ScenarioForm {
  if (!s) return { ...DEFAULT_SCENARIO_FORM };
  const form: ScenarioForm = { ...DEFAULT_SCENARIO_FORM, coldReps: '0', warmReps: '0', promptTokens: '', concurrency: '', sessions: '', llamaBench: false };
  for (const step of s.steps) {
    if (step.kind === 'load') form[step.cache === 'cold' ? 'coldReps' : 'warmReps'] = String(step.reps);
    else if (step.kind === 'latency') {
      form.promptTokens = step.promptTokens.join(', ');
      form.outputTokens = String(step.outputTokens);
      form.warmup = String(step.warmup);
      form.reps = String(step.reps);
    } else if (step.kind === 'concurrency') {
      form.concurrency = showUsers(step.levels);
      form.requestsPerWorker = String(step.requestsPerWorker);
    } else if (step.kind === 'sessions') {
      form.sessions = showUsers(step.levels);
      form.sessionsDepth = step.depth > 0 ? String(step.depth) : '';
      form.sessionsTurns = String(step.turns);
    } else if (step.kind === 'llama-bench') form.llamaBench = true;
  }
  return form;
}
