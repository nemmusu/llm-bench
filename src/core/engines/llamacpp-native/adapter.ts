import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { InstallEngineRequest, LlamaRelease } from '../../../contract/api';
import type { EngineConfig, EngineStatus, LaunchParams } from '../../../contract/engines';
import { AppError, toAppErrorData } from '../../../contract/errors';
import { missingLibrary } from '../../process/missing-library';
import type { EngineIdentity } from '../../../contract/results';
import type { CoreDeps, ManagedProcess } from '../../deps';
import type { OwnershipRegistry } from '../../process/ownership';
import { LOOPBACK } from '../../process/ports';
import { createProcessInstance, type ClientFactory } from '../instance';
import {
  weightFiles,
  type CoreEngineConfig,
  type EngineAdapter,
  type EngineInstance,
  type InstallPlan,
  type LaunchPlan,
  type ModelTarget,
  type PendingPart,
  type PlanOptions,
  type ProgressSink,
} from '../types';
import { DEFAULT_CONTEXT, llamaArgs } from './args';
import { CapsProbe, currentLlamaCaps, guessVariant, type LlamaCaps } from './caps';
import {
  buildEnv,
  installLlamaBuild,
  listInstalled,
  llamaRoot,
  removeBuild,
  serverExeName,
  type InstallDeps,
  type InstalledBuild,
} from './install';
import { diagnoseExit, llamaPhaseOf } from './logs';
import { LlamaReleasesClient, selectAssets, type AssetSelection } from './releases';
import { FlagGate, trustedFlags } from '../shared/standard-flags';
import { ignore, timeoutSignal } from '../util';

export { DEFAULT_CONTEXT };

export type LlamaDeps = Pick<CoreDeps, 'clock' | 'proc' | 'fetch' | 'platform' | 'arch' | 'paths' | 'endpoints' | 'env' | 'log' | 'appVersion'>;

export interface LlamaNativeOptions {
  deps: LlamaDeps;
  ownership: OwnershipRegistry;
  createClient: ClientFactory;
  /** Highest CUDA version supported by the driver (nvidia-smi header), used to pick the release asset. */
  cudaVersion?: () => Promise<string | undefined>;
  /**
   * Argv placed before the executable. Tests run the fake engine as `[process.execPath]` +
   * `cli.mjs`; production leaves it empty.
   */
  launcherPrefix?: string[];
  readyTimeoutMs?: number;
  pollMs?: number;
  caps?: CapsProbe;
  releases?: LlamaReleasesClient;
  install?: Partial<InstallDeps>;
}

/** The binary that will run, and where it came from. */
export interface ResolvedExecutable {
  path: string;
  variant: string;
  managed?: InstalledBuild;
  /** Plan preview only: the managed build an install will create (not on disk yet), with its tag when known. */
  planned?: { tag?: string };
}

const installDataSchema = z.object({
  tag: z.string(),
  selection: z.object({
    main: z.object({ name: z.string(), url: z.string(), size: z.number(), digest: z.string().optional() }),
    cudart: z.object({ name: z.string(), url: z.string(), size: z.number(), digest: z.string().optional() }).optional(),
    backend: z.enum(['cuda', 'vulkan', 'cpu']),
    cudaVersion: z.string().optional(),
    variant: z.string(),
  }),
});

/**
 * llama.cpp `llama-server` run as a native child process: either a managed build installed
 * from the GitHub releases into enginesDir/llamacpp, or a custom executable chosen by the user.
 */
export class LlamaNativeAdapter implements EngineAdapter {
  readonly kind = 'llamacpp-native' as const;
  readonly caps: CapsProbe;
  private readonly releasesClient: LlamaReleasesClient;
  private readonly prefix: string[];

  constructor(private readonly o: LlamaNativeOptions) {
    this.caps = o.caps ?? new CapsProbe(o.deps.proc);
    this.releasesClient =
      o.releases ??
      new LlamaReleasesClient({
        fetch: o.deps.fetch,
        githubApi: o.deps.endpoints.githubApi,
        cacheDir: o.deps.paths.cacheDir,
        appVersion: o.deps.appVersion,
      });
    this.prefix = o.launcherPrefix ?? [];
  }

