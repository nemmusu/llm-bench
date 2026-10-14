/**
 * VRAM fit estimator.
 *
 * Inspired by llmfit (github.com/AlexsJones/llmfit, MIT licence, © Alex Jones): its
 * bytes-per-parameter table, KV = 2·n_kv_heads·head_dim·ctx·bytes and the 60 / 85 / 98 %
 * utilization levels. LLM Bench is more precise:
 *  - weights are the real file bytes (all shards) when known, minus the input embeddings that
 *    llama.cpp keeps in RAM when the output tensor is separate;
 *  - the KV cache is summed per layer group from the real metadata: per-layer KV heads and head
 *    sizes, sliding-window layers capped at the window, recurrent (SSM) layers with a fixed state;
 *  - overhead = CUDA context + a compute-buffer approximation that grows with ubatch and ctx;
 *  - two verdicts: `level` on the card's TOTAL memory minus a fixed reserve (VRAM_RESERVE_MIB, the
 *    driver and the desktop), the same whatever else is open; `levelNow` on what a launch right now
 *    gets, min(free VRAM, total − reserve), which the spill warnings, fixes, tuner and server follow;
 *  - vLLM follows its own rule (the KV budget inside gpu_memory_utilization × total must hold at
 *    least one sequence of max_model_len; right now that share must also be free) and reports the
 *    concurrency it allows;
 *  - TensorRT-LLM gives its KV cache a share of the memory still free once the weights are in
 *    (kv_cache_free_gpu_memory_fraction): that pool must hold one sequence of max_seq_len;
 *  - llama.cpp partial offload reports the largest -ngl that fits;
 *  - llama.cpp estimates can be calibrated with the VRAM peaks measured on this GPU (calibration.ts):
 *    the KV cache + compute buffer part is scaled (and, for the very same model, offset) to match.
 */
import type { LaunchParams, EngineKind } from '../../contract/engines';
import type { NinferManifest } from '../../contract/formats';
import { llamaKvBits } from '../../contract/kv-cache';
import { VRAM_RESERVE_MIB, type FitEstimate, type FitFixes, type FitLevel, type HubFile } from '../../contract/models';
import { bytesPerParam } from './quant';
import type { GpuMem, KvLayout, ModelFactsEx } from './types';

const MIB = 1024 * 1024;

/** CUDA context + cuBLAS workspace of a llama.cpp process (measured ~300–400 MiB on RTX 30/50). */
export const CUDA_CONTEXT_MIB = 350;
/** Context used when the caller does not choose one (capped by the model's own maximum). */
export const DEFAULT_FIT_CONTEXT = 8192;
export const DEFAULT_UBATCH = 512;
export const VLLM_DEFAULT_GPU_UTIL = 0.9;
/** vLLM memory outside torch's profiled peak: CUDA context, CUDA graphs, NCCL buffers. */
export const VLLM_NON_TORCH_MIB = 512;
/** TensorRT-LLM's --kv_cache_free_gpu_memory_fraction default (contract TRTLLM_DEFAULT_KV_FRACTION). */
export const TRTLLM_DEFAULT_FREE_FRACTION = 0.9;
/** llama.cpp pads the KV cache to multiples of 256 cells. */
const KV_PAD = 256;
/** Fallbacks when metadata is missing: typical 7–8B GQA shapes and a large-ish vocabulary. */
const FALLBACK = { layers: 32, kvHeads: 8, headDim: 128, embd: 4096, heads: 32, vocab: 152064, paramsB: 7 };

export const LEVEL_THRESHOLDS = { perfect: 0.6, good: 0.85, tight: 0.98 } as const;
const LEVEL_ORDER: FitLevel[] = ['perfect', 'good', 'tight', 'partial', 'no'];

/** Lower is better: perfect 0 … no 4. */
export function levelRank(level: FitLevel): number {
  return LEVEL_ORDER.indexOf(level);
}

