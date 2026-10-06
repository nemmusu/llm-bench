import { isAppError } from '../../contract/errors';
import type { GpuInfo, GpuSample } from '../../contract/hardware';
import type { Clock, Logger, ProcessRunner } from '../deps';
import type { FieldChoice } from './fields';
import { gpuUserKind, isKnownLlm, processBaseName } from './known-llm';
import { NvidiaSmiCli, type DriverInfo, type NvidiaSmiLocation } from './nvidia-smi';
import { PROBE_FIELDS, SAMPLE_FIELDS, parseComputeApps, parseProbe, parseSamples, type ComputeApp } from './parse';
import {
  COMPUTE_APPS_ARGS,
  MIN_PROCESS_VRAM_INTERVAL_MS,
  PROCESS_VRAM_INTERVAL_MS,
  ProcessVramRecorder,
  type ProcessMemorySetup,
} from './process-vram';
import { StreamSession, type StreamSetup } from './session';
import type { GpuProcessMemory, GpuUser, PidSource, ProcessVramSession, TelemetrySampler, TelemetrySession } from './types';

export const DEFAULT_MAX_SAMPLES = 200_000;
/** nvidia-smi itself needs a few ms per query; below this the stream only burns CPU. */
export const MIN_INTERVAL_MS = 50;
/** Owner recorded in the process registry for every telemetry child. */
export const TELEMETRY_OWNER = { runId: 'telemetry', marker: 'nvidia-smi' } as const;

export interface NvidiaSmiTelemetryOptions extends ProcessMemorySetup {
  clock: Clock;
  proc: ProcessRunner;
  location: NvidiaSmiLocation;
  /** Driver/CUDA version read once at detection (CUDA only appears in the header / --version). */
  driver?: DriverInfo;
  log?: Logger;
  timeoutMs?: number;
  maxSamples?: number;
}

/** Processes seen only by the OS counters are listed from this size up (the desktop has dozens of tiny ones). */
export const EXTRA_USER_MIN_MIB = 64;

function gpuUser(pid: number, processName: string, memMiB: number | undefined): GpuUser {
  return {
    pid,
    name: processBaseName(processName),
    knownLlm: isKnownLlm(processName),
    kind: gpuUserKind(processName),
    ...(memMiB !== undefined ? { memMiB: Math.round(memMiB) } : {}),
  };
}

/**
 * Other GPU users: the nvidia-smi compute-apps list (memory summed over GPUs; "[N/A]" under WDDM),
 * with memory from the OS counters when given (a listed process absent from them holds 0), plus
 * counter-only processes above EXTRA_USER_MIN_MIB (vmwp, dwm… never appear in compute-apps), largest
 * first. Our own PIDs are never listed.
 */
export function mergeGpuUsers(apps: readonly ComputeApp[], counted: readonly GpuProcessMemory[] | undefined, ownPids: readonly number[]): GpuUser[] {
  const own = new Set(ownPids);
  const mem = new Map((counted ?? []).map((c) => [c.pid, c.mib]));
  const users = new Map<number, GpuUser>();
  for (const app of apps) {
    if (own.has(app.pid)) continue;
    const prev = users.get(app.pid);
    if (!prev) {
      users.set(app.pid, gpuUser(app.pid, app.processName, counted ? (mem.get(app.pid) ?? 0) : (app.usedMiB ?? undefined)));
    } else if (!counted && app.usedMiB !== null) {
      // A process using several GPUs is listed once per GPU.
      prev.memMiB = (prev.memMiB ?? 0) + Math.round(app.usedMiB);
    }
  }
  for (const c of [...(counted ?? [])].sort((a, b) => b.mib - a.mib)) {
    if (own.has(c.pid) || users.has(c.pid) || c.mib <= EXTRA_USER_MIN_MIB || !c.name) continue;
    users.set(c.pid, gpuUser(c.pid, c.name, c.mib));
  }
  return [...users.values()];
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

  async otherGpuUsers(ownPids: number[]): Promise<GpuUser[]> {
    const [apps, counted] = await Promise.all([
      emptyWhenNoGpu(async () => parseComputeApps(await this.cli.text(COMPUTE_APPS_ARGS))),
      this.o.userMemory?.read(),
    ]);
    return mergeGpuUsers(apps, counted, ownPids);
  }

  /** Engine VRAM per process (Windows GPU counters, nvidia-smi on Linux); undefined without a source. */
  async startProcessVram(pids: PidSource, intervalMs = PROCESS_VRAM_INTERVAL_MS): Promise<ProcessVramSession | undefined> {
    const source = this.o.processMemory;
    if (!source) return undefined;
    const recorder = new ProcessVramRecorder({
      source,
      clock: this.o.clock,
      pids,
      intervalMs: Math.max(MIN_PROCESS_VRAM_INTERVAL_MS, intervalMs),
      ...(this.o.expandPids ? { expand: this.o.expandPids } : {}),
    });
    await recorder.ready;
    return recorder;
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
