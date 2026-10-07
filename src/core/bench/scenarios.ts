import type { EngineKind, LaunchParams } from '../../contract/engines';
import type { Profile, Scenario, Step } from '../../contract/results';

export type BuiltinProfile = Exclude<Profile, 'custom'>;
export const DEFAULT_SEED = 42;
/** Tokens kept free in the context besides prompt + output (BOS, server-side extras). */
export const CONTEXT_MARGIN = 16;

/** 1, 2, 3 … n: every step up to the busiest, so the table shows how each extra user changes things. */
export const usersUpTo = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);

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
    { kind: 'concurrency', levels: usersUpTo(4), promptTokens: 512, outputTokens: 128, requestsPerWorker: 4 },
  ],
  full: [
    { kind: 'load', cache: 'cold', reps: 3 },
    { kind: 'load', cache: 'warm', reps: 3 },
    { kind: 'latency', promptTokens: [128, 512, 2048, 8192, 32768], outputTokens: 512, warmup: 2, reps: 10 },
    { kind: 'concurrency', levels: usersUpTo(16), promptTokens: 512, outputTokens: 128, requestsPerWorker: 4 },
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
export function limitsFor(
  kind: EngineKind,
  params: LaunchParams,
  modelContext?: number,
  opts: { kvUnified?: boolean } = {},
): ScenarioLimits {
  const ctx = params.contextSize ?? params.maxModelLen ?? modelContext;
  if (isLlamaCpp(kind)) {
    const parallel = params.parallel ?? 1;
    const perRequest = ctx === undefined ? undefined : opts.kvUnified ? ctx : Math.floor(ctx / parallel);
    return { engineKind: kind, ...(perRequest ? { contextSize: perRequest } : {}), maxConcurrency: parallel };
  }
  return { engineKind: kind, ...(ctx ? { contextSize: ctx } : {}) };
}

const roundUp = (n: number, step: number): number => Math.ceil(n / step) * step;

/**
 * Launch parameters the scenario needs, for whatever the user did not set: the context must hold
 * the longest prompt + output (and, with a unified KV pool, all concurrent requests at once), and
 * llama.cpp needs one slot per concurrent request. Values are rounded to 1024 tokens and capped by
 * the model's native context (longer prompts are then dropped by fitScenario, with a warning).
 */
export function autoLaunchParams(
  kind: EngineKind,
  scenario: Scenario,
  params: LaunchParams,
  modelContext?: number,
  opts: { kvUnified?: boolean } = {},
): LaunchParams {
  let single = 0;
  let concurrency = 0;
  let perConcurrent = 0;
  for (const step of scenario.steps) {
    if (step.kind === 'latency') single = Math.max(single, Math.max(...step.promptTokens) + step.outputTokens + CONTEXT_MARGIN);
    if (step.kind === 'concurrency') {
      concurrency = Math.max(concurrency, ...step.levels);
      perConcurrent = Math.max(perConcurrent, step.promptTokens + step.outputTokens + CONTEXT_MARGIN);
    }
  }
  if (kind === 'external') return params;
  // Round first, then cap: the context must never exceed what the model was trained for.
  const sized = (n: number) => (modelContext ? Math.min(roundUp(n, 1024), modelContext) : roundUp(n, 1024));
  const out: LaunchParams = { ...params };
  if (isLlamaCpp(kind)) {
    const parallel = params.parallel ?? Math.max(1, concurrency);
    if (params.parallel === undefined && parallel > 1) out.parallel = parallel;
    if (params.contextSize === undefined && (single > 0 || perConcurrent > 0)) {
      const unified = opts.kvUnified ?? true;
      const perSlot = Math.max(single, perConcurrent);
      const total = unified ? Math.max(single, perConcurrent * Math.min(parallel, concurrency || 1)) : perSlot * parallel;
      out.contextSize = unified ? sized(total) : sized(perSlot) * parallel;
    }
    return out;
  }
  if (params.maxModelLen === undefined && single > 0) out.maxModelLen = sized(Math.max(single, perConcurrent));
  if (params.parallel === undefined && concurrency > 1) out.parallel = concurrency;
  return out;
}

/** Planning warning (code + params), localized by the renderer. */
export interface ScenarioWarning {
  code: string;
  params?: Record<string, unknown>;
}

const fits = (prompt: number, output: number, ctx: number | undefined): boolean =>
  ctx === undefined || prompt + output + CONTEXT_MARGIN <= ctx;

/** Smallest first, each value once: tables and charts then read in order (1, 2, 3, 4 users). */
const ascending = (values: readonly number[]): number[] => [...new Set(values)].sort((a, b) => a - b);

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
        const prompts = ascending(step.promptTokens);
        const kept = prompts.filter((p) => fits(p, step.outputTokens, ctx));
        for (const p of prompts) {
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
        const all = ascending(step.levels);
        const levels = all.filter((l) => max === undefined || l <= max);
        for (const l of all) {
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
