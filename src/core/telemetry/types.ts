import type { GpuInfo, GpuSample } from '../../contract/hardware';

/**
 * What a GPU process is, for the "shared GPU" rules: 'llm' = a known LLM server, 'vm' = WSL / Hyper-V /
 * Docker Desktop VM (its memory belongs to programs inside it), 'system' = the OS desktop (compositor,
 * shell), 'app' = anything else.
 */
export type GpuUserKind = 'llm' | 'vm' | 'system' | 'app';

export interface GpuUser {
  pid: number;
  name: string;
  /** true for well-known LLM servers (llama-server, ollama, vllm, lm studio…): these skew results. */
  knownLlm: boolean;
  /** Dedicated VRAM held (MiB), when the OS can tell: Windows GPU counters, nvidia-smi outside WDDM. */
  memMiB?: number;
  kind?: GpuUserKind;
}

/** Dedicated VRAM one process holds at a reading. */
export interface GpuProcessMemory {
  pid: number;
  /** MiB, fractional (Windows counters are bytes). */
  mib: number;
  /** Executable name or path, when known. */
  name?: string;
}

/** One per-process reading taken while an engine runs. */
export interface ProcessVramTick {
  /** Clock.now() at arrival. */
  t: number;
  /** Engine PIDs at this reading, descendants included. */
  engine: number[];
  /** VRAM held by those PIDs (MiB). */
  engineMiB: number;
  /** Every process holding GPU memory at this reading (engine included). */
  procs: GpuProcessMemory[];
}

/** PIDs to attribute, or a function read at every tick (engines are restarted between loads). */
export type PidSource = readonly number[] | (() => readonly number[]);

/** Per-process VRAM of the engine during a run (ProcessVramSampler.start). */
export interface ProcessVramSession {
  /** Engine VRAM (MiB) at the last reading; undefined while the engine PIDs hold no GPU memory. */
  latestMiB(): number | undefined;
  /** Highest engine VRAM seen (MiB); undefined when the engine never appeared (not attributable). */
  peakMiB(): number | undefined;
  /** Every reading so far (the first one is always kept). */
  readonly samples: readonly ProcessVramTick[];
  /** Stops sampling (only our own helper process, if any) and returns every reading. Idempotent. */
  stop(): Promise<ProcessVramTick[]>;
}

export interface TelemetrySession {
  /** Most recent sample per GPU (index 0 first). */
  latest(): GpuSample[];
  /** Stops sampling and returns every sample collected (t = Clock.now() at arrival). */
  stop(): Promise<GpuSample[]>;
}

export interface TelemetrySampler {
  /** false when no NVIDIA driver / nvidia-smi is available ("telemetria non disponibile"). */
  available(): Promise<boolean>;
  /** Static info per GPU (name, VRAM, driver, CUDA version from the nvidia-smi header…). */
  probe(): Promise<GpuInfo[]>;
  /** One-shot reading, used for VRAM baselines and the live monitor. */
  snapshot(): Promise<GpuSample[]>;
  /** Processes using the GPU that GPU Bench did not start (with their VRAM and kind when known). */
  otherGpuUsers(ownPids: number[]): Promise<GpuUser[]>;
  /** Continuous sampling with a single long-running nvidia-smi (-lms). */
  start(intervalMs: number, onSamples?: (samples: GpuSample[]) => void): TelemetrySession;
  /**
   * Per-process VRAM sampling of the given PIDs (and their descendants on Linux). Resolves after the
   * first reading; undefined when this OS/driver cannot attribute memory per process.
   */
  startProcessVram?(pids: PidSource, intervalMs?: number): Promise<ProcessVramSession | undefined>;
}
