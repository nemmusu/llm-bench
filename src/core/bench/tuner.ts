/**
 * "Trova le impostazioni migliori", goal 'single' ("Un utente, contesto massimo"): finds, by launching
 * the engine several times, the largest context each KV cache precision can hold fully on the GPU,
 * then the fastest launch settings at that context, and measures every surviving combination with the
 * same context sweep. (Goal 'multi' is tune-multi.ts, "Ricontrollo rapido" tune-recheck.ts: they share
 * this machinery.)
 *
 *  1. Predict (no load): the VRAM estimate gives each KV type's largest context (+10 % slack, capped
 *     at the model's trained context). Candidates are powers of two from 4K up to it (plus the trained
 *     context itself); a type with none is skipped.
 *  2. Reference (Windows only, where a model that does not fit spills to shared memory instead of
 *     failing): the smallest context with the most precise KV that loads; its speed is what a
 *     collapse is measured against.
 *  3. Capacity, per KV type in the user's order (f16 → q8_0 → q4_0; vLLM auto → fp8), with the
 *     cheapest-memory settings: the largest candidate that loads without "out of memory" and without
 *     spilling. The top candidate is tried first (the estimate is usually close), then a binary search.
 *     A less precise type that cannot add context (the previous one already reached the model's limit)
 *     is not searched: its capacity is known without a launch. vLLM's memory share starts at the
 *     highest that fits the free VRAM and steps down while vLLM refuses to start with it.
 *  4. Coordinate descent at each type's largest context, one dimension at a time (flash attention →
 *     ubatch → batch → speculative decoding; vLLM: batched tokens, block size, fp8 format): each value
 *     is screened at three depths (1K, the middle of the grid and the deepest) and kept when it is
 *     faster (see tune-rank.ts); a value that runs out of memory or spills at that context is dropped —
 *     context comes first. Values that won in earlier runs on this GPU are tried first.
 *  5. Full context sweep (same depth grid for everyone) of each type's best combination, and of any
 *     screened variant that was the fastest at one of its depths.
 *  6. Last resorts: nothing fits even at 4K with q4_0 → part of the model on the CPU (--n-cpu-moe for
 *     MoE models, fewer -ngl otherwise). vLLM: fewer CUDA graphs, then --enforce-eager, when that is
 *     the only way to a larger context.
 *  7. Optional "fedeltà": the same greedy generation with the most precise KV and the recommended one.
 *
 * Everything runs within a time budget and a cap on launches; the search stops early when either is
 * spent and reports what it measured. The engine work itself goes through TuneLab (the runner).
 */
import type { LaunchParams } from '../../contract/engines';
import { AppError, toAppErrorData, type AppErrorData, type ErrorCode } from '../../contract/errors';
import type { RunPhase } from '../../contract/events';
import type { FitEstimate } from '../../contract/models';
import {
  nominalDepth,
  type ConcurrencyPoint,
  type LatencyPoint,
  type SessionsPoint,
  type SessionsStep,
  type TuneAttempt,
  type TuneBudget,
  type TuneCombination,
  type TuneCommand,
  type TuneGoal,
  type TuneKvType,
  type TuneStage,
  type TuneTag,
  type Tuning,
} from '../../contract/results';
import { depthGrid, maxDepth, runSweep, sweepDepths } from './sweep';
import { comparePoints, fastestByDepth, kvPrecisionRank, measuredDepths, pointAt, recommendedCombination, screenBetter } from './tune-rank';

// ---- engine access ------------------------------------------------------------------------------

/** A loaded engine of one attempt. */
export interface LabEngine {
  /** `reps` requests of `depth` prompt tokens and `outputTokens` answer tokens, as one point. */
  measure(depth: number, outputTokens: number, reps: number, kind: 'tune-probe' | 'tune-screen' | 'context-sweep'): Promise<LatencyPoint>;
  /** `level` users at once, each sending `requestsPerWorker` requests back to back (goal 'multi'). */
  concurrency(level: number, promptTokens: number, outputTokens: number, requestsPerWorker: number): Promise<ConcurrencyPoint>;
  /** "Conversazioni lunghe" on this engine (goal 'multi'): one point per level. */
  sessions(step: SessionsStep): Promise<SessionsPoint[]>;
  /** Peaks of this launch so far: VRAM (process or total minus baseline) and shared GPU memory (Windows). */
  memory(): { vramPeakMiB?: number; sharedPeakMiB?: number };
  /** KV cache capacity the engine reported, in tokens (vLLM "GPU KV cache size"). */
  capacityHint(): number | undefined;
  /** Greedy generation after a fixed prompt: token ids when the engine returns them, else text pieces. */
  generate(promptTokens: number, tokens: number): Promise<(number | string)[]>;
  stop(): Promise<void>;
}

export type LabStart = { ok: true; engine: LabEngine; loadMs: number } | { ok: false; error: AppErrorData; loadMs?: number };

/** One planned launch: its exact command is known before the engine starts. */
export interface LabLaunch {
  command: TuneCommand;
  start(): Promise<LabStart>;
}

export interface TuneLab {
  prepare(params: LaunchParams, info: { stage: TuneStage; attempt: number }): Promise<LabLaunch>;
}

// ---- search space -------------------------------------------------------------------------------

export type DimValue = string | number | boolean;
/** Values of every searched dimension ('kv' always present). */
export type Variant = Readonly<Record<string, DimValue>>;

/**
 * One searched launch setting. Adding a dimension is one entry here plus its mapping in
 * TuneSpace.params: the search code does not change.
 */
