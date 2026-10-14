/**
 * Goal 'multi' ("Più utenti") against the deterministic machine of tune-lab.ts: which KV types hold N
 * users of C tokens, the descent with every user busy, users 1…N in order, the conversations, the
 * fallback to fewer users, vLLM's pool, the budget.
 */
import { describe, expect, it } from 'vitest';
import type { LaunchParams } from '../../../../src/contract/engines';
import { MULTI_REFERENCE_CONTEXT, MultiTuner, poolTooSmall } from '../../../../src/core/bench/tune-multi';
import { llamaSpace, vllmSpace } from '../../../../src/core/bench/tune-space';
import { BUDGETS } from '../../../../src/core/bench/tuner';
import { MULTI_PROFILE } from '../../../fakes/fake-engine/profiles.mjs';
import type { FakeProfile } from '../../../fakes/fake-engine/server.mjs';
import { input, Lab, P, tune } from './tune-lab';

const FLAGS = new Set(['-ub', '--ubatch-size', '--kv-unified', '-kvu', '--no-kv-unified', '-no-kvu', '--cache-reuse']);
const multiSpace = (users = 4, flags: ReadonlySet<string> = FLAGS) => llamaSpace({ budget: 'fast', params: P(), users, flags });
const multi = (users = 4, perUserContext = 8192) => ({ goal: 'multi' as const, multi: { users, perUserContext, turns: 3 }, space: multiSpace(users) });
const machine = (o: ConstructorParameters<typeof Lab>[0] = {}) => new Lab({ profile: MULTI_PROFILE, ...o });

