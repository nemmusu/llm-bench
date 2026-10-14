import { z } from 'zod';
import { PRECISIONS } from './formats';

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
  /** NInfer artifacts: the parts packed in it, from its manifest ("text", "vision", "mtp", "dflash2"), else what its file name says (noManifest). */
  components: z.array(z.string()).optional(),
  /**
   * The checkpoint reads images itself (config.json has a vision part: Qwen-VL, Gemma 3, LLaVA…). A GGUF
   * keeps its image projector in a separate mmproj file: it says nothing here. Absent = not known.
   */
  vision: z.boolean().optional(),
  /**
   * The model thinks before it answers: its chat template (GGUF tokenizer.chat_template, a checkpoint's
   * tokenizer_config.json or chat_template.jinja) has a reasoning part (<think>, enable_thinking,
   * reasoning_content). Absent = no template read.
   */
  reasoning: z.boolean().optional(),
  /**
   * NInfer artifacts: no manifest next to the file ("senza manifest") and none readable at its start:
   * its facts come from its name and size only (the family, the parameters, an "MTP" in the name), and
   * NInfer itself says the rest.
   */
  noManifest: z.boolean().optional(),
  /**
   * NInfer artifacts: the tensor layouts the manifest at the start of the .ninfer file lists
   * ("contiguous_le_v1", "row_split_k128_v1", "gguf_blocks_v1"…): which build of NInfer can read it
   * (contract/ninfer.ts ninferBuildFor). Absent = that manifest could not be read.
   */
  layouts: z.array(z.string()).optional(),
  /** NInfer artifacts: the container version at the start of the .ninfer file (3 for NInfer's current one). */
  containerVersion: z.number().int().optional(),
});
export type ModelFacts = z.infer<typeof modelFactsSchema>;

/**
 * Identity of a model across downloads and PCs. `sha256` (of the main file) is the strong key;
 * `weakKey` (repo/file/quant/size) works before the hash is known.
 */
