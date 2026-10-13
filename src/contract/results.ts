import { z } from 'zod';
import { appErrorSchema } from './errors';
import { hardwareFingerprintSchema } from './hardware';
import { engineKindSchema, launchParamsSchema } from './engines';
import { customEngineBaseSchema } from './custom-engines';
import { fitFixesSchema, modelIdentitySchema } from './models';
import { appliedRecipeSchema } from './recipes';

export const RESULT_SCHEMA_VERSION = 1;
/** Bump when a metric definition changes; stored with each run so old runs stay comparable. */
export const METRICS_FORMULA_VERSION = 1;

/** Summary statistics over repeated measurements. */
export const statSchema = z.object({
  n: z.number().int(),
  median: z.number(),
  mean: z.number(),
  min: z.number(),
  max: z.number(),
  stddev: z.number(),
  /** Coefficient of variation (stddev/mean), 0..1. */
  cv: z.number(),
  values: z.array(z.number()),
});
export type Stat = z.infer<typeof statSchema>;

/** 'tune' = "Trova le impostazioni migliori": several engine launches, see RunResult.tuning. */
export const PROFILES = ['quick', 'standard', 'full', 'custom', 'tune'] as const;
export const profileSchema = z.enum(PROFILES);
export type Profile = z.infer<typeof profileSchema>;

/**
 * "Contesto per gradi": with the engine loaded once, prompts that fill the context to increasing
 * depths. `depths` empty = the default grid (1K, 4K, 8K, 16K, 32K, … up to the launched context
 * minus output and margin, plus that exact maximum); fitScenario resolves it once the context is known.
 */
export const contextSweepStepSchema = z.object({
  kind: z.literal('context-sweep'),
  depths: z.array(z.number().int().positive()).default([]),
  /** Also 25 / 50 / 75 / 100 % of the launched context. */
  fractions: z.boolean().default(false),
  outputTokens: z.number().int().positive(),
  reps: z.number().int().min(1),
  /** Time budget of the step in seconds: deeper points are skipped once it is spent. */
  maxSeconds: z.number().int().positive().optional(),
});
export type ContextSweepStep = z.infer<typeof contextSweepStepSchema>;

/**
 * The grid depth a measured depth stands for, so sweeps of different contexts line up (core and
 * renderer use the same rule): the deepest prompt of a 32K context (32 624 tokens with 128 to
 * generate) is "32K". A depth within max(256, 1 %) below a multiple of 1024 counts as that multiple;
 * anything else stays as it is. Tuning.depths and fastestByDepth use these nominal depths.
 */
export function nominalDepth(depth: number): number {
  const up = Math.ceil(depth / 1024) * 1024;
  return up - depth <= Math.max(256, up * 0.01) ? up : depth;
}

// ---- "Conversazioni lunghe" (step 'sessions') and "Contesto tenuto in memoria" ------------------

/**
 * N conversations at once, each with its own long context (no shared prefix between them). Message 1
 * sends `depth` tokens; every later message re-sends the conversation so far (previous prompt +
 * previous answer) plus `followupTokens` of new text, with the engine's prefix cache ON: what the
 * server already read should not be read again. Levels run in ascending order.
 */
export const sessionsStepSchema = z.object({
  kind: z.literal('sessions'),
  /**
   * First-message prompt per conversation, tokens; 0 = as large as the launched per-conversation
   * context allows (the whole conversation must fit: depth + every answer and follow-up).
   * A depth > 0 sizes the launch context like a latency prompt does; 0 never grows it.
   */
  depth: z.number().int().min(0).default(0),
  /** With depth 0: at most this many tokens (profile "Completo": 32 768). */
  maxDepth: z.number().int().positive().optional(),
  /** Conversations at once, e.g. [1, 2]. */
  levels: z.array(z.number().int().positive()).min(1),
  /** Messages per conversation, the first included. */
  turns: z.number().int().min(1).default(4),
  /** New text of every later message, tokens. */
  followupTokens: z.number().int().positive().default(256),
  outputTokens: z.number().int().positive().default(256),
  /** Time budget: levels that would not fit in what is left are skipped. */
  maxSeconds: z.number().int().positive().optional(),
});
export type SessionsStep = z.infer<typeof sessionsStepSchema>;

