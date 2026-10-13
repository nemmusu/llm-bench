/**
 * Configurations: results grouped by HOW the engine ran, not only by model.
 *
 * A configuration is the engine (kind + build or image), the model (sha256 when known, else its weak
 * key; vLLM: repo + revision), the GPU (its uuid) and the launch settings that change speed or
 * memory, normalized: the same settings in another argv order, explicit engine defaults and unset
 * values, all give the same key. Port, alias, served model name, paths, seeds and log flags never
 * count. Old runs work too: the settings come from the saved argv (what really ran) and, where the
 * argv says nothing, from the saved launch params.
 *
 *   GET /api/configs?gpu=&model=&engine=&minContext= -> ConfigsResponse
 */
import { z } from 'zod';
import { engineKindSchema, type EngineKind, type LaunchParams } from './engines';
import { profileSchema } from './results';

// ---- normalized launch settings ------------------------------------------------------------------

export type EngineFamily = 'llamacpp' | 'vllm' | 'external';

/**
 * SGLang reads its settings like vLLM (context, KV dtype, memory share, users, batched tokens): its
 * own flag spellings are parsed into the same fields, and the engine kind in the key keeps the two apart.
 */
export function engineFamilyOf(kind: EngineKind): EngineFamily {
  if (kind === 'llamacpp-native' || kind === 'llamacpp-docker') return 'llamacpp';
  // A command template is the user's own program: no flags GPU Bench knows, like an external endpoint.
  return kind === 'external' || kind === 'command' ? 'external' : 'vllm';
}

/** llama.cpp's own defaults: a setting equal to one of these is the same configuration as leaving it unset. */
export const LLAMA_DEFAULTS = {
  cacheType: 'f16',
  flashAttention: 'auto',
  batchSize: 2048,
  ubatchSize: 512,
  /** GPU Bench passes "all" (or 999) when the layers are left unset: everything on the GPU. */
  gpuLayers: 'all',
} as const;

/** vLLM's own defaults (GPU Bench always passes --gpu-memory-utilization, 0.9 unless lowered). */
export const VLLM_DEFAULTS = {
  cacheType: 'auto',
  gpuMemoryUtilization: 0.9,
  enforceEager: false,
  /** --block-size on CUDA. */
  blockSize: 16,
} as const;

export const CONFIG_DEFAULTS = { llamacpp: LLAMA_DEFAULTS, vllm: VLLM_DEFAULTS } as const;

/**
 * The settings that make a configuration. `undefined` = the engine's default. llama.cpp -ngl counts
 * of at least the model's layers (or 999) are "all"; vLLM --kv-cache-dtype fills both cache types.
 */
export const configParamsSchema = z.object({
  /** llama.cpp -c / --ctx-size, vLLM --max-model-len. */
  contextSize: z.number().int().positive().optional(),
  /** -ctk / --cache-type-k (vLLM --kv-cache-dtype). */
  cacheTypeK: z.string().optional(),
  /** -ctv / --cache-type-v (vLLM --kv-cache-dtype). */
  cacheTypeV: z.string().optional(),
  flashAttention: z.enum(['on', 'off', 'auto']).optional(),
  batchSize: z.number().int().positive().optional(),
  ubatchSize: z.number().int().positive().optional(),
  /** llama.cpp -np slots, vLLM --max-num-seqs. */
  parallel: z.number().int().positive().optional(),
  /**
   * llama.cpp with more than one slot: 'unified' = one KV pool shared by every slot (--kv-unified),
   * 'split' = each slot its own share of -c (--no-kv-unified, or -np N without --kv-unified). Absent
   * with one slot (it makes no difference) and for vLLM (its pool is always shared).
   */
  kvLayout: z.enum(['split', 'unified']).optional(),
  /** llama.cpp --cache-reuse N: reuses cached chunks of at least N tokens that are not a plain prefix (0 = off, the default). */
  cacheReuse: z.number().int().positive().optional(),
  /** -ngl: layers on the GPU. */
  gpuLayers: z.union([z.number().int().min(0), z.literal('all')]).optional(),
  /** --n-cpu-moe N (expert layers kept on the CPU), --cpu-moe = all of them. */
  cpuMoe: z.union([z.number().int().min(0), z.literal('all')]).optional(),
  threads: z.number().int().positive().optional(),
  /** Speculative decoding: llama.cpp -md (file name only) and --draft-max / --draft-min. */
  draftModel: z.string().optional(),
  draftMax: z.number().int().optional(),
  draftMin: z.number().int().optional(),
  /** vLLM --speculative-config (keys sorted, model as a bare name). */
  speculative: z.string().optional(),
  /** vLLM. */
  maxNumBatchedTokens: z.number().int().positive().optional(),
  gpuMemoryUtilization: z.number().optional(),
  enforceEager: z.boolean().optional(),
  /** vLLM --block-size (16, its CUDA default, is dropped). */
  blockSize: z.number().int().positive().optional(),
  /** vLLM CUDA graph capture sizes (--cuda-graph-sizes, or cudagraph_capture_sizes of --compilation-config), ascending. */
  cudaGraphSizes: z.array(z.number().int().positive()).optional(),
  dtype: z.string().optional(),
  quantization: z.string().optional(),
  /**
   * RoPE context extension (recipes: "Contesto oltre il limite del modello"): llama.cpp --rope-scaling /
   * --rope-scale / --yarn-orig-ctx, vLLM --hf-overrides or --rope-scaling, SGLang
   * --json-model-override-args (their rope_scaling), or LaunchParams.ropeScaling. Factor to 4 decimals.
   */
  ropeScaling: z.object({ type: z.string(), factor: z.number().optional(), originalContext: z.number().int().optional() }).optional(),
  /** Any other engine flag, "flag value" with paths as bare file names, sorted. */
  other: z.array(z.string()).default([]),
});
export type ConfigParams = z.infer<typeof configParamsSchema>;

