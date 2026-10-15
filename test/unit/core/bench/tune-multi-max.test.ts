/**
 * Goal 'multi' with the context per user "Massimo" against the deterministic machine of tune-lab.ts:
 * for each KV type the largest context every user can have with all N at once (the capacity search of
 * goal 'single', per user), then the fastest settings there with every user busy.
 */
import { describe, expect, it } from 'vitest';
import type { LaunchParams } from '../../../../src/contract/engines';
import type { Tuning } from '../../../../src/contract/results';
import { MULTI_REFERENCE_CONTEXT, MultiTuner, poolTooSmall } from '../../../../src/core/bench/tune-multi';
import { recommendedForUsers, runnerUp } from '../../../../src/core/bench/tune-rank';
import { llamaSpace, vllmSpace } from '../../../../src/core/bench/tune-space';
import { MULTI_PROFILE } from '../../../fakes/fake-engine/profiles.mjs';
import type { FakeProfile } from '../../../fakes/fake-engine/server.mjs';
import { capacityOf, input, Lab, optimistic, P, tune } from './tune-lab';

const FLAGS = new Set(['-ub', '--ubatch-size', '--kv-unified', '-kvu', '--no-kv-unified', '-no-kvu', '--cache-reuse']);
const largest = (users: number, o: { usersMode?: 'exact' } = {}) => ({
  goal: 'multi' as const,
  multi: { users, perUserContext: 'max' as const, turns: 3, ...o },
  space: llamaSpace({ budget: 'fast', params: P(), users, flags: FLAGS }),
});
const machine = (o: ConstructorParameters<typeof Lab>[0] = {}) => new Lab({ profile: MULTI_PROFILE, ...o });
/** Each combination's KV type and context per user. */
const perUser = (t: Tuning) => t.combinations.map((c) => [c.kvType, c.perUserContext]);

