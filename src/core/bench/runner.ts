import path from 'node:path';
import type { EngineConfig, EngineKind, LaunchParams } from '../../contract/engines';
import { AppError, isAppError, toAppErrorData, type AppErrorData } from '../../contract/errors';
import type { CurrentStep, LivePoint, LiveSpill, RunPhase, ServerEvent } from '../../contract/events';
import type { GpuSample, HardwareFingerprint } from '../../contract/hardware';
import type { FitFixes } from '../../contract/models';
import {
  METRICS_FORMULA_VERSION,
  RESULT_SCHEMA_VERSION,
  type ConcurrencyPoint,
  type ContextSweepStep,
  type KvCapacity,
  type LatencyPoint,
  type LaunchRecord,
  type Metrics,
  type RunResult,
  type RunStatus,
  type Scenario,
  type SessionsPoint,
  type SessionsStep,
  type Spill,
  type Step,
  type Tuning,
} from '../../contract/results';
import type { Clock, ExitInfo } from '../deps';
import { LOG_HEAD_LINES, omittedCount, omittedLine } from '../engines/log-buffer';
import { parseKvCapacity } from '../engines/shared/kv-capacity';
import { LoadTracker } from '../engines/shared/load-progress';
import { toLaunchRecord, type EngineAdapter, type EngineInstance, type LaunchPlan, type ModelTarget } from '../engines/types';
import type { GenerateRequest, InferenceClient, StreamEvent } from '../inference/types';
import type { RunsRepo } from '../store/runs-repo';
import { contextOf, engineLabelOf, summaryOf } from '../store/runs-repo';
import { PROCESS_VRAM_INTERVAL_MS } from '../telemetry/process-vram';
import type { GpuUser, ProcessVramSession, ProcessVramTick, TelemetrySampler, TelemetrySession } from '../telemetry/types';
import {
  aggregateConcurrency,
  aggregateLatency,
  coldReadSpeed,
  downsampleTelemetry,
  energyOverWindows,
  fromStream,
  maxTemp,
  othersDriftMiB,
  primaryGpu,
  throttling,
  toLoadPhases,
  vram,
  type LoadPhase,
  type RequestMetrics,
  type Window,
} from './metrics';
import { buildPrompt, buildTextPrompt, CHARS_PER_TOKEN, getCorpusTokens } from './prompts';
import { DEFAULT_EXPECTATIONS, isLlamaCpp, requestSeconds, stepSeconds } from './scenarios';
import { scoreRun, type ScoreReference } from './score';
import { summarize } from './stats';
import { runSessions } from './steps/sessions';
import { cpuOffloaded, spillOf, spillPossible, type NormalDecode } from './spill';
import { runSweep } from './sweep';
import { createTuner } from './tune-run';
import type { LabEngine, LaunchGuard, LaunchMemory, Tuner, TuneLab, TunerInput } from './tuner';
import { computeValidity, describeGpuUser, isVramApproximate, sharedGpuUsers, VRAM_DRIFT_MIN_MIB, vramBusy } from './validity';
import { STALL_RULES, watchStream, type StallRules } from './watchdog';

export type Redactor = (argv: string[], env: Record<string, string>) => { argv: string[]; env: Record<string, string> };

/** Launch record with secrets redacted (when a redactor is given) in argv, env and the display strings. */
export function launchRecordOf(
  plan: LaunchPlan,
  display: RunnerDeps['displayCommand'],
  redact: Redactor | undefined,
): LaunchRecord {
  const shown = redact ? redact(plan.argv, plan.env) : { argv: plan.argv, env: plan.env };
  return toLaunchRecord({ ...plan, ...shown }, display(shown.argv, shown.env));
}

export interface LlamaBenchResult {
  test: string;
  tps: number;
  stddev: number;
}

export interface RunnerDeps {
  clock: Clock;
  adapter: EngineAdapter;
  telemetry: TelemetrySampler;
  runs: Pick<RunsRepo, 'save'>;
  publish: (e: ServerEvent) => void;
  fingerprint: () => Promise<HardwareFingerprint>;
  /** Ready-to-paste command lines (quoting lives with the engines). Receives already-redacted values. */
  displayCommand: (argv: string[], env: Record<string, string>) => { powershell: string; bash: string };
  /** Hides secrets (API keys, HF token) before argv/env are stored or shown; absent = stored as planned. */
  redact?: Redactor;
  /** Drops the OS file cache for the model files; absent = cold loads are not guaranteed. */
  evictCache?: (files: string[]) => Promise<{ guaranteed: boolean }>;
  /** Runs llama-bench for the plan's model (llama.cpp native only); absent = the step is skipped. */
  llamaBench?: (
    plan: LaunchPlan,
    step: Extract<Step, { kind: 'llama-bench' }>,
    signal: AbortSignal,
  ) => Promise<LlamaBenchResult[]>;
  appVersion: string;
  /** Token cache for the corpus lives under cacheDir/tokens. */
  cacheDir: string;
  /** The benchmark corpus text (loaded once by the caller). */
  corpus: () => Promise<string>;
  scoreReference?: () => Promise<ScoreReference | undefined>;
  /** PIDs of processes GPU Bench itself started (never counted as "other GPU users"). */
  ownPids: () => number[];
  telemetryIntervalMs?: number;
  /** Max wait for VRAM to drop back to the baseline between loads. */
  vramSettleMs?: number;
  /** When a streamed request counts as stalled (default STALL_RULES: no event for a minute; tests use less). */
  stall?: StallRules;
}

export interface RunInput {
  runId: string;
  engineConfig: EngineConfig;
  model: ModelTarget;
  params: LaunchParams;
  /** Already fitted to the engine configuration (see fitScenario). */
  scenario: Scenario;
  port: number;
  marker: string;
  allowSharedGpu: boolean;
  note?: string;
  /** The model is read through a 9p/drvfs share (Docker Desktop on Windows, WSL /mnt/c). */
  slowSharedFilesystem?: boolean;
  /** VRAM estimate shown next to the measurement. */
  vramEstimateMiB?: number;
  /** Planning notes (skipped steps…), kept in the log excerpt. */
  notes?: string[];
  /** Planning warnings as codes for the renderer (stored in RunResult.notes). */
  warnings?: RunNote[];
  /** Profile "tune": what to search (see tuner.ts); the runner provides the engine launches. */
  tune?: TunerInput;
  /** Usual start → ready time of this model with this engine on this PC (past runs), for run.load. */
  expectedLoadMs?: { cold?: number; warm?: number };
  /** Usual generation speed of this model and engine on this GPU (earlier runs that did not spill): a collapse below 0.4× is a spill. */
  normalDecode?: NormalDecode;
  /** What would fit, from the VRAM estimate made at the start (kept with a spill: "Riprova con…"). */
  fitFixes?: FitFixes;
}

/** A localized note on the run (RunResult.notes): planning warnings and skipped steps. */
export interface RunNote {
  code: string;
  params?: Record<string, unknown>;
}

/** Bounds of the stored server log. */
export const LOG_EXCERPT_LINES = 400;
export const LOG_EXCERPT_BYTES = 64 * 1024;
/** run.log batching: flush after this many lines or this much time. */
const LOG_BATCH_LINES = 100;
const LOG_BATCH_MS = 250;
/** Max wait for log streams to end at cleanup. */
const LOG_DRAIN_MS = 1000;
/** VRAM within this much of the baseline counts as "back to baseline". */
const VRAM_SETTLE_SLACK_MIB = 512;
/** First-token probe: ~16 tokens of text. */
const FIRST_TOKEN_PROMPT_CHARS = 64;
/** A tune run re-sends its progress and time left at least this often (on the telemetry heartbeat). */
export const PHASE_HEARTBEAT_MS = 5000;
/** Engines in containers: an instance PID (if any) is a docker CLI helper, never the engine. */
const CONTAINER_KINDS: ReadonlySet<EngineKind> = new Set<EngineKind>(['llamacpp-docker', 'vllm-docker', 'sglang-docker']);

/** The engine process is ours and visible to the OS (native llama.cpp / vLLM): its VRAM can be read per process. */
function pidAttributable(kind: EngineKind): boolean {
  return kind !== 'external' && !CONTAINER_KINDS.has(kind);
}

const UNKNOWN_HARDWARE: HardwareFingerprint = {
  hostId: 'unknown',
  hostLabel: 'unknown',
  gpus: [],
  cpu: { model: 'unknown', cores: 0, threads: 0 },
  ramBytes: 0,
  os: { platform: 'other', release: '', arch: '', name: 'unknown', isWsl: false },
};

