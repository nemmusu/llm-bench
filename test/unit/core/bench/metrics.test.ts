import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../../../src/contract/errors';
import type { GpuSample } from '../../../../src/contract/hardware';
import {
  aggregateConcurrency,
  aggregateLatency,
  coldReadSpeed,
  downsampleTelemetry,
  energy,
  energyOverWindows,
  fromStream,
  maxTemp,
  othersDriftMiB,
  primaryGpu,
  throttling,
  toLoadPhases,
  vram,
  type RequestMetrics,
} from '../../../../src/core/bench/metrics';
import type { StreamEvent } from '../../../../src/core/inference/types';
import type { GpuProcessMemory, ProcessVramTick } from '../../../../src/core/telemetry/types';

export function sample(t: number, over: Partial<GpuSample> = {}): GpuSample {
  return {
    t,
    gpu: 0,
    utilPct: 90,
    memUsedMiB: 2000,
    memTotalMiB: 32768,
    powerW: 300,
    tempC: 60,
    smClockMHz: 2500,
    memClockMHz: 14000,
    pcieGen: 5,
    pcieWidth: 16,
    throttle: [],
    ...over,
  };
}

const chunk = (t: number, textLen: number, tokens?: number): StreamEvent => ({
  kind: 'chunk',
  t,
  textLen,
  ...(tokens !== undefined ? { tokens } : {}),
});

describe('fromStream', () => {
  it('llama.cpp style: exact N from timings, per-token ITL, engine rates, draft acceptance', () => {
    const events: StreamEvent[] = [
      chunk(1100, 3, 1),
      chunk(1110, 0, 0),
      chunk(1120, 6, 2),
      chunk(1130, 2, 1),
      {
        kind: 'done',
        t: 1135,
        usage: { promptTokens: 513, completionTokens: 4 },
        timings: { promptN: 512, promptMs: 50, predictedN: 4, predictedMs: 32, draftN: 4, draftNAccepted: 2 },
      },
    ];
    const m = fromStream(events, { sentAt: 1000, promptTokens: 512, expectedOutput: 4 });
    expect(m.ttftMs).toBe(100);
    expect(m.totalMs).toBe(135);
    expect(m.outputTokens).toBe(4);
    expect(m.tokensExact).toBe(true);
    expect(m.outputExact).toBe(true);
    expect(m.decodeTokens).toBe(3);
    expect(m.decodeTps).toBeCloseTo(3 / 0.03);
    expect(m.prefillTpsClient).toBeCloseTo(5120);
    expect(m.prefillTpsEngine).toBeCloseTo(10240);
    expect(m.decodeTpsEngine).toBeCloseTo(125);
    expect(m.itlMs).toEqual([10, 10, 10]);
    expect(m.itlPerChunk).toBe(false);
    expect(m.draftAcceptance).toBe(0.5);
    expect(m.promptTokensReported).toBe(513);
    expect(m.firstAt).toBe(1100);
    expect(m.lastAt).toBe(1130);
    expect(m.endAt).toBe(1135);
  });

  it('falls back to timings.predictedN, then to exact chunk counts', () => {
    const a = fromStream([chunk(10, 1, 1), chunk(20, 1, 1), { kind: 'done', t: 25, timings: { predictedN: 2 } }], {
      sentAt: 0,
      promptTokens: 8,
      expectedOutput: 2,
    });
    expect(a.outputTokens).toBe(2);
    expect(a).not.toHaveProperty('prefillTpsEngine');
    const b = fromStream([chunk(10, 1, 2), chunk(20, 1, 3)], { sentAt: 0, promptTokens: 8, expectedOutput: 6 });
    expect(b.outputTokens).toBe(5);
    expect(b.tokensExact).toBe(true);
    expect(b.outputExact).toBe(false);
    expect(b.decodeTokens).toBe(3);
    expect(b.endAt).toBe(20);
  });

  it('without any count: one token per chunk, approximate, per-chunk ITL', () => {
    const m = fromStream([chunk(10, 4), chunk(30, 4), chunk(60, 0), chunk(70, 4, 0)], {
      sentAt: 0,
      promptTokens: 16,
      expectedOutput: 3,
    });
    expect(m.outputTokens).toBe(3);
    expect(m.tokensExact).toBe(false);
    expect(m.itlPerChunk).toBe(true);
    expect(m.itlMs).toEqual([20, 40]);
    expect(m.decodeTps).toBeCloseTo(2 / 0.06);
  });

  it('mixed counts: known chunk counts are used, unknown chunks count as one', () => {
    const m = fromStream([chunk(10, 1, 2), chunk(20, 3)], { sentAt: 0, promptTokens: 1, expectedOutput: 3 });
    expect(m.outputTokens).toBe(3);
    expect(m.tokensExact).toBe(false);
    expect(m.decodeTokens).toBe(1);
  });

  it('draft stats need both counters', () => {
    const m = fromStream([chunk(10, 1, 1), { kind: 'done', t: 11, timings: { draftN: 3 } }], { sentAt: 0, promptTokens: 1, expectedOutput: 1 });
    expect(m.draftAcceptance).toBeUndefined();
  });

  it('leaves rates undefined when they cannot be computed', () => {
    const m = fromStream([chunk(0, 5, 1), { kind: 'done', t: 1, timings: { draftN: 0, promptN: 4 } }], {
      sentAt: 0,
      promptTokens: 0,
      expectedOutput: 1,
    });
    expect(m.decodeTps).toBeUndefined();
    expect(m.prefillTpsClient).toBeUndefined();
    expect(m.prefillTpsEngine).toBeUndefined();
    expect(m.draftAcceptance).toBeUndefined();
    expect(m.itlMs).toEqual([]);
  });

  it('throws ENDPOINT_INVALID when nothing was generated', () => {
    expect(() => fromStream([chunk(1, 0), { kind: 'done', t: 2 }], { sentAt: 0, promptTokens: 1, expectedOutput: 1 })).toThrow(AppError);
  });

  it('property: per-token ITLs sum to the decode window', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.integer({ min: 1, max: 50 }), fc.integer({ min: 1, max: 4 })), { minLength: 2, maxLength: 40 }), (steps) => {
        let t = 100;
        const events: StreamEvent[] = steps.map(([dt, k]) => chunk((t += dt), 1, k));
        const m = fromStream(events, { sentAt: 0, promptTokens: 1, expectedOutput: 0 });
        const sum = m.itlMs.reduce((a, b) => a + b, 0);
        expect(sum).toBeCloseTo(m.lastAt - m.firstAt, 6);
        expect(m.itlMs.length).toBe(m.outputTokens - (steps[0]?.[1] ?? 0));
      }),
    );
  });
});

