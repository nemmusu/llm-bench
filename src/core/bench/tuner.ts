/**
 * "Trova le impostazioni migliori", goal 'single' ("Un utente, contesto massimo"): finds, by launching
 * the engine several times, the largest context each KV cache precision can hold fully on the GPU,
 * then the fastest launch settings at that context, and measures every surviving combination with the
 * same context sweep. (Goal 'multi' is tune-multi.ts, "Ricontrollo rapido" tune-recheck.ts: they share
 * this machinery.)
 *
 *  1. Predict (no load): the VRAM estimate gives each KV type's largest context (+10 % slack, capped
 *     at the model's trained context). Candidates are powers of two from 4K up to it, the estimate
 *     itself rounded down to 8K (e.g. 245 760) and the trained context when it fits; a type with none
 *     is skipped.
 *  2. Reference (Windows only, where a model that does not fit spills to shared memory instead of
 *     failing): the smallest context with the most precise KV that loads; its 1K probe is what a
 *     collapse is measured against, its shared memory what a spill is measured against.
 *  3. Capacity, per KV type in the user's order (f16 → q8_0 → q4_0; vLLM auto → fp8), with the
 *     cheapest-memory settings: the largest candidate that loads without "out of memory" and without
 *     spilling. A capacity launch is only a check: load → shared memory → a 1K probe compared with the
 *     reference's 1K probe (the same depth: slowing down on deep prompts is normal). No deep prompt is
 *     sent while searching. The top candidate first (the estimate is usually close), then a binary
 *     search between the largest that loaded and the smallest that did not, down to steps of 8K
 *     (or 1/8 of the context). An engine that says how many tokens fit (vLLM's KV cache report,
 *     NInfer's reservation) has that context tried next: when it loads it is the limit, when it does
 *     not (it spills, it is too slow) the search goes on below it like after any other failure. A
 *     less precise type that cannot add context is not searched. vLLM's memory share starts at the
 *     highest that fits the free VRAM and steps down while vLLM refuses to start with it.
 *  4. Coordinate descent at each type's largest context, one dimension at a time (flash attention →
 *     ubatch → batch → speculative decoding; vLLM: batched tokens, block size, fp8 format): each value
 *     is screened at three depths (the deepest first, then 1K and the middle of the grid; "Veloce" on
 *     contexts above 64K: 1K and the middle only, the deepest prompt taking minutes) and kept when it
 *     is faster (see tune-rank.ts); a value that runs out of memory or spills at that context is
 *     dropped — context comes first. Values that won in earlier runs on this GPU are tried first. The
 *     last value a type tries (no later dimension has another value for it) is swept on its screening
 *     launch when it wins.
 *  5. Full context sweep of each type's best combination (and of any screened variant that was the
 *     fastest at one of its depths): what its screening measured is reused, so each deep prompt of a
 *     combination is measured once; the deepest prompt (the context full: every speed of a combination
 *     is read there) comes first, then the depths in between, so a search the time limit stops still
 *     has it. "Veloce" on contexts above 64K: 1K, 4K, 16K, 64K… (×4) plus the exact maximum, without
 *     200K (minutes per request); "Accurata" doubles and measures 200K when the context reaches it.
 *  6. Last resorts: nothing fits even at 4K with q4_0 → part of the model on the CPU (--n-cpu-moe for
 *     MoE models, fewer -ngl otherwise). vLLM: fewer CUDA graphs, then --enforce-eager, when that is
 *     the only way to a larger context.
 *  7. Optional "fedeltà": the same greedy generation with the most precise KV and the recommended one.
 *
 * Spills (Windows): the engine's memory is watched live from its start to its stop (launchSpilled in
 * spill.ts: Shared Usage over the threshold, or the card full with Shared Usage 512 MiB over the
 * reference's): the moment it crosses the rule the launch is given up — the load or the request in
 * flight aborted, the engine stopped — and counts as "does not fit"; the check right after the load and
 * after the measurements stay. Every probe, screening or sweep request also has a deadline: max(30 s,
 * 5 × its time predicted from the reference launch's speeds); past it (or with no token for a minute,
 * the stall guard of every run) the launch is given up as 'too-slow': that slow, it reads from shared
 * memory. Either way the search goes on (the binary search steps down).
 *
 * Time: the search forecasts itself from the predicted contexts, the expected speeds (earlier runs of
 * this model, else its size) and the launches; its time limit is that estimate × 1.5. The first launch
 * that loads measures how long an engine start really takes (and its 1K speed): once, the limit is
 * raised to (the time so far + the rest as now predicted) × 1.5 when that is more (never lowered; a
 * limit the request set stays). Every request is predicted from the speeds measured so far: one longer
 * than a minute is made once (n = 1), one that would end past the limit (plus a grace) is not started
 * (recorded; when it is the deepest prompt the shorter ones still are), a started one is never cut.
 * When the limit or the launch cap stops the search, what was measured at each type's largest context
 * becomes a combination "misurata in parte", ranked by the same rules. The engine work itself goes
 * through TuneLab (the runner).
 */
import type { LaunchParams } from '../../contract/engines';
import { AppError, toAppErrorData, type AppErrorData, type ErrorCode } from '../../contract/errors';
import type { RunPhase } from '../../contract/events';
import type { FitEstimate } from '../../contract/models';
import {
  nominalDepth,
  TUNE_PROBE_DEPTH,
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
  type TuneUsersMode,
  type Tuning,
} from '../../contract/results';
import { availableNowMiB } from '../models/fit';
import { launchSpilled, SPILL_RATIO } from './spill';
import { anchorOf, depthGrid, maxDepth, requestMsAt, sweepDepths, type GridStep, type SpeedAnchor } from './sweep';
import { comparePoints, fastestByDepth, kvPrecisionRank, measuredDepths, pointAt, recommendedCombination, screenBetter } from './tune-rank';
import { watchdogFired } from './watchdog';

export { SPILL_RATIO };

// ---- engine access ------------------------------------------------------------------------------

/** Peaks of one launch so far, MiB. */
export interface LaunchMemory {
  /** VRAM of the launch: the engine process's own when the OS attributes it, else the total minus the baseline. */
  vramPeakMiB?: number;
  /** Shared GPU memory of the engine process (Windows counters). */
  sharedPeakMiB?: number;
  /** Dedicated memory in use on the card, every process (nvidia-smi). */
  cardPeakMiB?: number;
  /** The card's whole memory. */
  totalMiB?: number;
}

/**
 * The live spill watch of a launch: called with its memory peaks at every reading of the monitor while
 * its engine is up, from its start to its stop. true = give the launch up at once: the load or the
 * request in flight is aborted, every later request on it fails, and it is stopped.
 */
export type LaunchGuard = (m: LaunchMemory) => boolean;

export interface MeasureOptions {
  /** Asked before every repetition after the first: false = stop there (the point keeps the ones made). */
  more?: () => boolean;
  /** Deadline of each request, ms: past it the request is aborted (ENGINE_TIMEOUT, reason 'deadline'). */
  timeoutMs?: number;
}

