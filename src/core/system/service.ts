import type { SystemResponse } from '../../contract/api';
import type { GpuInfo, GpuSample } from '../../contract/hardware';
import type { Settings } from '../../contract/settings';
import type { Clock, CorePaths, Logger } from '../deps';
import type { SysInfo } from '../sysinfo/fingerprint';
import type { TelemetryStatus } from '../telemetry/factory';
import { LiveTelemetry } from '../telemetry/live';
import type { GpuUser, TelemetrySampler } from '../telemetry/types';

export type DockerStatus = SystemResponse['docker'];

export interface SystemServiceOptions {
  paths: Pick<CorePaths, 'dataDir' | 'resultsDir' | 'modelsDir' | 'enginesDir'>;
  clock: Clock;
  settings: { get(): Promise<Pick<Settings, 'resultsDir' | 'modelsDir'>> };
  /** The shared sampler; `status()` (from createTelemetry) reports where nvidia-smi was found. */
  telemetry: TelemetrySampler & { status?(): Promise<Pick<TelemetryStatus, 'found' | 'path'>> };
  sysinfo: SysInfo;
  /** Docker state from the docker module; absent = "unknown". */
  dockerStatus?: () => Promise<DockerStatus>;
  /** PIDs LLM Bench started (process registry), never reported as "other" GPU users. */
  ownPids?: () => number[];
  log?: Logger;
  /** Snapshot reuse window for the polling monitor (default 500 ms). */
  liveMaxAgeMs?: number;
  /** GPU users reuse window (default 2.5 s): the UI polls /api/system, the list changes slowly. */
  usersMaxAgeMs?: number;
}

export const USERS_MAX_AGE_MS = 2500;

export interface SystemService {
  /** GET /api/system */
  system(): Promise<SystemResponse>;
  /** GET /api/telemetry/snapshot (polled every second by "Monitor GPU"). */
  snapshot(): Promise<GpuSample[]>;
}

export function createSystemService(o: SystemServiceOptions): SystemService {
  const live = new LiveTelemetry(o.telemetry, o.clock, o.liveMaxAgeMs);

  // Other GPU users (nvidia-smi + Windows GPU counters): concurrent requests share one query, and a
  // result is reused for usersMaxAgeMs unless our own PIDs changed (a run started or ended).
  let usersCache: { at: number; own: string; users: GpuUser[] } | undefined;
  let usersInflight: Promise<GpuUser[]> | undefined;
  const otherUsers = (): Promise<GpuUser[]> => {
    const ownPids = o.ownPids?.() ?? [];
    const own = ownPids.join(',');
    const c = usersCache;
    if (c && c.own === own && o.clock.now() - c.at < (o.usersMaxAgeMs ?? USERS_MAX_AGE_MS)) return Promise.resolve(c.users);
    usersInflight ??= o.telemetry.otherGpuUsers(ownPids).then(
      (users) => {
        usersCache = { at: o.clock.now(), own, users };
        usersInflight = undefined;
        return users;
      },
      (e: unknown) => {
        usersInflight = undefined;
        throw e;
      },
    );
    return usersInflight;
  };

  // The system page must render even when one source fails: each part degrades on its own.
  const soft = async <T>(what: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      o.log?.warn(`system: ${what} failed`, { error: String(e) });
      return fallback;
    }
  };

  async function nvidiaSmi(): Promise<SystemResponse['nvidiaSmi']> {
    if (o.telemetry.status) {
      const s = await o.telemetry.status();
      return s.path ? { found: s.found, path: s.path } : { found: s.found };
    }
    return { found: await o.telemetry.available() };
  }

  return {
    async system() {
      const [fp, liveGpus, users, docker, smi, settings] = await Promise.all([
        o.sysinfo.getFingerprint(),
        soft<GpuInfo[] | undefined>('probe', () => o.telemetry.probe(), undefined),
        soft<GpuUser[]>('otherGpuUsers', otherUsers, []),
        soft<DockerStatus>('docker', () => (o.dockerStatus ? o.dockerStatus() : Promise.resolve({ state: 'unknown' as const })), {
          state: 'unknown',
        }),
        soft<SystemResponse['nvidiaSmi']>('nvidia-smi status', nvidiaSmi, { found: false }),
        o.settings.get(),
      ]);
      return {
        // Fresh probe (current VRAM in use); the cached fingerprint list only when probing failed.
        gpus: liveGpus ?? fp.gpus,
        os: fp.os,
        cpu: fp.cpu,
        ramBytes: fp.ramBytes,
        hostLabel: fp.hostLabel,
        hostId: fp.hostId,
        nvidiaSmi: smi,
        otherGpuUsers: users,
        docker,
        paths: {
          dataDir: o.paths.dataDir,
          resultsDir: settings.resultsDir || o.paths.resultsDir,
          modelsDir: settings.modelsDir || o.paths.modelsDir,
          enginesDir: o.paths.enginesDir,
        },
      };
    },
    snapshot: () => live.read(),
  };
}
