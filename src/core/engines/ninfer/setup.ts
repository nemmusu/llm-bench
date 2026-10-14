/** NInfer's part of the composition root: both adapters, WSL's process records, builders, routes, its two builds, variants' updates. */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { customEngineKindOf, NINFER_ALL_DIR, NINFER_ALL_SOURCE, NINFER_ALL_TEMPLATE, ninferAllEngineOf, type CustomEngine, type GitSource } from '../../../contract/custom-engines';
import type { EngineConfig } from '../../../contract/engines';
import type { LocalModel } from '../../../contract/models';
import {
  NINFER_ALL_NAME,
  NINFER_DEFAULT_DIR,
  NINFER_SERVE_PATH,
  NINFER_SOURCE,
  ninferAllRequest,
  ninferKindFor,
  type NinferBuildId,
  type NinferBuildInfo,
  type NinferBuildPath,
  type NinferBuildPathResult,
  type NinferKind,
  type NinferRemovePlan,
  type NinferSettings,
} from '../../../contract/ninfer';
import { AppError } from '../../../contract/errors';
import type { ServerEvent } from '../../../contract/events';
import type { CoreDeps } from '../../deps';
import type { OwnershipRegistry } from '../../process/ownership';
import type { ClientFactory } from '../instance';
import { NinferAdapter, probeStale, serveOf, type GpuFacts, type NinferWhere } from './adapter';
import { NinferBuilder } from './build';
import { withBuild, withVariantBuild, type NinferRouteDeps } from './routes';
import { NinferUpdater } from './update';
import { deleteFolder, folderBytes, removeCommand, removeModeOf } from './remove';
import { distroRunner, hostArgv, listDistros, WslProcesses, type DistroRun } from './wsl';

export interface NinferServices {
  native: NinferAdapter;
  wsl: NinferAdapter;
  processes: WslProcesses;
  /** "Aggiorna" of each kind's saved build (core/engines/updates asks them for 'ninfer-native' / 'ninfer-wsl'). */
  updaters: Record<NinferKind, NinferUpdater>;
  /** "Aggiorna" of a NInfer variant (a custom engine of base 'ninfer', NInfer-all among them): its own checkout, the same way. */
  variantUpdater(engine: CustomEngine): NinferUpdater;
  /** NInfer-all for a model that needs it: its saved engine, else a working build in ~/ninfer-all (saved as it is found). */
  findAll(kind: NinferKind): Promise<CustomEngine | undefined>;
  /** Stops our ninfer-serve left in WSL by a crashed session (no record = WSL is not asked). */
  cleanupOrphans(): Promise<void>;
  routes(o: { publish: (e: ServerEvent) => void; shutdown?: AbortSignal; busy?: () => boolean }): NinferRouteDeps;
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

type SavedNinfer = Awaited<ReturnType<NinferServicesOptions['settings']['get']>>;

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

/** Where a NInfer variant's program is: its path (and distro). */
function whereOf(engine: CustomEngine): NinferWhere {
  const run = engine.run as Extract<CustomEngine['run'], { mode: 'ninfer' }>;
  return { ...serveOf(run.path), ...(run.distro ? { distro: run.distro } : {}) };
}

export function createNinferServices(o: NinferServicesOptions): NinferServices {
  const { deps } = o;
  const argv = deps.endpoints.wsl ?? ['wsl.exe'];
  const processes = new WslProcesses({ proc: deps.proc, wsl: argv, file: path.join(deps.paths.dataDir, 'ninfer-wsl.json'), sleep: (ms) => deps.clock.sleep(ms) });
  const common = { deps, createClient: o.createClient, saved: async () => (await o.settings.get()).ninfer, gpus: o.gpus };
  // Native, tests and E2E only: a fake Linux host runs every program (endpoints.ninferHost).
  const host = deps.endpoints.ninferHost ? { launcherPrefix: deps.endpoints.ninferHost } : {};
  const native = new NinferAdapter({ ...common, kind: 'ninfer-native', ...(o.ownership ? { ownership: o.ownership } : {}), ...host });
  const wsl = new NinferAdapter({ ...common, kind: 'ninfer-wsl', wsl: { argv, processes } });
  const repoBytes = (repo: string) => githubRepoBytes(deps.fetch, deps.endpoints.githubApi, repo);
  // A failed build's whole output is kept here (the error names the file).
  const logDir = path.join(deps.paths.dataDir, 'logs');
  const builders: Record<NinferKind, NinferBuilder> = {
    'ninfer-native': new NinferBuilder({ kind: 'ninfer-native', proc: deps.proc, newMarker: () => `gpubench-${randomUUID()}`, repoBytes, logDir, ...host }),
    'ninfer-wsl': new NinferBuilder({ kind: 'ninfer-wsl', proc: deps.proc, wsl: { argv, processes }, newMarker: () => `gpubench-${randomUUID()}`, repoBytes, logDir }),
  };
  const adapters: Record<NinferKind, NinferAdapter> = { 'ninfer-native': native, 'ninfer-wsl': wsl };
  // One compile of NInfer at a time: the guided build and the update share the checkout and the CPU.
  const jobs: NinferRouteDeps['jobs'] = { building: false };
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
    const where = whereOf(engine);
    const cfg = { kind, ninferPath: (engine.run as { path: string }).path, ...(where.distro ? { wslDistro: where.distro } : {}) };
    return new NinferUpdater({
      kind,
      target: `custom:${engine.id}`,
      builder: builders[kind],
      where: async () => where,
      models,
      verify: async () => {
        adapters[kind].forget();
        return (await adapters[kind].detect(cfg)).installed;
      },
      building: () => jobs.building,
      clock: deps.clock,
    });
  };

