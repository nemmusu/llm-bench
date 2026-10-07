import { describe, expect, it } from 'vitest';
import { launchParamsSchema } from '../../../../src/contract/engines';
import { scenarioSchema, type Scenario } from '../../../../src/contract/results';
import {
  buildScenario,
  DEFAULT_EXPECTATIONS,
  estimateSeconds,
  fitScenario,
  isLlamaCpp,
  limitsFor,
  requestSeconds,
  stepSeconds,
} from '../../../../src/core/bench/scenarios';

const params = (p: Record<string, unknown> = {}) => launchParamsSchema.parse(p);

describe('buildScenario', () => {
  it('quick: one warm load, 512×128, 1+3 reps', () => {
    const s = buildScenario('quick');
    expect(scenarioSchema.parse(s)).toEqual(s);
    expect(s).toEqual({
      profile: 'quick',
      seed: 42,
      steps: [
        { kind: 'load', cache: 'warm', reps: 1 },
        { kind: 'latency', promptTokens: [512], outputTokens: 128, warmup: 1, reps: 3 },
      ],
    });
  });
  it('standard and full follow the methodology', () => {
    const std = buildScenario('standard', 7);
    expect(std.seed).toBe(7);
    expect(std.steps.map((s) => s.kind)).toEqual(['load', 'load', 'latency', 'concurrency']);
    expect(std.steps[2]).toMatchObject({ promptTokens: [512, 4096], outputTokens: 256, warmup: 1, reps: 5 });
    expect(std.steps[3]).toMatchObject({ levels: [1, 2, 3, 4], promptTokens: 512, outputTokens: 128, requestsPerWorker: 4 });
    const full = buildScenario('full');
    expect(full.steps[0]).toEqual({ kind: 'load', cache: 'cold', reps: 3 });
    expect(full.steps[2]).toMatchObject({ promptTokens: [128, 512, 2048, 8192, 32768], outputTokens: 512, warmup: 2, reps: 10 });
    expect(full.steps[3]).toMatchObject({ levels: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16] });
    expect(full.steps[4]).toEqual({ kind: 'llama-bench', pp: 512, tg: 128, reps: 5 });
  });
  it('returns independent copies', () => {
    const a = buildScenario('quick');
    (a.steps[0] as { reps: number }).reps = 99;
    expect(buildScenario('quick').steps[0]).toMatchObject({ reps: 1 });
  });
});

describe('limitsFor', () => {
  it('llama.cpp: per-slot context and slot-limited concurrency', () => {
    expect(isLlamaCpp('llamacpp-docker')).toBe(true);
    expect(isLlamaCpp('vllm-docker')).toBe(false);
    expect(limitsFor('llamacpp-native', params({ contextSize: 8192, parallel: 4 }))).toEqual({
      engineKind: 'llamacpp-native',
      contextSize: 2048,
      maxConcurrency: 4,
    });
    expect(limitsFor('llamacpp-native', params(), 32768)).toEqual({ engineKind: 'llamacpp-native', contextSize: 32768, maxConcurrency: 1 });
    expect(limitsFor('llamacpp-docker', params())).toEqual({ engineKind: 'llamacpp-docker', maxConcurrency: 1 });
  });
  it('vLLM / external: max model len, no concurrency cap', () => {
    expect(limitsFor('vllm-docker', params({ maxModelLen: 4096 }))).toEqual({ engineKind: 'vllm-docker', contextSize: 4096 });
    expect(limitsFor('external', params())).toEqual({ engineKind: 'external' });
  });
});

