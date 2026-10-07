import { z } from 'zod';

/** Facts read from a GGUF header (or HF config.json for safetensors models). */
export const modelFactsSchema = z.object({
  architecture: z.string().optional(),
  name: z.string().optional(),
  paramsB: z.number().optional(),
  quant: z.string().optional(),
  /** Bits per weight, computed as fileBytes*8/params when both are known. */
  bitsPerWeight: z.number().optional(),
  contextLength: z.number().int().optional(),
  blockCount: z.number().int().optional(),
  headCount: z.number().int().optional(),
  headCountKv: z.number().int().optional(),
  keyLength: z.number().int().optional(),
  valueLength: z.number().int().optional(),
  embeddingLength: z.number().int().optional(),
  /** Sliding-window size and how many layers use it (Gemma-style models). */
  slidingWindow: z.number().int().optional(),
  slidingWindowLayers: z.number().int().optional(),
  /** Layers with full attention (hybrid SSM/attention models); defaults to blockCount. */
  fullAttentionLayers: z.number().int().optional(),
  expertCount: z.number().int().optional(),
  expertUsedCount: z.number().int().optional(),
  /** Exact per-layer KV layout (layers differ on Gemma 4, hybrid models…); see core/models/types.ts. */
  kv: z
    .object({
      groups: z.array(
        z.object({
          layers: z.number(),
          kvHeads: z.number(),
          keyLength: z.number(),
          valueLength: z.number(),
          window: z.number().optional(),
        }),
      ),
      recurrentLayers: z.number(),
      recurrentBytesPerSeq: z.number(),
    })
    .optional(),
  vocabSize: z.number().int().optional(),
  feedForwardLength: z.number().int().optional(),
  /** Share of the GGUF file llama.cpp keeps in RAM (input embeddings). */
  cpuOnlyFraction: z.number().optional(),
});
export type ModelFacts = z.infer<typeof modelFactsSchema>;

/**
 * Identity of a model across downloads and PCs. `sha256` (of the main file) is the strong key;
 * `weakKey` (repo/file/quant/size) works before the hash is known.
 */
export const modelIdentitySchema = z.object({
  displayName: z.string(),
  format: z.enum(['gguf', 'safetensors', 'remote']),
  source: z.enum(['local', 'hf', 'external']),
  repo: z.string().optional(),
  revision: z.string().optional(),
  /** Main file name (first shard for split GGUF). */
  file: z.string().optional(),
  files: z.array(z.string()).default([]),
  quant: z.string().optional(),
  sizeBytes: z.number().optional(),
  sha256: z.string().optional(),
  weakKey: z.string(),
  path: z.string().optional(),
  facts: modelFactsSchema.optional(),
});
export type ModelIdentity = z.infer<typeof modelIdentitySchema>;

export const localModelSchema = z.object({
  id: z.string(),
  identity: modelIdentitySchema,
  /** Absolute paths of all files (shards first, then auxiliaries). */
  paths: z.array(z.string()),
  auxiliary: z.array(z.object({ kind: z.enum(['mmproj', 'mtp', 'draft', 'other']), path: z.string() })).default([]),
  dir: z.string(),
  origin: z.enum(['library', 'lmstudio', 'ollama', 'hf-cache', 'custom']),
  modifiedAt: z.string(),
});
export type LocalModel = z.infer<typeof localModelSchema>;

export const FIT_LEVELS = ['perfect', 'good', 'tight', 'partial', 'no'] as const;
export const fitLevelSchema = z.enum(FIT_LEVELS);
export type FitLevel = z.infer<typeof fitLevelSchema>;

/**
 * llama.cpp settings that would make a launch that does not fit entirely in VRAM fit after all
 * (the same estimate, the same free VRAM): what the "Usa cache q4_0" / "Contesto massimo che entra"
 * buttons offer before a run, and "Riprova con…" after a run that spilled.
 */
export const fitFixesSchema = z.object({
  /** A q4_0 KV cache (with flash attention) at the same context fits. */
  kvCacheType: z.literal('q4_0').optional(),
  /** The largest context (a multiple of 1024) that fits with the same settings; absent when not even 1024 does. */
  maxContext: z.number().int().positive().optional(),
});
export type FitFixes = z.infer<typeof fitFixesSchema>;