/** A loaded engine of one attempt. */
export interface LabEngine {
  /** `reps` requests of `depth` prompt tokens and `outputTokens` answer tokens, as one point. */
  measure(depth: number, outputTokens: number, reps: number, kind: 'tune-probe' | 'tune-screen' | 'context-sweep', o?: MeasureOptions): Promise<LatencyPoint>;
  /** `level` users at once, each sending `requestsPerWorker` requests back to back (goal 'multi'). */
  concurrency(level: number, promptTokens: number, outputTokens: number, requestsPerWorker: number): Promise<ConcurrencyPoint>;
  /** "Conversazioni lunghe" on this engine (goal 'multi'): one point per level. */
  sessions(step: SessionsStep): Promise<SessionsPoint[]>;
  /** Peaks of this launch so far: VRAM, shared GPU memory (Windows), the card's memory in use. */
  memory(): LaunchMemory;
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
  /** Starts the engine; `guard` watches its memory until it is stopped (a launch given up while it loads: ok false). */
  start(guard?: LaunchGuard): Promise<LabStart>;
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
  /** The shortest time limit (a small model's estimate can be a minute or two). */
  minMs: number;
  maxLaunches: number;
  /** Repetitions of each screening depth. */
  screenReps: number;
  /** Grid of the sweeps (and of the screening's middle depth) on contexts above LONG_CONTEXT. */
  longGrid: GridStep;
}

export const BUDGETS: Record<TuneBudget, BudgetRules> = {
  fast: { minMs: 60_000, maxLaunches: 24, screenReps: 2, longGrid: 4 },
  thorough: { minMs: 2 * 60_000, maxLaunches: 60, screenReps: 3, longGrid: 2 },
  recheck: { minMs: 60_000, maxLaunches: 4, screenReps: 2, longGrid: 2 },
};

/** The time limit is the search's own estimate times this. */
export const TIME_MARGIN = 1.5;
/** A request is still started when it is predicted to end at most this long after the limit. */
export const TIME_GRACE_MS = 30_000;
/** A request predicted to take longer than this is made once (n = 1) instead of `reps` times. */
export const SLOW_REQUEST_MS = 60_000;
/** Above this context "Veloce" sweeps on the ×4 grid. */
export const LONG_CONTEXT = 65_536;
/** Smallest context searched (or the model's own, when smaller). */
export const MIN_CONTEXT = 4096;
/** Search limit when the model does not say how long its context is. */
export const DEFAULT_CONTEXT_CAP = 131_072;
/** The estimate is approximate: contexts needing up to 10 % more than the free VRAM are still tried. */
export const PREDICT_SLACK = 1.1;
/** Capacity candidates and the refinement between "loads" and "does not" are multiples of this. */
export const CAPACITY_STEP = 8192;
/** The search between the largest context that loaded and the smallest that did not stops within this share. */
export const CAPACITY_PRECISION = 1 / 8;
/** Quick check after every load, at the same depth as the reference's: a 1K prompt and a few tokens (also warms the engine up). */
export const PROBE_DEPTH = TUNE_PROBE_DEPTH;
export const PROBE_OUTPUT = 32;
/** Shallow screening depth. */
export const SCREEN_SHALLOW = 1024;
/** Screened variants that won at some depth and get a full sweep too (at most). */
export const MAX_EXTRA_SWEEPS = 2;
/** A started users measurement (goal 'multi') gets what is left of the time, never less than this. */
export const MIN_SWEEP_MS = 60_000;
/** A tune request is given up after max(30 s, 5 × its predicted time): a launch that slow reads from shared memory. */
export const REQUEST_TIMEOUT_MIN_MS = 30_000;
export const REQUEST_TIMEOUT_FACTOR = 5;
/** Fidelity check: prompt and greedy tokens compared. */
export const FIDELITY_PROMPT = 1024;
export const FIDELITY_TOKENS = 128;
/** What a request, a load and the capacity search are expected to take before anything is measured here. */
export const DEFAULT_SPEED: SpeedAnchor = { depth: 1024, prefillTps: 2000, decodeTps: 60 };
export const DEFAULT_LOAD_MS = 10_000;
/** Capacity launches per searched KV type in the forecast (the estimate is usually right first time). */
export const CAPACITY_LAUNCHES = 1.5;

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

/** The sweep grid of a context: ×`longGrid` above LONG_CONTEXT, doubling below. */
export function gridFor(ctx: number, longGrid: GridStep): GridStep {
  return ctx > LONG_CONTEXT ? longGrid : 2;
}

/**
 * Screening depths of a context: 1K, the grid depth nearest to half the deepest prompt (prompt reading
 * dominates deep prompts, the middle shows where a setting starts to pay off) and the deepest prompt.
 */
export function screenDepths(ctx: number, outputTokens: number, step: GridStep = 2): number[] {
  const deepest = maxDepth(ctx, outputTokens);
  const shallow = Math.min(SCREEN_SHALLOW, deepest);
  const inner = depthGrid(deepest, step).filter((d) => d > shallow && d < deepest);
  const middle = inner.reduce<number | undefined>((m, d) => (m === undefined || Math.abs(d - deepest / 2) < Math.abs(m - deepest / 2) ? d : m), undefined);
  return [...new Set([shallow, ...(middle !== undefined ? [middle] : []), deepest])];
}

/**
 * Depths in the order a launch measures them: `deepest` first when it is among them (the context full:
 * every speed of a combination is read there, so a search the time limit stops still has it), then the
 * others in their order.
 */
export function fullContextFirst(depths: readonly number[], deepest: number): number[] {
  return depths.includes(deepest) ? [deepest, ...depths.filter((d) => d !== deepest)] : [...depths];
}

/** The middle of the largest context that loads and the smallest that does not, rounded down to 8K. */
export function capacityMiddle(lo: number, hi: number): number {
  return Math.floor((lo + hi) / 2 / CAPACITY_STEP) * CAPACITY_STEP;
}

/**
 * The largest context that loads (`lo`) and the smallest that does not (`hi`) are as close as the
 * capacity search goes: at most 8K or 1/8 of `lo` apart, or no multiple of 8K between them.
 */
export function capacitySettled(lo: number, hi: number): boolean {
  return hi - lo <= Math.max(CAPACITY_STEP, lo * CAPACITY_PRECISION) || capacityMiddle(lo, hi) <= lo;
}

/** No dimension after the `d`-th has another value to try for `variant`: when it wins, the descent ends with it. */
export function lastToTry(dims: readonly Dimension[], d: number, variant: Variant): boolean {
  return dims.slice(d + 1).every((x) => x.values(variant).every((v) => v === variant[x.key]));
}

/** Errors that mean "this configuration does not fit", not "something is broken". */
export function memoryError(e: AppErrorData): boolean {
  return e.code === 'ENGINE_OOM' || (e.code === 'MODEL_TOO_LARGE' && e.params?.reason === 'kv-cache');
}

/**
 * Failures that would repeat on every launch: the search stops at the first one and the run fails
 * with it. Among them, those that are a property of the model and the engine build together (every
 * setting fails the same): a model the build cannot read (ENGINE_MODEL_UNSUPPORTED: an unknown weight
 * layout, container version or architecture, for every engine), a GPU the engine does not run on.
 */
