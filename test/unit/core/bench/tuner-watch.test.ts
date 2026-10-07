/**
 * The tuner's live spill watch, request deadlines and interrupted searches, on the real numbers of an
 * RTX 5090 32 GB (32 607 MiB) with a 27B Q4 model (real-5090.ts), in virtual time. The case of the bug
 * report: f16 at 240K (245 760, the estimate rounded down to 8K) loaded with 31 160 MiB of its own and
 * 1 338 MiB of shared memory, and its 1K probe never finished (99 % GPU, ~147 W: starved).
 */
import { describe, expect, it } from 'vitest';
import type { LaunchParams } from '../../../../src/contract/engines';
import { AppError } from '../../../../src/contract/errors';
import type { Tuning } from '../../../../src/contract/results';
import { anchorOf, requestMsAt } from '../../../../src/core/bench/sweep';
import { createTuner } from '../../../../src/core/bench/tune-run';
import { REQUEST_TIMEOUT_FACTOR, REQUEST_TIMEOUT_MIN_MS, type TunerInput } from '../../../../src/core/bench/tuner';
import { memoryPlan } from '../../../fakes/fake-engine/server.mjs';
import { REAL, REAL_PROFILE, realPredict } from './real-5090';
import { brief, input, Lab, type LabOptions, tune } from './tune-lab';

/** The candidate of the bug report: 240K. */
const BORDER = 245_760;
/** The card, and what the desktop and the other programs held on it besides the engine. */
const TOTAL = 32_607;
const DESKTOP = 1_300;
/** What the engine itself held at 240K. */
const ENGINE_AT_BORDER = 31_160;

/** Shared memory without a spill: ~1 MiB per 1K tokens (124 at 4K, 360 at 240K, 376 at 256K). */
const natural = (ctx: number) => Math.round(REAL.reference.sharedMiB + ((ctx - REAL.reference.ctx) * 252) / 258_048);
const spillsByPlan = (p: LaunchParams) => memoryPlan(REAL_PROFILE.memory!, { flavor: 'llamacpp', ctx: p.contextSize as number, kvType: p.kvCacheType, ubatch: p.ubatchSize }).outcome === 'spill';

/** "Trova le impostazioni migliori", Veloce, on that card (Windows). */
const real = (over: Partial<TunerInput> = {}): Partial<TunerInput> => ({
  spillPossible: true,
  modelContext: 262_144,
  predict: realPredict,
  expect: { anchors: [{ depth: 1024, prefillTps: 2134, decodeTps: 58 }], loadMs: 11_800 },
  ...over,
});

/**
 * The card: every launch the plan says spills uses 4 666 MiB of shared memory (the full spill), except
 * 240K, the borderline one: `border(requests)` (0 = just loaded). The card's memory in use is the
 * engine's own plus the desktop's.
 */
function lab(o: { border?: (requests: number) => number | undefined; engineAtBorder?: number } & LabOptions = {}): Lab {
  const { border, engineAtBorder, ...rest } = o;
  return new Lab({
    profile: REAL_PROFILE,
    timed: true,
    loadMs: REAL.reference.loadMs,
    totalMiB: TOTAL,
    shared: (p, requests) => {
      const ctx = p.contextSize as number;
      if (ctx === BORDER && border) return border(requests);
      return spillsByPlan(p) ? REAL.spill.sharedMiB : natural(ctx);
    },
    card: (p) => DESKTOP + (p.contextSize === BORDER ? (engineAtBorder ?? ENGINE_AT_BORDER) : Math.min(31_000, 16_536 + (65 / 1024) * (p.contextSize as number))),
    ...rest,
  });
}

const checks = (t: Tuning) => t.attempts.filter((a) => a.stage === 'reference' || a.stage === 'capacity').map(brief);

