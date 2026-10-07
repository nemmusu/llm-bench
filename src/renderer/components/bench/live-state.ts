/** State of the live screen, folded from the core's server events (pure reducer). */
import type { ActiveRun } from '../../../contract/api';
import type { AppErrorData } from '../../../contract/errors';
import type { CurrentStep, LivePoint, LiveSpill, RunLaunch, RunPhase, ServerEvent } from '../../../contract/events';
import type { GpuSample } from '../../../contract/hardware';
import type { TuneAttempt, Tuning } from '../../../contract/results';
import { trackLoad, type LoadTrack } from './load-progress';

/** The tune launch in progress (no outcome yet). */
export type TuneCurrent = Omit<TuneAttempt, 'outcome'>;

/** Points with the same key replace each other (the core re-sends the medians after every repetition). */
export function pointKey(p: LivePoint): string {
  if (p.stepKind === 'concurrency') return `concurrency:${p.point.level}`;
  if (p.stepKind === 'sessions') return `sessions:${p.point.sessions}`;
  return `${p.stepKind}:${p.point.promptTokens}:${p.attempt ?? ''}`;
}

/** Adds or replaces a point, keeping the arrival order. */
export function mergePoint(points: readonly LivePoint[], p: LivePoint): LivePoint[] {
  const key = pointKey(p);
  const at = points.findIndex((q) => pointKey(q) === key);
  if (at < 0) return [...points, p];
  const next = [...points];
  next[at] = p;
  return next;
}

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
  /** The engine instance in use (configuration and command). */
  launch?: RunLaunch;
  /** The request in flight. */
  current?: CurrentStep;
  /** Measurements so far, latest per key. */
  points: LivePoint[];
  /** "Trova le impostazioni migliori": the search so far and the launch in progress. */
  tuning?: Tuning;
  tuneCurrent?: TuneCurrent;
  /** The latest engine start, stage by stage. */
  load?: LoadTrack;
  /** The time left the core last said (a tune run), and when it said it (Date.now()). */
  remaining?: { seconds: number; at: number };
  /** The engine spilled to shared system memory (run.spill). */
  spill?: LiveSpill;
}

export function initialLive(phase: RunPhase = 'prepare', progress = 0): LiveState {
  return { phase, progress, log: [], samples: [], marks: [], done: false, points: [] };
}

/**
 * What the core says about the run (screen reopened, or a missed event): fills in what the events
 * have not brought yet, never overwriting fresher event data.
 */
export function seedFromActive(s: LiveState, a: ActiveRun, now = Date.now()): LiveState {
  const patch: Partial<LiveState> = {};
  // Until the first event arrives (screen reopened mid-run), show where the core says the run is.
  if (!s.marks.length) {
    patch.phase = a.phase;
    patch.progress = Math.max(s.progress, a.progress);
  }
  if (!s.remaining && a.remainingSeconds !== undefined) patch.remaining = { seconds: a.remainingSeconds, at: now };
  if (!s.spill && a.spill) patch.spill = a.spill;
  if (!s.launch && a.launch) patch.launch = a.launch;
  if (!s.current && a.current) patch.current = a.current;
  if (!s.tuning && a.tuning) patch.tuning = a.tuning;
  if (!s.load && a.loading) patch.load = trackLoad(undefined, a.loading);
  const known = new Set(s.points.map(pointKey));
  const missing = a.points.filter((p) => !known.has(pointKey(p)));
  // Points the events already brought are fresher: only the ones they have not brought are added.
  if (missing.length) patch.points = [...missing, ...s.points];
  return { ...s, ...patch };
}

/** Applies one event of this run (other runs' events and unrelated types are ignored); `now` stamps the time left the core says. */
export function liveReducer(s: LiveState, e: ServerEvent, runId: string, now = Date.now()): LiveState {
  switch (e.type) {
    case 'run.phase': {
      if (e.runId !== runId) return s;
      const lastT = s.samples[s.samples.length - 1]?.t ?? 0;
      const marks = e.phase !== s.phase || s.marks.length === 0 ? [...s.marks, { t: lastT, phase: e.phase }] : s.marks;
      const next: LiveState = { ...s, phase: e.phase, progress: Math.max(s.progress, e.progress), marks };
      if (e.detail === undefined) delete next.detail;
      else next.detail = e.detail;
      if (e.remainingSeconds !== undefined) next.remaining = { seconds: e.remainingSeconds, at: now };
      return next;
    }
    case 'run.spill':
      return e.runId === runId ? { ...s, spill: e.spill } : s;
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
    case 'run.launch':
      return e.runId === runId ? { ...s, launch: e.launch } : s;
    case 'run.step':
      return e.runId === runId ? { ...s, current: e.current } : s;
    case 'run.point':
      return e.runId === runId ? { ...s, points: mergePoint(s.points, e.live) } : s;
    case 'run.load': {
      if (e.runId !== runId) return s;
      const { type: _t, runId: _r, ...progress } = e;
      return { ...s, load: trackLoad(s.load, progress) };
    }
    case 'run.tune': {
      if (e.runId !== runId) return s;
      const next: LiveState = { ...s, tuning: e.tuning };
      if (e.current) next.tuneCurrent = e.current;
      else delete next.tuneCurrent;
      return next;
    }
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
