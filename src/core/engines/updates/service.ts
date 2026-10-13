/**
 * The "Aggiorna" of an engine card (contract/engine-updates.ts): the check (a newer image tag or
 * digest on Docker Hub, a newer PyPI release, new commits upstream of a fork's checkout) and the
 * update (docker pull, uv pip install, git pull + cmake --build) with its progress.
 */
import { customEngineKindOf, type CustomEngine } from '../../../contract/custom-engines';
import { UPDATABLE_KINDS, type EngineUpdateCheck, type UpdatableKind } from '../../../contract/engine-updates';
import type { EngineConfig, EngineKind, EngineStatus } from '../../../contract/engines';
import { AppError } from '../../../contract/errors';
import type { Settings } from '../../../contract/settings';
import type { Clock } from '../../deps';
import type { HubTag } from '../../docker/hub';
import { digestFor, displayRepo, isDockerHub, parseImageRef } from '../../docker/image-ref';
import { CustomEngineAdapter, expandCustom } from '../custom/adapter';
import type { EngineRegistry } from '../registry';
import type { EngineAdapter, InstallPlan, ProgressSink } from '../types';
import { findCheckout, gitState, gitUpdate, updateCommands, type GitTools } from './git';
import { compareVersions, newerTag, packageOf, parseVersion, pypiLatest, type PypiRelease } from './versions';

/** A tag as the update check reads it (Docker Hub, or an engine's own list with its GPU advice). */
export type UpdateTag = Pick<HubTag, 'name' | 'sizeBytes' | 'digest'> & { supportsGpu?: boolean };

export interface UpdateProgress {
  stage: string;
  bytesDone: number;
  bytesTotal?: number;
  step?: number;
  steps?: number;
}

export interface EngineUpdatesDeps {
  /** The engines (custom engines wrapped: their base adapter does the work). */
  registry: EngineRegistry;
  settings: { get(): Promise<Pick<Settings, 'lastEngine' | 'customEngines'>>; update(patch: Partial<Settings>): Promise<unknown> };
  images: { inspect(ref: string): Promise<{ repoDigests: string[] } | undefined> };
  hub: { listTags(repo: string, nameFilter?: string, opts?: { refresh?: boolean }): Promise<HubTag[]>; tagInfo(ref: string): Promise<HubTag | undefined> };
  /** Release tags of the built-in Docker engines (vLLM's say which ones run on this GPU). */
  tags: Record<'vllm-docker' | 'sglang-docker', { tags(opts: { refresh?: boolean }): Promise<UpdateTag[]> }>;
  /** `uv pip install` requirement of the managed environments (default "vllm", "sglang"). */
  packages?: Partial<Record<'vllm-native' | 'sglang-native', string>>;
  tools: GitTools;
  fetch: typeof globalThis.fetch;
  /** PyPI base URL. */
  pypi: string;
  clock: Clock;
  /** PyPI answers are kept this long (default 10 min). */
  ttlMs?: number;
  /** NInfer's own update of its git checkout, on Linux or inside WSL (core/engines/ninfer/update.ts). */
  ninfer?: Record<'ninfer-native' | 'ninfer-wsl', NinferPlanner>;
  /** The same for a NInfer variant (a custom engine of base 'ninfer'): its own checkout. */
  ninferVariant?: (engine: CustomEngine) => NinferPlanner;
}

type NinferPlanner = { plan(opts: { fetch?: boolean }): Promise<{ check: EngineUpdateCheck; run?: Run }> };

type Target = { kind: 'builtin'; engine: UpdatableKind } | { kind: 'custom'; id: string };

function parseTarget(target: string): Target {
  if (target.startsWith('custom:') && target.length > 'custom:'.length) return { kind: 'custom', id: target.slice('custom:'.length) };
  if ((UPDATABLE_KINDS as readonly string[]).includes(target)) return { kind: 'builtin', engine: target as UpdatableKind };
  throw new AppError('VALIDATION', `No update for ${target}`, { params: { reason: 'update_target', target } });
}

/** The base adapter of a kind (registry entries are wrapped for custom engines). */
function baseOf(registry: EngineRegistry, kind: EngineKind): EngineAdapter {
  const a = registry.require(kind);
  return a instanceof CustomEngineAdapter ? a.inner : a;
}

type Installer = EngineAdapter & Required<Pick<EngineAdapter, 'installPlan' | 'install'>>;