export interface Dimension {
  key: string;
  /** Values to try given the rest of the variant (e.g. flash attention off only with f16), in the order to try them. */
  values: (v: Variant) => readonly DimValue[];
  /** Values tried only where the VRAM estimate says they fit at that context (the biggest ubatch). */
  prune?: (value: DimValue) => boolean;
}

export interface TuneSpace {
  kvLadder: readonly TuneKvType[];
  /** The cheapest-memory settings of a KV type (used for the capacity search). */
  base: (kv: TuneKvType) => Variant;
  /** Coordinate-descent order. */
  dimensions: readonly Dimension[];
  /**
   * A start-up setting tried from its first value down, until the engine accepts it (vLLM's memory
   * share: "less than desired GPU memory utilization"); then kept for every launch.
   */
  startup?: { key: string; values: readonly DimValue[] };
  /** Ways beyond the largest context, tried in order with the most compact KV (vLLM: fewer CUDA graphs, eager). */
  extensions?: readonly Variant[];
  /** Goal 'multi': the context to launch for `users` users of `perUser` tokens each (llama.cpp: the sum; vLLM: one user's). */
  contextFor: (users: number, perUser: number) => number;
  /** Exact launch parameters of a variant at a context. */
  params: (v: Variant, ctx: number) => LaunchParams;
  tags: (v: Variant) => TuneTag[];
}

export interface BudgetRules {
  ms: number;
  maxLaunches: number;
  /** Repetitions of each screening depth. */
  screenReps: number;
}

export const BUDGETS: Record<TuneBudget, BudgetRules> = {
  fast: { ms: 5 * 60_000, maxLaunches: 24, screenReps: 2 },
  thorough: { ms: 20 * 60_000, maxLaunches: 60, screenReps: 3 },
  recheck: { ms: 3 * 60_000, maxLaunches: 4, screenReps: 2 },
};

/** Smallest context searched (or the model's own, when smaller). */
export const MIN_CONTEXT = 4096;
/** Search limit when the model does not say how long its context is. */
export const DEFAULT_CONTEXT_CAP = 131_072;
/** The estimate is approximate: contexts needing up to 10 % more than the free VRAM are still tried. */
export const PREDICT_SLACK = 1.1;
/** Quick check after every load: a short prompt and a few tokens (also warms the engine up). */
export const PROBE_DEPTH = 256;
export const PROBE_OUTPUT = 32;
/** Shallow screening depth. */
export const SCREEN_SHALLOW = 1024;
/** Spill: shared GPU memory of at least this much, and this much above the reference's. */
export const SPILL_SHARED_MIN_MIB = 512;
export const SPILL_SHARED_OVER_MIB = 256;
/** Spill: generation below this share of the reference's at a shallow depth (Windows was seen at 65 → 4.5 tok/s). */
export const SPILL_RATIO = 0.4;
/** Screened variants that won at some depth and get a full sweep too (at most). */
export const MAX_EXTRA_SWEEPS = 2;
/** A started sweep gets what is left of the budget, never less than this. */
export const MIN_SWEEP_MS = 60_000;
/** Fidelity check: prompt and greedy tokens compared. */
export const FIDELITY_PROMPT = 1024;
export const FIDELITY_TOKENS = 128;

/**
 * Generation slows down as the context fills, so a deep point is compared with the one before it with
 * a looser limit: 0.4 for depths up to 4× apart, divided by log₄ of the ratio beyond that.
 */
export function collapseLimit(fromDepth: number, toDepth: number): number {
  const ratio = toDepth / Math.max(1, fromDepth);
  return ratio <= 4 ? SPILL_RATIO : SPILL_RATIO / (Math.log(ratio) / Math.log(4));
}

/** The first depth whose generation speed collapsed against the previous point, if any. */
export function collapsedAt(points: readonly LatencyPoint[]): number | undefined {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as LatencyPoint;
    const b = points[i] as LatencyPoint;
    if (b.decodeTps.median < collapseLimit(a.promptTokens, b.promptTokens) * a.decodeTps.median) return b.promptTokens;
  }
  return undefined;
}

/**
 * Screening depths of a context: 1K, the grid depth nearest to half the deepest prompt (prompt reading
 * dominates deep prompts, the middle shows where a setting starts to pay off) and the deepest prompt.
 */
export function screenDepths(ctx: number, outputTokens: number): number[] {
  const deepest = maxDepth(ctx, outputTokens);
  const shallow = Math.min(SCREEN_SHALLOW, deepest);
  const inner = depthGrid(deepest).filter((d) => d > shallow && d < deepest);
  const middle = inner.reduce<number | undefined>((m, d) => (m === undefined || Math.abs(d - deepest / 2) < Math.abs(m - deepest / 2) ? d : m), undefined);
  return [...new Set([shallow, ...(middle !== undefined ? [middle] : []), deepest])];
}

/** Errors that mean "this configuration does not fit", not "something is broken". */
export function memoryError(e: AppErrorData): boolean {
  return e.code === 'ENGINE_OOM' || (e.code === 'MODEL_TOO_LARGE' && e.params?.reason === 'kv-cache');
}

