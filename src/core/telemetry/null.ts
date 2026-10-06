import type { GpuInfo, GpuSample } from '../../contract/hardware';
import type { GpuUser, TelemetrySampler, TelemetrySession } from './types';

/** No NVIDIA driver / nvidia-smi: every reading is empty and the UI shows "telemetria non disponibile". */
export class NullTelemetry implements TelemetrySampler {
  available(): Promise<boolean> {
    return Promise.resolve(false);
  }
  probe(): Promise<GpuInfo[]> {
    return Promise.resolve([]);
  }
  snapshot(): Promise<GpuSample[]> {
    return Promise.resolve([]);
  }
  otherGpuUsers(): Promise<GpuUser[]> {
    return Promise.resolve([]);
  }
  start(): TelemetrySession {
    return { latest: () => [], stop: () => Promise.resolve([]) };
  }
}