  /** One build as the card shows it: its state from a probe of its program (the probe says why it does not answer). */
  const infoOf = async (build: NinferBuildId, kind: NinferKind, where: NinferWhere | undefined, base: Pick<NinferBuildInfo, 'source' | 'dir' | 'distro' | 'customEngineId'>, fresh: boolean): Promise<NinferBuildInfo> => {
    if (!where) return { build, kind, state: 'missing', ...base };
    const adapter = adapters[kind];
    const cfg: EngineConfig = { kind, ninferPath: where.serve, ...(where.distro ? { wslDistro: where.distro } : {}) };
    const status = await adapter.detect(cfg, { fresh });
    // detect() just probed it (or used the probe it trusts): the same answer.
    const probe = await adapter.probe(where);
    const state = probe.ok ? (probeStale(probe) ? 'stale' : 'ready') : probe.commit ? 'not-built' : 'broken';
    return {
      build,
      kind,
      state,
      ...base,
      dir: where.repo ?? path.posix.dirname(where.serve),
      path: where.serve,
      ...(where.distro ? { distro: where.distro } : {}),
      ...(probe.commit ? { commit: probe.commit.slice(0, 7) } : {}),
      ...(probe.built ? { built: probe.built.slice(0, 7) } : {}),
      ...(probe.release ? { release: probe.release } : {}),
      status,
      ...(probe.kvDtypes ? { kvDtypes: probe.kvDtypes } : {}),
    };
  };

  /**
   * Where NInfer-all usually is before LLM Bench knows it (~/ninfer-all): on Linux this PC, on Windows the
   * official build's distro, else WSL's default one; undefined when WSL has none.
   */
  const usualAll = async (kind: NinferKind, saved: SavedNinfer): Promise<NinferWhere | undefined> => {
    const at = { serve: `${NINFER_ALL_DIR}/${NINFER_SERVE_PATH}`, repo: NINFER_ALL_DIR };
    if (kind === 'ninfer-native') return at;
    const distro = saved.ninfer?.wsl?.distro ?? (await listDistros(deps.proc, argv).then((l) => l.distros.find((d) => d.default)?.name, () => undefined));
    return distro ? { ...at, distro } : undefined;
  };

  /** A working build in NInfer-all's usual folder (built by hand, or before LLM Bench knew it), saved as NInfer-all: used from now on. */
  const adoptAll = async (at: string, distro: string | undefined): Promise<CustomEngine> => {
    const saved = await o.settings.get();
    const made = withVariantBuild(saved.customEngines ?? [], { template: NINFER_ALL_TEMPLATE, name: NINFER_ALL_NAME }, { path: at, ...(distro ? { distro } : {}) }, NINFER_ALL_SOURCE);
    await o.settings.update({ customEngines: made.engines });
    deps.log.info('NInfer-all found in its usual folder: saved as NInfer-all', { path: at, ...(distro ? { distro } : {}) });
    return made.engines.find((e) => e.id === made.id) as CustomEngine;
  };