type LoadKind = { cache: 'cold' | 'warm'; measured: boolean };

/** Mutable state of one run: everything measured so far, so a failed run still saves partial data. */
interface RunState {
  input: RunInput;
  signal: AbortSignal;
  origin: number;
  phase: RunPhase;
  doneUnits: number;
  totalUnits: number;
  hardware?: HardwareFingerprint;
  telemetryOn: boolean;
  baseline: GpuSample[];
  otherUsers: GpuUser[];
  plan?: LaunchPlan;
  launch?: LaunchRecord;
  session?: TelemetrySession;
  samples: GpuSample[];
  /** Per-process VRAM of the engine (absent when the OS cannot attribute it). */
  procVram?: ProcessVramSession;
  procTicks: ProcessVramTick[];
  procPeakMiB?: number;
  /** An engine instance with an attributable PID was started. */
  enginePidSeen: boolean;
  marks: { t: number; label: string }[];
  instance?: EngineInstance;
  instanceLabel: string;
  instanceExit?: ExitInfo;
  logBuffer: string[];
  lastFlush: number;
  pumps: Promise<void>[];
  logBlocks: { label: string; lines: string[] }[];
  notes: string[];
  codes: RunNote[];
  coldMs: number[];
  warmMs: number[];
  coldPhases?: LoadPhase[];
  firstPhases?: LoadPhase[];
  coldGuaranteed?: boolean;
  firstTokenMs?: number;
  corpus: string;
  tokens?: number[];
  bos?: number;
  requestSeq: number;
  requestExample?: Record<string, unknown>;
  latency: LatencyPoint[];
  contextSweep: LatencyPoint[];
  measured: RequestMetrics[];
  concurrency: ConcurrencyPoint[];
  sessions: SessionsPoint[];
  /** "Contesto tenuto in memoria" from the last engine start's log. */
  kvCapacity?: KvCapacity;
  /** The engine start in progress (run.load), until publishLaunch. */
  loading?: LoadTracker;
  llamaBench: LlamaBenchResult[];
  outputExact: boolean;
  tokensApproximate: boolean;
  /** Telemetry samples as they arrive (per-launch VRAM peaks of the tuner without per-process counters). */
  liveSamples: GpuSample[];
  /** Profile "tune": the search so far, and each attempt's launch record (by attempt index). */
  tuning?: Tuning;
  tuneRecords: Map<number, LaunchRecord>;
  /** Monotonic ms when the search started, and the search itself (its forecast drives the progress). */
  tuneStart?: number;
  tuner?: Tuner;
  /** Monotonic ms of the last run.phase: a tune run re-sends its progress every few seconds. */
  lastPhaseAt: number;
  /** Normal runs: the spill shown on the live screen so far (run.spill). */
  liveSpill?: LiveSpill;
  /** Profile "tune": the launch in progress, watched from its start to its stop (see watchLaunch). */
  launchWatch?: LaunchWatch;
}

/** A tune launch under the search's spill watch: given up (its signal aborted) the moment the guard says so. */
interface LaunchWatch {
  /** Monotonic ms of the engine start (its memory is read from here). */
  from: number;
  guard?: LaunchGuard;
  abort: AbortController;
  /** The run's signal and the launch's: every request and the wait for ready of this launch. */
  signal: AbortSignal;
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new AppError('CANCELLED', 'Run cancelled');
}

/**
 * Load order: cold and warm loads interleaved (cold, warm, cold, warm…) so every cold load follows
 * an eviction and every warm load follows a load of the same file. When the scenario has no load
 * step but needs a server, one unmeasured start is added.
 */
export function loadSequence(scenario: Scenario): LoadKind[] {
  const count = (cache: 'cold' | 'warm') =>
    scenario.steps.reduce((n, s) => n + (s.kind === 'load' && s.cache === cache ? s.reps : 0), 0);
  const cold = count('cold');
  const warm = count('warm');
  const out: LoadKind[] = [];
  for (let i = 0; i < Math.max(cold, warm); i++) {
    if (i < cold) out.push({ cache: 'cold', measured: true });
    if (i < warm) out.push({ cache: 'warm', measured: true });
  }
  if (out.length === 0 && scenario.steps.some(needsServer)) out.push({ cache: 'warm', measured: false });
  return out;
}

/** Steps that send requests to the running server. */
function needsServer(step: Step): boolean {
  return step.kind === 'latency' || step.kind === 'concurrency' || step.kind === 'context-sweep' || step.kind === 'sessions';
}

/**
 * Context each user of a concurrency level can hold: llama.cpp splits its context across the slots
 * unless the KV cache is unified (then everyone shares the whole context, as with vLLM's pool).
 */
export function userContext(plan: Pick<LaunchPlan, 'kind' | 'argv' | 'params'>): { contextPerUser?: number; contextShared?: boolean } {
  const ctx = contextOf(plan);
  if (ctx === undefined) return {};
  if (!isLlamaCpp(plan.kind)) return { contextPerUser: ctx, contextShared: true };
  const slots = plan.params.parallel ?? 1;
  if (slots <= 1) return { contextPerUser: ctx, contextShared: false };
  return plan.argv.includes('--kv-unified') ? { contextPerUser: ctx, contextShared: true } : { contextPerUser: Math.floor(ctx / slots), contextShared: false };
}

/** Example request for the launch record: token arrays are summarized, long texts shortened. */
export function exampleBody(body: Record<string, unknown>): Record<string, unknown> {
  const prompt = body.prompt;
  if (Array.isArray(prompt)) return { ...body, prompt: `<${prompt.length} token ids>` };
  if (typeof prompt === 'string' && prompt.length > 200) return { ...body, prompt: `${prompt.slice(0, 200)}…` };
  return body;
}

/** A block's log split where the engine's own buffer (or LOG_HEAD_LINES) puts the end of its start. */
function splitBlock(lines: readonly string[]): { head: string[]; rest: string[]; omitted: number } {
  const at = lines.findIndex((l) => omittedCount(l) !== undefined);
  if (at < 0) return { head: lines.slice(0, LOG_HEAD_LINES), rest: lines.slice(LOG_HEAD_LINES), omitted: 0 };
  return { head: lines.slice(0, at), rest: lines.slice(at + 1), omitted: omittedCount(lines[at] as string) as number };
}

/**
 * Every block within `budget` lines: its header, its head (the engine start), "… N righe omesse …"
 * and the last lines. Heads share at most three quarters of the room (evenly, short heads leave
 * theirs to the others); tails fill the rest, the latest block first.
 */
function excerptLines(blocks: readonly { label: string; lines: readonly string[] }[], notes: readonly string[], budget: number): string[] {
  const parts = blocks.map((b) => ({ label: b.label, ...splitBlock(b.lines) }));
  const tailNotes = notes.length ? ['=== gpu-bench ===', ...notes] : [];
  const all = (keep: (p: (typeof parts)[number], i: number) => { head: number; rest: number }) => {
    const out: string[] = [];
    parts.forEach((p, i) => {
      const k = keep(p, i);
      const omitted = p.head.length - k.head + p.omitted + p.rest.length - k.rest;
      out.push(`=== ${p.label} ===`, ...p.head.slice(0, k.head), ...(omitted > 0 ? [omittedLine(omitted)] : []), ...p.rest.slice(p.rest.length - k.rest));
    });
    return [...out, ...tailNotes];
  };
  const full = all((p) => ({ head: p.head.length, rest: p.rest.length }));
  // Header + marker per block, the notes, and at least one line per block.
  const fixed = parts.length * 2 + tailNotes.length;
  if (full.length <= budget || budget < fixed + parts.length) return full.slice(-budget);
  const room = budget - fixed;
  const restTotal = parts.reduce((n, p) => n + p.rest.length, 0);
  let headRoom = Math.min(room - Math.min(restTotal, Math.floor(room / 4)), Math.floor((room * 3) / 4));
  const heads = new Map<number, number>();
  const byLength = parts.map((p, i) => ({ i, n: p.head.length })).sort((x, y) => x.n - y.n);
  byLength.forEach((h, k) => {
    const share = Math.min(h.n, Math.floor(headRoom / (byLength.length - k)));
    heads.set(h.i, share);
    headRoom -= share;
  });
  let tailRoom = room - [...heads.values()].reduce((n, x) => n + x, 0);
  const rests = new Map<number, number>();
  for (let i = parts.length - 1; i >= 0; i--) {
    const take = Math.min((parts[i] as (typeof parts)[number]).rest.length, tailRoom);
    rests.set(i, take);
    tailRoom -= take;
  }
  return all((_, i) => ({ head: heads.get(i) as number, rest: rests.get(i) as number }));
}

