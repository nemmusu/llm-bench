/**
 * "Motori personalizzati": forks of llama.cpp / vLLM / SGLang and other programs that serve the
 * OpenAI API, saved in settings.customEngines.
 *
 * A fork keeps its base's features (same flags, same timings, same tuner): it runs through the base's
 * adapter with its own executable, image or Python, plus its extra arguments and environment. The
 * standard flags its `--help` does not list are left out of its commands, and said so
 * (CustomEngineCheck.missing, run note 'flag_unsupported'). An 'openai-server' engine is a command
 * template LLM Bench starts and stops (kind 'command'), measured like an external endpoint.
 *
 * A 'ninfer' engine is a variant of NInfer (a fork with the same ninfer-serve, plus options and weight
 * formats of its own: NInfer-all, ninfer-fusion-kvmem…): it runs through the NInfer adapter, natively
 * on Linux or inside its WSL distro on Windows (kind 'ninfer-native' / 'ninfer-wsl'), with every NInfer
 * feature (presets, tuner, load progress, chat client). Its checkout can be cloned and built by LLM
 * Bench's guided build (POST /api/engines/ninfer/build with `variant`), from its `source`.
 *
 *   GET    /api/engines/custom                -> CustomEngineInfo[] (every saved engine, its kind and check)
 *   POST   /api/engines/custom                (CustomEngineDraft) -> CustomEngine (id from its name)
 *   PUT    /api/engines/custom/:id            (CustomEngineDraft) -> CustomEngine
 *   DELETE /api/engines/custom/:id            -> { ok: true }
 *   POST   /api/engines/custom/:id/duplicate  -> CustomEngine ("… (copia)")
 *   POST   /api/engines/custom/check          (CustomEngineDraft) -> CustomEngineCheck ("Prova": --version / --help)
 *
 * A run or server targets one with EngineConfig { kind: customEngineKindOf(engine), customEngineId }.
 */
import { z } from 'zod';
import { engineKindSchema, engineStatusSchema, type EngineConfig, type EngineKind } from './engines';

export const CUSTOM_ENGINE_BASES = ['llamacpp', 'vllm', 'sglang', 'ninfer', 'openai-server'] as const;
export const customEngineBaseSchema = z.enum(CUSTOM_ENGINE_BASES);
export type CustomEngineBase = z.infer<typeof customEngineBaseSchema>;

/** An https git repository LLM Bench may clone ("https://github.com/iamwavecut/ninfer-all.git"). */
export const GIT_URL = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/[A-Za-z0-9._~/-]+$/;
/** A branch name (no leading dash: it becomes a git argument). */
export const GIT_BRANCH = /^[A-Za-z0-9._/][A-Za-z0-9._/-]{0,99}$/;

/** Where a variant's source comes from: the repository and the branch to clone (absent = its default). */
export const gitSourceSchema = z.object({
  url: z.string().trim().regex(GIT_URL),
  branch: z.string().trim().regex(GIT_BRANCH).optional(),
});
export type GitSource = z.infer<typeof gitSourceSchema>;

/** Placeholders of a command template; {port} is required (LLM Bench picks a free port). */
export const COMMAND_PLACEHOLDERS = ['model', 'modelDir', 'port', 'host', 'ctx', 'alias'] as const;
export type CommandPlaceholder = (typeof COMMAND_PLACEHOLDERS)[number];

/**
 * Where the engine is:
 *   native   llama.cpp: the llama-server executable (or its folder); vLLM: the `vllm` script or its
 *            venv folder; SGLang: the Python of an environment with SGLang, or that venv folder
 *   docker   an image:tag built on the base's official image (same entrypoint and flags)
 *   command  'openai-server' only: the command template, and which OpenAI API it is measured with:
 *            'completions' (/v1/completions) or 'chat' (/v1/chat/completions, for servers without the former)
 *   ninfer   'ninfer' only: its ninfer-serve or checkout as Linux sees it (inside `distro` on Windows,
 *            where it runs in WSL), and the repository it was (or will be) cloned from
 */
export const customEngineRunSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('native'), path: z.string().trim().min(1) }),
  z.object({ mode: z.literal('docker'), image: z.string().trim().min(1) }),
  z.object({ mode: z.literal('command'), template: z.string().trim().min(1).max(4000), api: z.enum(['completions', 'chat']).default('completions') }),
  z.object({ mode: z.literal('ninfer'), path: z.string().trim().min(1), distro: z.string().trim().min(1).optional(), source: gitSourceSchema.optional() }),
]);
export type CustomEngineRun = z.infer<typeof customEngineRunSchema>;