describe('MultiTuner "Massimo": llama.cpp (18 000 MiB, weights 6000, KV 600 MiB per 1K in f16)', () => {
  it('2 users: the largest context each per KV type (f16 8K, q8_0 16K, q4_0 32K), -c 2 × it, and the largest one recommended', async () => {
    const { t } = await tune(largest(2), machine());
    expect(t.multi).toEqual({ users: 2, perUserContext: 'max', outputTokens: 128, turns: 3 });
    expect(capacityOf(t)).toEqual({ f16: 8192, q8_0: 16384, q4_0: 32768 });
    // As goal 'single': the next context up did not fit, as close as the search goes.
    expect(t.capacity.map((c) => [c.kvType, c.bound, c.failedAt])).toEqual([
      ['f16', 'found', 16384],
      ['q8_0', 'found', 24576],
      ['q4_0', 'found', 40960],
    ]);
    // Every launch: 2 slots and the whole context of the 2 users.
    expect(t.attempts.every((a) => a.params.parallel === 2 && a.contextSize % 2 === 0)).toBe(true);
    expect(t.attempts.filter((a) => a.stage === 'capacity' && a.kvType === 'f16').map((a) => [a.contextSize, a.outcome])).toEqual([
      [2 * 40960, 'oom'],
      [2 * 8192, 'ok'],
      [2 * 16384, 'oom'],
    ]);
    expect(perUser(t)).toEqual(expect.arrayContaining([['f16', 8192], ['q8_0', 16384], ['q4_0', 32768]]));
    const rec = t.combinations[t.recommended!]!;
    expect(rec).toMatchObject({ kvType: 'q4_0', perUserContext: 32768, maxContext: 65536, params: { contextSize: 65536, parallel: 2 } });
    // Each user's prompt fills its own context (but the answer and the margin), users 1 and 2.
    expect(rec.concurrency!.map((p) => [p.level, p.promptTokens])).toEqual([
      [1, 32768 - 128 - 16],
      [2, 32768 - 128 - 16],
    ]);
    // The more precise caches hold less: the runner-up is the next largest context per user.
    expect(t.combinations[runnerUp(t)!]!.perUserContext).toBe(16384);
  });

  it('4 users: half as much each (f16 4K, q8_0 8K, q4_0 16K); "solo 4 utenti" measures only 4 at once', async () => {
    const { t } = await tune(largest(4), machine());
    expect(capacityOf(t)).toEqual({ f16: 4096, q8_0: 8192, q4_0: 16384 });
    expect(t.combinations[t.recommended!]).toMatchObject({ kvType: 'q4_0', perUserContext: 16384, params: { contextSize: 65536, parallel: 4 } });
    const exact = await tune(largest(4, { usersMode: 'exact' }), machine());
    expect(exact.t.multi).toMatchObject({ perUserContext: 'max', usersMode: 'exact' });
    expect(capacityOf(exact.t)).toEqual({ f16: 4096, q8_0: 8192, q4_0: 16384 });
    expect(exact.t.attempts.flatMap((a) => a.concurrency ?? []).every((p) => p.level === 4)).toBe(true);
    expect(exact.t.attempts.some((a) => a.stage === 'sweep')).toBe(false);
  });

  it('Windows: filling every user spills where the check only loaded them: the next context per user down is screened', async () => {
    // q4_0 with 2 × 32K loads, but filling both users moves memory to shared memory.
    const shared = (p: LaunchParams, requests: number) => (p.kvCacheType === 'q4_0' && p.contextSize === 65536 && requests > 1 ? 4000 : 0);
    const { t, lab } = await tune({ ...largest(2), spillPossible: true }, machine({ shared }));
    // The reference: 2 users of 1K each.
    expect(lab.started[0]).toMatchObject({ contextSize: 2 * MULTI_REFERENCE_CONTEXT, kvCacheType: 'f16' });
    expect(t.attempts.find((a) => a.stage === 'variant' && a.kvType === 'q4_0' && a.contextSize === 65536)).toMatchObject({ outcome: 'spill', spill: 'shared-memory' });
    expect(capacityOf(t)).toEqual({ f16: 8192, q8_0: 16384, q4_0: 16384 });
    expect(t.capacity.find((c) => c.kvType === 'q4_0')).toMatchObject({ bound: 'found', failedAt: 32768 });
    expect(perUser(t).filter(([kv]) => kv === 'q4_0').every(([, c]) => c === 16384)).toBe(true);
    // Two caches with 16K each: the one that serves the users best (q8_0: q4_0 generates slower here).
    expect(t.combinations[t.recommended!]).toMatchObject({ kvType: 'q8_0', perUserContext: 16384 });
  });

  it('a step down with nothing below: the KV type holds no users after all', async () => {
    // q4_0 of 2 × 4K… every screening of 2 users spills; the capacity checks load.
    const shared = (p: LaunchParams, requests: number) => (requests > 1 ? 4000 : 0);
    const { t } = await tune({ ...largest(2), modelContext: 4096, spillPossible: true }, machine({ shared }));
    expect(t.combinations).toEqual([]);
    expect(capacityOf(t)).toEqual({ f16: undefined, q8_0: undefined, q4_0: undefined });
  });

  it('not even 4K each holds the users: the most users with 4K each, measured instead', async () => {
    // 6 users of 4K need 14 400 MiB of f16 KV, 4 080 of q4_0: a card of 9 000 MiB holds 2 of them with q4_0.
    const small: FakeProfile = { ...MULTI_PROFILE, memory: { ...MULTI_PROFILE.memory!, totalMiB: 9000 } };
    const { t } = await tune({ ...largest(16), modelContext: 32768 }, machine({ profile: small }));
    expect(t.multi).toMatchObject({ users: 16, perUserContext: 'max', fittingUsers: expect.any(Number) });
    const n = t.multi!.fittingUsers!;
    expect(n).toBeGreaterThan(1);
    expect(n).toBeLessThan(16);
    // The capacity is said per user, with nothing to bound.
    expect(t.capacity.find((c) => c.kvType === 'q4_0')).toEqual({ kvType: 'q4_0', predictedMax: 32768, measuredMax: 4096, inferred: false });
    expect(t.combinations[t.recommended!]).toMatchObject({ kvType: 'q4_0', perUserContext: 4096, params: { contextSize: n * 4096, parallel: n } });
  });

  it('the plan: capacity launches first, each type at the context it is expected to reach; more users or a larger context take longer', () => {
    const lab = machine();
    const time = (o: Partial<Parameters<typeof input>[0]>) => new MultiTuner(input(o), { lab, now: lab.now }).time().estimateMs;
    const max = time(largest(2));
    expect(max).toBeGreaterThan(time({ ...largest(2), multi: { users: 2, perUserContext: 4096, turns: 3 } }));
    expect(time(largest(4))).toBeGreaterThan(max);
    // The estimate says f16 holds nothing: it is not counted (and not searched).
    const predict = (p: LaunchParams) => ({ ...optimistic(), needMiB: p.kvCacheType === 'f16' ? 1e9 : 1000 });
    expect(time({ ...largest(2), predict })).toBeLessThan(max);
    expect(time({ ...largest(2), multi: { users: 2, perUserContext: 'max', turns: 3, usersMode: 'exact' } })).toBeLessThan(max);
  });
});

