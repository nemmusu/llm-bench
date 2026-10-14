/**
 * NVIDIA TensorRT-LLM in a Python environment ('trtllm-native'): `python -m tensorrt_llm.commands.serve
 * serve <model> …` (the program behind `trtllm-serve`). TensorRT-LLM is Linux only:
 *
 *  - Linux: the user's Python (`trtllmPath`: a python, or its venv folder) or LLM Bench's own environment
 *    (enginesDir/trtllm-venv), installed with uv like vLLM's; an engine process of ours like llama-server.
 *  - Windows: inside a WSL distro (`wslDistro`, else WSL's default one), like NInfer (ninfer/wsl.ts): the
 *    Python is a Linux path there (LLM Bench's own: ~/.llm-bench/trtllm-venv, installed with a Linux uv that
 *    LLM Bench downloads and checks itself and runs from /mnt/<drive>); the server is started through
 *    `wsl.exe -d <distro> --exec …`, its Linux PID and marker recorded and checked before any signal. A
 *    Windows model folder is read through /mnt/<drive> (slow); the HF token reaches it through WSLENV.
 *
 * TensorRT-LLM also needs Open MPI (libopenmpi-dev): a system package LLM Bench cannot install; a missing
 * library is said with the one command that adds it.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { EngineConfig, EngineStatus, LaunchParams } from '../../../contract/engines';
import { AppError, toAppErrorData } from '../../../contract/errors';
import type { EngineIdentity } from '../../../contract/results';
import { createLinuxEvictor, type EvictResult } from '../../cache/evictor';
import type { CoreDeps, LogLine, ManagedProcess, RunOutput } from '../../deps';
import type { OwnershipRegistry } from '../../process/ownership';
import { LOOPBACK } from '../../process/ports';
import { AsyncQueue } from '../../process/runner';
import { HF_PLACEHOLDER } from '../command-display';
import { createProcessInstance } from '../instance';
import { PID_LINE } from '../ninfer/logs';
import { distroRunner, hostArgv, listDistros, wslLaunchArgv, wslPathOf, type DistroRun, type WslProcesses } from '../ninfer/wsl';
import type { ModelClientFactory } from '../shared/client';
import { modelReadyProbe } from '../shared/probes';
import { FlagGate, trustedFlags } from '../shared/standard-flags';
import {
  diagnoseTrtllm,
  packageOfLibrary,
  parseTrtllmVersion,
  probeClickHelp,
  TRTLLM_MODULE,
  TRTLLM_PACKAGE,
  TRTLLM_SERVE,
  TRTLLM_VERSION_CODE,
  trtllmIgnored,
  trtllmPhaseOf,
  trtllmServeArgs,
} from '../shared/trtllm';
import { vllmModelSource } from '../shared/vllm-args';
import type { VllmHelp } from '../shared/vllm-help';
import type { EngineAdapter, EngineCaps, EngineInstance, InstallPlan, LaunchPlan, ModelTarget, PlanOptions, ProgressSink } from '../types';
import { failure, installUvEnv } from '../vllm-native/install';
import { ownerExecutable } from '../vllm-native/adapter';

export type TrtllmNativeDeps = Pick<CoreDeps, 'clock' | 'proc' | 'fetch' | 'platform' | 'paths' | 'log'>;

/** LLM Bench's own environment on Linux: enginesDir/trtllm-venv. */
export const TRTLLM_VENV_DIR = 'trtllm-venv';
/** LLM Bench's own environment inside a WSL distro (the distro user's home). */
export const TRTLLM_WSL_VENV = '~/.llm-bench/trtllm-venv';

export function trtllmVenvPaths(enginesDir: string): { venv: string; python: string } {
  const venv = path.join(enginesDir, TRTLLM_VENV_DIR);
  return { venv, python: path.join(venv, 'bin', 'python') };
}

export interface TrtllmWsl {
  /** wsl.exe (an argv prefix: tests use a fake). */
  argv: readonly string[];
  /** The record of our processes in the distros (shared with NInfer: one start-up cleanup for both). */
  processes: WslProcesses;
  /** A Linux uv binary on this PC's disk (downloaded and checked when missing), run from the distro through /mnt/<drive>. */
  linuxUv(distro: string, progress: ProgressSink, signal: AbortSignal): Promise<string>;
}

