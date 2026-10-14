/**
 * Expert mode form ⇄ LaunchParams / Scenario. Fields are kept as text while the user types;
 * an empty field means "let LLM Bench decide" (undefined), an invalid one is reported and stops the start until fixed.
 */
import type { EngineBase, LaunchParams, NinferParams, NinferSpec, TrtllmParams } from '../../../contract/engines';
import { NINFER_MAX_CONCURRENCY } from '../../../contract/ninfer';
import { yarnScaling } from '../../../contract/recipes';
import type { Scenario, Step } from '../../../contract/results';
import { fieldsOf } from './launch-fields';
import type { ParamsField, ParamsForm, Tri } from './params-form';

export type { ParamsField, ParamsForm, Tri } from './params-form';

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
  ninferKvCapacity: '',
  ninferKvDtype: '',
  ninferSpec: 'default',
  ninferDraftTokens: '',
  ninferLmHeadDraft: 'default',
  ninferVision: 'default',
  ninferPrefixReuse: 'default',
  ninferDeviceStateSlots: '',
  ninferHostStateSlots: '',
  ninferHostKvMib: '',
  ninferThinking: 'default',
  ninferPreserveThinking: 'default',
  vision: 'default',
  reasoning: 'default',
  trtllmKvMemory: '',
  trtllmTp: '',
  trtllmTrustRemoteCode: 'default',
};

/** The fields of NInfer's own settings (LaunchParams.ninfer). */
export const NINFER_FORM_FIELDS = [
  'ninferKvCapacity',
  'ninferKvDtype',
  'ninferSpec',
  'ninferDraftTokens',
  'ninferLmHeadDraft',
  'ninferVision',
  'ninferPrefixReuse',
  'ninferDeviceStateSlots',
  'ninferHostStateSlots',
  'ninferHostKvMib',
  'ninferThinking',
  'ninferPreserveThinking',
] as const satisfies readonly (keyof ParamsForm)[];
export type NinferFormField = (typeof NINFER_FORM_FIELDS)[number];

/** What a NInfer preset sets: context, users and every NInfer field (a preset replaces all of them). */
export const NINFER_PRESET_FIELDS = ['contextSize', 'parallel', ...NINFER_FORM_FIELDS] as const;

/** Draft tokens NInfer takes per speculative backend (--draft-tokens: MTP 1..5, DFlash / DFlash2 1..15). */
export const NINFER_DRAFT_MAX: Record<Exclude<NinferSpec, 'off'>, number> = { mtp: 5, dflash: 15, dflash2: 15 };


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
 * With `base`, only the fields that engine takes are read (launch-fields.ts): a value typed for another
 * engine is neither sent nor reported, so what the panel shows is exactly what runs.
 */