/** An update ready to run: resolves with the version it installed. */
export type Run = (progress: (p: UpdateProgress) => void, signal: AbortSignal) => Promise<string>;

function installer(a: EngineAdapter): Installer {
  if (!a.installPlan || !a.install) throw new AppError('VALIDATION', `${a.kind} cannot be installed from the app`, { params: { reason: 'update_target' } });
  return a as Installer;
}

const DOCKER_PROBLEMS = new Set(['DOCKER_NOT_INSTALLED', 'DOCKER_NOT_RUNNING', 'DOCKER_PERMISSION', 'DOCKER_UNSUPPORTED']);

export class EngineUpdates {
  private readonly pypiCache = new Map<string, { at: number; value: Promise<PypiRelease> }>();

  constructor(private readonly d: EngineUpdatesDeps) {}

  /** The name an update's progress is shown with. */
  async labelOf(target: string): Promise<string> {
    const t = parseTarget(target);
    if (t.kind === 'custom') return (await this.custom(t.id)).name;
    return { 'vllm-docker': 'vLLM (Docker)', 'sglang-docker': 'SGLang (Docker)', 'vllm-native': 'vLLM', 'sglang-native': 'SGLang', 'ninfer-native': 'NInfer', 'ninfer-wsl': 'NInfer (WSL)' }[t.engine];
  }

  async check(target: string, opts: { fetch?: boolean } = {}): Promise<EngineUpdateCheck> {
    return (await this.plan(target, opts)).check;
  }

  /** Runs the update the check offers; resolves with the version installed. */
  async update(target: string, progress: (p: UpdateProgress) => void, signal: AbortSignal): Promise<{ version?: string }> {
    const { check, run } = await this.plan(target, {});
    if (!run) throw new AppError('ENGINE_UPDATE_FAILED', `Nothing to update for ${target}`, { params: { reason: check.reason ?? check.state } });
    return { version: await run(progress, signal) };
  }

  private async custom(id: string): Promise<CustomEngine> {
    const engine = (await this.d.settings.get()).customEngines.find((e) => e.id === id);
    if (!engine) throw new AppError('ENGINE_NOT_INSTALLED', `Custom engine not found: ${id}`, { params: { reason: 'custom_engine_missing', id } });
    return engine;
  }

  private now(): string {
    return new Date(this.d.clock.wall()).toISOString();
  }

  private base(target: string, method: EngineUpdateCheck['method']): Pick<EngineUpdateCheck, 'target' | 'method' | 'commands' | 'checkedAt'> {
    return { target, method, commands: [], checkedAt: this.now() };
  }

  private async plan(target: string, opts: { fetch?: boolean }): Promise<{ check: EngineUpdateCheck; run?: Run }> {
    const t = parseTarget(target);
    if (t.kind === 'builtin') {
      if (t.engine === 'ninfer-native' || t.engine === 'ninfer-wsl') {
        const ninfer = this.d.ninfer?.[t.engine];
        return ninfer ? ninfer.plan(opts) : { check: { ...this.base(target, 'none'), state: 'none', reason: 'tools' } };
      }
      if (t.engine === 'vllm-docker' || t.engine === 'sglang-docker') {
        const last = (await this.d.settings.get()).lastEngine;
        const kind = t.engine;
        const cfg: EngineConfig = last?.kind === kind && last.customEngineId === undefined ? last : { kind };
        return this.docker(target, installer(baseOf(this.d.registry, kind)), cfg, opts, (o) => this.d.tags[kind].tags(o), async (image) => {
          await this.d.settings.update({ lastEngine: { kind, image } });
        });
      }
      return this.uv(target, t.engine, opts);
    }
    const engine = await this.custom(t.id);
    const kind = customEngineKindOf(engine);
    // A NInfer variant: git pull + rebuild in its checkout, as NInfer's own (its previous build kept aside).
    if (engine.run.mode === 'ninfer') return this.d.ninferVariant ? this.d.ninferVariant(engine).plan(opts) : { check: { ...this.base(target, 'none'), state: 'none', reason: 'tools' } };
    if (engine.run.mode === 'docker') {
      return this.docker(target, installer(baseOf(this.d.registry, kind)), expandCustom(engine, { kind }), opts, undefined, async (image) => {
        const list = (await this.d.settings.get()).customEngines;
        await this.d.settings.update({ customEngines: list.map((e) => (e.id === engine.id && e.run.mode === 'docker' ? { ...e, run: { ...e.run, image } } : e)) });
      });
    }
    if (engine.run.mode === 'native' && engine.base === 'llamacpp') return this.git(target, engine, opts);
    return { check: { ...this.base(target, 'none'), state: 'none', reason: 'tools' } };
  }

