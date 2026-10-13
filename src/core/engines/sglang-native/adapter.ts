import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { EngineStatus, LaunchParams } from '../../../contract/engines';
import { AppError, toAppErrorData } from '../../../contract/errors';
import type { EngineIdentity } from '../../../contract/results';
import type { CoreDeps, ManagedProcess } from '../../deps';
import type { OwnershipRegistry } from '../../process/ownership';
import { LOOPBACK } from '../../process/ports';
import { HF_PLACEHOLDER } from '../command-display';
import { createProcessInstance } from '../instance';
import type { ModelClientFactory } from '../shared/client';
import { modelReadyProbe } from '../shared/probes';
import { diagnoseSglang, parseSglangVersion, SGLANG_MODULE, SGLANG_VERSION_CODE, sglangEnv, sglangPhaseOf, sglangServeArgs } from '../shared/sglang';
import { FlagGate, trustedFlags } from '../shared/standard-flags';
import { vllmModelSource } from '../shared/vllm-args';
import { probeArgparseHelp, type VllmHelp } from '../shared/vllm-help';
import type { CoreEngineConfig, EngineAdapter, EngineCaps, EngineInstance, InstallPlan, LaunchPlan, ModelTarget, PlanOptions, ProgressSink } from '../types';
import { installUvEnv, failure } from '../vllm-native/install';
import { ownerExecutable } from '../vllm-native/adapter';

export type SglangNativeDeps = Pick<CoreDeps, 'clock' | 'proc' | 'fetch' | 'platform' | 'paths' | 'log'>;

export interface SglangNativeOptions {
  deps: SglangNativeDeps;
  createClient: ModelClientFactory;
  ownership?: Pick<OwnershipRegistry, 'add' | 'remove'>;
  hfToken?: () => string | undefined;
  /** argv prefix of uv (resolved at install time); default ["uv"]. */
  uv?: string[] | (() => Promise<string[] | undefined>);
  /** Argv placed before the Python executable (tests run the fake engine through node). */
  launcherPrefix?: string[];
  readyTimeoutMs?: number;
  pollMs?: number;
  /** `uv pip install` requirement (default "sglang"). */
  packageSpec?: string;
}

export interface SglangNativeLaunchPlan extends LaunchPlan {
  modelRepo?: string;
}

export const SGLANG_VENV_DIR = 'sglang-venv';

export function sglangVenvPaths(enginesDir: string): { venv: string; python: string } {
  const venv = path.join(enginesDir, SGLANG_VENV_DIR);
  return { venv, python: path.join(venv, 'bin', 'python') };
}

const installDataSchema = z.object({ spec: z.string() });

/**
 * SGLang as a native process (Linux only: SGLang has no Windows build; on Windows it runs in
 * Docker). The Python is the user's (`sglangPath`: a python, or its venv folder) or the managed venv
 * installed with uv; it runs `python -m sglang.launch_server`.
 */
export class SglangNativeAdapter implements EngineAdapter {
  readonly kind = 'sglang-native' as const;
  private readonly versions = new Map<string, Promise<{ ok: boolean; version?: string; output: string }>>();
  private readonly helps = new Map<string, Promise<VllmHelp>>();

  constructor(private readonly o: SglangNativeOptions) {}

  private supported(): boolean {
    return this.o.deps.platform === 'linux';
  }

  /** cfg.sglangPath (a python, or a venv folder → bin/python) or the managed venv's python. */
  async resolvePython(cfg?: CoreEngineConfig): Promise<string> {
    let p = cfg?.sglangPath ? path.resolve(cfg.sglangPath) : sglangVenvPaths(this.o.deps.paths.enginesDir).python;
    if ((await fs.stat(p).catch(() => undefined))?.isDirectory()) p = path.join(p, 'bin', 'python');
    const file = await fs.stat(p).catch(() => undefined);
    if (!file?.isFile()) throw new AppError('ENGINE_NOT_INSTALLED', `SGLang Python not found: ${p}`, { params: { path: p, kind: this.kind } });
    return p;
  }

