import { AppError, isAppError } from '../../contract/errors';
import type { Clock, ExitInfo, LogLine, Logger, ManagedProcess, ProcessRunner } from '../deps';
import { createProcessInstance } from '../engines/instance';
import type { EngineInstance, LaunchPlan, PhaseMark } from '../engines/types';
import { ignore } from '../engines/util';
import type { InferenceClient } from '../inference/types';
import { AsyncQueue } from '../process/runner';
import { classifyDockerError, GPUBENCH_LABEL, isEngineHang, isOurs, MARKER_LABEL, parseTimestampedLine, type DockerCli } from './cli';

export const CONTAINER_PREFIX = 'gpubench-';

export function containerName(marker: string): string {
  return marker.startsWith(CONTAINER_PREFIX) ? marker : `${CONTAINER_PREFIX}${marker}`;
}

export interface DockerRunSpec {
  /** argv prefix of the docker CLI (DockerCli.command()). */
  docker: string[];
  marker: string;
  hostPort: number;
  containerPort: number;
  /** -v specs, e.g. "C:\models\x:/models:ro", "gpubench-hf-cache:/root/.cache/huggingface". */
  volumes: string[];
  /** Variables passed by name only (`-e NAME`): values live in the docker CLI's environment, never in argv. */
  envNames: string[];
  extraRunFlags?: string[];
  image: string;
  /** Arguments after the image (the engine's own command line). */
  args: string[];
}

/**
 * `docker run -d` argv. Every container carries gpubench=1 and its marker, is named after the
 * marker, and publishes its port on 127.0.0.1 only.
 */
export function dockerRunArgv(s: DockerRunSpec): string[] {
  const argv = [
    ...s.docker,
    'run',
    '-d',
    '--name',
    containerName(s.marker),
    '--label',
    `${GPUBENCH_LABEL}=1`,
    '--label',
    `${MARKER_LABEL}=${s.marker}`,
    '--gpus',
    'all',
    ...(s.extraRunFlags ?? []),
    '-p',
    `127.0.0.1:${s.hostPort}:${s.containerPort}`,
  ];
  for (const v of s.volumes) argv.push('-v', v);
  for (const n of [...new Set(s.envNames)].sort()) argv.push('-e', n);
  argv.push(s.image, ...s.args);
  return argv;
}

/** EngineInstance of a container: adds its id and the start overhead (container start → first log line). */
export interface DockerEngineInstance extends EngineInstance {
  containerId: string;
  containerName: string;
  /** ms from t0 (just before `docker run`) to the container's first log line; undefined before it. */
  containerOverheadMs(): number | undefined;
}

export interface StartContainerOptions {
  cli: DockerCli;
  proc: ProcessRunner;
  clock: Clock;
  log: Logger;
  plan: LaunchPlan;
  /** Real values of secret variables whose plan.env value is a placeholder (HF_TOKEN). */
  secretEnv?: Record<string, string>;
  client: InferenceClient;
  probe(signal: AbortSignal): Promise<boolean>;
  phaseOf(text: string): string | undefined;
  diagnose(lines: readonly string[], exit: ExitInfo): AppError;
  signal: AbortSignal;
  pollMs?: number;
  readyTimeoutMs?: number;
  /** `docker stop -t` grace (s). */
  stopTimeoutSec?: number;
  /** Called when `docker run` failed for lack of GPU support (DockerEnvironment.noteGpuFailure). */
  onNoGpu?(detail?: string): void;
  /** Called when `docker run` got no answer from Docker (DockerEnvironment.reportHang). */
  onHang?(detail?: string): void;
  /** `docker run -d` timeout: creating a GPU container takes seconds, but Desktop can be slow. */
  runTimeoutMs?: number;
  /** Upper bound of the post-ready wait for late log lines (default 1 s; does not change tReady). */
  logCatchUpMs?: number;
  /**
   * While the engine prints nothing new, readiness is probed at most this often (default: 500 ms with
   * Docker Desktop, 0 on Linux). See throttledProbe.
   */
  idleProbeMs?: number;
}

/**
 * Readiness probes through Docker Desktop's port forwarder: every probe of a port the engine does
 * not listen on yet is a refused connection its forwarder retries and logs (about 17 a second at
 * the 50 ms poll: Docker Desktop's logs rotated every 3 minutes during a vLLM load). While the
 * engine prints nothing new a probe goes out at most every `idleMs`; any new log line ("Uvicorn
 * running…", "server is listening…") lets the next one through at once, so the time to ready stays
 * as precise as before.
 */