/** What a configuration is read from: a run's launch record, a tune combination, or bare params (labels). */
export interface LaunchInput {
  engineKind: EngineKind;
  /** The launch params (run.launch.params, a tune combination's params, the Benchmark form). */
  params?: LaunchParams | undefined;
  /** The whole saved command line; its engine part wins over `params` (it is what really ran). */
  argv?: readonly string[] | undefined;
  /** Docker image: the engine's arguments start after it in `argv`. */
  image?: string | undefined;
  /** The model's layer count: -ngl at or above it means "all on the GPU". */
  blockCount?: number | undefined;
  /** The model's trained context, for llama.cpp -c 0. */
  modelContext?: number | undefined;
}

type Raw = Omit<ConfigParams, 'other' | 'gpuLayers' | 'cpuMoe' | 'contextSize' | 'kvLayout' | 'ropeScaling'> & {
  contextSize?: number;
  /** RoPE scaling read so far (each flag sets its part). */
  rope?: { type?: string; factor?: number; originalContext?: number };
  /** --kv-unified (true) / --no-kv-unified (false); undefined = not said. */
  kvUnified?: boolean;
  gpuLayers?: number | 'all';
  cpuMoe?: number | 'all';
  speculativeModel?: string;
  speculativeTokens?: number;
  other: Set<string>;
};

type Setter = (raw: Raw, values: readonly string[], flag: string) => void;

