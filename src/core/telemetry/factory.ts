import { AppError, toAppErrorData, type AppErrorData } from '../../contract/errors';
import type { GpuInfo, GpuSample } from '../../contract/hardware';
import type { CoreDeps } from '../deps';
import { NullTelemetry } from './null';
import { NvidiaSmiCli, locateNvidiaSmi, parseDriverInfo, type DriverInfo, type FileExists, type NvidiaSmiLocation } from './nvidia-smi';
import { createProcessMemory, type ProcessMemoryDeps } from './process-vram';
import { NvidiaSmiTelemetry } from './sampler';
import type { GpuUser, PidSource, ProcessVramSession, TelemetrySampler, TelemetrySession } from './types';

export interface TelemetryStatus {
  /** nvidia-smi binary located (or overridden). */
  found: boolean;
  path?: string;
  source?: NvidiaSmiLocation['source'];
  /** nvidia-smi answered and listed at least one GPU. */
  works: boolean;
  driverVersion?: string;
  cudaVersion?: string;
  gpuCount: number;
  /** Why it does not work (DRIVER_MISSING, GPU_NOT_FOUND…). */
  error?: AppErrorData;
}

/** TelemetrySampler plus detection status, as created by createTelemetry(). */
export interface Telemetry extends TelemetrySampler {
  status(): Promise<TelemetryStatus>;
  /** Forgets the detection (e.g. after a driver install) so the next call detects again. */
  refresh(): void;
  /** Always present here: undefined result when the detected sampler cannot attribute VRAM per process. */
  startProcessVram(pids: PidSource, intervalMs?: number): Promise<ProcessVramSession | undefined>;
}

export type TelemetryDeps = Pick<CoreDeps, 'clock' | 'proc' | 'platform' | 'env'> & {
  endpoints: Pick<CoreDeps['endpoints'], 'nvidiaSmi'>;
  log?: CoreDeps['log'];
};

export interface CreateTelemetryOptions {
  fileExists?: FileExists;
  timeoutMs?: number;
  maxSamples?: number;
  /** A failed detection is retried after this long, so a freshly installed driver is picked up (default 10 s). */
  retryMs?: number;
  /** Per-process VRAM tuning (tests): Windows monitor timings, Linux /proc reader. */
  processMemory?: Pick<ProcessMemoryDeps, 'windows' | 'procFs' | 'procRoot'>;
}

export interface Detection {
  sampler: TelemetrySampler;
  status: TelemetryStatus;
}

/** Driver/CUDA from `--version`; falls back to the plain header (old drivers lack --version or CUDA there). */
async function readDriverInfo(cli: NvidiaSmiCli): Promise<DriverInfo> {
  const v = await cli.run(['--version']);
  const fromVersion = v.code === 0 ? parseDriverInfo(v.stdout) : {};
  if (fromVersion.driverVersion && fromVersion.cudaVersion) return fromVersion;
  return { ...parseDriverInfo(await cli.text([])), ...fromVersion };
}

/** Locates nvidia-smi and checks it works (driver reachable, ≥ 1 GPU). Never rejects. */
export async function detectTelemetry(deps: TelemetryDeps, opts: CreateTelemetryOptions = {}): Promise<Detection> {
  let status: TelemetryStatus = { found: false, works: false, gpuCount: 0 };
  try {
    const location = await locateNvidiaSmi({
      platform: deps.platform,
      env: deps.env,
      override: deps.endpoints.nvidiaSmi,
      ...(opts.fileExists ? { fileExists: opts.fileExists } : {}),
    });
    if (!location) return { sampler: new NullTelemetry(), status };
    status = { ...status, found: true, path: location.path, source: location.source };
    const cli = new NvidiaSmiCli(deps.proc, location, opts.timeoutMs);
    const driver = await readDriverInfo(cli);
    status = { ...status, ...driver };
    const sampler = new NvidiaSmiTelemetry({
      clock: deps.clock,
      proc: deps.proc,
      location,
      driver,
      ...(deps.log ? { log: deps.log } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.maxSamples ? { maxSamples: opts.maxSamples } : {}),
      ...createProcessMemory({
        platform: deps.platform,
        proc: deps.proc,
        clock: deps.clock,
        env: deps.env,
        ...(deps.log ? { log: deps.log } : {}),
        cli,
        overridden: location.source === 'override',
        ...opts.processMemory,
      }),
    });
    const gpus = await sampler.probe();
    if (gpus.length === 0) throw new AppError('GPU_NOT_FOUND', 'nvidia-smi found no NVIDIA GPU');
    return { sampler, status: { ...status, works: true, gpuCount: gpus.length } };
  } catch (e) {
    deps.log?.warn('GPU telemetry unavailable', { error: String(e) });
    return { sampler: new NullTelemetry(), status: { ...status, error: toAppErrorData(e) } };
  }
}

