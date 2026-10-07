import { describe, expect, it } from 'vitest';
import { launchParamsSchema } from '../../../../src/contract/engines';
import type { Scenario, SessionsStep } from '../../../../src/contract/results';
import {
  autoLaunchParams,
  buildScenario,
  DEFAULT_EXPECTATIONS,
  estimateSeconds,
  fitScenario,
  limitsFor,
  MIN_SESSION_DEPTH,
  sessionExtras,
  stepSeconds,
  VLLM_PROMPT_DETAILS_FLAG,
} from '../../../../src/core/bench/scenarios';

const empty = launchParamsSchema.parse({});
const step = (over: Partial<SessionsStep> = {}): SessionsStep => ({ kind: 'sessions', depth: 8000, levels: [2, 1], turns: 3, followupTokens: 256, outputTokens: 256, ...over });
const only = (s: SessionsStep): Scenario => ({ profile: 'custom', seed: 1, steps: [s] });

describe('long conversations: launch parameters', () => {
  it('extras: every answer and follow-up of the conversation, plus the margin', () => {
    expect(sessionExtras({ turns: 3, outputTokens: 256, followupTokens: 256 })).toBe(3 * 256 + 2 * 256 + 16);
  });

  it('llama.cpp: one slot per conversation; a set depth sizes the context (shared pool or per slot)', () => {
    const perConversation = 8000 + sessionExtras(step());
    const unified = autoLaunchParams('llamacpp-native', only(step()), empty, 131072);
    expect(unified).toMatchObject({ parallel: 2, contextSize: Math.ceil((perConversation * 2) / 1024) * 1024 });
    const split = autoLaunchParams('llamacpp-docker', only(step()), empty, 131072, { kvUnified: false });
    expect(split).toMatchObject({ parallel: 2, contextSize: Math.ceil(perConversation / 1024) * 1024 * 2 });
    // Depth 0 takes the launched context: only the slots change.
    expect(autoLaunchParams('llamacpp-native', only(step({ depth: 0 })), empty)).toEqual({ ...empty, parallel: 2 });
    // The user's own context and slots win.
    expect(autoLaunchParams('llamacpp-native', only(step()), { ...empty, contextSize: 4096, parallel: 3 })).toEqual({ ...empty, contextSize: 4096, parallel: 3 });
  });

  it('vLLM: max-model-len holds one conversation, max-num-seqs the conversations, and cached tokens are reported', () => {
    const p = autoLaunchParams('vllm-docker', only(step()), empty, 131072);
    expect(p).toMatchObject({ maxModelLen: Math.ceil((8000 + sessionExtras(step())) / 1024) * 1024, parallel: 2, extraArgs: [VLLM_PROMPT_DETAILS_FLAG] });
    // Never twice, and not for scenarios without long conversations.
    expect(autoLaunchParams('vllm-native', only(step({ depth: 0, levels: [1] })), { ...empty, extraArgs: [VLLM_PROMPT_DETAILS_FLAG] }).extraArgs).toEqual([VLLM_PROMPT_DETAILS_FLAG]);
    expect(autoLaunchParams('vllm-native', buildScenario('standard'), empty).extraArgs).toEqual([]);
    // Completo: the flag is in the exact command.
    expect(autoLaunchParams('vllm-docker', buildScenario('full'), empty).extraArgs).toEqual([VLLM_PROMPT_DETAILS_FLAG]);
    expect(autoLaunchParams('external', only(step()), empty)).toEqual(empty);
  });
});

describe('long conversations: fitting the step to the launch', () => {
  it('levels ascending, within the slots; depth reduced to what fits, with a warning', () => {
    const { scenario, warnings } = fitScenario(only(step({ levels: [4, 2, 1, 2] })), { engineKind: 'llamacpp-native', contextSize: 6000, maxConcurrency: 2 });
    const s = scenario.steps[0] as SessionsStep;
    expect(s.levels).toEqual([1, 2]);
    expect(s.depth).toBe(6000 - sessionExtras(s));
    expect(warnings).toEqual([
      { code: 'concurrency_level_skipped', params: { level: 4, parallel: 2 } },
      { code: 'sessions_depth_reduced', params: { requested: 8000, depth: s.depth, contextSize: 6000 } },
    ]);
  });

  it('a unified llama.cpp pool is shared by the conversations at once; vLLM gives each the whole length', () => {
    const shared = fitScenario(only(step({ depth: 0 })), limitsFor('llamacpp-native', { ...empty, contextSize: 32768, parallel: 2 }, undefined, { kvUnified: true }));
    expect((shared.scenario.steps[0] as SessionsStep).depth).toBe(16384 - sessionExtras(step()));
    const vllm = fitScenario(only(step({ depth: 0, maxDepth: 4096 })), limitsFor('vllm-docker', { ...empty, maxModelLen: 32768 }));
    expect((vllm.scenario.steps[0] as SessionsStep).depth).toBe(4096);
    expect(vllm.warnings).toEqual([]);
  });

  it('unknown context: a set depth is kept, depth 0 cannot be resolved', () => {
    expect(fitScenario(only(step()), { engineKind: 'external' }).scenario.steps).toEqual([{ ...step(), levels: [1, 2] }]);
    const auto = fitScenario(only(step({ depth: 0 })), { engineKind: 'external' });
    expect(auto.scenario.steps).toEqual([]);
    expect(auto.warnings).toEqual([{ code: 'sessions_depth_unknown' }]);
  });

  it('nothing left: no level within the slots, or a context too small for a long conversation', () => {
    expect(fitScenario(only(step({ levels: [2] })), { engineKind: 'llamacpp-native', contextSize: 8192, maxConcurrency: 1 }).scenario.steps).toEqual([]);
    const tiny = fitScenario(only(step({ depth: 0 })), { engineKind: 'vllm-native', contextSize: sessionExtras(step()) + MIN_SESSION_DEPTH - 1 });
    expect(tiny.scenario.steps).toEqual([]);
    expect(tiny.warnings[0]).toMatchObject({ code: 'prompt_too_long', params: { promptTokens: MIN_SESSION_DEPTH - 1 } });
  });
});

describe('long conversations: duration', () => {
  it('first messages read one after the other, later ones only read the new text; within the budget', () => {
    const e = DEFAULT_EXPECTATIONS;
    const s = step({ levels: [1, 2] });
    const level = (n: number) => {
      const write = (256 / e.decodeTps) * (1 + 0.15 * (n - 1)) + 0.2;
      return (n * 8000) / e.prefillTps + write + 2 * ((n * 512) / e.prefillTps + write);
    };
    expect(stepSeconds(s, e)).toBeCloseTo(level(1) + level(2), 9);
    expect(stepSeconds({ ...s, maxSeconds: 5 }, e)).toBe(5);
    expect(estimateSeconds(only(s))).toBe(Math.round(20 + level(1) + level(2)));
  });
});
