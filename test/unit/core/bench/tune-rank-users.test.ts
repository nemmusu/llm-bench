/** Ranking rules of phase 3: screening at three depths, users at once, runner-up, what moved. */
import { describe, expect, it } from 'vitest';
import type { Tuning } from '../../../../src/contract/results';
import {
  compareUsers,
  levelPoint,
  movedLevels,
  movedPoints,
  perUserStat,
  recommendedCombination,
  recommendedForUsers,
  runnerUp,
  screenBetter,
  TIE_TAIL,
  tiedValues,
  usersNoise,
  usersOf,
  usersWithoutErrors,
} from '../../../../src/core/bench/tune-rank';
import { combo, concurrencyPoint, point, sessionsPoint, stat } from './tune-helpers';

const tuning = (over: Partial<Tuning>): Tuning => ({ budget: 'fast', maxLaunches: 24, dimensions: [], capacity: [], depths: [], attempts: [], combinations: [], fastestByDepth: [], ...over });

describe('screening at three depths', () => {
  it('the deepest point decides, then the middle, then 1K; a full tie keeps the current value', () => {
    const best = [point(1024, 100), point(16384, 80), point(40816, 60)];
    expect(screenBetter([point(1024, 50), point(16384, 50), point(40816, 70)], best)).toBe(true);
    expect(screenBetter([point(1024, 200), point(16384, 200), point(40816, 50)], best)).toBe(false);
    // Tied at the deepest point: the middle one (prompt reading dominates there too).
    expect(screenBetter([point(1024, 50), point(16384, 80, { prefill: 9000 }), point(40816, 60)], best)).toBe(true);
    expect(screenBetter([point(1024, 120), point(16384, 80), point(40816, 60)], best)).toBe(true);
    expect(screenBetter(best, best)).toBe(false);
  });
});

describe('users at once', () => {
  it('ties: plain numbers within max(floor, 2 × noise); the noise of a per-user median is its spread over √users', () => {
    expect(tiedValues(100, 101.9)).toBe(true);
    expect(tiedValues(100, 103)).toBe(false);
    expect(tiedValues(100, 109, 0, TIE_TAIL)).toBe(true);
    expect(tiedValues(0, 0)).toBe(true);
    expect(usersNoise({ ...stat(100, 0.2), n: 4 })).toBeCloseTo(0.1, 9);
    expect(usersNoise({ ...stat(100, 0.2), n: 1 })).toBe(0.2);
    // Old points had only the p50.
    expect(perUserStat(concurrencyPoint(4, 50, { noStat: true }))).toMatchObject({ n: 1, median: 50, cv: 0 });
    expect(perUserStat({ ...concurrencyPoint(4, 50), perRequestDecodeTps: { ...stat(50), n: 0 } })).toMatchObject({ n: 1, median: 50 });
  });

  it('fewer failed requests → per-user generation → total → TTFT p95 → later messages → tie', () => {
    const m = (perUser: number, o: Parameters<typeof concurrencyPoint>[2] = {}, later?: number) => ({ point: concurrencyPoint(4, perUser, o), ...(later !== undefined ? { sessions: sessionsPoint(4, 7000, later) } : {}) });
    expect(compareUsers(m(10, { errors: 0 }), m(100, { errors: 1 }))).toBeGreaterThan(0);
    expect(compareUsers(m(110), m(100))).toBeGreaterThan(0);
    expect(compareUsers(m(100, { aggregate: 500 }), m(100, { aggregate: 400 }))).toBeGreaterThan(0);
    expect(compareUsers(m(100, { ttftP95: 500 }), m(100, { ttftP95: 1000 }))).toBeGreaterThan(0);
    expect(compareUsers(m(100, { ttftP95: 950 }), m(100, { ttftP95: 1000 }))).toBe(0);
    expect(compareUsers(m(100, {}, 40), m(100, {}, 100))).toBeGreaterThan(0);
    expect(compareUsers(m(100, {}, 100), m(100))).toBe(0);
    expect(compareUsers(m(100), m(100))).toBe(0);
    // A wide spread between users makes small differences noise.
    expect(compareUsers(m(108, { cv: 0.2 }), m(100, { cv: 0.2 }))).toBe(0);
    const empty = { point: concurrencyPoint(4, 100), sessions: { ...sessionsPoint(4, 7000, 50), laterTurns: { ...sessionsPoint(4, 7000, 50).laterTurns!, ttftMs: { ...stat(50), n: 0 } } } };
    expect(compareUsers(empty, m(100, {}, 100))).toBe(0);
  });

  it('the recommendation for N users, the users a tuning measured, the most users without a failed request', () => {
    const at4 = (perUser: number, kv: 'q8_0' | 'q4_0' | 'f16' = 'q8_0', errors = 0) =>
      combo(kv, 32768, [], { concurrency: [concurrencyPoint(1, perUser * 1.5), concurrencyPoint(4, perUser, { errors })], sessions: [sessionsPoint(4, 7000, 100)] });
    const combos = [at4(100, 'q4_0'), at4(100, 'q8_0'), at4(120, 'q4_0', 1), { ...at4(500), outcome: 'oom' as const }, combo('f16', 4096, [point(1024, 900)])];
    // Fewer errors first; then the more precise KV on a tie.
    expect(recommendedForUsers(combos, 4)).toBe(1);
    expect(recommendedForUsers(combos, 4, 1)).toBe(0);
    expect(recommendedForUsers(combos, 3)).toBeUndefined();
    expect(recommendedForUsers([at4(100, 'q8_0'), at4(100, 'q4_0')], 4)).toBe(0);
    // No conversation measured at that level: the first one stands for it.
    expect(recommendedForUsers([combo('q8_0', 1, [], { concurrency: [concurrencyPoint(4, 10)] })], 4)).toBe(0);
    expect(levelPoint(undefined, 4)).toBeUndefined();
    expect(usersOf({})).toBeUndefined();
    expect(usersOf({ multi: { users: 16, perUserContext: 8192, promptTokens: 8048, outputTokens: 128, turns: 3, fittingUsers: 8 } })).toBe(8);
    expect(usersOf({ multi: { users: 4, perUserContext: 8192, promptTokens: 8048, outputTokens: 128, turns: 3 } })).toBe(4);
    expect(usersWithoutErrors([concurrencyPoint(2, 1), concurrencyPoint(1, 1), concurrencyPoint(3, 1, { errors: 1 }), concurrencyPoint(4, 1)])).toBe(2);
    expect(usersWithoutErrors([concurrencyPoint(4, 1)])).toBe(0);
    expect(usersWithoutErrors([])).toBe(0);
  });
});

