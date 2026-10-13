import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DockerHangReason, DockerRestartStep, DockerState } from '../../contract/docker';
import { AppError, isAppError, type ErrorCode } from '../../contract/errors';
import type { Clock, Logger, Platform, ProcessRunner } from '../deps';
import type { ContainerOwnership, OwnedRecord } from '../process/ownership';
import { classifyDockerError, envValue, GPUBENCH_LABEL, isEngineHang, isOurs, NO_DESKTOP_PLUGIN, WSL_SHIM, type DesktopStatus, type DockerCli } from './cli';

export type { DockerState } from '../../contract/docker';

export interface DockerStatusDetail {
  state: DockerState;
  /** Server version when reachable, else the CLI version. */
  version?: string;
  clientVersion?: string;
  serverVersion?: string;
  /** "Docker Desktop 4.47.0 (…)" when the daemon is Docker Desktop. */
  platform?: string;
  context?: string;
  /**
   * Why the state is what it is: wsl-integration, podman, windows-containers, gpu-check-failed…;
   * for "not-responding" a DockerHangReason; 'slow-answer' when `docker version` was slow once.
   */
  reason?: string;
  /** Raw CLI message (expert "Dettagli"). */
  detail?: string;
  /** How long a start we requested has been running (state "starting"). */
  startingForMs?: number;
  /** State "not-responding": for how long Docker has not been answering. */
  stuckForMs?: number;
  /** A restart LLM Bench asked for is under way (the state says "starting" meanwhile). */
  restarting?: boolean;
}

export interface StartProgress {
  state: DockerState;
  elapsedMs: number;
  /** Starting for longer than usual: Docker Desktop may be waiting for the user (terms, sign-in, WSL update). */
  slow: boolean;
  method: 'cli' | 'exe';
}

/** Where a restart is ("Riavvia Docker"): the step, its place among the steps it may take, Docker's state. */
export interface RestartProgress {
  step: Exclude<DockerRestartStep, 'servers'>;
  /** 1-based position of the step among the ones this restart may take. */
  index: number;
  steps: number;
  elapsedMs: number;
  state: DockerState;
  slow: boolean;
}

export interface GpuCheckResult {
  image: string;
  /** "GPU 0: NVIDIA GeForce RTX 5090 (UUID: GPU-…)" lines from nvidia-smi -L inside the container. */
  gpus: string[];
}

export interface DockerEnvironmentOptions {
  cli: DockerCli;
  clock: Clock;
  platform: Platform;
  env: Record<string, string | undefined>;
  log?: Logger;
  /** Starts a GUI program without waiting for it (default: detached child_process.spawn). */
  launchDetached?: (cmd: string, args: string[]) => Promise<void>;
  exists?: (p: string) => Promise<boolean>;
  /** status() result reuse window (the system page polls). Default 2 s. */
  statusMaxAgeMs?: number;
  /** Docker Desktop takes 30–120 s to start; default 180 s. */
  startTimeoutMs?: number;
  startPollMs?: number;
  /** After this long "starting" is reported as slow (default 60 s). */
  slowStartMs?: number;
  gpuCheckTimeoutMs?: number;
  /** `docker version` time limit in status(): two misses in a row = "not-responding". Default 10 s. */
  versionTimeoutMs?: number;
  /** Starting for this long without LLM Bench having asked for it = stuck. Default 4 min. */
  stuckStartingMs?: number;
  /** Docker Desktop saying "stopping" (or not answering itself) for this long = stuck. Default 20 s. */
  stuckStoppingMs?: number;
  /** How often status() asks Docker Desktop for its own engine status, in the background. Default 60 s. */
  desktopStatusEveryMs?: number;
  desktopStatusTimeoutMs?: number;
  /** The call probe() makes to the engine itself (`docker ps`). Default 10 s. */
  probeTimeoutMs?: number;
  /** `docker desktop restart` / `docker desktop stop --force` time limit. Default 90 s. */
  restartCommandTimeoutMs?: number;
  /** Each step of a restart waits this long for Docker to answer again. Default 120 s. */
  restartWaitMs?: number;
  /** Runs wsl.exe for the last-resort restart (the composition root passes deps.proc). */
  proc?: ProcessRunner;
  /** wsl.exe as an argv prefix (tests: a fake). */
  wsl?: string[];
}