  async detect(cfg?: CoreEngineConfig): Promise<EngineStatus> {
    let exe: ResolvedExecutable;
    try {
      exe = await this.resolveExecutable(cfg ?? { kind: this.kind });
    } catch (e) {
      return { kind: this.kind, available: false, installed: false, problems: [toAppErrorData(e).code], supported: true };
    }
    const v = await this.caps.version(this.argvFor(exe), this.exeEnv(exe, cfg));
    const lib = v.ok ? undefined : missingLibrary(v.output);
    const status: EngineStatus = {
      kind: this.kind,
      available: v.ok,
      installed: true,
      variant: exe.variant,
      location: exe.path,
      problems: v.ok ? [] : [lib ? 'ENGINE_MISSING_LIBRARY' : 'ENGINE_START_FAILED'],
      ...(lib ? { problemParams: { library: lib.library, package: lib.package } } : {}),
      supported: true,
    };
    if (v.build !== undefined) status.version = v.build;
    return status;
  }

  /** Custom executable (file, or a folder containing llama-server) or the requested/newest managed build. */
  async resolveExecutable(cfg: EngineConfig): Promise<ResolvedExecutable> {
    if (cfg.executable) {
      let p = path.resolve(cfg.executable);
      let st = await fs.stat(p).catch(ignore);
      if (st?.isDirectory()) {
        p = path.join(p, serverExeName(this.o.deps.platform));
        st = await fs.stat(p).catch(ignore);
      }
      if (!st?.isFile()) throw new AppError('ENGINE_NOT_INSTALLED', `Executable not found: ${p}`, { params: { path: p } });
      return { path: p, variant: guessVariant(await fs.readdir(path.dirname(p))) };
    }
    const builds = await listInstalled(this.o.deps.paths.enginesDir);
    const b = cfg.build ? builds.find((x) => x.tag === cfg.build || x.id === cfg.build) : builds[0];
    if (!b) {
      throw new AppError('ENGINE_NOT_INSTALLED', 'No llama.cpp build installed', { params: { build: cfg.build ?? '' } });
    }
    return { path: b.serverPath, variant: b.variant, managed: b };
  }

  async capabilities(cfg: CoreEngineConfig): Promise<LlamaCaps> {
    const exe = await this.resolveExecutable(cfg);
    const caps = await this.caps.probe(this.argvFor(exe), this.exeEnv(exe, cfg));
    return { ...caps, variant: exe.variant };
  }

  async plan(cfg: CoreEngineConfig, model: ModelTarget, params: LaunchParams, opts: PlanOptions): Promise<LaunchPlan> {
    const pending: PendingPart[] = [];
    let exe: ResolvedExecutable;
    try {
      exe = await this.resolveExecutable(cfg);
    } catch (e) {
      // A preview before the install shows where the managed build will be; a custom executable
      // that is missing is the user's to fix (no install brings it back).
      if (!opts.preview || cfg.executable) throw e;
      exe = await this.plannedExecutable(cfg);
      pending.push('engine');
    }
    const env = this.exeEnv(exe);
    const caps = exe.planned ? currentLlamaCaps() : await this.caps.probe(this.argvFor(exe), this.exeEnv(exe, cfg));
    const weights = weightFiles(model, opts.preview);
    if (weights.pending) pending.push('model');
    const files = weights.files;
    const main = files[0];
    if (main === undefined) {
      throw new AppError('MODEL_NOT_FOUND', 'No local GGUF file for this model', {
        params: { model: model.identity.displayName },
      });
    }
    const sizes = await Promise.all(files.map((f) => fs.stat(f).then((s) => s.size, () => 0)));
    const statBytes = sizes.reduce((a, b) => a + b, 0);

    // A build whose --help lists our flags (forks too) gets only the ones it knows; the rest is reported.
    const gate = new FlagGate('llamacpp', exe.planned ? undefined : trustedFlags('llamacpp', caps.flags));
    const args = llamaArgs(params, caps, { modelPath: main, host: LOOPBACK, port: opts.port, marker: opts.marker, apiName: opts.apiName }, gate);

    const engine: EngineIdentity = { kind: this.kind, name: 'llama.cpp', variant: exe.variant, executable: exe.path };
    if (caps.version !== undefined) engine.version = caps.version;
    const build = caps.build ?? exe.managed?.tag ?? exe.planned?.tag;
    if (build !== undefined) engine.build = build;

    return {
      kind: this.kind,
      argv: [...this.argvFor(exe), ...args],
      env: { ...env, ...params.env },
      host: LOOPBACK,
      port: opts.port,
      params,
      engine,
      modelFiles: files,
      modelBytes: statBytes > 0 ? statBytes : (model.identity.sizeBytes ?? 0),
      marker: opts.marker,
      ...(pending.length > 0 ? { pending } : {}),
      ...(gate.missing.length > 0 ? { unsupported: gate.missing } : {}),
    };
  }