/** One level of "Conversazioni lunghe": N conversations at once. */
export const sessionsPointSchema = z.object({
  /** Conversations at once. */
  sessions: z.number().int().positive(),
  /** First-message prompt per conversation, tokens. */
  depth: z.number().int().positive(),
  turns: z.number().int().positive(),
  outputTokens: z.number().int().positive(),
  followupTokens: z.number().int().positive(),
  /** First message of every conversation: the whole context is read. */
  firstTurn: z.object({
    /** Send → first token. */
    ttftMs: statSchema,
    /**
     * Each request's own reading speed on the tokens it had to read (not cached): engine timings when
     * reported (llama.cpp), else tokens / (TTFT − queue wait when measured by the engine), else tokens / TTFT.
     */
    prefillTps: statSchema,
    /** Time a request waited before its own reading started (see queueEstimated). */
    queueWaitMs: statSchema,
    decodeTps: statSchema,
  }),
  /** Messages 2…turns: the context so far should come from the cache. Absent when turns = 1. */
  laterTurns: z
    .object({
      ttftMs: statSchema,
      /** Share of the prompt the engine took from its cache (0..1); absent = the engine did not say (never guessed). */
      cachedShare: statSchema.optional(),
      decodeTps: statSchema,
    })
    .optional(),
  /** Context tokens read per second by the server as a whole on first messages: total read / union of the reading windows. */
  aggregatePrefillTps: z.number().optional(),
  /**
   * true = queue wait estimated as TTFT − tokens to read / the reading speed of one conversation alone
   * (level 1, else the fastest request); false = TTFT − the engine's own reading time (llama.cpp timings).
   */
  queueEstimated: z.boolean(),
  /** Requests sent and failed at this level. */
  requests: z.number().int().min(0),
  errors: z.number().int().min(0),
  /**
   * The engine's prefix cache over this level, as the engine itself counts it: vLLM /metrics
   * (`vllm:prefix_cache_queries` / `vllm:prefix_cache_hits` counters, read before and after the
   * level: source 'metrics'; old versions only expose the `gpu_prefix_cache_hit_rate` gauge:
   * 'metrics-gauge', no token counts), else the cached prompt tokens every response reported
   * (llama.cpp timings.cache_n, vLLM usage cached_tokens: 'cached-tokens'). Absent = the engine did not say.
   */
  prefixCache: z
    .object({
      /** Prompt tokens looked up in the cache (counters) or sent (cached-tokens). */
      queries: z.number().min(0).optional(),
      /** Of those, tokens found in the cache. */
      hits: z.number().min(0).optional(),
      /** hits / queries, 0..1. */
      hitRate: z.number().min(0).max(1),
      source: z.enum(['metrics', 'metrics-gauge', 'cached-tokens']),
    })
    .optional(),
});
export type SessionsPoint = z.infer<typeof sessionsPointSchema>;

/**
 * "Contesto tenuto in memoria": tokens the KV cache can hold, read from the engine's start log
 * (vLLM "GPU KV cache size: 889,820 tokens"; llama.cpp n_ctx / KV cells).
 */
export const kvCapacitySchema = z.object({
  tokens: z.number().int().positive(),
  /**
   * How many requests of `tokens` tokens fit at once: vLLM "Maximum concurrency for 200,000 tokens per
   * request: 4.45x"; llama.cpp split slots (n_ctx_seq tokens × n_seq_max).
   */
  maxConcurrencyAtTokens: z.object({ tokens: z.number().int().positive(), concurrency: z.number().positive() }).optional(),
});
export type KvCapacity = z.infer<typeof kvCapacitySchema>;

export const stepSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('load'), cache: z.enum(['cold', 'warm']), reps: z.number().int().min(1) }),
  z.object({
    kind: z.literal('latency'),
    promptTokens: z.array(z.number().int().positive()).min(1),
    outputTokens: z.number().int().positive(),
    warmup: z.number().int().min(0),
    reps: z.number().int().min(1),
  }),
  z.object({
    kind: z.literal('concurrency'),
    levels: z.array(z.number().int().positive()).min(1),
    promptTokens: z.number().int().positive(),
    outputTokens: z.number().int().positive(),
    requestsPerWorker: z.number().int().positive(),
  }),
  z.object({ kind: z.literal('llama-bench'), pp: z.number().int(), tg: z.number().int(), reps: z.number().int() }),
  contextSweepStepSchema,
  sessionsStepSchema,
]);
export type Step = z.infer<typeof stepSchema>;

export const scenarioSchema = z.object({
  profile: profileSchema,
  steps: z.array(stepSchema),
  seed: z.number().int().default(42),
});
export type Scenario = z.infer<typeof scenarioSchema>;

/**
 * Flags that qualify a run's numbers, in the order the result page shows them. 'shared_memory_spill'
 * comes first: the model did not fit in VRAM and Windows put part of it in shared system memory
 * (RunResult.metrics.spill says how it was seen), so every number is far below the card's real one.
 */
export const VALIDITY_FLAGS = [
  'shared_memory_spill',
  'gpu_shared',
  'throttling',
  'cold_not_guaranteed',
  'cold_probably_cached',
  'output_not_exact',
  'tokens_approximate',
  'slow_shared_filesystem',
  'energy_unavailable',
  'unstable',
  'vram_approximate',
] as const;
export const validityFlagSchema = z.enum(VALIDITY_FLAGS);
export type ValidityFlag = z.infer<typeof validityFlagSchema>;

/**
 * The run spilled into shared system memory: its numbers are not the card's. Such runs never feed
 * what is expected of the model here (durations, load times, the VRAM calibration, "Provato su questa
 * GPU", the speed a later spill is compared with). Runs saved before the shared memory was measured get
 * the flag when they are read, if they were far slower than the others (Spill.inferred).
 */
export function spilledRun(r: { validity: readonly ValidityFlag[] }): boolean {
  return r.validity.includes('shared_memory_spill');
}

export const loadPhaseSchema = z.object({ name: z.string(), startMs: z.number(), endMs: z.number() });