describe('MultiTuner "Massimo": vLLM, 2 users', () => {
  const vprof: FakeProfile = { ...MULTI_PROFILE, memory: { totalMiB: 24_000, weightsMiB: 15_000, kvMiBPer1k: 200, computeMiBPer512: 0 } };
  it('the KV pool vLLM reports, shared by the users, is the next context per user: auto 12K, fp8 25K each', async () => {
    const space = vllmSpace({ budget: 'fast', params: P(), users: 2, utilizations: [0.9] });
    const { t } = await tune({ goal: 'multi', multi: { users: 2, perUserContext: 'max', turns: 3 }, space, modelContext: 131072 }, new Lab({ profile: vprof, flavor: 'vllm' }));
    // auto: 0.9 × 24000 − 15000 − 1024 − 512 = 5064 MiB = 25 927 tokens, 12 963 each; fp8 twice that.
    expect(t.attempts[0]).toMatchObject({ kvType: 'auto', contextSize: 131072, outcome: 'oom', error: { params: { estimatedMaxModelLen: 25927 } } });
    expect(t.attempts[1]).toMatchObject({ kvType: 'auto', stage: 'capacity', contextSize: 12288, outcome: 'ok', kvTokens: 25927 });
    expect(capacityOf(t)).toEqual({ auto: 12288, fp8: 25600 });
    expect(t.capacity.map((c) => c.bound)).toEqual(['found', 'found']);
    const rec = t.combinations[t.recommended!]!;
    expect(rec).toMatchObject({ kvType: 'fp8', perUserContext: 25600, maxContext: 25600, params: { maxModelLen: 25600, parallel: 2 } });
  });

  it('a launch that starts but whose pool cannot hold every user does not hold them', async () => {
    // The pool reported when it starts: 25 927 tokens; 2 users of 16K need 32 768.
    const space = vllmSpace({ budget: 'fast', params: P(), users: 2, utilizations: [0.9] });
    const { t } = await tune({ goal: 'multi', multi: { users: 2, perUserContext: 'max', turns: 3 }, space, modelContext: 16384 }, new Lab({ profile: vprof, flavor: 'vllm' }));
    expect(t.attempts[0]).toMatchObject({ kvType: 'auto', contextSize: 16384, outcome: 'oom', kvTokens: 25927, error: poolTooSmall(25927, 32768) });
    expect(capacityOf(t)).toMatchObject({ auto: 12288, fp8: 16384 });
  });
});

describe('recommendedForUsers with the largest context per user first', () => {
  it('a larger context per user wins over a faster smaller one; the same context goes to the faster', async () => {
    const { t } = await tune(largest(2), machine());
    const combos = t.combinations;
    const wide = combos.findIndex((c) => c.kvType === 'q4_0');
    expect(recommendedForUsers(combos, 2, undefined, true)).toBe(wide);
    // Without it: the one that serves the users best (q4_0 generates slower here).
    expect(combos[recommendedForUsers(combos, 2)!]!.kvType).not.toBe('q4_0');
  });
});