describe('the live spill watch', () => {
  it('240K: clean once loaded (360 MiB shared), 1 338 MiB during the probe that never ends: given up at once, the search goes on lower and ends', async () => {
    const machine = lab({ border: (requests) => (requests === 0 ? natural(BORDER) : 1338), stall: (p) => (p.contextSize === BORDER ? 'deadline' : undefined) });
    const seen: { stopped: number[] }[] = [];
    const tuner = createTuner(input(real()), {
      lab: machine,
      now: machine.now,
      onUpdate: (t) => {
        // The moment the attempt shows in the list: its engine (the 2nd launch) is not stopped yet.
        if (seen.length === 0 && t.attempts.some((a) => a.contextSize === BORDER)) seen.push({ stopped: [...machine.stopped] });
      },
    });
    const t = await tuner.run();
    const border = t.attempts.find((a) => a.contextSize === BORDER)!;
    // max(1024, 124 + 236 + 768) = 1 128 MiB at 240K: crossed in the middle of the probe, which was aborted.
    expect(border).toMatchObject({ stage: 'capacity', outcome: 'spill', spill: 'shared-memory', sharedPeakMiB: 1338, points: [] });
    expect(seen[0]!.stopped).not.toContain(2);
    expect(machine.stopped).toContain(2);
    // Given up at once: the next launch starts one load later, not after the probe's 30 s deadline.
    const next = t.attempts[t.attempts.indexOf(border) + 1]!;
    expect(next.atMs! - border.atMs!).toBe(REAL.reference.loadMs);
    // The search goes on: the binary search steps down, and every KV type is settled.
    expect(checks(t)).toEqual([
      'reference f16@4096 on/512 ok',
      'capacity f16@245760 on/512 spill',
      'capacity f16@32768 on/512 ok',
      'capacity f16@65536 on/512 ok',
      'capacity f16@131072 on/512 ok',
      'capacity f16@188416 on/512 ok',
      'capacity f16@212992 on/512 ok',
      'capacity f16@229376 on/512 spill',
      'capacity q8_0@262144 on/512 ok',
    ]);
    expect(t.capacity[0]).toMatchObject({ kvType: 'f16', measuredMax: 212_992, bound: 'found', failedAt: 229_376 });
    expect(t.recommended).toBeDefined();
    expect(t.stoppedBy).toBeUndefined();
  });

  it('the card full (31 160 MiB of the engine + the desktop’s, of 32 607) and 512 MiB more shared than the reference: given up as soon as it loads', async () => {
    // 700 MiB of shared memory: under 1 128, but the card has no room left.
    const full = await tune(real(), lab({ border: () => 700 }));
    expect(full.t.attempts.find((a) => a.contextSize === BORDER)).toMatchObject({ outcome: 'spill', spill: 'shared-memory', sharedPeakMiB: 700, points: [] });
    // The same 700 MiB with room left on the card (31 160 + 1 300 − 1 000 = 31 460 < 31 583): not a spill by
    // its memory; the probe then shows the starved generation.
    const room = await tune(real(), lab({ border: () => 700, engineAtBorder: ENGINE_AT_BORDER - 1000 }));
    expect(room.t.attempts.find((a) => a.contextSize === BORDER)).toMatchObject({ outcome: 'spill', spill: 'decode-collapse', sharedPeakMiB: 700 });
    expect(room.t.attempts.find((a) => a.contextSize === BORDER)!.points).toHaveLength(1);
  });

  it('a probe quicker than the monitor’s interval: the check right after it still sees the spill (the probe is kept)', async () => {
    const machine = lab({ border: (requests) => (requests === 0 ? natural(BORDER) : 1338), noLiveReadings: true });
    const { t } = await tune(real(), machine);
    const border = t.attempts.find((a) => a.contextSize === BORDER)!;
    expect(border).toMatchObject({ outcome: 'spill', spill: 'shared-memory', sharedPeakMiB: 1338 });
    expect(border.points.map((p) => p.promptTokens)).toEqual([1024]);
  });

  it('memory that spills while the work runs (a deep screening) stops it at that request', async () => {
    // q8_0 at 256K: fine for the probe, 4 666 MiB once its second request (the screening) runs.
    const shared = (p: LaunchParams, requests: number) => (p.kvCacheType === 'q8_0' && requests > 1 ? REAL.spill.sharedMiB : natural(p.contextSize as number));
    const { t } = await tune(real(), new Lab({ profile: REAL_PROFILE, timed: true, loadMs: REAL.reference.loadMs, shared }));
    const q8 = t.attempts.find((a) => a.kvType === 'q8_0')!;
    expect(q8).toMatchObject({ stage: 'capacity', outcome: 'ok' });
    const screen = t.attempts.find((a) => a.kvType === 'q8_0' && a.stage === 'variant')!;
    expect(screen).toMatchObject({ outcome: 'spill', spill: 'shared-memory' });
    // Only the probe was measured on it: the screening request was aborted.
    expect(screen.points.map((p) => p.promptTokens)).toEqual([1024]);
  });

  it('Linux (no spill possible): nothing is watched', async () => {
    const machine = lab({ border: () => 9999 });
    const { t } = await tune(real({ spillPossible: false }), machine);
    expect(t.attempts.every((a) => a.outcome !== 'spill')).toBe(true);
  });
});

