/**
 * NInfer: a C++/CUDA inference engine for Qwen3.5-family models (Qwen3.6-27B, Qwen3.8-27B,
 * Qwen3.6-35B-A3B) on ONE RTX 5090 (sm_120a). It runs from its source build tree
 * (build/apps/ninfer-serve <model.ninfer> …) and serves OpenAI Chat Completions (no /v1/completions):
 * LLM Bench measures it with the chat client and text prompts.
 *
 *   ninfer-native  Linux: the ninfer-serve the user built (or LLM Bench's guided build).
 *   ninfer-wsl     Windows: the same, inside a WSL distro (wsl.exe -d <distro> --exec …). The port is
 *                  reached through WSL's localhost forwarding; models are read from the distro's own
 *                  disk (a Windows folder through /mnt/c works, but reads much more slowly).
 *
 *   GET  /api/engines/ninfer/distros          -> NinferDistros (Windows: WSL and its distros)
 *   POST /api/engines/ninfer/check            (EngineConfig) -> EngineStatus ("Indica dove si trova")
 *   POST /api/engines/ninfer/build-plan       (NinferBuildRequest) -> NinferBuildPlan (commands, prerequisites)
 *   POST /api/engines/ninfer/build            (NinferBuildStart) -> { ok: true }; progress as 'engine.install'
 *        events (kind = the NInfer kind, stage clone | configure | build | done | error, step/steps,
 *        result.ninferPath at 'done'). Nothing is installed with apt: missing packages are only listed.
 *
 * Launch settings: LaunchParams.contextSize → --max-context, parallel → --max-concurrency, and
 * LaunchParams.ninfer (contract/engines.ts) for the rest. Where its build is: EngineConfig.ninferPath /
 * wslDistro, else settings.ninfer.
 */
import { z } from 'zod';
import { engineBaseOf, engineStatusSchema, type EngineKind, type LaunchParams, type NinferKvDtype, type NinferParams, type NinferSpec } from './engines';
import type { FitEstimate, FitLevel } from './models';

export const NINFER_KINDS = ['ninfer-native', 'ninfer-wsl'] as const;
export const ninferKindSchema = z.enum(NINFER_KINDS);
export type NinferKind = z.infer<typeof ninferKindSchema>;

export function isNinferKind(kind: EngineKind): kind is NinferKind {
  return kind === 'ninfer-native' || kind === 'ninfer-wsl';
}

/** The NInfer kind of a platform: Linux runs it directly, Windows inside WSL; elsewhere it does not run. */
export function ninferKindFor(platform: string): NinferKind | undefined {
  if (platform === 'linux') return 'ninfer-native';
  return platform === 'win32' ? 'ninfer-wsl' : undefined;
}

export const NINFER_REPO_URL = 'https://github.com/Neroued/ninfer.git';
/** Where the server binary is inside a checkout (no install target: it runs from the build tree). */
export const NINFER_SERVE_PATH = 'build/apps/ninfer-serve';
/** Official artifacts on Hugging Face (one .ninfer + "<Repo>.artifact-manifest.json" + "<Repo>.SHA256SUMS" each). */
export const NINFER_OFFICIAL_REPOS = [
  'neroued/Qwen3.8-27B-nvfp4-NInfer',
  'neroued/Qwen3.8-27B-NInfer',
  'neroued/Qwen3.6-27B-nvfp4-NInfer',
  'neroued/Qwen3.6-27B-NInfer',
  'neroued/Qwen3.6-35B-A3B-NInfer',
] as const;

// ---- engines and formats -------------------------------------------------------------------------

/** Model formats (ModelIdentity.format). */
export type ModelFormatId = 'gguf' | 'safetensors' | 'ninfer' | 'remote';