  /**
   * Where the install will put llama-server: enginesDir/llamacpp/<tag>-<variant>/ of the release it
   * would pick, or `<build or "latest">` when the releases cannot be read (offline, rate limited).
   */
  private async plannedExecutable(cfg: EngineConfig): Promise<ResolvedExecutable> {
    const plan = await this.planInstall(cfg.build ? { build: cfg.build } : {}).catch(() => undefined);
    const data = plan ? installDataSchema.parse(plan.data) : undefined;
    const id = data ? `${data.tag}-${data.selection.variant}` : (cfg.build ?? 'latest');
    return {
      path: path.join(llamaRoot(this.o.deps.paths.enginesDir), id, serverExeName(this.o.deps.platform)),
      variant: data?.selection.variant ?? 'cuda',
      planned: data ? { tag: data.tag } : {},
    };
  }

  async start(plan: LaunchPlan, signal: AbortSignal): Promise<EngineInstance> {
    if (signal.aborted) throw new AppError('CANCELLED', 'Engine start cancelled');
    const [cmd, ...args] = plan.argv as [string, ...string[]];
    const { clock, proc, log } = this.o.deps;
    let mp: ManagedProcess;
    try {
      // The ownership marker is also the run id here: LaunchPlan carries no run id.
      mp = proc.spawn({ cmd, args, env: plan.env, ...(plan.cwd ? { cwd: plan.cwd } : {}), owner: { runId: plan.marker, marker: plan.marker } });
    } catch (e) {
      throw new AppError('ENGINE_START_FAILED', `Cannot start ${cmd}: ${String(e)}`, { cause: e });
    }
    if (mp.pid > 0) {
      const rec = { pid: mp.pid, startedAtWall: clock.wall(), exe: cmd, marker: plan.marker, runId: plan.marker, kind: 'process' as const };
      await this.o.ownership.add(rec).catch((e: unknown) => log.warn('ownership record failed', { error: String(e) }));
    }
    const baseUrl = `http://${plan.host}:${plan.port}`;
    return createProcessInstance({
      mp,
      baseUrl,
      client: this.o.createClient('llamacpp', baseUrl),
      clock,
      probe: (s) => this.probeReady(baseUrl, plan.marker, s, plan.apiKey),
      phaseOf: llamaPhaseOf,
      diagnose: diagnoseExit,
      startSignal: signal,
      ...(this.o.pollMs !== undefined ? { pollMs: this.o.pollMs } : {}),
      ...(this.o.readyTimeoutMs !== undefined ? { readyTimeoutMs: this.o.readyTimeoutMs } : {}),
      onExit: () => this.o.ownership.remove(mp.pid),
    });
  }

  /**
   * llama-server binds its port before loading: /health answers 503 while loading, 200 when
   * ready. The alias check makes sure the 200 comes from our process, not from another server
   * that grabbed the port first.
   */
  private async probeReady(baseUrl: string, marker: string, signal: AbortSignal, apiKey: string | undefined): Promise<boolean> {
    const t = timeoutSignal(5000, signal);
    try {
      const health = await this.o.deps.fetch(`${baseUrl}/health`, { signal: t.signal });
      await health.text();
      if (health.status !== 200) return false;
      // A server shared on the network answers /v1/models only with its key.
      const models = await this.o.deps.fetch(`${baseUrl}/v1/models`, { signal: t.signal, ...(apiKey ? { headers: { authorization: `Bearer ${apiKey}` } } : {}) });
      const body = await models.text();
      return !models.ok || body.includes(marker);
    } finally {
      t.clear();
    }
  }

