import { z } from 'zod';
import { KV_CACHE_TYPE } from './kv-cache';

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
  // NVIDIA TensorRT-LLM (`trtllm-serve`): its NGC image (nvcr.io/nvidia/tensorrt-llm/release), or a Python
  // environment with the tensorrt_llm package: on Linux, or inside a WSL distro on Windows.
  'trtllm-docker',
  'trtllm-native',
] as const;
export const engineKindSchema = z.enum(ENGINE_KINDS);
export type EngineKind = z.infer<typeof engineKindSchema>;

/**
 * API flavour spoken by the server under test. 'openai' = OpenAI `/v1/completions`; 'openai-chat' =
 * OpenAI `/v1/chat/completions` only (NInfer, chat-only servers): text prompts, sent as a user message.
 * 'trtllm' = TensorRT-LLM's `trtllm-serve`: `/v1/completions` with vLLM's extensions (token ids,
 * min_tokens, continuous usage), its tokenizer at `/_internal/tokenize`.
 */
export const apiFlavorSchema = z.enum(['llamacpp', 'vllm', 'sglang', 'openai', 'openai-chat', 'trtllm']);
export type ApiFlavor = z.infer<typeof apiFlavorSchema>;

/**
 * The engine behind a kind: which flags, logs, readiness and tuner dimensions apply. 'external'
 * covers every OpenAI server LLM Bench only talks to (external endpoints) or starts from a command
 * template ('command'): no known flags.
 */
export type EngineBase = 'llamacpp' | 'vllm' | 'sglang' | 'ninfer' | 'trtllm' | 'external';

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
    case 'trtllm-docker':
    case 'trtllm-native':
      return 'trtllm';
    default:
      return 'external';
  }
}

