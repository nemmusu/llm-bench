import { describe, expect, it } from 'vitest';
import { launchParamsSchema } from '../../../../src/contract/engines';
import { autoLaunchParams, buildScenario, limitsFor } from '../../../../src/core/bench/scenarios';

const empty = launchParamsSchema.parse({});

describe('autoLaunchParams', () => {
  it('sizes llama.cpp for the longest prompt and one slot per concurrent user (unified KV)', () => {
    // standard: prompts up to 4096 + 256 out; concurrency up to 4 × (512 + 128).
    const p = autoLaunchParams('llamacpp-native', buildScenario('standard'), empty, 40960);
    expect(p.parallel).toBe(4);
    expect(p.contextSize).toBe(5120); // 4096 + 256 + 16 → rounded to 1024
    const quick = autoLaunchParams('llamacpp-docker', buildScenario('quick'), empty, 40960);
    expect(quick.parallel).toBeUndefined();
    expect(quick.contextSize).toBe(1024);
  });

  it('multiplies per-slot context when the KV cache is split across slots', () => {
    const p = autoLaunchParams('llamacpp-native', buildScenario('standard'), empty, 40960, { kvUnified: false });
    expect(p.contextSize).toBe(5120 * 4);
  });

  it('never exceeds the model native context, and keeps what the user set', () => {
    const small = autoLaunchParams('llamacpp-native', buildScenario('standard'), empty, 2048);
    expect(small.contextSize).toBe(2048);
    const user = autoLaunchParams('llamacpp-native', buildScenario('standard'), { ...empty, contextSize: 3000, parallel: 2 }, 40960);
    expect(user).toMatchObject({ contextSize: 3000, parallel: 2 });
    const noModelCtx = autoLaunchParams('llamacpp-native', buildScenario('quick'), empty);
    expect(noModelCtx.contextSize).toBe(1024);
  });

  it('leaves the context alone when the scenario has no requests', () => {
    const loadOnly = { profile: 'custom' as const, seed: 1, steps: [{ kind: 'load' as const, cache: 'warm' as const, reps: 1 }] };
    expect(autoLaunchParams('llamacpp-native', loadOnly, empty, 4096)).toEqual(empty);
    expect(autoLaunchParams('vllm-docker', loadOnly, empty, 4096)).toEqual(empty);
  });

  it('sets vLLM max-model-len and max-num-seqs', () => {
    const p = autoLaunchParams('vllm-docker', buildScenario('standard'), empty, 32768);
    expect(p).toMatchObject({ maxModelLen: 5120, parallel: 4 });
    const q = autoLaunchParams('vllm-native', buildScenario('quick'), { ...empty, maxModelLen: 2048 }, 32768);
    expect(q.maxModelLen).toBe(2048);
    expect(q.parallel).toBeUndefined();
  });

  it('does not touch external endpoints', () => {
    expect(autoLaunchParams('external', buildScenario('standard'), empty, 32768)).toEqual(empty);
  });
});

describe('limitsFor with a unified KV cache', () => {
  it('gives every request the whole context', () => {
    expect(limitsFor('llamacpp-native', { ...empty, contextSize: 8192, parallel: 4 }, undefined, { kvUnified: true })).toEqual({
      engineKind: 'llamacpp-native',
      contextSize: 8192,
      maxConcurrency: 4,
      sharedPool: true,
    });
    expect(limitsFor('llamacpp-native', { ...empty, contextSize: 8192, parallel: 4 })).toMatchObject({ contextSize: 2048 });
    expect(limitsFor('llamacpp-native', empty)).toEqual({ engineKind: 'llamacpp-native', maxConcurrency: 1 });
  });
});
