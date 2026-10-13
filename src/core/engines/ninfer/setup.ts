/** NInfer's part of the composition root: both adapters, WSL's process records, builders, routes. */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { LocalModel } from '../../../contract/models';
import type { NinferKind, NinferSettings } from '../../../contract/ninfer';
import type { ServerEvent } from '../../../contract/events';
import type { CoreDeps } from '../../deps';
import type { OwnershipRegistry } from '../../process/ownership';
import type { ClientFactory } from '../instance';
import { NinferAdapter, type GpuFacts } from './adapter';
import { NinferBuilder } from './build';
import { withBuild, type NinferRouteDeps } from './routes';
import { NinferUpdater } from './update';
import { listDistros, WslProcesses } from './wsl';

export interface NinferServices {
  native: NinferAdapter;
  wsl: NinferAdapter;
  processes: WslProcesses;
  /** "Aggiorna" of each kind's saved build (core/engines/updates asks them for 'ninfer-native' / 'ninfer-wsl'). */
  updaters: Record<NinferKind, NinferUpdater>;
  /** Stops our ninfer-serve left in WSL by a crashed session (no record = WSL is not asked). */
  cleanupOrphans(): Promise<void>;
  routes(o: { publish: (e: ServerEvent) => void; shutdown?: AbortSignal }): NinferRouteDeps;
}

export interface NinferServicesOptions {
  deps: Pick<CoreDeps, 'clock' | 'proc' | 'fetch' | 'platform' | 'log' | 'paths' | 'endpoints'>;
  createClient: ClientFactory;
  ownership?: Pick<OwnershipRegistry, 'add' | 'remove'>;
  settings: { get(): Promise<{ ninfer?: NinferSettings | undefined }>; update(patch: { ninfer: NinferSettings }): Promise<unknown> };
  gpus: () => Promise<GpuFacts[]>;
  /** The library (the artifacts an updated build would no longer read). */
  models?: () => Promise<LocalModel[]>;
}

export function createNinferServices(o: NinferServicesOptions): NinferServices {
  const { deps } = o;
  const argv = deps.endpoints.wsl ?? ['wsl.exe'];
  const processes = new WslProcesses({ proc: deps.proc, wsl: argv, file: path.join(deps.paths.dataDir, 'ninfer-wsl.json'), sleep: (ms) => deps.clock.sleep(ms) });
  const common = { deps, createClient: o.createClient, saved: async () => (await o.settings.get()).ninfer, gpus: o.gpus };
  const native = new NinferAdapter({ ...common, kind: 'ninfer-native', ...(o.ownership ? { ownership: o.ownership } : {}) });
  const wsl = new NinferAdapter({ ...common, kind: 'ninfer-wsl', wsl: { argv, processes } });
  const builders: Record<NinferKind, NinferBuilder> = {
    'ninfer-native': new NinferBuilder({ kind: 'ninfer-native', proc: deps.proc, newMarker: () => `gpubench-${randomUUID()}` }),
    'ninfer-wsl': new NinferBuilder({ kind: 'ninfer-wsl', proc: deps.proc, wsl: { argv, processes }, newMarker: () => `gpubench-${randomUUID()}` }),
  };
  const adapters: Record<NinferKind, NinferAdapter> = { 'ninfer-native': native, 'ninfer-wsl': wsl };
  // One compile of NInfer at a time: the guided build and the update share the checkout and the CPU.
  const jobs = { building: false };
  const updaterOf = (kind: NinferKind) =>
    new NinferUpdater({
      kind,
      builder: builders[kind],
      where: () => adapters[kind].where(),
      models: async () => (o.models ? o.models() : []),
      // The rebuilt program answers its help (the cached probe of the old one is dropped first).
      verify: async () => {
        adapters[kind].forget();
        return (await adapters[kind].detect()).installed;
      },
      building: () => jobs.building,
      clock: deps.clock,
    });
  return {
    native,
    wsl,
    processes,
    updaters: { 'ninfer-native': updaterOf('ninfer-native'), 'ninfer-wsl': updaterOf('ninfer-wsl') },
    cleanupOrphans: async () => {
      if (deps.platform !== 'win32') return;
      const stopped = await processes.cleanupOrphans();
      if (stopped.length) deps.log.info('stopped NInfer servers left in WSL by a previous session', { pids: stopped.map((r) => r.pid) });
    },
    routes: (r) => ({
      distros: async () => (deps.platform === 'win32' ? listDistros(deps.proc, argv) : { wsl: false, distros: [] }),
      check: (kind, cfg) => adapters[kind].check(cfg),
      builder: (kind) => builders[kind],
      saveBuild: async (kind, where) => {
        await o.settings.update({ ninfer: withBuild((await o.settings.get()).ninfer, kind, where) });
      },
      jobs,
      publish: r.publish,
      ...(r.shutdown ? { shutdown: r.shutdown } : {}),
    }),
  };
}
