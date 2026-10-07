import { AppError } from '../../contract/errors';
import type { GpuSample } from '../../contract/hardware';
import type { ConcurrencyPoint, LatencyPoint, TelemetrySeries } from '../../contract/results';
import type { PhaseMark } from '../engines/types';
import type { StreamEvent } from '../inference/types';
import { gpuUserKind } from '../telemetry/known-llm';
import type { GpuProcessMemory, ProcessVramTick } from '../telemetry/types';
import { mean, percentile, summarize } from './stats';

/** Everything measured on one streamed request. Times are monotonic ms (Clock.now). */
export interface RequestMetrics {
  sentAt: number;
  /** First / last chunk that carried output. */
  firstAt: number;
  lastAt: number;
  /** `done` event (or the last chunk when the stream had none). */
  endAt: number;
  ttftMs: number;
  totalMs: number;
  promptTokens: number;
  /** Generated tokens N (exact from usage/timings when available). */
  outputTokens: number;
  /** false when N had to be estimated from the number of chunks. */
  tokensExact: boolean;
  /** N === the requested output length. */
  outputExact: boolean;
  /** Tokens produced after the first chunk, i.e. inside the decode window [firstAt, lastAt]. */
  decodeTokens: number;
  decodeTps?: number;
  /** promptTokens / TTFT (includes HTTP and first-token overhead). */
  prefillTpsClient?: number;
  /** Engine-reported rates (llama.cpp `timings`). */
  prefillTpsEngine?: number;
  decodeTpsEngine?: number;
  /** Inter-token latencies, per token when chunk token counts are known, else per chunk. */
  itlMs: number[];
  itlPerChunk: boolean;
  draftAcceptance?: number;
  /** Prompt length the server says it processed (checks BOS handling). */
  promptTokensReported?: number;
}

type Chunk = Extract<StreamEvent, { kind: 'chunk' }>;
type Done = Extract<StreamEvent, { kind: 'done' }>;

const isChunk = (e: StreamEvent): e is Chunk => e.kind === 'chunk';
const hasOutput = (c: Chunk): boolean => (c.tokens ?? 0) > 0 || c.textLen > 0;
const defined = (xs: readonly (number | undefined)[]): number[] => xs.filter((x): x is number => x !== undefined);
const rate = (n: number | undefined, ms: number | undefined): number | undefined =>
  n !== undefined && ms !== undefined && n > 0 && ms > 0 ? (n / ms) * 1000 : undefined;

/**
 * Derives request metrics from the stream events.
 *
 * - TTFT: send → first chunk carrying output.
 * - Decode rate: (N − tokens of the first chunk) / (t_last − t_first), i.e. the usual (N−1)/Δt when
 *   the first chunk holds one token. N comes from usage/timings (never from the chunk count: MTP
 *   and speculative decoding put several tokens in a chunk); else from per-chunk token counts
 *   (still exact, reported by the engine); else one token per chunk (approximate).
 * - ITL: each chunk interval spread evenly over that chunk's tokens when counts are known, else
 *   one value per chunk (`itlPerChunk`).
 *
 * Throws ENDPOINT_INVALID when the stream produced no output at all.
 */
