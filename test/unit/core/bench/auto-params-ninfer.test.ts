import { describe, expect, it } from 'vitest';
import { launchParamsSchema } from '../../../../src/contract/engines';
import type { Scenario } from '../../../../src/contract/results';
import { autoLaunchParams, buildScenario, limitsFor } from '../../../../src/core/bench/scenarios';

const P = (over: object = {}) => launchParamsSchema.parse(over);

describe('NInfer launch settings for a scenario', () => {
  it('one lane per user (at most 8), the longest request as --max-context, a pool for everyone at once', () => {
    const p = autoLaunchParams('ninfer-wsl', buildScenario('standard'), P(), 262_144);
    expect(p).toMatchObject({ parallel: 4, contextSize: 5120, ninfer: { prefixReuse: false, thinking: false } });
    expect(p.ninfer?.kvCapacity).toBeUndefined();
    // 12 users at once of 4K each: 8 lanes, a pool for 8 × 4K.
    const crowd: Scenario = { profile: 'custom', seed: 1, steps: [{ kind: 'concurrency', levels: [12], promptTokens: 4000, outputTokens: 64 }] } as Scenario;
    expect(autoLaunchParams('ninfer-native', crowd, P(), 262_144)).toMatchObject({ parallel: 8, contextSize: 4096, ninfer: { kvCapacity: 8 * 4096 } });
    // Long conversations: prefix reuse on (that is what they measure), the pool for the sessions.
    const team: Scenario = { profile: 'custom', seed: 1, steps: [{ kind: 'sessions', depth: 8000, levels: [1, 2], turns: 2, followupTokens: 64, outputTokens: 16 }] } as Scenario;
    const s = autoLaunchParams('ninfer-wsl', team, P({ ninfer: { kvDtype: 'int8' } }), 262_144);
    expect(s).toMatchObject({ parallel: 2, ninfer: { kvDtype: 'int8', prefixReuse: true, thinking: false } });
    expect(s.ninfer?.kvCapacity).toBeGreaterThan(s.contextSize as number);
    // The user's own settings stay; a scenario of loads only keeps NInfer's default context.
    expect(autoLaunchParams('ninfer-wsl', buildScenario('standard'), P({ contextSize: 16_384, parallel: 1, ninfer: { kvCapacity: 'auto' } }))).toMatchObject({ contextSize: 16_384, parallel: 1, ninfer: { kvCapacity: 'auto' } });
    const loads: Scenario = { profile: 'custom', seed: 1, steps: [{ kind: 'load', cache: 'warm', reps: 1 }] } as Scenario;
    expect(autoLaunchParams('ninfer-wsl', loads, P())).toEqual({ ...P(), ninfer: { prefixReuse: false, thinking: false } });
  });

  it('limits a scenario to what the launch holds: per request, and everyone in the pool', () => {
    expect(limitsFor('ninfer-wsl', P())).toEqual({ engineKind: 'ninfer-wsl', contextSize: 8192, maxConcurrency: 1 });
    expect(limitsFor('ninfer-wsl', P({ contextSize: 65_536, parallel: 2, ninfer: { kvCapacity: 131_072 } }))).toEqual({ engineKind: 'ninfer-wsl', contextSize: 65_536, maxConcurrency: 2 });
    expect(limitsFor('ninfer-native', P({ contextSize: 65_536, parallel: 12 }))).toEqual({ engineKind: 'ninfer-native', contextSize: 8192, maxConcurrency: 8 });
    expect(limitsFor('ninfer-native', P({ contextSize: 65_536, parallel: 2, ninfer: { kvCapacity: 'auto' } }))).toEqual({ engineKind: 'ninfer-native', contextSize: 32_768, maxConcurrency: 2 });
  });
});
