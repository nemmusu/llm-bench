/**
 * The tuner on the NInfer-all run of 2026-10-14 ("Trova le impostazioni migliori", Veloce, RTX 5090,
 * Windows through WSL), in virtual time: engine starts of ~90 s where 15 s were expected (the model read
 * from /mnt/c), NInfer's reservation saying how many tokens fit (bf16 120 832, int8 241 664) at contexts
 * that then spill (generation 19.2 tok/s against the reference's 94.5), rk8v4 holding the whole 256K,
 * nvfp4 known to hold it without a launch. Only the numbers, no file of the user.
 */
import { describe, expect, it } from 'vitest';
import type { LaunchParams } from '../../../../src/contract/engines';
import { fullContextPoint, type TuneAttempt, type Tuning } from '../../../../src/contract/results';
import { PREFILL_HALF_DEPTH, DECODE_HALF_DEPTH, rateAt, requestMsAt } from '../../../../src/core/bench/sweep';
import { NINFER_EXPECT, ninferSpace } from '../../../../src/core/bench/tune-ninfer';
import { runnerUp } from '../../../../src/core/bench/tune-rank';
import { createTuner, tuneTime } from '../../../../src/core/bench/tune-run';
import { vllmSpace } from '../../../../src/core/bench/tune-space';
import {
  BUDGETS,
  capacityMiddle,
  capacitySettled,
  fullContextFirst,
  lastToTry,
  TIME_GRACE_MS,
  TIME_MARGIN,
  type Dimension,
  type LabEngine,
  type LabLaunch,
  type LabStart,
  type TuneLab,
  type TunerInput,
} from '../../../../src/core/bench/tuner';
import { TUNE_PROFILE } from '../../../fakes/fake-engine/profiles.mjs';
import type { FakeProfile } from '../../../fakes/fake-engine/server.mjs';
import { concurrencyPoint, point, sessionsPoint } from './tune-helpers';
import { capacityOf, Lab, P, tune } from './tune-lab';

const FULL = 262_144;
/** The deepest prompt of a 256K context with a 128-token answer: the context full. */
const DEEPEST = 262_000;
/** Prompt reading at 1K, tok/s. */
const PREFILL = 8000;
/** Tokens each KV precision holds fully on the GPU, and how many NInfer's reservation says fit (above: out of memory); fp8 is int8's size. */
const HOLDS: Record<string, { fits: number; reserve: number }> = {
  bf16: { fits: 106_496, reserve: 120_832 },
  int8: { fits: 196_608, reserve: 241_664 },
  fp8: { fits: 196_608, reserve: 241_664 },
  rk8v4: { fits: FULL, reserve: FULL },
  nvfp4: { fits: FULL, reserve: FULL },
};
/** Generation at 1K, tok/s: the reference's 94.5 (bf16); MTP with 4 draft tokens the fastest, speculation off the slowest. */
const DECODE_1K: Record<string, number> = { bf16: 94.5, int8: 80, fp8: 82, rk8v4: 84, nvfp4: 88 };
/** A launch in shared memory generates at this speed (the run's attempt 2). */
const SPILLED = 19.2;

type Ninfer = NonNullable<LaunchParams['ninfer']>;

/** Speeds at a depth, slowing down as the tuner's own forecast expects (so its predictions are exact). */
function speedsAt(n: Ninfer, depth: number): { prefill: number; decode: number } {
  const spec = n.spec === 'off' ? 0.65 : n.draftTokens === 4 ? 1.06 : n.draftTokens === 2 ? 0.95 : 1;
  const decode = (DECODE_1K[n.kvDtype as string] as number) * spec;
  return { prefill: rateAt(PREFILL, 1024, depth, PREFILL_HALF_DEPTH), decode: rateAt(decode, 1024, depth, DECODE_HALF_DEPTH) };
}

interface Measured {
  launch: number;
  depth: number;
  made: number;
  at: number;
}

interface CardOptions {
  /** Every engine start, ms. */
  loadMs?: number;
  /** Requests that run in shared memory once the context fills (the KV tail spilled). */
  deepSpill?: (n: Ninfer, depth: number) => boolean;
}

/** The card and NInfer, scripted: starts take `loadMs`, requests what their speeds say. */
class NinferCard implements TuneLab {
  t = 0;
  readonly started: LaunchParams[] = [];
  readonly measured: Measured[] = [];
  constructor(private readonly o: CardOptions = {}) {}
  now = (): number => this.t;