export interface TrtllmNativeOptions {
  deps: TrtllmNativeDeps;
  createClient: ModelClientFactory;
  ownership?: Pick<OwnershipRegistry, 'add' | 'remove'>;
  hfToken?: () => string | undefined;
  /** Linux: argv prefix of uv (resolved at install time); default ["uv"]. */
  uv?: string[] | (() => Promise<string[] | undefined>);
  /** Windows: WSL. Without it trtllm-native is not supported there. */
  wsl?: TrtllmWsl;
  /** Linux, tests only: argv placed before the Python (the fake engine run through node). */
  launcherPrefix?: string[];
  readyTimeoutMs?: number;
  pollMs?: number;
  /** `uv pip install` requirement (default "tensorrt-llm"). */
  packageSpec?: string;
  /** How long a probe of an environment is trusted (default 5 min). */
  probeTtlMs?: number;
}

/** Where a launch finds TensorRT-LLM. */
export interface TrtllmWhere {
  /** The Python as given (a path, a venv folder; in WSL "~/" is the home there). */
  python: string;
  /** Windows: the WSL distro. */
  distro?: string;
  /** The user's own environment (trtllmPath): updated and removed with their own tools. */
  own: boolean;
}

/** What one probe of an environment found. */
export interface TrtllmProbe {
  ok: boolean;
  /** The Python's full path (a venv folder resolved, "~/" expanded). */
  python?: string;
  version?: string;
  output: string;
  /** Why it cannot be used. */
  error?: AppError;
}

/** A plan that also says how to reach the process later (start, stop, eviction). */
export interface TrtllmNativeLaunchPlan extends LaunchPlan {
  modelRepo?: string;
  trtllm?: { distro?: string };
  slowSharedFilesystem?: boolean;
}

/**
 * Probe script for WSL: the Python ("~/" expanded, a folder → bin/python), then the version code and its
 * exit code after it.
 */
export const WSL_PROBE = [
  'py="$1"',
  'case "$py" in "~/"*) py="$HOME/${py#"~/"}";; esac',
  '[ -d "$py" ] && py="$py/bin/python"',
  'if [ ! -x "$py" ]; then echo "##gpubench-nopython $py"; exit 0; fi',
  'echo "##gpubench-python $py"',
  `"$py" -c "${TRTLLM_VERSION_CODE}" 2>&1`,
  'echo "##gpubench-rc $?"',
].join('\n');

/** Runs the Python with its arguments in the distro ("~/" expanded there). */
export const WSL_PYTHON = 'py="$1"; shift; case "$py" in "~/"*) py="$HOME/${py#"~/"}";; esac; [ -d "$py" ] && py="$py/bin/python"; exec "$py" "$@"';

const notInstalled = (reason: string, params: Record<string, string> = {}) =>
  new AppError('ENGINE_NOT_INSTALLED', `TensorRT-LLM: ${reason}`, { params: { reason, kind: 'trtllm-native', ...params } });

/** The version check's output: the version, or why the environment cannot run TensorRT-LLM. */
export function versionProbe(out: Pick<RunOutput, 'code' | 'stdout' | 'stderr'>, python: string, distro?: string): TrtllmProbe {
  const output = `${out.stdout}\n${out.stderr}`.trim();
  const version = parseTrtllmVersion(out.stdout);
  if (out.code === 0 && version !== undefined) return { ok: true, python, version, output };
  const lib = /([\w.+-]+\.so(?:\.[\d.]+)?): cannot open shared object file/.exec(output)?.[1];
  const error = lib
    ? new AppError('ENGINE_MISSING_LIBRARY', `TensorRT-LLM: the system library ${lib} is missing`, { params: { library: lib, package: packageOfLibrary(lib), ...(distro ? { distro } : {}) }, detail: output.slice(-2000) })
    : /No module named '?tensorrt_llm/.test(output)
      ? notInstalled('trtllm_missing', { path: python })
      : new AppError('ENGINE_START_FAILED', 'TensorRT-LLM does not start in this Python', { params: { path: python }, detail: output.slice(-2000) });
  return { ok: false, python, output, error };
}

