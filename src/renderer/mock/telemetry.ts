/**
 * Synthetic nvidia-smi telemetry that behaves like a real RTX 5090 run (VRAM steps on load,
 * power plateaus on prefill/decode, temperature lagging behind power). M1 replaces it with
 * `telemetry` SSE events and RunResult.telemetry.
 */
import type { RunPhase } from '../../contract/events';
import type { TelemetrySeries } from '../../contract/results';
import { jitter, round, seeded } from './random';

export interface PhaseSpan {
  phase: RunPhase;
  /** Seconds from the start of the run. */
  start: number;
  end: number;
  /** Load cycles inside load phases (VRAM goes up and back down each time). */
  reps?: number;
}

export interface TelemetryProfile {
  baselineMiB: number;
  loadedMiB: number;
  concurrencyMiB: number;
  idleW: number;
  prefillW: number;
  decodeW: number;
  concurrencyW: number;
}

export const RTX5090_QWEN8B: TelemetryProfile = {
  baselineMiB: 3993,
  loadedMiB: 3993 + 7270,
  concurrencyMiB: 3993 + 8460,
  idleW: 38,
  prefillW: 515,
  decodeW: 421,
  concurrencyW: 548,
};

export interface Sample {
  t: number;
  utilPct: number;
  memUsedMiB: number;
  powerW: number;
  tempC: number;
  smClockMHz: number;
}

/** Simulates samples every `stepSec` seconds over the whole schedule. */
export function simulate(schedule: readonly PhaseSpan[], profile: TelemetryProfile, stepSec: number, seed = 7): Sample[] {
  const rand = seeded(seed);
  const end = schedule[schedule.length - 1]!.end;
  const out: Sample[] = [];
  let temp = 36;
  for (let t = 0; t <= end + 1e-9; t += stepSec) {
    const span = schedule.find((s) => t >= s.start && t < s.end) ?? schedule[schedule.length - 1]!;
    const local = (t - span.start) / Math.max(1e-9, span.end - span.start);
    let util = jitter(rand, 3, 2);
    let mem = profile.baselineMiB + jitter(rand, 0, 6);
    let power = jitter(rand, profile.idleW, 4);
    switch (span.phase) {
      case 'cold-load':
      case 'warm-load': {
        const reps = span.reps ?? 1;
        const cycle = (local * reps) % 1;
        const loaded = cycle < 0.72;
        const ramp = Math.min(1, cycle / (span.phase === 'cold-load' ? 0.45 : 0.18));
        mem = loaded ? profile.baselineMiB + (profile.loadedMiB - profile.baselineMiB) * ramp : profile.baselineMiB;
        util = loaded ? jitter(rand, 22, 12) : jitter(rand, 4, 2);
        power = loaded ? jitter(rand, 118, 22) : jitter(rand, 62, 8);
        break;
      }
      case 'prefill':
        mem = profile.loadedMiB + jitter(rand, 40, 30);
        util = jitter(rand, 96, 3);
        power = jitter(rand, profile.prefillW, 26);
        break;
      case 'decode':
        mem = profile.loadedMiB + jitter(rand, 60, 20);
        util = jitter(rand, 94, 2.5);
        power = jitter(rand, profile.decodeW, 9);
        break;
      case 'concurrency':
        mem = profile.concurrencyMiB + jitter(rand, 0, 30);
        util = jitter(rand, 98.5, 1.2);
        power = jitter(rand, profile.concurrencyW, 14);
        break;
      case 'cleanup':
        mem = local < 0.3 ? profile.loadedMiB : profile.baselineMiB;
        power = jitter(rand, 55, 6);
        break;
      default:
        break;
    }
    // Temperature follows power with a ~40 s time constant, like a real cooler.
    const target = 33 + power * 0.064;
    temp += (target - temp) * Math.min(1, stepSec / 40);
    out.push({
      t: round(t, 2),
      utilPct: round(Math.max(0, Math.min(100, util)), 0),
      memUsedMiB: Math.round(mem),
      powerW: round(Math.max(20, power), 0),
      tempC: round(temp, 0),
      smClockMHz: Math.round(power > 300 ? jitter(rand, 2730, 25) : jitter(rand, 1050, 280)),
    });
  }
  return out;
}

export function toSeries(samples: readonly Sample[], schedule: readonly PhaseSpan[], stepSec: number): TelemetrySeries {
  return {
    intervalMs: stepSec * 1000,
    t: samples.map((s) => Math.round(s.t * 1000)),
    utilPct: samples.map((s) => s.utilPct),
    memUsedMiB: samples.map((s) => s.memUsedMiB),
    powerW: samples.map((s) => s.powerW),
    tempC: samples.map((s) => s.tempC),
    smClockMHz: samples.map((s) => s.smClockMHz),
    marks: schedule.map((s) => ({ t: s.start * 1000, label: s.phase })),
  };
}