describe('MultiTuner: llama.cpp, 4 users × 8K', () => {
  it('holds the users with q8_0 (q4_0 known), splits the pool, keeps the faster ubatch, measures users 1…4 and the conversations', async () => {
    const { t, phases } = await tune(multi(), machine());
    expect(t).toMatchObject({ goal: 'multi', multi: { users: 4, perUserContext: 8192, promptTokens: 8048, outputTokens: 128, turns: 3 } });
    // q4_0 was known to hold them (q8_0 does), then its own screenings loaded there: not "deduced" any more.
    expect(t.capacity).toEqual([
      { kvType: 'f16', predictedMax: 32768, inferred: false },
      { kvType: 'q8_0', predictedMax: 32768, measuredMax: 32768, inferred: false },
      { kvType: 'q4_0', predictedMax: 32768, measuredMax: 32768, inferred: false, skipped: 'no-gain' },
    ]);
    expect(t.attempts[0]).toMatchObject({ stage: 'capacity', kvType: 'f16', contextSize: 32768, outcome: 'oom' });
    // Every launch: 4 slots and the whole context of the 4 users; screening = level 4 + the conversations.
    expect(t.attempts.every((a) => a.params.parallel === 4 && a.params.contextSize === 32768)).toBe(true);
    const screen = t.attempts[1]!;
    expect(screen.concurrency!.map((p) => [p.level, p.promptTokens])).toEqual([[4, 8048]]);
    expect(screen.sessions!.map((s) => [s.sessions, s.depth])).toEqual([[4, 8192 - (3 * 128 + 2 * 256 + 16)]]);
    expect(t.dimensions.map((d) => d.key)).toEqual(['kv', 'layout', 'reuse', 'fa', 'ub']);
    const rec = t.combinations[t.recommended!]!;
    expect(rec).toMatchObject({ kvType: 'q8_0', kvLayout: 'split', usersWithoutErrors: 4, maxContext: 32768, sweep: [], params: { ubatchSize: 2048, extraArgs: ['--no-kv-unified'] } });
    expect(rec.cacheReuse).toBeUndefined();
    expect(rec.concurrency!.map((p) => p.level)).toEqual([1, 2, 3, 4]);
    expect(rec.sessions).toHaveLength(1);
    expect(rec.variant).toMatchObject({ kv: 'q8_0', layout: 'split', reuse: 0, ub: 2048, np: 4 });
    // The shared pool and the reuse lost (reuse: a tie keeps it off); q4_0 is slower per user.
    const q4 = t.combinations.find((c) => c.kvType === 'q4_0')!;
    expect(q4.concurrency!.at(-1)!.perRequestDecodeTpsP50).toBeLessThan(rec.concurrency!.at(-1)!.perRequestDecodeTpsP50);
    expect(t.attempts.filter((a) => a.variant?.reuse === 256).every((a) => a.screen === 'lost')).toBe(true);
    expect(t.fastestByDepth).toEqual([]);
    expect(phases).toEqual(expect.arrayContaining(['tune-capacity', 'tune-variants', 'concurrency']));
  });

  it('"solo 4 utenti insieme": the same search and recommendation, every combination measured with 4 users only, no launch of its own', async () => {
    const ramp = await tune(multi(), machine());
    const exact = await tune({ ...multi(), multi: { users: 4, perUserContext: 8192, turns: 3, usersMode: 'exact' as const } }, machine());
    const t = exact.t;
    expect(t.multi).toMatchObject({ users: 4, usersMode: 'exact' });
    expect(ramp.t.multi?.usersMode).toBeUndefined();
    // Never fewer users than asked, and no launch only to measure them.
    expect(t.attempts.flatMap((a) => a.concurrency ?? []).every((p) => p.level === 4)).toBe(true);
    expect(t.attempts.some((a) => a.stage === 'sweep')).toBe(false);
    expect(t.attempts.length).toBeLessThanOrEqual(ramp.t.attempts.length);
    expect(exact.phases).not.toContain('concurrency');
    // The ranking is the same: the same combination recommended, each with its 4 users and conversations.
    const rec = t.combinations[t.recommended!]!;
    const was = ramp.t.combinations[ramp.t.recommended!]!;
    expect(rec.variant).toEqual(was.variant);
    expect(rec.concurrency!.map((p) => p.level)).toEqual([4]);
    expect(rec.sessions).toHaveLength(1);
    expect(t.combinations.map((c) => c.kvType)).toEqual(ramp.t.combinations.map((c) => c.kvType));
    for (const c of t.combinations) expect(t.attempts[t.attempts.findIndex((a) => a.combination === t.combinations.indexOf(c))]!.concurrency!.at(-1)).toEqual(c.concurrency![0]);
    // The forecast never counts the levels 1 … 4.
    expect(t.estimateSeconds!).toBeLessThan(ramp.t.estimateSeconds!);
  });

  it('"solo N utenti": when N do not fit, the most that do are measured (and said), still at once only', async () => {
    const { t } = await tune({ ...multi(16), multi: { users: 16, perUserContext: 8192, turns: 3, usersMode: 'exact' as const }, space: multiSpace(16) }, machine());
    expect(t.multi).toMatchObject({ users: 16, fittingUsers: 8, usersMode: 'exact' });
    expect(t.combinations[t.recommended!]!.concurrency!.map((p) => p.level)).toEqual([8]);
  });

  it('keeps --cache-reuse when the later messages come back faster with it, and measures the conversations of a dedicated launch', async () => {
    const lab = machine({ laterTtft: (p) => (p.extraArgs.includes('--cache-reuse') ? 40 : 100) });
    const { t } = await tune({ ...multi(), space: llamaSpace({ budget: 'fast', params: P(), users: 4, flags: new Set(['--cache-reuse']) }) }, lab);
    // A build without --kv-unified: the pool is split, nothing to choose.
    expect(t.dimensions.map((d) => d.key)).toEqual(['kv', 'reuse', 'fa', 'ub']);
    const rec = t.combinations[t.recommended!]!;
    expect(rec).toMatchObject({ kvLayout: 'split', cacheReuse: 256, params: { extraArgs: ['--cache-reuse', '256'] } });
    expect(rec.sessions![0]!.laterTurns!.ttftMs.median).toBe(40);
  });

  it('the shared pool when the build cannot split it; failed requests rank last', async () => {
    const shared = llamaSpace({ budget: 'fast', params: P(), users: 4, flags: new Set(['--kv-unified']) });
    const errors = (p: LaunchParams, level: number) => (p.ubatchSize === 2048 && level === 4 ? 1 : 0);
    const { t } = await tune({ ...multi(), space: shared }, machine({ usersErrors: errors }));
    const rec = t.combinations[t.recommended!]!;
    expect(rec).toMatchObject({ kvLayout: 'unified', params: { ubatchSize: 512 } });
    expect(rec.params.extraArgs).toEqual([]);
  });

  it('nothing holds 16 users × 8K: the most users the most compact KV holds (binary search) are measured instead', async () => {
    const { t } = await tune({ ...multi(16), space: multiSpace(16) }, machine());
    // q4_0: 8 × 8K = 64K fits (17 100 MiB), 9 × 8K does not.
    expect(t.multi).toMatchObject({ users: 16, fittingUsers: 8 });
    expect(t.attempts.filter((a) => a.stage === 'capacity' && a.kvType === 'q4_0').map((a) => [a.variant!.np, a.outcome])).toEqual([
      [16, 'oom'],
      [8, 'ok'],
      [12, 'oom'],
      [10, 'oom'],
      [9, 'oom'],
    ]);
    const rec = t.combinations[t.recommended!]!;
    expect(rec).toMatchObject({ kvType: 'q4_0', maxContext: 65536, usersWithoutErrors: 8 });
    expect(rec.concurrency!.map((p) => p.level)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // Not even one user: nothing measured.
    const tiny: FakeProfile = { ...MULTI_PROFILE, memory: { ...MULTI_PROFILE.memory!, totalMiB: 5000 } };
    const none = await tune({ ...multi(2), space: multiSpace(2) }, machine({ profile: tiny }));
    expect(none.t.combinations).toEqual([]);
    expect(none.t.recommended).toBeUndefined();
    expect(none.t.multi?.fittingUsers).toBeUndefined();
  });

  it('prunes what the estimate rules out, a reference launch where a spill is possible, a spill while measuring', async () => {
    const pruned = await tune({ ...multi(), predict: (p) => ({ ...(input().predict!(p) as NonNullable<ReturnType<NonNullable<ReturnType<typeof input>['predict']>>>), needMiB: p.kvCacheType === 'q4_0' ? 1 : 1e9 }) }, machine());
    expect(pruned.t.capacity.map((c) => [c.kvType, c.skipped, c.measuredMax])).toEqual([
      ['f16', 'estimate', undefined],
      ['q8_0', 'estimate', undefined],
      ['q4_0', undefined, 32768],
    ]);
    // Windows: a reference with a small context per user first; q8_0 spills while its users are served.
    const shared = (p: LaunchParams, requests: number) => (p.kvCacheType === 'q8_0' && requests > 1 ? 3000 : 10);
    const spill = await tune({ ...multi(), spillPossible: true }, machine({ shared }));
    expect(spill.t.attempts[0]).toMatchObject({ stage: 'reference', contextSize: 4 * MULTI_REFERENCE_CONTEXT, outcome: 'ok' });
    expect(spill.t.attempts.find((a) => a.kvType === 'q8_0' && a.stage === 'capacity')).toMatchObject({ outcome: 'spill', spill: 'shared-memory' });
    expect(spill.t.combinations[spill.t.recommended!]!.kvType).toBe('q4_0');
  });

  it('a short budget: middle levels are skipped (users N always measured), and the search stops where it is', async () => {
    const slow = await tune({ ...multi(), limitMs: 5 * 60_000 }, machine({ requestMs: 15_000 }));
    const rec = slow.t.combinations[slow.t.recommended!]!;
    expect(rec.concurrency!.at(-1)!.level).toBe(4);
    expect(rec.concurrency!.length).toBeLessThan(4);
    expect(rec.usersWithoutErrors).toBe(0);
    expect(slow.t.stoppedBy).toBe('budget');
    // Launch caps at every stage.
    for (const cap of [1, 2, 3, 4, 6]) {
      const lab = machine();
      const tuner = new MultiTuner(input(multi()), { lab, now: lab.now });
      (tuner as unknown as { rules: object }).rules = { ...BUDGETS.fast, maxLaunches: cap };
      const r = await tuner.run();
      expect(r.attempts.length).toBeLessThanOrEqual(cap);
      expect(r.stoppedBy).toBe('launches');
    }
    const lab16 = machine();
    const few = new MultiTuner(input({ ...multi(16), space: multiSpace(16) }), { lab: lab16, now: lab16.now });
    (few as unknown as { rules: object }).rules = { ...BUDGETS.fast, maxLaunches: 5 };
    const r16 = await few.run();
    expect(r16.multi?.fittingUsers).toBe(8);
  });

  it('every user at once that would end past the time limit is not started (recorded); the forecast counts the screenings', async () => {
    // f16 runs out of memory (200 s to fail), q8_0 loads in 200 s more: its users would end past 5 min.
    const { t } = await tune({ ...multi(), limitMs: 300_000 }, machine({ loadMs: 200_000 }));
    expect(t.attempts.find((a) => a.skipped)).toMatchObject({ stage: 'capacity', outcome: 'ok', skipped: [{ depth: 8048, predictedMs: expect.any(Number) }] });
    expect(t.stoppedBy).toBe('budget');
    expect(t.combinations).toEqual([]);
    // Planned: a screening per value of every dimension, then users 1 … 4; more with a reference launch (Windows).
    const plain = new MultiTuner(input(multi()), { lab: machine(), now: () => 0 }).time().estimateMs;
    expect(new MultiTuner(input({ ...multi(), spillPossible: true }), { lab: machine(), now: () => 0 }).time().estimateMs).toBeGreaterThan(plain);
    expect(t.capacity.every((c) => c.bound === undefined)).toBe(true);
  });

  it('a context per user too small for the conversations: users at once only', async () => {
    const { t } = await tune({ ...multi(4, 800), modelContext: undefined }, machine());
    const rec = t.combinations[t.recommended!]!;
    expect(rec.sessions).toEqual([]);
    expect(rec.concurrency!.map((p) => [p.level, p.promptTokens])).toEqual([
      [1, 656],
      [2, 656],
      [3, 656],
      [4, 656],
    ]);
    expect(t.attempts.every((a) => a.sessions === undefined)).toBe(true);
  });

  it('a type known to hold the users that fails when screened is given up; the biggest ubatch only where it fits', async () => {
    const crash = machine({ fail: (p) => (p.kvCacheType === 'q4_0' ? { code: 'ENGINE_EXITED', message: 'crash' } : undefined) });
    const { t } = await tune(multi(), crash);
    expect(t.capacity.find((c) => c.kvType === 'q4_0')?.measuredMax).toBeUndefined();
    expect(t.combinations.every((c) => c.kvType === 'q8_0')).toBe(true);
    const thorough = llamaSpace({ budget: 'thorough', params: P(), users: 4, flags: FLAGS });
    const predict = (p: LaunchParams) => ({ ...input().predict!(p)!, needMiB: 1000 + (p.ubatchSize === 4096 ? 50_000 : 0) });
    const big = await tune({ ...multi(), budget: 'thorough', space: thorough, predict }, machine());
    expect(big.t.dimensions.find((d) => d.key === 'ub')!.values).toContain(4096);
    expect(big.t.attempts.some((a) => a.params.ubatchSize === 4096)).toBe(false);
  });

  it('conversations only when the context per user holds them', () => {
    const lab = machine();
    const t = new MultiTuner(input({ ...multi(4, 800), modelContext: undefined }), { lab, now: lab.now });
    expect(t.sessionsStep(4)).toBeUndefined();
    const fits = new MultiTuner(input({ ...multi(4, 8192), modelContext: 4096 }), { lab, now: lab.now });
    // The context per user never exceeds the model's trained context.
    expect(fits.sessionsStep(2)).toMatchObject({ depth: 4096 - (3 * 128 + 2 * 256 + 16), levels: [2], turns: 3 });
  });
});

describe('MultiTuner: vLLM, 4 users × 8K', () => {
  const vprof: FakeProfile = { ...MULTI_PROFILE, memory: { totalMiB: 24_000, weightsMiB: 15_000, kvMiBPer1k: 200, computeMiBPer512: 0 } };
  it('a KV pool that cannot hold every user does not fit; fp8 does', async () => {
    const space = vllmSpace({ budget: 'fast', params: P(), users: 4, utilizations: [0.9], flags: new Set(['--enable-prompt-tokens-details']) });
    const { t } = await tune({ goal: 'multi', multi: { users: 4, perUserContext: 8192, turns: 3 }, space, modelContext: 131072 }, new Lab({ profile: vprof, flavor: 'vllm' }));
    // auto: 0.9 × 24000 − 15000 − 1024 − 512 = 5064 MiB = 25 927 tokens < 4 × 8192.
    expect(t.attempts[0]).toMatchObject({ kvType: 'auto', outcome: 'oom', kvTokens: 25927, error: poolTooSmall(25927, 32768) });
    const rec = t.combinations[t.recommended!]!;
    expect(rec).toMatchObject({ kvType: 'fp8', kvLayout: 'unified', maxContext: 8192, params: { maxModelLen: 8192, parallel: 4, gpuMemoryUtilization: 0.9, extraArgs: ['--enable-prompt-tokens-details'] } });
    expect(rec.concurrency!.map((p) => p.level)).toEqual([1, 2, 3, 4]);
  });

  it('more batched tokens take KV pool from the users: that variant does not fit', async () => {
    // Activations of 150 MiB per 512 batched tokens: 8192 leave fp8 2664 MiB, less than 4 × 8K needs.
    const heavy: FakeProfile = { ...vprof, memory: { ...vprof.memory!, computeMiBPer512: 150 } };
    const space = vllmSpace({ budget: 'fast', params: P(), users: 4, utilizations: [0.9] });
    const { t } = await tune({ goal: 'multi', multi: { users: 4, perUserContext: 8192, turns: 3 }, space, modelContext: 131072 }, new Lab({ profile: heavy, flavor: 'vllm' }));
    expect(t.attempts.find((a) => a.kvType === 'fp8' && a.params.batchSize === 8192)).toMatchObject({ outcome: 'oom', error: { params: { reason: 'kv-cache', needTokens: 32768 } } });
    expect(t.combinations[t.recommended!]).toMatchObject({ kvType: 'fp8', params: { batchSize: 2048 } });
  });
});

describe('MultiTuner: a search the run ends', () => {
  it('cancelled while the first KV type is checked: none was tried with the users (the reference is not one), nothing "misurata in parte"', async () => {
    // Windows: the reference (4 users × 1K) loads, then the run is cancelled as f16 starts with 4 × 8K.
    const lab = machine({ fail: (_p, n) => (n === 2 ? { code: 'CANCELLED', message: 'Run cancelled' } : undefined) });
    const tuner = new MultiTuner(input({ ...multi(), spillPossible: true }), { lab, now: lab.now });
    await expect(tuner.run()).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(lab.started[0]).toMatchObject({ contextSize: 4 * MULTI_REFERENCE_CONTEXT });
    const t = tuner.interrupted('cancelled');
    expect(t.stoppedBy).toBe('cancelled');
    expect(t.capacity.map((c) => [c.kvType, c.measuredMax, c.bound, c.skipped])).toEqual([
      ['f16', undefined, undefined, 'cancelled'],
      ['q8_0', undefined, undefined, 'cancelled'],
      ['q4_0', undefined, undefined, 'cancelled'],
    ]);
    expect(t.combinations).toEqual([]);
  });
});