/** The WSL probe script's output. */
export function parseWslProbe(out: RunOutput, where: TrtllmWhere): TrtllmProbe {
  const text = `${out.stdout}\n${out.stderr}`.replace(/\0/g, '');
  const missing = /##gpubench-nopython (.*)/.exec(text);
  if (missing) return { ok: false, output: text, error: notInstalled('python_missing', { path: (missing[1] as string).trim() }) };
  const python = /##gpubench-python (\/[^\r\n]*)/.exec(text)?.[1];
  const rc = /##gpubench-rc (\d+)/.exec(text);
  if (!python || !rc) {
    if (out.code === null) return { ok: false, output: text, error: notInstalled('wsl_missing') };
    if (/There is no distribution|WSL_E_DISTRO_NOT_FOUND|distribuzione con il nome/i.test(text)) return { ok: false, output: text, error: notInstalled('distro_missing', where.distro ? { distro: where.distro } : {}) };
    return { ok: false, output: text, error: notInstalled('python_missing', { path: where.python }) };
  }
  const body = text.slice(text.indexOf('\n', text.indexOf('##gpubench-python')) + 1, rc.index);
  return versionProbe({ code: Number(rc[1]), stdout: body, stderr: '' }, python, where.distro);
}

const installDataSchema = z.object({ spec: z.string(), distro: z.string().optional() });

export class TrtllmNativeAdapter implements EngineAdapter {
  readonly kind = 'trtllm-native' as const;
  private readonly probes = new Map<string, { at: number; result: Promise<TrtllmProbe> }>();
  private readonly helps = new Map<string, Promise<VllmHelp>>();

  constructor(private readonly o: TrtllmNativeOptions) {}

  /** Windows: through WSL. */
  private get inWsl(): boolean {
    return this.o.deps.platform === 'win32';
  }

  private supported(): boolean {
    return this.o.deps.platform === 'linux' || (this.inWsl && this.o.wsl !== undefined);
  }

  private get wsl(): TrtllmWsl {
    return this.o.wsl as TrtllmWsl;
  }

  /** WSL's default distro (Docker Desktop's own never count); undefined when WSL has none. */
  private async defaultDistro(): Promise<string | undefined> {
    const list = await listDistros(this.o.deps.proc, this.wsl.argv).catch(() => ({ wsl: false, distros: [] }));
    return (list.distros.find((d) => d.default) ?? list.distros[0])?.name;
  }

  /** Where TensorRT-LLM is for this config: its Python (and distro). */
  async where(cfg?: EngineConfig): Promise<TrtllmWhere> {
    const own = cfg?.trtllmPath !== undefined;
    if (this.inWsl) {
      const distro = cfg?.wslDistro ?? (await this.defaultDistro());
      if (!distro) throw notInstalled('distro_missing');
      return { python: cfg?.trtllmPath ?? `${TRTLLM_WSL_VENV}/bin/python`, distro, own };
    }
    return { python: cfg?.trtllmPath ? path.resolve(cfg.trtllmPath) : trtllmVenvPaths(this.o.deps.paths.enginesDir).python, own };
  }

  /** Runs a program where TensorRT-LLM runs: the distro (WSL) or this system. */
  private runner(where: Pick<TrtllmWhere, 'distro'>): DistroRun {
    if (this.inWsl) return distroRunner(this.o.deps.proc, this.wsl.argv, where.distro as string);
    const prefix = this.o.launcherPrefix ?? [];
    return (cmd, args, opts) => this.o.deps.proc.run(...hostArgv(prefix, [cmd, ...args]), opts);
  }

  /** Runs the environment's Python with `args` (WSL: "~/" and a venv folder resolved there). */
  private python(where: TrtllmWhere, python: string, args: string[], opts: { timeoutMs: number; signal?: AbortSignal }): Promise<RunOutput> {
    if (this.inWsl) return this.runner(where)('/bin/sh', ['-c', WSL_PYTHON, 'sh', python, ...args], opts);
    return this.runner(where)(python, args, opts);
  }

