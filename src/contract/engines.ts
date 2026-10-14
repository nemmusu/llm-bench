import { z } from 'zod';

/**
 * How an engine runs. SGLang: Docker everywhere (`lmsysorg/sglang`, on Windows through Docker
 * Desktop's WSL2 GPU), native on Linux only. 'command': a program the user names with a command
 * template (contract/custom-engines.ts) that serves the OpenAI API: LLM Bench starts and stops it,
 * and measures it like an external endpoint.
 */
export const ENGINE_KINDS = [
  'llamacpp-native',
  'llamacpp-docker',
  'vllm-docker',
  'vllm-native',
  'sglang-docker',
  'sglang-native',
  'external',
  'command',
  // NInfer (C++/CUDA engine for Qwen3.5–3.8 on one RTX 5090, contract/ninfer.ts): Linux, or inside a WSL distro on Windows.
  'ninfer-native',
  'ninfer-wsl',
] as const;
export const engineKindSchema = z.enum(ENGINE_KINDS);
export type EngineKind = z.infer<typeof engineKindSchema>;

/**
 * API flavour spoken by the server under test. 'openai' = OpenAI `/v1/completions`; 'openai-chat' =
 * OpenAI `/v1/chat/completions` only (NInfer, chat-only servers): text prompts, sent as a user message.
 */
export const apiFlavorSchema = z.enum(['llamacpp', 'vllm', 'sglang', 'openai', 'openai-chat']);
export type ApiFlavor = z.infer<typeof apiFlavorSchema>;

/**
 * The engine behind a kind: which flags, logs, readiness and tuner dimensions apply. 'external'
 * covers every OpenAI server LLM Bench only talks to (external endpoints) or starts from a command
 * template ('command'): no known flags.
 */
export type EngineBase = 'llamacpp' | 'vllm' | 'sglang' | 'ninfer' | 'external';

export function engineBaseOf(kind: EngineKind): EngineBase {
  switch (kind) {
    case 'llamacpp-native':
    case 'llamacpp-docker':
      return 'llamacpp';
    case 'vllm-docker':
    case 'vllm-native':
      return 'vllm';
    case 'sglang-docker':
    case 'sglang-native':
      return 'sglang';
    case 'ninfer-native':
    case 'ninfer-wsl':
      return 'ninfer';
    default:
      return 'external';
  }
}

/** Kinds that run in a Docker container (image pull, volumes, Docker Desktop on Windows). */
export function isDockerKind(kind: EngineKind): boolean {
  return kind === 'llamacpp-docker' || kind === 'vllm-docker' || kind === 'sglang-docker';
}

/**
 * RoPE context extension: the model reads `factor` times the context it was trained on.
 *   llama.cpp  --rope-scaling yarn|linear --rope-scale <factor> --yarn-orig-ctx <originalContext>
 *   vLLM       --hf-overrides {"rope_scaling":{"rope_type":"yarn","factor":…,"original_max_position_embeddings":…}}
 *              (older builds without --hf-overrides: --rope-scaling with the same JSON)
 *   SGLang     --json-model-override-args with the same rope_scaling JSON
 * `linear` is plain position interpolation; `yarn` keeps short prompts close to the original quality.
 */
export const ropeScalingSchema = z.object({
  type: z.enum(['yarn', 'linear']),
  /** Context multiplier, e.g. 4 for 32K → 128K. */
  factor: z.number().min(1).max(64),
  /** The context the model was trained with, tokens (its config's original_max_position_embeddings). */
  originalContext: z.number().int().positive(),
});
export type RopeScaling = z.infer<typeof ropeScalingSchema>;

/**
 * NInfer KV-cache storage (--kv-dtype) of the official build: bf16 (its default), int8 (group-64), fp8,
 * nvfp4, k8v4 (K int8, V 4-bit). Variants add their own (NInfer-all: rk8v4, rk4v4, rk4v4-e8, rk2v4-e8):
 * a launch may name any value its build's --help lists (core/engines/ninfer: the probe reads them).
 */
export const NINFER_KV_DTYPES = ['bf16', 'int8', 'fp8', 'nvfp4', 'k8v4'] as const;
/** A --kv-dtype value: one of the official ones, or a variant's (a short lower-case word: it becomes a CLI argument). */
export type NinferKvDtype = string;
export const NINFER_KV_DTYPE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** NInfer speculative decoding (--spec): the model's MTP head, DFlash (35B-A3B), DFlash2 (Qwen3.8-27B); 'off' = none. */
export const NINFER_SPECS = ['off', 'mtp', 'dflash', 'dflash2'] as const;
export type NinferSpec = (typeof NINFER_SPECS)[number];

/**
 * NInfer's own launch settings (LaunchParams.ninfer). The shared fields keep their meaning:
 * contextSize → --max-context (each request's ceiling, prompt + answer), parallel → --max-concurrency
 * (requests served at once, 1..8). Unset = NInfer's default, except what LLM Bench sets for benchmarks
 * (core/engines/ninfer/args.ts: no prefix reuse, no thinking).
 */