/** Which engines read a model format: GGUF llama.cpp, safetensors vLLM and SGLang, .ninfer NInfer only. */
export const FORMAT_ENGINE_BASES = {
  gguf: ['llamacpp'],
  safetensors: ['vllm', 'sglang'],
  ninfer: ['ninfer'],
} as const satisfies Record<Exclude<ModelFormatId, 'remote'>, readonly string[]>;

/**
 * An engine kind can run a model of this format: the format's engines (FORMAT_ENGINE_BASES); an
 * external endpoint only its own remote model; a command template any local GGUF or safetensors model
 * (never a .ninfer artifact: only NInfer reads those).
 */
export function engineRunsFormat(kind: EngineKind, format: ModelFormatId): boolean {
  if (kind === 'external') return format === 'remote';
  if (kind === 'command') return format === 'gguf' || format === 'safetensors';
  if (format === 'remote') return false;
  return (FORMAT_ENGINE_BASES[format] as readonly string[]).includes(engineBaseOf(kind));
}

// ---- the GPU -------------------------------------------------------------------------------------

/**
 * NInfer's kernels are built for sm_120a only and its models need a 32 GB card: an RTX 5090 (or a
 * workstation Blackwell with compute capability 12.0 and at least as much memory).
 */
export function ninferGpuSupported(gpu: { name?: string | undefined; computeCapability?: string | undefined; memTotalMiB?: number | null | undefined }): boolean {
  if (/rtx\s*5090/i.test(gpu.name ?? '')) return true;
  return gpu.computeCapability === '12.0' && (gpu.memTotalMiB ?? 0) >= 30_000;
}

// ---- models --------------------------------------------------------------------------------------

/** Trained context of the Qwen3.5-family models NInfer runs (Qwen3.6 / 3.8: 262,144 tokens). */
export const NINFER_MODEL_CONTEXT = 262_144;

/** A model's trained context: what its facts say, else NInfer's for a .ninfer artifact (its manifest does not say). */
export function trainedContextOf(identity: { format: string; facts?: { contextLength?: number | undefined } | undefined }): number | undefined {
  return identity.facts?.contextLength ?? (identity.format === 'ninfer' ? NINFER_MODEL_CONTEXT : undefined);
}

/** The model families NInfer runs, by the artifact's metadata name ("qwen3.8-27b"). */
export type NinferFamily = 'dense-27b' | 'moe-35b-a3b';

/** "qwen3.6-35b-a3b" (or a file / repo name saying 35B-A3B) → MoE; anything else is the 27B dense layout. */
export function ninferFamilyOf(name: string | undefined): NinferFamily {
  return /35b[-_.]?a3b/i.test(name ?? '') ? 'moe-35b-a3b' : 'dense-27b';
}

/**
 * KV elements per token of a family: full-attention layers × KV heads × head size × 2 (K and V). Qwen3.5
 * is hybrid: only every fourth layer keeps a KV cache (27B: 16 layers × 4 heads × 256; 35B-A3B: 10 × 2 × 256);
 * the MTP head adds one more attention layer.
 */
const KV_ELEMENTS: Record<NinferFamily, { text: number; mtp: number }> = {
  'dense-27b': { text: 16 * 4 * 256 * 2, mtp: 4 * 256 * 2 },
  'moe-35b-a3b': { text: 10 * 2 * 256 * 2, mtp: 2 * 256 * 2 },
};

/** Bytes per KV element: int8 and fp8 carry a 16-bit scale per 64 values, nvfp4 an 8-bit one per 16, k8v4 = int8 K + 4-bit V. */
const KV_BYTES: Record<NinferKvDtype, number> = { bf16: 2, int8: 1 + 2 / 64, fp8: 1 + 2 / 64, nvfp4: 0.5 + 1 / 16, k8v4: (1 + 2 / 64 + 0.5 + 1 / 16) / 2 };

/** KV bytes one token takes (checked against NInfer's own "capacity | KV … | runtime" lines: int8 35 KiB on Qwen3.8-27B). */
export function ninferKvBytesPerToken(family: NinferFamily, dtype: NinferKvDtype = 'bf16', spec: NinferSpec = 'off'): number {
  const e = KV_ELEMENTS[family];
  return (e.text + (spec === 'mtp' ? e.mtp : 0)) * KV_BYTES[dtype];
}