describe('request deadlines', () => {
  it('without the counters the stalled probe runs into its deadline (30 s): "too slow", and the search goes on lower', async () => {
    const machine = lab({ shared: () => undefined, stall: (p) => (p.contextSize === BORDER ? 'deadline' : undefined) });
    const { t } = await tune(real(), machine);
    const border = t.attempts.find((a) => a.contextSize === BORDER)!;
    expect(border).toMatchObject({ outcome: 'spill', spill: 'too-slow', error: { code: 'ENGINE_TIMEOUT', params: { reason: 'deadline', ms: REQUEST_TIMEOUT_MIN_MS } }, points: [] });
    // It waited its deadline, then the next launch.
    const next = t.attempts[t.attempts.indexOf(border) + 1]!;
    expect(next.atMs! - border.atMs!).toBe(REAL.reference.loadMs + REQUEST_TIMEOUT_MIN_MS);
    expect(next).toMatchObject({ stage: 'capacity', contextSize: 32_768, outcome: 'ok' });
    expect(t.capacity[0]).toMatchObject({ kvType: 'f16', measuredMax: 212_992 });
  });

  it('every probe, screening and sweep request has max(30 s, 5 × its time predicted from the reference’s speeds at its depth)', async () => {
    const machine = lab();
    const { t } = await tune(real(), machine);
    const ref = anchorOf(t.attempts[0]!.points[0]!);
    expect(ref).toMatchObject({ depth: 1024 });
    expect(machine.timeouts.length).toBeGreaterThan(10);
    for (const { depth, ms } of machine.timeouts) {
      const out = depth === 1024 && ms === REQUEST_TIMEOUT_MIN_MS ? undefined : 128;
      const predicted = out === undefined ? 0 : requestMsAt(depth, out, ref);
      expect(ms).toBe(Math.round(Math.max(REQUEST_TIMEOUT_MIN_MS, REQUEST_TIMEOUT_FACTOR * predicted)));
    }
    // A deep prompt gets minutes: 256K reads at ~600 tok/s here (predicted), 5 × that.
    const deep = machine.timeouts.find((x) => x.depth > 200_000)!;
    expect(deep.ms).toBe(Math.round(REQUEST_TIMEOUT_FACTOR * requestMsAt(deep.depth, 128, ref)));
    expect(deep.ms).toBeGreaterThan(20 * 60_000);
  });

  it('an engine that stops streaming (the stall guard of every run) is "too slow" too; before the reference, deadlines come from the expected speeds', async () => {
    const machine = lab({ shared: () => undefined, stall: (p) => (p.contextSize === BORDER ? 'stalled' : undefined) });
    const { t } = await tune(real({ minRequestTimeoutMs: 1000 }), machine);
    expect(t.attempts.find((a) => a.contextSize === BORDER)).toMatchObject({ outcome: 'spill', spill: 'too-slow', error: { params: { reason: 'stalled', ms: 60_000 } } });
    // The reference's own probe: 5 × (1 024 / 2 134 + 32 / 58) s from the expected speeds.
    expect(machine.timeouts[0]).toEqual({ depth: 1024, ms: Math.round(5 * requestMsAt(1024, 32, { depth: 1024, prefillTps: 2134, decodeTps: 58 })) });
  });
});