const int = (v: string | undefined): number | undefined => {
  if (v === undefined || !/^-?\d+$/.test(v.trim())) return undefined;
  return Number(v);
};
const num = (v: string | undefined): number | undefined => {
  const n = v === undefined || v.trim() === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const positive = (v: string | undefined): number | undefined => {
  const n = int(v);
  return n !== undefined && n > 0 ? n : undefined;
};
/** "C:\models\draft.gguf" → "draft.gguf": a path never makes two configurations different. */
export const bareName = (v: string): string => v.split(/[\\/]/).filter(Boolean).pop() ?? v;

/** "C:\models\draft.gguf", "/models/x", "./a.json": values that name a file (not a regex like "blk\.\d+=CPU"). */
const isPath = (v: string): boolean => /^(?:[A-Za-z]:[\\/]|[\\/]|\.{1,2}[\\/]|~[\\/])/.test(v) || /\.(?:gguf|bin|safetensors|json|jinja|txt)$/i.test(v);

const FA_VALUES = new Map<string, 'on' | 'off' | 'auto'>([
  ['on', 'on'],
  ['1', 'on'],
  ['true', 'on'],
  ['enabled', 'on'],
  ['off', 'off'],
  ['0', 'off'],
  ['false', 'off'],
  ['disabled', 'off'],
  ['auto', 'auto'],
]);

/** Flags with a value (`--flag value`). The setter receives every value up to the next flag. */
const VALUE_FLAGS = new Map<string, Setter>();
const add = (flags: string[], set: Setter) => {
  for (const f of flags) VALUE_FLAGS.set(f, set);
};
add(['-c', '--ctx-size', '--max-model-len', '--context-length'], (r, v) => {
  const n = int(v[0]);
  if (n !== undefined && n >= 0) r.contextSize = n;
});
add(['-ctk', '--cache-type-k'], (r, v) => {
  if (v[0]) r.cacheTypeK = v[0].toLowerCase();
});
add(['-ctv', '--cache-type-v'], (r, v) => {
  if (v[0]) r.cacheTypeV = v[0].toLowerCase();
});
add(['--kv-cache-dtype'], (r, v) => {
  if (v[0]) r.cacheTypeK = r.cacheTypeV = v[0].toLowerCase();
});
add(['-b', '--batch-size'], (r, v) => {
  r.batchSize = positive(v[0]) ?? r.batchSize;
});
add(['-ub', '--ubatch-size'], (r, v) => {
  r.ubatchSize = positive(v[0]) ?? r.ubatchSize;
});
add(['-np', '--parallel', '--max-num-seqs', '--max-running-requests'], (r, v) => {
  r.parallel = positive(v[0]) ?? r.parallel;
});
add(['-ngl', '--gpu-layers', '--n-gpu-layers'], (r, v) => {
  const n = int(v[0]);
  if (v[0]?.toLowerCase() === 'all' || (n !== undefined && n < 0)) r.gpuLayers = 'all';
  else if (n !== undefined) r.gpuLayers = n;
});
add(['--n-cpu-moe', '-ncmoe'], (r, v) => {
  const n = int(v[0]);
  if (n !== undefined && n >= 0) r.cpuMoe = n;
});
add(['-t', '--threads'], (r, v) => {
  r.threads = positive(v[0]) ?? r.threads;
});
add(['-md', '--model-draft'], (r, v) => {
  if (v[0]) r.draftModel = bareName(v[0]);
});
add(['--draft-max', '--draft', '--draft-n'], (r, v) => {
  r.draftMax = int(v[0]) ?? r.draftMax;
});
add(['--draft-min', '--draft-n-min'], (r, v) => {
  r.draftMin = int(v[0]) ?? r.draftMin;
});
add(['--speculative-config'], (r, v) => {
  if (v.length) r.speculative = canonicalJson(v.join(' '));
});
add(['--speculative-model'], (r, v) => {
  if (v[0]) r.speculativeModel = bareName(v[0]);
});
add(['--num-speculative-tokens'], (r, v) => {
  r.speculativeTokens = int(v[0]) ?? r.speculativeTokens;
});
add(['--max-num-batched-tokens', '--chunked-prefill-size'], (r, v) => {
  r.maxNumBatchedTokens = positive(v[0]) ?? r.maxNumBatchedTokens;
});
add(['--gpu-memory-utilization', '--mem-fraction-static'], (r, v) => {
  r.gpuMemoryUtilization = num(v[0]) ?? r.gpuMemoryUtilization;
});
add(['--cache-reuse'], (r, v) => {
  const n = int(v[0]);
  if (n !== undefined && n >= 0) r.cacheReuse = n;
});
add(['--block-size'], (r, v) => {
  r.blockSize = positive(v[0]) ?? r.blockSize;
});
add(['--cuda-graph-sizes'], (r, v) => {
  const sizes = v.flatMap((x) => x.split(/[\s,]+/)).map(positive);
  if (sizes.length && sizes.every((n) => n !== undefined)) r.cudaGraphSizes = sizes as number[];
});
add(['--compilation-config', '-O'], (r, v) => {
  if (!v.length) return;
  const text = v.join(' ');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    r.other.add(`--compilation-config ${text.trim()}`);
    return;
  }
  const { cudagraph_capture_sizes: sizes, ...rest } = parsed as Record<string, unknown>;
  if (Array.isArray(sizes) && sizes.length && sizes.every((n) => Number.isInteger(n) && (n as number) > 0)) r.cudaGraphSizes = sizes as number[];
  else if (sizes !== undefined) rest.cudagraph_capture_sizes = sizes;
  if (Object.keys(rest).length) r.other.add(`--compilation-config ${stableStringify(rest)}`);
});
add(['--dtype'], (r, v) => {
  if (v[0]) r.dtype = v[0];
});
// RoPE scaling: llama.cpp spells each part; vLLM (older --rope-scaling, newer --hf-overrides) and SGLang
// (--json-model-override-args) take a JSON whose rope_scaling says the same.
add(['--rope-scaling'], (r, v) => {
  const text = v.join(' ').trim();
  if (!text) return;
  if (text.startsWith('{')) {
    readOverrides(r, `{"rope_scaling":${text}}`, '--rope-scaling');
    return;
  }
  r.rope = { ...r.rope, type: text.toLowerCase() };
});
add(['--rope-scale'], (r, v) => {
  const n = num(v[0]);
  if (n !== undefined && n > 0) r.rope = { ...r.rope, factor: n };
});
add(['--yarn-orig-ctx'], (r, v) => {
  const n = int(v[0]);
  if (n !== undefined && n > 0) r.rope = { ...r.rope, originalContext: n };
});
add(['--hf-overrides', '--json-model-override-args'], (r, v, flag) => {
  if (v.length) readOverrides(r, v.join(' '), flag);
});

