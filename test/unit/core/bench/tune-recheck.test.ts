/**
 * "Ricontrollo rapido" against the deterministic machine of tune-lab.ts: the previous recommendation
 * and its runner-up loaded again, a short sweep, what moved, what no longer fits.
 */
import { describe, expect, it } from 'vitest';
import type { LaunchParams } from '../../../../src/contract/engines';
import type { TuneCombination, Tuning } from '../../../../src/contract/results';
import { recheckResult, usersMeasured } from '../../../../src/core/bench/tune-recheck';
import { runnerUp } from '../../../../src/core/bench/tune-rank';
import { llamaSpace } from '../../../../src/core/bench/tune-space';
import { BUDGETS, Tuner, type RecheckInput } from '../../../../src/core/bench/tuner';
import { MULTI_PROFILE } from '../../../fakes/fake-engine/profiles.mjs';
import type { FakeProfile } from '../../../fakes/fake-engine/server.mjs';
import { input, Lab, LINUX, P, tune } from './tune-lab';

function checksOf(t: Tuning): RecheckInput['checks'] {
  const second = runnerUp(t);
  return [
    { role: 'recommended', combination: t.combinations[t.recommended!]! },
    ...(second !== undefined ? [{ role: 'runner-up' as const, combination: t.combinations[second]! }] : []),
  ];
}

const recheckOf = (t: Tuning, over: Partial<RecheckInput> = {}): RecheckInput => ({
  previousRunId: 'PREV',
  previousCreatedAt: '2026-10-01T10:00:00.000Z',
  previousBuild: 'b10000',
  currentBuild: 'b10997',
  ...(t.multi ? { multi: t.multi } : {}),
  checks: checksOf(t),
  ...over,
});