/**
 * Every instance's log within LOG_EXCERPT_LINES lines and LOG_EXCERPT_BYTES: per block its start
 * (what was loaded, up to ready), "… N righe omesse …" and its last lines; then the run's notes.
 */
export function buildLogExcerpt(blocks: readonly { label: string; lines: readonly string[] }[], notes: readonly string[]): string {
  let budget = LOG_EXCERPT_LINES;
  let text = excerptLines(blocks, notes, budget).join('\n');
  while (Buffer.byteLength(text, 'utf8') > LOG_EXCERPT_BYTES && budget > 1) {
    budget = Math.max(1, Math.floor(budget * 0.9));
    text = excerptLines(blocks, notes, budget).join('\n');
  }
  return Buffer.byteLength(text, 'utf8') > LOG_EXCERPT_BYTES ? text.slice(-LOG_EXCERPT_BYTES / 4) : text;
}

/**
 * Runs one benchmark: prepare → loads (cold/warm) → latency → concurrency → llama-bench →
 * cleanup → metrics → save. A RunResult is ALWAYS saved (status completed / failed / cancelled)
 * and the engine is always stopped. Only instances started by this run are ever stopped.
 *
 * Events: run.phase (with 0..1 progress), run.live, run.log (batched), telemetry, then run.error
 * (failed/cancelled only) and finally run.done (summary.status tells the outcome) + runs.changed.
 */
export class BenchRunner {
  private readonly deps: RunnerDeps;

  constructor(deps: RunnerDeps) {
    this.deps = deps;
  }

  async run(input: RunInput, signal: AbortSignal): Promise<RunResult> {
    const d = this.deps;
    const createdAt = new Date(d.clock.wall()).toISOString();
    const s: RunState = {
      input,
      signal,
      origin: d.clock.now(),
      phase: 'prepare',
      doneUnits: 0,
      totalUnits: this.totalUnits(input.scenario),
      telemetryOn: false,
      baseline: [],
      otherUsers: [],
      samples: [],
      procTicks: [],
      enginePidSeen: false,
      marks: [],
      instanceLabel: '',
      logBuffer: [],
      lastFlush: d.clock.now(),
      pumps: [],
      logBlocks: [],
      notes: [...(input.notes ?? [])],
      codes: [...(input.warnings ?? [])],
      coldMs: [],
      warmMs: [],
      corpus: '',
      requestSeq: 0,
      latency: [],
      contextSweep: [],
      measured: [],
      concurrency: [],
      sessions: [],
      llamaBench: [],
      outputExact: true,
      tokensApproximate: false,
      liveSamples: [],
      tuneRecords: new Map(),
      lastPhaseAt: d.clock.now(),
    };
    let status: RunStatus = 'completed';
    let error: AppErrorData | undefined;
    try {
      await this.execute(s);
    } catch (e) {
      status = signal.aborted ? 'cancelled' : 'failed';
      error = signal.aborted ? { code: 'CANCELLED', message: 'Run cancelled' } : this.explain(e, s);
    }
    await this.cleanup(s);
    const result = await this.compose(s, status, error, createdAt);
    let file: string;
    try {
      file = await d.runs.save(result);
    } catch (e) {
      d.publish({ type: 'run.error', runId: input.runId, error: toAppErrorData(e) });
      throw e;
    }
    if (error) d.publish({ type: 'run.error', runId: input.runId, error });
    d.publish({ type: 'run.done', runId: input.runId, summary: summaryOf(result, path.basename(file)) });
    d.publish({ type: 'runs.changed' });
    return result;
  }

  // ---- flow -------------------------------------------------------------------------------

  private async execute(s: RunState): Promise<void> {
    const { input, signal } = s;
    const d = this.deps;
    this.setPhase(s, 'prepare');
    s.hardware = await d.fingerprint().catch(() => undefined);
    // Planned first (pure, no side effects) so even a refused run records the command it would have run.
    const plan = await d.adapter.plan(input.engineConfig, input.model, input.params, {
      port: input.port,
      marker: input.marker,
    });
    s.plan = plan;
    s.launch = launchRecordOf(plan, d.displayCommand, d.redact);
    s.telemetryOn = await d.telemetry.available().catch(() => false);
    if (s.telemetryOn) {
      s.baseline = await d.telemetry.snapshot().catch(() => []);
      s.otherUsers = await d.telemetry.otherGpuUsers(d.ownPids()).catch(() => []);
      const shared = sharedGpuUsers(s.otherUsers);
      if (shared.length > 0) s.notes.push(`GPU shared with ${shared.map(describeGpuUser).join(', ')}`);
      const busy = input.allowSharedGpu ? undefined : vramBusy(s.otherUsers, s.baseline, input.vramEstimateMiB);
      if (busy) {
        const params = { names: busy.users.map((u) => u.name).join(', '), pids: busy.users.map((u) => u.pid).join(', ') };
        throw busy.reason === 'llm'
          ? new AppError('VRAM_BUSY', 'Other LLM servers are using the GPU', { params })
          : new AppError('VRAM_BUSY', 'Other processes hold the VRAM this model needs', {
              params: { ...params, freeMiB: busy.freeMiB, needMiB: busy.needMiB },
            });
      }
    }
    s.corpus = await d.corpus();
    if (s.telemetryOn) {
      s.session = d.telemetry.start(d.telemetryIntervalMs ?? 250, (samples) => {
        s.liveSamples.push(...samples);
        d.publish({ type: 'telemetry', samples });
        // Telemetry is the heartbeat: a spill shows as soon as the counters say (a tune launch is given up
        // at once), a long tune request keeps its time left current.
        this.watchSpill(s);
        this.watchLaunch(s);
        if (s.tuner && d.clock.now() - s.lastPhaseAt >= PHASE_HEARTBEAT_MS) this.publishPhase(s);
      });
      // Started before the first load: its first reading is the reference for other processes' drift.
      s.procVram = d.telemetry.startProcessVram
        ? await d.telemetry.startProcessVram(() => this.enginePids(s), PROCESS_VRAM_INTERVAL_MS).catch(() => undefined)
        : undefined;
    }
    this.advance(s, 1);
    checkAbort(signal);

    if (input.tune) {
      await this.tune(s, input.tune);
      return;
    }
    await this.loads(s, plan);
    for (const step of input.scenario.steps) {
      if (step.kind === 'latency') await this.latencyStep(s, step);
      else if (step.kind === 'context-sweep') await this.contextSweepStep(s, step);
      else if (step.kind === 'concurrency') await this.concurrencyStep(s, step, plan);
      else if (step.kind === 'sessions') await this.sessionsStep(s, step, plan);
    }
    const bench = input.scenario.steps.find((x): x is Extract<Step, { kind: 'llama-bench' }> => x.kind === 'llama-bench');
    if (bench) await this.llamaBenchStep(s, bench, plan);
  }

  private async loads(s: RunState, plan: LaunchPlan): Promise<void> {
    const d = this.deps;
    const seq = loadSequence(s.input.scenario);
    const counters = { cold: 0, warm: 0 };
    for (let i = 0; i < seq.length; i++) {
      const load = seq[i] as LoadKind;
      const n = ++counters[load.cache];
      const label = `${load.cache}-load ${n}`;
      this.setPhase(s, load.cache === 'cold' ? 'cold-load' : 'warm-load', String(n));
      if (i > 0) await this.waitVramSettled(s);
      if (load.cache === 'cold') {
        const evicted = d.evictCache ? await d.evictCache(plan.modelFiles) : { guaranteed: false };
        s.coldGuaranteed = (s.coldGuaranteed ?? true) && evicted.guaranteed;
      }
      checkAbort(s.signal);
      const total = seq.filter((l) => l.cache === load.cache && l.measured === load.measured).length;
      this.step(s, { kind: 'load', label: load.cache, rep: n, reps: total });
      const inst = await d.adapter.start(plan, s.signal);
      this.attach(s, inst, label);
      s.marks.push({ t: inst.t0, label });
      const ready = await inst.waitReady(s.signal);
      s.marks.push({ t: ready.tReady, label: 'ready' });
      this.publishLaunch(s, plan);
      const loadMs = ready.tReady - inst.t0;
      const phases = toLoadPhases(ready.phases, inst.t0, ready.tReady);
      s.firstPhases ??= phases;
      if (load.measured) {
        if (load.cache === 'cold') {
          s.coldMs.push(loadMs);
          s.coldPhases ??= phases;
        } else s.warmMs.push(loadMs);
        d.publish({ type: 'run.live', runId: s.input.runId, loadMs });
      }
      if (i === 0) await this.firstToken(s, inst);
      if (i < seq.length - 1) await this.stopInstance(s);
      this.advance(s, stepSeconds({ kind: 'load', cache: load.cache, reps: 1 }, DEFAULT_EXPECTATIONS));
    }
    if (s.instance && s.input.scenario.steps.some(needsServer)) await this.prepareCorpus(s, s.instance);
  }