function rm(over: Partial<RequestMetrics>): RequestMetrics {
  return {
    sentAt: 0,
    firstAt: 100,
    lastAt: 1100,
    endAt: 1110,
    ttftMs: 100,
    totalMs: 1110,
    promptTokens: 512,
    outputTokens: 101,
    tokensExact: true,
    outputExact: true,
    decodeTokens: 100,
    decodeTps: 100,
    prefillTpsClient: 5120,
    itlMs: [10, 10],
    itlPerChunk: false,
    ...over,
  };
}

describe('aggregateLatency', () => {
  it('summarizes repetitions; engine stats only when reported', () => {
    const p = aggregateLatency([rm({ decodeTps: 90, itlMs: [1, 2, 3] }), rm({ decodeTps: 110, itlMs: [4, 5], draftAcceptance: 0.8 })], {
      promptTokens: 512,
      outputTokens: 128,
    });
    expect(p.decodeTps.median).toBe(100);
    expect(p.ttftMs.n).toBe(2);
    expect(p.itlP50Ms).toBe(3);
    expect(p.itlP95Ms).toBeCloseTo(4.8);
    expect(p.draftAcceptance).toBe(0.8);
    expect(p).not.toHaveProperty('prefillTpsEngine');
    expect(p).not.toHaveProperty('decodeTpsEngine');
    const q = aggregateLatency([rm({ prefillTpsEngine: 9000, decodeTpsEngine: 120, itlPerChunk: true })], { promptTokens: 1, outputTokens: 1 });
    expect(q.prefillTpsEngine?.median).toBe(9000);
    expect(q.decodeTpsEngine?.median).toBe(120);
    expect(q.itlPerChunk).toBe(true);
    expect(q).not.toHaveProperty('draftAcceptance');
  });
});

describe('aggregateConcurrency', () => {
  it('aggregate throughput over the makespan, errors counted', () => {
    const c = aggregateConcurrency(4, [rm({ outputTokens: 100, ttftMs: 50 }), rm({ outputTokens: 100, ttftMs: 150, decodeTps: 80 }), null], 2000);
    expect(c).toEqual({
      level: 4,
      requests: 3,
      aggregateTps: 100,
      perRequestDecodeTpsP50: 90,
      ttftP50Ms: 100,
      ttftP95Ms: 145,
      errors: 1,
    });
    expect(aggregateConcurrency(1, [], 0).aggregateTps).toBe(0);
  });
});