/**
 * "Usa per questi modelli": LLM Bench proposes the engine (a suggestion the user can change) for a
 * model whose repo, file or name contains one of `names` (plain text, any case; "/regex/" for a
 * regular expression), whose quantization is one of `quants` (PQ2_0, PTQ1_0…), or that an earlier run
 * said its engine could not read for one of `layouts` (ENGINE_MODEL_UNSUPPORTED: "gguf_blocks_v1").
 */
export const modelMatchSchema = z.object({
  names: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  quants: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  layouts: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
});
export type ModelMatch = z.infer<typeof modelMatchSchema>;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Lower-case slug: what an id looks like ("prismml-fork", "my-sglang-2"). */
export const CUSTOM_ENGINE_ID = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

const draftShape = {
  name: z.string().trim().min(1).max(60),
  base: customEngineBaseSchema,
  run: customEngineRunSchema,
  /** Appended to every command of this engine, before the run's own extra arguments. */
  extraArgs: z.array(z.string().min(1)).max(100).default([]),
  /** Added to the environment of every launch (the run's own variables win). */
  env: z.record(z.string().regex(ENV_NAME), z.string()).default({}),
  notes: z.string().max(2000).default(''),
  match: modelMatchSchema.optional(),
  /** The built-in template it was created from (CUSTOM_ENGINE_TEMPLATES), for its explanation. */
  template: z.string().optional(),
};

/** What makes an engine usable at all: base and mode agree, the template names a port, rules compile. */
function refineEngine(e: { base: CustomEngineBase; run: CustomEngineRun; match?: ModelMatch | undefined }, ctx: z.RefinementCtx): void {
  const issue = (path: (string | number)[], reason: string) => ctx.addIssue({ code: 'custom', path, message: reason, params: { reason } });
  if ((e.base === 'openai-server') !== (e.run.mode === 'command') || (e.base === 'ninfer') !== (e.run.mode === 'ninfer')) issue(['run', 'mode'], 'mode_mismatch');
  if (e.run.mode === 'docker' && !DOCKER_IMAGE.test(e.run.image)) issue(['run', 'image'], 'bad_image');
  if (e.run.mode === 'command') {
    const t = templateProblem(e.run.template);
    if (t !== undefined) issue(['run', 'template'], t);
  }
  e.match?.names.forEach((n, i) => {
    if (patternOf(n) === undefined) issue(['match', 'names', i], 'bad_pattern');
  });
}

/** A custom engine as the user writes it (create/update requests, "Prova"). */
export const customEngineDraftSchema = z.object(draftShape).superRefine(refineEngine);
export type CustomEngineDraft = z.input<typeof customEngineDraftSchema>;

export const CUSTOM_ENGINE_SCHEMA_VERSION = 1;

/** A saved custom engine (settings.customEngines). */
export const customEngineSchema = z
  .object({
    /** Format version of this entry: a newer app may migrate it, an older one drops it (never the whole settings file). */
    schema: z.literal(CUSTOM_ENGINE_SCHEMA_VERSION).default(CUSTOM_ENGINE_SCHEMA_VERSION),
    id: z.string().regex(CUSTOM_ENGINE_ID),
    ...draftShape,
  })
  .superRefine(refineEngine);
export type CustomEngine = z.infer<typeof customEngineSchema>;

/**
 * settings.customEngines: the saved list, read leniently. An entry that does not validate (edited by
 * hand, written by a newer version) is dropped on read instead of resetting every setting.
 */
export const customEnginesSettingSchema = z
  .array(z.unknown())
  .default([])
  .transform((list) =>
    list.flatMap((raw) => {
      const p = customEngineSchema.safeParse(raw);
      return p.success ? [p.data] : [];
    }),
  );

// ---- kinds ---------------------------------------------------------------------------------------

/** Docker image reference (validated again by the core before it becomes a CLI argument). */
const DOCKER_IMAGE = /^[a-z0-9][a-z0-9._/:@-]*$/i;

