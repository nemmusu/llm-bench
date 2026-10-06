import { z } from 'zod';
import { appErrorSchema } from './errors';
import { hardwareFingerprintSchema } from './hardware';
import { engineKindSchema, launchParamsSchema } from './engines';
import { modelIdentitySchema } from './models';

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

export const PROFILES = ['quick', 'standard', 'full', 'custom'] as const;
export const profileSchema = z.enum(PROFILES);
export type Profile = z.infer<typeof profileSchema>;

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
]);
export type Step = z.infer<typeof stepSchema>;

export const scenarioSchema = z.object({
  profile: profileSchema,
  steps: z.array(stepSchema),
  seed: z.number().int().default(42),
});
export type Scenario = z.infer<typeof scenarioSchema>;

export const VALIDITY_FLAGS = [
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
});
export type LatencyPoint = z.infer<typeof latencyPointSchema>;

export const concurrencyPointSchema = z.object({
  level: z.number().int(),
  requests: z.number().int(),
  aggregateTps: z.number(),
  perRequestDecodeTpsP50: z.number(),
  ttftP50Ms: z.number(),
  ttftP95Ms: z.number(),
  errors: z.number().int(),
});
export type ConcurrencyPoint = z.infer<typeof concurrencyPointSchema>;

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
  concurrency: z.array(concurrencyPointSchema).default([]),
  llamaBench: z.array(z.object({ test: z.string(), tps: z.number(), stddev: z.number() })).default([]),
  vram: z.object({
    baselineMiB: z.number().optional(),
    peakMiB: z.number().optional(),
    deltaMiB: z.number().optional(),
    estimateMiB: z.number().optional(),
    /** Peak dedicated VRAM of the engine process itself (Windows GPU counters / nvidia-smi per process). */
    processPeakMiB: z.number().optional(),
    /** How the headline VRAM figure was measured: per process (exact) or total-minus-baseline (approximate). */
    method: z.enum(['process', 'total-delta']).optional(),
  }),
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
  telemetry: telemetrySeriesSchema.optional(),
  logExcerpt: z.string().default(''),
  note: z.string().optional(),
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
  validity: z.array(validityFlagSchema).default([]),
  /** Which file this summary came from (results folder may be shared). */
  file: z.string(),
});
export type RunSummary = z.infer<typeof runSummarySchema>;