/** Machine-readable notes; the renderer translates them. */
export const FIT_NOTES = {
  paramsHeuristic: 'weights.params-heuristic',
  paramsUnknown: 'weights.params-unknown',
  embeddingsOnCpu: 'weights.input-embeddings-on-cpu',
  kvAssumed: 'kv.assumed-layout',
  /** A KV type LLM Bench does not know the size of (a fork's own): its cache is counted as f16. */
  kvTypeUnknown: 'kv.type-unknown',
  slidingWindow: 'kv.sliding-window',
  recurrent: 'kv.recurrent-state',
  contextOverModel: 'context.exceeds-model',
  /** Beyond the trained context on purpose, within what the RoPE scaling (YaRN / linear) extends it to. */
  contextExtended: 'context.rope-extended',
  partialOffload: 'llamacpp.partial-offload',
  budgetOverFree: 'vllm.budget-exceeds-free',
  kvTooSmall: 'vllm.kv-too-small',
  external: 'engine.external',
} as const;

export interface FitParams {
  /** Tokens per sequence (llama.cpp -c per slot, vLLM max_model_len when maxModelLen is unset). */
  contextSize?: number;
  /** f16 / q8_0 / q4_0, a fork's type (turbo3…), vLLM 'fp8' / 'auto' (contract/kv-cache.ts). */
  kvCacheType?: string;
  ubatchSize?: number;
  /** llama.cpp slots (-np) / vLLM concurrent sequences the user wants. */
  parallel?: number;
  /**
   * llama.cpp --kv-unified: slots share one cache of contextSize cells. Default false: each slot
   * gets its own contextSize (llama-server then needs -c contextSize×parallel), so KV × parallel.
   */
  kvUnified?: boolean;
  flashAttention?: 'auto' | 'on' | 'off';
  gpuMemoryUtilization?: number;
  maxModelLen?: number;
  /** YaRN / linear RoPE scaling: a context up to originalContext × factor is extended on purpose. */
  ropeScaling?: Pick<NonNullable<LaunchParams['ropeScaling']>, 'factor' | 'originalContext'>;
  /** TensorRT-LLM: --kv_cache_free_gpu_memory_fraction (default 0.9). */
  kvFreeFraction?: number;
}

/**
 * Correction from measured VRAM peaks (llama.cpp only: vLLM reserves its whole memory share whatever
 * the context). need = weights + CUDA context + offsetMiB + scale × (KV cache + compute buffer).
 */
export interface FitCalibration {
  scale: number;
  offsetMiB: number;
  /** Measurements it comes from (at least 2). */
  samples: number;
  /** Median error of the corrected estimate on those measurements, % of the measured peak. */
  errorPct: number;
  scope: 'model' | 'architecture';
}

/** Files a llama.cpp launch loads next to the model (a recipe's or the user's arguments). */
export interface FitExtras {
  /** -md: a draft GGUF or an MTP head; its facts when they could be read. */
  draft?: { bytes: number; facts?: ModelFactsEx | undefined };
  /** --mmproj: the image projector. */
  mmprojBytes?: number;
}

export interface FitInput {
  facts: ModelFactsEx;
  /** Bytes of all weight files (every shard). */
  fileBytes?: number;
  gpu: GpuMem;
  engine: EngineKind;
  params?: FitParams;
  calibration?: FitCalibration;
  extras?: FitExtras;
}

/** Draft and projector flags of llama-server, with the value after them (or after "="). */
export const DRAFT_FLAGS = ['-md', '--model-draft'] as const;
export const MMPROJ_FLAGS = ['-mm', '--mmproj'] as const;

/** The value of the first of `flags` in a launch's arguments ("-md x", "--mmproj=x"). */
export function flagValue(args: readonly string[], flags: readonly string[]): string | undefined {
  for (const [i, a] of args.entries()) {
    if (flags.includes(a)) return args[i + 1];
    const eq = flags.find((f) => a.startsWith(`${f}=`));
    if (eq) return a.slice(eq.length + 1);
  }
  return undefined;
}

/**
 * VRAM of the draft model: its weights and its KV cache for the same context (f16, llama.cpp's draft
 * default). An MTP head (or a file whose layout could not be read) holds about one layer of the model's KV.
 */
function draftMiBOf(draft: NonNullable<FitExtras['draft']>, model: { layout: KvLayout; layers: number }, kv: (layout: KvLayout) => number): number {
  const own = draft.facts && !draft.facts.mtpOnly ? kv(kvLayoutOf(draft.facts).layout) : kv(model.layout) / model.layers;
  return Math.round((draft.bytes + own) / MIB);
}