  private argvFor(python: string): string[] {
    return [...(this.o.launcherPrefix ?? []), python];
  }

  private async key(python: string): Promise<string> {
    const st = await fs.stat(python);
    return `${python}|${st.mtimeMs}|${st.size}`;
  }

  /** `python -c "import sglang; print(sglang.__version__)"` (imports torch: slow), cached per file. */
  async version(python: string, env: Record<string, string> = {}): Promise<{ ok: boolean; version?: string; output: string }> {
    const key = await this.key(python);
    let p = this.versions.get(key);
    if (!p) {
      const [cmd, ...pre] = this.argvFor(python) as [string, ...string[]];
      p = this.o.deps.proc.run(cmd, [...pre, '-c', SGLANG_VERSION_CODE], { timeoutMs: 300_000, env }).then((out) => {
        const version = parseSglangVersion(out.stdout);
        return { ok: out.code === 0 && version !== undefined, ...(version !== undefined ? { version } : {}), output: `${out.stdout}\n${out.stderr}`.trim() };
      });
      this.versions.set(key, p);
    }
    return p;
  }

  async detect(cfg?: CoreEngineConfig): Promise<EngineStatus> {
    if (!this.supported()) return { kind: this.kind, available: false, installed: false, problems: [], supported: false };
    let python: string;
    try {
      python = await this.resolvePython(cfg);
    } catch (e) {
      return { kind: this.kind, available: false, installed: false, problems: [toAppErrorData(e).code], supported: true };
    }
    const v = await this.version(python, cfg?.probeEnv);
    return {
      kind: this.kind,
      available: v.ok,
      installed: true,
      location: python,
      ...(v.version !== undefined ? { version: v.version } : {}),
      // Python runs but has no SGLang: not installed in that environment.
      problems: v.ok ? [] : [/No module named '?sglang/.test(v.output) ? 'ENGINE_NOT_INSTALLED' : 'ENGINE_START_FAILED'],
      supported: true,
    };
  }

  async capabilities(cfg: CoreEngineConfig): Promise<EngineCaps> {
    const python = await this.resolvePython(cfg);
    const v = await this.version(python, cfg.probeEnv);
    const key = await this.key(python);
    let p = this.helps.get(key);
    if (!p) {
      const [cmd, ...pre] = this.argvFor(python) as [string, ...string[]];
      p = probeArgparseHelp(() => this.o.deps.proc.run(cmd, [...pre, ...SGLANG_MODULE, '--help'], { timeoutMs: 300_000, ...(cfg.probeEnv ? { env: cfg.probeEnv } : {}) }));
      this.helps.set(key, p);
    }
    const help = await p;
    return {
      ...(v.version !== undefined ? { version: v.version } : {}),
      flags: help.flags,
      choices: help.choices,
      tokenIdsInPrompt: true,
      timings: false,
      minTokens: true,
      fitFlag: false,
    };
  }

  async plan(cfg: CoreEngineConfig, model: ModelTarget, params: LaunchParams, opts: PlanOptions): Promise<SglangNativeLaunchPlan> {
    if (!this.supported()) {
      throw new AppError('ENGINE_NOT_INSTALLED', 'SGLang native runs on Linux only', { params: { reason: 'unsupported-os', kind: this.kind } });
    }
    const python = await this.resolvePython(cfg);
    const v = await this.version(python, cfg.probeEnv);
    const src = vllmModelSource(model);
    const env = sglangEnv(params);
    if (this.o.hfToken?.()) env.HF_TOKEN = HF_PLACEHOLDER;
    const gate = new FlagGate('sglang', trustedFlags('sglang', opts.knownFlags));
    const servedName = opts.apiName ?? opts.marker;
    const args = sglangServeArgs(
      params,
      {
        model: src.kind === 'local' ? path.join(src.hostDir, src.inner) : src.repo,
        host: LOOPBACK,
        port: opts.port,
        servedName,
        ...(src.kind === 'repo' && src.revision !== undefined ? { revision: src.revision } : {}),
      },
      gate,
    );
    // A server's name is its API name: the marker still goes on the command line (a Python -X option
    // it ignores), so a leftover process can be recognized as ours after a crash.
    const mark = servedName === opts.marker ? [] : ['-X', `gpubench=${opts.marker}`];
    const engine: EngineIdentity = { kind: this.kind, name: 'SGLang', executable: python };
    if (v.version !== undefined) engine.version = v.version;
    const files = src.kind === 'local' ? src.files : [];
    const sizes = await Promise.all(files.map((f) => fs.stat(f).then((s) => s.size, () => 0)));
    const bytes = sizes.reduce((a, b) => a + b, 0);
    const out: SglangNativeLaunchPlan = {
      kind: this.kind,
      argv: [...this.argvFor(python), ...mark, ...SGLANG_MODULE, ...args],
      env,
      host: LOOPBACK,
      port: opts.port,
      params,
      engine,
      modelFiles: files,
      modelBytes: bytes > 0 ? bytes : (model.identity.sizeBytes ?? 0),
      marker: opts.marker,
      ...(gate.missing.length > 0 ? { unsupported: gate.missing } : {}),
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
    const served = plan.argv[plan.argv.indexOf('--served-model-name') + 1] as string;
    const repo = (plan as SglangNativeLaunchPlan).modelRepo;
    return createProcessInstance({
      mp,
      baseUrl,
      client: this.o.createClient('sglang', baseUrl, { model: served }),
      clock,
      probe: modelReadyProbe(fetch, baseUrl, served, plan.apiKey),
      phaseOf: sglangPhaseOf,
      diagnose: (lines, exit) => diagnoseSglang(lines, exit, repo !== undefined ? { repo } : {}),
      startSignal: signal,
      ...(this.o.pollMs !== undefined ? { pollMs: this.o.pollMs } : {}),
      ...(this.o.readyTimeoutMs !== undefined ? { readyTimeoutMs: this.o.readyTimeoutMs } : {}),
      ...(ownership ? { onExit: () => ownership.remove(mp.pid) } : {}),
    });
  }

  installPlan(): Promise<InstallPlan> {
    if (!this.supported()) {
      return Promise.reject(new AppError('ENGINE_INSTALL_FAILED', 'SGLang native runs on Linux only', { params: { reason: 'unsupported-os', kind: this.kind } }));
    }
    const spec = this.o.packageSpec ?? 'sglang';
    // The wheel set (SGLang + PyTorch CUDA, several GB) is only known once uv resolves it: 0 = unknown.
    return Promise.resolve({ kind: this.kind, label: `SGLang (${spec})`, bytes: 0, items: [{ label: `${spec} + PyTorch (CUDA)`, bytes: 0 }], data: { spec } });
  }

  /** uv venv in enginesDir/sglang-venv + `uv pip install sglang`, then the version check. */
  async install(plan: InstallPlan, progress: ProgressSink, signal: AbortSignal): Promise<void> {
    const { spec } = installDataSchema.parse(plan.data);
    const uv = (typeof this.o.uv === 'function' ? await this.o.uv() : this.o.uv) ?? ['uv'];
    const p = sglangVenvPaths(this.o.deps.paths.enginesDir);
    const state = await installUvEnv({ proc: this.o.deps.proc, uv }, { venv: p.venv, python: p.python, spec, label: 'SGLang', owner: 'sglang-install' }, progress, signal);
    const v = await this.o.deps.proc.run(p.python, ['-c', SGLANG_VERSION_CODE], { timeoutMs: 300_000, signal });
    if (v.code !== 0 || parseSglangVersion(v.stdout) === undefined) throw failure('verify', v.code, `${v.stdout}\n${v.stderr}`.trim().split(/\r?\n/).slice(-40), 'SGLang');
    this.versions.clear();
    progress({ stage: 'done', bytesDone: state.bytesDone, ...(state.bytesTotal > 0 ? { bytesTotal: state.bytesTotal } : {}) });
  }
}