  /** run.launch: the engine instance now in use (every load, every tune attempt). Ends its run.load. */
  private publishLaunch(s: RunState, plan: LaunchPlan): void {
    s.loading?.ready();
    s.loading = undefined;
    const kv = s.instance && !s.input.tune ? parseKvCapacity(s.instance.logTail(), plan.kind) : undefined;
    if (kv) s.kvCapacity = kv;
    const r = launchRecordOf(plan, this.deps.displayCommand, this.deps.redact);
    const contextSize = contextOf(plan);
    this.deps.publish({
      type: 'run.launch',
      runId: s.input.runId,
      launch: { params: plan.params, ...(contextSize !== undefined ? { contextSize } : {}), command: { argv: r.argv, ...r.display }, engineLabel: engineLabelOf(plan.engine) },
    });
  }

  /** run.step: what is measured right now. */
  private step(s: RunState, current: CurrentStep): void {
    this.deps.publish({ type: 'run.step', runId: s.input.runId, current });
  }

  /** run.point: a measurement so far (medians up to the last repetition). */
  private point(s: RunState, live: LivePoint): void {
    this.deps.publish({ type: 'run.point', runId: s.input.runId, live });
  }

  /** "First token after load": a ~16-token prompt with 1 output token right after ready (lazy init). */
  private async firstToken(s: RunState, inst: EngineInstance): Promise<void> {
    const req: GenerateRequest = {
      promptText: s.corpus.slice(0, FIRST_TOKEN_PROMPT_CHARS),
      outputTokens: 1,
      seed: s.input.scenario.seed,
      ...this.modelField(s),
    };
    this.step(s, { kind: 'first-token', outputTokens: 1 });
    const sentAt = this.deps.clock.now();
    const events = await this.collect(s, inst, req);
    const first = events.find((e) => e.kind === 'chunk' && ((e.tokens ?? 0) > 0 || e.textLen > 0));
    if (first) s.firstTokenMs = first.t - sentAt;
  }

  /** Tokenizes the corpus (cached per model); endpoints without /tokenize fall back to text prompts. */
  private async prepareCorpus(s: RunState, inst: EngineInstance): Promise<void> {
    const key = `${inst.client.flavor}:${s.input.model.identity.sha256 ?? s.input.model.identity.weakKey}`;
    try {
      const ct = await getCorpusTokens(inst.client, key, this.deps.cacheDir, { corpus: s.corpus, signal: s.signal });
      s.tokens = ct.tokens;
      if (ct.bos !== undefined) s.bos = ct.bos;
    } catch (e) {
      if (!(isAppError(e) && e.params?.reason === 'tokenize_unsupported')) throw e;
      s.tokensApproximate = true;
      s.notes.push('tokenize unsupported by the endpoint: prompts are text, token counts approximate');
    }
  }

  private async latencyStep(s: RunState, step: Extract<Step, { kind: 'latency' }>): Promise<void> {
    const inst = this.running(s);
    // Longest prompts first: prompt processing dominates them (phase "prefill"), short prompts
    // measure generation (phase "decode"), so the stepper only moves forward.
    for (const p of [...step.promptTokens].sort((a, b) => b - a)) {
      this.setPhase(s, p > 1024 ? 'prefill' : 'decode', String(p));
      s.marks.push({ t: this.deps.clock.now(), label: `latency ${p}` });
      const unit = stepSeconds({ ...step, promptTokens: [p], warmup: 0, reps: 1 }, DEFAULT_EXPECTATIONS);
      const point = await this.measurePoint(s, inst, { kind: 'latency', promptTokens: p, outputTokens: step.outputTokens, reps: step.reps, warmup: step.warmup }, () =>
        this.advance(s, unit),
      );
      s.latency.push(point);
    }
  }

  /**
   * "Contesto per gradi": the same engine, prompts filling the context deeper and deeper (depths
   * resolved by fitScenario), shallow first, within the step's time budget.
   */
  private async contextSweepStep(s: RunState, step: ContextSweepStep): Promise<void> {
    const inst = this.running(s);
    const d = this.deps;
    this.setPhase(s, 'context-sweep');
    const result = await runSweep(
      step.depths,
      async (depth) => {
        this.setPhase(s, 'context-sweep', String(depth));
        s.marks.push({ t: d.clock.now(), label: `context ${depth}` });
        const unit = requestSeconds(depth, step.outputTokens, DEFAULT_EXPECTATIONS);
        return this.measurePoint(s, inst, { kind: 'context-sweep', promptTokens: depth, outputTokens: step.outputTokens, reps: step.reps }, () => this.advance(s, unit));
      },
      { outputTokens: step.outputTokens, reps: step.reps, now: () => d.clock.now(), ...(step.maxSeconds !== undefined ? { maxMs: step.maxSeconds * 1000 } : {}) },
    );
    s.contextSweep = result.points;
    if (result.skippedFrom !== undefined) {
      s.notes.push(`context sweep stopped at ${result.skippedFrom} tokens: its time budget (${step.maxSeconds} s) was spent`);
      s.codes.push({ code: 'context_sweep_budget', params: { depth: result.skippedFrom, seconds: step.maxSeconds } });
    }
  }

  /**
   * One prompt length measured `reps` times (after `warmup` unmeasured requests): run.step before each
   * request, run.live and run.point (medians so far) after each measured one.
   */
  private async measurePoint(
    s: RunState,
    inst: EngineInstance,
    o: {
      kind: 'latency' | 'context-sweep' | 'tune-probe' | 'tune-screen';
      promptTokens: number;
      outputTokens: number;
      reps: number;
      warmup?: number;
      attempt?: number;
      /** Asked before every repetition after the first: false = stop here (the point keeps the ones made). */
      more?: () => boolean;
      /** Deadline of each request, ms (tune requests). */
      timeoutMs?: number;
    },
    onRequest?: () => void,
  ): Promise<LatencyPoint> {
    const shape = { promptTokens: o.promptTokens, outputTokens: o.outputTokens };
    const depth = o.kind === 'latency' ? {} : { depth: o.promptTokens };
    const warmup = o.warmup ?? 0;
    for (let w = 0; w < warmup; w++) {
      this.step(s, { kind: o.kind, ...shape, ...depth, rep: w + 1, reps: warmup, warmup: true });
      await this.measure(s, inst, o.promptTokens, o.outputTokens, o.kind, o.timeoutMs);
      onRequest?.();
    }
    const results: RequestMetrics[] = [];
    for (let r = 0; r < o.reps; r++) {
      if (r > 0 && o.more && !o.more()) break;
      this.step(s, { kind: o.kind, ...shape, ...depth, rep: r + 1, reps: o.reps });
      const m = await this.measure(s, inst, o.promptTokens, o.outputTokens, o.kind, o.timeoutMs);
      this.record(s, m);
      results.push(m);
      this.deps.publish({
        type: 'run.live',
        runId: s.input.runId,
        ttftMs: m.ttftMs,
        tokens: m.outputTokens,
        ...(m.decodeTps !== undefined ? { decodeTps: m.decodeTps } : {}),
        ...((m.prefillTpsEngine ?? m.prefillTpsClient) !== undefined ? { prefillTps: m.prefillTpsEngine ?? m.prefillTpsClient } : {}),
      });
      this.point(s, { stepKind: o.kind, point: aggregateLatency(results, shape), ...(o.attempt !== undefined ? { attempt: o.attempt } : {}) });
      onRequest?.();
    }
    const point = aggregateLatency(results, shape);
    // A short prompt that generates far slower than usual: the model spilled (shown at once).
    if (o.kind === 'latency' || o.kind === 'context-sweep') this.watchSpill(s, point);
    return point;
  }