  /** Every environment is asked again at its next probe (after an install or a removal). */
  forget(): void {
    this.probes.clear();
    this.helps.clear();
  }

  /** The environment's Python and TensorRT-LLM version, cached for probeTtlMs; `fresh` asks again. */
  probe(where: TrtllmWhere, fresh = false): Promise<TrtllmProbe> {
    const key = `${where.distro ?? ''}|${where.python}`;
    const now = this.o.deps.clock.now();
    const hit = this.probes.get(key);
    if (hit && !fresh && now - hit.at < (this.o.probeTtlMs ?? 5 * 60_000)) return hit.result;
    const result = this.runProbe(where).catch(
      (e: unknown): TrtllmProbe => ({ ok: false, output: String(e), error: new AppError('ENGINE_START_FAILED', 'TensorRT-LLM does not start in this Python', { params: { path: where.python }, detail: String(e) }) }),
    );
    this.probes.set(key, { at: now, result });
    return result;
  }

  private async runProbe(where: TrtllmWhere): Promise<TrtllmProbe> {
    if (this.inWsl) return parseWslProbe(await this.runner(where)('/bin/sh', ['-c', WSL_PROBE, 'sh', where.python], { timeoutMs: 300_000 }), where);
    let p = where.python;
    if ((await fs.stat(p).catch(() => undefined))?.isDirectory()) p = path.join(p, 'bin', 'python');
    if (!(await fs.stat(p).catch(() => undefined))?.isFile()) return { ok: false, output: '', error: notInstalled('python_missing', { path: p }) };
    return versionProbe(await this.runner(where)(p, ['-c', TRTLLM_VERSION_CODE], { timeoutMs: 300_000 }), p);
  }

  async detect(cfg?: EngineConfig): Promise<EngineStatus> {
    if (!this.supported()) return { kind: this.kind, available: false, installed: false, problems: [], supported: false };
    let where: TrtllmWhere;
    try {
      where = await this.where(cfg);
    } catch (e) {
      const err = toAppErrorData(e);
      // where() only fails with a reason (no distro).
      return { kind: this.kind, available: false, installed: false, problems: [err.code], problemParams: err.params as NonNullable<typeof err.params>, supported: true };
    }
    const probe = await this.probe(where);
    const status: EngineStatus = {
      kind: this.kind,
      available: probe.ok,
      // A Python that runs but lacks a system library is installed: the library is what is missing.
      installed: probe.ok || probe.error?.code === 'ENGINE_MISSING_LIBRARY' || probe.error?.code === 'ENGINE_START_FAILED',
      location: probe.python ?? where.python,
      ...(where.distro ? { variant: where.distro } : {}),
      ...(probe.version !== undefined ? { version: probe.version } : {}),
      problems: [],
      supported: true,
    };
    if (probe.ok) return status;
    const e = probe.error as AppError;
    // A failed probe always says why (its reason and details).
    return { ...status, problems: [e.code], problemParams: e.params as Record<string, string | number | boolean> };
  }

  /** Token-id prompts, min_tokens and continuous usage like vLLM; options from `… serve --help` (cached per environment). */
  async capabilities(cfg: EngineConfig): Promise<EngineCaps> {
    const where = await this.where(cfg);
    const probe = await this.probe(where);
    if (!probe.ok) throw probe.error as AppError;
    const python = probe.python as string;
    const key = `${where.distro ?? ''}|${python}|${probe.version as string}`;
    let help = this.helps.get(key);
    if (!help) {
      help = probeClickHelp(() => this.python(where, python, [...TRTLLM_MODULE, TRTLLM_SERVE, '--help'], { timeoutMs: 300_000 }));
      this.helps.set(key, help);
    }
    const h = await help;
    return { version: probe.version as string, flags: h.flags, choices: h.choices, tokenIdsInPrompt: true, timings: false, minTokens: true, fitFlag: false };
  }