describe('fitScenario', () => {
  it('drops prompts that do not fit and concurrency levels above the slots', () => {
    const { scenario, warnings } = fitScenario(buildScenario('full'), { engineKind: 'llamacpp-native', contextSize: 4096, maxConcurrency: 4 });
    expect(scenario.steps.find((s) => s.kind === 'latency')).toMatchObject({ promptTokens: [128, 512, 2048] });
    expect(scenario.steps.find((s) => s.kind === 'concurrency')).toMatchObject({ levels: [1, 2, 3, 4] });
    expect(scenario.steps.some((s) => s.kind === 'llama-bench')).toBe(true);
    expect(warnings).toContainEqual({ code: 'prompt_too_long', params: { promptTokens: 8192, contextSize: 4096 } });
    expect(warnings).toContainEqual({ code: 'concurrency_level_skipped', params: { level: 16, parallel: 4 } });
  });
  it('runs prompt lengths and users smallest first, each once', () => {
    const custom = {
      profile: 'custom' as const,
      seed: 1,
      steps: [
        { kind: 'latency' as const, promptTokens: [4096, 512, 512], outputTokens: 16, warmup: 0, reps: 1 },
        { kind: 'concurrency' as const, levels: [4, 1, 4, 2], promptTokens: 64, outputTokens: 16, requestsPerWorker: 1 },
      ],
    };
    const { scenario } = fitScenario(custom, { engineKind: 'vllm-docker' });
    expect(scenario.steps[0]).toMatchObject({ promptTokens: [512, 4096] });
    expect(scenario.steps[1]).toMatchObject({ levels: [1, 2, 4] });
  });
  it('removes whole steps when nothing fits, llama-bench outside native, loads on external', () => {
    const tiny = fitScenario(buildScenario('standard'), { engineKind: 'vllm-docker', contextSize: 300 });
    expect(tiny.scenario.steps.map((s) => s.kind)).toEqual(['load', 'load']);
    const noLevels = fitScenario(buildScenario('standard'), { engineKind: 'llamacpp-docker', maxConcurrency: 0 });
    expect(noLevels.scenario.steps.some((s) => s.kind === 'concurrency')).toBe(false);
    const ext = fitScenario(buildScenario('full'), { engineKind: 'external' });
    expect(ext.scenario.steps.map((s) => s.kind)).toEqual(['latency', 'concurrency']);
    expect(ext.warnings.map((w) => w.code)).toEqual(['load_not_measurable', 'load_not_measurable', 'llama_bench_unsupported']);
  });
  it('keeps everything when limits are unknown', () => {
    const s: Scenario = buildScenario('full');
    expect(fitScenario(s, { engineKind: 'llamacpp-native' }).scenario).toEqual(s);
  });
});

describe('estimates', () => {
  it('per-step heuristics', () => {
    const e = DEFAULT_EXPECTATIONS;
    expect(requestSeconds(2000, 60, e)).toBeCloseTo(2.2);
    expect(stepSeconds({ kind: 'load', cache: 'cold', reps: 2 }, e)).toBe(64);
    expect(stepSeconds({ kind: 'load', cache: 'warm', reps: 1 }, e)).toBe(12);
    expect(stepSeconds({ kind: 'latency', promptTokens: [2000], outputTokens: 60, warmup: 1, reps: 1 }, e)).toBeCloseTo(4.4);
    expect(stepSeconds({ kind: 'concurrency', levels: [1], promptTokens: 2000, outputTokens: 60, requestsPerWorker: 2 }, e)).toBeCloseTo(4);
    expect(stepSeconds({ kind: 'llama-bench', pp: 2000, tg: 60, reps: 1 }, e)).toBeCloseTo(13);
  });
  it('profiles get longer; past speeds shorten them; bad values are ignored', () => {
    const quick = estimateSeconds(buildScenario('quick'));
    const standard = estimateSeconds(buildScenario('standard'));
    const full = estimateSeconds(buildScenario('full'));
    expect(quick).toBeLessThan(standard);
    expect(standard).toBeLessThan(full);
    expect(estimateSeconds(buildScenario('standard'), { decodeTps: 200, prefillTps: 10000, warmLoadSec: 2, coldLoadSec: 5 })).toBeLessThan(standard);
    expect(estimateSeconds(buildScenario('quick'), { decodeTps: Number.NaN, prefillTps: -1, warmLoadSec: undefined })).toBe(quick);
    expect(Number.isInteger(full)).toBe(true);
  });
});
