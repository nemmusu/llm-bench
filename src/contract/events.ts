import { z } from 'zod';
import { appErrorSchema } from './errors';
import { gpuSampleSchema } from './hardware';
import { downloadJobSchema } from './models';
import { launchParamsSchema } from './engines';
import { concurrencyPointSchema, latencyPointSchema, runSummarySchema, sessionsPointSchema, spillSchema, tuneAttemptSchema, tuningSchema } from './results';

/** Phases of a benchmark run, in order. Shown as the stepper on the live screen. */
export const RUN_PHASES = [
  'prepare',
  'install',
  'download',
  'cold-load',
  'warm-load',
  'prefill',
  'decode',
  'context-sweep',
  'concurrency',
  // "Conversazioni lunghe": N conversations at once, the context read once and then reused.
  'sessions',
  'llama-bench',
  // "Trova le impostazioni migliori": largest context per KV type, then one setting at a time.
  'tune-capacity',
  'tune-variants',
  'fidelity',
  'cleanup',
] as const;
export const runPhaseSchema = z.enum(RUN_PHASES);
export type RunPhase = z.infer<typeof runPhaseSchema>;

/** The engine instance a run is using right now (every run; changes per load and per tune attempt). */
export const runLaunchSchema = z.object({
  /** Exact launch parameters of this instance (what the core filled in included). */
  params: launchParamsSchema,
  /** Tokens it takes at once: llama.cpp ctx-size, vLLM max-model-len; absent when unknown (external endpoint). */
  contextSize: z.number().int().optional(),
  /** Ready-to-paste command (secrets redacted). */
  command: z.object({ argv: z.array(z.string()), powershell: z.string(), bash: z.string() }),
  /** "llama.cpp b10997 (cuda-13.4)", as RunSummary.engineLabel. */
  engineLabel: z.string(),
});
export type RunLaunch = z.infer<typeof runLaunchSchema>;

/**
 * What is being measured right now. 'first-token' = the 1-token probe right after the first load;
 * 'tune-probe' / 'tune-screen' = the quick checks of a tune attempt (its full sweeps are 'context-sweep').
 */
export const CURRENT_STEP_KINDS = ['load', 'first-token', 'latency', 'context-sweep', 'concurrency', 'sessions', 'llama-bench', 'tune-probe', 'tune-screen', 'fidelity'] as const;
export const currentStepSchema = z.object({
  kind: z.enum(CURRENT_STEP_KINDS),
  /** Prompt length of the request in flight (latency, sweeps: same as depth). */
  promptTokens: z.number().int().optional(),
  /** Context sweeps: how full the context is (tokens). */
  depth: z.number().int().optional(),
  outputTokens: z.number().int().optional(),
  /** 1-based repetition and how many there are (warm-ups are counted separately). */
  rep: z.number().int().optional(),
  reps: z.number().int().optional(),
  warmup: z.boolean().optional(),
  /** Concurrent users of the level being measured (sessions: conversations at once). */
  concurrency: z.number().int().optional(),
  /** Sessions: the message of the conversations being sent (1 = the whole context), out of turns. */
  turn: z.number().int().optional(),
  turns: z.number().int().optional(),
  /** Loads: 'cold' / 'warm'; tune attempts: the stage. */
  label: z.string().optional(),
});
export type CurrentStep = z.infer<typeof currentStepSchema>;

/**
 * A measurement so far, re-sent after every repetition with the medians up to then: the latest point
 * with the same (stepKind, promptTokens / level, attempt) replaces the earlier one.
 */
export const livePointSchema = z.union([
  z.object({
    stepKind: z.enum(['latency', 'context-sweep', 'tune-probe', 'tune-screen']),
    point: latencyPointSchema,
    /** Tune runs: index of the attempt (RunResult.tuning.attempts) this point belongs to. */
    attempt: z.number().int().min(0).optional(),
  }),
  z.object({ stepKind: z.literal('concurrency'), point: concurrencyPointSchema }),
  /** "Conversazioni lunghe": one level (point.sessions conversations at once), re-sent after every message. */
  z.object({ stepKind: z.literal('sessions'), point: sessionsPointSchema }),
]);
export type LivePoint = z.infer<typeof livePointSchema>;

// ---- Engine start progress ("cosa sta facendo il motore mentre si carica") ----------------------

/**
 * What an engine is doing while it starts, read from its log (see core engines/shared/load-progress):
 * - 'starting': launched, nothing recognised in the log yet (native engines);
 * - 'container': Docker container starting, before the first engine line;
 * - 'metadata': llama.cpp reading the GGUF header;
 * - 'weights': loading the weights (vLLM checkpoint shards done/total; llama.cpp progress dots,
 *   "offloaded N/M layers to GPU" as detail);
 * - 'compile': vLLM torch.compile / Dynamo;
 * - 'memory-profile': vLLM measuring the memory left for the KV cache;
 * - 'kv-cache': allocating the KV cache (llama_context / llama_kv_cache, vLLM "GPU KV cache size");
 * - 'cuda-graphs': vLLM capturing CUDA graphs (done/total);
 * - 'warmup': llama.cpp "warming up the model", vLLM "init engine (profile, create kv cache, warmup model) took";
 * - 'api-server': the HTTP server is starting;
 * - 'ready': the engine answers.
 */