  async prepare(params: LaunchParams): Promise<LabLaunch> {
    const argv = ['ninfer-serve', JSON.stringify(params.ninfer)];
    return { command: { argv, powershell: argv.join(' '), bash: argv.join(' ') }, start: () => this.start(params) };
  }

  private async start(params: LaunchParams): Promise<LabStart> {
    this.started.push(params);
    const launch = this.started.length;
    const loadMs = this.o.loadMs ?? 90_000;
    this.t += loadMs;
    const n = params.ninfer as Ninfer;
    const ctx = n.kvCapacity as number;
    const holds = HOLDS[n.kvDtype as string] as { fits: number; reserve: number };
    if (ctx > holds.reserve) {
      return { ok: false, loadMs, error: { code: 'ENGINE_OOM', message: 'NInfer cannot reserve its runtime memory', params: { reason: 'ninfer-reservation', estimatedMaxModelLen: holds.reserve } } };
    }
    const spilled = ctx > holds.fits;
    const engine: LabEngine = {
      measure: async (depth, out, reps, _kind, mo = {}) => {
        const s = speedsAt(n, depth);
        const decode = spilled ? SPILLED : this.o.deepSpill?.(n, depth) ? 4.9 : s.decode;
        let made = 0;
        for (let r = 0; r < reps; r++) {
          if (r > 0 && mo.more && !mo.more()) break;
          made++;
          this.t += Math.round((depth / s.prefill + out / decode) * 1000);
        }
        this.measured.push({ launch, depth, made, at: this.t });
        const p = { ...point(depth, decode, { prefill: s.prefill }), outputTokens: out };
        return { ...p, decodeTps: { ...p.decodeTps, n: made } };
      },
      concurrency: async (level, promptTokens, outputTokens) => {
        const s = speedsAt(n, promptTokens);
        this.t += Math.round(((level * promptTokens) / s.prefill + outputTokens / s.decode) * 1000);
        return concurrencyPoint(level, s.decode / (1 + 0.15 * (level - 1)), { promptTokens, outputTokens });
      },
      sessions: async (step) => [sessionsPoint(step.levels[0] as number, step.depth, 100)],
      memory: () => ({ vramPeakMiB: 30_000 }),
      capacityHint: () => undefined,
      generate: async () => [1, 2, 3],
      stop: async () => undefined,
    };
    return { ok: true, engine, loadMs };
  }
}

/** "Trova le impostazioni migliori", Veloce, NInfer-all (its build lists rk8v4), Windows (WSL: a spill is possible). */
function ninferInput(over: Partial<TunerInput> & { kvDtypes?: string[]; users?: number } = {}): TunerInput {
  const { kvDtypes = ['bf16', 'int8', 'rk8v4', 'nvfp4'], users, ...rest } = over;
  return {
    space: ninferSpace({ budget: 'fast', params: P({ ninfer: { prefixReuse: false, thinking: false } }), backends: ['mtp'], proposalHead: false, kvDtypes, ...(users ? { users } : {}) }),
    budget: 'fast',
    sweep: { outputTokens: 128, reps: 2 },
    modelContext: FULL,
    spillPossible: true,
    fidelity: false,
    expect: NINFER_EXPECT,
    ...rest,
  };
}

async function search(input: TunerInput, card = new NinferCard(), maxLaunches?: number): Promise<{ t: Tuning; card: NinferCard; updates: Tuning[] }> {
  const updates: Tuning[] = [];
  const tuner = createTuner(input, { lab: card, now: card.now, onUpdate: (t) => updates.push(t) });
  if (maxLaunches !== undefined) (tuner as unknown as { rules: object }).rules = { ...BUDGETS[input.budget], maxLaunches };
  const t = await tuner.run();
  return { t, card, updates };
}

const brief = (a: TuneAttempt) => `${a.stage} ${a.kvType}@${a.contextSize} ${a.outcome}${a.spill ? ` ${a.spill}` : ''}`;