export function fitParamsFrom(p: LaunchParams | undefined): FitParams {
  if (!p) return {};
  const out: FitParams = {};
  if (p.contextSize !== undefined) out.contextSize = p.contextSize;
  if (p.kvCacheType !== undefined) out.kvCacheType = p.kvCacheType;
  if (p.ubatchSize !== undefined) out.ubatchSize = p.ubatchSize;
  if (p.parallel !== undefined) out.parallel = p.parallel;
  // llama.cpp -c is the whole context: with several slots LLM Bench shares one pool (--kv-unified)
  // unless the extra arguments split it (each slot then gets -c / slots).
  if (p.parallel !== undefined && p.parallel > 1) {
    out.kvUnified = !p.extraArgs.some((a) => a === '--no-kv-unified' || a === '-no-kvu');
    if (!out.kvUnified && p.contextSize !== undefined) out.contextSize = Math.max(1, Math.floor(p.contextSize / p.parallel));
  }
  if (p.flashAttention !== undefined) out.flashAttention = p.flashAttention;
  if (p.gpuMemoryUtilization !== undefined) out.gpuMemoryUtilization = p.gpuMemoryUtilization;
  if (p.maxModelLen !== undefined) out.maxModelLen = p.maxModelLen;
  if (p.ropeScaling !== undefined) out.ropeScaling = { factor: p.ropeScaling.factor, originalContext: p.ropeScaling.originalContext };
  if (p.trtllm?.kvCacheFreeMemoryFraction !== undefined) out.kvFreeFraction = p.trtllm.kvCacheFreeMemoryFraction;
  if (p.trtllm?.kvCacheDtype !== undefined) out.kvCacheType = p.trtllm.kvCacheDtype;
  return out;
}

/**
 * vLLM and SGLang reserve a share of the card up front (gpu_memory_utilization / mem-fraction-static);
 * TensorRT-LLM a share of what is free after the weights; the rest grow as llama.cpp does.
 */
function family(engine: EngineKind): 'llamacpp' | 'vllm' | 'trtllm' {
  if (engine === 'trtllm-docker' || engine === 'trtllm-native') return 'trtllm';
  return engine === 'vllm-docker' || engine === 'vllm-native' || engine === 'sglang-docker' || engine === 'sglang-native' ? 'vllm' : 'llamacpp';
}

/** Engines that run safetensors folders: vLLM, SGLang and TensorRT-LLM. */
export function runsSafetensors(engine: EngineKind): boolean {
  return family(engine) !== 'llamacpp';
}

/** NVFP4 KV cache: 4-bit values with one 8-bit scale per 16 (TensorRT-LLM --kv_cache_dtype nvfp4). */
export const NVFP4_KV_BYTES = 9 / 16;

/**
 * KV cache bytes per element. vLLM, SGLang and TensorRT-LLM have no q8_0/q4_0: both map to their fp8
 * cache (1 byte); TensorRT-LLM's nvfp4 is NVFP4_KV_BYTES. llama.cpp: the type's bits per value (q8_0 8.5,
 * q4_0 4.5, a fork's turbo3 3.125…); a type of unknown size counts as f16 (2 bytes, the safe side).
 */
export function kvElementBytes(fam: 'llamacpp' | 'vllm' | 'trtllm', type: FitParams['kvCacheType']): number {
  if (type === 'fp8') return 1;
  if (fam === 'trtllm' && type === 'nvfp4') return NVFP4_KV_BYTES;
  if (fam !== 'llamacpp') return type === 'q8_0' || type === 'q4_0' ? 1 : 2;
  const bits = type === undefined ? undefined : llamaKvBits(type);
  return bits === undefined ? 2 : bits / 8;
}

/** A llama.cpp launch asks for a KV type whose size is not known (it is estimated as f16). */
export function kvSizeUnknown(type: FitParams['kvCacheType']): boolean {
  return type !== undefined && type !== 'auto' && type !== 'fp8' && llamaKvBits(type) === undefined;
}