export const LOAD_STAGES = [
  'starting',
  'container',
  'metadata',
  'weights',
  'compile',
  'memory-profile',
  'kv-cache',
  'cuda-graphs',
  'warmup',
  'api-server',
  'ready',
] as const;
export const loadStageSchema = z.enum(LOAD_STAGES);
export type LoadStage = z.infer<typeof loadStageSchema>;

/** The latest start progress of an engine (run.load, ActiveRun.loading, ServerInfo.loading). */
export const loadProgressSchema = z.object({
  stage: loadStageSchema,
  /** 0..1 inside the stage, when the log says (vLLM shards and CUDA graphs, llama.cpp progress dots). */
  fraction: z.number().min(0).max(1).optional(),
  /** Units of the stage done and in total (shards, graphs, layers), when the log says. */
  done: z.number().int().min(0).optional(),
  total: z.number().int().min(0).optional(),
  /** Short text from the log line, already trimmed (e.g. "offloaded 49/49 layers to GPU", "took 12.40 s"). */
  detail: z.string().optional(),
  /** ms since this engine instance was started. */
  elapsedMs: z.number().min(0),
  /** Usual start → ready time of this model with this engine on this PC (past runs), when known: "di solito ~45 s". */
  expectedMs: z.number().min(0).optional(),
});
export type LoadProgress = z.infer<typeof loadProgressSchema>;

/** What the live screen says about a spill while the run goes on (RunResult.metrics.spill has the final word). */
export const liveSpillSchema = spillSchema.pick({ by: true, sharedPeakMiB: true, thresholdMiB: true, decodeTps: true, normalDecodeTps: true });
export type LiveSpill = z.infer<typeof liveSpillSchema>;

/** Server-sent events on GET /api/events. Each SSE `event:` name equals `type`. */
export const serverEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), version: z.string() }),
  z.object({
    type: z.literal('run.phase'),
    runId: z.string(),
    phase: runPhaseSchema,
    /** 0..1 progress inside the whole run. */
    progress: z.number(),
    detail: z.string().optional(),
    /**
     * Seconds the core expects are left (profile "tune": recomputed with the speeds measured so far,
     * re-sent every few seconds even during a long request). Absent = the renderer estimates it.
     */
    remainingSeconds: z.number().min(0).optional(),
  }),
  /**
   * The engine of a normal run spilled to shared system memory (Windows): sent once, as soon as it is
   * seen (Shared Usage over the threshold, or generation collapsed on a short prompt).
   */
  z.object({ type: z.literal('run.spill'), runId: z.string(), spill: liveSpillSchema }),
  z.object({
    type: z.literal('run.live'),
    runId: z.string(),
    /** Latest measured values, for the big live gauges. */
    decodeTps: z.number().optional(),
    prefillTps: z.number().optional(),
    ttftMs: z.number().optional(),
    loadMs: z.number().optional(),
    tokens: z.number().optional(),
  }),
  z.object({ type: z.literal('run.log'), runId: z.string(), lines: z.array(z.string()) }),
  /** An engine instance of the run became ready (every load of every run, every tune attempt). */
  z.object({ type: z.literal('run.launch'), runId: z.string(), launch: runLaunchSchema }),
  /** The request in flight changed (prompt length, repetition, users…). */
  z.object({ type: z.literal('run.step'), runId: z.string(), current: currentStepSchema }),
  /** A prompt length / depth / users level got a new measurement (medians so far). */
  z.object({ type: z.literal('run.point'), runId: z.string(), live: livePointSchema }),
  /**
   * Profile "tune": the search so far after every change (an attempt started or ended, a combination
   * measured). `current` = the launch in progress (no outcome yet: shown as "in corso").
   */
  z.object({ type: z.literal('run.tune'), runId: z.string(), tuning: tuningSchema, current: tuneAttemptSchema.omit({ outcome: true }).optional() }),
  /**
   * An engine of the run is starting (every cold/warm load, step instance and tune attempt): what it
   * is doing now, a few times per second at most. The last one of a start has stage 'ready'.
   */
  z.object({ type: z.literal('run.load'), runId: z.string(), ...loadProgressSchema.shape }),
  z.object({ type: z.literal('run.done'), runId: z.string(), summary: runSummarySchema }),
  z.object({ type: z.literal('run.error'), runId: z.string(), error: appErrorSchema }),
  z.object({ type: z.literal('telemetry'), samples: z.array(gpuSampleSchema) }),
  z.object({ type: z.literal('download.update'), job: downloadJobSchema }),
  z.object({
    type: z.literal('engine.install'),
    /** llamacpp-native, a docker image pull, docker-desktop, docker-linux, uv, vllm-native… */
    kind: z.string(),
    bytesDone: z.number(),
    bytesTotal: z.number().optional(),
    stage: z.string(),
    /** Script steps (docker-linux) instead of bytes. */
    step: z.number().optional(),
    steps: z.number().optional(),
    /** Docker image being pulled. */
    image: z.string().optional(),
    /** Docker Desktop state while starting (starting, running…) and whether it is unusually slow. */
    state: z.string().optional(),
    slow: z.boolean().optional(),
    error: appErrorSchema.optional(),
    result: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({ type: z.literal('runs.changed') }),
  /** A server started, became ready, stopped or exited, or a server preset changed: GET /api/servers (and /presets) again. */
  z.object({ type: z.literal('servers.changed') }),
]);
export type ServerEvent = z.infer<typeof serverEventSchema>;
