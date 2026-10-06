import type { ApiFlavor, EngineConfig, EngineKind, LaunchParams } from '../../../../src/contract/engines';
import { AppError } from '../../../../src/contract/errors';
import type { ServerEvent } from '../../../../src/contract/events';
import type { GpuSample } from '../../../../src/contract/hardware';
import { runResultSchema, type RunResult } from '../../../../src/contract/results';
import type { Clock, ExitInfo, LogLine } from '../../../../src/core/deps';
import type { EngineAdapter, EngineCaps, EngineInstance, LaunchPlan, ModelTarget, PhaseMark, PlanOptions } from '../../../../src/core/engines/types';
import type { GenerateRequest, InferenceClient, StreamEvent } from '../../../../src/core/inference/types';
import { ProcessVramRecorder, type GpuMemoryListener, type GpuMemorySource } from '../../../../src/core/telemetry/process-vram';
import type { GpuProcessMemory, GpuUser, PidSource, ProcessVramSession, TelemetrySampler, TelemetrySession } from '../../../../src/core/telemetry/types';
import { hardware, modelIdentity } from '../store/fixtures';

/** Virtual time: nothing waits for real, sleep() just moves the clock. */
export class FakeClock implements Clock {
  t = 10_000;
  readonly wallBase = Date.UTC(2026, 9, 6, 10, 0, 0);
  /** Called after every move of the clock (periodic fakes tick from here). */
  readonly onMove = new Set<(from: number, to: number) => void>();
  now(): number {
    return this.t;
  }
  wall(): number {
    return this.wallBase + this.t;
  }
  advance(ms: number): void {
    const from = this.t;
    this.t += ms;
    for (const f of [...this.onMove]) f(from, this.t);
  }
  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    this.advance(ms);
    // A macrotask, like a real timer: pending microtask work (log pumps) gets to run first.
    await new Promise<void>((r) => setImmediate(r));
  }
}

/** Minimal push → async-iterate queue (one consumer). */
export class Lines implements AsyncIterable<LogLine> {
  private items: LogLine[] = [];
  private waiters: ((r: IteratorResult<LogLine>) => void)[] = [];
  private closed = false;
  private failure: Error | undefined;
  push(l: LogLine): void {
    const w = this.waiters.shift();
    if (w) w({ value: l, done: false });
    else this.items.push(l);
  }
  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }
  fail(e: Error): void {
    this.failure = e;
    this.close();
  }
  [Symbol.asyncIterator](): AsyncIterator<LogLine> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.failure) return Promise.reject(this.failure);
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

/** Shared state of the fake machine: which instances run when, and whether the file cache is cold. */
export class World {
  readonly clock = new FakeClock();
  cacheCold = false;
  running: { from: number; to?: number; pid?: number }[] = [];
  baselineMiB = 1600;
  modelMiB = 4000;
  /** Memory still held after stop (simulates slow VRAM release). */
  leakMiB = 0;
  /** Growth of OTHER processes over time (e.g. a WSL server loading a model mid-run), in the total too. */
  othersGrowthMiB: (t: number) => number = () => 0;
  isRunning(t: number): boolean {
    return this.running.some((r) => t >= r.from && (r.to === undefined || t <= r.to));
  }
  memAt(t: number): number {
    const others = this.othersGrowthMiB(t);
    if (this.isRunning(t)) return this.baselineMiB + others + this.modelMiB;
    const afterAStop = this.running.some((r) => r.to !== undefined && t >= r.to);
    return this.baselineMiB + others + (afterAStop ? this.leakMiB : 0);
  }
}