  async plan(cfg: EngineConfig, model: ModelTarget, params: LaunchParams, opts: PlanOptions): Promise<TrtllmNativeLaunchPlan> {
    if (!this.supported()) {
      throw new AppError('ENGINE_NOT_INSTALLED', 'TensorRT-LLM runs on Linux, or inside WSL on Windows', { params: { reason: 'unsupported-os', kind: this.kind } });
    }
    const where = await this.where(cfg);
    const probe = await this.probe(where);
    // A preview names where TensorRT-LLM will be once it is installed.
    if (!probe.ok && !opts.preview) throw probe.error as AppError;
    const python = probe.python ?? where.python;
    const src = vllmModelSource(model);
    let modelRef: string;
    let slow = false;
    let files: string[] = [];
    if (src.kind === 'local') {
      const host = path.join(src.hostDir, src.inner);
      files = src.files;
      if (this.inWsl) {
        const mapped = wslPathOf(host, where.distro as string);
        if (!mapped) throw new AppError('VALIDATION', 'The model is in another WSL distro or on a network share', { params: { reason: 'trtllm_wsl_path', path: host, distro: where.distro as string } });
        modelRef = mapped.path;
        slow = mapped.slow;
        files = files.flatMap((f) => wslPathOf(f, where.distro as string)?.path ?? []);
      } else modelRef = host;
    } else modelRef = src.repo;
    const env: Record<string, string> = { ...params.env };
    if (this.o.hfToken?.()) env.HF_TOKEN = HF_PLACEHOLDER;
    const gate = new FlagGate('trtllm', trustedFlags('trtllm', opts.knownFlags));
    const servedName = opts.apiName ?? opts.marker;
    const args = trtllmServeArgs(params, { model: modelRef, host: LOOPBACK, port: opts.port, servedName, ...(src.kind === 'repo' && src.revision !== undefined ? { revision: src.revision } : {}) }, gate);
    const command = [...TRTLLM_MODULE, TRTLLM_SERVE, ...args];
    let argv: string[];
    let planEnv = env;
    if (this.inWsl) {
      // The variables reach the distro through WSLENV (never on the command line: the HF token is a secret).
      const names = Object.keys(env);
      planEnv = names.length > 0 ? { ...env, WSLENV: names.map((n) => `${n}/u`).join(':') } : {};
      argv = wslLaunchArgv(this.wsl.argv, { distro: where.distro as string, serve: python, args: command, env: {}, marker: opts.marker });
    } else {
      // A server's name is its API name: the marker still goes on the command line (a Python -X option it ignores).
      const mark = servedName === opts.marker ? [] : ['-X', `gpubench=${opts.marker}`];
      argv = [...(this.o.launcherPrefix ?? []), python, ...mark, ...command];
    }
    const engine: EngineIdentity = { kind: this.kind, name: 'TensorRT-LLM', executable: python, ...(probe.version !== undefined ? { version: probe.version } : {}), ...(where.distro ? { variant: where.distro } : {}) };
    const sizes = await Promise.all(src.kind === 'local' ? src.files.map((f) => fs.stat(f).then((s) => s.size, () => 0)) : []);
    const bytes = sizes.reduce((a, b) => a + b, 0);
    const unsupported = [...gate.missing, ...trtllmIgnored(params)];
    const out: TrtllmNativeLaunchPlan = {
      kind: this.kind,
      argv,
      env: planEnv,
      host: LOOPBACK,
      port: opts.port,
      params,
      engine,
      // WSL: the distro's paths (evicted from inside it, evict()).
      modelFiles: files,
      modelBytes: bytes > 0 ? bytes : (model.identity.sizeBytes ?? 0),
      marker: opts.marker,
      ...(where.distro ? { trtllm: { distro: where.distro } } : {}),
      ...(slow ? { slowSharedFilesystem: true } : {}),
      ...(unsupported.length > 0 ? { unsupported } : {}),
      ...(!probe.ok ? { pending: ['engine' as const] } : {}),
    };
    if (src.kind === 'repo') out.modelRepo = src.repo;
    return out;
  }

