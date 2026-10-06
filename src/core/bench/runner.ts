import path from 'node:path';
import type { EngineConfig, EngineKind, LaunchParams } from '../../contract/engines';
import { AppError, isAppError, toAppErrorData, type AppErrorData } from '../../contract/errors';
import type { RunPhase, ServerEvent } from '../../contract/events';
import type { GpuSample, HardwareFingerprint } from '../../contract/hardware';
import {
  METRICS_FORMULA_VERSION,
  RESULT_SCHEMA_VERSION,
  type ConcurrencyPoint,
  type LatencyPoint,
  type LaunchRecord,
  type Metrics,
  type RunResult,
  type RunStatus,
  type Scenario,
  type Step,
} from '../../contract/results';
import type { Clock, ExitInfo } from '../deps';
import { toLaunchRecord, type EngineAdapter, type EngineInstance, type LaunchPlan, type ModelTarget } from '../engines/types';
import type { GenerateRequest, StreamEvent } from '../inference/types';
import type { RunsRepo } from '../store/runs-repo';
import { summaryOf } from '../store/runs-repo';
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
import { buildPrompt, buildTextPrompt, getCorpusTokens } from './prompts';
import { DEFAULT_EXPECTATIONS, isLlamaCpp, stepSeconds } from './scenarios';
import { scoreRun, type ScoreReference } from './score';
import { summarize } from './stats';
import { computeValidity, describeGpuUser, isVramApproximate, sharedGpuUsers, VRAM_DRIFT_MIN_MIB, vramBusy } from './validity';

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
/** Engines in containers: an instance PID (if any) is a docker CLI helper, never the engine. */
const CONTAINER_KINDS: ReadonlySet<EngineKind> = new Set<EngineKind>(['llamacpp-docker', 'vllm-docker']);

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
  measured: RequestMetrics[];
  concurrency: ConcurrencyPoint[];
  llamaBench: LlamaBenchResult[];
  outputExact: boolean;
  tokensApproximate: boolean;
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
  const needsServer = scenario.steps.some((s) => s.kind === 'latency' || s.kind === 'concurrency');
  if (out.length === 0 && needsServer) out.push({ cache: 'warm', measured: false });
  return out;
}

/** Example request for the launch record: token arrays are summarized, long texts shortened. */
export function exampleBody(body: Record<string, unknown>): Record<string, unknown> {
  const prompt = body.prompt;
  if (Array.isArray(prompt)) return { ...body, prompt: `<${prompt.length} token ids>` };
  if (typeof prompt === 'string' && prompt.length > 200) return { ...body, prompt: `${prompt.slice(0, 200)}…` };
  return body;
}