export const ninferParamsSchema = z.object({
  /** --kv-capacity: tokens of the KV pool shared by every request, or 'auto' (all the memory left, 1 GiB spare). Unset = --max-context. */
  kvCapacity: z.union([z.number().int().positive(), z.literal('auto')]).optional(),
  kvDtype: z.string().regex(NINFER_KV_DTYPE).optional(),
  spec: z.enum(NINFER_SPECS).optional(),
  /** --draft-tokens: MTP 1..5, DFlash / DFlash2 1..15. */
  draftTokens: z.number().int().min(1).max(15).optional(),
  /** --lm-head-draft: the optimized proposal head. */
  lmHeadDraft: z.boolean().optional(),
  /** --vision: image and video input (loads the vision weights and workspace). */
  vision: z.boolean().optional(),
  /** Context cache (prefix reuse on only): --device-state-slots, --host-state-slots, --host-kv-mib. */
  deviceStateSlots: z.number().int().min(0).optional(),
  hostStateSlots: z.number().int().min(0).optional(),
  hostKvMib: z.number().int().min(0).optional(),
  /** false = --no-prefix-reuse (benchmarks: every prompt read in full). */
  prefixReuse: z.boolean().optional(),
  /** false = --no-thinking (benchmarks); true = the model's default (thinking on). */
  thinking: z.boolean().optional(),
  /** --preserve-thinking: keep closed turns' reasoning in the history. */
  preserveThinking: z.boolean().optional(),
});
export type NinferParams = z.infer<typeof ninferParamsSchema>;

/**
 * User-facing launch parameters. Beginners never see most of these: defaults come from
 * the planner. `undefined` means "let LLM Bench decide".
 */
export const launchParamsSchema = z.object({
  contextSize: z.number().int().positive().optional(),
  gpuLayers: z.number().int().min(0).optional(),
  flashAttention: z.enum(['auto', 'on', 'off']).optional(),
  /**
   * llama.cpp -ctk/-ctv (K = V, a quantized type turns flash attention on); vLLM / SGLang
   * --kv-cache-dtype (q8_0/q4_0 → fp8).
   */
  kvCacheType: z.enum(['f16', 'q8_0', 'q4_0', 'fp8', 'auto']).optional(),
  batchSize: z.number().int().positive().optional(),
  ubatchSize: z.number().int().positive().optional(),
  threads: z.number().int().positive().optional(),
  parallel: z.number().int().positive().optional(),
  /** vLLM --gpu-memory-utilization; SGLang --mem-fraction-static. */
  gpuMemoryUtilization: z.number().min(0.1).max(0.99).optional(),
  maxModelLen: z.number().int().positive().optional(),
  dtype: z.string().optional(),
  quantization: z.string().optional(),
  /** Context extension beyond the model's trained context (YaRN / linear RoPE scaling). */
  ropeScaling: ropeScalingSchema.optional(),
  /** NInfer's own settings (ninfer-native / ninfer-wsl). */
  ninfer: ninferParamsSchema.optional(),
  /** Extra raw CLI arguments appended verbatim (expert mode). */
  extraArgs: z.array(z.string()).default([]),
  /** Extra environment variables (expert mode). */
  env: z.record(z.string(), z.string()).default({}),
});
export type LaunchParams = z.infer<typeof launchParamsSchema>;

export const engineConfigSchema = z.object({
  kind: engineKindSchema,
  /** llamacpp-native: path to a custom llama-server executable; otherwise the managed build is used. */
  executable: z.string().optional(),
  /** llamacpp-native managed build tag, e.g. "b11438". */
  build: z.string().optional(),
  /** Docker engines: image reference, e.g. "vllm/vllm-openai:v0.12.0", "lmsysorg/sglang:v0.5.4". */
  image: z.string().optional(),
  /** external: base URL of an OpenAI-compatible server. */
  baseUrl: z.string().url().optional(),
  apiKey: z.string().optional(),
  flavor: apiFlavorSchema.optional(),
  /** vllm-native: path to the `vllm` executable or venv. */
  vllmPath: z.string().optional(),
  /** sglang-native: the Python of an environment with SGLang installed, or that environment's folder. */
  sglangPath: z.string().optional(),
  /**
   * command: the command line that starts an OpenAI-compatible server, with placeholders
   * (contract/custom-engines.ts COMMAND_PLACEHOLDERS, expandCommandTemplate). A custom engine's commands
   * before and after the server come with it in the core (CoreEngineConfig.commandRun).
   */
  command: z.string().optional(),
  /**
   * A custom engine of settings.customEngines ("Motori personalizzati"). The core fills in what it
   * names (executable, image, vllmPath, sglangPath or command, extra arguments, environment); `kind`
   * must be the kind it runs as (customEngineKindOf).
   */
  customEngineId: z.string().optional(),
  /** Docker engines: read the model from this named volume instead of a host folder (faster on Windows). */
  modelVolume: z.string().optional(),
  /**
   * ninfer-native / ninfer-wsl: the ninfer-serve program, or its NInfer checkout (build/apps/ninfer-serve
   * inside it). A Linux path: for WSL, inside the distro. Absent = the one saved in settings.ninfer.
   */
  ninferPath: z.string().optional(),
  /** ninfer-wsl: the WSL distro NInfer runs in (wsl.exe -d). Absent = the saved one. */
  wslDistro: z.string().optional(),
});
export type EngineConfig = z.infer<typeof engineConfigSchema>;

export const engineStatusSchema = z.object({
  kind: engineKindSchema,
  available: z.boolean(),
  installed: z.boolean(),
  version: z.string().optional(),
  variant: z.string().optional(),
  location: z.string().optional(),
  /** Why the engine cannot be used right now (error codes, see errors.ts). */
  problems: z.array(z.string()).default([]),
  /** Values for the first problem's message (e.g. the missing system library and its package). */
  problemParams: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  supported: z.boolean().default(true),
  /** Status of a custom engine (GET /api/engines/custom): its id in settings.customEngines. */
  customEngineId: z.string().optional(),
});
export type EngineStatus = z.infer<typeof engineStatusSchema>;
