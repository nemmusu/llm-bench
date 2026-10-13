import { engineBaseOf, type EngineKind, type LaunchParams } from '../../contract/engines';
import { NINFER_DEFAULTS } from '../../contract/ninfer';
import type { Profile, Scenario, SessionsStep, Step } from '../../contract/results';
import { NINFER_MAX_CONCURRENCY } from '../../contract/ninfer';
import { ninferBenchParams } from '../engines/ninfer/args';
import { CONTEXT_MARGIN, requestMsAt, sweepDepths } from './sweep';

export { CONTEXT_MARGIN };
export type BuiltinProfile = Exclude<Profile, 'custom'>;
export const DEFAULT_SEED = 42;

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
    { kind: 'context-sweep', depths: [], fractions: false, outputTokens: 128, reps: 2, maxSeconds: 300 },
    { kind: 'concurrency', levels: usersUpTo(16), promptTokens: 512, outputTokens: 128, requestsPerWorker: 4 },
    // "Conversazioni lunghe": the context the launch gives each conversation, up to 32K (never grows the launch).
    { kind: 'sessions', depth: 0, maxDepth: 32768, levels: [1, 2], turns: 3, followupTokens: 256, outputTokens: 256, maxSeconds: 300 },
    { kind: 'llama-bench', pp: 512, tg: 128, reps: 5 },
  ],
  // "Trova le impostazioni migliori": the tuner launches the engine several times (see tuner.ts);
  // this step is the template of every context sweep it runs.
  tune: [{ kind: 'context-sweep', depths: [], fractions: false, outputTokens: 128, reps: 2 }],
};

export function buildScenario(profile: BuiltinProfile, seed = DEFAULT_SEED): Scenario {
  return { profile, seed, steps: structuredClone(PROFILES[profile]) };
}

/**
 * The scenario with its context sweeps measuring every depth: a launch beyond the model's trained
 * context (YaRN) is there to measure up to it, whatever the profile's time budget (the plan's
 * duration says how long).
 */
export function sweepWithoutBudget(scenario: Scenario): Scenario {
  return {
    ...scenario,
    steps: scenario.steps.map((s) => {
      if (s.kind !== 'context-sweep') return s;
      const { maxSeconds: _budget, ...rest } = s;
      return rest;
    }),
  };
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
  /** llama.cpp unified KV: contextSize is one pool that requests at the same time share. */
  sharedPool?: boolean;
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
    return { engineKind: kind, ...(perRequest ? { contextSize: perRequest } : {}), maxConcurrency: parallel, ...(opts.kvUnified ? { sharedPool: true } : {}) };
  }
  if (engineBaseOf(kind) === 'ninfer') {
    // --max-context per request (NInfer's default without it), --max-concurrency 1..8; everyone at once
    // must also fit in the shared pool (--kv-capacity, else --max-context; 'auto' holds at least that).
    const parallel = Math.min(params.parallel ?? 1, NINFER_MAX_CONCURRENCY);
    const perRequest = params.contextSize ?? NINFER_DEFAULTS.maxContext;
    const capacity = params.ninfer?.kvCapacity;
    const pool = typeof capacity === 'number' ? capacity : perRequest;
    return { engineKind: kind, contextSize: Math.min(perRequest, Math.floor(pool / parallel)), maxConcurrency: parallel };
  }
  return { engineKind: kind, ...(ctx ? { contextSize: ctx } : {}) };
}

const roundUp = (n: number, step: number): number => Math.ceil(n / step) * step;

/** Tokens a conversation adds to its first message: every answer, every follow-up, and the margin. */
export function sessionExtras(step: Pick<SessionsStep, 'turns' | 'outputTokens' | 'followupTokens'>): number {
  return step.turns * step.outputTokens + (step.turns - 1) * step.followupTokens + CONTEXT_MARGIN;
}