/** Last LOG_EXCERPT_LINES lines / LOG_EXCERPT_BYTES of every instance's log, with section headers. */
export function buildLogExcerpt(blocks: readonly { label: string; lines: readonly string[] }[], notes: readonly string[]): string {
  const lines: string[] = [];
  for (const b of blocks) lines.push(`=== ${b.label} ===`, ...b.lines);
  if (notes.length) lines.push('=== gpu-bench ===', ...notes);
  let kept = lines.slice(-LOG_EXCERPT_LINES);
  let text = kept.join('\n');
  while (Buffer.byteLength(text, 'utf8') > LOG_EXCERPT_BYTES && kept.length > 1) {
    kept = kept.slice(Math.ceil(kept.length / 10));
    text = kept.join('\n');
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
      measured: [],
      concurrency: [],
      llamaBench: [],
      outputExact: true,
      tokensApproximate: false,
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
      s.session = d.telemetry.start(d.telemetryIntervalMs ?? 250, (samples) => d.publish({ type: 'telemetry', samples }));
      // Started before the first load: its first reading is the reference for other processes' drift.
      s.procVram = d.telemetry.startProcessVram
        ? await d.telemetry.startProcessVram(() => this.enginePids(s), PROCESS_VRAM_INTERVAL_MS).catch(() => undefined)
        : undefined;
    }
    this.advance(s, 1);
    checkAbort(signal);

    await this.loads(s, plan);
    for (const step of input.scenario.steps) {
      if (step.kind === 'latency') await this.latencyStep(s, step);
      else if (step.kind === 'concurrency') await this.concurrencyStep(s, step, plan);
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
      const inst = await d.adapter.start(plan, s.signal);
      this.attach(s, inst, label);
      s.marks.push({ t: inst.t0, label });
      const ready = await inst.waitReady(s.signal);
      s.marks.push({ t: ready.tReady, label: 'ready' });
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
    if (s.instance && s.input.scenario.steps.some((x) => x.kind === 'latency' || x.kind === 'concurrency')) {
      await this.prepareCorpus(s, s.instance);
    }
  }

  /** "First token after load": a ~16-token prompt with 1 output token right after ready (lazy init). */
  private async firstToken(s: RunState, inst: EngineInstance): Promise<void> {
    const req: GenerateRequest = {
      promptText: s.corpus.slice(0, FIRST_TOKEN_PROMPT_CHARS),
      outputTokens: 1,
      seed: s.input.scenario.seed,
      ...this.modelField(s),
    };
    const sentAt = this.deps.clock.now();
    const events = await this.collect(inst, req, s.signal);
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
      for (let w = 0; w < step.warmup; w++) {
        await this.measure(s, inst, p, step.outputTokens, 'latency');
        this.advance(s, unit);
      }
      const results: RequestMetrics[] = [];
      for (let r = 0; r < step.reps; r++) {
        const m = await this.measure(s, inst, p, step.outputTokens, 'latency');
        this.record(s, m);
        results.push(m);
        this.deps.publish({
          type: 'run.live',
          runId: s.input.runId,
          ttftMs: m.ttftMs,
          tokens: m.outputTokens,
          ...(m.decodeTps !== undefined ? { decodeTps: m.decodeTps } : {}),
          ...((m.prefillTpsEngine ?? m.prefillTpsClient) !== undefined
            ? { prefillTps: m.prefillTpsEngine ?? m.prefillTpsClient }
            : {}),
        });
        this.advance(s, unit);
      }
      s.latency.push(aggregateLatency(results, { promptTokens: p, outputTokens: step.outputTokens }));
    }
  }

  /** C closed-loop workers, each sending requestsPerWorker requests back to back. Failed requests count as errors. */
  private async concurrencyStep(s: RunState, step: Extract<Step, { kind: 'concurrency' }>, plan: LaunchPlan): Promise<void> {
    const inst = this.running(s);
    const d = this.deps;
    this.setPhase(s, 'concurrency');
    const slots = plan.params.parallel ?? 1;
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
      const results: (RequestMetrics | null)[] = [];
      const start = d.clock.now();
      const worker = async () => {
        for (let k = 0; k < step.requestsPerWorker; k++) {
          checkAbort(s.signal);
          try {
            const m = await this.measure(s, inst, step.promptTokens, step.outputTokens, 'concurrency');
            if (!m.tokensExact) s.tokensApproximate = true;
            results.push(m);
          } catch (e) {
            if (s.signal.aborted) throw e;
            results.push(null);
          }
        }
      };
      await Promise.all(Array.from({ length: level }, worker));
      if (s.instanceExit) throw this.engineExited(s.instanceExit);
      const point = aggregateConcurrency(level, results, d.clock.now() - start);
      s.concurrency.push(point);
      d.publish({ type: 'run.live', runId: s.input.runId, decodeTps: point.aggregateTps });
      this.advance(s, unit);
    }
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
    s.llamaBench = await d.llamaBench(plan, step, s.signal);
    this.advance(s, stepSeconds(step, DEFAULT_EXPECTATIONS));
  }

  // ---- requests ---------------------------------------------------------------------------

  private modelField(s: RunState): { model?: string } {
    return s.input.model.servedName ? { model: s.input.model.servedName } : {};
  }

  private async collect(inst: EngineInstance, req: GenerateRequest, signal: AbortSignal): Promise<StreamEvent[]> {
    const events: StreamEvent[] = [];
    for await (const e of inst.client.generate(req, signal)) events.push(e);
    return events;
  }

  /** One request with a fresh prompt (unique offset: never a prefix-cache hit). */
  private async measure(s: RunState, inst: EngineInstance, promptTokens: number, outputTokens: number, salt: string) {
    const rep = s.requestSeq++;
    const seed = s.input.scenario.seed;
    const prompt: Pick<GenerateRequest, 'promptIds' | 'promptText'> = s.tokens
      ? { promptIds: buildPrompt(s.tokens, promptTokens, rep, { seed, salt, ...(s.bos !== undefined ? { bos: s.bos } : {}) }) }
      : { promptText: buildTextPrompt(s.corpus, promptTokens, rep, { seed, salt }) };
    const req: GenerateRequest = { ...prompt, outputTokens, seed, ...this.modelField(s) };
    s.requestExample ??= exampleBody(inst.client.requestBody(req));
    const sentAt = this.deps.clock.now();
    const events = await this.collect(inst, req, s.signal);
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
    const pump = async () => {
      try {
        for await (const line of inst.logs) {
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

  private progress(s: RunState): number {
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
    this.deps.publish({
      type: 'run.phase',
      runId: s.input.runId,
      phase: s.phase,
      progress: s.phase === 'cleanup' ? Math.max(this.progress(s), 0.99) : this.progress(s),
      ...(detail ? { detail } : {}),
    });
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
      concurrency: s.concurrency,
      llamaBench: s.llamaBench,
      vram: {
        ...vr,
        ...(input.vramEstimateMiB !== undefined ? { estimateMiB: input.vramEstimateMiB } : {}),
        ...(processPeakMiB !== undefined ? { processPeakMiB } : {}),
        ...(method ? { method } : {}),
      },
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
    });

    const launch: LaunchRecord = {
      ...(s.launch ?? {
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
    };
  }
}

function baselineUtil(baseline: readonly GpuSample[]): { baselineUtilPct?: number } {
  const utils = baseline.map((x) => x.utilPct).filter((v): v is number => v !== null);
  // One sample per GPU: spreading is safe here.
  return utils.length ? { baselineUtilPct: Math.max(...utils) } : {};
}
