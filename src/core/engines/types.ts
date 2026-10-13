import type { MissingFlag } from '../../contract/custom-engines';
import { engineBaseOf, type EngineConfig, type EngineKind, type EngineStatus, type LaunchParams } from '../../contract/engines';
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
  /** Choices argparse lists for an option, by spelling (vLLM `--help`: "--kv-cache-dtype" → ["auto", "fp8", …]). */
  choices?: Record<string, string[]>;
}

/** A hub GGUF that is not downloaded yet: what its download will create in the library. */
export interface PendingDownload {
  repo: string;
  /** Path inside the repo of the file llama.cpp opens (first shard of a split model). */
  file: string;
  /** Absolute paths the downloader will write, weights only (every shard). */
  paths: string[];
  bytes: number;
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
  /** Set instead of `local` for a GGUF still to download: plan previews only, a real start refuses it. */
  pending?: PendingDownload;
}

/** Parts of a previewed command that do not exist yet (they are installed/downloaded before the run). */
export type PendingPart = 'engine' | 'model';

export interface PlanOptions {
  port: number;
  marker: string;
  /**
   * Plan preview ("Anteprima comando"): a missing engine or model is replaced by where its install
   * or download will put it, and the plan lists it in `pending`. Never set when starting a run.
   */
  preview?: boolean;
  /**
   * Servers for other programs: the model name the API shows (e.g. "Qwen3-4B-Q4_K_M"). The marker
   * stays as a second name, so ownership checks and readiness probes keep working. Benchmarks leave
   * it unset (the API then only knows the marker).
   */
  apiName?: string;
  /**
   * Options the engine's --help lists, when the caller knows them (a fork's check): GPU Bench's own
   * flags the build lacks are left out and listed in LaunchPlan.unsupported. llama.cpp adapters read
   * them from their own probe; undefined elsewhere = pass everything.
   */
  knownFlags?: ReadonlySet<string>;
}

/**
 * EngineConfig as the core passes it to adapters: a custom engine also brings the environment its
 * --version / --help probes need (a fork's LD_LIBRARY_PATH…).
 */
export type CoreEngineConfig = EngineConfig & { probeEnv?: Record<string, string> };

/** The model name a GPU Bench server shows to other programs: the HF repo for vLLM / SGLang, else the model's own name. */
export function serverApiName(kind: EngineKind, model: ModelTarget): string {
  const base = engineBaseOf(kind);
  const repoNamed = base === 'vllm' || base === 'sglang';
  const name = (repoNamed ? (model.repo ?? model.identity.repo) : undefined) ?? model.identity.displayName;
  // llama.cpp splits --alias at commas; spaces are awkward in client settings.
  return name.replace(/[,\s]+/g, '-');
}

/**
 * GGUF weights to load: the local files (auxiliary mmproj/mtp/draft files are never loaded for
 * benchmarks), or in a preview the paths a pending download will create. Empty = nothing to load.
 */
export function weightFiles(model: ModelTarget, preview = false): { files: string[]; pending: boolean } {
  const local = model.local;
  if (local) {
    const aux = new Set(local.auxiliary.map((a) => a.path));
    return { files: local.paths.filter((p) => !aux.has(p)), pending: false };
  }
  const files = preview ? (model.pending?.paths ?? []) : [];
  return { files, pending: files.length > 0 };
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
  /** Preview only: parts of argv that are placeholders until an install/download (see PlanOptions.preview). */
  pending?: PendingPart[];
  /** GPU Bench flags the build does not know: left out of argv (the engine's default applies). */
  unsupported?: MissingFlag[];
}

export interface EngineInstance {
  baseUrl: string;
  /**
   * PID of the engine process we spawned (per-process VRAM attribution). Absent for engines whose
   * process is not ours or not visible as such: Docker containers, external endpoints.
   */
  pid?: number;
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
  /** Pure: builds the exact command. Used for "Anteprima comando" (opts.preview) and by start(). */
  plan(cfg: EngineConfig, model: ModelTarget, params: LaunchParams, opts: PlanOptions): Promise<LaunchPlan>;
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