export const latencyPointSchema = z.object({
  promptTokens: z.number().int(),
  outputTokens: z.number().int(),
  ttftMs: statSchema,
  /** Client-side prefill rate: promptTokens / TTFT. */
  prefillTps: statSchema,
  /** Engine-reported prefill rate (llama.cpp timings), when available. */
  prefillTpsEngine: statSchema.optional(),
  decodeTps: statSchema,
  decodeTpsEngine: statSchema.optional(),
  itlP50Ms: z.number(),
  itlP95Ms: z.number(),
  /** true when ITL is per chunk rather than per token. */
  itlPerChunk: z.boolean(),
  draftAcceptance: z.number().optional(),
  totalMs: statSchema,
  /**
   * Median of the prompt tokens the engine itself reported for these requests (usage), when it did.
   * On chat-only servers prompts are text calibrated to about the target (note 'text_prompts_calibrated'):
   * there this, not promptTokens, is how much was really read (contextTokensOf).
   */
  promptTokensReported: z.number().optional(),
});
export type LatencyPoint = z.infer<typeof latencyPointSchema>;

/** The run note of prompts sent as calibrated text (no tokenizer): their token counts are the engine's own. */
export const CALIBRATED_PROMPTS_NOTE = 'text_prompts_calibrated';

/** The prompts of this run were calibrated text: the tokens really read are the reported ones. */
export function promptsCalibrated(run: { notes?: readonly { code: string }[] | undefined }): boolean {
  return (run.notes ?? []).some((n) => n.code === CALIBRATED_PROMPTS_NOTE);
}

/**
 * How many tokens a point's prompt really had, for every place that says it ("lettura di un prompt da
 * N token"): the engine's count for calibrated text prompts, else the exact length GPU Bench built.
 * Grid depths (nominalDepth) keep using promptTokens, so equal measurements still line up.
 */
export function contextTokensOf(p: Pick<LatencyPoint, 'promptTokens' | 'promptTokensReported'>, calibrated: boolean): number {
  return calibrated && p.promptTokensReported !== undefined ? Math.round(p.promptTokensReported) : p.promptTokens;
}

export const concurrencyPointSchema = z.object({
  level: z.number().int(),
  requests: z.number().int(),
  aggregateTps: z.number(),
  perRequestDecodeTpsP50: z.number(),
  ttftP50Ms: z.number(),
  ttftP95Ms: z.number(),
  errors: z.number().int(),
  /** Prompt and answer length of every request at this level (copied from the step). */
  promptTokens: z.number().int().optional(),
  outputTokens: z.number().int().optional(),
  /**
   * Tokens one user can hold: llama.cpp with split slots = ctx / slots; with a unified KV cache (and
   * vLLM, whose pool is always shared) the whole context, shared by everyone (contextShared = true).
   */
  contextPerUser: z.number().int().optional(),
  contextShared: z.boolean().optional(),
  /** The slowest users' generation speed: 5th percentile of the per-request decode rates. */
  perRequestDecodeTpsP5: z.number().optional(),
  /** Distribution of the per-request decode rates (one value per successful request). */
  perRequestDecodeTps: statSchema.optional(),
  /** Per-user prompt reading speed (engine timings when available, else prompt / TTFT): median and 5th percentile. */
  perRequestPrefillTpsP50: z.number().optional(),
  perRequestPrefillTpsP5: z.number().optional(),
  /**
   * Prompt tokens read per second by the server as a whole: total prompt tokens over the time at
   * least one request was still reading its prompt (union of the send → first-token windows).
   */
  aggregatePrefillTps: z.number().optional(),
});
export type ConcurrencyPoint = z.infer<typeof concurrencyPointSchema>;

/**
 * A spill seen in a run (Windows / WSL: a model that does not fit is not refused, part of it goes to
 * shared system memory and everything gets ~10–15× slower):
 *  - 'shared-memory': the engine's Shared Usage reached max(1024 MiB, reference + 768 MiB), the
 *    reference being what a launch of that context uses without spilling (~1 MiB per 1K tokens);
 *  - 'decode-collapse': generation on a short prompt below 0.4 × what this model and engine generated
 *    on this GPU in earlier runs that did not spill (every layer on the GPU only).
 */
export const spillSchema = z.object({
  by: z.array(z.enum(['shared-memory', 'decode-collapse'])).min(1),
  /** Peak Shared Usage of the engine and the threshold it crossed, MiB. */
  sharedPeakMiB: z.number().optional(),
  thresholdMiB: z.number().optional(),
  /** Generation speed on the shortest prompt of this run, and the usual one (median of earlier runs that did not spill). */
  decodeTps: z.number().optional(),
  normalDecodeTps: z.number().optional(),
  /** The earlier runs the usual speed comes from, newest first. */
  normalRunIds: z.array(z.string()).optional(),
  /** What would fit, from the (calibrated) VRAM estimate made when the run started. */
  fixes: fitFixesSchema.optional(),
  /**
   * "Probabile": not seen during the run but recognized when it is read, never saved in its file. A run
   * saved before the shared memory was measured (no metrics.vram.sharedPeakMiB) whose generation on a
   * short prompt was below 0.4 × the median of the clean runs of the same model and engine kind on this
   * PC and card (by ['decode-collapse']; normalRunIds = those runs). Fixes from the run's own uncalibrated estimate.
   */
  inferred: z.boolean().optional(),
});
export type Spill = z.infer<typeof spillSchema>;

