import type { ApiFlavor } from '../../contract/engines';
import { AppError } from '../../contract/errors';
import type { Clock, ExitInfo, LogLine, ManagedProcess } from '../deps';
import type { InferenceClient } from '../inference/types';
import { AsyncQueue } from '../process/runner';
import type { EngineInstance, PhaseMark } from './types';
import { ignore } from './util';

/** Builds the HTTP client for a started engine (implemented in core/inference, injected by the composition root). */
export type ClientFactory = (flavor: ApiFlavor, baseUrl: string, opts?: { apiKey?: string }) => InferenceClient;

export const DEFAULT_READY_TIMEOUT_MS = 15 * 60_000;
export const DEFAULT_POLL_MS = 50;
export const DEFAULT_LOG_LINES = 2000;

export interface ProcessInstanceOptions {
  mp: ManagedProcess;
  baseUrl: string;
  client: InferenceClient;
  clock: Clock;
  /** One readiness probe; true = ready. Errors count as "not yet". */
  probe(signal: AbortSignal): Promise<boolean>;
  phaseOf(text: string): string | undefined;
  diagnose(lines: readonly string[], exit: ExitInfo): AppError;
  /** Aborting it while waiting for readiness stops the engine (CANCELLED). */
  startSignal?: AbortSignal;
  pollMs?: number;
  readyTimeoutMs?: number;
  maxLogLines?: number;
  /** Called once when the process is gone (ownership registry cleanup). */
  onExit?(exit: ExitInfo): Promise<void>;
}

/**
 * EngineInstance on top of a ManagedProcess: one consumer drains the process lines into a
 * bounded tail + phase marks and re-publishes them on `logs`; readiness is polled every
 * `pollMs` and raced against the process exit, so a crash is diagnosed from its own log.
 */
export function createProcessInstance(o: ProcessInstanceOptions): EngineInstance {
  const tail: string[] = [];
  const marks: PhaseMark[] = [];
  const seen = new Set<string>();
  const logs = new AsyncQueue<LogLine>();
  const maxLines = o.maxLogLines ?? DEFAULT_LOG_LINES;

  const pumped = (async () => {
    for await (const line of o.mp.lines) {
      tail.push(line.text);
      if (tail.length > maxLines) tail.shift();
      const phase = o.phaseOf(line.text);
      if (phase !== undefined && !seen.has(phase)) {
        seen.add(phase);
        marks.push({ name: phase, t: line.t });
      }
      logs.push(line);
    }
    logs.close();
  })();

  let exitInfo: ExitInfo | undefined;
  const cleanedUp = o.mp.exited.then(async (exit) => {
    exitInfo = exit;
    if (o.onExit) await o.onExit(exit).catch(ignore);
    return exit;
  });

  let stopping: Promise<ExitInfo> | undefined;
  const stop = (): Promise<ExitInfo> => {
    stopping ??= o.mp.stop().then(() => cleanedUp);
    return stopping;
  };

  /** Lets the log pump catch up with the last lines a dying process wrote. */
  const drained = () => Promise.race([pumped, o.clock.sleep(500).catch(ignore)]);

  let ready: Promise<{ tReady: number; phases: PhaseMark[] }> | undefined;
  const waitLoop = async (signal?: AbortSignal) => {
    const ac = new AbortController();
    const abort = () => ac.abort();
    for (const s of [signal, o.startSignal]) {
      if (s?.aborted) ac.abort();
      s?.addEventListener('abort', abort, { once: true });
    }
    const timeoutMs = o.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    const deadline = o.clock.now() + timeoutMs;
    try {
      for (;;) {
        if (ac.signal.aborted) {
          await stop();
          throw new AppError('CANCELLED', 'Engine start cancelled');
        }
        if (exitInfo) {
          await drained();
          throw o.diagnose(tail, exitInfo);
        }
        if (o.clock.now() > deadline) {
          await stop();
          throw new AppError('ENGINE_TIMEOUT', 'The engine did not become ready in time', {
            params: { timeoutMs },
            detail: tail.slice(-25).join('\n'),
          });
        }
        // Raced with the exit: a probe stuck on a socket that never answers must not delay the diagnosis.
        const ok = await Promise.race([o.probe(ac.signal).catch(() => false), cleanedUp.then(() => false)]);
        // A 200 from a process that already died came from someone else on that port.
        if (ok && !exitInfo) return { tReady: o.clock.now(), phases: [...marks] };
        await Promise.race([o.clock.sleep(o.pollMs ?? DEFAULT_POLL_MS, ac.signal).catch(ignore), cleanedUp]);
      }
    } finally {
      // Cancels a probe still in flight (we returned or threw without waiting for it).
      ac.abort();
      signal?.removeEventListener('abort', abort);
      o.startSignal?.removeEventListener('abort', abort);
    }
  };

  return {
    baseUrl: o.baseUrl,
    pid: o.mp.pid,
    t0: o.mp.startedAt,
    logs,
    waitReady(signal) {
      ready ??= waitLoop(signal);
      return ready;
    },
    client: o.client,
    stop,
    exited: o.mp.exited,
    logTail: () => [...tail],
  };
}