export const FATAL_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'CANCELLED',
  'ENGINE_MODEL_UNSUPPORTED',
  'ENGINE_GPU_UNSUPPORTED',
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
  'DOCKER_NOT_RESPONDING',
  'DOCKER_NO_GPU',
  'DOCKER_PERMISSION',
  'HF_AUTH_REQUIRED',
  'HF_GATED',
  'HF_NOT_FOUND',
  'DRIVER_TOO_OLD',
  'GPU_NOT_FOUND',
  'VRAM_BUSY',
]);

/**
 * A search where no launch ever reached a verdict (none loaded, none ran out of memory or spilled: each
 * failed for another reason) found nothing about this model: the run must fail, with the last launch's
 * error, never end "completed" with nothing measured. Undefined when some launch did (or none failed).
 */
export function nothingLoaded(t: Pick<Tuning, 'attempts'>): AppErrorData | undefined {
  if (t.attempts.some((a) => a.outcome === 'ok' || a.outcome === 'oom' || a.outcome === 'spill')) return undefined;
  return [...t.attempts].reverse().find((a) => a.error !== undefined)?.error;
}

/** KV cache capacity a failed vLLM start reported ("estimated maximum model length is N"). */
export function failureHint(e: AppErrorData): number | undefined {
  const v = e.params?.estimatedMaxModelLen;
  return typeof v === 'number' && v > 0 ? v : undefined;
}

/** vLLM refused to start because its memory share is more than the free VRAM: a lower share may start. */
export function startupRefused(e: AppErrorData): boolean {
  return e.code === 'VRAM_BUSY' && e.params?.utilization !== undefined;
}