export const metricsSchema = z.object({
  formulaVersion: z.number().int(),
  load: z.object({
    coldMs: statSchema.optional(),
    warmMs: statSchema.optional(),
    /** Container start overhead (Docker only): start → first log line. */
    containerOverheadMs: statSchema.optional(),
    /** Estimated disk read speed during a cold load, bytes/s. */
    coldReadBytesPerSec: z.number().optional(),
    phases: z.array(loadPhaseSchema).default([]),
  }),
  firstTokenAfterLoadMs: z.number().optional(),
  latency: z.array(latencyPointSchema).default([]),
  /** "Contesto per gradi": one point per depth (promptTokens = how full the context was), shallow first. */
  contextSweep: z.array(latencyPointSchema).default([]),
  concurrency: z.array(concurrencyPointSchema).default([]),
  /** "Conversazioni lunghe": one point per level (conversations at once), ascending. */
  sessions: z.array(sessionsPointSchema).default([]),
  /** "Contesto tenuto in memoria", when the engine's log said. */
  kvCapacity: kvCapacitySchema.optional(),
  llamaBench: z.array(z.object({ test: z.string(), tps: z.number(), stddev: z.number() })).default([]),
  vram: z.object({
    baselineMiB: z.number().optional(),
    peakMiB: z.number().optional(),
    deltaMiB: z.number().optional(),
    estimateMiB: z.number().optional(),
    /** Peak dedicated VRAM of the engine process itself (Windows GPU counters / nvidia-smi per process). */
    processPeakMiB: z.number().optional(),
    /**
     * Peak shared GPU memory (system RAM the GPU uses for it) of the engine process: Windows "Shared
     * Usage" counters only (tune runs: the recommended combination's launch). Absent elsewhere and on old runs.
     */
    sharedPeakMiB: z.number().optional(),
    /** How the headline VRAM figure was measured: per process (exact) or total-minus-baseline (approximate). */
    method: z.enum(['process', 'total-delta']).optional(),
  }),
  /** The model did not fit in VRAM and spilled to shared system memory (validity 'shared_memory_spill'): how it was seen. */
  spill: spillSchema.optional(),
  energy: z.object({
    avgPowerW: z.number().optional(),
    maxPowerW: z.number().optional(),
    tokensPerJoule: z.number().optional(),
  }),
  thermals: z.object({ maxTempC: z.number().optional(), throttleReasons: z.array(z.string()).default([]) }),
  score: z.object({ value: z.number(), referenceVersion: z.number().int() }).optional(),
});
export type Metrics = z.infer<typeof metricsSchema>;

/** Exactly how the engine was started: shown in "Come è stato avviato", copyable, re-runnable. */
export const launchRecordSchema = z.object({
  /** argv[0] is the executable (or "docker"). Secrets are already redacted. */
  argv: z.array(z.string()),
  env: z.record(z.string(), z.string()).default({}),
  cwd: z.string().optional(),
  /** Ready-to-paste versions of the command. */
  display: z.object({ powershell: z.string(), bash: z.string() }),
  params: launchParamsSchema,
  host: z.string(),
  port: z.number().int(),
  /** Example request body sent during the test (one of them). */
  requestExample: z.record(z.string(), z.unknown()).optional(),
});
export type LaunchRecord = z.infer<typeof launchRecordSchema>;

export const engineIdentitySchema = z.object({
  kind: engineKindSchema,
  name: z.string(),
  version: z.string().optional(),
  build: z.string().optional(),
  variant: z.string().optional(),
  executable: z.string().optional(),
  image: z.string().optional(),
  imageDigest: z.string().optional(),
  /**
   * The custom engine (settings.customEngines) the run used: `name` is then also the identity's name,
   * so labels, Configurazioni and config keys tell "PrismML fork" from "llama.cpp b11460".
   */
  customEngine: z.object({ id: z.string(), name: z.string(), base: customEngineBaseSchema }).optional(),
});
export type EngineIdentity = z.infer<typeof engineIdentitySchema>;

export const RUN_STATUSES = ['completed', 'failed', 'cancelled'] as const;
export const runStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof runStatusSchema>;

/** Downsampled telemetry stored with the run (columnar to keep files small). */
export const telemetrySeriesSchema = z.object({
  intervalMs: z.number(),
  t: z.array(z.number()),
  utilPct: z.array(z.number().nullable()),
  memUsedMiB: z.array(z.number().nullable()),
  powerW: z.array(z.number().nullable()),
  tempC: z.array(z.number().nullable()),
  smClockMHz: z.array(z.number().nullable()),
  /** Phase markers on the same time axis. */
  marks: z.array(z.object({ t: z.number(), label: z.string() })).default([]),
});
export type TelemetrySeries = z.infer<typeof telemetrySeriesSchema>;

// ---- "Trova le impostazioni migliori" (profile 'tune') ------------------------------------------

/**
 * "Veloce" / "Accurata": how many values each dimension tries (fewer or more combinations). The time
 * limit of a search is its own estimate (Tuning.estimateSeconds: the predicted largest contexts, the
 * expected prompt reading speed, the launches) times a margin. 'recheck' = "Ricontrollo rapido": only
 * the previous run's recommended combination and its runner-up are loaded again (new engine build or
 * image), see Tuning.recheck.
 */
export const TUNE_BUDGETS = ['fast', 'thorough', 'recheck'] as const;
export const tuneBudgetSchema = z.enum(TUNE_BUDGETS);
export type TuneBudget = z.infer<typeof tuneBudgetSchema>;

/**
 * What the search optimizes. 'single' = "Un utente, contesto massimo" (the largest context, then the
 * fastest settings there); 'multi' = "Più utenti" (N users at once, each with its own context: the
 * highest per-user generation speed with all N busy).
 */
