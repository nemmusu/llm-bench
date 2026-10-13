/**
 * The tuner on the real numbers of an RTX 5090 with a 27B Q4 model (real-5090.ts), in virtual time:
 * requests take what their speeds say (minutes for 128K–256K prompts). Capacity checks, the time
 * forecast and limit, adaptive repetitions, requests left out at the limit, partial combinations.
 */
import { describe, expect, it } from 'vitest';
import type { LaunchParams } from '../../../../src/contract/engines';
import { llamaSpace } from '../../../../src/core/bench/tune-space';
import { createTuner, FORECAST_ONLY, tuneTime } from '../../../../src/core/bench/tune-run';
import { BUDGETS, nearestAnchor, pointsByDepth, SLOW_REQUEST_MS, TIME_GRACE_MS, TIME_MARGIN, type MeasureOptions, type TunerInput } from '../../../../src/core/bench/tuner';
import { memoryPlan } from '../../../fakes/fake-engine/server.mjs';
import { REAL, REAL_PROFILE, realPredict } from './real-5090';
import { point } from './tune-helpers';
import { brief, input, Lab, P, tune } from './tune-lab';

/** Shared memory as measured: ~1 MiB per 1K tokens without a spill (124 at 4K … 376 at 256K), 4 666 MiB when it spills. */
const shared = (p: LaunchParams): number => {
  const ctx = p.contextSize as number;
  const plan = memoryPlan(REAL_PROFILE.memory!, { flavor: 'llamacpp', ctx, kvType: p.kvCacheType, ubatch: p.ubatchSize });
  return plan.outcome === 'spill' ? REAL.spill.sharedMiB : Math.round(REAL.reference.sharedMiB + ((ctx - REAL.reference.ctx) * 252) / 258_048);
};

/** "Trova le impostazioni migliori" on that card, the way the 0.3.0 run was asked (Veloce, Windows). */
const real = (over: Partial<TunerInput> = {}): Partial<TunerInput> => ({
  spillPossible: true,
  modelContext: 262_144,
  predict: realPredict,
  // The model's size says ~2 100 tok/s of prompt reading and ~58 tok/s of generation, ~12 s per load.
  expect: { anchors: [{ depth: 1024, prefillTps: 2134, decodeTps: 58 }], loadMs: 11_800 },
  ...over,
});

const realLab = (log?: { depth: number; reps: number; made: number; at: number }[]) =>
  new Lab({ profile: REAL_PROFILE, timed: true, loadMs: REAL.reference.loadMs, shared, ...(log ? { log } : {}) });

describe('capacity: quick checks, the estimate rounded to 8K, a search down to 8K steps', () => {
  it('reference and capacity launches only measure a 1K probe; 245 760 (the estimate) is tried first', async () => {
    const { t } = await tune(real(), realLab());
    expect(t.attempts.filter((a) => a.stage === 'reference' || a.stage === 'capacity').map(brief)).toEqual([
      'reference f16@4096 on/512 ok',
      // The estimate (247 552) rounded down to 8K: it spills (4 666 MiB of shared memory).
      'capacity f16@245760 on/512 spill',
      'capacity f16@32768 on/512 ok',
      'capacity f16@65536 on/512 ok',
      'capacity f16@131072 on/512 ok',
      // Between 128K (loads) and 240K (spills): 184K, 208K, then 224K, down to steps within 1/8.
      'capacity f16@188416 on/512 ok',
      'capacity f16@212992 on/512 ok',
      'capacity f16@229376 on/512 spill',
      'capacity q8_0@262144 on/512 ok',
    ]);
    const checks = t.attempts.filter((a) => a.stage === 'reference' || a.stage === 'capacity');
    const loaded = checks.filter((a) => a.outcome === 'ok');
    expect(loaded.every((a) => a.points.length === 1 && a.points[0]!.promptTokens === 1024 && a.points[0]!.outputTokens === 32)).toBe(true);
    // A launch already in shared memory once loaded is given up at once: no probe (it would take a minute there).
    expect(checks.filter((a) => a.outcome === 'spill').every((a) => a.points.length === 0)).toBe(true);
    expect(checks.find((a) => a.contextSize === 245_760)).toMatchObject({ spill: 'shared-memory', sharedPeakMiB: 4666 });
    // 376 MiB at 256K is the natural growth, not a spill.
    expect(checks.find((a) => a.kvType === 'q8_0')).toMatchObject({ outcome: 'ok', sharedPeakMiB: 376 });
    expect(t.capacity).toEqual([
      { kvType: 'f16', predictedMax: 247_552, measuredMax: 212_992, inferred: false, bound: 'found', failedAt: 229_376 },
      { kvType: 'q8_0', predictedMax: 262_144, measuredMax: 262_144, inferred: false, bound: 'model' },
      { kvType: 'q4_0', predictedMax: 262_144, measuredMax: 262_144, inferred: true, skipped: 'no-gain', bound: 'model' },
    ]);
  });

  it('a collapse is measured at the same shallow depth as the reference: 3.5 tok/s against 53.7 at 1K; slowing down on deep prompts is not one', async () => {
    const decode = (p: LaunchParams, d: number) => (p.kvCacheType === 'q8_0' && p.contextSize === 262_144 && d === 1024 ? REAL.spill.decode : undefined);
    // Without the counters (no shared memory reading): the 1K probe gives it away.
    const lab = new Lab({ profile: REAL_PROFILE, timed: true, loadMs: REAL.reference.loadMs, decode });
    const { t } = await tune(real(), lab);
    expect(t.attempts.find((a) => a.stage === 'capacity' && a.kvType === 'q8_0' && a.contextSize === 262_144)).toMatchObject({ outcome: 'spill', spill: 'decode-collapse' });
    // Generation falls from 55.9 to 27.9 tok/s at 256K on a clean launch: every combination is kept.
    const clean = await tune(real(), realLab());
    const q8 = clean.t.combinations.find((c) => c.kvType === 'q8_0')!;
    expect(q8.sweep.at(-1)!.decodeTps.median / q8.sweep[0]!.decodeTps.median).toBeLessThan(0.6);
    expect(q8.partial).toBeUndefined();
  });

  it('a capacity search cut by the time limit says so ("Almeno"), the estimate stops it otherwise', async () => {
    const roomy = { ...REAL_PROFILE, memory: { ...REAL_PROFILE.memory!, totalMiB: 60_000 } };
    // The estimate says f16 holds 64K only: nothing larger is tried.
    const predict = (p: LaunchParams) => ({ ...realPredict(p), availableMiB: (16_536 + (65 / 1024) * 65_536) / 1.1 });
    const capped = await tune(real({ predict }), new Lab({ profile: roomy, timed: true, loadMs: REAL.reference.loadMs }));
    expect(capped.t.capacity[0]).toMatchObject({ kvType: 'f16', measuredMax: 65_536, bound: 'estimate' });
  });
});