export function throttledProbe(probe: (signal: AbortSignal) => Promise<boolean>, now: () => number, idleMs: number): { probe: (signal: AbortSignal) => Promise<boolean>; line: () => void } {
  let fresh = true;
  let last = Number.NEGATIVE_INFINITY;
  return {
    probe: (signal) => {
      const t = now();
      if (!fresh && t - last < idleMs) return Promise.resolve(false);
      fresh = false;
      last = t;
      return probe(signal);
    },
    line: () => {
      fresh = true;
    },
  };
}

const LOG_MIN_WAIT_MS = 150;
const LOG_QUIET_MS = 200;
const LOG_POLL_MS = 25;

/** Read time (our clock) and daemon timestamp of a log line. */
interface Stamp {
  t: number;
  ts?: number;
}

/**
 * Starts a container from `plan.argv` exactly as recorded, follows its log with daemon
 * timestamps, and wraps it as an EngineInstance (shared readiness/diagnosis loop).
 * t0 is taken right before `docker run`, so container creation counts as load time; the image
 * must already be present (pull time never counts).
 */
export async function startContainer(o: StartContainerOptions): Promise<DockerEngineInstance> {
  const { plan, clock, cli } = o;
  if (o.signal.aborted) throw new AppError('CANCELLED', 'Engine start cancelled');
  const name = containerName(plan.marker);
  const [cmd, ...args] = plan.argv as [string, ...string[]];
  const t0 = clock.now();
  const run = await o.proc.run(cmd, args, {
    env: { ...plan.env, ...o.secretEnv },
    timeoutMs: o.runTimeoutMs ?? 180_000,
    signal: o.signal,
  });
  const id = (run.stdout.trim().split(/\r?\n/).pop() as string).trim();
  if (run.code !== 0 || !/^[0-9a-f]{12,64}$/.test(id)) {
    if (!o.signal.aborted && isEngineHang(run)) {
      // Docker does not answer: nothing to clean up now (that would hang too); the restart takes care of it.
      o.onHang?.(`${run.stderr}${run.timedOut ? ' (docker run did not answer)' : ''}`);
      throw new AppError('DOCKER_NOT_RESPONDING', 'Docker did not answer docker run', { params: { reason: run.timedOut ? 'timeout' : 'deadline' }, detail: run.stderr.slice(-2000) });
    }
    // A failed `docker run` can leave a "Created" container behind: it is ours (name + label).
    await removeIfOurs(cli, name, plan.marker);
    if (o.signal.aborted) throw new AppError('CANCELLED', 'Engine start cancelled');
    const err = classifyDockerError(run, 'ENGINE_START_FAILED');
    if (err.code === 'DOCKER_NO_GPU') o.onNoGpu?.(err.detail);
    throw err;
  }
  let logs: ManagedProcess;
  try {
    logs = await cli.followLogs(id, { runId: plan.marker, marker: plan.marker });
  } catch (e) {
    await stopOwned(cli, id, plan.marker, o.stopTimeoutSec ?? 10, o.log);
    throw new AppError('ENGINE_START_FAILED', `Cannot follow the container log: ${String(e)}`, { cause: e });
  }

  // Daemon timestamps are mapped onto our monotonic clock with the smallest delivery delay seen
  // (our read time − daemon time, minimised over all lines, NTP style): immune to a skewed VM
  // clock (WSL2 after sleep) and to `docker logs` lag. Phase marks keep their raw timestamp and
  // are mapped with the final estimate, because a line printed before "ready" may arrive after it.
  let minOffset = Number.POSITIVE_INFINITY;
  const at = (s: Stamp): number => (s.ts === undefined ? s.t : Math.max(t0, s.ts + minOffset));
  const marks: (Stamp & { name: string })[] = [];
  const seen = new Set<string>();
  let first: Stamp | undefined;
  let last: Stamp | undefined;
  let lastArrival = clock.now();
  let ended = false;
  let wake: (() => void) | undefined;
  const lines = new AsyncQueue<LogLine>();
  // Docker Desktop (Windows, macOS) forwards the published port through its VM: see throttledProbe.
  const ready = throttledProbe(o.probe, () => clock.now(), o.idleProbeMs ?? (cli.platform === 'linux' ? 0 : 500));
  void (async () => {
    for await (const l of logs.lines) {
      ready.line();
      const p = parseTimestampedLine(l.text);
      const s: Stamp = p.tsMs === undefined ? { t: l.t } : { t: l.t, ts: p.tsMs };
      if (p.tsMs !== undefined) minOffset = Math.min(minOffset, l.t - p.tsMs);
      first ??= s;
      last = s;
      lastArrival = clock.now();
      const phase = o.phaseOf(p.text);
      if (phase !== undefined && !seen.has(phase)) {
        seen.add(phase);
        marks.push({ name: phase, ...s });
      }
      lines.push({ t: at(s), stream: l.stream, text: p.text });
      wake?.();
    }
    ended = true;
    lines.close();
    wake?.();
  })();

  /** Lets the log follower deliver what the engine printed before it became ready (bounded; tReady is unaffected). */
  const catchUp = async (tReady: number): Promise<void> => {
    const start = clock.now();
    const max = o.logCatchUpMs ?? 1000;
    const pending = () => {
      const now = clock.now();
      const stillComing = now - start < LOG_MIN_WAIT_MS || now - lastArrival < LOG_QUIET_MS;
      return !ended && (last === undefined || at(last) < tReady) && now - start < max && stillComing;
    };
    while (pending()) {
      await Promise.race([new Promise<void>((r) => (wake = r)), clock.sleep(LOG_POLL_MS).catch(ignore)]);
    }
  };

  let oomKilled = false;
  const exited = logs.exited.then(async (): Promise<ExitInfo> => {
    const info = await cli.inspect(id).catch(ignore);
    oomKilled = info?.oomKilled === true;
    return { code: info && !info.running ? (info.exitCode ?? null) : null, signal: null };
  });

  const mp: ManagedProcess = {
    pid: logs.pid,
    startedAt: t0,
    lines,
    exited,
    stop: async () => {
      await stopOwned(cli, id, plan.marker, o.stopTimeoutSec ?? 10, o.log);
      // The follower ends with the container; stopping it guarantees `exited` settles.
      await logs.stop().catch(ignore);
      return exited;
    },
  };

  const inner = createProcessInstance({
    mp,
    baseUrl: `http://${plan.host}:${plan.port}`,
    client: o.client,
    clock,
    probe: ready.probe,
    phaseOf: () => undefined,
    diagnose: (tail, exit) =>
      oomKilled
        ? new AppError('ENGINE_OOM', 'The container ran out of system memory', {
            params: { code: String(exit.code), where: 'host' },
            detail: tail.slice(-25).join('\n'),
          })
        : o.diagnose(tail, exit),
    startSignal: o.signal,
    ...(o.pollMs !== undefined ? { pollMs: o.pollMs } : {}),
    ...(o.readyTimeoutMs !== undefined ? { readyTimeoutMs: o.readyTimeoutMs } : {}),
  });

  return {
    ...inner,
    t0,
    async waitReady(signal) {
      const r = await inner.waitReady(signal);
      await catchUp(r.tReady);
      const named = marks.map((m) => ({ name: m.name, t: at(m) })).filter((m) => m.t <= r.tReady);
      const phases: PhaseMark[] = [{ name: 'container', t: t0 }];
      // The first log line ends the container phase (unless it is itself a named phase).
      const firstT = first === undefined ? undefined : at(first);
      if (firstT !== undefined && !named.some((p) => p.t <= firstT)) phases.push({ name: 'engine_start', t: firstT });
      return { tReady: r.tReady, phases: [...phases, ...named] };
    },
    containerId: id,
    containerName: name,
    containerOverheadMs: () => (first === undefined ? undefined : at(first) - t0),
  };
}

/** Stops and removes a container, but only after checking it carries our label and marker. */
export async function stopOwned(cli: DockerCli, id: string, marker: string, timeoutSec: number, log?: Logger): Promise<void> {
  const info = await cli.inspect(id).catch(ignore);
  if (!info) return;
  if (!isOurs(info.labels, marker)) {
    log?.warn('refusing to stop a container that is not ours', { id });
    return;
  }
  if (info.running) await cli.stop(id, timeoutSec).catch((e: unknown) => log?.warn('docker stop failed', { id, error: String(e) }));
  await cli.rm(id, true).catch((e: unknown) => log?.warn('docker rm failed', { id, error: isAppError(e) ? e.code : String(e) }));
}

async function removeIfOurs(cli: DockerCli, name: string, marker: string): Promise<void> {
  const info = await cli.inspect(name).catch(ignore);
  if (info && isOurs(info.labels, marker)) await cli.rm(name, true).catch(ignore);
}