  /** Cold loads in WSL: the model's pages are dropped from the distro's own page cache (posix_fadvise, no root). */
  async evict(plan: LaunchPlan, signal?: AbortSignal): Promise<EvictResult | undefined> {
    const distro = (plan as TrtllmNativeLaunchPlan).trtllm?.distro;
    if (!this.inWsl || !distro) return undefined;
    const evictor = createLinuxEvictor({ proc: { run: this.runner({ distro }), spawn: this.o.deps.proc.spawn } });
    return evictor.evict(plan.modelFiles, signal).catch(() => ({ guaranteed: false, reason: 'failed' as const }));
  }

  async start(plan: LaunchPlan, signal: AbortSignal): Promise<EngineInstance> {
    if (signal.aborted) throw new AppError('CANCELLED', 'Engine start cancelled');
    const p = plan as TrtllmNativeLaunchPlan;
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
    const distro = p.trtllm?.distro;
    let watched = mp;
    let onExit: (() => Promise<void>) | undefined;
    if (this.inWsl && distro) {
      const wsl = this.wsl;
      const linux = { pid: undefined as number | undefined };
      // The launcher's first line is the Linux PID: recorded (crash leftovers), never shown as an engine line.
      const lines = new AsyncQueue<LogLine>();
      void (async () => {
        for await (const line of mp.lines) {
          const pid = PID_LINE.exec(line.text)?.[1];
          if (pid !== undefined && linux.pid === undefined) {
            linux.pid = Number(pid);
            await wsl.processes.add({ distro, pid: linux.pid, marker: plan.marker, startedAtWall: clock.wall() }).catch((e: unknown) => log.warn('trtllm wsl record failed', { error: String(e) }));
            continue;
          }
          lines.push(line);
        }
        lines.close();
      })();
      const stop = async (o?: { graceMs?: number }) => {
        // Our server inside the distro first (checked by its marker), then the wsl.exe relay.
        if (linux.pid !== undefined) await wsl.processes.stop({ distro, pid: linux.pid, marker: plan.marker }, mp.exited).catch((e: unknown) => log.warn('trtllm wsl stop failed', { error: String(e) }));
        return mp.stop(o);
      };
      watched = { pid: mp.pid, startedAt: mp.startedAt, lines, exited: mp.exited, stop };
      onExit = async () => {
        if (linux.pid !== undefined) await wsl.processes.remove(distro, linux.pid);
      };
    } else if (this.o.ownership && mp.pid > 0) {
      const ownership = this.o.ownership;
      const exe = await ownerExecutable(cmd, this.o.launcherPrefix !== undefined && this.o.launcherPrefix.length > 0);
      await ownership.add({ pid: mp.pid, startedAtWall: clock.wall(), exe, marker: plan.marker, runId: plan.marker, kind: 'process' }).catch((e: unknown) => log.warn('ownership record failed', { error: String(e) }));
      onExit = () => ownership.remove(mp.pid);
    }
    const baseUrl = `http://${plan.host}:${plan.port}`;
    const served = plan.argv[plan.argv.indexOf('--served_model_name') + 1] as string;
    const inst = createProcessInstance({
      mp: watched,
      baseUrl,
      client: this.o.createClient('trtllm', baseUrl, { model: served }),
      clock,
      probe: modelReadyProbe(fetch, baseUrl, served, plan.apiKey),
      phaseOf: trtllmPhaseOf,
      diagnose: (lines, exit) => diagnoseTrtllm(lines, exit, { ...(p.modelRepo !== undefined ? { repo: p.modelRepo } : {}), ...(distro ? { distro } : {}) }),
      startSignal: signal,
      ...(this.o.pollMs !== undefined ? { pollMs: this.o.pollMs } : {}),
      ...(this.o.readyTimeoutMs !== undefined ? { readyTimeoutMs: this.o.readyTimeoutMs } : {}),
      ...(onExit ? { onExit } : {}),
    });
    if (!this.inWsl) return inst;
    // The process LLM Bench sees is wsl.exe: its VRAM is the WSL VM's, never attributable to the engine.
    const { pid: _relay, ...rest } = inst;
    return rest;
  }