export const TUNE_GOALS = ['single', 'multi'] as const;
export const tuneGoalSchema = z.enum(TUNE_GOALS);
export type TuneGoal = z.infer<typeof tuneGoalSchema>;

/** "Più utenti": users at once and context per user when the request leaves them unset. */
export const TUNE_MULTI_DEFAULTS = { users: 4, perUserContext: 8192 } as const;
/** Context-per-user presets offered by the UI (any value from 1024 up is accepted). */
export const TUNE_PER_USER_CONTEXTS = [4096, 8192, 16384, 32768] as const;
/** Most users the "Più utenti" goal accepts. */
export const TUNE_MAX_USERS = 32;

/** One searched setting's value: kv, fa, ub, b (numbers), layout, reuse, gmu, bs, graphs, fp8… */
export const tuneDimValueSchema = z.union([z.string(), z.number(), z.boolean()]);
/**
 * Every searched dimension of a launch, by key. llama.cpp: kv, fa, ub, b, draft, np (users),
 * layout ('split' | 'unified'), reuse (--cache-reuse tokens, 0 = off), ncmoe / ngl (offload).
 * vLLM: kv, bt (--max-num-batched-tokens), np (--max-num-seqs), gmu (--gpu-memory-utilization),
 * bs (--block-size), graphs ('default' | 'small': CUDA graph capture sizes), fp8 ('fp8' |
 * 'fp8_e4m3' | 'fp8_e5m2'), eager.
 */
export const tuneVariantSchema = z.record(z.string(), tuneDimValueSchema);
export type TuneVariant = z.infer<typeof tuneVariantSchema>;

/** KV cache precisions searched: llama.cpp f16 / q8_0 / q4_0 (K = V), vLLM auto / fp8. */
export const TUNE_KV_TYPES = ['f16', 'q8_0', 'q4_0', 'auto', 'fp8'] as const;
export const tuneKvTypeSchema = z.enum(TUNE_KV_TYPES);
export type TuneKvType = z.infer<typeof tuneKvTypeSchema>;

/**
 * How one engine launch went. 'spill' = it loaded but did not fit in VRAM: the Windows driver moved
 * part of it to shared system memory (Shared Usage of the engine process, or a collapse of the
 * generation speed). It counts as "does not fit", like 'oom'.
 */
export const TUNE_OUTCOMES = ['ok', 'oom', 'spill', 'error'] as const;
export const tuneOutcomeSchema = z.enum(TUNE_OUTCOMES);
export type TuneOutcome = z.infer<typeof tuneOutcomeSchema>;

/**
 * Why a launch was made: 'reference' (smallest context, the speed a spill is compared with),
 * 'capacity' (search of the largest context of a KV type), 'variant' (one dimension changed at that
 * context), 'sweep' (the full context sweep of a combination; goal 'multi': users 1..N and the
 * conversations), 'offload' (last resort: part of the model on the CPU), 'fidelity' (optional
 * same-prompt comparison), 'recheck' ("Ricontrollo rapido": a previous combination loaded again at its
 * largest context with a short sweep).
 */
export const TUNE_STAGES = ['reference', 'capacity', 'variant', 'sweep', 'offload', 'fidelity', 'recheck'] as const;
export const tuneStageSchema = z.enum(TUNE_STAGES);
export type TuneStage = z.infer<typeof tuneStageSchema>;

/** Ready-to-paste command of a launch (secrets redacted), as in the run's launch record. */
export const tuneCommandSchema = z.object({ argv: z.array(z.string()), powershell: z.string(), bash: z.string() });
export type TuneCommand = z.infer<typeof tuneCommandSchema>;

/** Labels of combinations that are slower by design. */
export const TUNE_TAGS = ['cpu-offload', 'eager', 'draft'] as const;
export const tuneTagSchema = z.enum(TUNE_TAGS);
export type TuneTag = z.infer<typeof tuneTagSchema>;

/** How a tune launch was seen to spill (TuneAttempt.spill). */
export const TUNE_SPILLS = ['shared-memory', 'decode-collapse', 'too-slow'] as const;

/**
 * Why a search ended before its plan: its time limit, its launch cap, or the run itself ended early
 * (cancelled by the user, or failed with an error that would repeat on every launch).
 */
export const TUNE_STOPS = ['budget', 'launches', 'cancelled', 'failed'] as const;

