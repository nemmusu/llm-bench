import type { GpuInfo, GpuSample } from '../../contract/hardware';

export interface GpuUser {
  pid: number;
  name: string;
  /** true for well-known LLM servers (llama-server, ollama, vllm, lm studio…): these skew results. */
  knownLlm: boolean;
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
  /** Processes using the GPU that GPU Bench did not start. */
  otherGpuUsers(ownPids: number[]): Promise<GpuUser[]>;
  /** Continuous sampling with a single long-running nvidia-smi (-lms). */
  start(intervalMs: number, onSamples?: (samples: GpuSample[]) => void): TelemetrySession;
}