describe('helpers', () => {
  it('the capacity search stops within 8K or 1/8, or with no multiple of 8K in between', () => {
    expect(capacityMiddle(65_536, 120_832)).toBe(90_112);
    expect(capacitySettled(65_536, 120_832)).toBe(false);
    expect(capacitySettled(106_496, 120_832)).toBe(true);
    expect(capacitySettled(212_992, 229_376)).toBe(true);
    expect(capacitySettled(180_224, 204_800)).toBe(false);
    expect(capacitySettled(74_000, 84_000)).toBe(true);
  });

  it('the context full first, then the others in their order', () => {
    expect(fullContextFirst([4096, 16384, DEEPEST], DEEPEST)).toEqual([DEEPEST, 4096, 16384]);
    expect(fullContextFirst([4096, 16384], DEEPEST)).toEqual([4096, 16384]);
    expect(fullContextFirst([], DEEPEST)).toEqual([]);
  });

  it('the last value to try: no later dimension has another value for the variant', () => {
    const dims: Dimension[] = [
      { key: 'draft', values: () => [3, 2, 4] },
      { key: 'kv8', values: (v) => (v.kv === 'int8' ? ['int8', 'fp8'] : []) },
    ];
    expect(lastToTry(dims, 0, { kv: 'rk8v4', draft: 4 })).toBe(true);
    expect(lastToTry(dims, 0, { kv: 'int8', draft: 4, kv8: 'int8' })).toBe(false);
    expect(lastToTry(dims, 1, { kv: 'int8', draft: 4, kv8: 'fp8' })).toBe(true);
    // A dimension whose only value is the variant's own has nothing left to try.
    expect(lastToTry([...dims, { key: 'vision', values: () => [false] }], 0, { kv: 'rk8v4', draft: 4, vision: false })).toBe(true);
  });
});

describe('capacity: NInfer says how many tokens fit, and that context spills', () => {
  it('bf16: 120 832 said, spilled; the search goes on above 64K, to within 1/8: "Limite trovato"', async () => {
    const { t } = await search(ninferInput({ kvDtypes: ['bf16'] }));
    expect(t.attempts.filter((a) => a.stage !== 'variant' && a.stage !== 'sweep').map(brief)).toEqual([
      'reference bf16@4096 ok',
      'capacity bf16@262144 oom',
      // The context NInfer's reservation named: it loads, but in shared memory (19.2 tok/s at 1K against 94.5).
      'capacity bf16@120832 spill decode-collapse',
      'capacity bf16@16384 ok',
      'capacity bf16@32768 ok',
      'capacity bf16@65536 ok',
      // The run stopped here ("a 118K non entra più"): 64K → 118K is far more than 1/8.
      'capacity bf16@90112 ok',
      'capacity bf16@98304 ok',
      'capacity bf16@106496 ok',
    ]);
    expect(t.capacity).toEqual([{ kvType: 'bf16', measuredMax: 106_496, inferred: false, bound: 'found', failedAt: 120_832 }]);
  });

  it('cut by the launch cap in the middle of that search: "Almeno", with the context that did not fit', async () => {
    const { t } = await search(ninferInput({ kvDtypes: ['bf16'] }), new NinferCard(), 7);
    expect(t.stoppedBy).toBe('launches');
    expect(t.attempts.at(-1)).toMatchObject({ stage: 'capacity', contextSize: 90_112, outcome: 'ok' });
    expect(t.capacity).toEqual([{ kvType: 'bf16', measuredMax: 90_112, inferred: false, skipped: 'budget', bound: 'budget', failedAt: 120_832 }]);
  });

  it('int8: 241 664 said, spilled; between 128K and it down to 184K', async () => {
    const { t } = await search(ninferInput({ kvDtypes: ['int8'] }));
    expect(t.attempts.filter((a) => a.stage === 'capacity').map(brief)).toEqual([
      'capacity int8@262144 oom',
      'capacity int8@241664 spill decode-collapse',
      'capacity int8@32768 ok',
      'capacity int8@65536 ok',
      'capacity int8@131072 ok',
      'capacity int8@180224 ok',
      'capacity int8@204800 spill decode-collapse',
      'capacity int8@188416 ok',
    ]);
    expect(t.capacity[0]).toMatchObject({ measuredMax: 188_416, bound: 'found', failedAt: 204_800 });
  });

  it('vLLM: the capacity it reports loads, so it is the limit; nothing is tried between it and the next context up', async () => {
    const vprof: FakeProfile = { ...TUNE_PROFILE, memory: { totalMiB: 24_000, weightsMiB: 15_000, kvMiBPer1k: 100, computeMiBPer512: 0 } };
    const { t } = await tune({ space: vllmSpace({ budget: 'fast', params: P(), utilizations: [0.9] }), modelContext: 131_072 }, new Lab({ profile: vprof, flavor: 'vllm' }));
    // 5 064 MiB of KV at 100 MiB per 1K: 51 855 tokens (auto), twice that with fp8.
    expect(capacityOf(t)).toEqual({ auto: 51_200, fp8: 103_424 });
    expect(t.capacity.map((c) => [c.kvType, c.bound, c.failedAt])).toEqual([
      ['auto', 'found', 65_536],
      ['fp8', 'found', 131_072],
    ]);
    const plain = t.attempts.filter((a) => a.stage === 'capacity' && !a.params.extraArgs.length);
    expect(plain.some((a) => a.kvType === 'auto' && a.contextSize > 51_200 && a.contextSize < 65_536)).toBe(false);
    expect(plain.some((a) => a.kvType === 'fp8' && a.contextSize > 103_424 && a.contextSize < 131_072)).toBe(false);
  });

  it('a context that loaded but does not hold its deepest prompts: the descent steps down, that one is the limit found', async () => {
    // rk8v4 at 256K: fine for its 1K check, in shared memory as soon as 64K are in the context.
    const card = new NinferCard({ deepSpill: (n, depth) => n.kvDtype === 'rk8v4' && n.kvCapacity === FULL && depth >= 65_536 });
    const { t } = await search(ninferInput({ kvDtypes: ['rk8v4'] }), card);
    expect(t.attempts.filter((a) => a.stage === 'variant').map(brief).slice(0, 2)).toEqual(['variant rk8v4@262144 spill decode-collapse', 'variant rk8v4@131072 ok']);
    expect(t.capacity[0]).toMatchObject({ measuredMax: 131_072, bound: 'found', failedAt: FULL });
  });
});