  /**
   * NInfer-all before LLM Bench knows it: what its usual folder holds. A build there that answers is
   * saved as NInfer-all at once (nothing to build); a copy of its code without a working program (a build
   * that stopped, a clone made by hand) is "Da compilare", built in place; else "Non installato".
   */
  const unsavedAll = async (kind: NinferKind, base: Pick<NinferBuildInfo, 'source' | 'dir' | 'distro'>, fresh: boolean): Promise<NinferBuildInfo> => {
    const missing: NinferBuildInfo = { build: 'all', kind, state: 'missing', ...base };
    const where = await usualAll(kind, await o.settings.get());
    if (!where) return missing;
    const probe = await adapters[kind].probe(where, fresh);
    const inDistro = where.distro ? { distro: where.distro } : {};
    if (probe.ok && probe.at) {
      const engine = await adoptAll(probe.at, where.distro);
      return infoOf('all', kind, whereOf(engine), { ...base, ...inDistro, customEngineId: engine.id }, false);
    }
    if (!probe.at || !probe.commit) return missing;
    return { ...missing, ...inDistro, state: 'not-built', dir: probe.at.slice(0, -NINFER_SERVE_PATH.length - 1), commit: probe.commit.slice(0, 7) };
  };

  /** NInfer-all for a model that needs it: its saved engine, else a working build in its usual folder (saved as it is found). */
  const findAll = async (kind: NinferKind): Promise<CustomEngine | undefined> => {
    const saved = await o.settings.get();
    const existing = ninferAllEngineOf(saved.customEngines ?? [], kind);
    if (existing) return existing;
    const where = await usualAll(kind, saved);
    const probe = where ? await adapters[kind].probe(where) : undefined;
    return probe?.ok && probe.at ? adoptAll(probe.at, where?.distro) : undefined;
  };

  /** Both builds of this PC's NInfer kind, each with its state. */
  const listBuilds = async (fresh: boolean) => {
    const kind = ninferKindFor(deps.platform);
    if (!kind) return { builds: [] };
    const saved = await o.settings.get();
    const distro = kind === 'ninfer-wsl' ? saved.ninfer?.wsl?.distro : undefined;
    const official = await infoOf('official', kind, await adapters[kind].where(), { source: NINFER_SOURCE, dir: NINFER_DEFAULT_DIR, ...(distro ? { distro } : {}) }, fresh);
    const all = ninferAllEngineOf(saved.customEngines ?? [], kind);
    const allSource: GitSource = (all?.run as { source?: GitSource } | undefined)?.source ?? NINFER_ALL_SOURCE;
    const base = { source: allSource, dir: NINFER_ALL_DIR, ...(distro ? { distro } : {}) };
    const allBuild = all ? await infoOf('all', kind, whereOf(all), { ...base, customEngineId: all.id }, fresh) : await unsavedAll(kind, base, fresh);
    return { kind, builds: [official, allBuild] };
  };

  /** Runs a program where a build is: its distro (WSL) or this system (the fake Linux host in tests). */
  const runnerOf = (kind: NinferKind, distro: string | undefined): DistroRun =>
    kind === 'ninfer-wsl' ? distroRunner(deps.proc, argv, distro as string) : (cmd, args, opts) => deps.proc.run(...hostArgv(deps.endpoints.ninferHost ?? [], [cmd, ...args]), opts);

  /** A build that is there (not "missing"), else VALIDATION. */
  const installedBuild = async (build: NinferBuildId): Promise<NinferBuildInfo> => {
    const info = (await listBuilds(true)).builds.find((b) => b.build === build);
    if (!info || info.state === 'missing') throw new AppError('VALIDATION', 'This build of NInfer is not there', { params: { reason: 'not-installed', build } });
    return info;
  };