describe('time: the forecast, the limit and every request within it', () => {
  it('the estimate is the plan’s duration; the limit is it × 1.5 (never below the budget’s shortest)', async () => {
    const t = tuneTime(input(real()));
    // ~34 minutes for this model with "Veloce": not 5, and not 47 (a 200K point in every combination
    // that reaches it, which only "Accurata" and "Completo" measure).
    expect(t.estimateMs / 60_000).toBeGreaterThan(30);
    expect(t.estimateMs / 60_000).toBeLessThan(38);
    expect(t.limitMs).toBe(Math.round(t.estimateMs * TIME_MARGIN));
    // "Accurata" tries more values: longer.
    expect(tuneTime(input(real({ budget: 'thorough', space: llamaSpace({ budget: 'thorough', params: P() }) }))).estimateMs).toBeGreaterThan(t.estimateMs);
    // A small model on a big card: the shortest limit of the budget.
    const small = tuneTime(input({ modelContext: 8192, expect: { anchors: [{ depth: 1024, prefillTps: 20_000, decodeTps: 300 }], loadMs: 1000 } }));
    expect(small.limitMs).toBe(BUDGETS.fast.minMs);
    expect(tuneTime(input({ limitMs: 3_600_000 })).limitMs).toBe(3_600_000);
    // A forecast never launches anything.
    await expect(FORECAST_ONLY.prepare(P(), { stage: 'capacity', attempt: 0 })).rejects.toThrow('never launches');
  });

  it('the whole search ends within its limit, close to its estimate', async () => {
    const lab = realLab();
    const { t } = await tune(real(), lab);
    expect(t.stoppedBy).toBeUndefined();
    expect(lab.t).toBeLessThan(t.limitSeconds! * 1000);
    expect(lab.t).toBeLessThanOrEqual(t.estimateSeconds! * 1000);
    expect(lab.t).toBeGreaterThan(0.6 * t.estimateSeconds! * 1000);
  });

  it('a request longer than a minute is made once (n = 1); a deep prompt is measured once per combination', async () => {
    const log: { depth: number; reps: number; made: number; at: number }[] = [];
    const { t } = await tune(real(), realLab(log));
    const slow = log.filter((l) => l.depth >= 131_072);
    expect(slow.length).toBeGreaterThan(0);
    expect(slow.every((l) => l.reps === 1)).toBe(true);
    expect(log.filter((l) => l.depth === 1024 && l.reps > 1).length).toBeGreaterThan(0);
    // The deepest prompt of 256K: once for each combination at 256K (q8_0, q4_0), in its sweep.
    expect(log.filter((l) => l.depth === 262_000)).toHaveLength(t.combinations.filter((c) => c.maxContext === 262_144).length);
    // "Veloce" on 256K: 1K, 4K, 16K, 64K and the exact maximum (no 200K); screened at 1K and 64K.
    const rec = t.combinations[t.recommended!]!;
    expect(rec).toMatchObject({ kvType: 'q8_0', maxContext: 262_144, params: { ubatchSize: 2048 } });
    expect(rec.sweep.map((p) => p.promptTokens)).toEqual([1024, 4096, 16384, 65536, 262_000]);
    expect(rec.sweep.at(-1)!.decodeTps.n).toBe(1);
    // A screening that lost never sent its deepest prompt (the winner's sweep did, on its own launch).
    expect(t.attempts.filter((a) => a.screen === 'lost').every((a) => a.points.every((p) => p.promptTokens <= 65_536))).toBe(true);
    expect(SLOW_REQUEST_MS).toBe(60_000);
  });

  it('"Accurata" doubles the grid and screens the deepest prompt too', async () => {
    const log: { depth: number; reps: number; made: number; at: number }[] = [];
    const { t } = await tune(real({ budget: 'thorough', space: llamaSpace({ budget: 'thorough', params: P() }) }), realLab(log));
    const q8 = t.combinations.find((c) => c.kvType === 'q8_0')!;
    expect(q8.sweep.map((p) => p.promptTokens)).toEqual([1024, 4096, 8192, 16384, 32768, 65536, 131_072, 204_800, 262_000]);
    expect(t.attempts.some((a) => a.stage === 'variant' && a.points.some((p) => p.promptTokens === 262_000))).toBe(true);
  });

  it('a request that would end past the limit is not started (recorded); a started one is never cut', async () => {
    const log: { depth: number; reps: number; made: number; at: number }[] = [];
    // The 0.3.0 run had 5 minutes; its two launches that spilled are given up at once now, without the
    // slow probe they used to measure: the same work is 30 s earlier.
    const { t, lab } = await tune(real({ limitMs: 4.5 * 60_000 }), realLab(log));
    expect(t.stoppedBy).toBe('budget');
    expect(lab.t).toBeLessThanOrEqual(4.5 * 60_000 + TIME_GRACE_MS);
    const cut = t.attempts.find((a) => a.skipped);
    // The first deep point left: the deepest prompt of 256K (a request of minutes).
    expect(cut!.skipped).toEqual([{ depth: 262_000, predictedMs: expect.any(Number) }]);
    expect(cut!.skipped![0]!.predictedMs).toBeGreaterThan(SLOW_REQUEST_MS);
    // The second repetition of 64K would not have ended in time: the point keeps the one made (n = 1).
    expect(log.some((l) => l.depth === 65_536 && l.made < l.reps)).toBe(true);
    // Every request that started ended (the lab's clock passed its whole duration).
    expect(log.every((l) => l.made >= 1)).toBe(true);
  });

  it('the forecast: what is left shrinks as the search goes, the estimate stays', async () => {
    const lab = realLab();
    const seen: { total: number; remaining: number; at: number }[] = [];
    const tuner = createTuner(input(real()), {
      lab,
      now: lab.now,
      onUpdate: () => {
        const f = tuner.forecast();
        seen.push({ total: f.totalMs, remaining: f.remainingMs, at: lab.t });
      },
    });
    const before = tuner.forecast();
    expect(before.remainingMs).toBe(before.totalMs);
    await tuner.run();
    expect(new Set(seen.map((s) => s.total)).size).toBe(1);
    expect(seen.at(-1)!.remaining).toBe(0);
    expect(seen[Math.floor(seen.length / 2)]!.remaining).toBeLessThan(before.remainingMs);
  });

  it('a request taking longer than predicted is expected to need a quarter of what it took so far', async () => {
    const holder: { tuner?: ReturnType<typeof createTuner> } = {};
    let during: number[] = [];
    const lab = realLab();
    const prepare = lab.prepare.bind(lab);
    lab.prepare = async (params: LaunchParams) => {
      const r = await prepare(params);
      return {
        ...r,
        start: async (guard) => {
          const s = await r.start(guard);
          if (!s.ok) return s;
          const m = s.engine.measure;
          return {
            ...s,
            engine: {
              ...s.engine,
              measure: async (d: number, o: number, n: number, k: Parameters<typeof m>[3], mo?: MeasureOptions) => {
                // In the middle of a 64K request: much later than it should have ended.
                if (d === 65_536 && during.length === 0) {
                  lab.t += 1_000_000;
                  during = [holder.tuner!.forecast().remainingMs];
                }
                return m(d, o, n, k, mo);
              },
            },
          };
        },
      };
    };
    holder.tuner = createTuner(input(real({ limitMs: 10_000_000 })), { lab, now: lab.now });
    await holder.tuner.run();
    expect(during[0]).toBeGreaterThanOrEqual(1_000_000 / 4);
  });

  it('"Accurata" cut by the limit inside a screening: the screening keeps what it measured', async () => {
    const { t } = await tune(real({ budget: 'thorough', space: llamaSpace({ budget: 'thorough', params: P() }), limitMs: 8 * 60_000 }), realLab());
    const cut = t.attempts.find((a) => a.stage === 'variant' && a.skipped);
    expect(cut!.skipped![0]!.depth).toBe(262_000);
    expect(cut!.points.map((p) => p.promptTokens)).toEqual([1024, 1024, 131_072]);
    expect(t.combinations.every((c) => c.partial === 'budget')).toBe(true);
  });

  it('a point without measurements says nothing about the speeds', async () => {
    const lab = realLab();
    const prepare = lab.prepare.bind(lab);
    lab.prepare = async (params: LaunchParams) => {
      const r = await prepare(params);
      return {
        ...r,
        start: async (guard) => {
          const s = await r.start(guard);
          if (!s.ok) return s;
          const m = s.engine.measure;
          // Every 1K probe comes back empty (no token ids, no timings).
          const empty = async (d: number, o: number, n: number, k: Parameters<typeof m>[3], mo?: MeasureOptions) => {
            const p = await m(d, o, n, k, mo);
            return d === 1024 && o === 32 ? { ...p, decodeTps: { ...p.decodeTps, n: 0 } } : p;
          };
          return { ...s, engine: { ...s.engine, measure: empty } };
        },
      };
    };
    const tuner = createTuner(input(real({ spillPossible: false })), { lab, now: lab.now });
    const before = tuner.time().estimateMs;
    await tuner.run();
    expect(tuner.time().estimateMs).toBe(before);
  });

  it('the search between "loads" and "does not" never repeats a context (an unaligned largest one)', () => {
    const tuner = createTuner(input(), { lab: FORECAST_ONLY, now: () => 0 }) as unknown as { refine: (c: object, ok: number, fail: number) => boolean };
    const cap = { candidates: [74_000, 84_000], status: new Map([[74_000, true], [84_000, false]]) };
    // Their middle rounded down to 8K is 73 728: below the largest that loads.
    expect(tuner.refine(cap, 0, 1)).toBe(false);
    expect(cap.candidates).toEqual([74_000, 84_000]);
  });

  it('speeds are predicted from the measurement nearest in depth', () => {
    const a = { depth: 1024, prefillTps: 1810, decodeTps: 55.9 };
    const b = { depth: 131_072, prefillTps: 1450, decodeTps: 40.2 };
    expect(nearestAnchor([a, b], 262_144)).toBe(b);
    expect(nearestAnchor([a, b], 2048)).toBe(a);
    expect(nearestAnchor([], 2048)).toBeUndefined();
    // An empty expectation: the defaults.
    expect(tuneTime(input({ expect: { anchors: [] } })).estimateMs).toBe(tuneTime(input()).estimateMs);
  });
});