describe('the descent’s last value, swept on its own launch', () => {
  it('rk8v4: 4 draft tokens win last (int8 vs fp8 has nothing for it): the sweep runs on that launch, the context full first', async () => {
    const { t, card } = await search(ninferInput({ kvDtypes: ['rk8v4'] }));
    // No launch of its own for the sweep (the run's attempt 14, ~90 s).
    expect(t.attempts.map(brief)).toEqual([
      'reference rk8v4@4096 ok',
      'capacity rk8v4@262144 ok',
      'variant rk8v4@262144 ok',
      'variant rk8v4@262144 ok',
      'variant rk8v4@262144 ok',
      'variant rk8v4@262144 ok',
    ]);
    expect(t.attempts.slice(2).map((a) => [a.variant?.spec, a.variant?.draft, a.screen])).toEqual([
      ['mtp', 3, 'lost'],
      ['off', 3, 'lost'],
      ['mtp', 2, 'lost'],
      ['mtp', 4, 'kept'],
    ]);
    const rec = t.combinations[t.recommended!]!;
    expect(t.attempts[5]!.combination).toBe(t.recommended);
    expect(rec.variant).toMatchObject({ kv: 'rk8v4', spec: 'mtp', draft: 4 });
    // On that launch: the 1K check, the screening (1K, 64K), then the deepest prompt before 4K and 16K.
    expect(card.measured.filter((m) => m.launch === 6).map((m) => m.depth)).toEqual([1024, 1024, 65_536, DEEPEST, 4096, 16_384]);
    expect(rec.sweep.map((p) => p.promptTokens)).toEqual([1024, 4096, 16_384, 65_536, DEEPEST]);
    expect(fullContextPoint(rec)?.promptTokens).toBe(DEEPEST);
    // The record of the launch stays shallow to deep: its last point is the context full.
    expect(t.attempts[5]!.points.map((p) => p.promptTokens)).toEqual([1024, 1024, 4096, 16_384, 65_536, DEEPEST]);
  });

  it('goal "Più utenti": users 1 … N on the winner’s launch too', async () => {
    const { t } = await search(ninferInput({ kvDtypes: ['rk8v4'], users: 2, goal: 'multi', multi: { users: 2, perUserContext: 65_536, turns: 3 } }));
    expect(t.attempts.map((a) => a.stage)).toEqual(['reference', 'capacity', 'variant', 'variant', 'variant']);
    const rec = t.combinations[t.recommended!]!;
    expect(rec.variant).toMatchObject({ spec: 'mtp', draft: 4, np: 2 });
    expect(rec.concurrency!.map((p) => p.level)).toEqual([1, 2]);
    expect(t.attempts.at(-1)!.combination).toBe(t.recommended);
  });
});

