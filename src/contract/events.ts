import { z } from 'zod';
import { appErrorSchema } from './errors';
import { gpuSampleSchema } from './hardware';
import { downloadJobSchema } from './models';
import { runSummarySchema } from './results';

/** Phases of a benchmark run, in order. Shown as the stepper on the live screen. */
export const RUN_PHASES = [
  'prepare',
  'install',
  'download',
  'cold-load',
  'warm-load',
  'prefill',
  'decode',
  'concurrency',
  'cleanup',
] as const;
export const runPhaseSchema = z.enum(RUN_PHASES);
export type RunPhase = z.infer<typeof runPhaseSchema>;

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
  }),
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
  z.object({ type: z.literal('run.done'), runId: z.string(), summary: runSummarySchema }),
  z.object({ type: z.literal('run.error'), runId: z.string(), error: appErrorSchema }),
  z.object({ type: z.literal('telemetry'), samples: z.array(gpuSampleSchema) }),
  z.object({ type: z.literal('download.update'), job: downloadJobSchema }),
  z.object({ type: z.literal('engine.install'), kind: z.string(), bytesDone: z.number(), bytesTotal: z.number().optional(), stage: z.string() }),
  z.object({ type: z.literal('runs.changed') }),
]);
export type ServerEvent = z.infer<typeof serverEventSchema>;
