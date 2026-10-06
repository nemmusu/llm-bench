/** State of the live screen, folded from the core's server events (pure reducer). */
import type { AppErrorData } from '../../../contract/errors';
import type { RunPhase, ServerEvent } from '../../../contract/events';
import type { GpuSample } from '../../../contract/hardware';

/** Log lines kept on screen (the full excerpt is saved with the result). */
export const MAX_LOG_LINES = 1000;
/** Telemetry samples kept for the live chart (~10 minutes at 4 Hz). */
export const MAX_SAMPLES = 2400;

export interface LiveState {
  phase: RunPhase;
  detail?: string;
  progress: number;
  decodeTps?: number;
  prefillTps?: number;
  ttftMs?: number;
  loadMs?: number;
  log: string[];
  samples: GpuSample[];
  /** Phase changes on the telemetry time axis (ms of the samples). */
  marks: { t: number; phase: RunPhase }[];
  error?: AppErrorData;
  done: boolean;
}

export function initialLive(phase: RunPhase = 'prepare', progress = 0): LiveState {
  return { phase, progress, log: [], samples: [], marks: [], done: false };
}

/** Applies one event of this run (other runs' events and unrelated types are ignored). */
export function liveReducer(s: LiveState, e: ServerEvent, runId: string): LiveState {
  switch (e.type) {
    case 'run.phase': {
      if (e.runId !== runId) return s;
      const lastT = s.samples[s.samples.length - 1]?.t ?? 0;
      const marks = e.phase !== s.phase || s.marks.length === 0 ? [...s.marks, { t: lastT, phase: e.phase }] : s.marks;
      const next: LiveState = { ...s, phase: e.phase, progress: Math.max(s.progress, e.progress), marks };
      if (e.detail === undefined) delete next.detail;
      else next.detail = e.detail;
      return next;
    }
    case 'run.live': {
      if (e.runId !== runId) return s;
      const next = { ...s };
      if (e.decodeTps !== undefined) next.decodeTps = e.decodeTps;
      if (e.prefillTps !== undefined) next.prefillTps = e.prefillTps;
      if (e.ttftMs !== undefined) next.ttftMs = e.ttftMs;
      if (e.loadMs !== undefined) next.loadMs = e.loadMs;
      return next;
    }
    case 'run.log':
      return e.runId === runId ? { ...s, log: [...s.log, ...e.lines].slice(-MAX_LOG_LINES) } : s;
    case 'telemetry': {
      const mine = e.samples.filter((x) => x.gpu === 0);
      return mine.length ? { ...s, samples: [...s.samples, ...mine].slice(-MAX_SAMPLES) } : s;
    }
    case 'run.error':
      return e.runId === runId ? { ...s, error: e.error } : s;
    case 'run.done':
      return e.runId === runId ? { ...s, done: true, progress: 1 } : s;
    default:
      return s;
  }
}