describe('energy', () => {
  it('integrates interpolated power over windows, summed over GPUs', () => {
    const samples = [sample(0, { powerW: 100 }), sample(1000, { powerW: 300 }), sample(0, { gpu: 1, powerW: 50 }), sample(1000, { gpu: 1, powerW: 50 })];
    const e = energy(samples, 0, 1000, 400);
    expect(e.available).toBe(true);
    expect(e.joules).toBeCloseTo(200 + 50);
    expect(e.avgPowerW).toBeCloseTo(250);
    expect(e.maxPowerW).toBeCloseTo(350);
    expect(e.tokensPerJoule).toBeCloseTo(1.6);
  });
  it('uses samples inside the window (peak in the middle)', () => {
    const samples = [sample(0, { powerW: 100 }), sample(500, { powerW: 500 }), sample(1000, { powerW: 100 })];
    const e = energy(samples, 0, 1000, 1);
    expect(e.joules).toBeCloseTo(300);
    expect(e.maxPowerW).toBe(500);
  });

  it('windows shorter than the sampling interval and outside the samples still work', () => {
    const samples = [sample(1000, { powerW: 200 }), sample(1250, { powerW: 400 })];
    const inside = energyOverWindows(samples, [[1100, 1150]], 10);
    expect(inside.joules).toBeCloseTo(((280 + 320) / 2) * 0.05);
    const before = energyOverWindows(samples, [[0, 500]], 10);
    expect(before.avgPowerW).toBeCloseTo(200);
    const after = energyOverWindows(samples, [[2000, 3000], [5, 5]], 10);
    expect(after.avgPowerW).toBeCloseTo(400);
  });
  it('reports unavailable without power readings, and nothing without windows', () => {
    expect(energy([sample(0, { powerW: null })], 0, 10, 1)).toEqual({ available: false });
    expect(energyOverWindows([sample(0)], [], 1)).toEqual({ available: true });
    const zero = energyOverWindows([sample(0, { powerW: 0 }), sample(10, { powerW: 0 })], [[0, 10]], 5);
    expect(zero.joules).toBe(0);
    expect(zero).not.toHaveProperty('tokensPerJoule');
  });
});

describe('vram / primaryGpu', () => {
  it('peak minus baseline per GPU, never negative', () => {
    const base = [sample(0, { memUsedMiB: 1600 }), sample(0, { gpu: 1, memUsedMiB: 500 }), sample(0, { gpu: 2, memUsedMiB: null })];
    const run = [sample(1, { memUsedMiB: 9000 }), sample(2, { memUsedMiB: 9600 }), sample(1, { gpu: 1, memUsedMiB: 400 }), sample(3, { gpu: 3, memUsedMiB: 100 }), sample(4, { memUsedMiB: null })];
    expect(vram(base, run)).toEqual({ baselineMiB: 2100, peakMiB: 9600 + 400 + 100, deltaMiB: 8000 });
    expect(primaryGpu(base, run)).toBe(0);
    expect(primaryGpu([sample(0, { gpu: 1, memUsedMiB: 0 }), sample(0, { gpu: 2, memUsedMiB: 0 })], [sample(1, { gpu: 2, memUsedMiB: 50 }), sample(1, { gpu: 1, memUsedMiB: 10 })])).toBe(2);
  });
  it('partial data', () => {
    expect(vram([], [])).toEqual({});
    expect(vram([sample(0)], [])).toEqual({ baselineMiB: 2000 });
    expect(vram([], [sample(0)])).toEqual({ peakMiB: 2000 });
    expect(primaryGpu([], [])).toBe(0);
    expect(primaryGpu([sample(0, { gpu: 3 })], [])).toBe(3);
  });
});

describe('throttling / maxTemp', () => {
  it('counts severe reasons, ignores benign ones, power cap only when sustained', () => {
    const s = [
      sample(0, { throttle: ['gpu_idle', 'clocks_event_reasons.applications_clocks_setting'] }),
      sample(1, { throttle: ['clocks_event_reasons.sw_thermal_slowdown'] }),
      sample(2, { throttle: [' SW_POWER_CAP '] }),
      sample(3, { throttle: [] }),
      sample(4, { throttle: [] }),
      sample(5, { throttle: [] }),
    ];
    expect(throttling(s)).toEqual(['sw_thermal_slowdown']);
    expect(throttling(s, [[2, 3]])).toEqual(['sw_power_cap']);
    expect(throttling([], [[0, 1]])).toEqual([]);
  });
  it('max temperature, undefined without readings', () => {
    expect(maxTemp([sample(0, { tempC: 50 }), sample(1, { tempC: 71 }), sample(2, { tempC: null }), sample(3, { tempC: 65 })])).toBe(71);
    expect(maxTemp([sample(0, { tempC: null })])).toBeUndefined();
  });
});