/** The engine kind a custom engine runs as (its base's adapter). A NInfer variant with a distro runs in WSL. */
export function customEngineKindOf(e: Pick<CustomEngine, 'base' | 'run'>): EngineKind {
  if (e.base === 'openai-server') return 'command';
  if (e.base === 'ninfer') return e.run.mode === 'ninfer' && e.run.distro !== undefined ? 'ninfer-wsl' : 'ninfer-native';
  const docker = e.run.mode === 'docker';
  if (e.base === 'llamacpp') return docker ? 'llamacpp-docker' : 'llamacpp-native';
  if (e.base === 'vllm') return docker ? 'vllm-docker' : 'vllm-native';
  return docker ? 'sglang-docker' : 'sglang-native';
}

/** The engine config of a run or server on this custom engine. */
export function customEngineConfigOf(e: Pick<CustomEngine, 'id' | 'base' | 'run'>): EngineConfig {
  return { kind: customEngineKindOf(e), customEngineId: e.id };
}

/** Bases a kind can be a fork of ('external' has none: it is not started by LLM Bench). */
export function customBaseOfKind(kind: EngineKind): CustomEngineBase | undefined {
  if (kind === 'llamacpp-native' || kind === 'llamacpp-docker') return 'llamacpp';
  if (kind === 'vllm-native' || kind === 'vllm-docker') return 'vllm';
  if (kind === 'sglang-native' || kind === 'sglang-docker') return 'sglang';
  if (kind === 'ninfer-native' || kind === 'ninfer-wsl') return 'ninfer';
  return kind === 'command' ? 'openai-server' : undefined;
}

/** A free id for a new engine named `name`: its slug, "-2", "-3"… when taken. */
export function customEngineIdFor(name: string, taken: readonly string[]): string {
  const slug =
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'engine';
  const used = new Set(taken);
  if (!used.has(slug)) return slug;
  let n = 2;
  while (used.has(`${slug}-${n}`)) n++;
  return `${slug}-${n}`;
}

// ---- command templates ---------------------------------------------------------------------------

const PLACEHOLDER = /\{([A-Za-z]+)\}/g;

/**
 * Splits a command line into arguments without any shell: blanks separate, '…' and "…" group
 * (quotes removed, nothing escaped: Windows paths keep their backslashes). undefined = unbalanced quote.
 */
export function splitCommandLine(text: string): string[] | undefined {
  const out: string[] = [];
  let cur = '';
  let started = false;
  let quote: '"' | "'" | undefined;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) out.push(cur);
      cur = '';
      started = false;
    } else {
      cur += ch;
      started = true;
    }
  }
  if (quote) return undefined;
  if (started) out.push(cur);
  return out;
}

/** Placeholders a template uses, in order of first use. */
export function templatePlaceholders(template: string): string[] {
  return [...new Set([...template.matchAll(PLACEHOLDER)].map((m) => m[1] as string))];
}

/** Why a command template cannot be used, or undefined: 'unbalanced_quote', 'empty', 'unknown_placeholder', 'port_missing', 'program_placeholder'. */
export function templateProblem(template: string): string | undefined {
  const argv = splitCommandLine(template);
  if (argv === undefined) return 'unbalanced_quote';
  if (argv.length === 0 || argv[0] === '') return 'empty';
  const used = templatePlaceholders(template);
  if (used.some((p) => !(COMMAND_PLACEHOLDERS as readonly string[]).includes(p))) return 'unknown_placeholder';
  if (!used.includes('port')) return 'port_missing';
  // The program itself must be fixed: a model path can never become the executable.
  if (/\{[A-Za-z]+\}/.test(argv[0] as string)) return 'program_placeholder';
  return undefined;
}

/**
 * The argv of a command template: split first, then each argument's placeholders replaced, so a
 * value with spaces (a model path) stays one argument. The template must be valid (templateProblem).
 */
export function expandCommandTemplate(template: string, values: Record<CommandPlaceholder, string>): string[] {
  const argv = splitCommandLine(template) ?? [];
  return argv.map((a) => a.replace(PLACEHOLDER, (whole, name: string) => (name in values ? values[name as CommandPlaceholder] : whole)));
}

// ---- model rules ---------------------------------------------------------------------------------