/** A model-config override JSON: its rope_scaling is the RoPE setting, anything else stays a flag of its own. */
function readOverrides(r: Raw, text: string, flag: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    r.other.add(`${flag} ${text.trim()}`);
    return;
  }
  const { rope_scaling: rope, ...rest } = parsed as Record<string, unknown>;
  if (rope && typeof rope === 'object' && !Array.isArray(rope)) {
    const o = rope as Record<string, unknown>;
    const type = o.rope_type ?? o.type;
    r.rope = {
      ...(typeof type === 'string' ? { type: type.toLowerCase() } : {}),
      ...(typeof o.factor === 'number' && o.factor > 0 ? { factor: o.factor } : {}),
      ...(typeof o.original_max_position_embeddings === 'number' && o.original_max_position_embeddings > 0 ? { originalContext: o.original_max_position_embeddings } : {}),
    };
  } else if (rope !== undefined) rest.rope_scaling = rope;
  if (Object.keys(rest).length) r.other.add(`${flag} ${stableStringify(rest)}`);
}
add(['--quantization'], (r, v) => {
  if (v[0]) r.quantization = v[0];
});

/** Switches without a value. */
const BOOLEAN_FLAGS = new Map<string, (raw: Raw) => void>([
  ['--enforce-eager', (r) => (r.enforceEager = true)],
  // SGLang: no CUDA graphs, vLLM's eager mode.
  ['--disable-cuda-graph', (r) => (r.enforceEager = true)],
  ['--kv-unified', (r) => (r.kvUnified = true)],
  ['-kvu', (r) => (r.kvUnified = true)],
  ['--no-kv-unified', (r) => (r.kvUnified = false)],
  ['-no-kvu', (r) => (r.kvUnified = false)],
  ['--cpu-moe', (r) => (r.cpuMoe = 'all')],
  ['-cmoe', (r) => (r.cpuMoe = 'all')],
]);

/** Identity, network, paths, seeds and logging: never part of a configuration. Values are skipped. */
const IGNORED_VALUE = new Set([
  '-m',
  '--model',
  '--host',
  '--port',
  '--alias',
  '-a',
  '--served-model-name',
  '--api-key',
  '--seed',
  '-s',
  '--revision',
  '--log-file',
  '--log-level',
  '--log-verbosity',
  '-lv',
  '--uvicorn-log-level',
  '--download-dir',
  '--hf-token',
  '-mmproj',
  '--mmproj',
  '--fit',
  // SGLang: the model, the seed; Python's -m (the module) and -X (GPU Bench's marker on servers).
  '--model-path',
  '--random-seed',
  '-X',
]);
const IGNORED_SWITCH = new Set([
  '--no-webui',
  '--webui',
  '--metrics',
  '--verbose',
  '-v',
  '--log-disable',
  '--log-colors',
  '--log-prefix',
  '--log-timestamps',
  // vLLM: only how much of the prompt came from the cache is reported, nothing runs differently.
  '--enable-prompt-tokens-details',
  '--enable-cache-report',
  '--disable-log-requests',
  '--disable-log-stats',
  '--disable-uvicorn-access-log',
  '--enable-log-requests',
  '--no-enable-log-requests',
]);
/** `docker run` flags, for a Docker command whose image cannot be found in the argv. */
const DOCKER_VALUE = new Set(['--name', '--label', '--gpus', '-p', '-v', '-e', '--ipc', '--pull', '--entrypoint', '--network', '--shm-size', '--runtime']);
const DOCKER_SWITCH = new Set(['-d', '--rm', '-it', '-i']);