  /** A Docker image: a newer release tag of the same kind, else the same tag with a newer digest. */
  private async docker(
    target: string,
    adapter: Installer,
    cfg: EngineConfig,
    opts: { fetch?: boolean },
    ownTags: ((o: { refresh?: boolean }) => Promise<UpdateTag[]>) | undefined,
    switchTo: (image: string) => Promise<void>,
  ): Promise<{ check: EngineUpdateCheck; run?: Run }> {
    const status: EngineStatus = await adapter.detect(cfg);
    const blocked = (reason: EngineUpdateCheck['reason']) => ({ check: { ...this.base(target, 'docker-pull'), state: 'blocked' as const, reason } });
    if (status.problems.some((p) => DOCKER_PROBLEMS.has(p))) return blocked('no-docker');
    if (!status.installed || status.location === undefined) return blocked('not-installed');
    const image = status.location;
    const ref = parseImageRef(image);
    if (ref.digest !== undefined) return { check: { ...this.base(target, 'none'), state: 'none', reason: 'pinned', current: image } };
    const tag = ref.tag ?? 'latest';
    const hub = isDockerHub(ref);
    const tags: UpdateTag[] = ownTags ? await ownTags({ refresh: opts.fetch === true }) : hub ? await this.d.hub.listTags(ref.repository, '', { refresh: opts.fetch === true }) : [];
    const pull =
      (next: string, version: string): Run =>
      async (progress, signal) => {
        const plan: InstallPlan = await adapter.installPlan({ ...cfg, image: next });
        const sink: ProgressSink = (p) => progress({ stage: p.stage === 'done' ? 'verify' : p.stage, bytesDone: p.bytesDone, ...(p.bytesTotal !== undefined ? { bytesTotal: p.bytesTotal } : {}) });
        await adapter.install(plan, sink, signal);
        if (next !== image) await switchTo(next);
        return version;
      };
    const newer = newerTag(tag, tags.filter((x) => x.supportsGpu !== false));
    if (newer) {
      const next = `${displayRepo(ref)}:${newer.name}`;
      return {
        check: { ...this.base(target, 'docker-tag'), state: 'available', current: tag, latest: newer.name, image: next, commands: [['docker', 'pull', next]], ...(newer.sizeBytes !== undefined ? { sizeBytes: newer.sizeBytes } : {}) },
        run: pull(next, newer.name),
      };
    }
    const again = { ...this.base(target, 'docker-pull'), current: tag, latest: tag, image, commands: [['docker', 'pull', image]] };
    // Another registry: no tag list to read without signing in. It can always be pulled again.
    if (!hub) return { check: { ...again, state: 'unknown' }, run: pull(image, tag) };
    const remote = tags.find((x) => x.name === tag) ?? (await this.d.hub.tagInfo(image));
    const local = digestFor(image, (await this.d.images.inspect(image))?.repoDigests ?? []);
    if (remote?.digest !== undefined && local !== undefined && remote.digest !== local) {
      return { check: { ...again, state: 'available', ...(remote.sizeBytes !== undefined ? { sizeBytes: remote.sizeBytes } : {}) }, run: pull(image, tag) };
    }
    return { check: { ...this.base(target, 'docker-pull'), state: 'current', current: tag } };
  }

  private pypiRelease(name: string, refresh: boolean): Promise<PypiRelease> {
    const hit = this.pypiCache.get(name);
    if (!refresh && hit && this.d.clock.now() - hit.at < (this.d.ttlMs ?? 600_000)) return hit.value;
    const value = pypiLatest(this.d.fetch, this.d.pypi, name);
    this.pypiCache.set(name, { at: this.d.clock.now(), value });
    value.catch(() => this.pypiCache.delete(name));
    return value;
  }