export const modelIdentitySchema = z.object({
  displayName: z.string(),
  /** gguf: llama.cpp; safetensors: vLLM / SGLang; ninfer: NInfer (a .ninfer artifact, RTX 5090 only); remote: an endpoint. */
  format: z.enum(['gguf', 'safetensors', 'ninfer', 'remote']),
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
  /**
   * Weight files still missing (a download stopped halfway, a split set with a part left out): the
   * model is listed ("incompleto (1 di 4 file)") but never benchmarked or served until it is whole.
   */
  incomplete: z.object({ have: z.number().int().min(0), total: z.number().int().min(1) }).optional(),
  /** The repo's folder (where the download sidecar is, or <library>/<owner>/<repo>): files of the repo go under it by their path. */
  repoDir: z.string().optional(),
  /**
   * The version an update replaced (sha256 of the main file and weak key before): results measured
   * with it stay as they are, and "Provato" then says they are of the previous version.
   */
  previous: z.object({ sha256: z.string().optional(), weakKey: z.string() }).optional(),
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

/**
 * VRAM the verdicts never count on, on any card: the driver's own reservation (nvidia-smi "Reserved":
 * 420 MiB on an RTX 5090) plus a bare desktop (the Windows compositor, a Linux desktop). It is also
 * where WDDM starts moving memory to shared RAM (core/bench/spill.ts: a card is full within 1 GiB of its
 * total). The engine's own CUDA context is part of the estimate, not of this reserve.
 */
export const VRAM_RESERVE_MIB = 1024;

/** Other programs hold at least this share of the card beyond the reserve: the note speaks up anyway. */
export const BUSY_NOTE_SHARE = 0.15;

/** What the card holds right now (GET /api/models/vram, and the same fields of a FitEstimate). */
export const vramNowSchema = z.object({
  totalMiB: z.number(),
  freeMiB: z.number(),
  /** In use by other programs (not LLM Bench's own engines). */
  busyMiB: z.number().min(0),
  reserveMiB: z.number(),
});
export type VramNow = z.infer<typeof vramNowSchema>;

/**
 * "Ora altri programmi usano 6,2 GB della scheda": shown when what other programs hold right now
 * changes this launch's verdict (`levelNow` worse than `level`), or when it is a notable share of the
 * card beyond the reserve (BUSY_NOTE_SHARE). Undefined when there is nothing worth saying.
 */
export function busyVram(f: { totalMiB?: number | undefined; busyMiB?: number | undefined; freeNowMiB?: number | undefined; level?: FitLevel; levelNow?: FitLevel | undefined }): { busyMiB: number; freeMiB: number } | undefined {
  if (f.totalMiB === undefined || f.busyMiB === undefined || f.freeNowMiB === undefined) return undefined;
  const worse = f.level !== undefined && f.levelNow !== undefined && FIT_LEVELS.indexOf(f.levelNow) > FIT_LEVELS.indexOf(f.level);
  const notable = f.busyMiB - VRAM_RESERVE_MIB >= BUSY_NOTE_SHARE * f.totalMiB;
  return worse || notable ? { busyMiB: f.busyMiB, freeMiB: f.freeNowMiB } : undefined;
}

export const fitEstimateSchema = z.object({
  /**
   * The verdict on the card's TOTAL memory minus VRAM_RESERVE_MIB: a property of model, settings and
   * card, the same whatever else is open. What is free right now is `levelNow`.
   */
  level: fitLevelSchema,
  /** Estimated VRAM needed by this engine/config, in MiB. */
  needMiB: z.number(),
  weightsMiB: z.number(),
  kvMiB: z.number(),
  overheadMiB: z.number(),
  /**
   * VRAM the verdict counts on: total minus VRAM_RESERVE_MIB (llama.cpp), the gpu_memory_utilization
   * share of the total (vLLM).
   */
  availableMiB: z.number(),
  utilization: z.number(),
  contextSize: z.number().int(),
  /** The card's whole memory, MiB. */
  totalMiB: z.number().optional(),
  /** VRAM free right now (total minus what every program holds), MiB; absent when unknown. */
  freeNowMiB: z.number().optional(),
  /** What other programs hold right now (in use minus LLM Bench's own engines), MiB; absent when unknown. */
  busyMiB: z.number().min(0).optional(),
  /**
   * The verdict for a launch right now: llama.cpp against min(free now, total − reserve), vLLM refusing to
   * start when its share of the total is not free. Spill and out-of-memory warnings, the "what would fit"
   * fixes, the tuner and the server's context follow this one. Absent when the free VRAM is unknown.
   */
  levelNow: fitLevelSchema.optional(),
  /**
   * llama.cpp: the speculative-decoding model the launch loads with it (-md: a draft GGUF or an MTP head):
   * its weights and its KV cache at the same context, MiB (part of needMiB): "+ MTP 3,2 GB".
   */
  draftMiB: z.number().optional(),
  /** llama.cpp: the image projector the launch loads with it (--mmproj), MiB (part of needMiB): "+ visione 0,9 GB". */
  mmprojMiB: z.number().optional(),
  /** llama.cpp partial offload: max layers on the GPU at a launch right now, when not everything fits. */
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
  /**
   * llama.cpp, when a launch right now does not fit entirely in VRAM (`levelNow`): settings that would
   * (absent when nothing simple does).
   */
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
  /** vllm also stands for SGLang (same safetensors, same memory rule); ninfer = the .ninfer artifact. */
  engine: z.enum(['llamacpp', 'vllm', 'ninfer']),
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
  /** Formats the repo ships, sub-folders included: GGUF (llama.cpp), safetensors (vLLM / SGLang), NInfer, other. */
  formats: z.array(z.enum(['gguf', 'safetensors', 'ninfer', 'other'])).default([]),
  /** Safetensors precision from the name, tags and the hub's dtype counts (contract/formats.ts). */
  precision: z.enum(PRECISIONS).optional(),
  /** The formats behind 'other' ("MLX", "ONNX", "NInfer"…): listed, not run by LLM Bench. */
  otherFormats: z.array(z.string()).default([]),
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

/**
 * A requested file next to what the PC already holds at the destination:
 *   have   on the PC and the same (size, and sha256 when the hub gives one): never fetched again;
 *   check  on the PC with the same size but no known sha256: hashed first, fetched only if it differs;
 *   update on the PC but another version (size or sha256 changed): fetched, and swapped in once verified;
 *   get    not on the PC.
 */
export const LOCAL_FILE_STATES = ['have', 'check', 'update', 'get'] as const;
export const localFileStateSchema = z.enum(LOCAL_FILE_STATES);
export type LocalFileState = z.infer<typeof localFileStateSchema>;

export const downloadJobSchema = z.object({
  id: z.string(),
  label: z.string(),
  repo: z.string().optional(),
  files: z.array(
    z.object({
      path: z.string(),
      sizeBytes: z.number().optional(),
      sha256: z.string().optional(),
      /** What is already on the PC (DownloadPlan): 'have' files are not fetched and not counted in the bytes. */
      local: localFileStateSchema.optional(),
    }),
  ),
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

/** What a download request would do (POST /api/downloads/plan): where it goes, what it fetches, what it skips. */
export const downloadPlanSchema = z.object({
  repo: z.string(),
  /** The repo's folder the files go under: the one already holding them (or the model asked for), else the library's. */
  dest: z.string(),
  files: z.array(z.object({ path: z.string(), sizeBytes: z.number(), sha256: z.string().optional(), kind: hubFileSchema.shape.kind.optional(), local: localFileStateSchema })),
  /** Bytes it fetches: the files not already on the PC ('check' ones only if they turn out different). */
  bytesToGet: z.number(),
  /** Bytes of the requested files already on the PC ('have' and 'check'). */
  bytesHave: z.number(),
});
export type DownloadPlan = z.infer<typeof downloadPlanSchema>;

/** A downloaded file whose hub copy changed: "il file Q4_K_M è cambiato (17,8 → 17,6 GB)". */
export const changedFileSchema = z.object({
  path: z.string(),
  /** Quant or kind for the sentence ("Q4_K_M", "mmproj"); else the file name. */
  label: z.string(),
  oldBytes: z.number(),
  newBytes: z.number(),
});
export type ChangedFile = z.infer<typeof changedFileSchema>;

/** A part the hub repo has for a local GGUF and the PC does not: "Aggiungi la parte visione (mmproj, 0,9 GB)". */
export const missingExtraSchema = z.object({ kind: z.enum(['mmproj', 'mtp']), path: z.string(), sizeBytes: z.number() });
export type MissingExtra = z.infer<typeof missingExtraSchema>;

/** What the last check of a local model's hub repo found (GET /api/models/updates). */
export const modelUpdateSchema = z.object({
  modelId: z.string(),
  repo: z.string(),
  /** Downloaded files whose hub copy changed (same path, another size or sha256). */
  changed: z.array(changedFileSchema),
  /** Vision projector / MTP head the repo has next to this GGUF and the PC does not. */
  extras: z.array(missingExtraSchema),
  checkedAt: z.string(),
});
export type ModelUpdate = z.infer<typeof modelUpdateSchema>;

export const modelUpdatesSchema = z.object({
  /** When every repo was last checked (on demand or the daily background check). */
  checkedAt: z.string().optional(),
  checking: z.boolean(),
  /** Only models with something to say (an update or a missing extra). */
  models: z.array(modelUpdateSchema),
});
export type ModelUpdates = z.infer<typeof modelUpdatesSchema>;
