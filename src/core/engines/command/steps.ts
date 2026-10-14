/**
 * The commands of a program with an OpenAI API around its server (LaunchPlan.steps). The ones before
 * run in order as soon as it is started, each must end with exit code 0, then the server starts; the
 * ones after run in order once the server has stopped (asked to, or on its own), and also when a
 * command before failed (a clean-up of what the others did). Their output goes to the engine's log as
 * it comes, each line marked "[before 1/2]" / "[after 1/1]".
 *
 * A command before that fails, or does not end within its time limit, stops the start with an error
 * that names it (ENGINE_START_FAILED / ENGINE_TIMEOUT, params.reason 'step_failed' / 'step_timeout',
 * `which` and `n`; its last lines in the details). One after that fails is only written in the log:
 * the measurements are already done. Programs run without a shell, as argv arrays: a value is never
 * read by one.
 */
import path from 'node:path';
import { AppError } from '../../../contract/errors';
import type { CoreDeps, ExitInfo, LogLine, ManagedProcess } from '../../deps';
import type { InferenceClient } from '../../inference/types';
import { AsyncQueue } from '../../process/runner';
import type { CommandSteps, EngineInstance, LaunchPlan } from '../types';
import { ignore, timeoutSignal } from '../util';

/** The longest a command before the server may take (a download, an install), and one after it. */
export const BEFORE_STEP_TIMEOUT_MS = 30 * 60_000;
export const AFTER_STEP_TIMEOUT_MS = 5 * 60_000;
/** Lines of the commands' output kept for the log tail, before and after the server each. */
export const STEP_LOG_LINES = 300;
/** Lines of a failed command shown in the error's details. */
const DETAIL_LINES = 25;

export interface SteppedOptions {
  plan: LaunchPlan;
  steps: CommandSteps;
  /** Aborting it while the commands before run or the server loads stops everything (CANCELLED). */
  signal: AbortSignal;
  deps: Pick<CoreDeps, 'clock' | 'proc'>;
  /** Starts the server itself (after the commands before), with the signal that cancels its start. */
  startServer: (signal: AbortSignal) => Promise<EngineInstance>;
  /** The client used until the server is up (nothing is sent before it is ready). */
  idleClient: InferenceClient;
  beforeTimeoutMs?: number;
  afterTimeoutMs?: number;
}

type StepOutcome = { kind: 'exit'; exit: ExitInfo; lines: string[] } | { kind: 'timeout'; lines: string[] } | { kind: 'cancelled' };