  /** C closed-loop workers, each sending requestsPerWorker requests back to back. Failed requests count as errors. */
  private async concurrencyStep(s: RunState, step: Extract<Step, { kind: 'concurrency' }>, plan: LaunchPlan): Promise<void> {
    const inst = this.running(s);
    const d = this.deps;
    this.setPhase(s, 'concurrency');
    const slots = plan.params.parallel ?? 1;
    const shape = { promptTokens: step.promptTokens, outputTokens: step.outputTokens, ...userContext(plan) };
    for (const level of step.levels) {
      const unit = stepSeconds({ ...step, levels: [level] }, DEFAULT_EXPECTATIONS);
      if (isLlamaCpp(plan.kind) && level > slots) {
        s.notes.push(`concurrency level ${level} skipped: llama.cpp started with ${slots} slot(s)`);
        s.codes.push({ code: 'concurrency_level_skipped', params: { level, parallel: slots } });
        this.advance(s, unit);
        continue;
      }
      this.setPhase(s, 'concurrency', String(level));
      s.marks.push({ t: d.clock.now(), label: `concurrency ${level}` });
      s.concurrency.push(await this.concurrencyLevel(s, inst, level, { ...step, shape }));
      this.advance(s, unit);
    }
  }

  /**
   * One level of users at once: `level` closed-loop workers, each sending requestsPerWorker requests
   * back to back. Failed requests count as errors; run.step / run.point / run.live as it goes.
   */
  private async concurrencyLevel(
    s: RunState,
    inst: EngineInstance,
    level: number,
    o: { promptTokens: number; outputTokens: number; requestsPerWorker: number; shape: Parameters<typeof aggregateConcurrency>[3] },
  ): Promise<ConcurrencyPoint> {
    const d = this.deps;
    const results: (RequestMetrics | null)[] = [];
    const start = d.clock.now();
    const total = level * o.requestsPerWorker;
    const progress = () => this.step(s, { kind: 'concurrency', concurrency: level, promptTokens: o.promptTokens, outputTokens: o.outputTokens, rep: results.length, reps: total });
    progress();
    const worker = async () => {
      for (let k = 0; k < o.requestsPerWorker; k++) {
        checkAbort(s.signal);
        try {
          const m = await this.measure(s, inst, o.promptTokens, o.outputTokens, 'concurrency');
          if (!m.tokensExact) s.tokensApproximate = true;
          results.push(m);
        } catch (e) {
          // Cancelled, or the tune launch was given up (it spilled): not a failed request.
          if (this.requestSignal(s).aborted) throw e;
          results.push(null);
        }
        progress();
      }
    };
    await Promise.all(Array.from({ length: level }, worker));
    if (s.instanceExit) throw this.engineExited(s.instanceExit);
    const point = aggregateConcurrency(level, results, d.clock.now() - start, o.shape);
    this.point(s, { stepKind: 'concurrency', point });
    d.publish({ type: 'run.live', runId: s.input.runId, decodeTps: point.aggregateTps });
    return point;
  }

  /** "Conversazioni lunghe" (steps/sessions.ts) on the running engine: one level after the other. */
  private async sessionsStep(s: RunState, step: SessionsStep, plan: LaunchPlan): Promise<void> {
    const inst = this.running(s);
    const d = this.deps;
    this.setPhase(s, 'sessions');
    s.marks.push({ t: d.clock.now(), label: 'sessions' });
    const run = await this.sessionsOn(s, inst, plan, step);
    s.sessions = run.points;
    if (run.skippedFrom !== undefined) {
      s.notes.push(`long conversations stopped before ${run.skippedFrom} at once: the time budget (${step.maxSeconds} s) was spent`);
      s.codes.push({ code: 'sessions_budget', params: { sessions: run.skippedFrom, seconds: step.maxSeconds } });
    }
  }

  /** "Conversazioni lunghe" (steps/sessions.ts) on `inst`: one level after the other. */
  private sessionsOn(s: RunState, inst: EngineInstance, plan: LaunchPlan, step: SessionsStep): ReturnType<typeof runSessions> {
    const d = this.deps;
    const client = inst.client;
    // The same client, every message under the stall guard.
    const watched: InferenceClient = Object.assign(Object.create(client) as InferenceClient, {
      generate: (req: GenerateRequest, signal: AbortSignal) => this.watched(client, req, signal),
    });
    return runSessions(step, {
      client: watched,
      now: () => d.clock.now(),
      signal: this.requestSignal(s),
      seed: s.input.scenario.seed,
      ...(s.tokens ? { tokens: s.tokens } : {}),
      ...(s.bos !== undefined ? { bos: s.bos } : {}),
      corpus: s.corpus,
      ...this.modelField(s),
      nextRep: () => s.requestSeq++,
      // llama.cpp: one slot per conversation keeps its cache; vLLM shares one prefix cache.
      ...(isLlamaCpp(plan.kind) ? { slots: plan.params.parallel ?? 1 } : {}),
      step: (current) => this.step(s, current),
      point: (point) => this.point(s, { stepKind: 'sessions', point }),
      record: (m) => this.record(s, m),
      alive: () => {
        if (s.instanceExit) throw this.engineExited(s.instanceExit);
      },
      levelDone: (n) => this.advance(s, stepSeconds({ ...step, levels: [n] }, DEFAULT_EXPECTATIONS)),
      // vLLM counts its prefix-cache hits itself (/metrics).
      ...(client.prefixCache ? { prefixCache: () => (client.prefixCache as NonNullable<typeof client.prefixCache>).call(client, s.signal) } : {}),
    });
  }

  private async llamaBenchStep(s: RunState, step: Extract<Step, { kind: 'llama-bench' }>, plan: LaunchPlan): Promise<void> {
    const d = this.deps;
    if (!d.llamaBench || plan.kind !== 'llamacpp-native') {
      s.notes.push('llama-bench skipped: not available for this engine');
      s.codes.push({ code: 'llama_bench_unsupported' });
      return;
    }
    // llama-bench loads its own copy of the model: free the GPU first.
    await this.stopInstance(s);
    await this.waitVramSettled(s);
    this.setPhase(s, 'decode', 'llama-bench');
    this.step(s, { kind: 'llama-bench', promptTokens: step.pp, outputTokens: step.tg, reps: step.reps });
    s.llamaBench = await d.llamaBench(plan, step, s.signal);
    this.advance(s, stepSeconds(step, DEFAULT_EXPECTATIONS));
  }

  // ---- "Trova le impostazioni migliori" ----------------------------------------------------

  /** The search (tuner.ts) with this runner's engine launches; run.tune after every change. */
  private async tune(s: RunState, setup: TunerInput): Promise<void> {
    const d = this.deps;
    s.tuneStart = d.clock.now();
    const tuner = (s.tuner = createTuner(setup, {
      lab: this.tuneLab(s),
      now: () => d.clock.now(),
      onUpdate: (tuning, current) => {
        s.tuning = tuning;
        d.publish({ type: 'run.tune', runId: s.input.runId, tuning, ...(current ? { current } : {}) });
        this.publishPhase(s);
      },
      onPhase: (phase) => this.setPhase(s, phase),
    }));
    try {
      s.tuning = await tuner.run();
    } catch (e) {
      // Cancelled, or a failure that would repeat on every launch: the result keeps what the search knew.
      s.tuning = tuner.interrupted(s.signal.aborted ? 'cancelled' : 'failed');
      throw e;
    }
  }