/** Failures that would repeat on every launch: the search stops and the run fails with them. */
export const FATAL_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'CANCELLED',
  'ENGINE_NOT_INSTALLED',
  'ENGINE_START_FAILED',
  'ENGINE_BAD_FLAG',
  'ENGINE_NO_KERNEL_IMAGE',
  'ENGINE_MISSING_LIBRARY',
  'ENGINE_PORT_IN_USE',
  'MODEL_NOT_FOUND',
  'MODEL_INVALID',
  'DOCKER_NOT_INSTALLED',
  'DOCKER_NOT_RUNNING',
  'DOCKER_NO_GPU',
  'DOCKER_PERMISSION',
  'HF_AUTH_REQUIRED',
  'HF_GATED',
  'HF_NOT_FOUND',
  'DRIVER_TOO_OLD',
  'GPU_NOT_FOUND',
  'VRAM_BUSY',
]);

/** KV cache capacity a failed vLLM start reported ("estimated maximum model length is N"). */
export function failureHint(e: AppErrorData): number | undefined {
  const v = e.params?.estimatedMaxModelLen;
  return typeof v === 'number' && v > 0 ? v : undefined;
}

/** vLLM refused to start because its memory share is more than the free VRAM: a lower share may start. */
export function startupRefused(e: AppErrorData): boolean {
  return e.code === 'VRAM_BUSY' && e.params?.utilization !== undefined;
}

// ---- tuner --------------------------------------------------------------------------------------

/** "Ricontrollo rapido": the previous tune and the combinations to load again (see tune-recheck.ts). */
export interface RecheckInput {
  previousRunId: string;
  previousCreatedAt: string;
  previousBuild?: string;
  currentBuild?: string;
  /** Goal 'multi' of the previous run (users, context per user, prompts). */
  multi?: Tuning['multi'];
  /** The previous recommendation first, then its runner-up (if any). */
  checks: { role: 'recommended' | 'runner-up'; combination: TuneCombination }[];
}

export interface TunerInput {
  space: TuneSpace;
  budget: TuneBudget;
  /** Sweep shape (from the profile's context-sweep step): also the answer length of goal 'multi'. */
  sweep: { outputTokens: number; reps: number };
  /** Trained context of the model (the search never goes above it). */
  modelContext?: number;
  /** VRAM estimate on the free VRAM measured before the search; undefined = no estimate (nothing pruned). */
  predict?: (params: LaunchParams) => FitEstimate | undefined;
  /** A model that does not fit can spill to shared memory (Windows / WDDM) instead of failing. */
  spillPossible: boolean;
  /** Last resort when nothing fits at the smallest context (llama.cpp only). */
  offload?: { layers: number; moe: boolean };
  fidelity: boolean;
  /** Absent = 'single'. */
  goal?: TuneGoal;
  /** Goal 'multi': users at once, context per user, messages per conversation. */
  multi?: { users: number; perUserContext: number; turns: number };
  /** Values tried first because they won before on this GPU (reported as is). */
  learned?: Tuning['learned'];
  /** Budget 'recheck'. */
  recheck?: RecheckInput;
}

export interface TunerDeps {
  lab: TuneLab;
  /** Monotonic ms. */
  now: () => number;
  /** The search so far, after every change; `current` = the launch in progress. */
  onUpdate?: (t: Tuning, current?: Omit<TuneAttempt, 'outcome'>) => void;
  onPhase?: (phase: RunPhase) => void;
}

export interface Capacity {
  kv: TuneKvType;
  predictedMax?: number;
  candidates: number[];
  /** Known results per context: true = loads fully on the GPU, false = does not. */
  status: Map<number, boolean>;
  /** Contexts this type was actually launched with (the others are known from a more precise type). */
  launched: Set<number>;
  measuredMax?: number;
  inferred: boolean;
  skipped?: 'estimate' | 'no-gain' | 'budget';
}

export interface Screen {
  variant: Variant;
  ctx: number;
  /** Index of the attempt that measured it. */
  attempt: number;
  points: LatencyPoint[];
}

/** An attempt being made: the record plus what the search needs to know about it. */
export interface Live {
  att: TuneAttempt;
  index: number;
  variant: Variant;
  /** KV capacity the engine reported (vLLM), tokens. */
  hint?: number;
  /** Full sweep measured on this launch. */
  sweep?: LatencyPoint[];
  /** Goal 'multi': users 1..N and the conversations measured on this launch, as a combination. */
  users?: { concurrency: ConcurrencyPoint[]; sessions: SessionsPoint[] };
}

export type Work = (engine: LabEngine, live: Live) => Promise<void>;

/** Identity of a variant at a context. */
export function variantKey(v: Variant, ctx: number): string {
  const parts = Object.keys(v)
    .sort()
    .map((k) => `${k}=${String(v[k])}`);
  return `${ctx}|${parts.join(',')}`;
}

export class Tuner {
  protected readonly rules: BudgetRules;
  protected readonly cap: number;
  protected readonly min: number;
  protected readonly started: number;
  protected readonly attempts: TuneAttempt[] = [];
  protected readonly combos: TuneCombination[] = [];
  protected readonly capacity = new Map<TuneKvType, Capacity>();
  protected readonly screens = new Map<string, Screen>();
  /** Variants already measured as a combination. */
  protected readonly combined = new Set<string>();
  protected launches = 0;
  protected stoppedBy: Tuning['stoppedBy'];
  protected refDecode: number | undefined;
  protected refShared: number | undefined;
  private fidelity: Tuning['fidelity'];
  /** Index of the start-up setting's value in use (space.startup). */
  private startupAt = 0;

  constructor(
    protected readonly input: TunerInput,
    protected readonly deps: TunerDeps,
  ) {
    this.rules = BUDGETS[input.budget];
    this.cap = input.modelContext ?? DEFAULT_CONTEXT_CAP;
    this.min = Math.min(MIN_CONTEXT, this.cap);
    this.started = deps.now();
  }