/** The exact layout when the metadata gave one, else a uniform stack built from the scalar facts. */
export function kvLayoutOf(facts: ModelFactsEx): { layout: KvLayout; assumed: boolean } {
  if (facts.kv) return { layout: facts.kv, assumed: false };
  const n = facts.blockCount ?? FALLBACK.layers;
  const kvHeads = facts.headCountKv ?? facts.headCount ?? FALLBACK.kvHeads;
  const k = facts.keyLength ?? (facts.embeddingLength && facts.headCount ? Math.floor(facts.embeddingLength / facts.headCount) : FALLBACK.headDim);
  const v = facts.valueLength ?? k;
  const swa = facts.slidingWindow ? Math.min(facts.slidingWindowLayers ?? 0, n) : 0;
  const full = Math.min(facts.fullAttentionLayers ?? n - swa, n - swa);
  const groups: KvLayout['groups'] = [];
  if (full > 0) groups.push({ layers: full, kvHeads, keyLength: k, valueLength: v });
  if (swa > 0) groups.push({ layers: swa, kvHeads, keyLength: k, valueLength: v, window: facts.slidingWindow as number });
  return { layout: { groups, recurrentLayers: 0, recurrentBytesPerSeq: 0 }, assumed: facts.blockCount === undefined };
}

/** llama.cpp KV bytes for `seqs` slots of `ctx` tokens (SWA cache: window + ubatch per stream). */
export function llamaKvBytes(layout: KvLayout, ctx: number, ub: number, seqs: number, unified: boolean, elem: number): number {
  const padded = Math.ceil(ctx / KV_PAD) * KV_PAD;
  let total = 0;
  for (const g of layout.groups) {
    let cells: number;
    if (g.window) cells = unified ? Math.min(padded, g.window * seqs + ub) : seqs * Math.min(padded, g.window + ub);
    else cells = unified ? padded : padded * seqs;
    total += g.layers * g.kvHeads * (g.keyLength + g.valueLength) * cells * elem;
  }
  return total + layout.recurrentBytesPerSeq * seqs;
}

/** vLLM KV bytes for one sequence of `len` tokens (its hybrid allocator caps SWA layers at the window). */
export function vllmKvBytesPerSeq(layout: KvLayout, len: number, elem: number): number {
  let total = 0;
  for (const g of layout.groups) total += g.layers * g.kvHeads * (g.keyLength + g.valueLength) * (g.window ? Math.min(len, g.window) : len) * elem;
  return total + layout.recurrentBytesPerSeq;
}

/**
 * llama.cpp compute buffer (graph reserve at n_ubatch tokens). Deliberately conservative: the
 * sum of the worst-case logits (n_vocab × ubatch f32, reserved for every token of the ubatch),
 * the FFN/attention activations, the KQ mask and, without flash attention, the materialized KQ.
 */
export function llamaComputeBytes(facts: ModelFactsEx, kvCells: number, ub: number, flash: FitParams['flashAttention']): number {
  const vocab = facts.vocabSize ?? FALLBACK.vocab;
  const embd = facts.embeddingLength ?? FALLBACK.embd;
  const ff = facts.feedForwardLength ?? 4 * embd;
  const heads = facts.headCount ?? FALLBACK.heads;
  const logits = vocab * ub * 4;
  const activations = ub * (4 * embd + 3 * ff) * 4;
  const attention = flash === 'off' ? 2 * heads * kvCells * ub * 4 + kvCells * ub * 4 : kvCells * ub * 4;
  return logits + activations + attention;
}

/** vLLM activation peak seen by its memory profiler: grows with model size (sampler, MLP). */
export function vllmActivationMiB(paramsB: number | undefined): number {
  if (paramsB === undefined) return 2048;
  if (paramsB <= 4) return 1024;
  if (paramsB <= 16) return 1536;
  return 2048;
}

export function levelFor(utilization: number, allowPartial: boolean): FitLevel | undefined {
  if (utilization <= LEVEL_THRESHOLDS.perfect) return 'perfect';
  if (utilization <= LEVEL_THRESHOLDS.good) return 'good';
  if (utilization <= LEVEL_THRESHOLDS.tight) return 'tight';
  return allowPartial ? undefined : 'no';
}

