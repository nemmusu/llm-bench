/**
 * What an engine is doing while it starts, read line by line from its log: "caricando i pesi 3/7",
 * "cattura dei grafi CUDA 30/67"… Shown live on the run screen (run.load) and in the servers list
 * (ServerInfo.loading). Patterns are not anchored: vLLM lines carry "(EngineCore_DP0 pid=255) INFO …"
 * prefixes, llama.cpp lines may carry --log-prefix / --log-timestamps.
 */
import { engineBaseOf, isDockerKind, type EngineKind } from '../../../contract/engines';
import { LOAD_STAGES, type LoadProgress, type LoadStage } from '../../../contract/events';
import { ninferProgress } from '../ninfer/logs';
import { sglangProgress } from './sglang';

/** What one log line says about the start: the stage and, when the line has it, how far along. */
export type LoadUpdate = Omit<LoadProgress, 'elapsedMs' | 'expectedMs'>;

/** "(EngineCore_DP0 pid=255) INFO 10-06 09:20:23 [default_loader.py:267] msg" → "msg" (also trims). */
export function logMessage(line: string): string {
  return line
    .replace(/^\s*(?:\([^)]*\)\s*)?(?:INFO|WARNING|DEBUG|ERROR)\s+\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?\s+\[[^\]]*\]\s*/, '')
    .trim()
    .slice(0, 160);
}

/** The last "<pct>% … | done/total" of a tqdm line (several redraws can share one line). */
function lastTqdm(line: string, re: RegExp): { done: number; total: number } | undefined {
  let last: RegExpExecArray | undefined;
  for (const m of line.matchAll(re)) last = m as RegExpExecArray;
  if (!last) return undefined;
  return { done: Number(last[1]), total: Number(last[2]) };
}

const counted = (stage: LoadStage, c: { done: number; total: number }): LoadUpdate => ({
  stage,
  done: c.done,
  total: c.total,
  ...(c.total > 0 ? { fraction: Math.min(1, c.done / c.total) } : {}),
});

const SHARDS = /checkpoint shards:\s*\d+%\s*Completed\s*\|\s*(\d+)\/(\d+)/g;
const GRAPHS = /Capturing (?:CUDA graphs?|cudagraphs?)[^:]*:\s*\d+%\|[^|]*\|\s*(\d+)\/(\d+)/g;

function vllmProgress(line: string): LoadUpdate | undefined {
  const shards = lastTqdm(line, SHARDS);
  if (shards) return counted('weights', shards);
  const graphs = lastTqdm(line, GRAPHS);
  if (graphs) return counted('cuda-graphs', graphs);
  const detail = logMessage(line);
  if (/Application startup complete/.test(line)) return { stage: 'ready' };
  if (/Starting vLLM API server|Started server process|Waiting for application startup/.test(line)) return { stage: 'api-server', detail };
  if (/init engine \(profile, create kv cache, warmup model\) took/.test(line)) return { stage: 'warmup', fraction: 1, detail };
  if (/Graph capturing finished/.test(line)) return { stage: 'cuda-graphs', fraction: 1, detail };
  if (/Capturing (?:CUDA graphs?|cudagraphs?)/.test(line)) return { stage: 'cuda-graphs' };
  if (/GPU KV cache size|Maximum concurrency for/.test(line)) return { stage: 'kv-cache', detail };
  if (/Memory profiling takes|Available KV cache memory/.test(line)) return { stage: 'memory-profile', detail };
  if (/torch\.compile|Dynamo bytecode transform|Compiling a graph|Directly load the compiled graph/.test(line)) return { stage: 'compile', detail };
  if (/Loading weights took|Model loading took/.test(line)) return { stage: 'weights', fraction: 1, detail };
  if (/Loading (?:safetensors|pt) checkpoint shards|Starting to load model/.test(line)) return { stage: 'weights', detail };
  return undefined;
}