describe('runner-up', () => {
  it('the best of the others by the run’s own rule; none without a recommendation', () => {
    const single = [combo('q4_0', 40960, [point(1024, 100), point(40816, 50)]), combo('q8_0', 32768, [point(1024, 120), point(32624, 70)]), combo('q4_0', 40960, [point(1024, 90), point(40816, 40)])];
    expect(recommendedCombination(single)).toBe(0);
    expect(runnerUp(tuning({ combinations: single, recommended: 0 }))).toBe(2);
    expect(runnerUp(tuning({ combinations: single }))).toBeUndefined();
    expect(recommendedCombination(single, 0)).toBe(2);
    expect(runnerUp(tuning({ combinations: [single[0]!], recommended: 0 }))).toBeUndefined();
    const users = [
      combo('q8_0', 32768, [], { concurrency: [concurrencyPoint(4, 100)] }),
      combo('q4_0', 32768, [], { concurrency: [concurrencyPoint(4, 60)] }),
    ];
    const multi = tuning({ goal: 'multi', multi: { users: 4, perUserContext: 8192, promptTokens: 8048, outputTokens: 128, turns: 3 }, combinations: users, recommended: 0 });
    expect(runnerUp(multi)).toBe(1);
  });
});

describe('what moved since the previous run', () => {
  it('depth by depth (nominal depths line up across contexts): decode, prefill, TTFT beyond noise', () => {
    const before = [point(1024, 100, { prefill: 5000, ttft: 200 }), point(32624, 50)];
    expect(movedPoints(before, [point(1024, 101, { prefill: 5000, ttft: 200 }), point(32700, 50)])).toEqual([]);
    expect(movedPoints(before, [point(1024, 80, { prefill: 9000, ttft: 120 }), point(16384, 10)])).toEqual([
      { at: 1024, metric: 'decode', before: 100, after: 80 },
      { at: 1024, metric: 'prefill', before: 5000, after: 9000 },
      { at: 1024, metric: 'ttft', before: 200, after: 120 },
    ]);
  });

  it('level by level: per-user generation, total, TTFT p95', () => {
    const before = [concurrencyPoint(1, 100), concurrencyPoint(4, 80)];
    expect(movedLevels(before, [concurrencyPoint(1, 100), concurrencyPoint(4, 81)])).toEqual([]);
    expect(movedLevels(before, [concurrencyPoint(2, 10), concurrencyPoint(4, 40, { ttftP95: 2000 })])).toEqual([
      { at: 4, metric: 'perUserDecode', before: 80, after: 40 },
      { at: 4, metric: 'aggregate', before: 320, after: 160 },
      { at: 4, metric: 'ttftP95', before: 1000, after: 2000 },
    ]);
  });
});