export interface ClientOptions {
  flavor?: ApiFlavor;
  prefillTps?: number;
  firstChunkDelayMs?: number;
  decodeMsPerToken?: number;
  tokensPerChunk?: number;
  reportTokens?: boolean;
  usage?: boolean;
  timings?: boolean;
  /** Generate this many tokens fewer than requested. */
  shortBy?: number;
  tokenizeUnsupported?: boolean;
  tokenizeError?: AppError;
  bos?: number;
  /** Throws for request number n (1-based, across the instance's client). */
  failOn?: (n: number, req: GenerateRequest) => Error | undefined;
  /** Requests (1-based) that produce no output at all. */
  silent?: (n: number) => boolean;
  /** Called before each request (e.g. to abort a run at a precise point). */
  onRequest?: (n: number) => void;
}

export class FakeClient implements InferenceClient {
  readonly flavor: ApiFlavor;
  readonly baseUrl = 'http://127.0.0.1:5555';
  readonly requests: GenerateRequest[] = [];
  tokenizeCalls = 0;
  constructor(
    private readonly world: World,
    private readonly o: ClientOptions = {},
  ) {
    this.flavor = o.flavor ?? 'llamacpp';
  }
  async ready(): Promise<boolean> {
    return true;
  }
  async models(): Promise<string[]> {
    return ['m'];
  }
  async tokenize(text: string, opts: { addSpecial?: boolean } = {}): Promise<number[]> {
    this.tokenizeCalls++;
    if (this.o.tokenizeError) throw this.o.tokenizeError;
    if (this.o.tokenizeUnsupported) {
      throw new AppError('ENDPOINT_INVALID', 'tokenize unsupported', { params: { reason: 'tokenize_unsupported' } });
    }
    const ids = Array.from(text, (c) => 10 + ((c.codePointAt(0) as number) % 1000));
    return opts.addSpecial && this.o.bos !== undefined ? [this.o.bos, ...ids] : ids;
  }
  requestBody(req: GenerateRequest): Record<string, unknown> {
    return { prompt: req.promptIds ?? req.promptText, n_predict: req.outputTokens, seed: req.seed };
  }
  async *generate(req: GenerateRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent, void, undefined> {
    const c = this.world.clock;
    this.requests.push(req);
    const n = this.requests.length;
    this.o.onRequest?.(n);
    const err = this.o.failOn?.(n, req);
    if (err) throw err;
    const p = req.promptIds?.length ?? Math.ceil((req.promptText?.length ?? 0) / 4);
    c.advance((p / (this.o.prefillTps ?? 10_000)) * 1000 + (this.o.firstChunkDelayMs ?? 5));
    if (this.o.silent?.(n)) {
      yield { kind: 'done', t: c.now() };
      return;
    }
    // Short outputs (the 1-token first-token probe) are never shortened.
    const short = this.o.shortBy ?? 0;
    const total = req.outputTokens > short ? req.outputTokens - short : req.outputTokens;
    const per = this.o.tokensPerChunk ?? 1;
    let emitted = 0;
    while (emitted < total) {
      if (signal?.aborted) throw new AppError('CANCELLED', 'aborted');
      const k = emitted === 0 ? 1 : Math.min(per, total - emitted);
      yield { kind: 'chunk', t: c.now(), textLen: k * 4, ...(this.o.reportTokens === false ? {} : { tokens: k }) };
      emitted += k;
      c.advance((this.o.decodeMsPerToken ?? 5) * k);
      await Promise.resolve();
    }
    yield {
      kind: 'done',
      t: c.now(),
      ...(this.o.usage === false ? {} : { usage: { promptTokens: p, completionTokens: total } }),
      ...(this.o.timings
        ? { timings: { promptN: p, promptMs: (p / (this.o.prefillTps ?? 10_000)) * 1000, predictedN: total, predictedMs: total * 5 } }
        : {}),
    };
  }
}

export interface InstanceOptions {
  loadMs: number;
  phases?: (t0: number) => PhaseMark[];
  failReady?: Error;
  logs?: string[];
  /** Gap (ms) between log lines. */
  logGapMs?: number;
  failLogs?: Error;
  stopError?: Error;
  exitRejects?: boolean;
  /** PID of the engine process (absent: an engine with no process of ours). */
  pid?: number;
}

export class FakeInstance implements EngineInstance {
  readonly baseUrl = 'http://127.0.0.1:5555';
  readonly t0: number;
  readonly pid?: number;
  readonly logs = new Lines();
  readonly exited: Promise<ExitInfo>;
  stopped = false;
  private resolveExit!: (e: ExitInfo) => void;
  private rejectExit!: (e: Error) => void;
  private readonly entry: { from: number; to?: number };
  constructor(
    private readonly world: World,
    readonly client: FakeClient,
    private readonly o: InstanceOptions,
  ) {
    this.t0 = world.clock.now();
    this.exited = new Promise<ExitInfo>((res, rej) => {
      this.resolveExit = res;
      this.rejectExit = rej;
    });
    if (o.pid !== undefined) this.pid = o.pid;
    this.entry = { from: this.t0, ...(o.pid !== undefined ? { pid: o.pid } : {}) };
    world.running.push(this.entry);
    let t = this.t0;
    for (const text of o.logs ?? []) this.logs.push({ t: (t += o.logGapMs ?? 1), stream: 'stderr', text });
    if (o.failLogs) this.logs.fail(o.failLogs);
  }
  async waitReady(): Promise<{ tReady: number; phases: PhaseMark[] }> {
    if (this.o.failReady) throw this.o.failReady;
    this.world.clock.advance(this.o.loadMs);
    return { tReady: this.world.clock.now(), phases: this.o.phases?.(this.t0) ?? [] };
  }
  /** The process dies on its own (crash). */
  crash(code = 1): void {
    this.entry.to = this.world.clock.now();
    this.resolveExit({ code, signal: null });
  }
  async stop(): Promise<ExitInfo> {
    this.stopped = true;
    this.entry.to ??= this.world.clock.now();
    this.logs.close();
    if (this.o.exitRejects) this.rejectExit(new Error('wait failed'));
    else this.resolveExit({ code: 0, signal: null });
    if (this.o.stopError) throw this.o.stopError;
    return { code: 0, signal: null };
  }
  logTail(): string[] {
    return [...(this.o.logs ?? [])];
  }
}

export interface AdapterOptions {
  kind?: EngineKind;
  coldMs?: number;
  warmMs?: number;
  /** Slots the plan reports (params.parallel) when the user set none; null = the plan has no value. */
  parallel?: number | null;
  modelBytes?: number;
  client?: ClientOptions;
  instance?: Partial<InstanceOptions>;
  /** Per start (1-based) overrides. */
  perStart?: (n: number) => Partial<InstanceOptions> | undefined;
  failStart?: (n: number) => Error | undefined;
  failPlan?: Error;
  /** start() waits for this (lets a test act while a run is in flight). */
  gate?: Promise<unknown>;
  /** Instances without a PID (external endpoints). */
  noPid?: boolean;
}

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

export class FakeAdapter implements EngineAdapter {
  readonly kind: EngineKind;
  readonly instances: FakeInstance[] = [];
  readonly plans: (PlanOptions & { params: LaunchParams })[] = [];
  /** One client shared by every instance, so requests can be inspected across loads. */
  readonly client: FakeClient;
  constructor(
    private readonly world: World,
    private readonly o: AdapterOptions = {},
  ) {
    this.kind = o.kind ?? 'llamacpp-native';
    this.client = new FakeClient(world, o.client);
  }
  async detect() {
    return { kind: this.kind, available: true, installed: true, problems: [], supported: true };
  }
  async capabilities(): Promise<EngineCaps> {
    return { flags: new Set(), tokenIdsInPrompt: true, timings: true, minTokens: false, fitFlag: false };
  }
  async plan(cfg: EngineConfig, _model: ModelTarget, params: LaunchParams, opts: PlanOptions): Promise<LaunchPlan> {
    if (this.o.failPlan) throw this.o.failPlan;
    this.plans.push({ ...opts, params });
    const { parallel, ...rest } = params;
    const planParams = this.o.parallel === null ? rest : { ...rest, parallel: parallel ?? this.o.parallel ?? 1 };
    return {
      kind: cfg.kind,
      argv: ['llama-server', '-m', 'C:/models/m.gguf', '--port', String(opts.port), '--alias', opts.marker],
      env: { CUDA_VISIBLE_DEVICES: '0' },
      host: '127.0.0.1',
      port: opts.port,
      params: planParams,
      engine: { kind: cfg.kind, name: 'llama.cpp', build: 'b11438', variant: 'CUDA 13.4' },
      modelFiles: ['C:/models/m.gguf'],
      modelBytes: this.o.modelBytes ?? 5e9,
      marker: opts.marker,
    };
  }
  async start(): Promise<EngineInstance> {
    if (this.o.gate) await this.o.gate;
    const n = this.instances.length + 1;
    const fail = this.o.failStart?.(n);
    if (fail) throw fail;
    const cold = this.world.cacheCold;
    this.world.cacheCold = false;
    const inst = new FakeInstance(this.world, this.client, {
      loadMs: cold ? (this.o.coldMs ?? 8000) : (this.o.warmMs ?? 2000),
      phases: (t0) => [
        { name: 'init', t: t0 + 100 },
        { name: 'load_tensors', t: t0 + 200 },
      ],
      logs: ['llama server listening', 'load_tensors: loading model'],
      // Every adapter here has a process (Docker's is the CLI log follower, like the real one).
      ...(this.o.noPid ? {} : { pid: 7000 + n }),
      ...this.o.instance,
      ...this.o.perStart?.(n),
    });
    this.instances.push(inst);
    return inst;
  }
}

export interface TelemetryOptions {
  available?: boolean | 'throw';
  users?: GpuUser[] | 'throw';
  snapshot?: 'throw' | 'throw-after-first';
  powerW?: number | null;
  throttle?: string[];
  stopThrows?: boolean;
  utilPct?: number | null;
  /** Memory readings missing (N/A). */
  memNull?: boolean;
  /**
   * Per-process VRAM (like the Windows counters): every running instance holds world.modelMiB under its
   * PID, `others(t)` adds the other processes. Absent = the OS cannot attribute (startProcessVram → undefined).
   */
  processVram?: {
    others?: (t: number) => GpuProcessMemory[];
    /** The engine's memory as the OS reports it (default world.modelMiB); null = not listed (WSL). */
    engineMiB?: number | null;
    startThrows?: boolean;
    stopThrows?: boolean;
  };
}

/** Readings every intervalMs of virtual time (driven by FakeClock moves), plus one at once (a warm source). */
class ClockSource implements GpuMemorySource {
  constructor(
    private readonly clock: FakeClock,
    private readonly procs: (t: number) => GpuProcessMemory[],
  ) {}
  read(): Promise<GpuProcessMemory[] | undefined> {
    return Promise.resolve(this.procs(this.clock.now()));
  }
  watch(intervalMs: number, onTick: GpuMemoryListener) {
    let next = this.clock.now() + intervalMs;
    const move = (_from: number, to: number) => {
      for (; next <= to; next += intervalMs) onTick(next, this.procs(next));
    };
    this.clock.onMove.add(move);
    onTick(this.clock.now(), this.procs(this.clock.now()));
    return {
      stop: () => {
        this.clock.onMove.delete(move);
        return Promise.resolve();
      },
    };
  }
}

export class FakeTelemetry implements TelemetrySampler {
  sessions = 0;
  snapshots = 0;
  constructor(
    private readonly world: World,
    private readonly o: TelemetryOptions = {},
  ) {}
  private sample(t: number): GpuSample {
    return {
      t,
      gpu: 0,
      utilPct: this.o.utilPct === undefined ? (this.world.isRunning(t) ? 95 : 3) : this.o.utilPct,
      memUsedMiB: this.o.memNull ? null : this.world.memAt(t),
      memTotalMiB: 32607,
      powerW: this.o.powerW === undefined ? (this.world.isRunning(t) ? 450 : 30) : this.o.powerW,
      tempC: 60,
      smClockMHz: 2800,
      memClockMHz: 14000,
      pcieGen: 5,
      pcieWidth: 16,
      throttle: this.o.throttle ?? [],
    };
  }
  async available(): Promise<boolean> {
    if (this.o.available === 'throw') throw new Error('nvidia-smi crashed');
    return this.o.available ?? true;
  }
  async probe() {
    return hardware().gpus;
  }
  async snapshot(): Promise<GpuSample[]> {
    this.snapshots++;
    if (this.o.snapshot === 'throw' || (this.o.snapshot === 'throw-after-first' && this.snapshots > 1)) throw new Error('snapshot failed');
    return [this.sample(this.world.clock.now())];
  }
  async otherGpuUsers(): Promise<GpuUser[]> {
    if (this.o.users === 'throw') throw new Error('query failed');
    return this.o.users ?? [];
  }
  /** PID functions the runner passed, and the recorders handed out, for inspection. */
  readonly processVramPids: PidSource[] = [];
  readonly recorders: ProcessVramRecorder[] = [];
  async startProcessVram(pids: PidSource, intervalMs = 1000): Promise<ProcessVramSession | undefined> {
    const pv = this.o.processVram;
    if (!pv) return undefined;
    if (pv.startThrows) throw new Error('counters broke');
    this.processVramPids.push(pids);
    const w = this.world;
    const source = new ClockSource(w.clock, (t) => [
      ...w.running
        .filter((r) => pv.engineMiB !== null && r.pid !== undefined && t >= r.from && (r.to === undefined || t <= r.to))
        .map((r) => ({ pid: r.pid as number, mib: pv.engineMiB ?? w.modelMiB, name: 'llama-server' })),
      ...(pv.others?.(t) ?? []),
    ]);
    const rec = new ProcessVramRecorder({ source, clock: w.clock, pids, intervalMs });
    this.recorders.push(rec);
    await rec.ready;
    if (pv.stopThrows) return Object.assign(rec, { stop: () => Promise.reject(new Error('stop failed')) });
    return rec;
  }
  start(intervalMs: number, onSamples?: (s: GpuSample[]) => void): TelemetrySession {
    this.sessions++;
    const from = this.world.clock.now();
    onSamples?.([this.sample(from)]);
    return {
      latest: () => [this.sample(this.world.clock.now())],
      stop: async () => {
        if (this.o.stopThrows) throw new Error('stop failed');
        const out: GpuSample[] = [];
        for (let t = from; t <= this.world.clock.now(); t += intervalMs) out.push(this.sample(t));
        return out;
      },
    };
  }
}

/** Save fake: validates against the contract schema, like the real repo. */
export function memoryRuns(opts: { fail?: Error } = {}) {
  const saved: RunResult[] = [];
  return {
    saved,
    save: async (run: RunResult): Promise<string> => {
      if (opts.fail) throw opts.fail;
      saved.push(runResultSchema.parse(run));
      return `/results/2026-10-06_10-00-00_${run.id}.json`;
    },
  };
}

export function events() {
  const list: ServerEvent[] = [];
  return {
    list,
    publish: (e: ServerEvent) => list.push(e),
    ofType: <T extends ServerEvent['type']>(type: T) => list.filter((e): e is Extract<ServerEvent, { type: T }> => e.type === type),
  };
}

export function modelTarget(over: Partial<ModelTarget> = {}): ModelTarget {
  return { identity: modelIdentity(), ...over };
}

export const displayCommand = (argv: string[]) => ({ powershell: `& ${argv.join(' ')}`, bash: argv.join(' ') });

/** Small corpus: tokenizing the real 420 KB one per test would only slow the suite down. */
export const SMALL_CORPUS = 'It was on a dreary night of November that I beheld the accomplishment of my toils.\n\n'.repeat(60);
