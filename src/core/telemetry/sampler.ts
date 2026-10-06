import { isAppError } from '../../contract/errors';
import type { GpuInfo, GpuSample } from '../../contract/hardware';
import type { Clock, Logger, ProcessRunner } from '../deps';
import type { FieldChoice } from './fields';
import { isKnownLlm, processBaseName } from './known-llm';
import { NvidiaSmiCli, type DriverInfo, type NvidiaSmiLocation } from './nvidia-smi';
import { PROBE_FIELDS, SAMPLE_FIELDS, parseComputeApps, parseProbe, parseSamples } from './parse';
import { StreamSession, type StreamSetup } from './session';
import type { GpuUser, TelemetrySampler, TelemetrySession } from './types';

export const DEFAULT_MAX_SAMPLES = 200_000;
/** nvidia-smi itself needs a few ms per query; below this the stream only burns CPU. */
export const MIN_INTERVAL_MS = 50;
/** Owner recorded in the process registry for every telemetry child. */
export const TELEMETRY_OWNER = { runId: 'telemetry', marker: 'nvidia-smi' } as const;

export interface NvidiaSmiTelemetryOptions {
  clock: Clock;
  proc: ProcessRunner;
  location: NvidiaSmiLocation;
  /** Driver/CUDA version read once at detection (CUDA only appears in the header / --version). */
  driver?: DriverInfo;
  log?: Logger;
  timeoutMs?: number;
  maxSamples?: number;
}

/** "No devices were found" is a normal answer for lists, not an error. */
async function emptyWhenNoGpu<T>(fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn();
  } catch (e) {
    if (isAppError(e) && e.code === 'GPU_NOT_FOUND') return [];
    throw e;
  }
}

/** TelemetrySampler backed by the nvidia-smi CLI (no NVML bindings: no native modules). */
export class NvidiaSmiTelemetry implements TelemetrySampler {
  readonly cli: NvidiaSmiCli;
  private probeChoice: FieldChoice | undefined;
  private sampleChoice: FieldChoice | undefined;
  private setup: Promise<StreamSetup> | undefined;
  private readonly sessions = new Set<StreamSession>();

  constructor(private readonly o: NvidiaSmiTelemetryOptions) {
    this.cli = new NvidiaSmiCli(o.proc, o.location, o.timeoutMs);
  }

  async available(): Promise<boolean> {
    try {
      return (await this.probe()).length > 0;
    } catch {
      return false;
    }
  }

  probe(): Promise<GpuInfo[]> {
    return emptyWhenNoGpu(async () => {
      const r = await this.cli.queryFields('--query-gpu', PROBE_FIELDS, this.probeChoice);
      this.probeChoice = r.choice;
      return parseProbe(r.stdout, r.fields, this.o.driver);
    });
  }

  /**
   * One-shot reading. While one of our -lms sessions is running and fresh (every GPU reported
   * within 2 intervals, max 1 s) its latest samples are returned instead of spawning another
   * nvidia-smi, so the live monitor polling during a benchmark adds no extra process churn.
   */
  snapshot(): Promise<GpuSample[]> {
    const live = this.fromSessions();
    if (live) return Promise.resolve(live);
    return emptyWhenNoGpu(async () => (await this.querySamples()).samples);
  }

  otherGpuUsers(ownPids: number[]): Promise<GpuUser[]> {
    return emptyWhenNoGpu(async () => {
      const stdout = await this.cli.text(['--query-compute-apps=pid,process_name,used_memory', '--format=csv,noheader,nounits']);
      const own = new Set(ownPids);
      const seen = new Set<number>();
      const out: GpuUser[] = [];
      // A process using several GPUs is listed once per GPU.
      for (const app of parseComputeApps(stdout)) {
        if (own.has(app.pid) || seen.has(app.pid)) continue;
        seen.add(app.pid);
        out.push({ pid: app.pid, name: processBaseName(app.processName), knownLlm: isKnownLlm(app.processName) });
      }
      return out;
    });
  }

  start(intervalMs: number, onSamples?: (samples: GpuSample[]) => void): TelemetrySession {
    const interval = Math.max(MIN_INTERVAL_MS, Math.round(intervalMs));
    const session: StreamSession = new StreamSession({
      intervalMs: interval,
      setup: this.streamSetup(),
      spawn: (fields) =>
        this.o.proc.spawn({
          ...this.cli.command([
            `--query-gpu=${fields.map((f) => f.name).join(',')}`,
            '--format=csv,noheader,nounits',
            // Never "-c": for nvidia-smi that is --compute-mode (a setter), not a sample count.
            '-lms',
            String(interval),
          ]),
          owner: { ...TELEMETRY_OWNER },
        }),
      onSamples,
      maxSamples: this.o.maxSamples ?? DEFAULT_MAX_SAMPLES,
      log: this.o.log,
      onEnd: () => this.sessions.delete(session),
    });
    this.sessions.add(session);
    return session;
  }

  private async querySamples(): Promise<{ samples: GpuSample[]; setup: StreamSetup }> {
    const r = await this.cli.queryFields('--query-gpu', SAMPLE_FIELDS, this.sampleChoice);
    this.sampleChoice = r.choice;
    const samples = parseSamples(r.stdout, r.fields, this.o.clock.now());
    return { samples, setup: { fields: r.fields, gpuCount: samples.length } };
  }

  /** Field resolution shared by concurrent start() calls; forgotten on failure so a later start retries. */
  private streamSetup(): Promise<StreamSetup> {
    this.setup ??= this.querySamples().then(
      (r) => r.setup,
      (e: unknown) => {
        this.setup = undefined;
        throw e;
      },
    );
    return this.setup;
  }

  private fromSessions(): GpuSample[] | undefined {
    const now = this.o.clock.now();
    for (const s of this.sessions) {
      const latest = s.latest();
      const maxAge = Math.min(2 * s.intervalMs, 1000);
      if (latest.length > 0 && latest.every((x) => now - x.t <= maxAge)) return latest;
    }
    return undefined;
  }
}