export function estimateFit(input: FitInput): FitEstimate {
  const { facts, gpu } = input;
  const p = input.params ?? {};
  const fam = family(input.engine);
  const notes: string[] = [];
  if (input.engine === 'external') notes.push(FIT_NOTES.external);

  // Weights.
  const fromFile = input.fileBytes !== undefined && input.fileBytes > 0;
  let weightsBytes: number;
  if (fromFile) {
    weightsBytes = input.fileBytes as number;
    if (fam === 'llamacpp' && facts.cpuOnlyFraction) {
      weightsBytes *= 1 - facts.cpuOnlyFraction;
      notes.push(FIT_NOTES.embeddingsOnCpu);
    }
  } else {
    notes.push(FIT_NOTES.paramsHeuristic);
    if (facts.paramsB === undefined) notes.push(FIT_NOTES.paramsUnknown);
    weightsBytes = (facts.paramsB ?? FALLBACK.paramsB) * 1e9 * bytesPerParam(facts.quant);
  }

  // Context and KV layout.
  const modelMax = facts.contextLength;
  const defaultCtx = Math.min(modelMax ?? DEFAULT_FIT_CONTEXT, DEFAULT_FIT_CONTEXT);
  const ctx = Math.max(1, Math.floor((fam === 'llamacpp' ? p.contextSize : (p.maxModelLen ?? p.contextSize)) ?? defaultCtx));
  if (modelMax !== undefined && ctx > modelMax) {
    // With RoPE scaling a longer context is the point: the estimate (linear KV) still holds.
    const extended = p.ropeScaling ? p.ropeScaling.originalContext * p.ropeScaling.factor : 0;
    notes.push(ctx <= extended ? FIT_NOTES.contextExtended : FIT_NOTES.contextOverModel);
  }
  const { layout, assumed } = kvLayoutOf(facts);
  if (assumed) notes.push(FIT_NOTES.kvAssumed);
  if (layout.groups.some((g) => g.window)) notes.push(FIT_NOTES.slidingWindow);
  if (layout.recurrentLayers > 0) notes.push(FIT_NOTES.recurrent);
  const elem = kvElementBytes(fam, p.kvCacheType);
  if (fam === 'llamacpp' && kvSizeUnknown(p.kvCacheType)) notes.push(FIT_NOTES.kvTypeUnknown);
  const seqs = Math.max(1, Math.floor(p.parallel ?? 1));

  const weightsMiB = Math.round(weightsBytes / MIB);

  if (fam === 'vllm') {
    const util = p.gpuMemoryUtilization ?? VLLM_DEFAULT_GPU_UTIL;
    const budgetMiB = Math.max(1, Math.round(util * gpu.totalMiB));
    const kvPerSeqMiB = vllmKvBytesPerSeq(layout, ctx, elem) / MIB;
    const kvMiB = Math.round(kvPerSeqMiB * seqs);
    const overheadMiB = vllmActivationMiB(facts.paramsB) + VLLM_NON_TORCH_MIB;
    const needMiB = weightsMiB + kvMiB + overheadMiB;
    const kvBudgetMiB = budgetMiB - weightsMiB - overheadMiB;
    const utilization = needMiB / budgetMiB;
    let level: FitLevel;
    if (kvBudgetMiB < kvPerSeqMiB || kvBudgetMiB <= 0) {
      level = 'no';
      notes.push(FIT_NOTES.kvTooSmall);
    } else {
      level = levelFor(utilization, false) as FitLevel;
    }
    // vLLM reserves its whole share up front and refuses to start when that much is not free now.
    const overFree = budgetMiB > gpu.freeMiB;
    if (overFree) notes.push(FIT_NOTES.budgetOverFree);
    const est: FitEstimate = {
      level,
      needMiB,
      weightsMiB,
      kvMiB,
      overheadMiB,
      availableMiB: budgetMiB,
      utilization,
      contextSize: ctx,
      basis: fromFile ? 'file-size' : 'params-heuristic',
      notes,
      ...nowOf(gpu),
      levelNow: overFree ? 'no' : level,
    };
    if (kvPerSeqMiB > 0) est.maxConcurrency = Math.max(0, Math.floor(kvBudgetMiB / kvPerSeqMiB));
    return est;
  }

  if (fam === 'trtllm') {
    // TensorRT-LLM: weights + buffers, then its KV pool takes "fraction" of what is still free. vLLM's
    // per-sequence KV size (its paged cache holds whole sequences the same way); the same activation figure.
    const fraction = p.kvFreeFraction ?? TRTLLM_DEFAULT_FREE_FRACTION;
    const usable = usableMiB(gpu);
    const kvPerSeqMiB = vllmKvBytesPerSeq(layout, ctx, elem) / MIB;
    const kvMiB = Math.round(kvPerSeqMiB * seqs);
    const overheadMiB = vllmActivationMiB(facts.paramsB) + VLLM_NON_TORCH_MIB;
    const pool = (room: number) => fraction * (room - weightsMiB - overheadMiB);
    const judge = (room: number): FitLevel => {
      // Every user's whole context must fit in the pool (the tuner's goal 'multi' asks for that many at once).
      if (pool(room) <= 0 || pool(room) < kvPerSeqMiB * seqs) return 'no';
      return levelFor((weightsMiB + kvMiB + overheadMiB) / room, false) as FitLevel;
    };
    const level = judge(usable);
    if (level === 'no') notes.push(FIT_NOTES.kvTooSmall);
    const est: FitEstimate = {
      level,
      needMiB: weightsMiB + kvMiB + overheadMiB,
      weightsMiB,
      kvMiB,
      overheadMiB,
      availableMiB: usable,
      utilization: (weightsMiB + kvMiB + overheadMiB) / usable,
      contextSize: ctx,
      basis: fromFile ? 'file-size' : 'params-heuristic',
      notes,
      ...nowOf(gpu),
      levelNow: judge(Math.max(1, Math.min(gpu.freeMiB, usable))),
    };
    if (kvPerSeqMiB > 0) est.maxConcurrency = Math.max(0, Math.floor(pool(usable) / kvPerSeqMiB));
    return est;
  }

  // llama.cpp (and external endpoints, judged as if llama.cpp served them).
  const ub = Math.max(1, Math.floor(p.ubatchSize ?? DEFAULT_UBATCH));
  const unified = p.kvUnified ?? false;
  const kvBytes = llamaKvBytes(layout, ctx, ub, seqs, unified, elem);
  const fullCells = Math.ceil(ctx / KV_PAD) * KV_PAD * (unified ? 1 : seqs);
  const computeBytes = llamaComputeBytes(facts, fullCells, ub, p.flashAttention);
  const rawKvMiB = Math.round(kvBytes / MIB);
  const computeMiB = Math.round(computeBytes / MIB);
  const layers = facts.blockCount ?? FALLBACK.layers;
  // The draft / MTP model and the image projector the launch loads too (they stay on the GPU).
  const { draft, mmprojBytes } = input.extras ?? {};
  const draftMiB = draft ? draftMiBOf(draft, { layout, layers }, (l) => llamaKvBytes(l, ctx, ub, seqs, unified, 2)) : undefined;
  const mmprojMiB = mmprojBytes !== undefined ? Math.round(mmprojBytes / MIB) : undefined;
  const extraMiB = (draftMiB ?? 0) + (mmprojMiB ?? 0);
  const rawNeedMiB = weightsMiB + rawKvMiB + CUDA_CONTEXT_MIB + computeMiB + extraMiB;
  const cal = input.calibration;
  // Calibrated: the measured peaks of this GPU scale the KV cache + compute buffer part.
  const kvMiB = cal ? Math.round(cal.scale * rawKvMiB) : rawKvMiB;
  const overheadMiB = cal ? Math.max(0, Math.round(CUDA_CONTEXT_MIB + cal.offsetMiB + cal.scale * computeMiB)) : CUDA_CONTEXT_MIB + computeMiB;
  const needMiB = weightsMiB + kvMiB + overheadMiB + extraMiB;
  const availableMiB = usableMiB(gpu);
  const utilization = needMiB / availableMiB;
  // Partial offload: -ngl N puts N repeating layers (weights + their KV) on the GPU; the output
  // layer stays on the CPU unless every layer fits, but we reserve it to stay conservative.
  const embd = facts.embeddingLength ?? FALLBACK.embd;
  const vocab = facts.vocabSize ?? FALLBACK.vocab;
  const bytesPerWeight = facts.bitsPerWeight ? facts.bitsPerWeight / 8 : bytesPerParam(facts.quant);
  const outputMiB = (vocab * embd * bytesPerWeight) / MIB;
  const perLayerMiB = Math.max(weightsMiB - outputMiB, weightsMiB / 4) / layers + kvMiB / layers;
  const judge = (room: number): { level: FitLevel; maxGpuLayers?: number } => {
    const full = levelFor(needMiB / room, true);
    if (full) return { level: full };
    const maxLayers = Math.min(layers, Math.floor((room - overheadMiB - outputMiB - extraMiB) / perLayerMiB));
    return maxLayers >= 1 ? { level: 'partial', maxGpuLayers: maxLayers } : { level: 'no' };
  };
  const total = judge(availableMiB);
  const now = judge(Math.max(1, Math.min(gpu.freeMiB, availableMiB)));
  if (now.level === 'partial') notes.push(FIT_NOTES.partialOffload);
  return {
    level: total.level,
    needMiB,
    weightsMiB,
    kvMiB,
    overheadMiB,
    availableMiB,
    utilization,
    contextSize: ctx,
    basis: fromFile ? 'file-size' : 'params-heuristic',
    notes,
    ...(cal ? { calibration: { samples: cal.samples, errorPct: cal.errorPct, scope: cal.scope, rawNeedMiB } } : {}),
    ...(draftMiB !== undefined ? { draftMiB } : {}),
    ...(mmprojMiB !== undefined ? { mmprojMiB } : {}),
    ...nowOf(gpu),
    levelNow: now.level,
    ...(now.maxGpuLayers !== undefined ? { maxGpuLayers: now.maxGpuLayers } : {}),
  };
}