  /**
   * Engine launches for the tuner: the same adapter, logs, telemetry and request machinery as the
   * normal loads (attach / waitReady / measure), one instance at a time, VRAM settled in between.
   */
  private tuneLab(s: RunState): TuneLab {
    const d = this.deps;
    const { input } = s;
    return {
      prepare: async (params, info) => {
        const plan = await d.adapter.plan(input.engineConfig, input.model, params, { port: input.port, marker: input.marker });
        const record = launchRecordOf(plan, d.displayCommand, d.redact);
        s.tuneRecords.set(info.attempt, record);
        return {
          command: { argv: record.argv, ...record.display },
          start: async (guard) => {
            await this.waitVramSettled(s);
            checkAbort(s.signal);
            const label = `tune ${info.attempt + 1} (${info.stage})`;
            this.step(s, { kind: 'load', label: info.stage });
            let inst: EngineInstance;
            try {
              inst = await d.adapter.start(plan, s.signal);
            } catch (e) {
              checkAbort(s.signal);
              return { ok: false, error: toAppErrorData(e) };
            }
            this.attach(s, inst, label);
            s.marks.push({ t: inst.t0, label });
            // From now until it is stopped, the search's guard reads its memory at every heartbeat.
            const abort = new AbortController();
            const watch: LaunchWatch = { from: inst.t0, abort, signal: AbortSignal.any([s.signal, abort.signal]), ...(guard ? { guard } : {}) };
            s.launchWatch = watch;
            let tReady: number;
            try {
              tReady = (await inst.waitReady(watch.signal)).tReady;
            } catch (e) {
              await this.stopInstance(s);
              checkAbort(s.signal);
              return { ok: false, error: toAppErrorData(e), loadMs: d.clock.now() - inst.t0 };
            }
            s.marks.push({ t: tReady, label: 'ready' });
            this.publishLaunch(s, plan);
            if (!s.tokens && !s.tokensApproximate) await this.prepareCorpus(s, inst);
            return { ok: true, loadMs: tReady - inst.t0, engine: this.labEngine(s, inst, plan, info.attempt, inst.t0) };
          },
        };
      },
    };
  }

  private labEngine(s: RunState, inst: EngineInstance, plan: LaunchPlan, attempt: number, from: number): LabEngine {
    return {
      measure: (depth, outputTokens, reps, kind, o = {}) => this.measurePoint(s, inst, { kind, promptTokens: depth, outputTokens, reps, attempt, ...o }),
      // "Più utenti": every user at once with the prompts of the whole context each one needs.
      concurrency: (level, promptTokens, outputTokens, requestsPerWorker) =>
        this.concurrencyLevel(s, inst, level, { promptTokens, outputTokens, requestsPerWorker, shape: { promptTokens, outputTokens, ...userContext(plan) } }),
      sessions: async (step) => (await this.sessionsOn(s, inst, plan, step)).points,
      memory: () => this.launchMemory(s, from),
      // vLLM's KV pool does not depend on max-model-len: what it holds is the largest context. (llama.cpp just echoes -c.)
      capacityHint: () => (isLlamaCpp(plan.kind) ? undefined : parseKvCapacity(inst.logTail(), plan.kind)?.tokens),
      generate: async (promptTokens, tokens) => {
        this.step(s, { kind: 'fidelity', promptTokens, outputTokens: tokens });
        const seed = s.input.scenario.seed;
        // The same prompt on every launch (fixed repetition and salt): the outputs are comparable.
        const prompt: Pick<GenerateRequest, 'promptIds' | 'promptText'> = s.tokens
          ? { promptIds: buildPrompt(s.tokens, promptTokens, 0, { seed, salt: 'fidelity', ...(s.bos !== undefined ? { bos: s.bos } : {}) }) }
          : { promptText: buildTextPrompt(s.corpus, promptTokens, 0, { seed, salt: 'fidelity' }) };
        const events = await this.collect(s, inst, { ...prompt, outputTokens: tokens, seed, ...this.modelField(s) });
        return events.flatMap((e): (number | string)[] => (e.kind !== 'chunk' ? [] : (e.ids ?? (e.text !== undefined ? [e.text] : []))));
      },
      stop: () => this.stopInstance(s),
    };
  }

  /**
   * Memory of the launch started at `from`: the engine process's own VRAM peak (and shared memory) when
   * the OS attributes it, else the peak total minus the baseline; and the card's dedicated memory in use
   * (every process, nvidia-smi) with its whole memory.
   */
  private launchMemory(s: RunState, from: number): LaunchMemory {
    const samples = s.liveSamples.filter((x) => x.t >= from);
    const gpu = primaryGpu(s.baseline, samples);
    const card = samples.filter((x) => x.gpu === gpu);
    const used = card.map((x) => x.memUsedMiB).filter((v): v is number => v !== null);
    const total = card.map((x) => x.memTotalMiB).find((v): v is number => v !== null);
    const cardMemory: LaunchMemory = {
      ...(used.length ? { cardPeakMiB: Math.round(Math.max(...used)) } : {}),
      ...(total !== undefined ? { totalMiB: total } : {}),
    };
    const ticks = (s.procVram?.samples ?? []).filter((t) => t.t >= from && t.engine.length > 0 && t.engineMiB > 0);
    if (ticks.length > 0) {
      const shared = ticks.map((t) => t.engineSharedMiB).filter((v): v is number => v !== undefined);
      return {
        vramPeakMiB: Math.round(Math.max(...ticks.map((t) => t.engineMiB))),
        ...(shared.length ? { sharedPeakMiB: Math.round(Math.max(...shared)) } : {}),
        ...cardMemory,
      };
    }
    const delta = vram(s.baseline, samples).deltaMiB;
    return { ...(delta === undefined ? {} : { vramPeakMiB: Math.round(delta) }), ...cardMemory };
  }

  /**
   * The search's spill watch of the tune launch in progress, at every telemetry heartbeat: the first
   * reading its guard says spilled gives the launch up at once (its load or the request in flight is
   * aborted, every later request fails; the search then stops it). Once given up, never asked again.
   */
  private watchLaunch(s: RunState): void {
    const w = s.launchWatch;
    if (!w?.guard || w.abort.signal.aborted) return;
    if (w.guard(this.launchMemory(s, w.from))) w.abort.abort(new AppError('CANCELLED', 'Launch given up: it spilled into shared memory'));
  }

  /** The signal of a request now: the run's, and the tune launch's while one is up. */
  private requestSignal(s: RunState): AbortSignal {
    return s.launchWatch?.signal ?? s.signal;
  }

  // ---- requests ---------------------------------------------------------------------------

  private modelField(s: RunState): { model?: string } {
    return s.input.model.servedName ? { model: s.input.model.servedName } : {};
  }

  /** One streamed request, whole, under the stall guard (and its deadline, if any). */
  private async collect(s: RunState, inst: EngineInstance, req: GenerateRequest, timeoutMs?: number): Promise<StreamEvent[]> {
    const events: StreamEvent[] = [];
    for await (const e of this.watched(inst.client, req, this.requestSignal(s), timeoutMs)) events.push(e);
    return events;
  }

  /** client.generate under the watchdogs (watchdog.ts): an engine that stops answering fails the request. */
  private watched(client: InferenceClient, req: GenerateRequest, signal: AbortSignal, timeoutMs?: number): AsyncIterable<StreamEvent> {
    // Every request is sent as token ids or, without a tokenizer, as text.
    const promptTokens = req.promptIds ? req.promptIds.length : Math.ceil((req.promptText as string).length / CHARS_PER_TOKEN);
    return watchStream((sig) => client.generate(req, sig), { signal, promptTokens, rules: this.deps.stall ?? STALL_RULES, timeoutMs });
  }

  /** One request with a fresh prompt (unique offset: never a prefix-cache hit). */
  private async measure(s: RunState, inst: EngineInstance, promptTokens: number, outputTokens: number, salt: string, timeoutMs?: number) {
    const rep = s.requestSeq++;
    const seed = s.input.scenario.seed;
    const prompt: Pick<GenerateRequest, 'promptIds' | 'promptText'> = s.tokens
      ? { promptIds: buildPrompt(s.tokens, promptTokens, rep, { seed, salt, ...(s.bos !== undefined ? { bos: s.bos } : {}) }) }
      : { promptText: buildTextPrompt(s.corpus, promptTokens, rep, { seed, salt }) };
    const req: GenerateRequest = { ...prompt, outputTokens, seed, ...this.modelField(s) };
    s.requestExample ??= exampleBody(inst.client.requestBody(req));
    const sentAt = this.deps.clock.now();
    const events = await this.collect(s, inst, req, timeoutMs);
    return fromStream(events, { sentAt, promptTokens, expectedOutput: outputTokens });
  }

  private record(s: RunState, m: RequestMetrics): void {
    s.measured.push(m);
    if (!m.outputExact) s.outputExact = false;
    if (!m.tokensExact) s.tokensApproximate = true;
  }

  /** loadSequence() always starts a server when latency/concurrency steps exist, and it runs until llama-bench/cleanup. */
  private running(s: RunState): EngineInstance {
    return s.instance as EngineInstance;
  }

  // ---- instances, logs, telemetry ---------------------------------------------------------

  /** PIDs whose VRAM is the engine's: the running instance, if its process is ours and attributable. */
  private enginePids(s: RunState): number[] {
    const pid = s.instance?.pid;
    return pid !== undefined && pidAttributable(s.input.engineConfig.kind) ? [pid] : [];
  }