export const fitEstimateSchema = z.object({
  level: fitLevelSchema,
  /** Estimated VRAM needed by this engine/config, in MiB. */
  needMiB: z.number(),
  weightsMiB: z.number(),
  kvMiB: z.number(),
  overheadMiB: z.number(),
  /** VRAM considered available (free now, or total minus reserve). */
  availableMiB: z.number(),
  utilization: z.number(),
  contextSize: z.number().int(),
  /** llama.cpp partial offload: max layers on GPU when not everything fits. */
  maxGpuLayers: z.number().int().optional(),
  /** vLLM: concurrent sequences of contextSize the KV budget allows. */
  maxConcurrency: z.number().optional(),
  basis: z.enum(['file-size', 'params-heuristic']),
  notes: z.array(z.string()).default([]),
  /**
   * "Stima tarata su N misure": the KV cache + compute buffer part was corrected with VRAM peaks
   * measured on this PC's GPU (normal runs and tune attempts). Absent = not enough measurements (< 2).
   */
  calibration: z
    .object({
      /** Measurements the correction comes from. */
      samples: z.number().int().min(2),
      /** Median error of the corrected estimate on those measurements, % of the measured peak. */
      errorPct: z.number().min(0),
      /** 'model' = measured with this very model; 'architecture' = other models of the same architecture. */
      scope: z.enum(['model', 'architecture']),
      /** needMiB before the correction. */
      rawNeedMiB: z.number(),
    })
    .optional(),
  /** llama.cpp, when it does not fit entirely in VRAM: settings that would (absent when nothing simple does). */
  fixes: fitFixesSchema.optional(),
});
export type FitEstimate = z.infer<typeof fitEstimateSchema>;

export const hubFileSchema = z.object({
  path: z.string(),
  sizeBytes: z.number(),
  sha256: z.string().optional(),
  quant: z.string().optional(),
  /** Grouped split parts share a groupKey; size is per file. */
  groupKey: z.string().optional(),
  kind: z.enum(['weights', 'mmproj', 'mtp', 'draft', 'config', 'tokenizer', 'other']),
});
export type HubFile = z.infer<typeof hubFileSchema>;

/**
 * VRAM verdict of a search result from its parameter count alone (no file reads), at the quant a
 * download would typically pick: Q4_K_M for GGUF repos, the repo's own precision for safetensors.
 */
export const quickFitSchema = z.object({
  level: fitLevelSchema,
  needMiB: z.number(),
  availableMiB: z.number(),
  quant: z.string(),
  engine: z.enum(['llamacpp', 'vllm']),
});
export type QuickFit = z.infer<typeof quickFitSchema>;

export const hubModelSchema = z.object({
  repo: z.string(),
  author: z.string(),
  name: z.string(),
  downloads: z.number().default(0),
  likes: z.number().default(0),
  updatedAt: z.string().optional(),
  gated: z.union([z.boolean(), z.string()]).default(false),
  license: z.string().optional(),
  formats: z.array(z.enum(['gguf', 'safetensors', 'other'])).default([]),
  paramsB: z.number().optional(),
  pipelineTag: z.string().optional(),
  baseModel: z.string().optional(),
  tags: z.array(z.string()).default([]),
  /** Search results only, when the GPU and the parameter count are known. */
  fit: quickFitSchema.optional(),
});
export type HubModel = z.infer<typeof hubModelSchema>;

export const hubSearchPageSchema = z.object({
  models: z.array(hubModelSchema),
  /** Pass back as `cursor` for the next page; absent on the last one. */
  nextCursor: z.string().optional(),
});
export type HubSearchPage = z.infer<typeof hubSearchPageSchema>;

export const downloadStateSchema = z.enum(['queued', 'running', 'paused', 'verifying', 'done', 'failed', 'cancelled']);
export type DownloadState = z.infer<typeof downloadStateSchema>;

export const downloadJobSchema = z.object({
  id: z.string(),
  label: z.string(),
  repo: z.string().optional(),
  files: z.array(z.object({ path: z.string(), sizeBytes: z.number().optional(), sha256: z.string().optional() })),
  dest: z.string(),
  state: downloadStateSchema,
  bytesDone: z.number(),
  bytesTotal: z.number().optional(),
  bytesPerSec: z.number().optional(),
  etaSec: z.number().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  createdAt: z.string(),
});
export type DownloadJob = z.infer<typeof downloadJobSchema>;