export function paramsFromForm(
  form: ParamsForm,
  /** `fields`: exactly these (a program with an OpenAI API: those its commands take, launch-fields.ts commandFields). */
  opts: { trainedContext?: number | undefined; base?: EngineBase | undefined; fields?: readonly ParamsField[] | undefined } = {},
): ParsedParams {
  const params: LaunchParams = { extraArgs: parseArgs(form.extraArgs), env: {} };
  const invalid: ParamsField[] = [];
  const ids = opts.fields ? new Set<string>(opts.fields) : opts.base === undefined ? undefined : new Set<string>(fieldsOf(opts.base).map((x) => x.field));
  const takes = (field: ParamsField): boolean => ids === undefined || ids.has(field);
  const int = (field: 'contextSize' | 'batchSize' | 'ubatchSize' | 'threads' | 'parallel' | 'maxModelLen', min = 1) => {
    const text = form[field].trim();
    if (!text || !takes(field)) return;
    const n = parseInteger(text, min);
    // NInfer serves at most 8 requests at once (--max-concurrency 1..8).
    if (n === null || (field === 'parallel' && opts.base === 'ninfer' && n > NINFER_MAX_CONCURRENCY)) invalid.push(field);
    else params[field] = n;
  };
  int('contextSize');
  int('batchSize');
  int('ubatchSize');
  int('threads');
  int('parallel');
  int('maxModelLen');
  const ngl = form.gpuLayers.trim();
  if (ngl && takes('gpuLayers')) {
    const n = parseInteger(ngl, 0);
    if (n === null) invalid.push('gpuLayers');
    else params.gpuLayers = n;
  }
  if (form.flashAttention !== 'default' && takes('flashAttention')) params.flashAttention = form.flashAttention;
  if (form.kvCacheType !== 'default' && takes('kvCacheType')) params.kvCacheType = form.kvCacheType;
  const util = form.gpuMemoryUtilization.trim();
  if (util && takes('gpuMemoryUtilization')) {
    const r = parseRatio(util);
    if (r === null) invalid.push('gpuMemoryUtilization');
    else params.gpuMemoryUtilization = r;
  }
  if (form.dtype.trim() && takes('dtype')) params.dtype = form.dtype.trim();
  if (form.quantization.trim() && takes('quantization')) params.quantization = form.quantization.trim();
  const env = parseEnv(form.env);
  params.env = env.env;
  if (env.invalid.length) invalid.push('env');
  if (form.yarnTarget.trim() && takes('yarnTarget')) {
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
  if (form.vision !== 'default' && takes('vision')) params.vision = form.vision === 'on';
  if (form.reasoning !== 'default' && takes('reasoning')) params.reasoning = form.reasoning === 'on';
  const ninfer = ninferFromForm(form, takes, invalid);
  if (ninfer) params.ninfer = ninfer;
  const trtllm = trtllmFromForm(form, takes, invalid);
  if (trtllm) params.trtllm = trtllm;
  return { params, invalid };
}

/** TensorRT-LLM's own fields (those `takes` lets through); undefined when none is set. One card sends nothing. */
function trtllmFromForm(form: ParamsForm, takes: (f: ParamsField) => boolean, invalid: ParamsField[]): TrtllmParams | undefined {
  const t: TrtllmParams = {};
  const memory = form.trtllmKvMemory.trim();
  if (memory && takes('trtllmKvMemory')) {
    const r = parseRatio(memory);
    if (r === null) invalid.push('trtllmKvMemory');
    else t.kvCacheFreeMemoryFraction = r;
  }
  const tp = form.trtllmTp.trim();
  if (tp && takes('trtllmTp')) {
    const n = parseInteger(tp);
    if (n === null || n > 8) invalid.push('trtllmTp');
    else if (n > 1) t.tensorParallel = n;
  }
  if (form.trtllmTrustRemoteCode !== 'default' && takes('trtllmTrustRemoteCode')) t.trustRemoteCode = form.trtllmTrustRemoteCode === 'on';
  return Object.keys(t).length > 0 ? t : undefined;
}

/** NInfer's own fields (those `takes` lets through); undefined when none is set. */
function ninferFromForm(form: ParamsForm, takes: (f: ParamsField) => boolean, invalid: ParamsField[]): NinferParams | undefined {
  const n: NinferParams = {};
  const count = (field: 'ninferDeviceStateSlots' | 'ninferHostStateSlots' | 'ninferHostKvMib', key: 'deviceStateSlots' | 'hostStateSlots' | 'hostKvMib') => {
    const text = form[field].trim();
    if (!text || !takes(field)) return;
    const v = parseInteger(text, 0);
    if (v === null) invalid.push(field);
    else n[key] = v;
  };
  const tri = (field: 'ninferLmHeadDraft' | 'ninferVision' | 'ninferPrefixReuse' | 'ninferThinking' | 'ninferPreserveThinking', key: 'lmHeadDraft' | 'vision' | 'prefixReuse' | 'thinking' | 'preserveThinking') => {
    if (form[field] !== 'default' && takes(field)) n[key] = form[field] === 'on';
  };
  const cap = form.ninferKvCapacity.trim();
  if (cap && takes('ninferKvCapacity')) {
    const v = /^auto$/i.test(cap) ? 'auto' : parseInteger(cap);
    if (v === null) invalid.push('ninferKvCapacity');
    else n.kvCapacity = v;
  }
  const dtype = form.ninferKvDtype.trim();
  if (dtype && takes('ninferKvDtype')) n.kvDtype = dtype;
  if (form.ninferSpec !== 'default' && takes('ninferSpec')) n.spec = form.ninferSpec;
  const draft = form.ninferDraftTokens.trim();
  if (draft && takes('ninferDraftTokens')) {
    const v = parseInteger(draft);
    const max = n.spec === undefined || n.spec === 'off' ? NINFER_DRAFT_MAX.dflash : NINFER_DRAFT_MAX[n.spec];
    if (v === null || v > max) invalid.push('ninferDraftTokens');
    else n.draftTokens = v;
  }
  tri('ninferLmHeadDraft', 'lmHeadDraft');
  tri('ninferVision', 'vision');
  tri('ninferPrefixReuse', 'prefixReuse');
  count('ninferDeviceStateSlots', 'deviceStateSlots');
  count('ninferHostStateSlots', 'hostStateSlots');
  count('ninferHostKvMib', 'hostKvMib');
  tri('ninferThinking', 'thinking');
  tri('ninferPreserveThinking', 'preserveThinking');
  return Object.keys(n).length > 0 ? n : undefined;
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
    ...ninferForm(p.ninfer),
    vision: triOf(p.vision),
    reasoning: triOf(p.reasoning),
    trtllmKvMemory: s(p.trtllm?.kvCacheFreeMemoryFraction),
    trtllmTp: s(p.trtllm?.tensorParallel),
    trtllmTrustRemoteCode: triOf(p.trtllm?.trustRemoteCode),
  };
}