export function fromStream(
  events: readonly StreamEvent[],
  ctx: { sentAt: number; promptTokens: number; expectedOutput: number },
): RequestMetrics {
  const chunks = events.filter(isChunk);
  const out = chunks.filter(hasOutput);
  const first = out[0];
  const last = out[out.length - 1];
  if (!first || !last) {
    throw new AppError('ENDPOINT_INVALID', 'The server returned no tokens', { params: { reason: 'no_tokens' } });
  }
  const done = events.find((e): e is Done => e.kind === 'done');
  const exactN = done?.usage?.completionTokens ?? done?.timings?.predictedN;
  const countsKnown = out.every((c) => c.tokens !== undefined && c.tokens > 0);
  let outputTokens: number;
  let tokensExact = true;
  if (exactN !== undefined) outputTokens = exactN;
  else if (countsKnown) outputTokens = out.reduce((s, c) => s + (c.tokens as number), 0);
  else {
    outputTokens = out.reduce((s, c) => s + (c.tokens !== undefined && c.tokens > 0 ? c.tokens : 1), 0);
    tokensExact = false;
  }
  const firstTokens = first.tokens !== undefined && first.tokens > 0 ? first.tokens : 1;
  const decodeTokens = Math.max(0, outputTokens - firstTokens);
  const decodeMs = last.t - first.t;

  const itlMs: number[] = [];
  for (let i = 1; i < out.length; i++) {
    const c = out[i] as Chunk;
    const dt = c.t - (out[i - 1] as Chunk).t;
    if (countsKnown) {
      const k = c.tokens as number;
      for (let j = 0; j < k; j++) itlMs.push(dt / k);
    } else itlMs.push(dt);
  }

  const ttftMs = first.t - ctx.sentAt;
  const endAt = done?.t ?? last.t;
  const t = done?.timings;
  const decodeTps = rate(decodeTokens, decodeMs);
  const prefillTpsClient = rate(ctx.promptTokens, ttftMs);
  const prefillTpsEngine = rate(t?.promptN, t?.promptMs);
  const decodeTpsEngine = rate(t?.predictedN, t?.predictedMs);
  const draftAcceptance =
    t?.draftN !== undefined && t.draftN > 0 && t.draftNAccepted !== undefined ? t.draftNAccepted / t.draftN : undefined;
  const promptTokensReported = done?.usage?.promptTokens;

  return {
    sentAt: ctx.sentAt,
    firstAt: first.t,
    lastAt: last.t,
    endAt,
    ttftMs,
    totalMs: endAt - ctx.sentAt,
    promptTokens: ctx.promptTokens,
    outputTokens,
    tokensExact,
    outputExact: outputTokens === ctx.expectedOutput,
    decodeTokens,
    ...(decodeTps !== undefined ? { decodeTps } : {}),
    ...(prefillTpsClient !== undefined ? { prefillTpsClient } : {}),
    ...(prefillTpsEngine !== undefined ? { prefillTpsEngine } : {}),
    ...(decodeTpsEngine !== undefined ? { decodeTpsEngine } : {}),
    itlMs,
    itlPerChunk: !countsKnown,
    ...(draftAcceptance !== undefined ? { draftAcceptance } : {}),
    ...(promptTokensReported !== undefined ? { promptTokensReported } : {}),
  };
}

/** Latency point (one prompt length) from its measured repetitions. */
export function aggregateLatency(
  results: readonly RequestMetrics[],
  shape: { promptTokens: number; outputTokens: number },
): LatencyPoint {
  const prefillEngine = defined(results.map((r) => r.prefillTpsEngine));
  const decodeEngine = defined(results.map((r) => r.decodeTpsEngine));
  const itl = results.flatMap((r) => r.itlMs);
  const draft = mean(defined(results.map((r) => r.draftAcceptance)));
  return {
    promptTokens: shape.promptTokens,
    outputTokens: shape.outputTokens,
    ttftMs: summarize(results.map((r) => r.ttftMs)),
    prefillTps: summarize(defined(results.map((r) => r.prefillTpsClient))),
    ...(prefillEngine.length ? { prefillTpsEngine: summarize(prefillEngine) } : {}),
    decodeTps: summarize(defined(results.map((r) => r.decodeTps))),
    ...(decodeEngine.length ? { decodeTpsEngine: summarize(decodeEngine) } : {}),
    itlP50Ms: percentile(itl, 50),
    itlP95Ms: percentile(itl, 95),
    itlPerChunk: results.some((r) => r.itlPerChunk),
    ...(draft !== undefined ? { draftAcceptance: draft } : {}),
    totalMs: summarize(results.map((r) => r.totalMs)),
  };
}

