/**
 * VRAM fit estimator.
 *
 * Inspired by llmfit (github.com/AlexsJones/llmfit, MIT licence, © Alex Jones): its
 * bytes-per-parameter table, KV = 2·n_kv_heads·head_dim·ctx·bytes and the 60 / 85 / 98 %
 * utilization levels. GPU Bench is more precise:
 *  - weights are the real file bytes (all shards) when known, minus the input embeddings that
 *    llama.cpp keeps in RAM when the output tensor is separate;
 *  - the KV cache is summed per layer group from the real metadata: per-layer KV heads and head
 *    sizes, sliding-window layers capped at the window, recurrent (SSM) layers with a fixed state;
 *  - overhead = CUDA context + a compute-buffer approximation that grows with ubatch and ctx;
 *  - availability starts from the FREE VRAM, not the total;
 *  - vLLM follows its own rule (gpu_memory_utilization × total must be free; the KV budget must
 *    hold at least one sequence of max_model_len) and reports the concurrency it allows;
 *  - llama.cpp partial offload reports the largest -ngl that fits;
 *  - llama.cpp estimates can be calibrated with the VRAM peaks measured on this GPU (calibration.ts):
 *    the KV cache + compute buffer part is scaled (and, for the very same model, offset) to match.
 */
import type { LaunchParams, EngineKind } from '../../contract/engines';
import type { FitEstimate, FitLevel, HubFile } from '../../contract/models';
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
  slidingWindow: 'kv.sliding-window',
  recurrent: 'kv.recurrent-state',
  contextOverModel: 'context.exceeds-model',
  partialOffload: 'llamacpp.partial-offload',
  budgetOverFree: 'vllm.budget-exceeds-free',
  kvTooSmall: 'vllm.kv-too-small',
  external: 'engine.external',
} as const;