/** A rule as a matcher: "/re/flags" a regular expression (always case-insensitive), else a substring. */
function patternOf(rule: string): ((text: string) => boolean) | undefined {
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

/** What the rules look at. */
export interface MatchableModel {
  displayName: string;
  repo?: string | undefined;
  file?: string | undefined;
  quant?: string | undefined;
  /** Weight layouts or formats an engine could not read for this model in an earlier run (RunSummary.unreadable). */
  unreadable?: readonly string[] | undefined;
  /**
   * The file format (gguf, safetensors, ninfer…), when known: an engine whose base cannot read it never
   * matches ("…-GGUF-NInfer" repos also ship plain GGUFs, which llama.cpp reads). Unknown: the rules alone.
   */
  format?: string | undefined;
}

/** The formats each base reads (the OpenAI-compatible program: whatever its command loads). */
export const CUSTOM_BASE_FORMATS: Readonly<Record<CustomEngineBase, readonly string[]>> = {
  llamacpp: ['gguf'],
  vllm: ['safetensors'],
  sglang: ['safetensors'],
  ninfer: ['ninfer'],
  'openai-server': ['gguf', 'safetensors'],
};

/** The base can load a model of this format (unknown format: yes). */
export function customBaseReads(base: CustomEngineBase, format: string | undefined): boolean {
  return format === undefined || CUSTOM_BASE_FORMATS[base].includes(format);
}

/** The model meets one of the rules (no rules: never). */
export function matchesModel(match: Pick<ModelMatch, 'names' | 'quants'> & { layouts?: readonly string[] | undefined } | undefined, model: MatchableModel): boolean {
  if (!match) return false;
  const text = [model.repo, model.file, model.displayName].filter((s): s is string => s !== undefined).join('\n');
  if (match.names.some((n) => patternOf(n)?.(text) === true)) return true;
  if ((match.layouts ?? []).some((l) => model.unreadable?.includes(l) === true)) return true;
  const quants = new Set(match.quants.map((q) => q.toLowerCase()));
  if (model.quant !== undefined && quants.has(model.quant.toLowerCase())) return true;
  // The quant is often only in the file name ("Bonsai-8B-PQ2_0.gguf").
  const tokens = (model.file ?? '').toLowerCase().split(/[^a-z0-9_]+/);
  return tokens.some((t) => quants.has(t));
}

/** The first saved engine whose rules match the model: LLM Bench's suggestion. */
export function customEngineForModel<E extends Pick<CustomEngine, 'match' | 'base'>>(engines: readonly E[], model: MatchableModel): E | undefined {
  return engines.find((e) => customBaseReads(e.base, model.format) && matchesModel(e.match, model));
}

// ---- built-in templates --------------------------------------------------------------------------

export interface CustomEngineTemplate {
  id: string;
  base: Exclude<CustomEngineBase, 'openai-server'>;
  /** Its own name (a project name, the same in every language). */
  label: string;
  /** The rules a new engine from this template starts with. */
  match: ModelMatch;
  /** NInfer variants: the repository LLM Bench clones for the guided build, and the folder it suggests. */
  source?: GitSource;
  dir?: string;
  /**
   * A build of a built-in engine LLM Bench manages on that engine's own card (NInfer-all, on NInfer's):
   * never offered in "Aggiungi motore", and its saved engine is not listed among "Motori personalizzati".
   */
  builtIn?: boolean;
}

/** NInfer-all's template id: its saved engine is NInfer's second build (contract/ninfer.ts NINFER_BUILDS). */
export const NINFER_ALL_TEMPLATE = 'ninfer-all';
/** Where NInfer-all comes from: github.com/iamwavecut/ninfer-all, branch master. */
export const NINFER_ALL_SOURCE: GitSource = { url: 'https://github.com/iamwavecut/ninfer-all.git', branch: 'master' };
/** Where its guided build puts the checkout when the user does not say. */
export const NINFER_ALL_DIR = '~/ninfer-all';

/**
 * Ready-made engines the user only has to point at (or let LLM Bench build). Explanations are localized
 * by the renderer (engines.custom.templates.<id>).
 *  - "Fork PrismML di llama.cpp (modelli Bonsai)": PrismML's Ternary-Bonsai GGUFs store weights as
 *    PQ2_0 / PTQ1_0, which only that fork reads.
 *  - "NInfer-all (modelli GGUF-NInfer)": NInfer artifacts converted from GGUF keep the GGUF quantization
 *    blocks (tensor layout gguf_blocks_v1), which only NInfer-all reads (github.com/iamwavecut/ninfer-all,
 *    branch master; its --kv-dtype adds rk8v4, rk4v4…). A build of NInfer managed on NInfer's own card.
 */
export const CUSTOM_ENGINE_TEMPLATES: readonly CustomEngineTemplate[] = [
  { id: 'prismml-bonsai', base: 'llamacpp', label: 'PrismML', match: { names: ['bonsai'], quants: ['PQ2_0', 'PTQ1_0'], layouts: [] } },
  {
    id: NINFER_ALL_TEMPLATE,
    base: 'ninfer',
    label: 'NInfer-all',
    match: { names: ['GGUF-NInfer'], quants: [], layouts: ['gguf_blocks_v1'] },
    source: NINFER_ALL_SOURCE,
    dir: NINFER_ALL_DIR,
    builtIn: true,
  },
];

/** Two repository URLs name the same repository (case, a ".git" and a trailing slash aside). */
export function sameGitRepo(a: string, b: string): boolean {
  const norm = (u: string) =>
    u
      .trim()
      .toLowerCase()
      .replace(/\/+$/, '')
      .replace(/\.git$/, '');
  return norm(a) === norm(b);
}

/**
 * A saved engine that is NInfer-all: made from its template, or a NInfer variant cloned from its
 * repository (one the user added by hand before NInfer-all was built in).
 */
export function isNinferAllEngine(e: Pick<CustomEngine, 'base' | 'template' | 'run'>): boolean {
  if (e.base !== 'ninfer') return false;
  if (e.template === NINFER_ALL_TEMPLATE) return true;
  return e.run.mode === 'ninfer' && e.run.source !== undefined && sameGitRepo(e.run.source.url, NINFER_ALL_SOURCE.url);
}

/**
 * NInfer's built-in NInfer-all build among the saved engines: the first NInfer-all engine (of this
 * kind when one is given: in WSL on Windows, native on Linux). Any other copy is listed as a custom engine.
 */
export function ninferAllEngineOf<E extends Pick<CustomEngine, 'base' | 'template' | 'run'>>(engines: readonly E[], kind?: EngineKind): E | undefined {
  return engines.find((e) => isNinferAllEngine(e) && (kind === undefined || customEngineKindOf(e) === kind));
}

/** A template whose rules match the model (offered when no saved engine does). */
export function templateForModel(model: MatchableModel): CustomEngineTemplate | undefined {
  return CUSTOM_ENGINE_TEMPLATES.find((t) => customBaseReads(t.base, model.format) && matchesModel(t.match, model));
}

/** The template that reads a weight layout or format a build did not know ("gguf_blocks_v1" → NInfer-all). */
export function templateForLayout(layout: string): CustomEngineTemplate | undefined {
  return CUSTOM_ENGINE_TEMPLATES.find((t) => t.match.layouts.includes(layout));
}

export function customEngineTemplate(id: string | undefined): CustomEngineTemplate | undefined {
  return CUSTOM_ENGINE_TEMPLATES.find((t) => t.id === id);
}

// ---- checks --------------------------------------------------------------------------------------

/** An LLM Bench setting whose flag the engine does not list in its --help. */
export const missingFlagSchema = z.object({
  /** The flag LLM Bench would pass ("-ub", "--chunked-prefill-size"). */
  flag: z.string(),
  /** The launch setting it carries (LaunchParams key, or 'alias' / 'noWebui' / 'fit'…), for the message. */
  setting: z.string(),
  /**
   * 'default': left out, the engine's own default applies. 'required': LLM Bench cannot run the
   * engine without it (-m, --port…): the engine cannot be used.
   */
  effect: z.enum(['default', 'required']),
});
export type MissingFlag = z.infer<typeof missingFlagSchema>;

/** "Prova": does it run (version), which options its --help lists, which LLM Bench settings it lacks. */
export const customEngineCheckSchema = z.object({
  kind: engineKindSchema,
  status: engineStatusSchema,
  /** Options listed by --help; 0 = the help could not be read (no flag check, nothing left out). */
  flagCount: z.number().int().min(0),
  missing: z.array(missingFlagSchema).default([]),
  /** Command engines: the placeholders the template uses. */
  placeholders: z.array(z.string()).optional(),
  /** NInfer variants: the --kv-dtype values its --help lists (the official ones and its own: rk8v4…). */
  kvDtypes: z.array(z.string()).optional(),
});
export type CustomEngineCheck = z.infer<typeof customEngineCheckSchema>;

/** One saved engine as GET /api/engines/custom lists it (also for the Server page's presets). */
export const customEngineInfoSchema = z.object({
  engine: customEngineSchema,
  kind: engineKindSchema,
  /** The engine config a run or server on it uses. */
  config: z.object({ kind: engineKindSchema, customEngineId: z.string() }),
  check: customEngineCheckSchema,
});
export type CustomEngineInfo = z.infer<typeof customEngineInfoSchema>;