/** VRAM a verdict counts on: the card's total minus the fixed reserve for the driver and the desktop. */
export function usableMiB(gpu: Pick<GpuMem, 'totalMiB'>): number {
  return Math.max(1, gpu.totalMiB - VRAM_RESERVE_MIB);
}

/** What the card holds right now: total, free, and what other programs (not LLM Bench's engines) use. */
function nowOf(gpu: GpuMem): Pick<FitEstimate, 'totalMiB' | 'freeNowMiB' | 'busyMiB'> {
  return { totalMiB: gpu.totalMiB, freeNowMiB: gpu.freeMiB, busyMiB: Math.max(0, gpu.totalMiB - gpu.freeMiB - (gpu.ownMiB ?? 0)) };
}

/** VRAM a launch right now gets (what the tuner predicts with): min(free now, total − reserve). */
export function availableNowMiB(est: Pick<FitEstimate, 'availableMiB' | 'freeNowMiB'>): number {
  return est.freeNowMiB === undefined ? est.availableMiB : Math.max(1, Math.min(est.freeNowMiB, est.availableMiB));
}

/** Everything in VRAM: perfect, good or tight (not 'partial', not 'no'). */
export function fitsFully(est: Pick<FitEstimate, 'level'>): boolean {
  return levelRank(est.level) <= levelRank('tight');
}