/** Kinds that run in a Docker container (image pull, volumes, Docker Desktop on Windows). */
export function isDockerKind(kind: EngineKind): boolean {
  return kind === 'llamacpp-docker' || kind === 'vllm-docker' || kind === 'sglang-docker' || kind === 'trtllm-docker';
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
 * TensorRT-LLM KV-cache storage (`trtllm-serve --kv_cache_dtype`): 'auto' = what the checkpoint says
 * (bf16/fp16, or fp8 for a ModelOpt checkpoint quantized with an FP8 KV cache), 'fp8', 'nvfp4'
 * (Blackwell only, a prototype in TensorRT-LLM).
 */
export const TRTLLM_KV_DTYPES = ['auto', 'fp8', 'nvfp4'] as const;
export type TrtllmKvDtype = (typeof TRTLLM_KV_DTYPES)[number];
/** trtllm-serve's own default share of the free memory (after the weights) its KV cache takes. */
export const TRTLLM_DEFAULT_KV_FRACTION = 0.9;

/**
 * TensorRT-LLM's own launch settings (LaunchParams.trtllm, kinds 'trtllm-docker' / 'trtllm-native').
 * The shared fields keep their meaning: maxModelLen (else contextSize) → --max_seq_len (each request's
 * ceiling, prompt + answer), parallel → --max_batch_size (requests served at once), batchSize →
 * --max_num_tokens (tokens one engine step reads), kvCacheType 'auto' / 'fp8' / 'nvfp4' → --kv_cache_dtype as it is,
 * 'q8_0' / 'q4_0' → fp8 (any other type: TensorRT-LLM's default). Unset = what LLM Bench passes (shown in the command), else trtllm-serve's default.
 */
export const trtllmParamsSchema = z.object({
  /**
   * --kv_cache_free_gpu_memory_fraction: the share of the GPU memory still free once the weights and
   * the engine's buffers are loaded that the KV cache takes (the rest stays free). Unset = 0.9.
   */
  kvCacheFreeMemoryFraction: z.number().min(0.05).max(0.99).optional(),
  /** --kv_cache_dtype: wins over kvCacheType. */
  kvCacheDtype: z.enum(TRTLLM_KV_DTYPES).optional(),
  /** --tp_size: GPUs the model is split across (tensor parallelism). Unset = 1 (one GPU). */
  tensorParallel: z.number().int().min(1).max(8).optional(),
  /**
   * --enable_chunked_prefill: long prompts are read in steps of --max_num_tokens (without it a prompt
   * longer than that is refused). Unset = on (LLM Bench passes it); false = left out.
   */
  chunkedPrefill: z.boolean().optional(),
  /** --trust_remote_code: run the model repository's own Python code (custom architectures). */
  trustRemoteCode: z.boolean().optional(),
});
export type TrtllmParams = z.infer<typeof trtllmParamsSchema>;

/** TensorRT-LLM's own settings in a few words, as its flags say them ("kv_cache_dtype fp8 · tp_size 2"); '' = none set. */
export function trtllmParamsText(p: TrtllmParams | undefined): string {
  if (!p) return '';
  const parts: string[] = [];
  if (p.kvCacheDtype !== undefined) parts.push(`kv_cache_dtype ${p.kvCacheDtype}`);
  if (p.kvCacheFreeMemoryFraction !== undefined) parts.push(`kv_cache_free_gpu_memory_fraction ${p.kvCacheFreeMemoryFraction}`);
  if (p.tensorParallel !== undefined) parts.push(`tp_size ${p.tensorParallel}`);
  if (p.chunkedPrefill !== undefined) parts.push(`chunked_prefill ${p.chunkedPrefill ? 'on' : 'off'}`);
  if (p.trustRemoteCode) parts.push('trust_remote_code');
  return parts.join(' · ');
}

/**
 * User-facing launch parameters. Beginners never see most of these: defaults come from
 * the planner. `undefined` means "let LLM Bench decide".
 */
export const launchParamsSchema = z.object({
  contextSize: z.number().int().positive().optional(),
  gpuLayers: z.number().int().min(0).optional(),
  flashAttention: z.enum(['auto', 'on', 'off']).optional(),
  /**
   * llama.cpp -ctk/-ctv (K = V, a quantized type turns flash attention on): f16, q8_0, q4_0, or any
   * type the build lists (a fork's turbo3…: contract/kv-cache.ts); vLLM / SGLang --kv-cache-dtype
   * 'auto' / 'fp8' (q8_0/q4_0 → fp8).
   */
  kvCacheType: z.string().regex(KV_CACHE_TYPE).optional(),
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
  /**
   * Image (and video) input, for a model that has it ("Immagini"): llama.cpp loads the model's projector
   * (--mmproj) only when true or unset; vLLM / SGLang turn their multimodal part off with false; NInfer
   * reads ninfer.vision (the form writes there). Unset = on when the model has it (the engine's default).
   */
  vision: z.boolean().optional(),
  /**
   * Reasoning ("Ragionamento"), for a model that thinks before it answers: false = the request asks for
   * none (chat template enable_thinking false, gpt-oss lowest effort); NInfer reads ninfer.thinking.
   * Unset = on when the model has it. With it on the speed counts every token written, thoughts included.
   */
  reasoning: z.boolean().optional(),
  /** TensorRT-LLM's own settings (trtllm-docker / trtllm-native). */
  trtllm: trtllmParamsSchema.optional(),
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
  /**
   * ninfer-wsl: the WSL distro NInfer runs in (wsl.exe -d). Absent = the saved one.
   * trtllm-native on Windows: the distro TensorRT-LLM runs in. Absent = WSL's default distro.
   */
  wslDistro: z.string().optional(),
  /**
   * trtllm-native: the Python of an environment with TensorRT-LLM installed (tensorrt_llm), or that
   * environment's folder (bin/python inside it). A Linux path: on Windows, inside the WSL distro.
   * Absent = LLM Bench's own environment (enginesDir/trtllm-venv on Linux, ~/.llm-bench/trtllm-venv in WSL).
   */
  trtllmPath: z.string().optional(),
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
