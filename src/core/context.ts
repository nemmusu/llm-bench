import type { CoreDeps } from './deps';
import type { SysInfo } from './sysinfo/fingerprint';
import type { Telemetry } from './telemetry/factory';
import type { EventHub } from './server/event-hub';
import type { SettingsRepo } from './store/settings-repo';

/**
 * Shared services handed to every route module. Modules add their own services here as the
 * app grows (runs repo, engines, models, downloads…), always created in createCore().
 */
export interface CoreContext {
  deps: CoreDeps;
  hub: EventHub;
  settings: SettingsRepo;
  /** Aborted when the core shuts down; long-running jobs listen to it. */
  shutdown: AbortSignal;
  /** In-memory secrets pushed by the Electron main (never written by the core, never logged). */
  secrets: { hfToken?: string };
  /** One NVIDIA sampler per core, shared by the system routes and the benchmark runner. */
  telemetry: Telemetry;
  sysinfo: SysInfo;
}
