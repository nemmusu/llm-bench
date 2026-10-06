import type { EngineConfig, EngineKind, EngineStatus, LaunchParams } from '../../contract/engines';
import type { EngineIdentity, LaunchRecord } from '../../contract/results';
import type { LocalModel, ModelIdentity } from '../../contract/models';
import type { ExitInfo, LogLine } from '../deps';
import type { InferenceClient } from '../inference/types';

/** Named load phase detected from timestamped log lines (llama.cpp load_tensors, vLLM "Loading weights took"…). */
export interface PhaseMark {
  name: string;
  /** Monotonic ms. */
  t: number;
}

export interface InstallPlan {
  kind: EngineKind;
  label: string;
  /** Total bytes to download (shown in the confirmation). */
  bytes: number;
  items: { label: string; url?: string; bytes: number }[];
  /** Opaque data the adapter needs to perform the install. */
  data: Record<string, unknown>;
}

export interface ProgressSink {
  (p: { stage: string; bytesDone: number; bytesTotal?: number }): void;
}

/** What a particular binary/image supports (probed from --help / version). */
export interface EngineCaps {
  version?: string;
  build?: string;
  variant?: string;
  flags: Set<string>;
  tokenIdsInPrompt: boolean;
  timings: boolean;
  minTokens: boolean;
  fitFlag: boolean;
}

/** The model as the engine will load it. */
export interface ModelTarget {
  identity: ModelIdentity;
  /** Local model (GGUF engines, or pre-downloaded HF folder for vLLM). */
  local?: LocalModel;
  /** HF repo id for vLLM when served from the HF cache. */
  repo?: string;
  /** Name to request from an external endpoint. */
  servedName?: string;
}

export interface LaunchPlan {
  kind: EngineKind;
  /** Exactly what will be executed; argv[0] is the program. Already the final form (no shell). */
  argv: string[];
  env: Record<string, string>;
  cwd?: string;
  host: string;
  port: number;
  params: LaunchParams;
  engine: EngineIdentity;
  /** Files the engine reads at load (for cache eviction and disk-speed estimate). */
  modelFiles: string[];
  modelBytes: number;
  /** Ownership marker placed in argv (e.g. --alias gpubench-<uuid>) or container label. */
  marker: string;
}

export interface EngineInstance {
  baseUrl: string;
  /** Monotonic ms when the process/container was started (t0 of load time). */
  t0: number;
  logs: AsyncIterable<LogLine>;
  /** Resolves when the server is ready to serve; rejects with AppError on exit/timeout/OOM. */
  waitReady(signal?: AbortSignal): Promise<{ tReady: number; phases: PhaseMark[] }>;
  client: InferenceClient;
  stop(): Promise<ExitInfo>;
  exited: Promise<ExitInfo>;
  /** Log lines captured so far (bounded), for the run's logExcerpt and diagnostics. */
  logTail(): string[];
}

export interface EngineAdapter {
  readonly kind: EngineKind;
  detect(cfg?: EngineConfig): Promise<EngineStatus>;
  installPlan?(cfg: EngineConfig): Promise<InstallPlan>;
  install?(plan: InstallPlan, progress: ProgressSink, signal: AbortSignal): Promise<void>;
  capabilities(cfg: EngineConfig): Promise<EngineCaps>;
  /** Pure: builds the exact command. Used for "Anteprima comando" and by start(). */
  plan(cfg: EngineConfig, model: ModelTarget, params: LaunchParams, opts: { port: number; marker: string }): Promise<LaunchPlan>;
  start(plan: LaunchPlan, signal: AbortSignal): Promise<EngineInstance>;
}

export function toLaunchRecord(plan: LaunchPlan, display: { powershell: string; bash: string }): LaunchRecord {
  return {
    argv: plan.argv,
    env: plan.env,
    ...(plan.cwd ? { cwd: plan.cwd } : {}),
    display,
    params: plan.params,
    host: plan.host,
    port: plan.port,
  };
}