const MIB = 1024 * 1024;

/**
 * Parts of an artifact a launch may leave on disk, MiB (27B: measured from NInfer's "weights ready"
 * lines; other families: the same share of the artifact). Vision is an estimate (its weights were never
 * left out in the measured launches).
 */
function componentMiB(family: NinferFamily, artifactMiB: number): { mtp: number; dflash: number; vision: number } {
  if (family === 'dense-27b') return { mtp: 717, dflash: 2140, vision: 800 };
  return { mtp: Math.round(artifactMiB * 0.032), dflash: Math.round(artifactMiB * 0.095), vision: Math.round(artifactMiB * 0.036) };
}

/** Runtime memory besides the KV pool (workspace, state images of 2 lanes + 2 cached, CUDA graphs), MiB. */
export const NINFER_RUNTIME_MIB = 840;
/** The MTP head's own runtime (draft state, proposal workspace), MiB. */
export const NINFER_MTP_RUNTIME_MIB = 716;
/** One StateImage (recurrent state of a lane or a cached checkpoint), MiB. */
export const NINFER_STATE_MIB = 147;
/** CUDA context, kernels and cuBLAS of the process, MiB. */
export const NINFER_CUDA_CONTEXT_MIB = 600;
/** What `--kv-capacity auto` keeps free. */
export const NINFER_AUTO_HEADROOM_MIB = 1024;
/** Tokens per KV page: capacities are whole pages. */
export const NINFER_PAGE_TOKENS = 64;
/** NInfer's defaults when an option is not given. */
export const NINFER_DEFAULTS = { maxContext: 8192, maxConcurrency: 1, kvDtype: 'bf16', defaultMaxTokens: 8192 } as const;

/** VRAM the verdicts never count on (as contract/models.ts VRAM_RESERVE_MIB). */
const RESERVE_MIB = 1024;
/** The same thresholds as the other engines' estimates; NInfer has no partial offload (over → 'no'). */
const LEVELS: readonly [number, FitLevel][] = [
  [0.6, 'perfect'],
  [0.85, 'good'],
  [0.98, 'tight'],
];
const levelOf = (utilization: number): FitLevel => LEVELS.find(([max]) => utilization <= max)?.[1] ?? 'no';

export interface NinferFitInput {
  /** The .ninfer file's size, bytes. */
  artifactBytes: number;
  /** What its manifest says: metadata name ("qwen3.8-27b") and packed components ("text", "vision", "mtp", "dflash2"). */
  manifest?: { name?: string | undefined; components?: readonly string[] | undefined } | undefined;
  /** File or repo name, when there is no manifest name (the family is read from it). */
  label?: string | undefined;
  params?: Pick<LaunchParams, 'contextSize' | 'parallel' | 'ninfer'> | undefined;
  gpu: { totalMiB: number; freeMiB?: number | undefined; ownMiB?: number | undefined };
}

/** What a launch puts on the GPU besides the KV pool, MiB. */
export interface NinferMemory {
  family: NinferFamily;
  weightsMiB: number;
  /** Runtime (workspace, state images, MTP state) + CUDA context. */
  overheadMiB: number;
  bytesPerToken: number;
}