export interface FitParams {
  /** Tokens per sequence (llama.cpp -c per slot, vLLM max_model_len when maxModelLen is unset). */
  contextSize?: number;
  kvCacheType?: 'f16' | 'q8_0' | 'q4_0' | 'fp8' | 'auto';
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

export interface FitInput {
  facts: ModelFactsEx;
  /** Bytes of all weight files (every shard). */
  fileBytes?: number;
  gpu: GpuMem;
  engine: EngineKind;
  params?: FitParams;
  calibration?: FitCalibration;
}

export function fitParamsFrom(p: LaunchParams | undefined): FitParams {
  if (!p) return {};
  const out: FitParams = {};
  if (p.contextSize !== undefined) out.contextSize = p.contextSize;
  if (p.kvCacheType !== undefined) out.kvCacheType = p.kvCacheType;
  if (p.ubatchSize !== undefined) out.ubatchSize = p.ubatchSize;
  if (p.parallel !== undefined) out.parallel = p.parallel;
  // llama.cpp -c is the whole context: with several slots GPU Bench shares one pool (--kv-unified)
  // unless the extra arguments split it (each slot then gets -c / slots).
  if (p.parallel !== undefined && p.parallel > 1) {
    out.kvUnified = !p.extraArgs.some((a) => a === '--no-kv-unified' || a === '-no-kvu');
    if (!out.kvUnified && p.contextSize !== undefined) out.contextSize = Math.max(1, Math.floor(p.contextSize / p.parallel));
  }
  if (p.flashAttention !== undefined) out.flashAttention = p.flashAttention;
  if (p.gpuMemoryUtilization !== undefined) out.gpuMemoryUtilization = p.gpuMemoryUtilization;
  if (p.maxModelLen !== undefined) out.maxModelLen = p.maxModelLen;
  return out;
}

function family(engine: EngineKind): 'llamacpp' | 'vllm' {
  return engine === 'vllm-docker' || engine === 'vllm-native' ? 'vllm' : 'llamacpp';
}

/** KV cache bytes per element. vLLM has no q8_0/q4_0: both map to its fp8 cache (1 byte). */
export function kvElementBytes(fam: 'llamacpp' | 'vllm', type: FitParams['kvCacheType']): number {
  if (type === 'fp8') return 1;
  if (type === 'q8_0') return fam === 'vllm' ? 1 : 34 / 32;
  if (type === 'q4_0') return fam === 'vllm' ? 1 : 18 / 32;
  return 2;
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
  const ctx = Math.max(1, Math.floor((fam === 'vllm' ? (p.maxModelLen ?? p.contextSize) : p.contextSize) ?? defaultCtx));
  if (modelMax !== undefined && ctx > modelMax) notes.push(FIT_NOTES.contextOverModel);
  const { layout, assumed } = kvLayoutOf(facts);
  if (assumed) notes.push(FIT_NOTES.kvAssumed);
  if (layout.groups.some((g) => g.window)) notes.push(FIT_NOTES.slidingWindow);
  if (layout.recurrentLayers > 0) notes.push(FIT_NOTES.recurrent);
  const elem = kvElementBytes(fam, p.kvCacheType);
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
    if (budgetMiB > gpu.freeMiB) {
      level = 'no';
      notes.push(FIT_NOTES.budgetOverFree);
    } else if (kvBudgetMiB < kvPerSeqMiB || kvBudgetMiB <= 0) {
      level = 'no';
      notes.push(FIT_NOTES.kvTooSmall);
    } else {
      level = levelFor(utilization, false) as FitLevel;
    }
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
    };
    if (kvPerSeqMiB > 0) est.maxConcurrency = Math.max(0, Math.floor(kvBudgetMiB / kvPerSeqMiB));
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
  const rawNeedMiB = weightsMiB + rawKvMiB + CUDA_CONTEXT_MIB + computeMiB;
  const cal = input.calibration;
  // Calibrated: the measured peaks of this GPU scale the KV cache + compute buffer part.
  const kvMiB = cal ? Math.round(cal.scale * rawKvMiB) : rawKvMiB;
  const overheadMiB = cal ? Math.max(0, Math.round(CUDA_CONTEXT_MIB + cal.offsetMiB + cal.scale * computeMiB)) : CUDA_CONTEXT_MIB + computeMiB;
  const needMiB = weightsMiB + kvMiB + overheadMiB;
  const availableMiB = Math.max(1, gpu.freeMiB);
  const utilization = needMiB / availableMiB;
  const est: FitEstimate = {
    level: 'no',
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
  };
  const level = levelFor(utilization, true);
  if (level) {
    est.level = level;
    return est;
  }
  // Partial offload: -ngl N puts N repeating layers (weights + their KV) on the GPU; the output
  // layer stays on the CPU unless every layer fits, but we reserve it to stay conservative.
  const layers = facts.blockCount ?? FALLBACK.layers;
  const embd = facts.embeddingLength ?? FALLBACK.embd;
  const vocab = facts.vocabSize ?? FALLBACK.vocab;
  const bytesPerWeight = facts.bitsPerWeight ? facts.bitsPerWeight / 8 : bytesPerParam(facts.quant);
  const outputMiB = (vocab * embd * bytesPerWeight) / MIB;
  const perLayerWeightMiB = Math.max(weightsMiB - outputMiB, weightsMiB / 4) / layers;
  const perLayerMiB = perLayerWeightMiB + kvMiB / layers;
  const room = availableMiB - overheadMiB - outputMiB;
  const maxLayers = Math.min(layers, Math.floor(room / perLayerMiB));
  if (maxLayers >= 1) {
    est.level = 'partial';
    est.maxGpuLayers = maxLayers;
    notes.push(FIT_NOTES.partialOffload);
  }
  return est;
}

export interface QuantChoice {
  groupKey: string;
  quant?: string;
  files: HubFile[];
  sizeBytes: number;
  fit: FitEstimate;
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
  return out.sort((a, b) => b.sizeBytes - a.sizeBytes);
}

/** The highest-quality option that fits at least "good", else at least "tight"; undefined if none. */
export function bestQuant(files: HubFile[], facts: ModelFactsEx, gpu: GpuMem, engine: EngineKind, params?: FitParams): QuantChoice | undefined {
  const choices = quantChoices(files, facts, gpu, engine, params);
  return choices.find((c) => levelRank(c.fit.level) <= levelRank('good')) ?? choices.find((c) => c.fit.level === 'tight');
}