describe('a capacity known without a launch', () => {
  it('nvfp4: deduced from rk8v4 at 256K ("Dedotto"), then its screenings loaded there: launched after all', async () => {
    const { t, updates } = await search(ninferInput({ kvDtypes: ['rk8v4', 'nvfp4'] }));
    const deduced = updates.find((u) => u.attempts.some((a) => a.stage === 'variant'))!;
    expect(deduced.capacity.find((c) => c.kvType === 'nvfp4')).toMatchObject({ measuredMax: FULL, inferred: true, skipped: 'no-gain' });
    expect(t.attempts.some((a) => a.kvType === 'nvfp4' && a.contextSize === FULL && a.outcome === 'ok')).toBe(true);
    expect(t.capacity.find((c) => c.kvType === 'nvfp4')).toEqual({ kvType: 'nvfp4', measuredMax: FULL, inferred: false, skipped: 'no-gain', bound: 'model' });
    // Never launched (the cap came first): still deduced.
    const cut = await search(ninferInput({ kvDtypes: ['rk8v4', 'nvfp4'] }), new NinferCard(), 6);
    expect(cut.t.attempts.some((a) => a.kvType === 'nvfp4')).toBe(false);
    expect(cut.t.capacity.find((c) => c.kvType === 'nvfp4')).toMatchObject({ inferred: true });
  });
});

describe('time: the limit set again with the first start measured', () => {
  it('starts of 90 s where 15 s were expected: after the reference the limit grows, once; the estimate stays', async () => {
    const input = ninferInput({ kvDtypes: ['rk8v4', 'nvfp4'] });
    const planned = tuneTime(input);
    const { t, updates } = await search(input);
    expect(t.expectedLoadSeconds).toBe(15);
    expect(t.attempts.every((a) => a.loadMs === 90_000)).toBe(true);
    expect(t.estimateSeconds).toBe(Math.round(planned.estimateMs / 1000));
    expect(t.limitSeconds).toBeGreaterThan(Math.round(planned.limitMs / 1000));
    // Before the reference loaded: the first limit; from its 1K check on: the new one, never moved again.
    expect(updates[0]!.limitSeconds).toBe(Math.round(planned.limitMs / 1000));
    expect(updates.filter((u) => u.attempts.length > 0).every((u) => u.limitSeconds === t.limitSeconds)).toBe(true);
    expect(t.stoppedBy).toBeUndefined();
    // With the first limit the run of the user stopped short (time over, nvfp4 cut).
    const before = await search({ ...input, limitMs: planned.limitMs });
    expect(before.t.stoppedBy).toBe('budget');
    expect(before.t.limitSeconds).toBe(Math.round(planned.limitMs / 1000));
  });

  it('starts quicker than expected: the limit stays the first one (never lowered)', async () => {
    const input = ninferInput({ kvDtypes: ['rk8v4', 'nvfp4'] });
    const { t } = await search(input, new NinferCard({ loadMs: 2000 }));
    expect(t.limitSeconds).toBe(Math.round(tuneTime(input).limitMs / 1000));
    expect(t.stoppedBy).toBeUndefined();
  });

  it('goal "Più utenti": the same after its first launch', async () => {
    const input = ninferInput({ kvDtypes: ['rk8v4'], users: 2, goal: 'multi', multi: { users: 2, perUserContext: 65_536, turns: 3 }, spillPossible: false });
    const planned = tuneTime(input);
    const { t, updates } = await search(input, new NinferCard({ loadMs: 200_000 }));
    expect(t.limitSeconds).toBeGreaterThan(Math.round(planned.limitMs / 1000));
    // No reference on Linux: the capacity launch is the first that loads (its users still to screen then).
    expect(updates.filter((u) => u.attempts.length > 0).every((u) => u.limitSeconds === t.limitSeconds)).toBe(true);
    expect(t.stoppedBy).toBeUndefined();
    expect((await search({ ...input, limitMs: planned.limitMs }, new NinferCard({ loadMs: 200_000 }))).t.stoppedBy).toBe('budget');
  });

  it('"Ricontrollo rapido": the first re-check’s own measurements count too; both fit', async () => {
    const before = (await search(ninferInput({ kvDtypes: ['rk8v4', 'nvfp4'] }))).t;
    const checks = [
      { role: 'recommended' as const, combination: before.combinations[before.recommended!]! },
      { role: 'runner-up' as const, combination: before.combinations[runnerUp(before)!]! },
    ];
    const recheck = { previousRunId: 'PREV', previousCreatedAt: '2026-10-14T09:54:04.000Z', checks };
    const input = ninferInput({ kvDtypes: ['rk8v4', 'nvfp4'], budget: 'recheck', recheck });
    const planned = tuneTime(input);
    const card = new NinferCard({ loadMs: 200_000 });
    const { t } = await search(input, card);
    expect(t.limitSeconds).toBeGreaterThan(Math.round(planned.limitMs / 1000));
    // Set after the first 1K check: the time so far + that re-check's short sweep + the second re-check (start, check, sweep), × 1.5.
    const s = speedsAt(card.started[0]!.ninfer!, 1024);
    const req = (depth: number, out = 128) => requestMsAt(depth, out, { depth: 1024, prefillTps: s.prefill, decodeTps: s.decode });
    // The deepest prompt takes more than a minute: made once.
    const shortSweep = req(DEEPEST) + 2 * req(1024) + 2 * req(131_072);
    const rebased = card.measured[0]!.at + shortSweep + 200_000 + req(1024, 32) + shortSweep;
    expect(t.limitSeconds).toBe(Math.round(Math.round(rebased * TIME_MARGIN) / 1000));
    expect(t.stoppedBy).toBeUndefined();
    expect(t.recheck!.checks.map((c) => c.fits)).toEqual([true, true]);
    // 1K, the middle and the deepest prompt: the deepest first.
    expect(card.measured.filter((m) => m.launch === 1).map((m) => m.depth)).toEqual([1024, DEEPEST, 1024, 131_072]);
    expect(t.combinations.every((c) => fullContextPoint(c) !== undefined)).toBe(true);
    // The first limit allowed one re-check only.
    expect((await search({ ...input, limitMs: planned.limitMs }, new NinferCard({ loadMs: 200_000 }))).t.recheck!.checks.map((c) => c.fits)).toEqual([true, false]);
  });
});