  const removePlan = async (build: NinferBuildId): Promise<NinferRemovePlan> => {
    const info = await installedBuild(build);
    const mode = removeModeOf(info);
    const base: NinferRemovePlan = { build, mode, dir: info.dir, ...(info.distro ? { distro: info.distro } : {}) };
    if (mode !== 'delete') return base;
    const size = await folderBytes(runnerOf(info.kind, info.distro), info.dir).catch(() => undefined);
    return { ...base, ...(size !== undefined ? { sizeBytes: size } : {}), command: removeCommand(info.dir, info.distro) };
  };

  /** Deleted (LLM Bench built it) or forgotten (the user's): either way LLM Bench no longer uses it. */
  const remove = async (build: NinferBuildId): Promise<void> => {
    const info = await installedBuild(build);
    const mode = removeModeOf(info);
    if (mode === 'manual') throw new AppError('VALIDATION', 'Built by hand in its usual folder: delete it by hand', { params: { reason: 'manual', dir: info.dir } });
    if (mode === 'delete') await deleteFolder(runnerOf(info.kind, info.distro), info.dir);
    const saved = await o.settings.get();
    if (build === 'official') {
      const ninfer: NinferSettings = { ...saved.ninfer };
      if (info.kind === 'ninfer-wsl') delete ninfer.wsl;
      else delete ninfer.native;
      await o.settings.update({ ninfer });
    } else {
      await o.settings.update({ customEngines: (saved.customEngines ?? []).filter((e) => e.id !== info.customEngineId) });
    }
    adapters[info.kind].forget();
    deps.log.info('NInfer build removed', { build, mode, dir: info.dir });
  };

  /** NInfer-all's saved engine on this PC's kind, if any. */
  const savedAll = async (kind: NinferKind): Promise<CustomEngine | undefined> => ninferAllEngineOf((await o.settings.get()).customEngines ?? [], kind);

  return {
    native,
    wsl,
    processes,
    updaters: { 'ninfer-native': updaterOf('ninfer-native'), 'ninfer-wsl': updaterOf('ninfer-wsl') },
    variantUpdater,
    findAll,
    cleanupOrphans: async () => {
      if (deps.platform !== 'win32') return;
      const stopped = await processes.cleanupOrphans();
      if (stopped.length) deps.log.info('stopped NInfer servers left in WSL by a previous session', { pids: stopped.map((r) => r.pid) });
    },
    routes: (r) => ({
      distros: async () => (deps.platform === 'win32' ? listDistros(deps.proc, argv) : { wsl: false, distros: [] }),
      check: (kind, cfg) => adapters[kind].check(cfg),
      builder: (kind) => builders[kind],
      normalize: async (req) => {
        if (req.build !== 'all') return req;
        const existing = await savedAll(req.kind);
        // Built again where it is (its checkout), unless another folder was asked for.
        const dir = req.dir ?? (existing ? whereOf(existing).repo : undefined);
        return ninferAllRequest({ ...req, ...(dir ? { dir } : {}) }, existing);
      },
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
      builds: listBuilds,
      removePlan,
      remove,
      ...(r.busy ? { busy: r.busy } : {}),
      setBuildPath: async (build, body: NinferBuildPath): Promise<NinferBuildPathResult> => {
        const kind = ninferKindFor(deps.platform) as NinferKind;
        const saved = await o.settings.get();
        const distro = kind === 'ninfer-wsl' ? (body.distro ?? saved.ninfer?.wsl?.distro) : undefined;
        const status = await adapters[kind].check({ kind, ninferPath: body.path, ...(distro ? { wslDistro: distro } : {}) });
        if (!status.installed) return { saved: false, status };
        const where = { path: body.path, ...(distro ? { distro } : {}) };
        if (build === 'official') await o.settings.update({ ninfer: withBuild(saved.ninfer, kind, where) });
        else {
          const existing = ninferAllEngineOf(saved.customEngines ?? [], kind);
          const variant = { template: 'ninfer-all', name: existing?.name ?? NINFER_ALL_NAME, ...(existing ? { id: existing.id } : {}) };
          const source = (existing?.run as { source?: GitSource } | undefined)?.source ?? NINFER_ALL_SOURCE;
          await o.settings.update({ customEngines: withVariantBuild(saved.customEngines ?? [], variant, where, source).engines });
        }
        adapters[kind].forget();
        return { saved: true, status };
      },
      jobs,
      publish: r.publish,
      ...(r.shutdown ? { shutdown: r.shutdown } : {}),
    }),
  };
}
