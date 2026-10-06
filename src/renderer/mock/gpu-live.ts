/**
 * Mock of the always-on GPU telemetry (sidebar, home GPU card, Monitor). M1 replaces it with the
 * `telemetry` SSE event stream.
 */
import { useEffect, useMemo, useState } from 'react';
import { jitter, round, seeded } from './random';
import type { Sample } from './telemetry';

const HISTORY = 180;
const BASE_MIB = 3993;

function sampleAt(i: number): Sample {
  const rand = seeded(9000 + i);
  // Light desktop load with an occasional burst from the other llama-server.
  const burst = i % 47 > 40;
  const power = burst ? jitter(rand, 236, 30) : jitter(rand, 46, 5);
  return {
    t: i,
    utilPct: round(burst ? jitter(rand, 62, 15) : jitter(rand, 4, 2.5), 0),
    memUsedMiB: Math.round(BASE_MIB + (burst ? 380 : 0) + jitter(rand, 0, 8)),
    powerW: round(power, 0),
    tempC: round(41 + (burst ? 6 : 0) + jitter(rand, 0, 0.6), 0),
    smClockMHz: Math.round(burst ? jitter(rand, 2650, 40) : jitter(rand, 870, 120)),
  };
}

export interface GpuLive {
  current: Sample;
  history: Sample[];
}

/** A rolling window of samples, one per second. */
export function gpuLiveAt(tick: number): GpuLive {
  const history = Array.from({ length: HISTORY }, (_, k) => sampleAt(tick - HISTORY + 1 + k));
  return { current: history[history.length - 1]!, history };
}

export function useMockGpuLive(): GpuLive {
  const [tick, setTick] = useState(1000);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return useMemo(() => gpuLiveAt(tick), [tick]);
}