  async installPlan(cfg: EngineConfig): Promise<InstallPlan> {
    if (!this.supported()) {
      throw new AppError('ENGINE_INSTALL_FAILED', 'TensorRT-LLM runs on Linux, or inside WSL on Windows', { params: { reason: 'unsupported-os', kind: this.kind } });
    }
    const spec = this.o.packageSpec ?? TRTLLM_PACKAGE;
    const distro = this.inWsl ? (await this.where(cfg)).distro : undefined;
    // The wheel set (TensorRT-LLM + PyTorch CUDA, several GB) is only known once uv resolves it: 0 = unknown.
    return { kind: this.kind, label: `TensorRT-LLM (${spec})`, bytes: 0, items: [{ label: `${spec} + PyTorch (CUDA)`, bytes: 0 }], data: { spec, ...(distro ? { distro } : {}) } };
  }

  /**
   * uv venv + `uv pip install tensorrt-llm --torch-backend auto` into LLM Bench's own environment (Linux:
   * enginesDir/trtllm-venv; WSL: ~/.llm-bench/trtllm-venv in the distro, with a Linux uv), then the version check.
   */
  async install(plan: InstallPlan, progress: ProgressSink, signal: AbortSignal): Promise<void> {
    const data = installDataSchema.parse(plan.data);
    let uv: string[];
    let venv: string;
    let python: string;
    const where: TrtllmWhere = { python: '', own: false, ...(data.distro ? { distro: data.distro } : {}) };
    if (this.inWsl) {
      const distro = data.distro as string;
      const exe = await this.wsl.linuxUv(distro, progress, signal);
      const mapped = wslPathOf(exe, distro) as { path: string };
      uv = [...this.wsl.argv, '-d', distro, '--exec', mapped.path];
      const home = (await this.runner(where)('/bin/sh', ['-c', 'echo "$HOME"'], { timeoutMs: 60_000, signal })).stdout.trim();
      if (!home.startsWith('/')) throw notInstalled('distro_missing', { distro });
      venv = `${home}/${TRTLLM_WSL_VENV.slice(2)}`;
      python = `${venv}/bin/python`;
    } else {
      uv = (typeof this.o.uv === 'function' ? await this.o.uv() : this.o.uv) ?? ['uv'];
      ({ venv, python } = trtllmVenvPaths(this.o.deps.paths.enginesDir));
    }
    const state = await installUvEnv({ proc: this.o.deps.proc, uv }, { venv, python, spec: data.spec, label: 'TensorRT-LLM', owner: 'trtllm-install' }, progress, signal);
    const v = versionProbe(await this.python(where, python, ['-c', TRTLLM_VERSION_CODE], { timeoutMs: 300_000, signal }), python, data.distro);
    this.forget();
    // Open MPI missing is a system package for the user to add: the install itself worked.
    if (!v.ok && v.error?.code !== 'ENGINE_MISSING_LIBRARY') throw failure('verify', null, v.output.split(/\r?\n/).slice(-40), 'TensorRT-LLM');
    if (!v.ok) throw v.error as AppError;
    progress({ stage: 'done', bytesDone: state.bytesDone, ...(state.bytesTotal > 0 ? { bytesTotal: state.bytesTotal } : {}) });
  }

  /** "Rimuovi": deletes LLM Bench's own environment (never the user's own: trtllmPath). */
  async remove(cfg: EngineConfig): Promise<void> {
    const where = await this.where(cfg);
    if (where.own) throw new AppError('VALIDATION', 'This Python environment is your own: remove it with your own tools', { params: { reason: 'own-environment', path: where.python } });
    if (this.inWsl) {
      const out = await this.runner(where)('/bin/sh', ['-c', 'rm -rf -- "$HOME/.llm-bench/trtllm-venv"'], { timeoutMs: 300_000 });
      if (out.code !== 0) throw new AppError('INTERNAL', 'The TensorRT-LLM environment could not be removed', { detail: `${out.stdout}\n${out.stderr}`.trim() });
    } else {
      await fs.rm(trtllmVenvPaths(this.o.deps.paths.enginesDir).venv, { recursive: true, force: true });
    }
    this.forget();
  }
}
