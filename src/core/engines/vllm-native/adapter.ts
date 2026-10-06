import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { EngineConfig, EngineStatus, LaunchParams } from '../../../contract/engines';
import { AppError, toAppErrorData } from '../../../contract/errors';
import type { EngineIdentity } from '../../../contract/results';
import type { CoreDeps, ManagedProcess } from '../../deps';
import type { OwnershipRegistry } from '../../process/ownership';
import { LOOPBACK } from '../../process/ports';
import { HF_PLACEHOLDER } from '../command-display';
import { createProcessInstance } from '../instance';
import type { EngineAdapter, EngineCaps, EngineInstance, InstallPlan, LaunchPlan, ModelTarget, PlanOptions, ProgressSink } from '../types';
import type { ModelClientFactory } from '../shared/client';
import { modelReadyProbe } from '../shared/probes';
import { vllmModelSource, vllmServeArgs } from '../shared/vllm-args';
import { diagnoseVllm, vllmPhaseOf } from '../shared/vllm-logs';
import { installVllm, parseVllmVersion, venvPaths } from './install';

export type VllmNativeDeps = Pick<CoreDeps, 'clock' | 'proc' | 'fetch' | 'platform' | 'paths' | 'log'>;

export interface VllmNativeOptions {
  deps: VllmNativeDeps;
  createClient: ModelClientFactory;
  ownership?: Pick<OwnershipRegistry, 'add' | 'remove'>;
  hfToken?: () => string | undefined;
  /** argv prefix of uv (the binary installed by the setup module); default ["uv"] from PATH. Resolved at install time. */
  uv?: string[] | (() => Promise<string[] | undefined>);
  /** Argv placed before the vllm executable (tests run the fake engine through node). */
  launcherPrefix?: string[];
  readyTimeoutMs?: number;
  pollMs?: number;
  /** `uv pip install` requirement (default "vllm"). */
  packageSpec?: string;
}

/** A plan that also remembers the HF repo for error messages. */
export interface VllmNativeLaunchPlan extends LaunchPlan {
  modelRepo?: string;
}

const installDataSchema = z.object({ spec: z.string() });

/**
 * vLLM run as a native process (Linux only: vLLM has no Windows build). The executable is the
 * user's (`vllmPath`: the `vllm` script or its venv) or the managed venv installed with uv.
 */
export class VllmNativeAdapter implements EngineAdapter {
  readonly kind = 'vllm-native' as const;
  private readonly versions = new Map<string, Promise<{ ok: boolean; version?: string; output: string }>>();

  constructor(private readonly o: VllmNativeOptions) {}

  private supported(): boolean {
    return this.o.deps.platform === 'linux';
  }

  /** cfg.vllmPath (file, or a venv folder → bin/vllm) or the managed venv. */
  async resolveExecutable(cfg?: EngineConfig): Promise<string> {
    let p = cfg?.vllmPath ? path.resolve(cfg.vllmPath) : venvPaths(this.o.deps.paths.enginesDir).vllm;
    const st = await fs.stat(p).catch(() => undefined);
    if (st?.isDirectory()) p = path.join(p, 'bin', 'vllm');
    const file = await fs.stat(p).catch(() => undefined);
    if (!file?.isFile()) throw new AppError('ENGINE_NOT_INSTALLED', `vLLM not found: ${p}`, { params: { path: p, kind: this.kind } });
    return p;
  }

  private argvFor(exe: string): string[] {
    return [...(this.o.launcherPrefix ?? []), exe];
  }

  /** `vllm --version` (slow: imports torch), cached per executable path + mtime. */
  async version(exe: string): Promise<{ ok: boolean; version?: string; output: string }> {
    const st = await fs.stat(exe);
    const key = `${exe}|${st.mtimeMs}|${st.size}`;
    let p = this.versions.get(key);
    if (!p) {
      const [cmd, ...pre] = this.argvFor(exe) as [string, ...string[]];
      p = this.o.deps.proc.run(cmd, [...pre, '--version'], { timeoutMs: 300_000 }).then((out) => {
        const version = parseVllmVersion(out.stdout);
        return { ok: out.code === 0 && version !== undefined, ...(version !== undefined ? { version } : {}), output: `${out.stdout}\n${out.stderr}`.trim() };
      });
      this.versions.set(key, p);
    }
    return p;
  }

  async detect(cfg?: EngineConfig): Promise<EngineStatus> {
    if (!this.supported()) return { kind: this.kind, available: false, installed: false, problems: [], supported: false };
    let exe: string;
    try {
      exe = await this.resolveExecutable(cfg);
    } catch (e) {
      return { kind: this.kind, available: false, installed: false, problems: [toAppErrorData(e).code], supported: true };
    }
    const v = await this.version(exe);
    return {
      kind: this.kind,
      available: v.ok,
      installed: true,
      location: exe,
      ...(v.version !== undefined ? { version: v.version } : {}),
      problems: v.ok ? [] : ['ENGINE_START_FAILED'],
      supported: true,
    };
  }

  async capabilities(cfg: EngineConfig): Promise<EngineCaps> {
    const v = await this.version(await this.resolveExecutable(cfg));
    return { ...(v.version !== undefined ? { version: v.version } : {}), flags: new Set(), tokenIdsInPrompt: true, timings: false, minTokens: true, fitFlag: false };
  }

