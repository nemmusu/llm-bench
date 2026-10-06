import type { GpuSample } from '../../contract/hardware';
import type { Logger, ManagedProcess } from '../deps';
import type { ActiveField } from './fields';
import { parseSampleRow } from './parse';
import type { TelemetrySession } from './types';

export interface StreamSetup {
  fields: ActiveField[];
  /** GPUs seen by the last one-shot query: a batch is complete once it has this many lines. */
  gpuCount: number;
}

export interface StreamSessionOptions {
  intervalMs: number;
  /** Field resolution (one-shot query, cached by the sampler); the stream starts after it. */
  setup: Promise<StreamSetup>;
  /** Spawns the long-lived `nvidia-smi --query-gpu=… -lms N` child. */
  spawn: (fields: ActiveField[]) => ManagedProcess;
  onSamples?: ((samples: GpuSample[]) => void) | undefined;
  /** Oldest samples are dropped beyond this (200k ≈ 14 h at 250 ms on one GPU). */
  maxSamples: number;
  /** Unexpected exits survived by respawning (default 1). */
  maxRestarts?: number;
  log?: Logger | undefined;
  onEnd?: () => void;
}

/**
 * One long-running nvidia-smi streaming CSV. Lines are parsed as they arrive and stamped with the
 * LogLine time (Clock.now() at arrival, set by the ProcessRunner). nvidia-smi prints one line per
 * GPU per interval in index order, so a batch ends when every GPU reported or the index wraps.
 */
export class StreamSession implements TelemetrySession {
  readonly intervalMs: number;
  /** Respawns performed after unexpected exits. */
  restarts = 0;
  private readonly samples: GpuSample[] = [];
  private readonly latestByGpu = new Map<number, GpuSample>();
  private batch: GpuSample[] = [];
  private child: ManagedProcess | undefined;
  private stopped = false;
  private stopping: Promise<GpuSample[]> | undefined;
  private readonly loop: Promise<void>;

  constructor(private readonly o: StreamSessionOptions) {
    this.intervalMs = o.intervalMs;
    this.loop = this.run();
  }

  latest(): GpuSample[] {
    return [...this.latestByGpu.values()].sort((a, b) => a.gpu - b.gpu);
  }

  /** Stops only the child this session spawned and returns every sample kept. Idempotent. */
  stop(): Promise<GpuSample[]> {
    this.stopping ??= (async () => {
      this.stopped = true;
      await this.child?.stop({ graceMs: 1000 });
      await this.loop;
      this.o.onEnd?.();
      return [...this.samples];
    })();
    return this.stopping;
  }

  private async run(): Promise<void> {
    let setup: StreamSetup;
    try {
      setup = await this.o.setup;
    } catch (e) {
      this.o.log?.warn('telemetry stream not started', { error: String(e) });
      return;
    }
    const maxRestarts = this.o.maxRestarts ?? 1;
    while (!this.stopped) {
      let child: ManagedProcess;
      try {
        child = this.o.spawn(setup.fields);
      } catch (e) {
        this.o.log?.warn('telemetry stream spawn failed', { error: String(e) });
        return;
      }
      this.child = child;
      for await (const line of child.lines) {
        if (line.stream === 'stdout') this.onLine(line.text, line.t, setup.gpuCount, setup.fields);
      }
      this.flush();
      if (this.stopped) return;
      if (this.restarts >= maxRestarts) {
        this.o.log?.warn('telemetry stream exited, giving up', { restarts: this.restarts });
        return;
      }
      this.restarts++;
      this.o.log?.warn('telemetry stream exited, restarting', { restarts: this.restarts });
    }
  }

  private onLine(text: string, t: number, gpuCount: number, fields: ActiveField[]): void {
    const s = parseSampleRow(text, fields, t);
    if (!s) return;
    const last = this.batch[this.batch.length - 1];
    if (last && s.gpu <= last.gpu) this.flush();
    // latest() is for live gauges: update it per line, not per completed batch.
    this.latestByGpu.set(s.gpu, s);
    this.batch.push(s);
    if (gpuCount > 0 && this.batch.length >= gpuCount) this.flush();
  }

  private flush(): void {
    if (this.batch.length === 0) return;
    const batch = this.batch;
    this.batch = [];
    this.samples.push(...batch);
    const excess = this.samples.length - this.o.maxSamples;
    if (excess > 0) this.samples.splice(0, excess);
    try {
      this.o.onSamples?.(batch);
    } catch (e) {
      // A broken subscriber must not stop the measurement.
      this.o.log?.warn('telemetry subscriber failed', { error: String(e) });
    }
  }
}
