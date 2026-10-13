/** NInfer's part of the composition root: both adapters, WSL's process records, builders, routes, variants' updates. */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { customEngineKindOf, type CustomEngine } from '../../../contract/custom-engines';
import type { LocalModel } from '../../../contract/models';
import type { NinferKind, NinferSettings } from '../../../contract/ninfer';
import type { ServerEvent } from '../../../contract/events';
import type { CoreDeps } from '../../deps';
import type { OwnershipRegistry } from '../../process/ownership';
import type { ClientFactory } from '../instance';
import { NinferAdapter, serveOf, type GpuFacts } from './adapter';
import { NinferBuilder } from './build';
import { withBuild, withVariantBuild, type NinferRouteDeps } from './routes';
import { NinferUpdater } from './update';
import { listDistros, WslProcesses } from './wsl';

export interface NinferServices {
  native: NinferAdapter;
  wsl: NinferAdapter;
  processes: WslProcesses;
  /** "Aggiorna" of each kind's saved build (core/engines/updates asks them for 'ninfer-native' / 'ninfer-wsl'). */
  updaters: Record<NinferKind, NinferUpdater>;
  /** "Aggiorna" of a NInfer variant (a custom engine of base 'ninfer'): its own checkout, the same way. */
  variantUpdater(engine: CustomEngine): NinferUpdater;
  /** Stops our ninfer-serve left in WSL by a crashed session (no record = WSL is not asked). */
  cleanupOrphans(): Promise<void>;
  routes(o: { publish: (e: ServerEvent) => void; shutdown?: AbortSignal }): NinferRouteDeps;
}

export interface NinferServicesOptions {
  deps: Pick<CoreDeps, 'clock' | 'proc' | 'fetch' | 'platform' | 'log' | 'paths' | 'endpoints'>;
  createClient: ClientFactory;
  ownership?: Pick<OwnershipRegistry, 'add' | 'remove'>;
  settings: {
    get(): Promise<{ ninfer?: NinferSettings | undefined; customEngines?: readonly CustomEngine[] | undefined }>;
    update(patch: { ninfer?: NinferSettings; customEngines?: CustomEngine[] }): Promise<unknown>;
  };
  gpus: () => Promise<GpuFacts[]>;
  /** The library (the artifacts an updated build would no longer read). */
  models?: () => Promise<LocalModel[]>;
}

/** What cloning a GitHub repository downloads: its size as the GitHub API says (KiB), undefined when it does not answer. */
export async function githubRepoBytes(fetch: typeof globalThis.fetch, api: string, repo: string): Promise<number | undefined> {
  try {
    const res = await fetch(`${api.replace(/\/+$/, '')}/repos/${repo}`, { headers: { accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(8000) });
    const size = res.ok ? ((await res.json()) as { size?: unknown }).size : undefined;
    return typeof size === 'number' && size > 0 ? size * 1024 : undefined;
  } catch {
    return undefined;
  }
}

export function createNinferServices(o: NinferServicesOptions): NinferServices {
  const { deps } = o;
  const argv = deps.endpoints.wsl ?? ['wsl.exe'];
  const processes = new WslProcesses({ proc: deps.proc, wsl: argv, file: path.join(deps.paths.dataDir, 'ninfer-wsl.json'), sleep: (ms) => deps.clock.sleep(ms) });
  const common = { deps, createClient: o.createClient, saved: async () => (await o.settings.get()).ninfer, gpus: o.gpus };
  const native = new NinferAdapter({ ...common, kind: 'ninfer-native', ...(o.ownership ? { ownership: o.ownership } : {}) });
  const wsl = new NinferAdapter({ ...common, kind: 'ninfer-wsl', wsl: { argv, processes } });
  const repoBytes = (repo: string) => githubRepoBytes(deps.fetch, deps.endpoints.githubApi, repo);
  const builders: Record<NinferKind, NinferBuilder> = {
    'ninfer-native': new NinferBuilder({ kind: 'ninfer-native', proc: deps.proc, newMarker: () => `gpubench-${randomUUID()}`, repoBytes }),
    'ninfer-wsl': new NinferBuilder({ kind: 'ninfer-wsl', proc: deps.proc, wsl: { argv, processes }, newMarker: () => `gpubench-${randomUUID()}`, repoBytes }),
  };
  const adapters: Record<NinferKind, NinferAdapter> = { 'ninfer-native': native, 'ninfer-wsl': wsl };
  // One compile of NInfer at a time: the guided build and the update share the checkout and the CPU.
  const jobs = { building: false };
  const models = async () => (o.models ? o.models() : []);
  const updaterOf = (kind: NinferKind) =>
    new NinferUpdater({
      kind,
      builder: builders[kind],
      where: () => adapters[kind].where(),
      models,
      // The rebuilt program answers its help (the cached probe of the old one is dropped first).
      verify: async () => {
        adapters[kind].forget();
        return (await adapters[kind].detect()).installed;
      },
      building: () => jobs.building,
      clock: deps.clock,
    });
  const variantUpdater = (engine: CustomEngine): NinferUpdater => {
    const kind = customEngineKindOf(engine) as NinferKind;
    const run = engine.run as Extract<CustomEngine['run'], { mode: 'ninfer' }>;
    const cfg = { kind, ninferPath: run.path, ...(run.distro ? { wslDistro: run.distro } : {}) };
    return new NinferUpdater({
      kind,
      target: `custom:${engine.id}`,
      builder: builders[kind],
      where: async () => ({ ...serveOf(run.path), ...(run.distro ? { distro: run.distro } : {}) }),
      models,
      verify: async () => {
        adapters[kind].forget();
        return (await adapters[kind].detect(cfg)).installed;
      },
      building: () => jobs.building,
      clock: deps.clock,
    });
  };
  return {
    native,
    wsl,
    processes,
    updaters: { 'ninfer-native': updaterOf('ninfer-native'), 'ninfer-wsl': updaterOf('ninfer-wsl') },
    variantUpdater,
    cleanupOrphans: async () => {
      if (deps.platform !== 'win32') return;
      const stopped = await processes.cleanupOrphans();
      if (stopped.length) deps.log.info('stopped NInfer servers left in WSL by a previous session', { pids: stopped.map((r) => r.pid) });
    },
    routes: (r) => ({
      distros: async () => (deps.platform === 'win32' ? listDistros(deps.proc, argv) : { wsl: false, distros: [] }),
      check: (kind, cfg) => adapters[kind].check(cfg),
      builder: (kind) => builders[kind],
      saveBuild: async (kind, where, req) => {
        // The new program answers from now on: no cached probe of the folder before it was built.
        adapters[kind].forget();
        const saved = await o.settings.get();
        if (!req.variant) {
          await o.settings.update({ ninfer: withBuild(saved.ninfer, kind, where) });
          return undefined;
        }
        const made = withVariantBuild(saved.customEngines ?? [], req.variant, where, req.source);
        await o.settings.update({ customEngines: made.engines });
        return made.id;
      },
      jobs,
      publish: r.publish,
      ...(r.shutdown ? { shutdown: r.shutdown } : {}),
    }),
  };
}