describe('a search the run ends (cancelled, failed)', () => {
  it('cancelled during the 240K probe: f16 holds at least 4K (the reference), q8_0 and q4_0 were never tried; what was measured is kept', async () => {
    // No counters here: the cancellation comes during the probe (the user's run).
    const machine = lab({ shared: () => undefined, throwOn: (p) => (p.contextSize === BORDER ? new AppError('CANCELLED', 'Run cancelled') : undefined) });
    const tuner = createTuner(input(real()), { lab: machine, now: machine.now });
    await expect(tuner.run()).rejects.toMatchObject({ code: 'CANCELLED' });
    const t = tuner.interrupted('cancelled');
    expect(t.stoppedBy).toBe('cancelled');
    expect(t.capacity).toEqual([
      { kvType: 'f16', predictedMax: REAL.predicted.f16, measuredMax: 4096, inferred: false, bound: 'cancelled' },
      { kvType: 'q8_0', predictedMax: REAL.predicted.q8_0, inferred: false, skipped: 'cancelled' },
      { kvType: 'q4_0', predictedMax: REAL.predicted.q4_0, inferred: false, skipped: 'cancelled' },
    ]);
    // The reference's 1K check is all that was measured: a combination "misurata in parte (test annullato)".
    expect(t.combinations.map((c) => [c.kvType, c.maxContext, c.partial, c.sweep.map((p) => p.promptTokens)])).toEqual([['f16', 4096, 'cancelled', [1024]]]);
    expect(t.recommended).toBe(0);
  });

  it('failed: a type with only failed launches so far has no maximum, the smallest that failed; a finished search keeps its own bound', async () => {
    // f16 runs out of memory even at 4K: the reference moves to q8_0; then q8_0 at 256K fails for good.
    const machine = lab({
      fail: (p) =>
        p.kvCacheType === 'f16' ? { code: 'ENGINE_OOM', message: 'oom' } : p.kvCacheType === 'q8_0' && p.contextSize === 262_144 ? { code: 'ENGINE_BAD_FLAG', message: 'bad', params: { flag: '-ctk' } } : undefined,
    });
    const tuner = createTuner(input(real()), { lab: machine, now: machine.now });
    await expect(tuner.run()).rejects.toMatchObject({ code: 'ENGINE_BAD_FLAG' });
    const t = tuner.interrupted('failed');
    expect(t.capacity.map((c) => [c.kvType, c.measuredMax, c.bound, c.failedAt, c.skipped])).toEqual([
      // Searched to its end: every context it tried failed ("Nessun contesto è entrato").
      ['f16', undefined, undefined, undefined, undefined],
      ['q8_0', 4096, 'failed', undefined, undefined],
      ['q4_0', undefined, undefined, undefined, 'failed'],
    ]);
  });

  it('a type cut after its only launches failed: no maximum, cut at the smallest context that failed', async () => {
    // Linux (no reference launch): f16 runs out of memory at 240K, the run is cancelled during its 16K check.
    const machine = lab({
      fail: (p) => (p.kvCacheType === 'f16' && p.contextSize === BORDER ? { code: 'ENGINE_OOM', message: 'oom' } : undefined),
      throwOn: (p) => (p.kvCacheType === 'f16' && p.contextSize === 16_384 ? new AppError('CANCELLED', 'Run cancelled') : undefined),
    });
    const tuner = createTuner(input(real({ spillPossible: false })), { lab: machine, now: machine.now });
    await expect(tuner.run()).rejects.toMatchObject({ code: 'CANCELLED' });
    const t = tuner.interrupted('cancelled');
    expect(t.capacity.map((c) => [c.kvType, c.measuredMax, c.bound, c.failedAt, c.skipped])).toEqual([
      ['f16', undefined, 'cancelled', BORDER, undefined],
      ['q8_0', undefined, undefined, undefined, 'cancelled'],
      ['q4_0', undefined, undefined, undefined, 'cancelled'],
    ]);
    expect(t.combinations).toEqual([]);
    expect(t.recommended).toBeUndefined();
  });
});