function llamaProgress(line: string): LoadUpdate | undefined {
  const text = line.trim();
  // The model loader prints one dot per percent while it reads the weights, then a line break.
  if (/^\.{3,}$/.test(text)) return { stage: 'weights', fraction: Math.min(1, text.length / 100) };
  if (/\bserver is listening on http|\bmain: model loaded\b/.test(line)) return { stage: 'ready' };
  if (/\binitializing slots\b/.test(line)) return { stage: 'api-server' };
  if (/\bwarming up the model\b/.test(line)) return { stage: 'warmup' };
  if (/\bllama_kv_cache|\bllama_context:|\bllama_init_from_model:|\bllama_new_context_with_model:/.test(line)) return { stage: 'kv-cache' };
  const offloaded = /\boffloaded (\d+)\/(\d+) layers to GPU/.exec(line);
  if (offloaded) return { stage: 'weights', detail: `offloaded ${offloaded[1]}/${offloaded[2]} layers to GPU` };
  if (/\bload_tensors:/.test(line)) return { stage: 'weights' };
  if (/\bllama_model_loader: loaded meta data\b|\bload_model: loading model\b|\bmain: loading model\b/.test(line)) return { stage: 'metadata' };
  return undefined;
}

/**
 * What `line` says about the start of a `kind` engine; undefined = nothing (the stage stays as it is).
 * External endpoints and command programs print nothing LLM Bench knows.
 */
export function parseLoadProgress(line: string, kind: EngineKind): LoadUpdate | undefined {
  const base = engineBaseOf(kind);
  if (base === 'vllm') return vllmProgress(line);
  if (base === 'sglang') return sglangProgress(line);
  if (base === 'ninfer') return ninferProgress(line);
  return base === 'llamacpp' ? llamaProgress(line) : undefined;
}

/** The stage before any engine line: a container is still starting, a process is just launched. */
export function initialStage(kind: EngineKind): LoadStage {
  return isDockerKind(kind) ? 'container' : 'starting';
}

/** Min ms between two updates of the same stage (stage changes are always sent at once). */
export const LOAD_PROGRESS_INTERVAL_MS = 250;

export interface LoadTrackerOptions {
  kind: EngineKind;
  /** Monotonic ms when the engine was started (EngineInstance.t0). */
  t0: number;
  now: () => number;
  emit: (p: LoadProgress) => void;
  /** Usual start → ready time from past runs. */
  expectedMs?: number;
  intervalMs?: number;
}

const order = (s: LoadStage): number => LOAD_STAGES.indexOf(s);

/**
 * Follows one engine start: feeds log lines through parseLoadProgress, never moves back to an
 * earlier stage, and emits at most every `intervalMs` within a stage. ready() sends the final
 * 'ready' and ignores whatever comes after.
 */
export class LoadTracker {
  private state: LoadProgress;
  private lastEmit = -Infinity;
  private pending = false;
  private done = false;

  constructor(private readonly o: LoadTrackerOptions) {
    this.state = { stage: initialStage(o.kind), elapsedMs: 0, ...(o.expectedMs !== undefined ? { expectedMs: o.expectedMs } : {}) };
    this.send(o.now());
  }

  /** The latest progress (what a reopened screen shows). */
  current(): LoadProgress {
    return this.state;
  }

  get finished(): boolean {
    return this.done;
  }

  line(text: string, t = this.o.now()): void {
    if (this.done) return;
    const u = parseLoadProgress(text, this.o.kind);
    if (!u || order(u.stage) < order(this.state.stage)) {
      if (this.pending && t - this.lastEmit >= (this.o.intervalMs ?? LOAD_PROGRESS_INTERVAL_MS)) this.send(t);
      return;
    }
    if (u.stage === 'ready') {
      this.ready(t);
      return;
    }
    const changed = u.stage !== this.state.stage;
    const base: LoadProgress = changed ? { stage: u.stage, elapsedMs: 0 } : { ...this.state };
    if (changed && this.state.expectedMs !== undefined) base.expectedMs = this.state.expectedMs;
    for (const k of ['fraction', 'done', 'total', 'detail'] as const) {
      if (u[k] !== undefined) (base as Record<string, unknown>)[k] = u[k];
    }
    this.state = base;
    this.pending = true;
    if (changed || t - this.lastEmit >= (this.o.intervalMs ?? LOAD_PROGRESS_INTERVAL_MS)) this.send(t);
  }

  /** The engine answers: last update. */
  ready(t = this.o.now()): void {
    if (this.done) return;
    this.done = true;
    this.state = { stage: 'ready', elapsedMs: 0, ...(this.state.expectedMs !== undefined ? { expectedMs: this.state.expectedMs } : {}) };
    this.send(t);
  }

  private send(t: number): void {
    this.state = { ...this.state, elapsedMs: Math.max(0, Math.round(t - this.o.t0)) };
    this.lastEmit = t;
    this.pending = false;
    this.o.emit(this.state);
  }
}