/** Weights and fixed memory of a launch: the artifact minus the parts it leaves on disk, plus the runtime. */
export function ninferMemory(input: Pick<NinferFitInput, 'artifactBytes' | 'manifest' | 'label' | 'params'>): NinferMemory {
  const n: NinferParams = input.params?.ninfer ?? {};
  const family = ninferFamilyOf(input.manifest?.name ?? input.label);
  const artifactMiB = input.artifactBytes / MIB;
  // Without a manifest the artifact is taken as text + vision + MTP (nothing left out that may not be there).
  const components = new Set(input.manifest?.components ?? ['text', 'vision', 'mtp']);
  const parts = componentMiB(family, artifactMiB);
  const spec = n.spec ?? 'off';
  let weights = artifactMiB;
  if (components.has('mtp') && spec !== 'mtp') weights -= parts.mtp;
  if ((components.has('dflash') || components.has('dflash2')) && spec !== 'dflash' && spec !== 'dflash2') weights -= parts.dflash;
  if (components.has('vision') && n.vision !== true) weights -= parts.vision;
  const lanes = input.params?.parallel ?? NINFER_DEFAULTS.maxConcurrency;
  // State images: the active lanes plus the cached ones (--device-state-slots, default = lanes); none cached without prefix reuse.
  const cached = n.prefixReuse === false ? 0 : (n.deviceStateSlots ?? lanes);
  const runtime = NINFER_RUNTIME_MIB + (lanes + cached - 4) * NINFER_STATE_MIB + (spec === 'mtp' ? NINFER_MTP_RUNTIME_MIB : 0);
  return {
    family,
    weightsMiB: Math.round(Math.max(0, weights)),
    overheadMiB: Math.round(Math.max(0, runtime) + NINFER_CUDA_CONTEXT_MIB),
    bytesPerToken: ninferKvBytesPerToken(family, n.kvDtype ?? NINFER_DEFAULTS.kvDtype, spec),
  };
}

/** Whole KV pages of `tokens`. */
const pages = (tokens: number): number => Math.floor(tokens / NINFER_PAGE_TOKENS) * NINFER_PAGE_TOKENS;

/** What `--kv-capacity auto` would give with `freeMiB` free: the memory left after weights and runtime, minus 1 GiB, in whole pages. */
export function ninferAutoKvTokens(mem: NinferMemory, freeMiB: number): number {
  const left = (freeMiB - mem.weightsMiB - mem.overheadMiB - NINFER_AUTO_HEADROOM_MIB) * MIB;
  return left > 0 ? pages(left / mem.bytesPerToken) : 0;
}

/**
 * VRAM verdict of an NInfer launch (FitEstimate, as the other engines'): weights (the artifact minus what
 * the launch leaves on disk) + runtime + CUDA context + the KV pool (--kv-capacity, else --max-context;
 * 'auto' = what is free now). `level` on the card's total minus the reserve, `levelNow` on what is
 * free now. `maxConcurrency` = full-length requests the pool holds at once.
 */
export function ninferFit(input: NinferFitInput): FitEstimate {
  const mem = ninferMemory(input);
  const ctx = input.params?.contextSize ?? NINFER_DEFAULTS.maxContext;
  const totalMiB = input.gpu.totalMiB;
  const availableMiB = Math.max(1, totalMiB - RESERVE_MIB);
  const freeNow = input.gpu.freeMiB === undefined ? undefined : input.gpu.freeMiB + (input.gpu.ownMiB ?? 0);
  const roomNow = freeNow === undefined ? undefined : Math.max(1, Math.min(freeNow, availableMiB));
  const capacity = input.params?.ninfer?.kvCapacity;
  const notes = ['ninfer.estimate'];
  let kvTokens: number;
  if (capacity === 'auto') {
    kvTokens = ninferAutoKvTokens(mem, roomNow ?? availableMiB);
    notes.push('ninfer.auto-capacity');
  } else kvTokens = capacity ?? ctx;
  const kvMiB = Math.round((kvTokens * mem.bytesPerToken) / MIB);
  const needMiB = mem.weightsMiB + mem.overheadMiB + kvMiB;
  const utilization = needMiB / availableMiB;
  // 'auto' sizes the pool to what is left: it loads as long as one full request fits in it.
  const autoLevel = (room: number): FitLevel => (ninferAutoKvTokens(mem, room) >= ctx ? 'tight' : 'no');
  const level = capacity === 'auto' ? autoLevel(availableMiB) : levelOf(utilization);
  const out: FitEstimate = {
    level,
    needMiB,
    weightsMiB: mem.weightsMiB,
    kvMiB,
    overheadMiB: mem.overheadMiB,
    availableMiB,
    utilization,
    contextSize: ctx,
    totalMiB,
    maxConcurrency: kvTokens > 0 ? Math.floor((kvTokens / ctx) * 100) / 100 : 0,
    basis: 'file-size',
    notes,
  };
  if (freeNow !== undefined && roomNow !== undefined) {
    out.freeNowMiB = freeNow;
    out.busyMiB = Math.max(0, totalMiB - freeNow);
    out.levelNow = capacity === 'auto' ? autoLevel(roomNow) : levelOf(needMiB / roomNow);
  }
  return out;
}