/** vLLM reports cached prompt tokens only with this flag (prefix caching itself is on by default in V1). */
export const VLLM_PROMPT_DETAILS_FLAG = '--enable-prompt-tokens-details';

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
  let sessions = 0;
  let perSession = 0;
  for (const step of scenario.steps) {
    if (step.kind === 'latency') single = Math.max(single, Math.max(...step.promptTokens) + step.outputTokens + CONTEXT_MARGIN);
    if (step.kind === 'concurrency') {
      concurrency = Math.max(concurrency, ...step.levels);
      perConcurrent = Math.max(perConcurrent, step.promptTokens + step.outputTokens + CONTEXT_MARGIN);
    }
    if (step.kind === 'sessions') {
      sessions = Math.max(sessions, ...step.levels);
      // Depth 0 takes whatever the launch gives: it never grows the context.
      if (step.depth > 0) perSession = Math.max(perSession, step.depth + sessionExtras(step));
    }
  }
  if (kind === 'external') return params;
  // Round first, then cap: the context must never exceed what the model was trained for.
  const sized = (n: number) => (modelContext ? Math.min(roundUp(n, 1024), modelContext) : roundUp(n, 1024));
  const out: LaunchParams = { ...params };
  if (kind === 'command') {
    // A command template only takes the context ({ctx}).
    if (params.contextSize === undefined && (single > 0 || perConcurrent > 0 || perSession > 0)) out.contextSize = sized(Math.max(single, perConcurrent, perSession));
    return out;
  }
  const users = Math.max(concurrency, sessions);
  if (isLlamaCpp(kind)) {
    // One slot per user at once; a conversation keeps its slot (and its cached context) between messages.
    const parallel = params.parallel ?? Math.max(1, users);
    if (params.parallel === undefined && parallel > 1) out.parallel = parallel;
    if (params.contextSize === undefined && (single > 0 || perConcurrent > 0 || perSession > 0)) {
      const unified = opts.kvUnified ?? true;
      const perSlot = Math.max(single, perConcurrent, perSession);
      const total = unified
        ? Math.max(single, perConcurrent * Math.min(parallel, concurrency || 1), perSession * Math.min(parallel, sessions || 1))
        : perSlot * parallel;
      out.contextSize = unified ? sized(total) : sized(perSlot) * parallel;
    }
    return out;
  }
  if (engineBaseOf(kind) === 'ninfer') {
    // --max-concurrency: one lane per user at once (at most 8); --max-context: the longest request.
    if (params.parallel === undefined && users > 1) out.parallel = Math.min(users, NINFER_MAX_CONCURRENCY);
    const lanes = out.parallel ?? 1;
    const perRequest = Math.max(single, perConcurrent, perSession);
    if (params.contextSize === undefined && perRequest > 0) out.contextSize = sized(perRequest);
    const ctx = out.contextSize ?? NINFER_DEFAULTS.maxContext;
    // The shared pool holds every user's request at once (a request whose pages do not fit waits).
    const pool = roundUp(Math.max(ctx, perConcurrent * Math.min(lanes, concurrency || 1), perSession * Math.min(lanes, sessions || 1)), 1024);
    const n = ninferBenchParams(params.ninfer, { conversations: sessions > 0 });
    out.ninfer = n.kvCapacity === undefined && pool > ctx ? { ...n, kvCapacity: pool } : n;
    return out;
  }
  if (params.maxModelLen === undefined && (single > 0 || perSession > 0)) out.maxModelLen = sized(Math.max(single, perConcurrent, perSession));
  if (params.parallel === undefined && users > 1) out.parallel = users;
  // SGLang always reports cached tokens (the adapter passes --enable-cache-report).
  if (engineBaseOf(kind) === 'vllm' && sessions > 0 && !out.extraArgs.includes(VLLM_PROMPT_DETAILS_FLAG)) out.extraArgs = [...out.extraArgs, VLLM_PROMPT_DETAILS_FLAG];
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
      case 'sessions': {
        const fitted = fitSessions(step, limits, warnings);
        if (fitted) steps.push(fitted);
        break;
      }
      case 'context-sweep': {
        // The grid follows the context the engine is started with; without one there is nothing to fill.
        if (ctx === undefined) {
          warnings.push({ code: 'context_sweep_skipped', params: { reason: 'unknown_context' } });
          break;
        }
        const all = step.depths.length ? ascending(step.depths) : sweepDepths(ctx, step.outputTokens, { fractions: step.fractions });
        const kept = all.filter((d) => fits(d, step.outputTokens, ctx));
        for (const d of all) if (!kept.includes(d)) warnings.push({ code: 'prompt_too_long', params: { promptTokens: d, contextSize: ctx } });
        if (kept.length) steps.push({ ...step, depths: kept });
        else warnings.push({ code: 'context_sweep_skipped', params: { reason: 'context_too_small', contextSize: ctx } });
        break;
      }
    }
  }
  return { scenario: { ...scenario, steps }, warnings };
}