/** Error code the UI maps to a "what to do" action for a non-running docker state. */
export function codeForState(state: DockerState): ErrorCode | undefined {
  switch (state) {
    case 'running':
      return undefined;
    case 'not-installed':
      return 'DOCKER_NOT_INSTALLED';
    case 'no-permission':
      return 'DOCKER_PERMISSION';
    case 'no-gpu':
      return 'DOCKER_NO_GPU';
    case 'unsupported':
      return 'DOCKER_UNSUPPORTED';
    case 'not-responding':
      return 'DOCKER_NOT_RESPONDING';
    default:
      return 'DOCKER_NOT_RUNNING';
  }
}

/** Launches a program detached from us (it must outlive the core) and returns once it was spawned. */
export function defaultLaunchDetached(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/** Docker Desktop executables, per-machine install first (both layouts exist in the wild). */
export function desktopExecutables(env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  const pf = envValue(env, 'ProgramFiles', 'win32');
  const local = envValue(env, 'LOCALAPPDATA', 'win32');
  if (pf) out.push(path.win32.join(pf, 'Docker', 'Docker', 'Docker Desktop.exe'));
  if (local) out.push(path.win32.join(local, 'Programs', 'DockerDesktop', 'Docker Desktop.exe'));
  return out;
}

/** Docker's own WSL machine: the only distribution the last-resort restart ever stops (never `wsl --shutdown`). */
export const DOCKER_WSL_DISTRO = 'docker-desktop';

const UP: ReadonlySet<DockerState> = new Set(['running', 'no-gpu', 'unsupported']);

/** Docker Desktop's own engine status, last asked. */
interface DesktopSeen {
  at: number;
  /** No Docker Desktop CLI plugin: never asked again. */
  missing: boolean;
  status?: string;
  /** Since when it has said "stopping" or not answered itself. */
  stuckSince?: number;
}

/**
 * Docker state machine: not installed → stopped ([Start Docker Desktop]) → starting → running
 * → no GPU (guide) / Podman or Windows containers (unsupported in v1), and "not responding"
 * ([Restart Docker]) when Docker Desktop is up but its engine does not answer. Detection goes through
 * the docker CLI, which follows the same context/DOCKER_HOST rules as the user's terminal. On Windows
 * Docker Desktop's own status says what `docker version` cannot: its API cache answers `version` and
 * `_ping` even while the engine behind it is stuck stopping.
 */
export class DockerEnvironment {
  private cached: { at: number; value: DockerStatusDetail } | undefined;
  private inflight: Promise<DockerStatusDetail> | undefined;
  private starting: { since: number; promise: Promise<DockerStatusDetail> } | undefined;
  private restarting: { since: number; promise: Promise<DockerStatusDetail> } | undefined;
  private gpu: { ok: boolean; image: string; detail?: string } | undefined;
  /** Docker stopped answering: since when, how we know. */
  private hang: { since: number; reason: DockerHangReason; detail?: string } | undefined;
  /** `docker version` calls in a row that timed out. */
  private versionMisses = 0;
  /** "Starting" seen without LLM Bench having started it. */
  private startingSince: number | undefined;
  /** What the daemon said last time (a start that timed out still "starting" is a stuck engine). */
  private daemon: 'starting' | 'stopped' | undefined;
  private desktop: DesktopSeen | undefined;
  private desktopInflight: Promise<void> | undefined;
  private lastState: DockerState | undefined;
  /** The last state worked out (peek()). */
  private last: DockerStatusDetail | undefined;
  private readonly listeners = new Set<(s: DockerStatusDetail) => void>();
  private readonly exists: (p: string) => Promise<boolean>;
  private readonly launch: (cmd: string, args: string[]) => Promise<void>;

  constructor(private readonly o: DockerEnvironmentOptions) {
    this.exists =
      o.exists ??
      ((p) =>
        fs.access(p).then(
          () => true,
          () => false,
        ));
    this.launch = o.launchDetached ?? defaultLaunchDetached;
  }

  get cli(): DockerCli {
    return this.o.cli;
  }

  get platform(): Platform {
    return this.o.platform;
  }

  async status(opts: { fresh?: boolean } = {}): Promise<DockerStatusDetail> {
    const now = this.o.clock.now();
    if (!opts.fresh && this.cached && now - this.cached.at < (this.o.statusMaxAgeMs ?? 2000)) return this.cached.value;
    this.inflight ??= this.compute().finally(() => {
      this.inflight = undefined;
    });
    const value = await this.inflight;
    this.publish(now, value);
    return value;
  }

  /** The last state worked out, without asking Docker (the tray); kept when the cache is dropped. */
  peek(): DockerStatusDetail | undefined {
    return this.last;
  }

  /** Called whenever the state changes (it stopped answering, came back…). Returns the unsubscribe. */
  onChange(fn: (s: DockerStatusDetail) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** A start or a restart LLM Bench asked for is under way. */
  busy(): 'starting' | 'restarting' | undefined {
    return this.restarting ? 'restarting' : this.starting ? 'starting' : undefined;
  }

  /** SystemResponse['docker'] for the system service (`dockerStatus` option). */
  async dockerStatus(): Promise<{ state: DockerState; version?: string }> {
    const s = await this.status();
    return s.version !== undefined ? { state: s.state, version: s.version } : { state: s.state };
  }

  private publish(at: number, value: DockerStatusDetail): void {
    this.cached = { at, value };
    this.last = value;
    if (value.state === this.lastState) return;
    this.lastState = value.state;
    for (const fn of this.listeners) fn(value);
  }

  private stuck(base: DockerStatusDetail, hang: NonNullable<DockerEnvironment['hang']>): DockerStatusDetail {
    return { ...base, state: 'not-responding', reason: hang.reason, stuckForMs: this.o.clock.now() - hang.since, ...(hang.detail ? { detail: hang.detail } : {}) };
  }

  /** Marks Docker as not responding (the first reason and time are kept) and says so at once. */
  private markHang(reason: DockerHangReason, detail?: string): void {
    // Our own start or restart is the moment Docker may be slow on purpose.
    if (this.restarting || this.starting) return;
    if (!this.hang) {
      this.hang = { since: this.o.clock.now(), reason, ...(detail ? { detail: detail.slice(-1000) } : {}) };
      this.o.log?.warn('docker does not answer', { reason, ...(detail ? { detail: detail.slice(0, 300) } : {}) });
    }
    const last = this.last;
    if (last && last.state !== 'not-responding') this.publish(this.o.clock.now(), this.stuck(last, this.hang));
  }

  private clearHang(...reasons: DockerHangReason[]): void {
    if (this.hang && (reasons.length === 0 || reasons.includes(this.hang.reason))) {
      this.hang = undefined;
      this.cached = undefined;
    }
  }

  /**
   * A Docker call LLM Bench made got no answer (it timed out, or Docker Desktop's proxy gave up):
   * Docker counts as not responding until a real call answers again or it is restarted.
   */
  readonly reportHang = (detail?: string): void => {
    this.markHang('calls-failing', detail);
  };

  private async compute(): Promise<DockerStatusDetail> {
    const v = await this.o.cli.version(this.o.versionTimeoutMs ?? 10_000);
    const now = this.o.clock.now();
    if (v.timedOut) {
      this.versionMisses++;
      // One slow answer can be a busy PC; two in a row is an engine that hangs.
      if (this.versionMisses >= 2) this.markHang('version-timeout', 'docker version did not answer');
      if (this.hang && !this.restarting) return this.stuck({ state: 'not-responding' }, this.hang);
      const prev = this.cached?.value;
      return { ...(prev ?? { state: 'unknown' }), reason: 'slow-answer' };
    }
    this.versionMisses = 0;
    this.clearHang('version-timeout');
    const text = `${v.stdout}\n${v.stderr}`;
    // In WSL the Windows shim answers (exit 0!) with a hint instead of a version.
    if (WSL_SHIM.test(text)) return { state: 'not-installed', reason: 'wsl-integration', detail: text.trim() };
    const base: DockerStatusDetail = { state: 'unknown' };
    if (v.client) {
      base.clientVersion = v.client.version;
      base.version = v.client.version;
      if (v.client.context !== undefined) base.context = v.client.context;
    }
    if (this.restarting) base.restarting = true;
    if (v.server) {
      base.serverVersion = v.server.version;
      base.version = v.server.version;
      if (v.server.platform !== undefined) base.platform = v.server.platform;
      if (v.server.podman) return { ...base, state: 'unsupported', reason: 'podman' };
      if (v.server.os === 'windows') return { ...base, state: 'unsupported', reason: 'windows-containers' };
      this.daemon = undefined;
      this.startingSince = undefined;
      // The engine answers: a start that looked endless is over.
      this.clearHang('start-timeout', 'starting-too-long');
      if (/docker desktop/i.test(v.server.platform ?? '')) void this.refreshDesktop();
      if (this.hang) return this.stuck(base, this.hang);
      if (this.gpu && !this.gpu.ok) {
        return { ...base, state: 'no-gpu', reason: 'gpu-check-failed', ...(this.gpu.detail ? { detail: this.gpu.detail } : {}) };
      }
      return { ...base, state: 'running' };
    }
    const err = classifyDockerError(v);
    // classifyDockerError always sets the detail (the CLI output).
    const detail = (err.detail as string).slice(-1000);
    if (err.code === 'DOCKER_NOT_INSTALLED') {
      this.clearHang();
      return { ...base, state: 'not-installed', detail };
    }
    if (err.code === 'DOCKER_PERMISSION') return { ...base, state: 'no-permission', detail };
    const ours = this.starting !== undefined || this.restarting !== undefined;
    if (err.code === 'DOCKER_NOT_RESPONDING') this.markHang('calls-failing', detail);
    if (err.code === 'DOCKER_NOT_RUNNING' || err.code === 'DOCKER_NOT_RESPONDING') {
      this.daemon = err.params?.reason === 'stopped' ? 'stopped' : 'starting';
      if (this.daemon === 'stopped' && !ours) {
        // Docker Desktop is closed: nothing is stuck any more, it is simply off.
        this.clearHang();
        this.startingSince = undefined;
      }
      if (this.daemon === 'starting' && !ours) {
        this.startingSince ??= now;
        if (now - this.startingSince > (this.o.stuckStartingMs ?? 240_000)) this.markHang('starting-too-long', detail);
      }
      if (this.hang && !ours) return this.stuck({ ...base, detail }, this.hang);
      const out: DockerStatusDetail = { ...base, state: this.daemon === 'starting' || ours ? 'starting' : 'stopped', detail };
      const since = this.starting?.since ?? this.restarting?.since;
      if (since !== undefined) out.startingForMs = now - since;
      return out;
    }
    return { ...base, detail };
  }

  /**
   * Docker Desktop's own engine status (Windows), asked in the background at most every
   * desktopStatusEveryMs (now when `force`). "Stopping" — or no answer from Docker Desktop itself —
   * for stuckStoppingMs makes Docker "not-responding"; anything else clears that.
   */
  private refreshDesktop(force = false): Promise<void> {
    const now = this.o.clock.now();
    const seen = this.desktop;
    if (this.o.platform !== 'win32' || seen?.missing) return Promise.resolve();
    if (!force && seen && now - seen.at < (this.o.desktopStatusEveryMs ?? 60_000)) return Promise.resolve();
    this.desktopInflight ??= this.o.cli
      .desktopStatus(this.o.desktopStatusTimeoutMs ?? 10_000)
      .then(
        (d) => this.noteDesktop(d),
        (e: unknown) => this.o.log?.warn('docker desktop status failed', { error: String(e) }),
      )
      .finally(() => {
        this.desktopInflight = undefined;
      });
    return this.desktopInflight;
  }

  private noteDesktop(d: DesktopStatus): void {
    const now = this.o.clock.now();
    const stuckish = d.timedOut || d.status === 'stopping';
    const since = stuckish ? (this.desktop?.stuckSince ?? now) : undefined;
    this.desktop = { at: now, missing: d.missing, ...(d.status !== undefined ? { status: d.status } : {}), ...(since !== undefined ? { stuckSince: since } : {}) };
    if (since === undefined) this.clearHang('desktop-stuck');
    else if (now - since >= (this.o.stuckStoppingMs ?? 20_000)) {
      this.markHang('desktop-stuck', d.timedOut ? 'docker desktop status did not answer' : 'Docker Desktop: engine stopping');
    }
  }

  /**
   * A real check before Docker is used (the start flow, the watchdog): a fresh status; on Docker
   * Desktop its own engine status (a "stopping" is waited out until it counts as stuck); then a
   * call the engine itself must answer (`docker ps`).
   */
  async probe(signal?: AbortSignal): Promise<DockerStatusDetail> {
    const s = await this.status({ fresh: true });
    const up = UP.has(s.state) || (s.state === 'not-responding' && s.reason !== 'version-timeout');
    if (!up || s.state === 'unsupported' || this.busy()) return s;
    if (/docker desktop/i.test(s.platform ?? '')) {
      await this.refreshDesktop(true);
      const since = this.desktop?.stuckSince;
      if (since !== undefined && !this.hang) {
        const wait = (this.o.stuckStoppingMs ?? 20_000) - (this.o.clock.now() - since);
        await this.o.clock.sleep(Math.max(0, wait), signal).catch(() => undefined);
        await this.refreshDesktop(true);
      }
    }
    const ps = await this.o.cli.exec(['ps', '-q', '--filter', `label=${GPUBENCH_LABEL}=1`], {
      timeoutMs: this.o.probeTimeoutMs ?? 10_000,
      ...(signal ? { signal } : {}),
    });
    if (isEngineHang(ps)) this.markHang('calls-failing', `${ps.stderr}${ps.timedOut ? ' (docker ps did not answer)' : ''}`);
    else if (ps.code === 0) this.clearHang('calls-failing');
    return this.status({ fresh: true });
  }

  /**
   * Windows: starts Docker Desktop (`docker desktop start --detach`, Docker Desktop ≥ 4.37;
   * otherwise its executable) and waits until the engine answers. Concurrent calls share one start.
   * Linux has no desktop to start: the engine is a system service (DOCKER_NOT_RUNNING, reason manual-start).
   */
  startDesktop(signal: AbortSignal, onProgress?: (p: StartProgress) => void): Promise<DockerStatusDetail> {
    if (this.restarting) return this.restarting.promise;
    if (this.starting) return this.starting.promise;
    const since = this.o.clock.now();
    const promise = this.doStart(since, signal, onProgress).finally(() => {
      this.starting = undefined;
      this.cached = undefined;
    });
    this.starting = { since, promise };
    return promise;
  }

  private async doStart(since: number, signal: AbortSignal, onProgress?: (p: StartProgress) => void): Promise<DockerStatusDetail> {
    // The status cache must not hide the transition we are about to cause.
    const first = await this.status({ fresh: true });
    if (UP.has(first.state)) return first;
    this.refuse(first);
    if (first.state === 'not-responding') {
      throw new AppError('DOCKER_NOT_RESPONDING', 'Docker is open but does not answer: restart it', { params: { reason: 'use-restart' } });
    }
    if (this.o.platform !== 'win32') {
      throw new AppError('DOCKER_NOT_RUNNING', 'Start the Docker service manually', {
        params: { reason: 'manual-start', platform: this.o.platform },
      });
    }
    const method = await this.launchDesktop(signal);
    const timeoutMs = this.o.startTimeoutMs ?? 180_000;
    const slowMs = this.o.slowStartMs ?? 60_000;
    for (;;) {
      if (signal.aborted) throw new AppError('CANCELLED', 'Docker Desktop start cancelled');
      const s = await this.status({ fresh: true });
      const elapsedMs = this.o.clock.now() - since;
      onProgress?.({ state: s.state, elapsedMs, slow: elapsedMs > slowMs, method });
      if (UP.has(s.state)) return s;
      if (elapsedMs > timeoutMs) {
        const extra = s.detail ? { detail: s.detail } : {};
        if (this.daemon === 'starting') {
          // Docker Desktop is up but its engine never got ready: only a restart helps.
          this.starting = undefined;
          this.markHang('start-timeout', s.detail);
          throw new AppError('DOCKER_NOT_RESPONDING', 'Docker Desktop started but its engine never answered', { params: { reason: 'start-timeout', timeoutMs }, ...extra });
        }
        throw new AppError('DOCKER_NOT_RUNNING', 'Docker Desktop did not start in time', { params: { reason: 'start-timeout', timeoutMs }, ...extra });
      }
      await this.o.clock.sleep(this.o.startPollMs ?? 2000, signal).catch(() => undefined);
    }
  }

  /** States no start or restart can fix. */
  private refuse(s: DockerStatusDetail): void {
    if (s.state === 'not-installed') {
      throw new AppError('DOCKER_NOT_INSTALLED', 'Docker is not installed', { params: { reason: s.reason ?? 'missing' } });
    }
    if (s.state === 'no-permission') throw new AppError('DOCKER_PERMISSION', 'No permission to use Docker');
  }

  private async launchDesktop(signal: AbortSignal): Promise<'cli' | 'exe'> {
    const out = await this.o.cli.exec(['desktop', 'start', '--detach'], { timeoutMs: 60_000, signal });
    if (out.code === 0) return 'cli';
    if (!NO_DESKTOP_PLUGIN.test(`${out.stderr}\n${out.stdout}`)) {
      this.o.log?.warn('docker desktop start failed, launching the executable', { stderr: out.stderr.slice(0, 500) });
    }
    return (await this.launchExe()) ? 'exe' : this.notFound();
  }

  /** Runs Docker Desktop's executable (when it already runs, that brings up its window). False when it is not there. */
  private async launchExe(): Promise<boolean> {
    for (const exe of desktopExecutables(this.o.env)) {
      if (await this.exists(exe)) {
        await this.launch(exe, []);
        return true;
      }
    }
    return false;
  }

  private notFound(): never {
    throw new AppError('DOCKER_NOT_INSTALLED', 'Docker Desktop was not found', { params: { reason: 'desktop-not-found' } });
  }

  /** "Apri Docker Desktop": brings up its window (its settings are there). Windows only. */
  async openDesktop(): Promise<void> {
    if (this.o.platform !== 'win32') throw new AppError('DOCKER_UNSUPPORTED', 'Docker Desktop is opened from here on Windows only', { params: { reason: 'not-windows' } });
    if (!(await this.launchExe())) this.notFound();
  }

  /**
   * "Riavvia Docker" (Windows): Docker Desktop's own restart; if Docker does not answer after it, a
   * forced stop and a start. `deep` (only after the user's click): forced stop, then Docker's own WSL
   * machine stopped (`wsl --terminate docker-desktop`, never `wsl --shutdown`: the user's other
   * distributions keep running), then a start. Images, volumes and containers are kept by Docker
   * itself. Concurrent calls share one restart; a start asked meanwhile waits for it.
   */
  restartDesktop(signal: AbortSignal, onProgress?: (p: RestartProgress) => void, opts: { deep?: boolean } = {}): Promise<DockerStatusDetail> {
    if (this.restarting) return this.restarting.promise;
    const since = this.o.clock.now();
    const promise = this.doRestart(since, signal, opts.deep === true, onProgress).finally(() => {
      this.restarting = undefined;
      this.cached = undefined;
    });
    this.restarting = { since, promise };
    return promise;
  }

  private async doRestart(since: number, signal: AbortSignal, deep: boolean, onProgress?: (p: RestartProgress) => void): Promise<DockerStatusDetail> {
    const first = await this.status({ fresh: true });
    this.refuse(first);
    if (this.o.platform !== 'win32') {
      throw new AppError('DOCKER_NOT_RESPONDING', 'Restart the Docker service manually', { params: { reason: 'manual-restart', platform: this.o.platform } });
    }
    // What we knew about the stuck engine is about to be out of date.
    this.hang = undefined;
    this.versionMisses = 0;
    this.startingSince = undefined;
    this.desktop = undefined;
    const steps: RestartProgress['step'][] = deep ? ['force-stop', 'wsl-terminate', 'start'] : ['restart', 'force-stop', 'start'];
    const slowMs = this.o.slowStartMs ?? 60_000;
    const report = (step: RestartProgress['step'], state: DockerState = 'starting') => {
      const elapsedMs = this.o.clock.now() - since;
      onProgress?.({ step, index: steps.indexOf(step) + 1, steps: steps.length, elapsedMs, state, slow: elapsedMs > slowMs });
    };
    const cmdMs = this.o.restartCommandTimeoutMs ?? 90_000;
    const desktopCli = async (args: string[]) => {
      const out = await this.o.cli.exec(['desktop', ...args], { timeoutMs: cmdMs, signal });
      if (signal.aborted) throw new AppError('CANCELLED', 'Docker restart cancelled');
      if (NO_DESKTOP_PLUGIN.test(`${out.stderr}\n${out.stdout}`)) {
        throw new AppError('DOCKER_NOT_RESPONDING', 'Docker Desktop cannot be restarted from here', { params: { reason: 'no-desktop-cli' } });
      }
      if (out.code !== 0) this.o.log?.warn(`docker desktop ${args[0] as string} failed`, { code: out.code, timedOut: out.timedOut, stderr: out.stderr.slice(0, 300) });
      return out.code === 0;
    };
    if (!deep) {
      report('restart');
      if (await desktopCli(['restart'])) {
        const s = await this.waitUp('restart', report, signal);
        if (s) return s;
      }
    }
    report('force-stop');
    await desktopCli(['stop', '--force']);
    if (deep) {
      report('wsl-terminate');
      await this.terminateDockerWsl(signal);
    }
    report('start');
    await this.launchDesktop(signal);
    const s = await this.waitUp('start', report, signal);
    if (s) return s;
    throw new AppError('DOCKER_NOT_RESPONDING', 'Docker did not come back after the restart', { params: { reason: deep ? 'restart-failed' : 'needs-deep' } });
  }

  /**
   * Polls until Docker answers again, for restartWaitMs: its status, or undefined. On Docker Desktop
   * its own status must agree (its API cache can answer for an engine that is not there yet).
   */
  private async waitUp(step: RestartProgress['step'], report: (step: RestartProgress['step'], state?: DockerState) => void, signal: AbortSignal): Promise<DockerStatusDetail | undefined> {
    const until = this.o.clock.now() + (this.o.restartWaitMs ?? 120_000);
    for (;;) {
      if (signal.aborted) throw new AppError('CANCELLED', 'Docker restart cancelled');
      const s = await this.status({ fresh: true });
      let up = UP.has(s.state);
      if (up && /docker desktop/i.test(s.platform ?? '')) {
        await this.refreshDesktop(true);
        const d = this.desktop;
        up = !(d?.stuckSince !== undefined || d?.status === 'starting');
      }
      report(step, up ? s.state : 'starting');
      if (up) return s;
      if (this.o.clock.now() >= until) return undefined;
      await this.o.clock.sleep(this.o.startPollMs ?? 2000, signal).catch(() => undefined);
    }
  }

  /** `wsl --terminate docker-desktop`: only Docker's own machine. A failure is logged; the start comes next anyway. */
  private async terminateDockerWsl(signal: AbortSignal): Promise<void> {
    const proc = this.o.proc;
    if (!proc) return;
    const [cmd, ...pre] = (this.o.wsl ?? ['wsl.exe']) as [string, ...string[]];
    const out = await proc.run(cmd, [...pre, '--terminate', DOCKER_WSL_DISTRO], { timeoutMs: 60_000, signal });
    if (signal.aborted) throw new AppError('CANCELLED', 'Docker restart cancelled');
    if (out.code !== 0) this.o.log?.warn('wsl --terminate docker-desktop failed', { code: out.code, stderr: out.stderr.slice(0, 300) });
  }

  /**
   * Runs nvidia-smi -L inside `image` with --gpus all. `--pull never`: a GPU check must never
   * start a multi-GB download. The outcome is remembered and reflected by status().
   */
  async gpuCheck(image: string, signal?: AbortSignal): Promise<GpuCheckResult> {
    const out = await this.o.cli.exec(['run', '--rm', '--pull', 'never', '--gpus', 'all', '--entrypoint', 'nvidia-smi', image, '-L'], {
      timeoutMs: this.o.gpuCheckTimeoutMs ?? 180_000,
      ...(signal ? { signal } : {}),
    });
    const gpus = out.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^GPU \d+:/.test(l));
    if (out.code === 0 && gpus.length > 0) {
      this.gpu = { ok: true, image };
      this.cached = undefined;
      return { image, gpus };
    }
    const err = out.code === 0 ? new AppError('DOCKER_NO_GPU', 'No GPU visible inside the container', { detail: out.stdout.slice(-2000) }) : classifyDockerError(out, 'DOCKER_NO_GPU');
    if (err.code === 'DOCKER_NO_GPU' || err.code === 'DRIVER_TOO_OLD') this.noteGpuFailure(image, err.detail);
    throw err;
  }

  /** A `docker run --gpus all` failed for lack of GPU support: status() reports "no-gpu" until a check succeeds. */
  noteGpuFailure(image: string, detail?: string): void {
    this.gpu = { ok: false, image, ...(detail ? { detail } : {}) };
    this.cached = undefined;
  }

  /**
   * Removes our leftover containers: label gpubench=1, a marker, and not one of `keep` (markers
   * of runs in progress). Containers without our label are never touched.
   */
  async cleanupOrphans(keep: Iterable<string> = []): Promise<{ removed: { id: string; name: string }[] }> {
    const keepSet = new Set(keep);
    const rows = await this.o.cli.ps([`${GPUBENCH_LABEL}=1`]);
    const removed: { id: string; name: string }[] = [];
    for (const r of rows) {
      const marker = r.labels['gpubench.marker'];
      if (!isOurs(r.labels) || marker === undefined || keepSet.has(marker)) continue;
      try {
        await this.o.cli.rm(r.id, true);
        removed.push({ id: r.id, name: r.name });
      } catch (e) {
        this.o.log?.warn('orphan container removal failed', { id: r.id, error: isAppError(e) ? e.code : String(e) });
      }
    }
    return { removed };
  }
}

/**
 * ContainerOwnership for the process registry: a record is ours only if the container still
 * carries our label and the same marker; stop() stops and removes exactly that container.
 */
export function containerOwnership(cli: DockerCli): ContainerOwnership {
  const target = (rec: OwnedRecord) => rec.containerId ?? `gpubench-${rec.marker}`;
  return {
    async verify(rec) {
      const info = await cli.inspect(target(rec)).catch(() => undefined);
      return info !== undefined && isOurs(info.labels, rec.marker);
    },
    async stop(rec) {
      await cli.stop(target(rec), 10).catch(() => undefined);
      await cli.rm(target(rec), true);
    },
  };
}