  async plan(cfg: EngineConfig, model: ModelTarget, params: LaunchParams, opts: PlanOptions): Promise<VllmNativeLaunchPlan> {
    if (!this.supported()) {
      throw new AppError('ENGINE_NOT_INSTALLED', 'vLLM native runs on Linux only', { params: { reason: 'unsupported-os', kind: this.kind } });
    }
    const exe = await this.resolveExecutable(cfg);
    const v = await this.version(exe);
    const src = vllmModelSource(model);
    const modelRef = src.kind === 'local' ? path.join(src.hostDir, src.inner) : src.repo;
    const env: Record<string, string> = { ...params.env };
    if (this.o.hfToken?.()) env.HF_TOKEN = HF_PLACEHOLDER;
    const args = vllmServeArgs(params, {
      model: modelRef,
      positional: true,
      host: LOOPBACK,
      port: opts.port,
      servedName: opts.marker,
      apiName: opts.apiName,
      ...(src.kind === 'repo' && src.revision !== undefined ? { revision: src.revision } : {}),
    });
    const engine: EngineIdentity = { kind: this.kind, name: 'vLLM', executable: exe };
    if (v.version !== undefined) engine.version = v.version;
    const files = src.kind === 'local' ? src.files : [];
    const sizes = await Promise.all(files.map((f) => fs.stat(f).then((s) => s.size, () => 0)));
    const bytes = sizes.reduce((a, b) => a + b, 0);
    const out: VllmNativeLaunchPlan = {
      kind: this.kind,
      argv: [...this.argvFor(exe), 'serve', ...args],
      env,
      host: LOOPBACK,
      port: opts.port,
      params,
      engine,
      modelFiles: files,
      modelBytes: bytes > 0 ? bytes : (model.identity.sizeBytes ?? 0),
      marker: opts.marker,
    };
    if (src.kind === 'repo') out.modelRepo = src.repo;
    return out;
  }

  async start(plan: LaunchPlan, signal: AbortSignal): Promise<EngineInstance> {
    if (signal.aborted) throw new AppError('CANCELLED', 'Engine start cancelled');
    const [cmd, ...args] = plan.argv as [string, ...string[]];
    const { clock, proc, log, fetch } = this.o.deps;
    const token = this.o.hfToken?.();
    const env = { ...plan.env, ...(plan.env.HF_TOKEN !== undefined && token ? { HF_TOKEN: token } : {}) };
    let mp: ManagedProcess;
    try {
      mp = proc.spawn({ cmd, args, env, owner: { runId: plan.marker, marker: plan.marker } });
    } catch (e) {
      throw new AppError('ENGINE_START_FAILED', `Cannot start ${cmd}: ${String(e)}`, { cause: e });
    }
    const ownership = this.o.ownership;
    if (ownership && mp.pid > 0) {
      const exe = await ownerExecutable(cmd, this.o.launcherPrefix !== undefined && this.o.launcherPrefix.length > 0);
      const rec = { pid: mp.pid, startedAtWall: clock.wall(), exe, marker: plan.marker, runId: plan.marker, kind: 'process' as const };
      await ownership.add(rec).catch((e: unknown) => log.warn('ownership record failed', { error: String(e) }));
    }
    const baseUrl = `http://${plan.host}:${plan.port}`;
    const repo = (plan as VllmNativeLaunchPlan).modelRepo;
    return createProcessInstance({
      mp,
      baseUrl,
      client: this.o.createClient('vllm', baseUrl, { model: plan.marker }),
      clock,
      probe: modelReadyProbe(fetch, baseUrl, plan.marker),
      phaseOf: vllmPhaseOf,
      diagnose: (lines, exit) => diagnoseVllm(lines, exit, repo !== undefined ? { repo } : {}),
      startSignal: signal,
      ...(this.o.pollMs !== undefined ? { pollMs: this.o.pollMs } : {}),
      ...(this.o.readyTimeoutMs !== undefined ? { readyTimeoutMs: this.o.readyTimeoutMs } : {}),
      ...(ownership ? { onExit: () => ownership.remove(mp.pid) } : {}),
    });
  }

  async installPlan(): Promise<InstallPlan> {
    if (!this.supported()) {
      throw new AppError('ENGINE_INSTALL_FAILED', 'vLLM native runs on Linux only', { params: { reason: 'unsupported-os', kind: this.kind } });
    }
    const spec = this.o.packageSpec ?? 'vllm';
    // The wheel set (vLLM + PyTorch CUDA, ~5–10 GB) is only known once uv resolves it: 0 = unknown.
    return { kind: this.kind, label: `vLLM (${spec})`, bytes: 0, items: [{ label: `${spec} + PyTorch (CUDA)`, bytes: 0 }], data: { spec } };
  }

  async install(plan: InstallPlan, progress: ProgressSink, signal: AbortSignal): Promise<void> {
    const { spec } = installDataSchema.parse(plan.data);
    const uv = (typeof this.o.uv === 'function' ? await this.o.uv() : this.o.uv) ?? ['uv'];
    await installVllm({ proc: this.o.deps.proc, enginesDir: this.o.deps.paths.enginesDir, uv, spec }, progress, signal);
    this.versions.clear();
  }
}

/**
 * The executable the OS reports for the process (/proc/<pid>/exe): `vllm` is a Python script, so
 * that is the interpreter named by its shebang, symlinks resolved (venv python → real CPython).
 * With a launcher prefix (tests) the launcher itself is the executable.
 */
export async function ownerExecutable(cmd: string, launcher: boolean): Promise<string> {
  if (launcher) return cmd;
  const head = await fs.readFile(cmd).then((b) => b.subarray(0, 512).toString('utf8'), () => '');
  const shebang = /^#!\s*(\S+)/.exec(head)?.[1];
  // "#!/usr/bin/env python3" names no file: keep the script path (the marker check still applies).
  const target = shebang !== undefined && !shebang.endsWith('/env') ? shebang : cmd;
  return fs.realpath(target).catch(() => target);
}