const triOf = (v: boolean | undefined): Tri => (v === undefined ? 'default' : v ? 'on' : 'off');

/** NInfer's own settings as the form's fields (all empty without them). */
export function ninferForm(n: NinferParams | undefined): Pick<ParamsForm, NinferFormField> {
  const s = (v: number | string | undefined) => (v === undefined ? '' : String(v));
  return {
    ninferKvCapacity: s(n?.kvCapacity),
    ninferKvDtype: n?.kvDtype ?? '',
    ninferSpec: n?.spec ?? 'default',
    ninferDraftTokens: s(n?.draftTokens),
    ninferLmHeadDraft: triOf(n?.lmHeadDraft),
    ninferVision: triOf(n?.vision),
    ninferPrefixReuse: triOf(n?.prefixReuse),
    ninferDeviceStateSlots: s(n?.deviceStateSlots),
    ninferHostStateSlots: s(n?.hostStateSlots),
    ninferHostKvMib: s(n?.hostKvMib),
    ninferThinking: triOf(n?.thinking),
    ninferPreserveThinking: triOf(n?.preserveThinking),
  };
}

/** The form with only the image and reasoning switches kept (what is sent without expert mode). */
export function switchesOnly(form: ParamsForm): ParamsForm {
  return { ...EMPTY_PARAMS_FORM, vision: form.vision, reasoning: form.reasoning, ninferVision: form.ninferVision, ninferThinking: form.ninferThinking };
}

/** True when the parameters say anything beyond the defaults (expert mode is needed to show them). */
export function hasCustomParams(p: LaunchParams | undefined): boolean {
  if (!p) return false;
  // An empty environment, NInfer or TensorRT-LLM object says nothing.
  const said = (k: string, v: unknown) =>
    k === 'extraArgs' ? (v as string[]).length > 0 : k === 'env' || k === 'ninfer' || k === 'trtllm' ? v !== undefined && Object.values(v as object).some((x) => x !== undefined) : v !== undefined;
  return Object.entries(p).some(([k, v]) => said(k, v));
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
  /** One number N above 1: only N at once ("Solo N utenti insieme") instead of every step from 1 to N. */
  concurrencyExact: boolean;
  sessionsExact: boolean;
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
  concurrencyExact: false,
  sessionsExact: false,
};

/** New text of every later message and answer length of the long conversations made by the form. */
export const FORM_SESSIONS = { followupTokens: 256, outputTokens: 256 } as const;

/** "4096, 512" → [512, 4096]: smallest first, each once; null when any item is not a positive integer. */
export function parseList(text: string): number[] | null {
  const items = text.split(/[,;\s]+/).filter(Boolean);
  const nums = items.map((i) => parseInteger(i));
  return nums.some((n) => n === null) ? null : [...new Set(nums as number[])].sort((a, b) => a - b);
}

/** "4" → 1, 2, 3, 4 (every step up to that many users), or only 4 when `exact`; a list is taken as written. */
export function parseUsers(text: string, exact = false): number[] | null {
  const l = parseList(text);
  return l?.length === 1 && !exact ? Array.from({ length: l[0]! }, (_, i) => i + 1) : l;
}

/** 1, 2, 3, 4 shows back as "4" (and a lone level as itself, exact: usersExact); any other set of levels as a list. */
export function showUsers(levels: readonly number[]): string {
  const upTo = levels.length > 1 && levels.every((l, i) => l === i + 1);
  return upTo ? String(levels.length) : levels.join(', ');
}

/** True when levels are only one count above 1 ("Solo 2 utenti insieme"). */
export const usersExact = (levels: readonly number[]): boolean => levels.length === 1 && (levels[0] as number) > 1;

/** The custom plan of the form; llama-bench only for llama.cpp (`llamaCpp` false leaves it out: it is llama.cpp's own tool). */
export function scenarioFromForm(form: ScenarioForm, seed = 42, opts: { llamaCpp?: boolean } = {}): { scenario: Scenario; invalid: ScenarioField[] } {
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
    const l = field === 'promptTokens' ? parseList(text) : parseUsers(text, field === 'concurrency' ? form.concurrencyExact : form.sessionsExact);
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
  if (form.llamaBench && opts.llamaCpp !== false) steps.push({ kind: 'llama-bench', pp: 512, tg: 128, reps: 5 });
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
      form.concurrencyExact = usersExact(step.levels);
      form.requestsPerWorker = String(step.requestsPerWorker);
    } else if (step.kind === 'sessions') {
      form.sessions = showUsers(step.levels);
      form.sessionsExact = usersExact(step.levels);
      form.sessionsDepth = step.depth > 0 ? String(step.depth) : '';
      form.sessionsTurns = String(step.turns);
    } else if (step.kind === 'llama-bench') form.llamaBench = true;
  }
  return form;
}
