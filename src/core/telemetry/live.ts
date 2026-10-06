import type { GpuSample } from '../../contract/hardware';
import type { Clock } from '../deps';
import type { TelemetrySampler } from './types';

/**
 * Backs GET /api/telemetry/snapshot for the "Monitor GPU" page, which polls it every second.
 *
 * Why polling instead of a refcounted background stream publishing 'telemetry' events:
 *  - the SSE hub cannot tell whether the Monitor page is visible (the renderer keeps /api/events
 *    open on every page), so a stream would need explicit start/stop leases that leak when the
 *    renderer reloads or crashes;
 *  - polling is stateless, survives reloads, and costs one short nvidia-smi run per second only
 *    while the page is open;
 *  - during a benchmark the sampler serves snapshots from the run's -lms stream, so the monitor
 *    adds no process churn exactly when measurements must stay clean.
 *
 * This helper coalesces concurrent requests (several windows/tabs) into one nvidia-smi run and
 * reuses a result younger than `maxAgeMs`.
 */
export class LiveTelemetry {
  private cached: { at: number; samples: GpuSample[] } | undefined;
  private inflight: Promise<GpuSample[]> | undefined;

  constructor(
    private readonly sampler: Pick<TelemetrySampler, 'snapshot'>,
    private readonly clock: Clock,
    private readonly maxAgeMs = 500,
  ) {}

  read(): Promise<GpuSample[]> {
    const c = this.cached;
    if (c && this.clock.now() - c.at < this.maxAgeMs) return Promise.resolve(c.samples);
    this.inflight ??= this.sampler.snapshot().then(
      (samples) => {
        this.cached = { at: this.clock.now(), samples };
        this.inflight = undefined;
        return samples;
      },
      (e: unknown) => {
        this.inflight = undefined;
        throw e;
      },
    );
    return this.inflight;
  }
}