  private attach(s: RunState, inst: EngineInstance, label: string): void {
    s.instance = inst;
    s.instanceLabel = label;
    s.instanceExit = undefined;
    if (this.enginePids(s).length > 0) s.enginePidSeen = true;
    inst.exited.then(
      (info) => {
        if (s.instance === inst) s.instanceExit = info;
      },
      () => undefined,
    );
    // run.load: what the engine is doing while it starts, from its log, until publishLaunch().
    const expected = s.input.expectedLoadMs?.[label.startsWith('cold') ? 'cold' : 'warm'];
    const loading = new LoadTracker({
      kind: s.input.engineConfig.kind,
      t0: inst.t0,
      now: () => this.deps.clock.now(),
      emit: (p) => this.deps.publish({ type: 'run.load', runId: s.input.runId, ...p }),
      ...(expected !== undefined ? { expectedMs: expected } : {}),
    });
    s.loading = loading;
    const pump = async () => {
      try {
        for await (const line of inst.logs) {
          loading.line(line.text, line.t);
          s.logBuffer.push(line.text);
          if (s.logBuffer.length >= LOG_BATCH_LINES || line.t - s.lastFlush >= LOG_BATCH_MS) this.flushLogs(s);
        }
      } catch {
        // A broken log stream is not a run failure: the excerpt still comes from logTail().
      }
      this.flushLogs(s);
    };
    s.pumps.push(pump());
  }

  private flushLogs(s: RunState): void {
    s.lastFlush = this.deps.clock.now();
    if (s.logBuffer.length === 0) return;
    const lines = s.logBuffer.splice(0);
    this.deps.publish({ type: 'run.log', runId: s.input.runId, lines });
  }

  /** Stops the instance this run started (and only that one), keeping its log tail. */
  private async stopInstance(s: RunState): Promise<void> {
    const inst = s.instance;
    if (!inst) return;
    s.instance = undefined;
    // A tune launch's watch ends with it.
    s.launchWatch = undefined;
    try {
      await inst.stop();
    } catch (e) {
      s.notes.push(`engine stop failed: ${toAppErrorData(e).message}`);
    }
    s.logBlocks.push({ label: s.instanceLabel, lines: inst.logTail() });
  }

  /** After a stop, waits (bounded) until total VRAM is back near the baseline, so loads do not overlap. */
  private async waitVramSettled(s: RunState): Promise<void> {
    const d = this.deps;
    if (!s.telemetryOn || s.baseline.length === 0) return;
    const baseline = s.baseline.reduce((sum, x) => sum + (x.memUsedMiB ?? 0), 0);
    const deadline = d.clock.now() + (d.vramSettleMs ?? 15_000);
    for (;;) {
      const snap = await d.telemetry.snapshot().catch(() => [] as GpuSample[]);
      const used = snap.reduce((sum, x) => sum + (x.memUsedMiB ?? 0), 0);
      if (used <= baseline + VRAM_SETTLE_SLACK_MIB) return;
      if (d.clock.now() >= deadline) {
        s.notes.push(`VRAM did not return to the baseline (${used} MiB used, baseline ${baseline} MiB)`);
        return;
      }
      await d.clock.sleep(250, s.signal);
    }
  }

  private async cleanup(s: RunState): Promise<void> {
    this.setPhase(s, 'cleanup');
    await this.stopInstance(s);
    if (s.session) s.samples = await s.session.stop().catch(() => [] as GpuSample[]);
    if (s.procVram) {
      s.procTicks = await s.procVram.stop().catch(() => [] as ProcessVramTick[]);
      s.procPeakMiB = s.procVram.peakMiB();
    }
    // Stopped engines close their log streams: let the pumps drain (bounded) so run.log precedes run.done.
    await Promise.race([Promise.allSettled(s.pumps), this.deps.clock.sleep(LOG_DRAIN_MS)]);
    this.flushLogs(s);
  }

  // ---- progress ---------------------------------------------------------------------------

  private totalUnits(scenario: Scenario): number {
    const loads = loadSequence(scenario).reduce(
      (n, l) => n + stepSeconds({ kind: 'load', cache: l.cache, reps: 1 }, DEFAULT_EXPECTATIONS),
      0,
    );
    const rest = scenario.steps
      .filter((x) => x.kind !== 'load')
      .reduce((n, x) => n + stepSeconds(x, DEFAULT_EXPECTATIONS), 0);
    return 1 + loads + rest;
  }

  /**
   * 0..1. A tune run: elapsed / max(its estimate, elapsed + what its forecast says is left), so it
   * keeps moving while a long request runs and never sits at the end while work remains.
   */
  private progress(s: RunState): number {
    if (s.tuner) {
      const elapsed = this.deps.clock.now() - (s.tuneStart as number);
      const f = s.tuner.forecast();
      return Math.min(0.98, elapsed / Math.max(1, f.totalMs, elapsed + f.remainingMs));
    }
    return Math.min(1, s.doneUnits / s.totalUnits);
  }

  private advance(s: RunState, units: number): void {
    s.doneUnits += units;
    this.publishPhase(s);
  }

  private setPhase(s: RunState, phase: RunPhase, detail?: string): void {
    this.flushLogs(s);
    s.phase = phase;
    if (phase !== 'prepare') s.marks.push({ t: this.deps.clock.now(), label: phase });
    this.publishPhase(s, detail);
  }

  private publishPhase(s: RunState, detail?: string): void {
    s.lastPhaseAt = this.deps.clock.now();
    const cleanup = s.phase === 'cleanup';
    // The search knows what is left (recomputed with the speeds it measured); other runs leave it to the renderer.
    const remaining = s.tuner && !cleanup ? Math.round(s.tuner.forecast().remainingMs / 1000) : undefined;
    this.deps.publish({
      type: 'run.phase',
      runId: s.input.runId,
      phase: s.phase,
      progress: cleanup ? Math.max(this.progress(s), 0.99) : this.progress(s),
      ...(detail ? { detail } : {}),
      ...(remaining !== undefined ? { remainingSeconds: remaining } : {}),
    });
  }

  // ---- spills (normal runs) ---------------------------------------------------------------

  /**
   * How a normal run spilled so far: Shared Usage of its engine over the threshold, or a collapse on a
   * short prompt against the usual speed. Undefined for tune runs (the tuner discards what spills).
   */
  private spillNow(s: RunState, extra: readonly LatencyPoint[] = []): Spill | undefined {
    const { input, plan } = s;
    if (input.tune || !plan) return undefined;
    const kind = input.engineConfig.kind;
    return spillOf({
      possible: kind !== 'external' && spillPossible(s.hardware?.os),
      sharedPeakMiB: s.procVram?.sharedPeakMiB(),
      context: contextOf(plan),
      points: [...s.latency, ...s.contextSweep, ...extra],
      normal: input.normalDecode,
      allOnGpu: !cpuOffloaded(kind, plan, input.model.identity.facts?.blockCount),
      fixes: input.fitFixes,
    });
  }

  /** run.spill when a spill is first seen, and again when it is seen another way or the shared memory grew by 10 % or more. */
  private watchSpill(s: RunState, point?: LatencyPoint): void {
    const spill = this.spillNow(s, point ? [point] : []);
    if (!spill) return;
    const last = s.liveSpill;
    const grew = (spill.sharedPeakMiB ?? 0) >= (last?.sharedPeakMiB ?? 0) * 1.1 + 64;
    if (last && spill.by.length <= last.by.length && !grew) return;
    const { fixes: _fixes, normalRunIds: _ids, ...live } = spill;
    s.liveSpill = live;
    this.deps.publish({ type: 'run.spill', runId: s.input.runId, spill: live });
  }

  // ---- errors -----------------------------------------------------------------------------

  private engineExited(info: ExitInfo): AppError {
    return new AppError('ENGINE_EXITED', `Engine exited during the run (code ${info.code ?? info.signal ?? 'unknown'})`, {
      params: { exitCode: info.code ?? -1, ...(info.signal ? { signal: info.signal } : {}) },
    });
  }

  /** Errors seen by the client after the engine died are reported as the engine exit. */
  private explain(e: unknown, s: RunState): AppErrorData {
    const data = toAppErrorData(e);
    if (s.instanceExit && (data.code === 'ENDPOINT_UNREACHABLE' || data.code === 'ENDPOINT_INVALID')) {
      return { ...this.engineExited(s.instanceExit).toJSON(), detail: data.message };
    }
    return data;
  }