describe('RecheckTuner: goal "Un utente, contesto massimo"', () => {
  it('the same machine: both load at their context, every number within noise, the recommendation stays', async () => {
    const before = (await tune()).t;
    const { t, phases } = await tune({ budget: 'recheck', recheck: recheckOf(before) });
    expect(t.budget).toBe('recheck');
    expect(t.attempts.map((a) => [a.stage, a.kvType, a.contextSize, a.outcome])).toEqual([
      ['recheck', 'q4_0', 40960, 'ok'],
      ['recheck', 'q8_0', 32768, 'ok'],
    ]);
    // The exact previous parameters; a short sweep: 1K, the middle, the deepest prompt.
    expect(t.attempts[0]!.params).toEqual(before.combinations[before.recommended!]!.params);
    expect(t.combinations[0]!.sweep.map((p) => p.promptTokens)).toEqual([1024, 16384, 40816]);
    expect(t.recheck).toMatchObject({ previousRunId: 'PREV', previousBuild: 'b10000', currentBuild: 'b10997', result: 'same', suggestFull: false });
    expect(t.recheck!.checks.map((c) => [c.role, c.fits, c.outcome, c.combination, c.moved])).toEqual([
      ['recommended', true, 'ok', 0, []],
      ['runner-up', true, 'ok', 1, []],
    ]);
    expect(t.recommended).toBe(0);
    expect(t.dimensions).toEqual([]);
    expect(t.capacity).toEqual([]);
    expect(t.goal).toBeUndefined();
    expect(phases).toEqual(['tune-capacity', 'context-sweep', 'context-sweep']);
  });

  it('slower generation: what moved, depth by depth; a full search is suggested and the recommendation kept', async () => {
    const before = (await tune()).t;
    const { t } = await tune({ budget: 'recheck', recheck: recheckOf(before) }, new Lab({ decode: () => 100 }));
    expect(t.recheck).toMatchObject({ result: 'changed', suggestFull: true });
    const moved = t.recheck!.checks[0]!.moved;
    expect(moved.filter((m) => m.metric === 'decode').map((m) => m.at)).toEqual([1024, 16384, 40960]);
    expect(moved[0]).toMatchObject({ metric: 'decode', after: 100 });
    expect(t.recommended).toBe(0);
  });

  it('no longer fits: said so, no recommendation; a runner-up that no longer fits is a change', async () => {
    const before = (await tune()).t;
    const small: FakeProfile = { ...LINUX, memory: { ...LINUX.memory!, totalMiB: 12_000 } };
    const gone = await tune({ budget: 'recheck', recheck: recheckOf(before) }, new Lab({ profile: small }));
    expect(gone.t.recheck).toMatchObject({ result: 'no-longer-fits', suggestFull: true });
    expect(gone.t.recheck!.checks.map((c) => [c.role, c.fits, c.outcome])).toEqual([
      ['recommended', false, 'oom'],
      ['runner-up', false, 'oom'],
    ]);
    expect(gone.t.recommended).toBeUndefined();
    expect(gone.t.combinations).toEqual([]);
    const runnerGone = await tune({ budget: 'recheck', recheck: recheckOf(before) }, new Lab({ fail: (p) => (p.kvCacheType === 'q8_0' ? { code: 'ENGINE_OOM', message: 'oom' } : undefined) }));
    expect(runnerGone.t.recheck).toMatchObject({ result: 'changed', suggestFull: true });
    expect(runnerGone.t.recommended).toBe(0);
  });

  it('incomplete: the recommendation failed for another reason, or the budget allowed no launch', async () => {
    const before = (await tune()).t;
    const crashed = await tune({ budget: 'recheck', recheck: recheckOf(before) }, new Lab({ fail: (p: LaunchParams) => (p.kvCacheType === 'q4_0' ? { code: 'ENGINE_EXITED', message: 'crash' } : undefined) }));
    expect(crashed.t.recheck).toMatchObject({ result: 'incomplete', suggestFull: true });
    const lab = new Lab();
    const tuner = new (await import('../../../../src/core/bench/tune-recheck')).RecheckTuner(input({ budget: 'recheck', recheck: recheckOf(before) }), { lab, now: lab.now });
    (tuner as unknown as { rules: object }).rules = { ...BUDGETS.recheck, maxLaunches: 0 };
    const none = await tuner.run();
    expect(none.recheck!.checks.map((c) => [c.role, c.fits, c.outcome])).toEqual([
      ['recommended', false, undefined],
      ['runner-up', false, undefined],
    ]);
    expect(none.recheck!.result).toBe('incomplete');
    expect(none.stoppedBy).toBe('launches');
  });

  it('a combination saved before phase 3 (no variant) and a run without a runner-up', async () => {
    const before = (await tune()).t;
    const { variant: _v, ...old } = before.combinations[before.recommended!]!;
    const { t } = await tune({ budget: 'recheck', recheck: recheckOf(before, { checks: [{ role: 'recommended', combination: old as TuneCombination }] }) });
    expect(t.attempts).toHaveLength(1);
    expect(t.attempts[0]!.variant).toEqual({ kv: 'q4_0' });
    expect(t.recheck!.result).toBe('same');
  });
});