describe('results when the time runs out', () => {
  it('the 0.3.0 run again (its 5 minutes, less the 30 s its spills no longer cost): partly measured combinations, ranked by the same rules, and a recommendation', async () => {
    const { t } = await tune(real({ limitMs: 4.5 * 60_000 }), realLab());
    expect(t.combinations.length).toBeGreaterThan(0);
    expect(t.combinations.every((c) => c.partial === 'budget')).toBe(true);
    const rec = t.combinations[t.recommended!]!;
    // The largest context first: q8_0 at 256K, with what its launch measured (1K, 4K, 16K, 64K).
    expect(rec).toMatchObject({ kvType: 'q8_0', maxContext: 262_144 });
    expect(rec.sweep.map((p) => p.promptTokens)).toEqual([1024, 4096, 16384, 65536]);
    // f16 at its largest context: its quick check at 1K.
    expect(t.combinations.find((c) => c.kvType === 'f16')).toMatchObject({ maxContext: 212_992, sweep: [expect.objectContaining({ promptTokens: 1024, outputTokens: 32 })] });
    // Each partial combination points at the launch that measured it (its command, its record).
    for (const [i, c] of t.combinations.entries()) expect(t.attempts.find((a) => a.combination === i)?.contextSize).toBe(c.maxContext);
    expect(t.fastestByDepth.length).toBeGreaterThan(0);
  });

  it('one point per depth: the one with the most tokens behind it', () => {
    const probe = { ...point(1024, 50), outputTokens: 32 };
    const screen = point(1024, 52);
    expect(pointsByDepth([probe, point(65_536, 40), screen])).toEqual([screen, point(65_536, 40)]);
    expect(pointsByDepth([screen, probe])).toEqual([screen]);
  });
});