/** One engine launch of the search, with what it measured. */
export const tuneAttemptSchema = z.object({
  stage: tuneStageSchema,
  /** Exact launch parameters (every searched dimension, contextSize included). */
  params: launchParamsSchema,
  kvType: tuneKvTypeSchema,
  contextSize: z.number().int().positive(),
  outcome: tuneOutcomeSchema,
  /**
   * How the spill was seen: 'shared-memory' (the engine's Shared Usage crossed the rule, even in the
   * middle of a request: the launch is given up at once), 'decode-collapse' (generation far slower than
   * the reference's), 'too-slow' (a request took more than its deadline, or the engine stopped
   * streaming: a launch that slow is reading from shared memory). `error` says which deadline for 'too-slow'.
   */
  spill: z.enum(TUNE_SPILLS).optional(),
  error: appErrorSchema.optional(),
  /** Start → ready, ms. */
  loadMs: z.number().optional(),
  /** Peak VRAM of this launch (engine process when attributable, else total minus baseline), MiB. */
  vramPeakMiB: z.number().optional(),
  /** Peak shared GPU memory (system RAM) of the engine process, Windows only, MiB. */
  sharedPeakMiB: z.number().optional(),
  /** Numbers measured on this launch: the quick probe (1K), the screening depths or the full sweep. */
  points: z.array(latencyPointSchema).default([]),
  /**
   * Requests not made on this launch because they would have ended past the time limit (predicted
   * from the prompt reading speed measured so far): a request that started is never cut.
   */
  skipped: z.array(z.object({ depth: z.number().int().positive(), predictedMs: z.number().min(0) })).optional(),
  command: tuneCommandSchema,
  /** Coordinate descent: this value was kept, or lost against the current best (stage 'variant'). */
  screen: z.enum(['kept', 'lost']).optional(),
  /** The combination (index into `combinations`) this launch measured, if any. */
  combination: z.number().int().min(0).optional(),
  /** ms from the start of the run. */
  atMs: z.number().optional(),
  /** Every searched dimension's value of this launch (see tuneVariantSchema); absent on runs before phase 3. */
  variant: tuneVariantSchema.optional(),
  /** Goal 'multi': users at once measured on this launch (screening: level N only; 'sweep': 1..N in order). */
  concurrency: z.array(concurrencyPointSchema).optional(),
  /** Goal 'multi': the short "Conversazioni lunghe" measured on this launch (N conversations at once). */
  sessions: z.array(sessionsPointSchema).optional(),
  /** vLLM: tokens its KV cache holds, as its log said ("GPU KV cache size"). */
  kvTokens: z.number().int().positive().optional(),
});
export type TuneAttempt = z.infer<typeof tuneAttemptSchema>;

/** A launch configuration that loaded and was measured with the full context sweep. */
export const tuneCombinationSchema = z.object({
  /** Every searched dimension's value (kv, fa, ubatch, batch, offload, draft…) and contextSize = maxContext: ready to launch. */
  params: launchParamsSchema,
  kvType: tuneKvTypeSchema,
  /** Largest context that loaded fully on the GPU without spilling (for this KV type). */
  maxContext: z.number().int().positive(),
  vramPeakMiB: z.number().optional(),
  /** Context sweep at maxContext: one point per depth of the shared grid it can reach (promptTokens = depth). */
  sweep: z.array(latencyPointSchema).default([]),
  command: tuneCommandSchema,
  /** 'ok' = measured; a failure here means the sweep launch itself failed (the attempts say why). */
  outcome: z.enum(['ok', 'oom', 'spill', 'error', 'skipped']),
  tags: z.array(tuneTagSchema).default([]),
  /** Every searched dimension's value (see tuneVariantSchema); absent on runs before phase 3. */
  variant: tuneVariantSchema.optional(),
  /**
   * Goal 'multi': users at once, levels 1..N in this order (promptTokens = perUserContext − output −
   * margin, one request per user per level). `sweep` is empty for these combinations.
   */
  concurrency: z.array(concurrencyPointSchema).optional(),
  /** Goal 'multi': N conversations at once, a few messages each (prefix-cache reuse, queue wait). */
  sessions: z.array(sessionsPointSchema).optional(),
  /** Goal 'multi': the most users (≤ N) whose level had no failed request. */
  usersWithoutErrors: z.number().int().min(0).optional(),
  /**
   * Goal 'multi': llama.cpp 'split' = each user its own part of the context (-np N, ctx = N × context
   * per user); 'unified' = one pool of the same total shared by everyone (--kv-unified). vLLM: always 'unified'.
   */
  kvLayout: z.enum(['split', 'unified']).optional(),
  /** llama.cpp --cache-reuse (tokens): reuses cached chunks that are not a plain prefix. Absent = off. */
  cacheReuse: z.number().int().positive().optional(),
  /**
   * "Misurata in parte": the search stopped (time limit, launch cap, or the run was cancelled / failed)
   * before this configuration got its own full sweep; `sweep` holds what one of its launches did
   * measure (its quick check at the largest context, or its screening depths). Ranked by the same rules as the others.
   */
  partial: z.enum(TUNE_STOPS).optional(),
});
export type TuneCombination = z.infer<typeof tuneCombinationSchema>;

/**
 * "Ricontrollo rapido" (budget 'recheck'): the previous tune of this model here, re-checked with the
 * engine build / image in use now. The recommendation is never changed silently: `recommended` of
 * the recheck run is the previous recommended combination (measured again) when it still fits, and
 * `suggestFull` says when a full search should be run instead.
 */