describe('time: the context full first when the limit is near', () => {
  /** The winner's launch of rk8v4 (the 6th): when its screening ended, the deepest prompt is next. */
  async function sweepStart(): Promise<number> {
    const { card } = await search(ninferInput({ kvDtypes: ['rk8v4'] }));
    return card.measured.find((m) => m.launch === 6 && m.depth === 65_536)!.at;
  }
  /** What the deepest prompt takes on that launch (the tuner predicts it exactly here). */
  const deepestMs = (): number => {
    const s = speedsAt({ kvDtype: 'rk8v4', spec: 'mtp', draftTokens: 4 } as Ninfer, 1024);
    return requestMsAt(DEEPEST, 128, { depth: 1024, prefillTps: s.prefill, decodeTps: s.decode });
  };

  it('time for the deepest prompt but not for the rest: the combination has the context full, "misurata in parte"', async () => {
    const t0 = await sweepStart();
    const limitMs = Math.round(t0 + deepestMs() + 500 - TIME_GRACE_MS);
    const { t, card } = await search(ninferInput({ kvDtypes: ['rk8v4'], limitMs }));
    expect(t.stoppedBy).toBe('budget');
    expect(card.measured.filter((m) => m.launch === 6).map((m) => m.depth)).toEqual([1024, 1024, 65_536, DEEPEST]);
    // 4K would have ended past the limit: left (and 16K after it, not even tried).
    expect(t.attempts[5]!.skipped).toEqual([{ depth: 4096, predictedMs: expect.any(Number) }]);
    const rec = t.combinations[t.recommended!]!;
    expect(rec).toMatchObject({ partial: 'budget', maxContext: FULL });
    expect(fullContextPoint(rec)?.promptTokens).toBe(DEEPEST);
  });

  it('no time for the deepest prompt: the shorter depths are still measured', async () => {
    const t0 = await sweepStart();
    const limitMs = Math.round(t0 + deepestMs() - 500 - TIME_GRACE_MS);
    const { t, card } = await search(ninferInput({ kvDtypes: ['rk8v4'], limitMs }));
    expect(card.measured.filter((m) => m.launch === 6).map((m) => m.depth)).toEqual([1024, 1024, 65_536, 4096, 16_384]);
    expect(t.attempts[5]!.skipped).toEqual([{ depth: DEEPEST, predictedMs: expect.any(Number) }]);
    const rec = t.combinations[t.recommended!]!;
    expect(rec.sweep.map((p) => p.promptTokens)).toEqual([1024, 4096, 16_384, 65_536]);
    expect(fullContextPoint(rec)).toBeUndefined();
    expect(TIME_MARGIN).toBe(1.5);
  });
});
