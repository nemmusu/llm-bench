import type { EngineKind, LaunchParams } from '../../contract/engines';
import type { Profile, Scenario, Step } from '../../contract/results';

export type BuiltinProfile = Exclude<Profile, 'custom'>;
export const DEFAULT_SEED = 42;
/** Tokens kept free in the context besides prompt + output (BOS, server-side extras). */
export const CONTEXT_MARGIN = 16;

const PROFILES: Record<BuiltinProfile, Step[]> = {
  // ~2 min: one warm load and a small latency sweep.
  quick: [
    { kind: 'load', cache: 'warm', reps: 1 },
    { kind: 'latency', promptTokens: [512], outputTokens: 128, warmup: 1, reps: 3 },
  ],
  // ~6 min: the profile the score is defined on.
  standard: [
    { kind: 'load', cache: 'cold', reps: 1 },
    { kind: 'load', cache: 'warm', reps: 3 },
    { kind: 'latency', promptTokens: [512, 4096], outputTokens: 256, warmup: 1, reps: 5 },
    { kind: 'concurrency', levels: [1, 4], promptTokens: 512, outputTokens: 128, requestsPerWorker: 4 },
  ],
  full: [
    { kind: 'load', cache: 'cold', reps: 3 },
    { kind: 'load', cache: 'warm', reps: 3 },
    { kind: 'latency', promptTokens: [128, 512, 2048, 8192, 32768], outputTokens: 512, warmup: 2, reps: 10 },
    { kind: 'concurrency', levels: [1, 2, 4, 8, 16], promptTokens: 512, outputTokens: 128, requestsPerWorker: 4 },
    { kind: 'llama-bench', pp: 512, tg: 128, reps: 5 },
  ],
};

export function buildScenario(profile: BuiltinProfile, seed = DEFAULT_SEED): Scenario {
  return { profile, seed, steps: structuredClone(PROFILES[profile]) };
}

export function isLlamaCpp(kind: EngineKind): boolean {
  return kind === 'llamacpp-native' || kind === 'llamacpp-docker';
}

export interface ScenarioLimits {
  engineKind: EngineKind;
  /** Context available to ONE request, in tokens; undefined = unknown (nothing is dropped for length). */
  contextSize?: number;
  /** Concurrent requests the server accepts (llama.cpp slots); undefined = no limit known. */
  maxConcurrency?: number;
}

/**
 * Limits implied by the launch parameters. llama.cpp splits its context across `-np` slots
 * (unless the KV cache is unified, which we cannot know from the flags alone), so the per-request
 * context is taken conservatively as ctx / parallel; its concurrency is capped by the slots.
 */
export function limitsFor(kind: EngineKind, params: LaunchParams, modelContext?: number): ScenarioLimits {
  const ctx = params.contextSize ?? params.maxModelLen ?? modelContext;
  if (isLlamaCpp(kind)) {
    const parallel = params.parallel ?? 1;
    return { engineKind: kind, ...(ctx ? { contextSize: Math.floor(ctx / parallel) } : {}), maxConcurrency: parallel };
  }
  return { engineKind: kind, ...(ctx ? { contextSize: ctx } : {}) };
}

/** Planning warning (code + params), localized by the renderer. */
export interface ScenarioWarning {
  code: string;
  params?: Record<string, unknown>;
}

const fits = (prompt: number, output: number, ctx: number | undefined): boolean =>
  ctx === undefined || prompt + output + CONTEXT_MARGIN <= ctx;

/**
 * Removes what the engine configuration cannot run: prompt lengths that do not fit the context,
 * concurrency levels above the server's slots, llama-bench outside llama.cpp native, and load
 * measurements on external endpoints (already running: nothing to load). Each removal is reported.
 */
export function fitScenario(scenario: Scenario, limits: ScenarioLimits): { scenario: Scenario; warnings: ScenarioWarning[] } {
  const warnings: ScenarioWarning[] = [];
  const steps: Step[] = [];
  const ctx = limits.contextSize;
  for (const step of scenario.steps) {
    switch (step.kind) {
      case 'load':
        if (limits.engineKind === 'external') warnings.push({ code: 'load_not_measurable' });
        else steps.push(step);
        break;
      case 'latency': {
        const kept = step.promptTokens.filter((p) => fits(p, step.outputTokens, ctx));
        for (const p of step.promptTokens) {
          if (!kept.includes(p)) warnings.push({ code: 'prompt_too_long', params: { promptTokens: p, contextSize: ctx } });
        }
        if (kept.length) steps.push({ ...step, promptTokens: kept });
        break;
      }
      case 'concurrency': {
        if (!fits(step.promptTokens, step.outputTokens, ctx)) {
          warnings.push({ code: 'prompt_too_long', params: { promptTokens: step.promptTokens, contextSize: ctx } });
          break;
        }
        const max = limits.maxConcurrency;
        const levels = step.levels.filter((l) => max === undefined || l <= max);
        for (const l of step.levels) {
          if (!levels.includes(l)) warnings.push({ code: 'concurrency_level_skipped', params: { level: l, parallel: max } });
        }
        if (levels.length) steps.push({ ...step, levels });
        break;
      }
      case 'llama-bench':
        if (limits.engineKind === 'llamacpp-native') steps.push(step);
        else warnings.push({ code: 'llama_bench_unsupported' });
        break;
    }
  }
  return { scenario: { ...scenario, steps }, warnings };
}

/** Speeds used to estimate durations; past results for the same model replace the defaults. */
export interface Expectations {
  decodeTps: number;
  prefillTps: number;
  coldLoadSec: number;
  warmLoadSec: number;
}

export const DEFAULT_EXPECTATIONS: Expectations = { decodeTps: 60, prefillTps: 2000, coldLoadSec: 30, warmLoadSec: 10 };
/** Startup, corpus tokenization, first-token probe and cleanup. */
const FIXED_OVERHEAD_SEC = 20;
/** Engine stop + VRAM settle between loads. */
const BETWEEN_LOADS_SEC = 2;

export function requestSeconds(prompt: number, output: number, e: Expectations): number {
  return prompt / e.prefillTps + output / e.decodeTps + 0.2;
}

/** Heuristic duration of a step in seconds (also used as the progress weight of that step). */
export function stepSeconds(step: Step, e: Expectations): number {
  switch (step.kind) {
    case 'load':
      return step.reps * ((step.cache === 'cold' ? e.coldLoadSec : e.warmLoadSec) + BETWEEN_LOADS_SEC);
    case 'latency':
      return step.promptTokens.reduce((s, p) => s + (step.warmup + step.reps) * requestSeconds(p, step.outputTokens, e), 0);
    case 'concurrency':
      // Prefill of C prompts is serialized; per-request decode slows ~15% per extra stream.
      return step.levels.reduce(
        (s, c) =>
          s +
          step.requestsPerWorker *
            ((step.promptTokens * c) / e.prefillTps + (step.outputTokens / e.decodeTps) * (1 + 0.15 * (c - 1))),
        0,
      );
    case 'llama-bench':
      return e.warmLoadSec + step.reps * (step.pp / e.prefillTps + step.tg / e.decodeTps + 1);
  }
}

export function estimateSeconds(scenario: Scenario, expectations: Partial<Expectations> = {}): number {
  const e: Expectations = { ...DEFAULT_EXPECTATIONS };
  for (const [k, v] of Object.entries(expectations) as [keyof Expectations, number | undefined][]) {
    if (v !== undefined && Number.isFinite(v) && v > 0) e[k] = v;
  }
  return Math.round(FIXED_OVERHEAD_SEC + scenario.steps.reduce((s, step) => s + stepSeconds(step, e), 0));
}