/** The anchor nearest to `depth` (on a log scale): the speeds measured closest to it predict it best. */
export function nearestAnchor(anchors: readonly SpeedAnchor[], depth: number): SpeedAnchor | undefined {
  const gap = (a: SpeedAnchor) => Math.abs(Math.log(Math.max(1, depth) / Math.max(1, a.depth)));
  return anchors.reduce<SpeedAnchor | undefined>((best, a) => (best === undefined || gap(a) < gap(best) ? a : best), undefined);
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

/** What a search expects before it measures anything: speeds at known depths and the load time. */
export interface TuneExpect {
  /** Earlier runs of this model and engine on this GPU (their points), else one anchor from the model's size. */
  anchors: SpeedAnchor[];
  loadMs?: number;
}

export interface TunerInput {
  space: TuneSpace;
  budget: TuneBudget;
  /** Sweep shape (from the profile's context-sweep step): also the answer length of goal 'multi'. */
  sweep: { outputTokens: number; reps: number };
  /** Trained context of the model, or with YaRN the extended one (the search never goes above it). */
  modelContext?: number;
  /** Contexts the capacity search also tries when the estimate allows them (the YaRN targets, 300K / 500K). */
  contextCandidates?: readonly number[];
  /** VRAM estimate on the free VRAM measured before the search; undefined = no estimate (nothing pruned). */
  predict?: (params: LaunchParams) => FitEstimate | undefined;
  /** A model that does not fit can spill to shared memory (Windows / WDDM) instead of failing. */
  spillPossible: boolean;
  /** Last resort when nothing fits at the smallest context (llama.cpp only). */
  offload?: { layers: number; moe: boolean };
  fidelity: boolean;
  /** Absent = 'single'. */
  goal?: TuneGoal;
  /** Goal 'multi': users at once, context per user, messages per conversation, users 1 … N or N only ('exact'). */
  multi?: { users: number; perUserContext: number; turns: number; usersMode?: TuneUsersMode };
  /** Values tried first because they won before on this GPU (reported as is). */
  learned?: Tuning['learned'];
  /** Budget 'recheck'. */
  recheck?: RecheckInput;
  /** Expected speeds and load time (absent = DEFAULT_SPEED and DEFAULT_LOAD_MS). */
  expect?: TuneExpect;
  /** The time limit, overriding estimate × TIME_MARGIN (never below the budget's minimum). */
  limitMs?: number;
  /** The shortest deadline of a request (default REQUEST_TIMEOUT_MIN_MS; tests use less). */
  minRequestTimeoutMs?: number;
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
  skipped?: 'estimate' | 'no-gain' | 'budget' | 'cancelled' | 'failed';
  /** The run ended while this type was being searched (see Tuner.interrupted). */
  cut?: 'cancelled' | 'failed';
  /**
   * The context the engine said its KV cache holds (vLLM's report, NInfer's reservation), rounded down
   * to 1K: when it loads it is the limit, nothing to refine.
   */
  hinted?: number;
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
  /** A request of this launch was not made (the time limit): its sweep is only part of one. */
  cut?: boolean;
  /** The live watch saw it spill (what the monitor had read then): the launch is being given up. */
  tripped?: LaunchMemory;
}

export type Work = (engine: LabEngine, live: Live) => Promise<void>;

/** The search's own forecast: the whole search as expected when it started, and what is left now. */
export interface TuneForecast {
  totalMs: number;
  remainingMs: number;
}

/** Identity of a variant at a context. */
export function variantKey(v: Variant, ctx: number): string {
  const parts = Object.keys(v)
    .sort()
    .map((k) => `${k}=${String(v[k])}`);
  return `${ctx}|${parts.join(',')}`;
}

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

/** One point per nominal depth: the one measured with the most tokens (repetitions × answer length). */
export function pointsByDepth(points: readonly LatencyPoint[]): LatencyPoint[] {
  const best = new Map<number, LatencyPoint>();
  const weight = (p: LatencyPoint) => p.decodeTps.n * p.outputTokens;
  for (const p of points) {
    const d = nominalDepth(p.promptTokens);
    const cur = best.get(d);
    if (!cur || weight(p) > weight(cur)) best.set(d, p);
  }
  return [...best.values()].sort((a, b) => a.promptTokens - b.promptTokens);
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
  /** The reference launch's shared memory and context (what a launch that does not spill uses). */
  protected refShared: { sharedMiB?: number; context: number } | undefined;
  /** The reference launch's speeds (its 1K probe): every request's deadline is predicted from them. */
  protected refAnchor: SpeedAnchor | undefined;
  private fidelity: Tuning['fidelity'];
  /** Index of the start-up setting's value in use (space.startup). */
  private startupAt = 0;
  // ---- time
  private prepared = false;
  private estimateMs = 0;
  /** The time limit (ms from the start). */
  protected limitMs = 0;
  /** The limit was set again with the first start measured here (see rebase). */
  private rebased = false;
  /** Speeds measured so far (latest per nominal depth), seeded with the expected ones. */
  private readonly anchors = new Map<number, SpeedAnchor>();
  private readonly loads: number[] = [];
  /** The request or load in progress: when it started and how long it should take. */
  private inflight: { from: number; ms: number } | undefined;
  /** What is still planned on the launch in progress (ms each). */
  protected queue: number[] = [];
  // ---- what is done (the forecast counts the rest)
  protected refDone = false;
  protected readonly capacityDone = new Set<TuneKvType>();
  /** KV types whose capacity search came to its end (the others were not started, or are being searched). */
  protected readonly capacityEnded = new Set<TuneKvType>();
  /** Screens left of a KV type whose descent is under way; done types are in `descended`. */
  protected readonly descentLeft = new Map<TuneKvType, number>();
  protected readonly descended = new Set<TuneKvType>();
  protected readonly swept = new Set<TuneKvType>();
  private fidelityDone = false;

  constructor(
    protected readonly input: TunerInput,
    protected readonly deps: TunerDeps,
  ) {
    this.rules = BUDGETS[input.budget];
    this.cap = input.modelContext ?? DEFAULT_CONTEXT_CAP;
    this.min = Math.min(MIN_CONTEXT, this.cap);
    this.started = deps.now();
    const expected = input.expect?.anchors ?? [];
    for (const a of expected.length ? expected : [DEFAULT_SPEED]) this.anchors.set(nominalDepth(a.depth), a);
  }

  async run(): Promise<Tuning> {
    this.prepare();
    const { space } = this.input;
    this.deps.onPhase?.('tune-capacity');
    if (this.input.spillPossible) await this.reference(this.min);
    for (const kv of space.kvLadder) await this.searchCapacity(kv);
    const fitting = space.kvLadder.filter((kv) => this.capacity.get(kv)?.measuredMax !== undefined);
    if (fitting.length === 0 && this.input.offload) await this.offload(this.input.offload);
    const order = this.sweepOrder(fitting);
    const bests = new Map<TuneKvType, Variant>();
    for (const kv of order) {
      this.deps.onPhase?.('tune-variants');
      const best = await this.descend(kv);
      this.descended.add(kv);
      this.descentLeft.delete(kv);
      if (!best) continue;
      bests.set(kv, best.variant);
      await this.sweepCombination(best.variant, best.ctx);
      this.swept.add(kv);
    }
    const left = fitting.filter((kv) => this.capacity.get(kv)?.measuredMax !== undefined);
    if (left.length > 0) await this.extend(left, bests);
    await this.extraSweeps();
    if (this.input.fidelity) await this.checkFidelity();
    this.fidelityDone = true;
    this.addPartials();
    return this.snapshot();
  }

  /**
   * The order the fitting KV types are searched and swept in, what the result says first coming first
   * (the time limit cuts the last ones): the largest context (the recommendation comes from there), then
   * the best quality (the most precise type that fits: "con le impostazioni più fedeli"), then the rest
   * by context, the more precise first.
   */
  protected sweepOrder(fitting: readonly TuneKvType[]): TuneKvType[] {
    const bySize = [...fitting].sort((a, b) => this.maxOf(b) - this.maxOf(a) || kvPrecisionRank(a) - kvPrecisionRank(b));
    const precise = [...fitting].sort((a, b) => kvPrecisionRank(a) - kvPrecisionRank(b) || this.maxOf(b) - this.maxOf(a))[0];
    // Nothing fits, or the most precise type is also the one with the largest context: by context.
    if (precise === undefined || precise === bySize[0]) return bySize;
    return [bySize[0] as TuneKvType, precise, ...bySize.slice(1).filter((kv) => kv !== precise)];
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

  // ---- time: forecast, limit and requests --------------------------------------------------------

  /** Predictions before the first launch (the capacity candidates) and the estimate they give: once. */
  protected prepare(): void {
    if (this.prepared) return;
    this.prepared = true;
    this.predict();
    this.estimateMs = Math.round(this.plannedMs());
    const own = Math.round(this.estimateMs * TIME_MARGIN);
    this.limitMs = Math.max(this.rules.minMs, this.input.limitMs ?? own);
  }

  /**
   * The first launch that loaded measured an engine start and its 1K speed (a start expected to take
   * 15 s can take 100 s, a model read from a slow disk): the limit becomes (the time so far + the rest
   * as now predicted) × TIME_MARGIN when that is more. Once; never lowered; a limit the request set stays.
   */
  private rebase(): void {
    if (this.rebased) return;
    this.rebased = true;
    if (this.input.limitMs !== undefined) return;
    const ms = this.deps.now() - this.started + this.currentWorkMs() + this.plannedMs();
    this.limitMs = Math.max(this.limitMs, Math.round(ms * TIME_MARGIN));
  }

  /** Expected ms of the work of the launch in progress that plannedMs does not count (asked after its 1K probe). */
  protected currentWorkMs(): number {
    return 0;
  }

  /** The capacity candidates of every KV type (goal 'multi': whether it holds the users). */
  protected predict(): void {
    for (const kv of this.input.space.kvLadder) this.capacity.set(kv, this.predictCapacity(kv));
  }

  /** The estimate of the whole search and its time limit, ms (before it runs: the plan's duration). */
  time(): { estimateMs: number; limitMs: number } {
    this.prepare();
    return { estimateMs: this.estimateMs, limitMs: this.limitMs };
  }

  forecast(): TuneForecast {
    this.prepare();
    const now = this.deps.now();
    const f = this.inflight;
    // A request taking longer than predicted is expected to need a quarter of what it took so far.
    const current = f ? Math.max(f.ms - (now - f.from), (now - f.from) / 4) : 0;
    return { totalMs: this.estimateMs, remainingMs: Math.round(current + this.queue.reduce((a, b) => a + b, 0) + this.plannedMs()) };
  }

  /** Expected ms of an engine start (the loads measured here, else the expected one). */
  protected loadMs(): number {
    return this.loads.length ? median(this.loads) : (this.input.expect?.loadMs ?? DEFAULT_LOAD_MS);
  }

  /** Expected ms of one request, from the speeds measured nearest to that depth. */
  protected requestMs(depth: number, outputTokens = this.input.sweep.outputTokens): number {
    return requestMsAt(depth, outputTokens, nearestAnchor([...this.anchors.values()], depth) as SpeedAnchor);
  }

  /** Repetitions of a depth: 1 when one request is predicted to take longer than SLOW_REQUEST_MS. */
  protected repsFor(depth: number, reps: number, outputTokens = this.input.sweep.outputTokens): number {
    return this.requestMs(depth, outputTokens) > SLOW_REQUEST_MS ? 1 : reps;
  }

  /**
   * Deadline of one request: max(30 s, 5 × its time predicted from the reference launch's speeds,
   * moved to its depth like every forecast); before the reference is measured (or without one, on
   * Linux) from the speeds measured nearest to that depth.
   */
  protected timeoutMs(depth: number, outputTokens: number): number {
    const anchor = this.refAnchor ?? (nearestAnchor([...this.anchors.values()], depth) as SpeedAnchor);
    const min = this.input.minRequestTimeoutMs ?? REQUEST_TIMEOUT_MIN_MS;
    return Math.round(Math.max(min, REQUEST_TIMEOUT_FACTOR * requestMsAt(depth, outputTokens, anchor)));
  }

  /** A request of `ms` started now ends within the limit (plus the grace). */
  protected fitsInTime(ms: number): boolean {
    return this.deps.now() - this.started + ms <= this.limitMs + TIME_GRACE_MS;
  }

  /** Remembers what a launch or a request really took: the next predictions use it. */
  protected learn(p: LatencyPoint): void {
    if (p.decodeTps.n > 0) this.anchors.set(nominalDepth(p.promptTokens), anchorOf(p));
  }

  /** Marks the work in progress for the forecast (cleared by settle). */
  protected busy(ms: number): void {
    this.inflight = { from: this.deps.now(), ms };
  }

  protected settle(): void {
    this.inflight = undefined;
  }

  /**
   * One depth on a loaded engine, within the time limit: `reps` requests (one when a request is slow),
   * none when even one would end past the limit (recorded on the attempt; the search then stops).
   */
  protected async measureAt(engine: LabEngine, live: Live, depth: number, reps: number, kind: 'tune-screen' | 'context-sweep'): Promise<LatencyPoint | undefined> {
    const out = this.input.sweep.outputTokens;
    const one = this.requestMs(depth, out);
    this.queue.shift();
    if (!this.fitsInTime(one)) {
      live.att.skipped = [...(live.att.skipped ?? []), { depth, predictedMs: Math.round(one) }];
      live.cut = true;
      this.stoppedBy ??= 'budget';
      this.queue = [];
      return undefined;
    }
    const n = this.repsFor(depth, reps, out);
    this.busy(one * n);
    try {
      const p = await engine.measure(depth, out, n, kind, { more: () => this.fitsInTime(one), timeoutMs: this.timeoutMs(depth, out) });
      this.learn(p);
      // The record stays shallow to deep whatever the order measured (its last point is its deepest).
      const at = live.att.points.findIndex((q) => q.promptTokens > p.promptTokens);
      live.att.points.splice(at < 0 ? live.att.points.length : at, 0, p);
      return p;
    } finally {
      this.settle();
    }
  }

  /**
   * `depths` on a loaded engine within the time limit (measureAt), the context full first (`deepest`,
   * when it is among them): when even it would end past the limit the others are still tried; past
   * any other that would, the deeper ones are left. Returns the points shallow to deep.
   */
  private async measureDepths(engine: LabEngine, live: Live, depths: readonly number[], deepest: number, reps: number, kind: 'tune-screen' | 'context-sweep'): Promise<LatencyPoint[]> {
    const order = fullContextFirst(depths, deepest);
    this.queue = order.map((d) => this.repsFor(d, reps) * this.requestMs(d));
    const points: LatencyPoint[] = [];
    for (const d of order) {
      const p = await this.measureAt(engine, live, d, reps, kind);
      if (p) points.push(p);
      else if (d !== deepest) break;
    }
    return points.sort((a, b) => a.promptTokens - b.promptTokens);
  }

  /** Expected ms of a launch measuring `depths` with `reps` repetitions each (the probe included). */
  protected launchMs(depths: readonly number[], reps: number): number {
    return this.loadMs() + this.requestMs(PROBE_DEPTH, PROBE_OUTPUT) + depths.reduce((a, d) => a + this.repsFor(d, reps) * this.requestMs(d), 0);
  }

  /** Sweep grid of a context for this budget. */
  protected gridOf(ctx: number): GridStep {
    return gridFor(ctx, this.rules.longGrid);
  }

  /**
   * Screening depths of a context: 1K, the middle and the deepest prompt. "Veloce" on a long context
   * (the ×4 grid) leaves the deepest prompt (minutes per request) to the sweep of the winner: it is
   * measured once per combination.
   */
  protected screenAt(ctx: number): number[] {
    const step = this.gridOf(ctx);
    const all = screenDepths(ctx, this.input.sweep.outputTokens, step);
    return step === 4 ? all.slice(0, -1) : all;
  }

  /** Screens of a KV type's descent: its base settings and every other value of every dimension. */
  protected screensOf(kv: TuneKvType): number {
    const base = this.base(kv);
    return 1 + this.input.space.dimensions.reduce((n, d) => n + d.values(base).filter((v) => v !== base[d.key]).length, 0);
  }

  /**
   * The largest context a KV type is expected to reach: measured once its capacity search ended, else
   * (not started, or under way) predicted; undefined = none.
   */
  private expectedMax(kv: TuneKvType, previous: number | undefined): number | undefined {
    const cap = this.capacity.get(kv) as Capacity;
    if (this.capacityEnded.has(kv)) return cap.measuredMax;
    const ladder = this.input.space.kvLadder;
    if (cap.candidates.length === 0) return kv === ladder[ladder.length - 1] && previous === undefined ? this.min : previous;
    return Math.max(cap.predictedMax ?? this.cap, previous ?? 0);
  }

  /** Expected ms of the work not started yet (goal 'single'). */
  protected plannedMs(): number {
    const out = this.input.sweep.outputTokens;
    const probe = this.loadMs() + this.requestMs(PROBE_DEPTH, PROBE_OUTPUT);
    let ms = this.input.spillPossible && !this.refDone ? probe : 0;
    let previous: number | undefined;
    for (const kv of this.input.space.kvLadder) {
      const ctx = this.expectedMax(kv, previous);
      const cap = this.capacity.get(kv) as Capacity;
      if (!this.capacityDone.has(kv) && cap.candidates.some((c) => c > (previous ?? 0))) ms += CAPACITY_LAUNCHES * probe;
      if (ctx === undefined) continue;
      previous = ctx;
      const step = this.gridOf(ctx);
      const screen = this.screenAt(ctx);
      if (!this.descended.has(kv)) ms += (this.descentLeft.get(kv) ?? this.screensOf(kv)) * this.launchMs(screen, this.rules.screenReps);
      // The sweep reuses the screening: nothing else to measure on a short context.
      const rest = sweepDepths(ctx, out, { step }).filter((d) => !screen.includes(d));
      if (!this.swept.has(kv) && rest.length) ms += this.launchMs(rest, this.input.sweep.reps);
    }
    if (this.input.fidelity && !this.fidelityDone) ms += 2 * (this.loadMs() + this.requestMs(FIDELITY_PROMPT, FIDELITY_TOKENS));
    return ms;
  }

  // ---- predictions and capacity -----------------------------------------------------------------

  /** True / false when the estimate says this launch fits (with slack) / does not; undefined = no estimate. */
  protected predictFits(params: LaunchParams): boolean | undefined {
    const est = this.input.predict?.(params);
    // The search launches now, with whatever else is open: what is free now counts, not the card's total.
    return est === undefined ? undefined : est.needMiB <= availableNowMiB(est) * PREDICT_SLACK;
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
    // The estimate itself (rounded down to 8K) is usually the answer: not only powers of two.
    const near = Math.floor(limit / CAPACITY_STEP) * CAPACITY_STEP;
    if (predicted !== undefined && near > this.min && !candidates.includes(near)) candidates.push(near);
    if (this.cap <= limit && !candidates.includes(this.cap)) candidates.push(this.cap);
    for (const c of this.input.contextCandidates ?? []) if (c > this.min && c <= Math.min(limit, this.cap) && !candidates.includes(c)) candidates.push(c);
    candidates.sort((a, b) => a - b);
    return { kv, ...(predicted !== undefined ? { predictedMax: predicted } : {}), candidates, status: new Map(), launched: new Set(), inferred: false };
  }

  /** The most precise KV type's base settings at a small context: the speed and the shared memory a spill is compared with. */
  protected async reference(ctx: number): Promise<void> {
    this.refDone = true;
    for (const kv of this.input.space.kvLadder) {
      const cap = this.capacity.get(kv) as Capacity;
      if (cap.candidates.length === 0) continue;
      const live = await this.launch('reference', this.base(kv), ctx);
      if (!live) return;
      cap.status.set(ctx, live.att.outcome === 'ok');
      cap.launched.add(ctx);
      if (live.att.outcome === 'ok') {
        const probe = live.att.points[0] as LatencyPoint;
        this.refDecode = probe.decodeTps.median;
        this.refAnchor = anchorOf(probe);
        this.refShared = { ...(live.att.sharedPeakMiB !== undefined ? { sharedMiB: live.att.sharedPeakMiB } : {}), context: ctx };
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
    this.capacityDone.add(kv);
    await this.findCapacity(kv);
    this.capacityEnded.add(kv);
  }

  /** The capacity search of one KV type (searchCapacity). */
  private async findCapacity(kv: TuneKvType): Promise<void> {
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
    await this.search(cap, this.base(kv));
  }

  /**
   * Largest candidate that loads with `variant` (quick checks only): the top unknown one first (the
   * estimate or the engine's own report is usually close), then a binary search; between the largest
   * that loads and the smallest that does not, contexts in steps of 8K are added until the two are
   * close (see refine). `work` runs on a launch that is the largest if it loads (vLLM's extensions:
   * the combination is measured on that same launch).
   */
  protected async search(cap: Capacity, variant: Variant, work?: Work): Promise<void> {
    let tried = false;
    for (;;) {
      const cands = cap.candidates;
      const okIdx = this.highestOk(cap);
      const failIdx = cands.findIndex((c, i) => i > okIdx && cap.status.get(c) === false);
      const hi = failIdx < 0 ? cands.length : failIdx;
      if (hi - okIdx <= 1) {
        if (!this.refine(cap, okIdx, failIdx)) break;
        continue;
      }
      // The top candidate first (the estimate is usually close), then a binary search.
      const next = tried ? Math.floor((okIdx + hi) / 2) : hi - 1;
      tried = true;
      const ctx = cands[next] as number;
      const live = await this.launch('capacity', variant, ctx, work && next === hi - 1 ? work : undefined);
      if (!live) {
        cap.skipped = 'budget';
        break;
      }
      cap.status.set(ctx, live.att.outcome === 'ok');
      cap.launched.add(ctx);
      if (live.sweep) this.addCombination(live);
      // The engine said how much fits: its exact capacity is the next candidate to try.
      if (this.applyHint(cap, live.hint)) tried = false;
    }
    const okIdx = this.highestOk(cap);
    if (okIdx < 0) return;
    cap.measuredMax = cap.candidates[okIdx] as number;
    cap.inferred = !cap.launched.has(cap.measuredMax);
  }

  /**
   * The largest context that loads and the smallest that does not are far apart (see capacitySettled):
   * their middle, rounded down to 8K, becomes a candidate. False = done. The context the engine said
   * fits is exact when it loads; when it did not (NInfer's reservation at a context that spills) the
   * search goes on below it like below any other context that did not fit.
   */
  private refine(cap: Capacity, okIdx: number, failIdx: number): boolean {
    if (okIdx < 0 || failIdx < 0 || this.hintHeld(cap)) return false;
    const lo = cap.candidates[okIdx] as number;
    const hi = cap.candidates[failIdx] as number;
    if (capacitySettled(lo, hi)) return false;
    cap.candidates.push(capacityMiddle(lo, hi));
    cap.candidates.sort((a, b) => a - b);
    return true;
  }

  protected highestOk(cap: Capacity): number {
    return cap.candidates.reduce((m, c, i) => (cap.status.get(c) === true ? i : m), -1);
  }

  /** The context the engine said its KV cache holds loaded: it is the limit. */
  private hintHeld(cap: Capacity): boolean {
    return cap.hinted !== undefined && cap.status.get(cap.hinted) === true;
  }

  /**
   * The engine reported how many tokens its KV cache holds (vLLM, NInfer's reservation): candidates
   * above are impossible, the exact capacity (rounded down to 1K) becomes one. True when that added a
   * candidate.
   */
  private applyHint(cap: Capacity, hint: number | undefined): boolean {
    if (hint === undefined) return false;
    const exact = Math.floor(hint / 1024) * 1024;
    cap.hinted = exact;
    for (const c of cap.candidates) if (c > hint) cap.status.set(c, false);
    if (exact < this.min || exact > this.cap || cap.candidates.includes(exact)) return false;
    cap.candidates.push(exact);
    cap.candidates.sort((a, b) => a - b);
    return true;
  }

  // ---- launches -------------------------------------------------------------------------------

  /** Another launch is allowed: under the cap, and its start and quick check end within the time limit. */
  private canLaunch(): boolean {
    if (this.launches >= this.rules.maxLaunches) this.stoppedBy ??= 'launches';
    else if (this.deps.now() - this.started + this.loadMs() + this.requestMs(PROBE_DEPTH, PROBE_OUTPUT) > this.limitMs) this.stoppedBy ??= 'budget';
    return this.stoppedBy === undefined;
  }

  /**
   * One launch: start, a quick probe, the spill checks, then `work` while it is still loaded.
   * Undefined when the budget does not allow another launch. Failures that would repeat on every
   * launch are thrown (the run fails with them); a start-up setting the engine refuses steps down and
   * the launch is made again. `params` overrides the variant's launch parameters.
   */
  protected async launch(stage: TuneStage, variant: Variant, ctx: number, work?: Work, params?: LaunchParams): Promise<Live | undefined> {
    this.prepare();
    for (;;) {
      if (!this.canLaunch()) return undefined;
      this.launches++;
      const v = params ? variant : this.withStartup(variant);
      const p = params ?? this.input.space.params(v, ctx);
      const index = this.attempts.length;
      const planned = await this.deps.lab.prepare(p, { stage, attempt: index });
      const pending = { stage, params: p, kvType: v.kv as TuneKvType, contextSize: ctx, points: [], command: planned.command, atMs: this.deps.now() - this.started, variant: { ...v } };
      this.update(pending);
      const live: Live = { att: { ...pending, outcome: 'ok', points: [] }, index, variant: v };
      this.busy(this.loadMs());
      const started = await planned.start(this.guardOf(live));
      this.settle();
      let retry = false;
      if (started.ok) {
        live.att.loadMs = started.loadMs;
        this.loads.push(started.loadMs);
        await this.drive(started.engine, live, work);
      } else {
        const e = started.error;
        if (started.loadMs !== undefined) live.att.loadMs = started.loadMs;
        if (live.tripped) {
          // Given up while it loaded: it was already in shared memory.
          markSpill(live.att, 'shared-memory');
          recordMemory(live.att, live.tripped);
        } else {
          retry = !params && this.stepDown(e);
          live.att.outcome = memoryError(e) ? 'oom' : 'error';
          live.att.error = e;
          if (!retry && FATAL_CODES.has(e.code)) {
            // The launch that showed it stays in the list (with its error), then the run fails with it.
            if (e.code !== 'CANCELLED') this.attempts.push(live.att);
            throw new AppError(e.code, e.message, { ...(e.params ? { params: e.params } : {}), ...(e.detail ? { detail: e.detail } : {}) });
          }
          const hint = failureHint(e);
          if (hint !== undefined) live.hint = hint;
        }
        this.attempts.push(live.att);
      }
      this.queue = [];
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

  /**
   * The live spill watch of a launch (Windows only, where a launch that does not fit spills instead of
   * failing): the first reading that crosses the rule marks it, and the runner gives the launch up.
   */
  private guardOf(live: Live): LaunchGuard | undefined {
    if (!this.input.spillPossible) return undefined;
    return (m) => {
      if (!live.tripped && this.spills(m, live.att.contextSize)) live.tripped = m;
      return live.tripped !== undefined;
    };
  }

  /**
   * Probe, spill checks and the work of a loaded engine; always stops it, after recording the attempt
   * (shown at once: a starved engine can take a while to stop).
   */
  private async drive(engine: LabEngine, live: Live, work: Work | undefined): Promise<void> {
    const att = live.att;
    const ctx = att.contextSize;
    try {
      // What the monitor read while it loaded: the live watch may not have had a reading yet.
      if (live.tripped || this.spills(engine.memory(), ctx)) return markSpill(att, 'shared-memory');
      // Never skipped: a second at most, and the spill checks need it.
      this.busy(this.requestMs(PROBE_DEPTH, PROBE_OUTPUT));
      const probe = await engine.measure(PROBE_DEPTH, PROBE_OUTPUT, 1, 'tune-probe', { timeoutMs: this.timeoutMs(PROBE_DEPTH, PROBE_OUTPUT) });
      this.settle();
      this.learn(probe);
      att.points.push(probe);
      this.rebase();
      const hint = engine.capacityHint();
      if (hint !== undefined) {
        live.hint = hint;
        att.kvTokens = hint;
      }
      if (live.tripped || this.spills(engine.memory(), ctx)) markSpill(att, 'shared-memory');
      else if (this.input.spillPossible && this.refDecode !== undefined && probe.decodeTps.median < SPILL_RATIO * this.refDecode) {
        // The same 1K prompt as the reference's probe: a slower generation here is not the context filling up.
        markSpill(att, 'decode-collapse');
      } else if (work) {
        await work(engine, live);
        // Memory taken while measuring (the KV cache filling up, compute buffers) can spill too.
        if (att.outcome === 'ok' && (live.tripped || this.spills(engine.memory(), ctx))) {
          markSpill(att, 'shared-memory');
          this.forget(live);
        }
      }
    } catch (e) {
      const data = toAppErrorData(e);
      // The live watch gave it up in the middle of a request (that request was aborted).
      if (live.tripped) markSpill(att, 'shared-memory');
      else if (watchdogFired(data)) {
        // Past its deadline, or no token for a minute: that slow, it reads from shared memory.
        markSpill(att, 'too-slow');
        att.error = data;
      } else if (data.code === 'CANCELLED') throw e;
      else {
        att.outcome = memoryError(data) ? 'oom' : 'error';
        att.error = data;
      }
      this.forget(live);
    } finally {
      this.settle();
      recordMemory(att, engine.memory());
      this.attempts.push(att);
      this.queue = [];
      this.update();
      await engine.stop();
    }
  }

  /** What a launch measured no longer counts (it spilled or failed after all). */
  protected forget(live: Live): void {
    this.screens.delete(this.key(live.variant, live.att.contextSize));
    delete live.sweep;
    delete live.users;
  }

  /**
   * Windows: the launch spilled to shared GPU memory (system RAM), judged on its peaks so far with
   * launchSpilled (spill.ts): Shared Usage over max(1024, the reference's + ~1 MiB per 1K tokens more
   * + 768) MiB, or the card full and Shared Usage 512 MiB over the reference's.
   */
  protected spills(m: LaunchMemory, ctx: number): boolean {
    return this.input.spillPossible && launchSpilled(this.refShared, ctx, { sharedMiB: m.sharedPeakMiB, dedicatedMiB: m.cardPeakMiB ?? m.vramPeakMiB, totalMiB: m.totalMiB });
  }

  /** Marks the attempt as a spill when the generation speed collapsed between two of these points. */
  protected collapsed(att: TuneAttempt, points: readonly LatencyPoint[]): boolean {
    if (!this.input.spillPossible || collapsedAt(points) === undefined) return false;
    markSpill(att, 'decode-collapse');
    return true;
  }

  /** Screening (screenAt) with the budget's repetitions, within the time limit; the deepest prompt first when it is screened. */
  private async screenWork(engine: LabEngine, live: Live): Promise<void> {
    const ctx = live.att.contextSize;
    const points = await this.measureDepths(engine, live, this.screenAt(ctx), maxDepth(ctx, this.input.sweep.outputTokens), this.rules.screenReps, 'tune-screen');
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
      const live = await this.launch('variant', base, ctx, (e, l) => this.screenWork(e, l));
      if (!live) return undefined;
      this.descentLeft.set(kv, Math.max(0, (this.descentLeft.get(kv) as number) - 1));
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
    return need <= availableNowMiB(est) * PREDICT_SLACK;
  }

  /** One dimension at a time at the type's largest context; returns the best screened settings. */
  private async descend(kv: TuneKvType): Promise<Screen | undefined> {
    this.descentLeft.set(kv, this.screensOf(kv));
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
        this.descentLeft.set(kv, Math.max(0, (this.descentLeft.get(kv) as number) - 1));
        if (dim.prune?.(values[i] as DimValue) && !this.estimateAllows(variant, current)) continue;
        // The last value tried (no later dimension has another value for it), and the winner: its full sweep runs on this same launch.
        const last = i === values.length - 1 && lastToTry(dims, d, variant);
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

  /**
   * The full sweep on a loaded engine, within the time limit: depths `reuse` already has (the same
   * configuration's screening, on this launch or another) are not measured again; the deepest prompt
   * (the context full) is measured first, then the depths in between.
   */
  protected async sweepWork(engine: LabEngine, live: Live, reuse: readonly LatencyPoint[], depthsOf?: (ctx: number, out: number) => number[]): Promise<void> {
    this.deps.onPhase?.('context-sweep');
    const { outputTokens, reps } = this.input.sweep;
    const ctx = live.att.contextSize;
    const have = new Set(reuse.map((p) => p.promptTokens));
    const all = depthsOf ? depthsOf(ctx, outputTokens) : sweepDepths(ctx, outputTokens, { step: this.gridOf(ctx) });
    const points = await this.measureDepths(engine, live, all.filter((d) => !have.has(d)), maxDepth(ctx, outputTokens), reps, 'context-sweep');
    const sweep = [...reuse, ...points].sort((a, b) => a.promptTokens - b.promptTokens);
    if (this.collapsed(live.att, sweep)) {
      // It does not hold its deepest prompts after all: not a candidate any more.
      this.screens.delete(this.key(live.variant, ctx));
      return;
    }
    live.sweep = sweep;
  }

  protected addCombination(live: Live, why?: TuneCombination['partial']): void {
    const att = live.att;
    // A sweep the time limit cut is only part of one.
    const partial = why ?? (live.cut ? 'budget' : undefined);
    att.combination = this.combos.length;
    this.combined.add(this.key(live.variant, att.contextSize));
    this.swept.add(att.kvType);
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
      ...(partial ? { partial } : {}),
    });
    this.update();
  }

  /** Goal-specific fields of a new combination (goal 'multi': users and conversations). */
  protected combinationExtras(_live: Live): Partial<TuneCombination> {
    return {};
  }

  /**
   * The full sweep of a combination (unless it was measured already): its screening is reused, and
   * when the screening already measured every depth of the grid (a short context) it is the sweep,
   * with no other launch.
   */
  private async sweepCombination(variant: Variant, ctx: number): Promise<void> {
    const key = this.key(variant, ctx);
    if (this.combined.has(key)) return;
    // Every variant swept here was screened first (that is how it was chosen).
    const screen = this.screens.get(key) as Screen;
    const screened = screen.points;
    const have = new Set(screened.map((p) => p.promptTokens));
    if (sweepDepths(ctx, this.input.sweep.outputTokens, { step: this.gridOf(ctx) }).every((d) => have.has(d))) {
      const att = this.attempts[screen.attempt] as TuneAttempt;
      this.addCombination({ att, index: screen.attempt, variant, sweep: [...screened].sort((a, b) => a.promptTokens - b.promptTokens) });
      return;
    }
    const live = await this.launch('sweep', variant, ctx, (e, l) => this.sweepWork(e, l, screened));
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

  /**
   * The search stopped early (time limit or launch cap): at each KV type's largest context that has no
   * combination, what its launches measured there becomes one, "misurata in parte" — every screened
   * variant still in the running, else the launch that found the context (its 1K check).
   */
  protected addPartials(): void {
    const why = this.stoppedBy;
    if (!why) return;
    for (const kv of this.input.space.kvLadder) {
      const ctx = this.capacity.get(kv)?.measuredMax;
      if (ctx === undefined || this.combos.some((c) => c.kvType === kv && c.maxContext === ctx)) continue;
      const here = this.attempts
        .map((att, index) => ({ att, index }))
        .filter(({ att }) => att.kvType === kv && att.contextSize === ctx && att.outcome === 'ok' && att.combination === undefined && att.points.length > 0 && att.screen !== 'lost');
      const screened = here.filter(({ att }) => att.screen === 'kept');
      const picked = screened.length ? screened : here.slice(-1);
      // Every attempt of this run records its variant.
      for (const { att, index } of picked) this.addCombination({ att, index, variant: att.variant as Variant, sweep: pointsByDepth(att.points) }, why);
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

  /** What is known above a KV type's largest context (see Tuning.capacity.bound). */
  protected boundOf(c: Capacity): Pick<Tuning['capacity'][number], 'bound' | 'failedAt'> {
    // Candidates are kept sorted.
    const above = c.candidates.filter((x) => x > (c.measuredMax ?? 0));
    const failed = above.find((x) => c.status.get(x) === false);
    const known = failed !== undefined ? { failedAt: failed } : {};
    // The run ended while nothing tried for this type had loaded (at least one had failed: see interrupted).
    if (c.measuredMax === undefined) return c.cut ? { bound: c.cut, ...known } : {};
    const next = failed !== undefined && failed === above[0];
    // The very next context up did not fit, as close as the search goes (or the engine said this is its capacity): this is the limit.
    if (next && (capacitySettled(c.measuredMax, failed) || this.hintHeld(c))) return { bound: 'found', ...known };
    if (c.measuredMax >= this.cap) return { bound: 'model' };
    // The run ended before the search of this type did.
    if (c.cut) return { bound: c.cut, ...known };
    // A search leaves contexts untried above its largest (or between it and the smallest that did not fit) only when the time limit or the launch cap cut it.
    if (c.skipped === 'budget') return { bound: 'budget', ...known };
    // The next context up loaded for its check but did not hold its deepest prompt: the descent stepped down to this one.
    return next ? { bound: 'found', ...known } : { bound: 'estimate' };
  }

  /**
   * The run ended before the search did (cancelled, or a failure that would repeat on every launch):
   * the result keeps what was known. A KV type being searched (or not searched yet) holds at least the
   * largest context that loaded so far (bound 'cancelled' / 'failed'; none of those tried loaded: no
   * maximum, the same bound); one never launched says why it was not tried; what each type measured at
   * that context becomes a combination "misurata in parte", as when the time runs out.
   */
  interrupted(why: 'cancelled' | 'failed'): Tuning {
    this.stoppedBy = why;
    for (const [kv, cap] of this.capacity) {
      if (this.capacityEnded.has(kv)) continue;
      const ok = this.highestOk(cap);
      if (ok >= 0) {
        cap.measuredMax = cap.candidates[ok] as number;
        cap.inferred = !cap.launched.has(cap.measuredMax);
      }
      // Tried: one of its candidates is known to load or not (goal 'multi': its reference launch is not one).
      if (ok >= 0 || cap.candidates.some((c) => cap.status.get(c) === false)) cap.cut = why;
      else cap.skipped ??= why;
    }
    this.addPartials();
    return this.snapshot();
  }

  protected snapshot(): Tuning {
    const combos = this.combos.map((c) => ({ ...c }));
    const rec = this.recommend(combos);
    const t: Tuning = {
      budget: this.input.budget,
      ...(this.input.learned ? { learned: this.input.learned } : {}),
      maxLaunches: this.rules.maxLaunches,
      estimateSeconds: Math.round(this.estimateMs / 1000),
      limitSeconds: Math.round(this.limitMs / 1000),
      expectedLoadSeconds: Math.round((this.input.expect?.loadMs ?? DEFAULT_LOAD_MS) / 1000),
      ...(this.stoppedBy ? { stoppedBy: this.stoppedBy } : {}),
      dimensions: this.dimensionsTried(),
      capacity: [...this.capacity.values()].map((c) => ({
        kvType: c.kv,
        ...(c.predictedMax ? { predictedMax: c.predictedMax } : {}),
        ...(c.measuredMax !== undefined ? { measuredMax: c.measuredMax } : {}),
        // Deduced without a launch, then a later launch of this type (a screening, a sweep) loaded there after all.
        inferred: c.inferred && !this.loadedAt(c.kv, c.measuredMax),
        ...(c.skipped ? { skipped: c.skipped } : {}),
        ...this.boundOf(c),
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

  /** A launch of this KV type (any stage) loaded at exactly this context and held it. */
  private loadedAt(kv: TuneKvType, ctx: number | undefined): boolean {
    return this.attempts.some((a) => a.kvType === kv && a.contextSize === ctx && a.outcome === 'ok');
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

/** The attempt spilled, seen this way. */
function markSpill(att: TuneAttempt, how: NonNullable<TuneAttempt['spill']>): void {
  att.outcome = 'spill';
  att.spill = how;
}

/** The launch's memory peaks on its attempt. */
function recordMemory(att: TuneAttempt, m: LaunchMemory): void {
  if (m.vramPeakMiB !== undefined) att.vramPeakMiB = m.vramPeakMiB;
  if (m.sharedPeakMiB !== undefined) att.sharedPeakMiB = m.sharedPeakMiB;
}