describe('load phases / cold read speed', () => {
  it('turns marks into intervals ending at the next mark or ready', () => {
    expect(toLoadPhases([{ name: 'load_tensors', t: 1500 }, { name: 'init', t: 1100 }], 1000, 4000)).toEqual([
      { name: 'init', startMs: 100, endMs: 500 },
      { name: 'load_tensors', startMs: 500, endMs: 3000 },
    ]);
  });
  it('bytes / load_tensors seconds, else / cold load', () => {
    const phases = [{ name: 'load_tensors', startMs: 500, endMs: 2500 }];
    expect(coldReadSpeed(4e9, phases, 9000)).toBe(2e9);
    expect(coldReadSpeed(4e9, [{ name: 'load_tensors', startMs: 5, endMs: 5 }], 4000)).toBe(1e9);
    expect(coldReadSpeed(4e9, [], undefined)).toBeUndefined();
    expect(coldReadSpeed(0, [], 1000)).toBeUndefined();
    expect(coldReadSpeed(1, [], 0)).toBeUndefined();
  });
});

describe('downsampleTelemetry', () => {
  it('keeps everything when small, relative times, one GPU', () => {
    const s = [sample(1250, { powerW: 100.04 }), sample(1000), sample(1000, { gpu: 1 })];
    const t = downsampleTelemetry(s, [{ t: 1100, label: 'cold-load' }], { origin: 1000 });
    expect(t.t).toEqual([0, 250]);
    expect(t.powerW).toEqual([300, 100]);
    expect(t.intervalMs).toBe(250);
    expect(t.marks).toEqual([{ t: 100, label: 'cold-load' }]);
  });
  it('buckets to maxPoints, averaging values and keeping the memory maximum', () => {
    const s = Array.from({ length: 10 }, (_, i) =>
      sample(i * 100, { memUsedMiB: i >= 8 ? null : i === 1 ? 0 : i, utilPct: i % 2 ? null : 10, smClockMHz: null }),
    );
    const t = downsampleTelemetry(s, [], { maxPoints: 3, intervalMs: 100, gpu: 0 });
    expect(t.t.length).toBe(3);
    expect(t.intervalMs).toBe(400);
    expect(t.memUsedMiB).toEqual([3, 7, null]);
    expect(t.utilPct).toEqual([10, 10, 10]);
    expect(t.smClockMHz).toEqual([null, null, null]);
    expect(t.t[0]).toBe(150);
  });
  it('empty input gives empty columns', () => {
    const t = downsampleTelemetry([], []);
    expect(t.t).toEqual([]);
    expect(t.marks).toEqual([]);
  });
});

describe('othersDriftMiB', () => {
  const tick = (t: number, engine: number[], procs: GpuProcessMemory[]): ProcessVramTick => ({
    t,
    engine,
    engineMiB: procs.filter((p) => engine.includes(p.pid)).reduce((n, p) => n + p.mib, 0),
    procs,
  });
  const vmwp = (mib: number) => ({ pid: 29192, mib, name: 'vmwp' });
  const dwm = { pid: 2260, mib: 3300, name: 'dwm' };

  it('nothing known: no readings, or readings that never list a process (WSL)', () => {
    expect(othersDriftMiB([], { engineHasPid: true })).toBeUndefined();
    expect(othersDriftMiB([tick(0, [], []), tick(1, [7], [])], { engineHasPid: true })).toBeUndefined();
  });

  it('native engine: every non-engine process counts, new ones included; engine PIDs of any instance are left out', () => {
    const ticks = [
      tick(0, [], [vmwp(18_000), dwm]),
      tick(1, [7001], [vmwp(18_000), dwm, { pid: 7001, mib: 4000 }]),
      // The first instance stopped (still listed while it frees memory), the next one runs.
      tick(2, [7002], [vmwp(28_000.4), dwm, { pid: 7001, mib: 2000 }, { pid: 7002, mib: 4000 }]),
      tick(3, [], [vmwp(18_500), dwm, { pid: 9000, mib: 700 }]),
    ];
    expect(othersDriftMiB(ticks, { engineHasPid: true })).toBe(10_000);
    expect(othersDriftMiB([ticks[0]!, ticks[3]!], { engineHasPid: true })).toBe(1200);
  });

  it('a process that exits during the run is a drift too', () => {
    expect(othersDriftMiB([tick(0, [], [vmwp(18_000), dwm]), tick(1, [], [dwm])], { engineHasPid: true })).toBe(18_000);
  });

  it('engine without PID (Docker): VMs and processes that appear during the run are the engine, not others', () => {
    const ticks = [
      tick(0, [], [vmwp(300), dwm, { pid: 5, mib: 100 }]),
      tick(1, [], [vmwp(4300), dwm, { pid: 5, mib: 100 }, { pid: 31337, mib: 4000, name: 'llama-server' }]),
      tick(2, [], [vmwp(4300), { ...dwm, mib: 3800 }, { pid: 5, mib: 100 }]),
    ];
    expect(othersDriftMiB(ticks, { engineHasPid: false })).toBe(500);
    expect(othersDriftMiB(ticks, { engineHasPid: true })).toBe(8000);
  });
});