  releases(signal?: AbortSignal): Promise<LlamaRelease[]> {
    return this.releasesClient.list(signal);
  }

  installPlan(cfg: EngineConfig): Promise<InstallPlan> {
    return this.planInstall(cfg.build ? { build: cfg.build } : {});
  }

  /** Release + assets for this PC: requested build or the newest one with a usable asset. */
  async planInstall(req: InstallEngineRequest, signal?: AbortSignal): Promise<InstallPlan> {
    const releases = await this.releasesClient.list(signal);
    const cudaVersion = await this.o.cudaVersion?.();
    const sel = {
      platform: this.o.deps.platform,
      arch: this.o.deps.arch,
      ...(cudaVersion !== undefined ? { cudaVersion } : {}),
      ...(req.variant !== undefined ? { variant: req.variant } : {}),
    };
    let tag: string | undefined;
    let pick: AssetSelection | undefined;
    for (const r of req.build !== undefined ? releases.filter((x) => x.tag === req.build) : releases) {
      pick = selectAssets(r, sel);
      if (pick) {
        tag = r.tag;
        break;
      }
    }
    if (!pick || tag === undefined) {
      throw new AppError('ENGINE_INSTALL_FAILED', 'No llama.cpp release asset for this system', {
        params: { reason: 'no-asset', build: req.build ?? '', variant: req.variant ?? '', platform: this.o.deps.platform, arch: this.o.deps.arch },
      });
    }
    const items = [pick.main, ...(pick.cudart ? [pick.cudart] : [])].map((a) => ({ label: a.name, url: a.url, bytes: a.size }));
    return {
      kind: this.kind,
      label: `llama.cpp ${tag} (${pick.variant})`,
      bytes: items.reduce((s, i) => s + i.bytes, 0),
      items,
      data: { tag, selection: pick },
    };
  }

  async install(plan: InstallPlan, progress: ProgressSink, signal: AbortSignal): Promise<void> {
    await this.installBuild(plan, progress, signal);
  }

  installBuild(plan: InstallPlan, progress: ProgressSink, signal: AbortSignal): Promise<InstalledBuild> {
    const data = installDataSchema.parse(plan.data);
    const { deps } = this.o;
    const installDeps: InstallDeps = {
      fetch: deps.fetch,
      proc: deps.proc,
      clock: deps.clock,
      platform: deps.platform,
      enginesDir: deps.paths.enginesDir,
      ...(deps.env.LD_LIBRARY_PATH ? { ldLibraryPath: deps.env.LD_LIBRARY_PATH } : {}),
      ...this.o.install,
    };
    return installLlamaBuild(installDeps, data.tag, data.selection as AssetSelection, progress, signal);
  }

  listInstalled(): Promise<InstalledBuild[]> {
    return listInstalled(this.o.deps.paths.enginesDir);
  }

  removeBuild(id: string): Promise<void> {
    return removeBuild(this.o.deps.paths.enginesDir, id);
  }

  private argvFor(exe: ResolvedExecutable): string[] {
    return [...this.prefix, exe.path];
  }

  /**
   * Managed Linux builds (installed or planned) load the bundled CUDA runtime through LD_LIBRARY_PATH;
   * a custom engine's own environment applies to its probes too (`cfg.probeEnv`).
   */
  private exeEnv(exe: ResolvedExecutable, cfg?: CoreEngineConfig): Record<string, string> {
    const own = cfg?.probeEnv ?? {};
    if (!exe.managed && !exe.planned) return own;
    return { ...buildEnv(this.o.deps.platform, path.dirname(exe.path), this.o.deps.env.LD_LIBRARY_PATH), ...own };
  }
}