export const tuneRecheckSchema = z.object({
  previousRunId: z.string(),
  previousCreatedAt: z.string(),
  /** Engine build or image of the previous run ("b10997", "vllm/vllm-openai:v0.12.0@sha256:…"). */
  previousBuild: z.string().optional(),
  /** The one used now. */
  currentBuild: z.string().optional(),
  /** One per re-checked combination: the previous recommendation first, then the runner-up (if any). */
  checks: z.array(
    z.object({
      role: z.enum(['recommended', 'runner-up']),
      /** The combination as the previous run measured it. */
      previous: tuneCombinationSchema,
      /** Index into this run's combinations when it loaded and was measured again. */
      combination: z.number().int().min(0).optional(),
      /** It still loads fully on the GPU at its largest context (no out of memory, no spill). */
      fits: z.boolean(),
      /** How the re-check launch went (absent = not launched: budget spent or an earlier failure). */
      outcome: tuneOutcomeSchema.optional(),
      /**
       * Numbers that moved beyond noise (max(2 %, 2 × CV), as the ranking): `at` = nominal depth
       * (goal 'single') or users at once (goal 'multi'). Empty = everything within noise.
       */
      moved: z
        .array(
          z.object({
            at: z.number().int().positive(),
            metric: z.enum(['decode', 'prefill', 'ttft', 'perUserDecode', 'aggregate', 'ttftP95']),
            before: z.number(),
            after: z.number(),
          }),
        )
        .default([]),
    }),
  ),
  /**
   * 'same' = it loads and every number is within noise; 'changed' = it loads, some number moved;
   * 'no-longer-fits' = the recommended combination ran out of memory or spilled at its context;
   * 'incomplete' = not measured (budget spent or the launch failed for another reason).
   */
  result: z.enum(['same', 'changed', 'no-longer-fits', 'incomplete']),
  /** Run the full search ("Accurata" or "Veloce") now: true unless the result is 'same'. */
  suggestFull: z.boolean(),
});
export type TuneRecheck = z.infer<typeof tuneRecheckSchema>;

export const tuningSchema = z.object({
  budget: tuneBudgetSchema,
  /** What was optimized; absent = 'single' (every run before phase 3). */
  goal: tuneGoalSchema.optional(),
  /** Goal 'multi': what was asked and the shape of the measurements. */
  multi: z
    .object({
      users: z.number().int().min(2),
      perUserContext: z.number().int().positive(),
      /** Prompt of every concurrent request: perUserContext − outputTokens − margin. */
      promptTokens: z.number().int().positive(),
      outputTokens: z.number().int().positive(),
      /** Messages per conversation of the sessions measurement. */
      turns: z.number().int().positive(),
      /**
       * Nothing held N users at perUserContext, not even the most compact KV cache: the most users that
       * did fit (each with the full perUserContext), measured instead of N. Absent = N fit.
       */
      fittingUsers: z.number().int().positive().optional(),
    })
    .optional(),
  /**
   * Values tried first because they won in earlier tune runs on this GPU with this engine kind
   * (ordering only: nothing is skipped). `runs` = how many earlier runs said so.
   */
  learned: z.object({ runs: z.number().int().positive(), first: z.array(z.object({ key: z.string(), value: tuneDimValueSchema })) }).optional(),
  /** Budget 'recheck': what was re-checked and how it went. */
  recheck: tuneRecheckSchema.optional(),
  /** Hard cap on engine launches. */
  maxLaunches: z.number().int().positive(),
  /** Expected length of the whole search when it started, and its time limit (the estimate times a margin), seconds. */
  estimateSeconds: z.number().min(0).optional(),
  limitSeconds: z.number().min(0).optional(),
  /** The search stopped before the end: time budget or launch cap spent, or the run was cancelled or failed. */
  stoppedBy: z.enum(TUNE_STOPS).optional(),
  /** Searched dimensions with the values tried, in search order (kv, fa, ubatch, batch, draft, batchTokens…). */
  dimensions: z.array(z.object({ key: z.string(), values: z.array(z.union([z.string(), z.number(), z.boolean()])) })).default([]),
  /** Per KV type: the estimate before loading anything, and the largest context measured. */
  capacity: z
    .array(
      z.object({
        kvType: tuneKvTypeSchema,
        /** VRAM-estimate prediction (capped at the model's trained context); undefined = cannot fit. */
        predictedMax: z.number().int().optional(),
        /** Largest context that loaded fully on the GPU; undefined = none did (or not tried). */
        measuredMax: z.number().int().optional(),
        /** Known without a launch (a less precise type than one that already reached the model's limit). */
        inferred: z.boolean().default(false),
        /**
         * Why it was not searched: pruned by the estimate, it could not add context, the time ran out
         * before it, or the run was cancelled / failed before it was launched at all.
         */
        skipped: z.enum(['estimate', 'no-gain', 'budget', 'cancelled', 'failed']).optional(),
        /**
         * What is known above measuredMax: 'found' = a larger context was tried and ran out of memory
         * or spilled (failedAt), so measuredMax is the limit; 'model' = it is the model's trained
         * context; 'estimate' = nothing larger was tried, the VRAM estimate says it does not fit;
         * 'budget' = larger contexts were left untried (time limit or launch cap); 'cancelled' / 'failed'
         * = the run ended while this type was being searched (measuredMax, when set, is the largest
         * context that loaded so far; absent = none of the contexts tried so far loaded). Absent on old runs.
         */
        bound: z.enum(['found', 'model', 'estimate', 'budget', 'cancelled', 'failed']).optional(),
        /** The smallest context known not to fit (out of memory or spill), when one was tried (with 'budget': contexts in between were left untried). */
        failedAt: z.number().int().optional(),
      }),
    )
    .default([]),
  /** Sweep depths shared by all combinations (each combination stops at its own maximum). */
  depths: z.array(z.number().int().positive()).default([]),
  attempts: z.array(tuneAttemptSchema).default([]),
  combinations: z.array(tuneCombinationSchema).default([]),
  /**
   * Index into combinations. Goal 'single': among those reaching the largest context, the fastest at
   * its deepest point. Goal 'multi': the highest per-user generation speed (p50) with all N users busy;
   * ties → higher total tok/s → lower TTFT p95 → later messages' TTFT → more precise KV (noise-aware).
   * Budget 'recheck': the previous recommendation measured again, only when it still fits.
   */
  recommended: z.number().int().min(0).optional(),
  /** At each depth, the fastest combination (decode, then prefill, then TTFT, then the more precise KV; noise-aware). Empty for goal 'multi'. */
  fastestByDepth: z.array(z.object({ depth: z.number().int().positive(), combination: z.number().int().min(0) })).default([]),
  /** Optional "fedeltà" check: greedy tokens with the most precise KV that fits vs the recommended one. An indication, not a quality test. */
  fidelity: z
    .object({
      referenceKv: tuneKvTypeSchema,
      comparedKv: tuneKvTypeSchema,
      promptTokens: z.number().int(),
      tokens: z.number().int(),
      identical: z.number().int(),
      firstDivergence: z.number().int().optional(),
    })
    .optional(),
});
export type Tuning = z.infer<typeof tuningSchema>;