  async run(): Promise<Tuning> {
    const { space } = this.input;
    for (const kv of space.kvLadder) this.capacity.set(kv, this.predictCapacity(kv));
    this.deps.onPhase?.('tune-capacity');
    if (this.input.spillPossible) await this.reference(this.min);
    for (const kv of space.kvLadder) await this.searchCapacity(kv);
    const fitting = space.kvLadder.filter((kv) => this.capacity.get(kv)?.measuredMax !== undefined);
    if (fitting.length === 0 && this.input.offload) await this.offload(this.input.offload);
    // Largest context first (the recommendation comes from there), then the more precise KV.
    const order = [...fitting].sort((a, b) => this.maxOf(b) - this.maxOf(a) || kvPrecisionRank(a) - kvPrecisionRank(b));
    const bests = new Map<TuneKvType, Variant>();
    for (const kv of order) {
      this.deps.onPhase?.('tune-variants');
      const best = await this.descend(kv);
      if (!best) continue;
      bests.set(kv, best.variant);
      await this.sweepCombination(best.variant, best.ctx);
    }
    const left = fitting.filter((kv) => this.capacity.get(kv)?.measuredMax !== undefined);
    if (left.length > 0) await this.extend(left, bests);
    await this.extraSweeps();
    if (this.input.fidelity) await this.checkFidelity();
    return this.snapshot();
  }

  protected maxOf(kv: TuneKvType): number {
    return (this.capacity.get(kv) as Capacity).measuredMax as number;
  }

  /** The base settings of a KV type, with the start-up setting in use. */
  protected base(kv: TuneKvType): Variant {
    return this.withStartup(this.input.space.base(kv));
  }

  private withStartup(v: Variant): Variant {
    const s = this.input.space.startup;
    return s ? { ...v, [s.key]: s.values[this.startupAt] as DimValue } : v;
  }

  /** Identity of a variant at a context; the start-up setting is the same for every launch that loads. */
  protected key(v: Variant, ctx: number): string {
    const s = this.input.space.startup;
    if (!s || !(s.key in v)) return variantKey(v, ctx);
    const { [s.key]: _startup, ...rest } = v;
    return variantKey(rest, ctx);
  }

  // ---- predictions and capacity -----------------------------------------------------------------

  /** True / false when the estimate says this launch fits (with slack) / does not; undefined = no estimate. */
  protected predictFits(params: LaunchParams): boolean | undefined {
    const est = this.input.predict?.(params);
    return est === undefined ? undefined : est.needMiB <= est.availableMiB * PREDICT_SLACK;
  }