/** Total length (ms) of the union of the intervals: overlapping ones are counted once. */
export function unionMs(windows: readonly Window[]): number {
  const sorted = windows.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let total = 0;
  let end = -Infinity;
  for (const [a, b] of sorted) {
    if (b <= end) continue;
    total += b - Math.max(a, end);
    end = b;
  }
  return total;
}

/** What one user of a concurrency level asks for and how much context each one has. */
export interface ConcurrencyShape {
  promptTokens: number;
  outputTokens: number;
  /** Tokens one user can hold (llama.cpp ctx / slots, or the whole shared context). */
  contextPerUser?: number;
  /** The context is one pool shared by every user (unified KV cache, vLLM). */
  contextShared?: boolean;
}

/**
 * Closed-loop concurrency level: `null` entries are failed requests. Aggregate generation is total
 * generated tokens / makespan (first send → last completion); aggregate prompt reading is total
 * prompt tokens / the time at least one request was still reading (union of send → first token).
 * Per user: the median and the slowest 5 % of the per-request rates.
 */
export function aggregateConcurrency(
  level: number,
  perRequest: readonly (RequestMetrics | null)[],
  makespanMs: number,
  shape?: ConcurrencyShape,
): ConcurrencyPoint {
  const ok = perRequest.filter((r): r is RequestMetrics => r !== null);
  const tokens = ok.reduce((s, r) => s + r.outputTokens, 0);
  const ttft = ok.map((r) => r.ttftMs);
  const decode = defined(ok.map((r) => r.decodeTps));
  const prefill = defined(ok.map((r) => r.prefillTpsEngine ?? r.prefillTpsClient));
  const reading = unionMs(ok.map((r) => [r.sentAt, r.firstAt] as const));
  const promptTotal = ok.reduce((s, r) => s + r.promptTokens, 0);
  return {
    level,
    requests: perRequest.length,
    aggregateTps: makespanMs > 0 ? (tokens / makespanMs) * 1000 : 0,
    perRequestDecodeTpsP50: percentile(decode, 50),
    ttftP50Ms: percentile(ttft, 50),
    ttftP95Ms: percentile(ttft, 95),
    errors: perRequest.length - ok.length,
    ...(shape
      ? {
          promptTokens: shape.promptTokens,
          outputTokens: shape.outputTokens,
          ...(shape.contextPerUser !== undefined ? { contextPerUser: shape.contextPerUser } : {}),
          ...(shape.contextShared !== undefined ? { contextShared: shape.contextShared } : {}),
        }
      : {}),
    ...(decode.length ? { perRequestDecodeTpsP5: percentile(decode, 5), perRequestDecodeTps: summarize(decode) } : {}),
    ...(prefill.length ? { perRequestPrefillTpsP50: percentile(prefill, 50), perRequestPrefillTpsP5: percentile(prefill, 5) } : {}),
    ...(reading > 0 ? { aggregatePrefillTps: (promptTotal / reading) * 1000 } : {}),
  };
}

/** A [from, to] interval in monotonic ms. */
export type Window = readonly [number, number];

interface Point {
  t: number;
  v: number;
}