/**
 * The largest --kv-capacity that fits on a card with `roomMiB` usable (a multiple of 1024 tokens, at
 * least `min`): the tuner's prediction before it launches anything; 0 when not even `min` fits.
 */
export function ninferMaxKvTokens(mem: NinferMemory, roomMiB: number, min = 1024): number {
  const left = (roomMiB - mem.weightsMiB - mem.overheadMiB) * MIB;
  const tokens = left > 0 ? Math.floor(left / mem.bytesPerToken / 1024) * 1024 : 0;
  return tokens >= min ? tokens : 0;
}

// ---- built-in settings ("preimpostate") -----------------------------------------------------------

export const NINFER_PRESET_IDS = ['ninfer-recommended', 'rtx5090-tested'] as const;
export type NinferPresetId = (typeof NINFER_PRESET_IDS)[number];

export interface NinferPreset {
  id: NinferPresetId;
  /** The launch settings it sets (the rest stays as the user had it). */
  params: Pick<LaunchParams, 'contextSize' | 'parallel'> & { ninfer: NinferParams };
}

/**
 * Built-in settings for an NInfer model, by its family:
 *  - 'ninfer-recommended' ("Consigliata da NInfer"): NInfer's README quick start, 240K per request in a
 *    240K fp8 pool, 2 users, MTP 3 with the optimized head, thinking history kept (35B-A3B: DFlash 7,
 *    as the README says for that model);
 *  - 'rtx5090-tested' ("Provata su RTX 5090"): 64K per request in a shared 128K int8 pool, 2 users,
 *    vision on, MTP 3 with the optimized head (about 27 GB of VRAM with Qwen3.8-27B NVFP4). 27B models only.
 */
export function ninferPresetsFor(model: { name?: string | undefined; label?: string | undefined }): NinferPreset[] {
  const family = ninferFamilyOf(model.name ?? model.label);
  const cache = { deviceStateSlots: 2, hostStateSlots: 8, hostKvMib: 8192 } as const;
  const speculative: Pick<NinferParams, 'spec' | 'draftTokens' | 'lmHeadDraft'> =
    family === 'moe-35b-a3b' ? { spec: 'dflash', draftTokens: 7, lmHeadDraft: true } : { spec: 'mtp', draftTokens: 3, lmHeadDraft: true };
  const out: NinferPreset[] = [
    {
      id: 'ninfer-recommended',
      params: { contextSize: 240_000, parallel: 2, ninfer: { kvCapacity: 240_000, kvDtype: 'fp8', ...cache, ...speculative, preserveThinking: true } },
    },
  ];
  if (family === 'dense-27b') {
    out.push({
      id: 'rtx5090-tested',
      params: { contextSize: 65_536, parallel: 2, ninfer: { kvCapacity: 131_072, kvDtype: 'int8', vision: true, ...cache, spec: 'mtp', draftTokens: 3, lmHeadDraft: true } },
    });
  }
  return out;
}

