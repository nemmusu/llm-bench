/**
 * Mock of a running benchmark. M1 replaces `useMockLiveRun` with a hook fed by the SSE events
 * run.phase / run.live / run.log / telemetry for the given run id.
 */
import { useEffect, useMemo, useState } from 'react';
import { RUN_PHASES, type RunPhase } from '../../contract/events';
import type { Profile } from '../../contract/results';
import type { StepState } from '../components/ui/stepper';
import { MOCK_LOG } from './runs';
import { jitter, round, seeded } from './random';
import { RTX5090_QWEN8B, simulate, type PhaseSpan, type Sample } from './telemetry';

export const LIVE_SCHEDULE: PhaseSpan[] = [
  { phase: 'prepare', start: 0, end: 5 },
  { phase: 'install', start: 5, end: 38 },
  { phase: 'cold-load', start: 38, end: 47, reps: 1 },
  { phase: 'warm-load', start: 47, end: 60, reps: 3 },
  { phase: 'prefill', start: 60, end: 122 },
  { phase: 'decode', start: 122, end: 252 },
  { phase: 'concurrency', start: 252, end: 340 },
  { phase: 'cleanup', start: 340, end: 348 },
];

/** Phases this run does not need (model already on disk). */
export const LIVE_SKIPPED: readonly RunPhase[] = ['download'];

/** Where the mock run is when the screen opens: mid-generation, so every widget has data. */
export const LIVE_START_SEC = 196;
const END = LIVE_SCHEDULE[LIVE_SCHEDULE.length - 1]!.end;
const DECODE_REPS = 10;

export interface LiveValues {
  decodeTps: number;
  prefillTps: number;
  ttftMs: number;
  vramGiB: number;
  tempC: number;
  powerW: number;
  utilPct: number;
}

export interface LiveRunState {
  runId: string;
  modelName: string;
  engineLabel: string;
  profile: Profile;
  phase: RunPhase;
  phaseStates: Record<RunPhase, StepState>;
  /** 0..1 */
  progress: number;
  elapsedSec: number;
  etaSec: number;
  repetition: { n: number; total: number; tokens: number };
  live: LiveValues;
  samples: Sample[];
  schedule: PhaseSpan[];
  log: string[];
  done: boolean;
}

let allSamples: Sample[] | undefined;
function samples(): Sample[] {
  allSamples ??= simulate(LIVE_SCHEDULE, RTX5090_QWEN8B, 1, 3);
  return allSamples;
}

/** Pure snapshot of the mock run at second `sec` (deterministic, easy to test). */
export function liveStateAt(runId: string, sec: number): LiveRunState {
  const t = Math.max(0, Math.min(END, sec));
  const span = LIVE_SCHEDULE.find((s) => t >= s.start && t < s.end) ?? LIVE_SCHEDULE[LIVE_SCHEDULE.length - 1]!;
  const done = t >= END;
  const order = RUN_PHASES.indexOf(span.phase);
  const phaseStates = Object.fromEntries(
    RUN_PHASES.map((p, i) => {
      const state: StepState = LIVE_SKIPPED.includes(p)
        ? 'skipped'
        : done || i < order
          ? 'done'
          : i === order
            ? 'current'
            : 'pending';
      return [p, state];
    }),
  ) as Record<RunPhase, StepState>;

  const upto = samples().filter((s) => s.t <= t);
  const last = upto[upto.length - 1]!;
  const rand = seeded(Math.floor(t) + 101);
  const decodeLocal = Math.max(0, Math.min(1, (t - 122) / 130));
  const rep = span.phase === 'decode' ? Math.min(DECODE_REPS, Math.floor(decodeLocal * DECODE_REPS) + 1) : span.phase === 'prefill' ? Math.min(10, Math.floor(((t - 60) / 62) * 10) + 1) : 1;

  const log = MOCK_LOG.slice(0, Math.min(MOCK_LOG.length, 3 + Math.floor(t / 4)));
  const completedDecodeReps = Math.floor(decodeLocal * DECODE_REPS);
  for (let i = 0; i < completedDecodeReps; i++) {
    const r = seeded(500 + i);
    log.push(
      `slot print_timing: id  0 | task ${140 + i} |`,
      `prompt eval time =      ${round(jitter(r, 57.2, 0.6), 2).toFixed(2)} ms /   512 tokens (    0.11 ms per token,  ${round(jitter(r, 8950, 40), 2).toFixed(2)} tokens per second)`,
      `       eval time =    ${round(jitter(r, 1338, 6), 2).toFixed(2)} ms /   255 tokens (    5.25 ms per token,   ${round(jitter(r, 190.6, 0.7), 2).toFixed(2)} tokens per second)`,
    );
  }

  return {
    runId,
    modelName: 'Qwen3 8B · Q4_K_M',
    engineLabel: 'llama.cpp b11438',
    profile: 'standard',
    phase: span.phase,
    phaseStates,
    progress: t / END,
    elapsedSec: t,
    etaSec: END - t,
    repetition: { n: rep, total: span.phase === 'decode' ? DECODE_REPS : 10, tokens: span.phase === 'prefill' ? (t < 91 ? 512 : 4096) : 512 },
    live: {
      decodeTps: span.phase === 'decode' || span.phase === 'concurrency' || span.phase === 'cleanup' ? round(jitter(rand, 190.4, 1.4), 1) : 0,
      prefillTps: t >= 60 ? round(t < 91 ? jitter(rand, 8960, 60) : jitter(rand, 10420, 70), 0) : 0,
      ttftMs: t >= 60 ? round(jitter(rand, 57, 1.5), 0) : 0,
      vramGiB: round(last.memUsedMiB / 1024, 1),
      tempC: last.tempC,
      powerW: last.powerW,
      utilPct: last.utilPct,
    },
    samples: upto,
    schedule: LIVE_SCHEDULE,
    log,
    done,
  };
}

/** Advances the mock run once per second, starting from {@link LIVE_START_SEC}. */
export function useMockLiveRun(runId: string, startSec = LIVE_START_SEC): LiveRunState {
  const [sec, setSec] = useState(startSec);
  useEffect(() => {
    const id = setInterval(() => setSec((s) => Math.min(END, s + 1)), 1000);
    return () => clearInterval(id);
  }, []);
  return useMemo(() => liveStateAt(runId, sec), [runId, sec]);
}