describe('RecheckTuner: goal "Più utenti"', () => {
  const flags = new Set(['--kv-unified', '--no-kv-unified', '--cache-reuse']);
  const space = llamaSpace({ budget: 'fast', params: P(), users: 4, flags });
  const multi = { goal: 'multi' as const, multi: { users: 4, perUserContext: 8192, turns: 3 }, space };

  it('users 1…4 again with the same prompts; within noise; the goal and its question are kept', async () => {
    const before = (await tune(multi, new Lab({ profile: MULTI_PROFILE }))).t;
    const { t } = await tune({ ...multi, budget: 'recheck', recheck: recheckOf(before) }, new Lab({ profile: MULTI_PROFILE }));
    expect(t).toMatchObject({ goal: 'multi', multi: before.multi, recheck: { result: 'same' } });
    const rec = t.combinations[t.recommended!]!;
    expect(rec.concurrency!.map((p) => [p.level, p.promptTokens])).toEqual([
      [1, 8048],
      [2, 8048],
      [3, 8048],
      [4, 8048],
    ]);
    expect(rec).toMatchObject({ kvLayout: 'split', usersWithoutErrors: 4, sessions: [] });
    // Half the speed per user: it moved.
    const slower = await tune({ ...multi, budget: 'recheck', recheck: recheckOf(before) }, new Lab({ profile: MULTI_PROFILE, decode: () => 50 }));
    expect(slower.t.recheck!.result).toBe('changed');
    expect(slower.t.recheck!.checks[0]!.moved.map((m) => m.metric)).toEqual(expect.arrayContaining(['perUserDecode', 'aggregate']));
  });

  it('cache reuse is carried over; a combination without prompt lengths re-uses what the run asked', async () => {
    const before = (await tune(multi, new Lab({ profile: MULTI_PROFILE, laterTtft: (p) => (p.extraArgs.includes('--cache-reuse') ? 40 : 100) }))).t;
    expect(before.combinations[before.recommended!]!.cacheReuse).toBe(256);
    const { t } = await tune({ ...multi, budget: 'recheck', recheck: recheckOf(before) }, new Lab({ profile: MULTI_PROFILE }));
    expect(t.combinations[t.recommended!]!.cacheReuse).toBe(256);
    const rec = before.combinations[before.recommended!]!;
    const bare = { ...rec, concurrency: rec.concurrency!.map(({ promptTokens: _p, outputTokens: _o, ...p }) => p) };
    const r = await tune({ ...multi, budget: 'recheck', recheck: recheckOf(before, { checks: [{ role: 'recommended', combination: bare }] }) }, new Lab({ profile: MULTI_PROFILE }));
    expect(r.t.combinations[0]!.concurrency![0]!.promptTokens).toBe(8048);
    const noQuestion = await tune({ ...multi, budget: 'recheck', recheck: { ...recheckOf(before, { checks: [{ role: 'recommended', combination: bare }] }), multi: undefined } }, new Lab({ profile: MULTI_PROFILE }));
    expect(noQuestion.t.combinations[0]!.concurrency![0]!.promptTokens).toBe(32768);
    // Saved without a layout (an engine whose pool is always shared) and without builds.
    const { kvLayout: _l, cacheReuse: _c, ...plain } = rec;
    const { previousBuild: _p, currentBuild: _b, ...noBuilds } = recheckOf(before, { checks: [{ role: 'recommended', combination: plain }] });
    const r2 = await tune({ ...multi, budget: 'recheck', recheck: noBuilds }, new Lab({ profile: MULTI_PROFILE }));
    expect(r2.t.combinations[0]).not.toHaveProperty('kvLayout');
    expect(r2.t.recheck).not.toHaveProperty('previousBuild');
    expect(r2.t.recheck).not.toHaveProperty('currentBuild');
  });
});

describe('recheck helpers', () => {
  it('the overall result and the users a combination was measured with', () => {
    const c = (o: object) => ({ role: 'recommended' as const, previous: {} as TuneCombination, fits: true, outcome: 'ok' as const, moved: [], ...o });
    expect(recheckResult([])).toBe('incomplete');
    expect(recheckResult([c({ outcome: undefined, fits: false })])).toBe('incomplete');
    expect(recheckResult([c({ outcome: 'spill', fits: false })])).toBe('no-longer-fits');
    expect(recheckResult([c({}), { ...c({ outcome: 'spill', fits: false }), role: 'runner-up' }])).toBe('changed');
    expect(recheckResult([c({}), { ...c({ outcome: 'error', fits: false }), role: 'runner-up' }])).toBe('same');
    expect(recheckResult([c({ moved: [{ at: 1024, metric: 'decode', before: 1, after: 2 }] })])).toBe('changed');
    expect(usersMeasured({})).toBeUndefined();
    expect(usersMeasured({ concurrency: [] })).toBeUndefined();
    expect(Tuner).toBeDefined();
  });
});