/** The preset a launch's settings are (same context, users and NInfer settings), if any. */
export function ninferPresetOf(params: Pick<LaunchParams, 'contextSize' | 'parallel' | 'ninfer'>, presets: readonly NinferPreset[]): NinferPresetId | undefined {
  const same = (a: object | undefined, b: object): boolean => JSON.stringify(sortKeys(a ?? {})) === JSON.stringify(sortKeys(b));
  return presets.find((p) => p.params.contextSize === params.contextSize && p.params.parallel === params.parallel && same(params.ninfer, p.params.ninfer))?.id;
}

const sortKeys = (o: object): [string, unknown][] => Object.entries(o).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : 1));

/** Draft tokens when the settings name a speculative backend without a count (NInfer README: MTP 3, DFlash 7). */
export const NINFER_DEFAULT_DRAFT_TOKENS: Record<Exclude<NinferSpec, 'off'>, number> = { mtp: 3, dflash: 7, dflash2: 7 };
/** --max-concurrency range (1..8). */
export const NINFER_MAX_CONCURRENCY = 8;

/**
 * NInfer's own settings as ninfer-serve flags, in launch order (docs/serving.md "Server options"):
 * --kv-capacity, --kv-dtype, --spec/--draft-tokens/--lm-head-draft, --vision, then prefix reuse
 * (--no-prefix-reuse, else the context-cache slots: NInfer refuses them together, so without prefix
 * reuse they are left out) and thinking. Context and concurrency are LaunchParams of their own.
 */
export function ninferFlags(n: NinferParams | undefined): string[] {
  if (!n) return [];
  const out: string[] = [];
  if (n.kvCapacity !== undefined) out.push('--kv-capacity', String(n.kvCapacity));
  if (n.kvDtype !== undefined) out.push('--kv-dtype', n.kvDtype);
  const spec = n.spec ?? 'off';
  if (spec !== 'off') {
    out.push('--spec', spec, '--draft-tokens', String(n.draftTokens ?? NINFER_DEFAULT_DRAFT_TOKENS[spec]));
    if (n.lmHeadDraft === true) out.push('--lm-head-draft');
  }
  if (n.vision === true) out.push('--vision');
  if (n.prefixReuse === false) out.push('--no-prefix-reuse');
  else {
    if (n.deviceStateSlots !== undefined) out.push('--device-state-slots', String(n.deviceStateSlots));
    if (n.hostStateSlots !== undefined) out.push('--host-state-slots', String(n.hostStateSlots));
    if (n.hostKvMib !== undefined) out.push('--host-kv-mib', String(n.hostKvMib));
  }
  if (n.thinking === false) out.push('--no-thinking');
  if (n.preserveThinking === true) out.push('--preserve-thinking');
  return out;
}

/** NInfer settings as their flags, for labels and comparisons ("--kv-capacity 131072 --kv-dtype int8 --spec mtp …"). */
export function ninferParamsText(n: NinferParams | undefined): string {
  return ninferFlags(n).join(' ');
}

// ---- routes --------------------------------------------------------------------------------------

/** One WSL distro (wsl.exe -l -v). */
export const wslDistroSchema = z.object({
  name: z.string(),
  default: z.boolean(),
  /** WSL 1 or 2 (CUDA needs WSL 2). */
  version: z.number().int().optional(),
  running: z.boolean().optional(),
});
export type WslDistro = z.infer<typeof wslDistroSchema>;

/** GET /api/engines/ninfer/distros: is WSL there, and its distros (Windows only: elsewhere wsl false). */
export const ninferDistrosSchema = z.object({ wsl: z.boolean(), distros: z.array(wslDistroSchema) });
export type NinferDistros = z.infer<typeof ninferDistrosSchema>;

/** POST /api/engines/ninfer/check: the same status the Engines page shows, for a path not saved yet. */
export const ninferCheckResponseSchema = engineStatusSchema;

