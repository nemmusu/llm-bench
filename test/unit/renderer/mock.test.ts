import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gpuLiveAt, useMockGpuLive } from '../../../src/renderer/mock/gpu-live';
import { jitter, round, seeded } from '../../../src/renderer/mock/random';
import { RTX5090_QWEN8B, simulate, toSeries, type PhaseSpan } from '../../../src/renderer/mock/telemetry';

/** The schedule of the old live-run mock (the benchmark screens now use real runs). */
const LIVE_SCHEDULE: PhaseSpan[] = [
  { phase: 'prepare', start: 0, end: 5 },
  { phase: 'install', start: 5, end: 38 },
  { phase: 'cold-load', start: 38, end: 47, reps: 1 },
  { phase: 'warm-load', start: 47, end: 60, reps: 3 },
  { phase: 'prefill', start: 60, end: 122 },
  { phase: 'decode', start: 122, end: 252 },
  { phase: 'concurrency', start: 252, end: 340 },
  { phase: 'cleanup', start: 340, end: 348 },
]

afterEach(() => {
  vi.useRealTimers();
});

describe('random', () => {
  it('is deterministic', () => {
    const a = seeded(1);
    const b = seeded(1);
    expect(a()).toBe(b());
    const v = jitter(seeded(2), 10, 1);
    expect(v).toBeGreaterThanOrEqual(9);
    expect(v).toBeLessThanOrEqual(11);
    expect(round(1.256, 2)).toBe(1.26);
    expect(round(1.25)).toBe(1.3);
  });
});

describe('telemetry simulation', () => {
  it('raises VRAM on load and power on decode', () => {
    const samples = simulate(LIVE_SCHEDULE, RTX5090_QWEN8B, 1, 3);
    const at = (t: number) => samples.find((s) => s.t === t)!;
    expect(at(2).memUsedMiB).toBeLessThan(4100);
    expect(at(150).memUsedMiB).toBeGreaterThan(11000);
    expect(at(150).powerW).toBeGreaterThan(380);
    expect(at(300).powerW).toBeGreaterThan(500);
    expect(at(347).memUsedMiB).toBeLessThan(4100);
    const series = toSeries(samples, LIVE_SCHEDULE, 1);
    expect(series.t.length).toBe(samples.length);
    expect(series.marks[0]).toEqual({ t: 0, label: 'prepare' });
  });
});

describe('gpu live', () => {
  it('keeps a rolling window', () => {
    const w = gpuLiveAt(1000);
    expect(w.history).toHaveLength(180);
    expect(w.current.t).toBe(1000);
    expect(gpuLiveAt(1001).history[0]!.t).toBe(822);
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useMockGpuLive());
    act(() => vi.advanceTimersByTime(2000));
    expect(result.current.current.t).toBe(1002);
    unmount();
  });
});