export const runResultSchema = z.object({
  schema: z.literal(RESULT_SCHEMA_VERSION),
  id: z.string(),
  app: z.object({ name: z.literal('gpu-bench'), version: z.string() }),
  createdAt: z.string(),
  finishedAt: z.string(),
  status: runStatusSchema,
  error: appErrorSchema.optional(),
  scenario: scenarioSchema,
  hardware: hardwareFingerprintSchema,
  model: modelIdentitySchema,
  engine: engineIdentitySchema,
  launch: launchRecordSchema,
  metrics: metricsSchema,
  validity: z.array(validityFlagSchema).default([]),
  /** Planning notes and skipped steps (codes localized by the renderer, e.g. prompt_too_long). */
  notes: z.array(z.object({ code: z.string(), params: z.record(z.string(), z.unknown()).optional() })).default([]),
  /** Other processes that held GPU memory during the run (behind the gpu_shared flag). */
  sharedGpu: z
    .array(
      z.object({
        pid: z.number(),
        name: z.string(),
        memMiB: z.number().optional(),
        kind: z.enum(['llm', 'vm', 'system', 'app']).optional(),
      }),
    )
    .default([]),
  telemetry: telemetrySeriesSchema.optional(),
  logExcerpt: z.string().default(''),
  note: z.string().optional(),
  /** Profile 'tune' only: the search, every launch and the measured combinations. */
  tuning: tuningSchema.optional(),
  /** "Comandi per questo modello": the recipe the run used (its exact command is `launch`). */
  recipe: appliedRecipeSchema.optional(),
});
export type RunResult = z.infer<typeof runResultSchema>;

/** Lightweight row for lists and "tried on this GPU" badges. */
export const runSummarySchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  status: runStatusSchema,
  profile: profileSchema,
  modelName: z.string(),
  modelWeakKey: z.string(),
  modelSha256: z.string().optional(),
  quant: z.string().optional(),
  engineKind: engineKindSchema,
  engineLabel: z.string(),
  gpuName: z.string(),
  gpuUuid: z.string().optional(),
  hostId: z.string(),
  hostLabel: z.string(),
  decodeTps: z.number().optional(),
  prefillTps: z.number().optional(),
  ttftMs: z.number().optional(),
  coldLoadMs: z.number().optional(),
  warmLoadMs: z.number().optional(),
  vramPeakMiB: z.number().optional(),
  score: z.number().optional(),
  /**
   * Context the engine was started with (llama.cpp --ctx-size, vLLM --max-model-len), when known.
   * Tune runs: the recommended combination's largest context.
   */
  contextSize: z.number().int().optional(),
  /** KV cache precision of the launch (tune runs: of the recommended combination), when set. */
  kvCacheType: z.string().optional(),
  /** Tune runs: how many combinations were measured. */
  tunedCombinations: z.number().int().optional(),
  /** Tune runs: the goal (absent on runs before phase 3 = 'single'), users of goal 'multi', and the budget ('recheck' = "Ricontrollo rapido"). */
  tuneGoal: tuneGoalSchema.optional(),
  tuneUsers: z.number().int().optional(),
  /** Goal 'multi': the context per user asked (Tuning.multi.perUserContext). */
  tunePerUserContext: z.number().int().optional(),
  tuneBudget: tuneBudgetSchema.optional(),
  /**
   * The engine release the run used: llama.cpp build ("b10997"), else the Docker image digest
   * ("sha256:…"), else the version. Tune results are remembered per (GPU, model, engine kind + this).
   */
  engineBuild: z.string().optional(),
  /** Most users served at once in the test (concurrency above 1) and their combined generation speed. */
  parallelUsers: z.number().int().optional(),
  parallelTps: z.number().optional(),
  /** Generation speed each of those users got (median per request). */
  parallelPerUserTps: z.number().optional(),
  /**
   * What the speeds above were measured on, so lists can say it next to them: the tokens in the
   * context of decodeTps / ttftMs (the headline prompt, or depth) and of prefillTps (the longest
   * prompt), whether they are prompt lengths ('prompt': latency step) or context depths ('depth':
   * context sweep, tune runs), and the prompt each parallel user sent.
   */
  decodeTokens: z.number().int().optional(),
  prefillTokens: z.number().int().optional(),
  speedBasis: z.enum(['prompt', 'depth']).optional(),
  parallelPromptTokens: z.number().int().optional(),
  validity: z.array(validityFlagSchema).default([]),
  /** Which file this summary came from (results folder may be shared). */
  file: z.string(),
});
export type RunSummary = z.infer<typeof runSummarySchema>;