/** An argv as one readable line (only for the log: it is never run as text). */
export function stepLine(argv: readonly string[]): string {
  return argv.map((a) => (a === '' || /[\s"']/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ');
}

/** Resolves when the signal aborts (at once when it already has). */
function whenAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}

/**
 * The engine instance of a server with commands around it: the commands before start at once, the
 * server when they all ended well; `t0` and `pid` are the server's once it started (its load time does
 * not count the commands before), `logs` and `logTail()` hold every command's lines and the server's.
 */
export function createSteppedInstance(o: SteppedOptions): EngineInstance {
  const { clock, proc } = o.deps;
  const logs = new AsyncQueue<LogLine>();
  const beforeTail: string[] = [];
  const afterTail: string[] = [];
  const emit = (tail: string[], text: string, stream: LogLine['stream']) => {
    tail.push(text);
    if (tail.length > STEP_LOG_LINES) tail.shift();
    logs.push({ t: clock.now(), stream, text });
  };
  const stopCtl = new AbortController();
  const cancel = AbortSignal.any([o.signal, stopCtl.signal]);
  const createdAt = clock.now();
  let server: EngineInstance | undefined;
  let serverLogs: Promise<void> = Promise.resolve();
  let resolveExit!: (e: ExitInfo) => void;
  const exited = new Promise<ExitInfo>((r) => (resolveExit = r));

  const runStep = async (argv: readonly string[], label: string, tail: string[], timeoutMs: number, signal?: AbortSignal): Promise<StepOutcome> => {
    emit(tail, `${label} ${stepLine(argv)}`, 'stdout');
    const [cmd, ...args] = argv as [string, ...string[]];
    const lines: string[] = [];
    let mp: ManagedProcess;
    try {
      mp = proc.spawn({ cmd, args, env: o.plan.env, owner: { runId: o.plan.marker, marker: o.plan.marker } });
    } catch (e) {
      const text = `Error: ${String(e)}`;
      lines.push(text);
      emit(tail, `${label} ${text}`, 'stderr');
      return { kind: 'exit', exit: { code: null, signal: null }, lines };
    }
    const pump = (async () => {
      for await (const l of mp.lines) {
        lines.push(l.text);
        emit(tail, `${label} ${l.text}`, l.stream);
      }
    })().catch(ignore);
    const limit = timeoutSignal(timeoutMs, signal);
    try {
      const first = await Promise.race([mp.exited, whenAborted(limit.signal).then(() => undefined)]);
      if (first !== undefined) {
        await Promise.race([pump, clock.sleep(500).catch(ignore)]);
        return { kind: 'exit', exit: first, lines };
      }
      await mp.stop();
      await Promise.race([pump, clock.sleep(500).catch(ignore)]);
      return signal?.aborted ? { kind: 'cancelled' } : { kind: 'timeout', lines };
    } finally {
      limit.clear();
    }
  };

  /** The commands after the server, once (whatever made it end): a failure is only written in the log. */
  let finishing: Promise<void> | undefined;
  const finish = (): Promise<void> => {
    finishing ??= (async () => {
      await Promise.race([serverLogs, clock.sleep(500).catch(ignore)]);
      const total = o.steps.after.length;
      for (let i = 0; i < total; i++) {
        const label = `[after ${i + 1}/${total}]`;
        const r = await runStep(o.steps.after[i] as string[], label, afterTail, o.afterTimeoutMs ?? AFTER_STEP_TIMEOUT_MS);
        if (r.kind === 'timeout') emit(afterTail, `${label} did not end in time: stopped`, 'stderr');
        else if (r.kind === 'exit' && r.exit.code !== 0) emit(afterTail, `${label} ended with ${String(r.exit.code ?? r.exit.signal)}`, 'stderr');
      }
      logs.close();
    })();
    return finishing;
  };

  const starting = (async (): Promise<EngineInstance> => {
    const total = o.steps.before.length;
    for (let i = 0; i < total; i++) {
      const argv = o.steps.before[i] as string[];
      const timeoutMs = o.beforeTimeoutMs ?? BEFORE_STEP_TIMEOUT_MS;
      const r = await runStep(argv, `[before ${i + 1}/${total}]`, beforeTail, timeoutMs, cancel);
      if (r.kind === 'cancelled') throw new AppError('CANCELLED', 'Engine start cancelled');
      const step = { which: 'before', n: i + 1, program: path.basename(argv[0] as string) };
      const detail = r.lines.slice(-DETAIL_LINES).join('\n');
      if (r.kind === 'timeout') {
        throw new AppError('ENGINE_TIMEOUT', `Command ${i + 1} before the server did not end in time`, { params: { ...step, reason: 'step_timeout', timeoutMs }, detail });
      }
      if (r.exit.code !== 0) {
        const code = String(r.exit.code ?? r.exit.signal);
        throw new AppError('ENGINE_START_FAILED', `Command ${i + 1} before the server ended with ${code}`, { params: { ...step, reason: 'step_failed', code }, detail });
      }
    }
    // Stopped between the last command and here: the server's own start says CANCELLED.
    const srv = await o.startServer(cancel);
    server = srv;
    serverLogs = (async () => {
      for await (const l of srv.logs) logs.push(l);
    })().catch(ignore);
    void srv.exited.then((e) => {
      resolveExit(e);
      return finish();
    });
    return srv;
  })();
  // A command before that failed: the instance has ended (the commands after still clean up).
  starting.catch(() => {
    resolveExit({ code: null, signal: null });
    void finish();
  });

  let stopping: Promise<ExitInfo> | undefined;
  const stop = (): Promise<ExitInfo> => {
    stopping ??= (async () => {
      // A command before still running is stopped and the server is not started.
      stopCtl.abort();
      const srv = await starting.catch(() => undefined);
      const exit = srv ? await srv.stop() : { code: null, signal: null };
      resolveExit(exit);
      await finish();
      return exit;
    })();
    return stopping;
  };

  return {
    baseUrl: `http://${o.plan.host}:${o.plan.port}`,
    get pid() {
      return server?.pid;
    },
    get t0() {
      return server?.t0 ?? createdAt;
    },
    logs,
    waitReady: async (signal) => {
      const abort = () => stopCtl.abort();
      signal?.addEventListener('abort', abort, { once: true });
      try {
        if (signal?.aborted) stopCtl.abort();
        const srv = await starting;
        return await srv.waitReady(signal);
      } finally {
        signal?.removeEventListener('abort', abort);
      }
    },
    get client() {
      return server?.client ?? o.idleClient;
    },
    stop,
    exited,
    logTail: () => [...beforeTail, ...(server?.logTail() ?? []), ...afterTail],
  };
}