  /** The managed uv environment of vLLM or SGLang (Linux), against PyPI's newest release. */
  private async uv(target: string, kind: 'vllm-native' | 'sglang-native', opts: { fetch?: boolean }): Promise<{ check: EngineUpdateCheck; run?: Run }> {
    const base = this.base(target, 'uv');
    const adapter = installer(baseOf(this.d.registry, kind));
    const last = (await this.d.settings.get()).lastEngine;
    const own = last?.kind === kind && last.customEngineId === undefined && (kind === 'vllm-native' ? last.vllmPath : last.sglangPath);
    if (own) return { check: { ...this.base(target, 'none'), state: 'none', reason: 'own-environment' } };
    const status = await adapter.detect({ kind });
    if (status.supported === false) return { check: { ...this.base(target, 'none'), state: 'none', reason: 'tools' } };
    if (!status.installed || status.version === undefined) return { check: { ...base, state: 'blocked', reason: 'not-installed' } };
    const spec = this.d.packages?.[kind] ?? (kind === 'vllm-native' ? 'vllm' : 'sglang');
    const pkg = packageOf(spec);
    const release = await this.pypiRelease(pkg.name, opts.fetch === true);
    const have = parseVersion(status.version);
    const next = parseVersion(release.version);
    if (!have || !next || compareVersions(next, have) <= 0) return { check: { ...base, state: 'current', current: status.version } };
    const pinned = `${pkg.name}${pkg.extras}==${release.version}`;
    return {
      check: {
        ...base,
        state: 'available',
        current: status.version,
        latest: release.version,
        commands: [['uv', 'pip', 'install', pinned, '--torch-backend', 'auto']],
        ...(release.sizeBytes !== undefined ? { sizeBytes: release.sizeBytes } : {}),
      },
      run: async (progress, signal) => {
        const plan = await adapter.installPlan({ kind });
        await adapter.install({ ...plan, data: { ...plan.data, spec: pinned } }, (p) => progress(p.stage === 'done' ? { ...p, stage: 'verify' } : p), signal);
        return release.version;
      },
    };
  }

  /** A llama.cpp fork built from a git checkout: new commits upstream, then pull + build. */
  private async git(target: string, engine: CustomEngine, opts: { fetch?: boolean }): Promise<{ check: EngineUpdateCheck; run?: Run }> {
    const run = engine.run as Extract<CustomEngine['run'], { mode: 'native' }>;
    const checkout = await findCheckout(run.path);
    if (!checkout) return { check: { ...this.base(target, 'none'), state: 'none', reason: 'tools' } };
    const base = { ...this.base(target, 'git'), repo: checkout.repo, buildDir: checkout.buildDir, commands: updateCommands(checkout) };
    const state = await gitState(this.d.tools, checkout.repo, opts);
    if (state.kind === 'missing') return { check: { ...base, state: 'blocked', reason: 'git-missing' } };
    if (state.kind === 'detached') return { check: { ...base, state: 'blocked', reason: 'detached', current: state.head } };
    if (state.kind === 'no-upstream') return { check: { ...base, state: 'blocked', reason: 'no-upstream', current: state.head, branch: state.branch } };
    const at = { ...base, branch: state.branch, current: state.head, latest: state.upstreamHead };
    if (state.fetchError !== undefined) return { check: { ...at, state: 'blocked', reason: 'fetch-failed', detail: state.fetchError } };
    if (state.changed > 0) return { check: { ...at, state: 'blocked', reason: 'dirty', changed: state.changed, commits: state.behind } };
    if (state.behind === 0) return { check: { ...at, state: 'current' } };
    if (state.ahead > 0) return { check: { ...at, state: 'blocked', reason: 'diverged', commits: state.behind } };
    const [cmake, ...cmakeArgs] = this.d.tools.cmake as [string, ...string[]];
    const hasCmake = (await this.d.tools.proc.run(cmake, [...cmakeArgs, '--version'], { timeoutMs: 15_000 })).code === 0;
    if (!hasCmake) return { check: { ...at, state: 'blocked', reason: 'cmake-missing', commits: state.behind } };
    return {
      check: { ...at, state: 'available', commits: state.behind },
      run: async (progress, signal) => {
        await gitUpdate(this.d.tools, checkout, (p) => progress({ bytesDone: 0, ...p }), signal);
        progress({ stage: 'verify', bytesDone: 0 });
        // The new build must start: its --version through the engine's own check.
        const status = await baseOf(this.d.registry, 'llamacpp-native').detect(expandCustom(engine, { kind: 'llamacpp-native' }));
        if (!status.available) {
          throw new AppError('ENGINE_UPDATE_FAILED', `The rebuilt engine does not start: ${status.problems.join(', ')}`, { params: { reason: 'verify' } });
        }
        return state.upstreamHead;
      },
    };
  }
}