function seriesByGpu(samples: readonly GpuSample[], pick: (s: GpuSample) => number | null): Map<number, Point[]> {
  const out = new Map<number, Point[]>();
  for (const s of samples) {
    const v = pick(s);
    if (v === null) continue;
    const list = out.get(s.gpu) ?? [];
    list.push({ t: s.t, v });
    out.set(s.gpu, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.t - b.t);
  return out;
}

/** Piecewise-linear value at t, held constant before the first and after the last sample. */
function valueAt(points: readonly Point[], t: number): number {
  const firstP = points[0] as Point;
  if (t <= firstP.t) return firstP.v;
  for (let i = 1; i < points.length; i++) {
    const b = points[i] as Point;
    if (t <= b.t) {
      const a = points[i - 1] as Point;
      return a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
    }
  }
  return (points[points.length - 1] as Point).v;
}

/** Trapezoid integral of the interpolated series over [a, b] (value·ms) and its maximum there. */
function integrate(points: readonly Point[], a: number, b: number): { area: number; max: number } {
  const ts = [a, ...points.filter((p) => p.t > a && p.t < b).map((p) => p.t), b];
  let area = 0;
  let max = -Infinity;
  for (let i = 0; i < ts.length; i++) {
    const v = valueAt(points, ts[i] as number);
    max = Math.max(max, v);
    if (i > 0) area += ((valueAt(points, ts[i - 1] as number) + v) / 2) * ((ts[i] as number) - (ts[i - 1] as number));
  }
  return { area, max };
}

export interface EnergyResult {
  /** false when no sample had a power reading (flag energy_unavailable). */
  available: boolean;
  avgPowerW?: number;
  maxPowerW?: number;
  joules?: number;
  tokensPerJoule?: number;
}

/**
 * Energy over the given windows (normally each request's decode window), summed over all GPUs.
 * Power is linearly interpolated between samples, so windows shorter than the sampling interval
 * still integrate correctly.
 */
export function energyOverWindows(samples: readonly GpuSample[], windows: readonly Window[], tokens: number): EnergyResult {
  const series = seriesByGpu(samples, (s) => s.powerW);
  if (series.size === 0) return { available: false };
  const valid = windows.filter(([a, b]) => b > a);
  const totalMs = valid.reduce((s, [a, b]) => s + (b - a), 0);
  if (totalMs === 0) return { available: true };
  let wattMs = 0;
  let maxPowerW = 0;
  for (const [a, b] of valid) {
    let windowMax = 0;
    for (const points of series.values()) {
      const r = integrate(points, a, b);
      wattMs += r.area;
      windowMax += r.max;
    }
    maxPowerW = Math.max(maxPowerW, windowMax);
  }
  const joules = wattMs / 1000;
  return {
    available: true,
    avgPowerW: joules / (totalMs / 1000),
    maxPowerW,
    joules,
    ...(joules > 0 ? { tokensPerJoule: tokens / joules } : {}),
  };
}

export function energy(samples: readonly GpuSample[], fromT: number, toT: number, tokens: number): EnergyResult {
  return energyOverWindows(samples, [[fromT, toT]], tokens);
}

export interface VramResult {
  baselineMiB?: number;
  peakMiB?: number;
  /** Peak − baseline, summed over GPUs, never negative (another process may free memory meanwhile). */
  deltaMiB?: number;
}

function lastByGpu(samples: readonly GpuSample[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const s of samples) if (s.memUsedMiB !== null) out.set(s.gpu, s.memUsedMiB);
  return out;
}

function peakByGpu(samples: readonly GpuSample[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const s of samples) {
    if (s.memUsedMiB === null) continue;
    out.set(s.gpu, Math.max(out.get(s.gpu) ?? -Infinity, s.memUsedMiB));
  }
  return out;
}

/**
 * VRAM used by the run: peak total used memory minus the baseline taken before launch, per GPU
 * then summed. This is the "total-delta" method: it also counts what other processes allocated
 * meanwhile, so the engine's own per-process peak (processPeakMiB) is preferred when available.
 */
export function vram(baselineSamples: readonly GpuSample[], runSamples: readonly GpuSample[]): VramResult {
  const base = lastByGpu(baselineSamples);
  const peak = peakByGpu(runSamples);
  const out: VramResult = {};
  if (base.size) out.baselineMiB = [...base.values()].reduce((a, b) => a + b, 0);
  if (!peak.size) return out;
  out.peakMiB = [...peak.values()].reduce((a, b) => a + b, 0);
  if (base.size) {
    let delta = 0;
    for (const [gpu, p] of peak) delta += Math.max(0, p - (base.get(gpu) ?? p));
    out.deltaMiB = delta;
  }
  return out;
}

/**
 * Largest change (MiB) of the VRAM held by OTHER processes during the run, relative to the first
 * per-process reading (taken before the first load). Left out: every PID ever attributed to the
 * engine and, when the engine has no PID of its own (Docker), also VMs (on Windows containers run
 * inside the WSL VM, vmwp) and processes that appear during the run (on Linux a container's
 * processes are new host processes). undefined when no reading listed any process (WSL, counters
 * unavailable): nothing is known about the others.
 */
export function othersDriftMiB(ticks: readonly ProcessVramTick[], opts: { engineHasPid: boolean }): number | undefined {
  const first = ticks[0];
  if (!first || !ticks.some((t) => t.procs.length > 0)) return undefined;
  const engine = new Set(ticks.flatMap((t) => t.engine));
  const counts = (p: GpuProcessMemory) =>
    !engine.has(p.pid) && (opts.engineHasPid || p.name === undefined || gpuUserKind(p.name) !== 'vm');
  const before = new Set(first.procs.filter(counts).map((p) => p.pid));
  const others = (t: ProcessVramTick) =>
    t.procs.reduce((sum, p) => sum + (counts(p) && (opts.engineHasPid || before.has(p.pid)) ? p.mib : 0), 0);
  const base = others(first);
  return Math.round(ticks.reduce((max, t) => Math.max(max, Math.abs(others(t) - base)), 0));
}

function lowestGpu(samples: readonly GpuSample[]): number | undefined {
  return samples.length ? samples.reduce((m, s) => (s.gpu < m ? s.gpu : m), Infinity) : undefined;
}

/** GPU whose memory grew the most during the run (the one the engine used); lowest index on ties. */
export function primaryGpu(baselineSamples: readonly GpuSample[], runSamples: readonly GpuSample[]): number {
  const base = lastByGpu(baselineSamples);
  const peak = peakByGpu(runSamples);
  let best = lowestGpu([...runSamples, ...baselineSamples]) ?? 0;
  let bestDelta = 0;
  for (const [gpu, p] of [...peak].sort((a, b) => a[0] - b[0])) {
    const d = p - (base.get(gpu) ?? p);
    if (d > bestDelta) {
      best = gpu;
      bestDelta = d;
    }
  }
  return best;
}

/** Reasons that always mean the GPU was slowed down by heat or the power brake. */
export const SEVERE_THROTTLE_REASONS = [
  'hw_slowdown',
  'hw_thermal_slowdown',
  'hw_power_brake_slowdown',
  'sw_thermal_slowdown',
] as const;
/** Normal under full load (boost hits the power limit); counted only when sustained. */
export const POWER_CAP_REASON = 'sw_power_cap';
/** Share of measurement samples with sw_power_cap above which it counts as throttling. */
export const POWER_CAP_SHARE = 0.2;

function normalizeReason(r: string): string {
  return r.trim().toLowerCase().replace(/^.*\./, '');
}

function inWindows(t: number, windows: readonly Window[] | undefined): boolean {
  return !windows || windows.some(([a, b]) => t >= a && t <= b);
}

/**
 * Throttling reasons seen during the measurement windows (all samples when no windows are given).
 * gpu_idle, applications_clocks_setting, sync_boost and display clock reasons are benign and
 * ignored; sw_power_cap counts only when present in more than 20% of the samples.
 */
export function throttling(samples: readonly GpuSample[], windows?: readonly Window[]): string[] {
  const severe = new Set<string>(SEVERE_THROTTLE_REASONS);
  const selected = samples.filter((s) => inWindows(s.t, windows));
  const found = new Set<string>();
  let capped = 0;
  for (const s of selected) {
    const reasons = s.throttle.map(normalizeReason);
    for (const r of reasons) if (severe.has(r)) found.add(r);
    if (reasons.includes(POWER_CAP_REASON)) capped++;
  }
  if (selected.length > 0 && capped / selected.length > POWER_CAP_SHARE) found.add(POWER_CAP_REASON);
  return [...found].sort();
}

export function maxTemp(samples: readonly GpuSample[]): number | undefined {
  const temps = samples.map((s) => s.tempC).filter((v): v is number => v !== null);
  return temps.length ? temps.reduce((a, b) => (b > a ? b : a)) : undefined;
}

export interface LoadPhase {
  name: string;
  /** ms from the start of the load (process/container start). */
  startMs: number;
  endMs: number;
}

/** Phase marks (start points) → intervals: each phase ends at the next mark, the last one at ready. */
export function toLoadPhases(marks: readonly PhaseMark[], t0: number, tReady: number): LoadPhase[] {
  const sorted = [...marks].sort((a, b) => a.t - b.t);
  return sorted.map((m, i) => ({
    name: m.name,
    startMs: m.t - t0,
    endMs: (sorted[i + 1]?.t ?? tReady) - t0,
  }));
}

/**
 * Estimated disk read speed of a cold load (bytes/s): model bytes over the `load_tensors` phase
 * when the engine logs it, else over the whole cold load.
 */
export function coldReadSpeed(modelBytes: number, phases: readonly LoadPhase[], coldLoadMs?: number): number | undefined {
  const lt = phases.find((p) => p.name === 'load_tensors' && p.endMs > p.startMs);
  const ms = lt ? lt.endMs - lt.startMs : coldLoadMs;
  return modelBytes > 0 && ms !== undefined && ms > 0 ? modelBytes / (ms / 1000) : undefined;
}

const round1 = (v: number): number => Math.round(v * 10) / 10;

function avgOf(values: readonly (number | null)[]): number | null {
  const v = values.filter((x): x is number => x !== null);
  return v.length ? round1(v.reduce((a, b) => a + b, 0) / v.length) : null;
}

function maxOf(values: readonly (number | null)[]): number | null {
  const v = values.filter((x): x is number => x !== null);
  return v.length ? round1(v.reduce((a, b) => (b > a ? b : a))) : null;
}

export interface DownsampleOptions {
  /** Monotonic ms of the run start: stored times are relative to it. */
  origin?: number;
  /** Sampling interval of the input (ms). */
  intervalMs?: number;
  maxPoints?: number;
  /** GPU to keep (defaults to the lowest index present). */
  gpu?: number;
}

/**
 * Columnar, downsampled telemetry for one GPU, stored with the run. Buckets of consecutive
 * samples are averaged, except memory which keeps the bucket maximum so the VRAM peak survives.
 */
export function downsampleTelemetry(
  samples: readonly GpuSample[],
  marks: readonly { t: number; label: string }[],
  opts: DownsampleOptions = {},
): TelemetrySeries {
  const origin = opts.origin ?? 0;
  const maxPoints = Math.max(1, opts.maxPoints ?? 2000);
  const gpu = opts.gpu ?? lowestGpu(samples) ?? 0;
  const s = samples.filter((x) => x.gpu === gpu).sort((a, b) => a.t - b.t);
  const bucket = Math.max(1, Math.ceil(s.length / maxPoints));
  const series: TelemetrySeries = {
    intervalMs: (opts.intervalMs ?? 250) * bucket,
    t: [],
    utilPct: [],
    memUsedMiB: [],
    powerW: [],
    tempC: [],
    smClockMHz: [],
    marks: marks.map((m) => ({ t: Math.round(m.t - origin), label: m.label })),
  };
  for (let i = 0; i < s.length; i += bucket) {
    const g = s.slice(i, i + bucket);
    series.t.push(Math.round(g.reduce((a, x) => a + x.t, 0) / g.length - origin));
    series.utilPct.push(avgOf(g.map((x) => x.utilPct)));
    series.memUsedMiB.push(maxOf(g.map((x) => x.memUsedMiB)));
    series.powerW.push(avgOf(g.map((x) => x.powerW)));
    series.tempC.push(avgOf(g.map((x) => x.tempC)));
    series.smClockMHz.push(avgOf(g.map((x) => x.smClockMHz)));
  }
  return series;
}