  // ---- result -----------------------------------------------------------------------------

  private async compose(
    s: RunState,
    status: RunStatus,
    error: AppErrorData | undefined,
    createdAt: string,
  ): Promise<RunResult> {
    const d = this.deps;
    const { input } = s;
    const samples = s.samples;
    const gpu = primaryGpu(s.baseline, samples);
    const windows: Window[] = s.measured.map((m) => [m.firstAt, m.lastAt]);
    const decodeTokens = s.measured.reduce((n, m) => n + m.decodeTokens, 0);
    const en = energyOverWindows(samples, windows, decodeTokens);
    const vr = vram(s.baseline, samples);
    const gpuSamples = samples.filter((x) => x.gpu === gpu);
    const throttle = throttling(gpuSamples, windows.length ? windows : undefined);
    const temp = maxTemp(gpuSamples);
    const coldMs = s.coldMs.length ? summarize(s.coldMs) : undefined;
    const warmMs = s.warmMs.length ? summarize(s.warmMs) : undefined;
    const coldRead =
      // Cold phases are recorded together with the first cold load time.
      coldMs && s.plan ? coldReadSpeed(s.plan.modelBytes, s.coldPhases as LoadPhase[], coldMs.median) : undefined;
    const latency = [...s.latency].sort((a, b) => a.promptTokens - b.promptTokens);
    const kind = input.engineConfig.kind;
    // Headline VRAM: the engine's own peak when the OS attributes it, else peak total − baseline.
    const processPeakMiB = s.procPeakMiB;
    const method = processPeakMiB !== undefined ? 'process' : vr.deltaMiB !== undefined ? 'total-delta' : undefined;
    const drift = othersDriftMiB(s.procTicks, { engineHasPid: s.enginePidSeen });
    if (drift !== undefined && drift >= VRAM_DRIFT_MIN_MIB) s.notes.push(`other GPU processes changed their VRAM by up to ${drift} MiB during the run`);
    // Tune runs are described by their recommended combination: its command, its context sweep.
    const tuned = recommendedOf(s.tuning, s.tuneRecords);
    // The engine's shared GPU memory (Windows): a tune run's is its recommended launch's.
    const sharedPeakMiB = s.tuning ? tuned?.attempt.sharedPeakMiB : s.procVram?.sharedPeakMiB();
    const spill = this.spillNow(s);

    const metrics: Metrics = {
      formulaVersion: METRICS_FORMULA_VERSION,
      load: {
        ...(coldMs ? { coldMs } : {}),
        ...(warmMs ? { warmMs } : {}),
        ...(coldRead !== undefined ? { coldReadBytesPerSec: coldRead } : {}),
        phases: s.coldPhases ?? s.firstPhases ?? [],
      },
      ...(s.firstTokenMs !== undefined ? { firstTokenAfterLoadMs: s.firstTokenMs } : {}),
      latency,
      contextSweep: tuned?.combination.sweep ?? s.contextSweep,
      // A "Più utenti" tune run is described by its recommendation too: users 1 … N and the conversations.
      sessions: tuned?.combination.sessions ?? s.sessions,
      ...(s.kvCapacity ? { kvCapacity: s.kvCapacity } : {}),
      concurrency: tuned?.combination.concurrency ?? s.concurrency,
      llamaBench: s.llamaBench,
      vram: {
        ...vr,
        ...(input.vramEstimateMiB !== undefined ? { estimateMiB: input.vramEstimateMiB } : {}),
        ...(processPeakMiB !== undefined ? { processPeakMiB } : {}),
        ...(sharedPeakMiB !== undefined ? { sharedPeakMiB } : {}),
        ...(method ? { method } : {}),
      },
      ...(spill ? { spill } : {}),
      energy: {
        ...(en.avgPowerW !== undefined ? { avgPowerW: en.avgPowerW } : {}),
        ...(en.maxPowerW !== undefined ? { maxPowerW: en.maxPowerW } : {}),
        ...(en.tokensPerJoule !== undefined ? { tokensPerJoule: en.tokensPerJoule } : {}),
      },
      thermals: { ...(temp !== undefined ? { maxTempC: temp } : {}), throttleReasons: throttle },
    };
    if (status === 'completed') {
      const ref = await d.scoreReference?.().catch(() => undefined);
      const score = scoreRun({ profile: input.scenario.profile, model: input.model.identity, metrics }, ref);
      if (score) metrics.score = score;
    }

    const validity = computeValidity({
      otherGpuUsers: s.otherUsers,
      ...(vr.baselineMiB !== undefined ? { baselineVramMiB: vr.baselineMiB } : {}),
      ...baselineUtil(s.baseline),
      throttleReasons: throttle,
      ...(s.coldGuaranteed !== undefined ? { coldGuaranteed: s.coldGuaranteed } : {}),
      ...(coldMs ? { coldMedianMs: coldMs.median } : {}),
      ...(warmMs ? { warmMedianMs: warmMs.median } : {}),
      ...(s.plan ? { modelBytes: s.plan.modelBytes } : {}),
      outputExact: s.outputExact,
      tokensApproximate: s.tokensApproximate,
      energyAvailable: en.available,
      keyStats: latency.flatMap((p) => [p.decodeTps, p.prefillTps]),
      vramApproximate: isVramApproximate({
        method,
        external: kind === 'external',
        containerized: CONTAINER_KINDS.has(kind),
        deltaMiB: vr.deltaMiB,
        othersDriftMiB: drift,
        vmBaselineMiB: s.otherUsers.reduce((n, u) => n + (u.kind === 'vm' ? (u.memMiB ?? 0) : 0), 0),
      }),
      slowSharedFilesystem: input.slowSharedFilesystem ?? false,
      sharedMemorySpill: spill !== undefined,
    });

    const launch: LaunchRecord = {
      ...(tuned?.record ??
        s.launch ?? {
        argv: [],
        env: {},
        display: { powershell: '', bash: '' },
        params: input.params,
        host: '127.0.0.1',
        port: input.port,
      }),
      ...(s.requestExample ? { requestExample: s.requestExample } : {}),
    };
    return {
      schema: RESULT_SCHEMA_VERSION,
      id: input.runId,
      app: { name: 'gpu-bench', version: d.appVersion },
      createdAt,
      finishedAt: new Date(d.clock.wall()).toISOString(),
      status,
      ...(error ? { error } : {}),
      scenario: input.scenario,
      hardware: s.hardware ?? UNKNOWN_HARDWARE,
      model: input.model.identity,
      engine: s.plan?.engine ?? { kind, name: kind },
      launch,
      metrics,
      validity,
      notes: s.codes,
      sharedGpu: sharedGpuUsers(s.otherUsers).map((u) => ({
        pid: u.pid,
        name: u.name,
        ...(u.memMiB !== undefined ? { memMiB: u.memMiB } : {}),
        ...(u.kind !== undefined ? { kind: u.kind } : {}),
      })),
      ...(samples.length
        ? {
            telemetry: downsampleTelemetry(samples, s.marks, {
              origin: s.origin,
              intervalMs: d.telemetryIntervalMs ?? 250,
              gpu,
            }),
          }
        : {}),
      logExcerpt: buildLogExcerpt(s.logBlocks, s.notes),
      ...(input.note ? { note: input.note } : {}),
      ...(s.tuning ? { tuning: s.tuning } : {}),
    };
  }
}

type Combination = Tuning['combinations'][number];

/** The recommended combination of a tune run, the attempt that measured it and that attempt's launch record. */
export function recommendedOf(
  tuning: Tuning | undefined,
  records: ReadonlyMap<number, LaunchRecord>,
): { combination: Combination; attempt: Tuning['attempts'][number]; record: LaunchRecord } | undefined {
  const rec = tuning?.recommended;
  if (tuning === undefined || rec === undefined) return undefined;
  const at = tuning.attempts.findIndex((a) => a.combination === rec);
  const record = records.get(at);
  return record ? { combination: tuning.combinations[rec] as Combination, attempt: tuning.attempts[at] as Tuning['attempts'][number], record } : undefined;
}

function baselineUtil(baseline: readonly GpuSample[]): { baselineUtilPct?: number } {
  const utils = baseline.map((x) => x.utilPct).filter((v): v is number => v !== null);
  // One sample per GPU: spreading is safe here.
  return utils.length ? { baselineUtilPct: Math.max(...utils) } : {};
}