const isFlag = (token: string): boolean => token.length > 1 && token.startsWith('-') && !/^-\d/.test(token);

/** JSON with sorted keys and bare model names; anything that is not JSON is kept as written. */
function canonicalJson(text: string): string {
  try {
    return stableStringify(bareModels(JSON.parse(text) as unknown));
  } catch {
    return text.trim();
  }
}

function bareModels(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(bareModels);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'model' && typeof x === 'string' ? bareName(x) : bareModels(x)]));
  }
  return v;
}

/** JSON.stringify with object keys sorted and undefined values dropped: equal values, equal text. */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : stableStringify(x))).join(',')}]`;
  if (v && typeof v === 'object') {
    const entries = Object.entries(v)
      .filter(([, x]) => x !== undefined)
      // Keys of one object are unique: never equal.
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${stableStringify(x)}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** The engine's own arguments: after the image for Docker, after the executable (and subcommand, model) otherwise. */
function engineArgs(argv: readonly string[], image: string | undefined): { args: readonly string[]; docker: boolean } {
  if (image) {
    const at = argv.indexOf(image);
    if (at >= 0) return { args: argv.slice(at + 1), docker: false };
    return { args: argv, docker: true };
  }
  return { args: argv, docker: false };
}

/** Reads the settings in `args` into `raw` (a later occurrence of a flag wins, as in the engines). */
function parseArgs(args: readonly string[], raw: Raw, docker = false): void {
  let i = 0;
  // Executable, launcher, `serve`, a positional model: everything before the first flag.
  while (i < args.length && !isFlag(args[i]!)) i++;
  while (i < args.length) {
    const token = args[i++]!;
    if (!isFlag(token)) continue;
    const eq = token.startsWith('--') ? token.indexOf('=') : -1;
    const flag = eq > 0 ? token.slice(0, eq) : token;
    const values: string[] = eq > 0 ? [token.slice(eq + 1)] : [];
    const takeValues = () => {
      if (eq > 0) return;
      while (i < args.length && !isFlag(args[i]!)) values.push(args[i++]!);
    };
    if (flag === '-fa' || flag === '--flash-attn') {
      const next = eq > 0 ? values[0] : args[i];
      const fa = next === undefined ? undefined : FA_VALUES.get(next.toLowerCase());
      if (fa !== undefined && eq < 0) i++;
      raw.flashAttention = fa ?? 'on';
      continue;
    }
    const bool = BOOLEAN_FLAGS.get(flag);
    if (bool) {
      bool(raw);
      continue;
    }
    if (IGNORED_SWITCH.has(flag) || (docker && DOCKER_SWITCH.has(flag))) continue;
    takeValues();
    const set = VALUE_FLAGS.get(flag);
    if (set) set(raw, values, flag);
    else if (!IGNORED_VALUE.has(flag) && !(docker && DOCKER_VALUE.has(flag))) {
      raw.other.add([flag, ...values.map((v) => (isPath(v) ? bareName(v) : v))].join(' '));
    }
  }
}

/** The settings of the launch params themselves (what each engine family reads), then their extra arguments. */
function fromParams(family: EngineFamily, p: LaunchParams, raw: Raw): void {
  if (family === 'external') return;
  if (p.ropeScaling) raw.rope = { ...p.ropeScaling };
  if (family === 'vllm') {
    const ctx = p.maxModelLen ?? p.contextSize;
    if (ctx !== undefined) raw.contextSize = ctx;
    if (p.kvCacheType !== undefined) raw.cacheTypeK = raw.cacheTypeV = p.kvCacheType === 'q8_0' || p.kvCacheType === 'q4_0' ? 'fp8' : p.kvCacheType;
    if (p.gpuMemoryUtilization !== undefined) raw.gpuMemoryUtilization = p.gpuMemoryUtilization;
    if (p.dtype !== undefined) raw.dtype = p.dtype;
    if (p.quantization !== undefined) raw.quantization = p.quantization;
  } else {
    if (p.contextSize !== undefined) raw.contextSize = p.contextSize;
    if (p.kvCacheType !== undefined && p.kvCacheType !== 'auto') raw.cacheTypeK = raw.cacheTypeV = p.kvCacheType;
    if (p.flashAttention !== undefined) raw.flashAttention = p.flashAttention;
    if (p.batchSize !== undefined) raw.batchSize = p.batchSize;
    if (p.ubatchSize !== undefined) raw.ubatchSize = p.ubatchSize;
    if (p.gpuLayers !== undefined) raw.gpuLayers = p.gpuLayers;
    if (p.threads !== undefined) raw.threads = p.threads;
  }
  if (p.parallel !== undefined) raw.parallel = p.parallel;
  parseArgs(p.extraArgs, raw);
}

const emptyRaw = (): Raw => ({ other: new Set() });

/**
 * The configuration's settings from a launch: the command line when there is one (what really ran),
 * the params for whatever it does not say (or for everything, when there is no command line).
 * Engine defaults are dropped, so "unset" and "explicitly the default" are the same configuration.
 */
export function configParamsOf(input: LaunchInput): ConfigParams {
  const family = engineFamilyOf(input.engineKind);
  const fromLaunch = emptyRaw();
  if (input.params) fromParams(family, input.params, fromLaunch);
  // Params alone: GPU Bench adds --kv-unified for more than one slot. A command line without it: split
  // (llama-server shares the pool by default only when the slot count is automatic).
  if (!input.argv?.length || family === 'external') return normalize(family, fromLaunch, input, true);
  // The command line already holds the extra arguments: its unknown flags are the whole list.
  const fromArgv = emptyRaw();
  const { args, docker } = engineArgs(input.argv, input.image);
  parseArgs(args, fromArgv, docker);
  return normalize(family, { ...fromLaunch, ...definedOnly(fromArgv), other: fromArgv.other }, input, false);
}

function definedOnly<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([k, v]) => v !== undefined && k !== 'other')) as Partial<T>;
}

function normalize(family: EngineFamily, raw: Raw, input: LaunchInput, unifiedByDefault: boolean): ConfigParams {
  const out: ConfigParams = { other: [...raw.other].sort() };
  let ctx = raw.contextSize;
  if (ctx === 0) ctx = input.modelContext;
  if (ctx) out.contextSize = ctx;
  const defaults = family === 'vllm' ? VLLM_DEFAULTS : LLAMA_DEFAULTS;
  const cache = (v: string | undefined) => (v === undefined || v === defaults.cacheType || (family === 'vllm' && v === 'f16') || v === 'auto' ? undefined : v);
  const k = cache(raw.cacheTypeK);
  const v = cache(raw.cacheTypeV);
  if (k !== undefined) out.cacheTypeK = k;
  if (v !== undefined) out.cacheTypeV = v;
  if (raw.flashAttention !== undefined && raw.flashAttention !== LLAMA_DEFAULTS.flashAttention) out.flashAttention = raw.flashAttention;
  if (raw.batchSize !== undefined && raw.batchSize !== LLAMA_DEFAULTS.batchSize) out.batchSize = raw.batchSize;
  if (raw.ubatchSize !== undefined && raw.ubatchSize !== LLAMA_DEFAULTS.ubatchSize) out.ubatchSize = raw.ubatchSize;
  if (raw.parallel !== undefined) out.parallel = raw.parallel;
  if (family === 'llamacpp' && (raw.parallel ?? 1) > 1) out.kvLayout = (raw.kvUnified ?? unifiedByDefault) ? 'unified' : 'split';
  if (raw.cacheReuse !== undefined && raw.cacheReuse > 0) out.cacheReuse = raw.cacheReuse;
  const ngl = raw.gpuLayers;
  const allLayers = ngl === 'all' || (ngl !== undefined && (ngl >= 999 || (input.blockCount !== undefined && ngl >= input.blockCount)));
  if (ngl !== undefined && !allLayers) out.gpuLayers = ngl;
  if (raw.cpuMoe !== undefined && raw.cpuMoe !== 0) out.cpuMoe = raw.cpuMoe;
  if (raw.threads !== undefined) out.threads = raw.threads;
  if (raw.draftModel !== undefined) out.draftModel = raw.draftModel;
  if (raw.draftMax !== undefined) out.draftMax = raw.draftMax;
  if (raw.draftMin !== undefined) out.draftMin = raw.draftMin;
  const legacySpec = raw.speculativeModel !== undefined || raw.speculativeTokens !== undefined;
  const speculative = raw.speculative ?? (legacySpec ? stableStringify({ model: raw.speculativeModel, num_speculative_tokens: raw.speculativeTokens }) : undefined);
  if (speculative !== undefined) out.speculative = speculative;
  if (raw.maxNumBatchedTokens !== undefined) out.maxNumBatchedTokens = raw.maxNumBatchedTokens;
  if (raw.gpuMemoryUtilization !== undefined && raw.gpuMemoryUtilization !== VLLM_DEFAULTS.gpuMemoryUtilization) out.gpuMemoryUtilization = raw.gpuMemoryUtilization;
  if (raw.enforceEager === true) out.enforceEager = true;
  if (raw.blockSize !== undefined && raw.blockSize !== VLLM_DEFAULTS.blockSize) out.blockSize = raw.blockSize;
  if (raw.cudaGraphSizes !== undefined) out.cudaGraphSizes = [...new Set(raw.cudaGraphSizes)].sort((a, b) => a - b);
  if (raw.dtype !== undefined && raw.dtype !== 'auto') out.dtype = raw.dtype;
  if (raw.quantization !== undefined) out.quantization = raw.quantization;
  const rope = raw.rope;
  // "none", or a factor of 1, changes nothing: the same configuration as without it.
  if (rope && rope.type !== 'none' && rope.factor !== 1 && (rope.type !== undefined || rope.factor !== undefined)) {
    out.ropeScaling = {
      type: rope.type ?? 'linear',
      ...(rope.factor !== undefined ? { factor: Math.round(rope.factor * 1e4) / 1e4 } : {}),
      ...(rope.originalContext !== undefined ? { originalContext: rope.originalContext } : {}),
    };
  }
  return out;
}

/** Slower-by-design traits of a configuration, as the tuner tags its combinations. */
export type ConfigTag = 'cpu-offload' | 'eager' | 'draft';

/** Tags implied by the settings themselves (the tuner's own tags are added on top). */
export function configTagsOf(p: ConfigParams): ConfigTag[] {
  const tags: ConfigTag[] = [];
  if (p.cpuMoe !== undefined || p.gpuLayers !== undefined) tags.push('cpu-offload');
  if (p.enforceEager) tags.push('eager');
  if (p.draftModel !== undefined || p.speculative !== undefined) tags.push('draft');
  return tags;
}

// ---- identity and key ----------------------------------------------------------------------------

/** "sha256:…" when the file hash is known, "repo:owner/name@rev" for a vLLM repo, else "weak:<weak key>". */
export function modelKeyOf(m: { format: string; repo?: string | undefined; revision?: string | undefined; sha256?: string | undefined; weakKey: string }): string {
  if (m.format === 'safetensors' && m.repo) return `repo:${m.repo}@${m.revision ?? 'main'}`;
  if (m.sha256) return `sha256:${m.sha256}`;
  return `weak:${m.weakKey}`;
}

/** The card: its uuid when known, else this PC + the card's name. */
export function gpuKeyOf(g: { hostId: string; gpuUuid?: string | undefined; gpuName?: string | undefined }): string {
  return g.gpuUuid ? `gpu:${g.gpuUuid}` : `host:${g.hostId}:${g.gpuName ?? 'none'}`;
}

/**
 * Image, build (or version) and variant: "ghcr.io/ggml-org/llama.cpp:server-cuda b6000", "b11438 cuda-13.4".
 * A custom engine (a fork) comes first ("custom:prismml b11460"): it is never the same configuration as its base.
 */
export function engineReleaseOf(e: {
  image?: string | undefined;
  build?: string | undefined;
  version?: string | undefined;
  variant?: string | undefined;
  customEngine?: { id: string } | undefined;
}): string {
  return [e.customEngine ? `custom:${e.customEngine.id}` : undefined, e.image, e.build ?? e.version, e.variant].filter(Boolean).join(' ');
}

export interface ConfigKeyParts {
  engineKind: EngineKind;
  engineRelease: string;
  model: string;
  gpu: string;
  params: ConfigParams;
}

/** The canonical text of a configuration: equal configurations, equal text. */
export function configKeyOf(parts: ConfigKeyParts): string {
  return stableStringify(parts);
}

/** Short stable id of a configuration key (two FNV-1a hashes, 16 hex characters). */
export function configIdOf(key: string): string {
  const fnv = (seed: number) => {
    let h = seed >>> 0;
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  };
  return fnv(0x811c9dc5) + fnv(0x01000193 ^ 0x5bd1e995);
}

// ---- API -----------------------------------------------------------------------------------------

/** Median numbers of a configuration at one depth (prompt length, or how full the context was). */
export const depthPointSchema = z.object({
  depth: z.number().int().positive(),
  decodeTps: z.number().optional(),
  prefillTps: z.number().optional(),
  ttftMs: z.number().optional(),
  /** How many sources measured this depth. */
  n: z.number().int().positive(),
});
export type DepthPoint = z.infer<typeof depthPointSchema>;

/** A test that measured the configuration: a normal run, or one combination of a tune run. */
export const configSourceSchema = z.object({
  runId: z.string(),
  /** Index into the run's tuning.combinations. */
  combo: z.number().int().min(0).optional(),
  date: z.string(),
  /** The test's profile ('tune' for a combination). */
  profile: profileSchema,
  contextSize: z.number().int().optional(),
  vramPeakMiB: z.number().optional(),
  /** The source's own numbers at each depth it measured (provenance of a preset). */
  points: z.array(depthPointSchema.omit({ n: true })).default([]),
  /** Most users served at once (concurrency above 1): how many, each one's and the combined generation speed. */
  parallel: z.object({ users: z.number().int(), perUserTps: z.number().optional(), totalTps: z.number() }).optional(),
  /** The test spilled to shared system memory (validity 'shared_memory_spill'): its numbers are not the card's. */
  spill: z.boolean().optional(),
});
export type ConfigSource = z.infer<typeof configSourceSchema>;

export const configEntrySchema = z.object({
  /** Stable id (configIdOf of the key). */
  id: z.string(),
  engineKind: engineKindSchema,
  /** "llama.cpp b11438 (cuda-13.4)". */
  engineLabel: z.string(),
  engineRelease: z.string(),
  model: z.object({
    key: z.string(),
    name: z.string(),
    quant: z.string().optional(),
    sha256: z.string().optional(),
    weakKey: z.string(),
    repo: z.string().optional(),
  }),
  gpu: z.object({ key: z.string(), name: z.string(), hostId: z.string(), hostLabel: z.string() }),
  params: configParamsSchema,
  /** Context the engine was started with (the largest of the sources). */
  contextSize: z.number().int().optional(),
  points: z.array(depthPointSchema),
  /** Highest VRAM peak among the sources, MiB. */
  vramPeakMiB: z.number().optional(),
  /** Most users any source served at once, with the medians of the sources at that level. */
  parallel: z.object({ users: z.number().int(), perUserTps: z.number().optional(), totalTps: z.number() }).optional(),
  tags: z.array(z.enum(['cpu-offload', 'eager', 'draft'])).default([]),
  /**
   * Its tests spilled to shared system memory ("RAM condivisa"): tests that spilled never merge with
   * the ones that did not, so the clean numbers of the same settings stay clean.
   */
  spill: z.boolean().optional(),
  /** Newest first. */
  sources: z.array(configSourceSchema),
  /** Date of the newest source. */
  latest: z.string(),
});
export type ConfigEntry = z.infer<typeof configEntrySchema>;

export const configGpuSchema = z.object({
  key: z.string(),
  name: z.string(),
  hostId: z.string(),
  hostLabel: z.string(),
  /** This PC's card. */
  here: z.boolean(),
  configs: z.number().int(),
});
export type ConfigGpu = z.infer<typeof configGpuSchema>;

export const configsResponseSchema = z.object({
  configs: z.array(configEntrySchema),
  /** Every card with configurations, this PC's first. */
  gpus: z.array(configGpuSchema),
  /** Models and engines on the chosen card (before the model/engine/context filters), for the filter menus. */
  models: z.array(z.object({ key: z.string(), name: z.string(), quant: z.string().optional() })),
  engines: z.array(engineKindSchema),
  /** The card the list is for (the `gpu` filter, else this PC's); null = every card. */
  gpu: z.string().nullable(),
});
export type ConfigsResponse = z.infer<typeof configsResponseSchema>;

/** `gpu` = a card key, "all" for every card (default: this PC's card); `model` = a model key. */
export const configsQuerySchema = z.object({
  gpu: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  engine: engineKindSchema.optional(),
  minContext: z.coerce.number().int().positive().optional(),
});
export type ConfigsQuery = z.infer<typeof configsQuerySchema>;

export const ALL_GPUS = 'all';