/** What the guided build needs on the system (each with its Ubuntu / Debian packages). */
export const NINFER_PREREQS = ['git', 'cmake', 'ninja', 'compiler', 'pkg-config', 'cuda', 'ffmpeg', 'curl'] as const;
export const ninferPrereqSchema = z.object({
  id: z.enum(NINFER_PREREQS),
  found: z.boolean(),
  /** Version found, when it says. */
  version: z.string().optional(),
  /** Minimum required ("3.28", "7.85", "13.1"), when there is one. */
  need: z.string().optional(),
  /** apt packages that provide it (CUDA: NVIDIA's repository, see NinferBuildPlan.cudaFromNvidia). */
  packages: z.array(z.string()),
});
export type NinferPrereq = z.infer<typeof ninferPrereqSchema>;

export const ninferBuildRequestSchema = z.object({
  kind: ninferKindSchema,
  /** ninfer-wsl: the distro to build in. */
  distro: z.string().min(1).optional(),
  /** Where the checkout goes (a Linux path; default ~/ninfer). An existing checkout is built in place. */
  dir: z.string().min(1).optional(),
});
export type NinferBuildRequest = z.infer<typeof ninferBuildRequestSchema>;

/** POST /api/engines/ninfer/build: the plan the user saw and confirmed. */
export const ninferBuildStartSchema = ninferBuildRequestSchema.extend({ confirm: z.literal(true) });
export type NinferBuildStart = z.infer<typeof ninferBuildStartSchema>;

export const ninferBuildPlanSchema = z.object({
  kind: ninferKindSchema,
  distro: z.string().optional(),
  /** The checkout folder (absolute Linux path) and the server binary the build makes. */
  dir: z.string(),
  servePath: z.string(),
  /** The folder already holds an NInfer checkout: it is built as it is (no clone). */
  existing: z.boolean(),
  /** Exactly what runs, one line per step (clone, configure, build), ready to copy. */
  commands: z.array(z.string()),
  prereqs: z.array(ninferPrereqSchema),
  /** "sudo apt install …" for what is missing: shown to copy, never run by LLM Bench. */
  aptCommand: z.string().optional(),
  /** CUDA is missing or too old: its toolkit (13.1 validated) comes from NVIDIA's repository, not Ubuntu's. */
  cudaFromNvidia: z.boolean(),
  /** Everything needed is there: the build can start. */
  ready: z.boolean(),
});
export type NinferBuildPlan = z.infer<typeof ninferBuildPlanSchema>;

/** Build steps (engine.install stage), in order; an update (contract/engine-updates.ts) pulls, then builds. */
export const NINFER_BUILD_STAGES = ['clone', 'configure', 'git-pull', 'build'] as const;

// ---- updates (the "Aggiorna" of contract/engine-updates.ts, targets 'ninfer-native' / 'ninfer-wsl') ----

/** How to bring an older artifact to the container version a newer NInfer reads (NInfer's docs). */
export const NINFER_UPGRADE_DOC = 'https://github.com/Neroued/ninfer/blob/master/docs/weight-conversion.md#upgrade-an-existing-v2-artifact';

/** A library artifact older than the container version this build reads. */
export const ninferArtifactUpgradeSchema = z.object({
  /** Library id and name of the model. */
  id: z.string(),
  name: z.string(),
  /** The .ninfer file, on this PC. */
  file: z.string(),
  /** Its container version, and the one this build reads. */
  version: z.number().int(),
  needs: z.number().int(),
  /** NInfer's own upgrade tool, ready to copy (run from its checkout), when it has one for this step. */
  command: z.string().optional(),
});
export type NinferArtifactUpgrade = z.infer<typeof ninferArtifactUpgradeSchema>;

/** settings.ninfer: where NInfer's build is, per kind (Engines page). */
export const ninferSettingsSchema = z.object({
  native: z.object({ path: z.string().min(1) }).optional(),
  wsl: z.object({ distro: z.string().min(1), path: z.string().min(1) }).optional(),
});
export type NinferSettings = z.infer<typeof ninferSettingsSchema>;