/** The verdict of a launch right now (`levelNow`, else `level` when the free VRAM is unknown). */
export function levelNowOf(est: Pick<FitEstimate, 'level' | 'levelNow'>): FitLevel {
  return est.levelNow ?? est.level;
}

/** A launch right now has everything in VRAM. */
export function fitsNow(est: Pick<FitEstimate, 'level' | 'levelNow'>): boolean {
  return fitsFully({ level: levelNowOf(est) });
}

/** Contexts of the "largest context that fits" search are multiples of this. */
export const FIX_CONTEXT_STEP = 1024;

/**
 * llama.cpp settings that would make `params` fit entirely in VRAM at a launch right now (`levelNow`;
 * `estimate` = the same estimator with other launch params): a q4_0 KV cache with flash attention at
 * the same context, and the largest context (multiple of 1024) with the same settings. Undefined when
 * the launch already fits, for vLLM and external endpoints, and when neither change helps (the weights
 * alone do not fit).
 */
export function fitFixes(
  engine: EngineKind,
  params: LaunchParams,
  current: Pick<FitEstimate, 'level' | 'levelNow' | 'contextSize'>,
  estimate: (p: LaunchParams) => Pick<FitEstimate, 'level' | 'levelNow'>,
): FitFixes | undefined {
  if (engine === 'external' || family(engine) !== 'llamacpp' || fitsNow(current)) return undefined;
  const out: FitFixes = {};
  // q4_0 only helps a cache larger than it (not a fork's smaller turbo3…).
  if ((llamaKvBits(params.kvCacheType ?? 'f16') ?? 16) > 4.5 && fitsNow(estimate({ ...params, kvCacheType: 'q4_0', flashAttention: 'on' }))) out.kvCacheType = 'q4_0';
  // The launch's whole -c (several slots share it); without one, the context the estimate assumed.
  const ctx = params.contextSize ?? current.contextSize;
  const fits = (c: number) => fitsNow(estimate({ ...params, contextSize: c }));
  let lo = 0;
  let hi = Math.ceil(ctx / FIX_CONTEXT_STEP);
  // Invariant: lo × step fits (or lo = 0), hi × step does not.
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid * FIX_CONTEXT_STEP)) lo = mid;
    else hi = mid;
  }
  if (lo > 0) out.maxContext = lo * FIX_CONTEXT_STEP;
  return out.kvCacheType !== undefined || out.maxContext !== undefined ? out : undefined;
}

