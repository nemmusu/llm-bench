import { useState } from 'react';
import type { GpuSample } from '../../../contract/hardware';
import { useGpuSnapshot } from '../../lib/queries-library';

/** 3 minutes of one-second samples. */
export const HISTORY_SECONDS = 180;

/** Appends `next` to `history` unless it is the same reading, keeping only the last `max`. */
export function appendSample(history: readonly GpuSample[], next: GpuSample | undefined, max = HISTORY_SECONDS): GpuSample[] {
  if (!next || history[history.length - 1]?.t === next.t) return history as GpuSample[];
  const out = [...history, next];
  return out.length > max ? out.slice(out.length - max) : out;
}

/**
 * Polls GET /api/telemetry/snapshot every second and keeps a rolling window for the charts.
 * `gpu` is the nvidia-smi index of the card to follow.
 */
export function useGpuHistory(gpu: number): { current?: GpuSample; history: GpuSample[]; unavailable: boolean; error: unknown } {
  const snap = useGpuSnapshot(1000);
  const [history, setHistory] = useState<GpuSample[]>([]);
  const [seen, setSeen] = useState<GpuSample>();
  const next = snap.data?.find((s) => s.gpu === gpu);
  // Derived state, updated during render when a new reading arrives (no effect round-trip).
  if (next !== seen) {
    setSeen(next);
    setHistory((h) => appendSample(h, next));
  }
  return {
    ...(next ? { current: next } : {}),
    history,
    unavailable: snap.data !== undefined && snap.data.length === 0,
    error: snap.error,
  };
}