/**
 * Starts sampling once detection finished; stop() before that returns [] without spawning anything.
 * Lets start() stay synchronous while detection is lazy.
 */
class DeferredSession implements TelemetrySession {
  private inner: TelemetrySession | undefined;
  private stopped = false;
  private readonly ready: Promise<void>;

  constructor(sampler: Promise<TelemetrySampler>, intervalMs: number, onSamples?: (samples: GpuSample[]) => void) {
    this.ready = sampler.then((s) => {
      if (!this.stopped) this.inner = s.start(intervalMs, onSamples);
    });
  }

  latest(): GpuSample[] {
    return this.inner?.latest() ?? [];
  }

  async stop(): Promise<GpuSample[]> {
    this.stopped = true;
    await this.ready;
    return this.inner ? this.inner.stop() : [];
  }
}

/**
 * Telemetry that detects nvidia-smi lazily on first use (no process is spawned at app start-up)
 * and delegates to NvidiaSmiTelemetry when it works, NullTelemetry otherwise.
 */
class AutoTelemetry implements Telemetry {
  private detection: { at: number; promise: Promise<Detection>; result?: Detection } | undefined;

  constructor(
    private readonly deps: TelemetryDeps,
    private readonly opts: CreateTelemetryOptions,
  ) {}

  /** Shared by concurrent callers; a failed detection is redone after retryMs, a working one is kept. */
  private detect(): Promise<Detection> {
    const now = this.deps.clock.now();
    const cur = this.detection;
    if (cur && (!cur.result || cur.result.status.works || now - cur.at < (this.opts.retryMs ?? 10_000))) return cur.promise;
    const entry: { at: number; promise: Promise<Detection>; result?: Detection } = {
      at: now,
      promise: detectTelemetry(this.deps, this.opts),
    };
    void entry.promise.then((r) => {
      entry.result = r;
    });
    this.detection = entry;
    return entry.promise;
  }

  refresh(): void {
    this.detection = undefined;
  }

  async status(): Promise<TelemetryStatus> {
    return (await this.detect()).status;
  }

  async available(): Promise<boolean> {
    return (await this.detect()).status.works;
  }

  async probe(): Promise<GpuInfo[]> {
    return (await this.detect()).sampler.probe();
  }

  async snapshot(): Promise<GpuSample[]> {
    return (await this.detect()).sampler.snapshot();
  }

  async otherGpuUsers(ownPids: number[]): Promise<GpuUser[]> {
    return (await this.detect()).sampler.otherGpuUsers(ownPids);
  }

  async startProcessVram(pids: PidSource, intervalMs?: number): Promise<ProcessVramSession | undefined> {
    const sampler = (await this.detect()).sampler;
    return sampler.startProcessVram ? sampler.startProcessVram(pids, intervalMs) : undefined;
  }

  start(intervalMs: number, onSamples?: (samples: GpuSample[]) => void): TelemetrySession {
    return new DeferredSession(
      this.detect().then((d) => d.sampler),
      intervalMs,
      onSamples,
    );
  }
}

/** Composition-root factory: one instance per core, shared by the system routes and the benchmark runner. */
export function createTelemetry(deps: TelemetryDeps, opts: CreateTelemetryOptions = {}): Telemetry {
  return new AutoTelemetry(deps, opts);
}