export interface QuantChoice {
  groupKey: string;
  quant?: string;
  files: HubFile[];
  sizeBytes: number;
  fit: FitEstimate;
  /** Safetensors and NInfer: the folder in the repo ('' = the root); `files` is then all it downloads. */
  dir?: string;
  /** NInfer: what the artifact's manifest says (container version, parts). */
  manifest?: NinferManifest;
}

/**
 * Every weights option of a repo with its fit, largest (= most bits per weight) first. GGUF
 * files are grouped by split groupKey; safetensors weights form one option. `facts` come from
 * one quant of the same model and apply to all (only the quant label changes).
 */
export function quantChoices(files: HubFile[], facts: ModelFactsEx, gpu: GpuMem, engine: EngineKind, params?: FitParams): QuantChoice[] {
  const groups = new Map<string, HubFile[]>();
  const weights = files.filter((f) => f.kind === 'weights');
  const safetensors = weights.filter((f) => f.path.endsWith('.safetensors'));
  for (const f of weights) {
    const isGguf = f.path.toLowerCase().endsWith('.gguf');
    if (!isGguf && safetensors.length > 0 && !f.path.endsWith('.safetensors')) continue;
    const key = isGguf ? (f.groupKey ?? f.path) : '*weights';
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const out: QuantChoice[] = [];
  for (const [groupKey, groupFiles] of groups) {
    const sizeBytes = groupFiles.reduce((a, f) => a + f.sizeBytes, 0);
    const quant = groupFiles[0]?.quant ?? facts.quant;
    const fit = estimateFit({ facts: { ...facts, quant, bitsPerWeight: undefined }, fileBytes: sizeBytes, gpu, engine, ...(params ? { params } : {}) });
    out.push({ groupKey, files: groupFiles, sizeBytes, fit, ...(quant ? { quant } : {}) });
  }
  disambiguate(out);
  return out.sort((a, b) => b.sizeBytes - a.sizeBytes);
}

/**
 * The same quant label on several GGUF files ("…-Q4LynnStyle-MTP" and "…-Q4LynnStyle-Q8MTP"): what
 * follows the label in the file name tells them apart ("Q4LynnStyle · Q8MTP").
 */
function disambiguate(choices: QuantChoice[]): void {
  const counts = new Map<string, number>();
  for (const c of choices) if (c.quant) counts.set(c.quant, (counts.get(c.quant) ?? 0) + 1);
  for (const c of choices) {
    if (!c.quant || (counts.get(c.quant) as number) < 2 || !(c.files[0] as HubFile).path.toLowerCase().endsWith('.gguf')) continue;
    const name = ((c.files[0] as HubFile).path.split('/').pop() as string).replace(/(-\d{5}-of-\d{5})?\.gguf$/i, '');
    const at = name.toLowerCase().lastIndexOf(c.quant.toLowerCase());
    const tail = at >= 0 ? name.slice(at + c.quant.length).replace(/^[-_.]+/, '') : name;
    if (tail) c.quant = `${c.quant} · ${tail}`;
  }
}

/** The highest-quality choice (choices come largest first) that fits at least "good", else "tight". */
export function pickBest<C extends Pick<QuantChoice, 'fit'>>(choices: readonly C[]): C | undefined {
  return choices.find((c) => levelRank(c.fit.level) <= levelRank('good')) ?? choices.find((c) => c.fit.level === 'tight');
}

/** The highest-quality option that fits at least "good", else at least "tight"; undefined if none. */
export function bestQuant(files: HubFile[], facts: ModelFactsEx, gpu: GpuMem, engine: EngineKind, params?: FitParams): QuantChoice | undefined {
  return pickBest(quantChoices(files, facts, gpu, engine, params));
}