  /** Largest context the estimate allows for this KV type (with slack): 0 = not even the smallest, undefined = no estimate. */
  private predictMax(kv: TuneKvType): number | undefined {
    const fits = (ctx: number) => this.predictFits(this.input.space.params(this.base(kv), ctx));
    const atMin = fits(this.min);
    if (atMin === undefined) return undefined;
    if (!atMin) return 0;
    if (fits(this.cap)) return this.cap;
    // Invariant: lo fits, hi does not; contexts in steps of 256 tokens (llama.cpp pads to that).
    let lo = this.min;
    let hi = this.cap;
    while (hi - lo > 256) {
      const mid = Math.max(lo + 256, Math.floor((lo + hi) / 2 / 256) * 256);
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  private predictCapacity(kv: TuneKvType): Capacity {
    const predicted = this.predictMax(kv);
    const limit = predicted ?? this.cap;
    const candidates: number[] = [];
    for (let c = this.min; c <= limit; c *= 2) candidates.push(c);
    if (this.cap <= limit && !candidates.includes(this.cap)) candidates.push(this.cap);
    return { kv, ...(predicted !== undefined ? { predictedMax: predicted } : {}), candidates, status: new Map(), launched: new Set(), inferred: false };
  }

  /** The most precise KV type's base settings at a small context: the speed a spill is compared with. */
  protected async reference(ctx: number): Promise<void> {
    for (const kv of this.input.space.kvLadder) {
      const cap = this.capacity.get(kv) as Capacity;
      if (cap.candidates.length === 0) continue;
      const live = await this.launch('reference', this.base(kv), ctx);
      if (!live) return;
      cap.status.set(ctx, live.att.outcome === 'ok');
      cap.launched.add(ctx);
      if (live.att.outcome === 'ok') {
        this.refDecode = (live.att.points[0] as LatencyPoint).decodeTps.median;
        this.refShared = live.att.sharedPeakMiB;
        return;
      }
    }
  }

  /** Largest context a more precise KV type held: a less precise one holds it too (it needs less memory). */
  protected bestPrecise(kv: TuneKvType): number | undefined {
    const ladder = this.input.space.kvLadder;
    const known = ladder
      .slice(0, ladder.indexOf(kv))
      .map((k) => this.capacity.get(k)?.measuredMax)
      .filter((m): m is number => m !== undefined);
    return known.length ? Math.max(...known) : undefined;
  }

  private async searchCapacity(kv: TuneKvType): Promise<void> {
    const cap = this.capacity.get(kv) as Capacity;
    const floor = this.bestPrecise(kv);
    const ladder = this.input.space.kvLadder;
    if (floor !== undefined) {
      for (const c of cap.candidates) if (c <= floor) cap.status.set(c, true);
      if (!cap.candidates.includes(floor)) cap.candidates.push(floor);
      cap.status.set(floor, true);
      cap.candidates.sort((a, b) => a - b);
      if (cap.candidates.every((c) => c <= floor)) {
        cap.measuredMax = floor;
        cap.inferred = true;
        cap.skipped = 'no-gain';
        return;
      }
    } else if (cap.candidates.length === 0) {
      // The most compact type is always tried once before giving up (the estimate may be pessimistic).
      if (kv !== ladder[ladder.length - 1]) {
        cap.skipped = 'estimate';
        return;
      }
      cap.candidates.push(this.min);
    }
    await this.search(cap, this.base(kv), (e, l) => this.screenWork(e, l));
  }

  /**
   * Largest candidate that loads with `variant`: the top unknown one first (the estimate or the
   * engine's own report is usually close), then a binary search. A launch that is the largest if it
   * loads (the next candidate is known not to) also runs `provenWork`.
   */
  protected async search(cap: Capacity, variant: Variant, provenWork: Work): Promise<void> {
    let tried = false;
    for (;;) {
      const cands = cap.candidates;
      const okIdx = this.highestOk(cap);
      const failIdx = cands.findIndex((c, i) => i > okIdx && cap.status.get(c) === false);
      const hi = failIdx < 0 ? cands.length : failIdx;
      if (hi - okIdx <= 1) break;
      // The top candidate first (the estimate is usually close), then a binary search.
      const next = tried ? Math.floor((okIdx + hi) / 2) : hi - 1;
      tried = true;
      const ctx = cands[next] as number;
      // If it loads it is the largest (the next candidate is known not to, or there is none): screen it now.
      const provenMax = next === hi - 1;
      const live = await this.launch('capacity', variant, ctx, provenMax ? provenWork : undefined);
      if (!live) {
        cap.skipped = 'budget';
        break;
      }
      cap.status.set(ctx, live.att.outcome === 'ok');
      cap.launched.add(ctx);
      if (live.sweep || live.users) this.addCombination(live);
      // The engine said how much fits: its exact capacity is the next candidate to try.
      if (this.applyHint(cap, live.hint)) tried = false;
    }
    const okIdx = this.highestOk(cap);
    if (okIdx < 0) return;
    cap.measuredMax = cap.candidates[okIdx] as number;
    cap.inferred = !cap.launched.has(cap.measuredMax);
  }

  private highestOk(cap: Capacity): number {
    return cap.candidates.reduce((m, c, i) => (cap.status.get(c) === true ? i : m), -1);
  }

  /**
   * vLLM reports how many tokens its KV cache holds: candidates above are impossible, the exact
   * capacity (rounded down to 1K) becomes one. True when that added a candidate.
   */
  private applyHint(cap: Capacity, hint: number | undefined): boolean {
    if (hint === undefined) return false;
    for (const c of cap.candidates) if (c > hint) cap.status.set(c, false);
    const exact = Math.floor(hint / 1024) * 1024;
    if (exact < this.min || exact > this.cap || cap.candidates.includes(exact)) return false;
    cap.candidates.push(exact);
    cap.candidates.sort((a, b) => a - b);
    return true;
  }

  // ---- launches -------------------------------------------------------------------------------

  private canLaunch(): boolean {
    if (this.launches >= this.rules.maxLaunches) this.stoppedBy ??= 'launches';
    else if (this.deps.now() - this.started >= this.rules.ms) this.stoppedBy ??= 'budget';
    return this.stoppedBy === undefined;
  }

  /**
   * One launch: start, a quick probe, the spill checks, then `work` while it is still loaded.
   * Undefined when the budget does not allow another launch. Failures that would repeat on every
   * launch are thrown (the run fails with them); a start-up setting the engine refuses steps down and
   * the launch is made again. `params` overrides the variant's launch parameters.
   */
  protected async launch(stage: TuneStage, variant: Variant, ctx: number, work?: Work, params?: LaunchParams): Promise<Live | undefined> {
    for (;;) {
      if (!this.canLaunch()) return undefined;
      this.launches++;
      const v = params ? variant : this.withStartup(variant);
      const p = params ?? this.input.space.params(v, ctx);
      const index = this.attempts.length;
      const planned = await this.deps.lab.prepare(p, { stage, attempt: index });
      const pending = { stage, params: p, kvType: v.kv as TuneKvType, contextSize: ctx, points: [], command: planned.command, atMs: this.deps.now() - this.started, variant: { ...v } };
      this.update(pending);
      const started = await planned.start();
      const live: Live = { att: { ...pending, outcome: 'ok', points: [] }, index, variant: v };
      let retry = false;
      if (started.ok) {
        live.att.loadMs = started.loadMs;
        await this.drive(started.engine, live, work);
      } else {
        const e = started.error;
        retry = !params && this.stepDown(e);
        if (!retry && FATAL_CODES.has(e.code)) throw new AppError(e.code, e.message, { ...(e.params ? { params: e.params } : {}), ...(e.detail ? { detail: e.detail } : {}) });
        live.att.outcome = memoryError(e) ? 'oom' : 'error';
        live.att.error = e;
        if (started.loadMs !== undefined) live.att.loadMs = started.loadMs;
        const hint = failureHint(e);
        if (hint !== undefined) live.hint = hint;
      }
      this.attempts.push(live.att);
      this.update();
      if (!retry) return live;
    }
  }

  /** The engine refused the start-up setting in use and a lower one is left: use it from now on. */
  private stepDown(e: AppErrorData): boolean {
    const s = this.input.space.startup;
    if (!s || !startupRefused(e) || this.startupAt >= s.values.length - 1) return false;
    this.startupAt++;
    return true;
  }

  /** Probe, spill checks and the work of a loaded engine; always stops it. */
  private async drive(engine: LabEngine, live: Live, work: Work | undefined): Promise<void> {
    const att = live.att;
    try {
      const probe = await engine.measure(PROBE_DEPTH, PROBE_OUTPUT, 1, 'tune-probe');
      att.points.push(probe);
      const hint = engine.capacityHint();
      if (hint !== undefined) {
        live.hint = hint;
        att.kvTokens = hint;
      }
      if (this.sharedSpill(engine)) {
        att.outcome = 'spill';
        att.spill = 'shared-memory';
      } else if (this.input.spillPossible && this.refDecode !== undefined && probe.decodeTps.median < SPILL_RATIO * this.refDecode) {
        att.outcome = 'spill';
        att.spill = 'decode-collapse';
      } else if (work) {
        await work(engine, live);
        // Memory taken while measuring (the KV cache filling up, compute buffers) can spill too.
        if (att.outcome === 'ok' && this.sharedSpill(engine)) {
          att.outcome = 'spill';
          att.spill = 'shared-memory';
          this.forget(live);
        }
      }
    } catch (e) {
      const data = toAppErrorData(e);
      if (data.code === 'CANCELLED') throw e;
      att.outcome = memoryError(data) ? 'oom' : 'error';
      att.error = data;
      this.forget(live);
    } finally {
      const mem = engine.memory();
      if (mem.vramPeakMiB !== undefined) att.vramPeakMiB = mem.vramPeakMiB;
      if (mem.sharedPeakMiB !== undefined) att.sharedPeakMiB = mem.sharedPeakMiB;
      await engine.stop();
    }
  }

  /** What a launch measured no longer counts (it spilled or failed after all). */
  protected forget(live: Live): void {
    this.screens.delete(this.key(live.variant, live.att.contextSize));
    delete live.sweep;
    delete live.users;
  }

  /** Windows: the engine uses shared GPU memory (system RAM) well beyond the reference launch's. */
  private sharedSpill(engine: LabEngine): boolean {
    const shared = engine.memory().sharedPeakMiB;
    return this.input.spillPossible && shared !== undefined && shared >= Math.max(SPILL_SHARED_MIN_MIB, (this.refShared ?? 0) + SPILL_SHARED_OVER_MIB);
  }

  /** Marks the attempt as a spill when the generation speed collapsed between two of these points. */
  protected collapsed(att: TuneAttempt, points: readonly LatencyPoint[]): boolean {
    if (!this.input.spillPossible || collapsedAt(points) === undefined) return false;
    att.outcome = 'spill';
    att.spill = 'decode-collapse';
    return true;
  }

  /** Screening: 1K, the middle and the deepest prompt of this context, with the budget's repetitions. */
  private async screenWork(engine: LabEngine, live: Live): Promise<void> {
    const out = this.input.sweep.outputTokens;
    const ctx = live.att.contextSize;
    const points: LatencyPoint[] = [];
    for (const d of screenDepths(ctx, out)) {
      const p = await engine.measure(d, out, this.rules.screenReps, 'tune-screen');
      points.push(p);
      live.att.points.push(p);
    }
    if (this.collapsed(live.att, points)) return;
    this.screens.set(this.key(live.variant, ctx), { variant: live.variant, ctx, attempt: live.index, points });
  }

  // ---- coordinate descent -----------------------------------------------------------------------

  /** Screens the base settings at the type's largest context (one step down while its deepest prompt spills). */
  private async baseScreen(kv: TuneKvType): Promise<Screen | undefined> {
    const cap = this.capacity.get(kv) as Capacity;
    const base = this.base(kv);
    for (;;) {
      const ctx = cap.measuredMax as number;
      const known = this.screens.get(this.key(base, ctx));
      if (known) return known;
      const live = await this.launch('variant', base, ctx, (e, l) => this.screenWork(e, l));
      if (!live) return undefined;
      if (live.att.outcome === 'ok') {
        live.att.screen = 'kept';
        return this.screens.get(this.key(base, ctx));
      }
      // It loaded during the capacity search but does not hold its deepest prompt.
      cap.status.set(ctx, false);
      const lower = cap.candidates.filter((c) => c < ctx);
      if (lower.length === 0) {
        delete cap.measuredMax;
        return undefined;
      }
      cap.measuredMax = lower[lower.length - 1] as number;
    }
  }

  /**
   * A value the estimate must allow (the biggest ubatch): what the screened settings measured at this
   * context, plus what the estimate says the change adds, must fit the free VRAM (with slack).
   */
  protected estimateAllows(variant: Variant, from: { variant: Variant; ctx: number; attempt: number }): boolean {
    const { space, predict } = this.input;
    const est = predict?.(space.params(variant, from.ctx));
    if (!est) return true;
    const before = predict?.(space.params(from.variant, from.ctx));
    const measured = (this.attempts[from.attempt] as TuneAttempt).vramPeakMiB;
    const need = before && measured !== undefined ? measured + est.needMiB - before.needMiB : est.needMiB;
    return need <= est.availableMiB * PREDICT_SLACK;
  }

  /** One dimension at a time at the type's largest context; returns the best screened settings. */
  private async descend(kv: TuneKvType): Promise<Screen | undefined> {
    let best = await this.baseScreen(kv);
    if (!best) return undefined;
    const dims = this.input.space.dimensions;
    for (let d = 0; d < dims.length; d++) {
      const dim = dims[d] as Dimension;
      const from: Screen = best;
      const values = dim.values(from.variant).filter((v) => v !== from.variant[dim.key]);
      for (let i = 0; i < values.length; i++) {
        const current: Screen = best;
        const variant: Variant = { ...current.variant, [dim.key]: values[i] as DimValue };
        if (dim.prune?.(values[i] as DimValue) && !this.estimateAllows(variant, current)) continue;
        // The last value tried, and the winner: its full sweep runs on this same launch.
        const last = d === dims.length - 1 && i === values.length - 1;
        let won = false;
        const live = await this.launch('variant', variant, current.ctx, async (engine, l) => {
          await this.screenWork(engine, l);
          if (l.att.outcome !== 'ok') return;
          const mine = this.screens.get(this.key(variant, current.ctx)) as Screen;
          won = screenBetter(mine.points, current.points);
          if (won && last) await this.sweepWork(engine, l, mine.points);
        });
        if (!live) return best;
        if (live.att.outcome !== 'ok') continue;
        live.att.screen = won ? 'kept' : 'lost';
        if (!won) continue;
        (this.attempts[current.attempt] as TuneAttempt).screen = 'lost';
        best = this.screens.get(this.key(variant, current.ctx)) as Screen;
        if (live.sweep) this.addCombination(live);
      }
    }
    return best;
  }

  // ---- sweeps and combinations ------------------------------------------------------------------

  /** The full sweep on a loaded engine; depths already measured on this launch are reused. */
  protected async sweepWork(engine: LabEngine, live: Live, reuse: readonly LatencyPoint[], depthsOf: (ctx: number, out: number) => number[] = sweepDepths): Promise<void> {
    this.deps.onPhase?.('context-sweep');
    const { outputTokens, reps } = this.input.sweep;
    const ctx = live.att.contextSize;
    const have = new Set(reuse.map((p) => p.promptTokens));
    const depths = depthsOf(ctx, outputTokens).filter((d) => !have.has(d));
    const result = await runSweep(depths, (d) => engine.measure(d, outputTokens, reps, 'context-sweep'), {
      outputTokens,
      reps,
      now: this.deps.now,
      maxMs: Math.max(MIN_SWEEP_MS, this.rules.ms - (this.deps.now() - this.started)),
    });
    live.att.points.push(...result.points);
    const sweep = [...reuse, ...result.points].sort((a, b) => a.promptTokens - b.promptTokens);
    if (this.collapsed(live.att, sweep)) {
      // It does not hold its deepest prompts after all: not a candidate any more.
      this.screens.delete(this.key(live.variant, ctx));
      return;
    }
    live.sweep = sweep;
  }

  protected addCombination(live: Live): void {
    const att = live.att;
    att.combination = this.combos.length;
    this.combined.add(this.key(live.variant, att.contextSize));
    this.combos.push({
      params: att.params,
      kvType: att.kvType,
      maxContext: att.contextSize,
      ...(att.vramPeakMiB !== undefined ? { vramPeakMiB: att.vramPeakMiB } : {}),
      sweep: live.sweep ?? [],
      command: att.command,
      outcome: 'ok',
      tags: this.input.space.tags(live.variant),
      variant: { ...live.variant },
      ...this.combinationExtras(live),
    });
    this.update();
  }

  /** Goal-specific fields of a new combination (goal 'multi': users and conversations). */
  protected combinationExtras(_live: Live): Partial<TuneCombination> {
    return {};
  }

  /** A dedicated launch for the full sweep of a combination (unless it was measured already). */
  private async sweepCombination(variant: Variant, ctx: number): Promise<void> {
    if (this.combined.has(this.key(variant, ctx))) return;
    const live = await this.launch('sweep', variant, ctx, (e, l) => this.sweepWork(e, l, []));
    if (live?.sweep) this.addCombination(live);
  }

  /** Screened variants that were the fastest at one of their depths get a full sweep too. */
  private async extraSweeps(): Promise<void> {
    let extra = 0;
    for (const s of [...this.screens.values()]) {
      if (extra >= MAX_EXTRA_SWEEPS) return;
      if (this.combined.has(this.key(s.variant, s.ctx))) continue;
      const wins = s.points.some((p) => {
        const rivals = this.combos.map((c) => pointAt(c.sweep, nominalDepth(p.promptTokens))).filter((r): r is LatencyPoint => r !== undefined);
        return rivals.length > 0 && rivals.every((r) => comparePoints(p, r) > 0);
      });
      if (!wins) continue;
      extra++;
      await this.sweepCombination(s.variant, s.ctx);
    }
  }

  // ---- last resorts -----------------------------------------------------------------------------

  /**
   * Nothing fits at the smallest context even with the most compact KV: part of the model goes to the
   * CPU (MoE experts first, else fewer GPU layers), starting from the estimate, more each time.
   */
  private async offload(o: { layers: number; moe: boolean }): Promise<void> {
    const { space } = this.input;
    const kv = space.kvLadder[space.kvLadder.length - 1] as TuneKvType;
    const base = this.base(kv);
    const onGpu = this.input.predict?.(space.params(base, this.min))?.maxGpuLayers ?? Math.floor(o.layers / 2);
    const step = Math.max(1, Math.ceil(o.layers / 8));
    for (let k = 0; ; k++) {
      const value = o.moe ? Math.min(o.layers, o.layers - onGpu + k * step) : Math.max(0, onGpu - k * step);
      const variant: Variant = { ...base, [o.moe ? 'ncmoe' : 'ngl']: value };
      const live = await this.launch('offload', variant, this.min, (e, l) => this.sweepWork(e, l, []));
      if (!live) return;
      if (live.sweep) {
        this.addCombination(live);
        return;
      }
      if (o.moe ? value >= o.layers : value <= 0) return;
    }
  }

  /**
   * vLLM: fewer CUDA graphs, then --enforce-eager, free graph memory for the KV cache. Each is searched
   * (one step up, then the capacity vLLM reports) with the most compact KV and the best settings found
   * for it, only to go beyond the largest context so far; the combination found is measured on the
   * same launch.
   */
  private async extend(fitting: readonly TuneKvType[], bests: ReadonlyMap<TuneKvType, Variant>): Promise<void> {
    const kv = fitting[fitting.length - 1] as TuneKvType;
    for (const ext of this.input.space.extensions ?? []) {
      const best = Math.max(...fitting.map((k) => this.maxOf(k)), ...this.combos.map((c) => c.maxContext));
      if (best >= this.cap) return;
      const variant: Variant = { ...(bests.get(kv) ?? this.base(kv)), ...ext };
      const cap: Capacity = { kv, candidates: [best, Math.min(this.cap, best * 2)], status: new Map([[best, true]]), launched: new Set(), inferred: false };
      await this.search(cap, variant, (e, l) => this.sweepWork(e, l, []));
    }
  }

  /** Same prompt, greedy: the most precise KV that fits vs the recommended one. An indication only. */
  private async checkFidelity(): Promise<void> {
    const rec = recommendedCombination(this.combos);
    const { space } = this.input;
    const refKv = space.kvLadder.find((kv) => this.capacity.get(kv)?.measuredMax !== undefined);
    if (rec === undefined || refKv === undefined) return;
    const chosen = this.combos[rec] as TuneCombination;
    if (kvPrecisionRank(chosen.kvType) <= kvPrecisionRank(refKv)) return;
    this.deps.onPhase?.('fidelity');
    const prompt = Math.min(FIDELITY_PROMPT, maxDepth(this.min, FIDELITY_TOKENS));
    const generate = async (params: LaunchParams, variant: Variant): Promise<(number | string)[] | undefined> => {
      let out: (number | string)[] | undefined;
      const atMin: LaunchParams = params.maxModelLen !== undefined ? { ...params, maxModelLen: this.min } : { ...params, contextSize: this.min };
      await this.launch(
        'fidelity',
        variant,
        this.min,
        async (e) => {
          out = await e.generate(prompt, FIDELITY_TOKENS);
        },
        atMin,
      );
      return out;
    };
    const ref = await generate(space.params(this.base(refKv), this.min), this.base(refKv));
    // Every combination of this run records its variant.
    const cmp = ref ? await generate(chosen.params, chosen.variant as Variant) : undefined;
    if (!ref || !cmp) return;
    const n = Math.min(ref.length, cmp.length);
    let identical = 0;
    let first: number | undefined;
    for (let i = 0; i < n; i++) {
      if (ref[i] === cmp[i]) identical++;
      else first ??= i;
    }
    this.fidelity = { referenceKv: refKv, comparedKv: chosen.kvType, promptTokens: prompt, tokens: n, identical, ...(first !== undefined ? { firstDivergence: first } : {}) };
  }

  // ---- result -----------------------------------------------------------------------------------

  /** Index of the recommended combination (goal 'single': the fastest at the largest context). */
  protected recommend(combos: readonly TuneCombination[]): number | undefined {
    return recommendedCombination(combos);
  }

  /** Goal-specific fields of the result (goal 'multi', "Ricontrollo rapido"). */
  protected goalFields(): Partial<Tuning> {
    return {};
  }

  protected snapshot(): Tuning {
    const combos = this.combos.map((c) => ({ ...c }));
    const rec = this.recommend(combos);
    const t: Tuning = {
      budget: this.input.budget,
      ...(this.input.learned ? { learned: this.input.learned } : {}),
      maxLaunches: this.rules.maxLaunches,
      ...(this.stoppedBy ? { stoppedBy: this.stoppedBy } : {}),
      dimensions: this.dimensionsTried(),
      capacity: [...this.capacity.values()].map((c) => ({
        kvType: c.kv,
        ...(c.predictedMax ? { predictedMax: c.predictedMax } : {}),
        ...(c.measuredMax !== undefined ? { measuredMax: c.measuredMax } : {}),
        inferred: c.inferred,
        ...(c.skipped ? { skipped: c.skipped } : {}),
      })),
      depths: measuredDepths(combos),
      attempts: this.attempts.map((a) => ({ ...a, points: [...a.points] })),
      combinations: combos,
      ...(rec !== undefined ? { recommended: rec } : {}),
      fastestByDepth: fastestByDepth(combos),
      ...(this.fidelity ? { fidelity: this.fidelity } : {}),
    };
    return { ...t, ...this.goalFields() };
  }

  /** Searched dimensions with the values each KV type would try (the start-up setting: the ones tried so far). */
  private dimensionsTried(): Tuning['dimensions'] {
    const { space } = this.input;
    const bases = space.kvLadder.map((kv) => this.base(kv));
    const dims = space.dimensions
      .map((d) => ({ key: d.key, values: [...new Set(bases.flatMap((b) => [...d.values(b)]))] }))
      .filter((d) => d.values.length > 0);
    const s = space.startup;
    return [{ key: 'kv', values: [...space.kvLadder] }, ...(s ? [{ key: s.key, values: s.values.slice(0, this.startupAt + 1) }] : []), ...dims];
  }

  protected update(current?: Omit<TuneAttempt, 'outcome'>): void {
    this.deps.onUpdate?.(this.snapshot(), current);
  }
}