/** Shortest first message worth measuring as a "long conversation". */
export const MIN_SESSION_DEPTH = 256;

/**
 * Levels in ascending order within the server's slots, and the first-message depth that lets the
 * whole conversation fit the context each conversation gets (a unified llama.cpp pool is shared by
 * the conversations at once). A depth that does not fit is reduced (warning sessions_depth_reduced).
 */
function fitSessions(step: SessionsStep, limits: ScenarioLimits, warnings: ScenarioWarning[]): SessionsStep | undefined {
  const max = limits.maxConcurrency;
  const all = ascending(step.levels);
  const levels = all.filter((l) => max === undefined || l <= max);
  for (const l of all) if (!levels.includes(l)) warnings.push({ code: 'concurrency_level_skipped', params: { level: l, parallel: max } });
  if (!levels.length) return undefined;
  const ctx = limits.contextSize;
  if (ctx === undefined) {
    if (step.depth > 0) return { ...step, levels };
    warnings.push({ code: 'sessions_depth_unknown' });
    return undefined;
  }
  const perSession = limits.sharedPool ? Math.floor(ctx / (levels[levels.length - 1] as number)) : ctx;
  const room = perSession - sessionExtras(step);
  const wanted = step.depth > 0 ? step.depth : Math.min(room, step.maxDepth ?? room);
  const depth = Math.min(wanted, room);
  if (depth < MIN_SESSION_DEPTH) {
    warnings.push({ code: 'prompt_too_long', params: { promptTokens: wanted, contextSize: perSession } });
    return undefined;
  }
  if (depth < step.depth) warnings.push({ code: 'sessions_depth_reduced', params: { requested: step.depth, depth, contextSize: perSession } });
  return { ...step, levels, depth };
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
    case 'context-sweep': {
      // Deep prompts are read slower than short ones (attention grows with the context): see requestMsAt.
      const anchor = { depth: 1024, prefillTps: e.prefillTps, decodeTps: e.decodeTps };
      const all = step.depths.reduce((s, d) => s + step.reps * (requestMsAt(d, step.outputTokens, anchor) / 1000 + 0.2), 0);
      return step.maxSeconds === undefined ? all : Math.min(all, step.maxSeconds);
    }
    case 'sessions': {
      // The first messages of N conversations are read one after the other; later ones only read
      // the new text (the rest comes from the cache). Generation slows ~15% per extra stream.
      const all = step.levels.reduce((s, n) => {
        const write = (step.outputTokens / e.decodeTps) * (1 + 0.15 * (n - 1)) + 0.2;
        const later = (step.turns - 1) * ((n * (step.outputTokens + step.followupTokens)) / e.prefillTps + write);
        return s + (n * step.depth) / e.prefillTps + write + later;
      }, 0);
      return step.maxSeconds === undefined ? all : Math.min(all, step.maxSeconds);
    }
  }
}

export function estimateSeconds(scenario: Scenario, expectations: Partial<Expectations> = {}): number {
  const e: Expectations = { ...DEFAULT_EXPECTATIONS };
  for (const [k, v] of Object.entries(expectations) as [keyof Expectations, number | undefined][]) {
    if (v !== undefined && Number.isFinite(v) && v > 0) e[k] = v;
  }
  return Math.round(FIXED_OVERHEAD_SEC + scenario.steps.reduce((s, step) => s + stepSeconds(step, e), 0));
}
