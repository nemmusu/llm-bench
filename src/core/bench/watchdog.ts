/**
 * Watchdogs of one streamed request, for every run: an engine that stops answering would otherwise be
 * waited for forever (a starved launch on Windows, reading from shared memory, can sit at 99 % GPU use
 * for many minutes without producing a token). Either watchdog aborts the request and throws
 * ENGINE_TIMEOUT:
 *  - the stall guard: no stream event for a minute. Before the first token the engine is reading the
 *    prompt, which llama.cpp does not report, so the first event gets as long as reading the prompt at
 *    25 tok/s would take (slower than the slowest spill measured, 33 tok/s), never less than the minute;
 *  - a deadline (the tuner's requests: see Tuner.timeoutMs).
 * Timers are real (setTimeout), not the injected clock: they bound real waits.
 */
import { AppError, type AppErrorData } from '../../contract/errors';
import type { StreamEvent } from '../inference/types';

export interface StallRules {
  /** No stream event for this long once the first one came: the engine stalled. */
  idleMs: number;
  /** Before the first event: the prompt is given as long as reading it at this speed takes (at least idleMs). */
  minPrefillTps: number;
}

export const STALL_RULES: StallRules = { idleMs: 60_000, minPrefillTps: 25 };

/** How long the first event of a request with `promptTokens` tokens of prompt may take. */
export function firstEventMs(promptTokens: number, rules: StallRules): number {
  return Math.max(rules.idleMs, Math.round((promptTokens / rules.minPrefillTps) * 1000));
}

/** The engine sent nothing for `ms` (params.reason 'stalled'). */
export function stalledError(ms: number): AppError {
  return new AppError('ENGINE_TIMEOUT', `The engine sent nothing for ${ms} ms`, { params: { reason: 'stalled', ms } });
}

/** The request took longer than its deadline of `ms` (params.reason 'deadline'). */
export function deadlineError(ms: number): AppError {
  return new AppError('ENGINE_TIMEOUT', `The request took longer than its deadline (${ms} ms)`, { params: { reason: 'deadline', ms } });
}

export interface WatchOptions {
  /** The run's (or the tune launch's) signal: aborting it cancels the request as before. */
  signal: AbortSignal;
  promptTokens: number;
  rules: StallRules;
  /** Deadline of the whole request, ms; absent = none. */
  timeoutMs?: number | undefined;
}

/**
 * The events of `open(signal)` under the watchdogs. When one fires the request is aborted (through the
 * signal handed to `open`) and its error is thrown instead of the cancellation it causes.
 */
export async function* watchStream(open: (signal: AbortSignal) => AsyncIterable<StreamEvent>, o: WatchOptions): AsyncGenerator<StreamEvent, void, undefined> {
  const own = new AbortController();
  let failure: AppError | undefined;
  const fail = (e: AppError) => () => {
    failure ??= e;
    own.abort(e);
  };
  const first = firstEventMs(o.promptTokens, o.rules);
  let idle = setTimeout(fail(stalledError(first)), first);
  let started = false;
  const deadline = o.timeoutMs === undefined ? undefined : setTimeout(fail(deadlineError(o.timeoutMs)), o.timeoutMs);
  try {
    for await (const e of open(AbortSignal.any([o.signal, own.signal]))) {
      // A source slow to notice the abort: nothing more is passed on after a watchdog fired.
      if (failure) throw failure;
      if (started) idle.refresh();
      else {
        started = true;
        clearTimeout(idle);
        idle = setTimeout(fail(stalledError(o.rules.idleMs)), o.rules.idleMs);
      }
      yield e;
    }
  } catch (e) {
    throw failure ?? e;
  } finally {
    clearTimeout(idle);
    clearTimeout(deadline);
  }
}

/** ENGINE_TIMEOUT from a watchdog: the stall guard or a deadline. */
export function watchdogFired(e: Pick<AppErrorData, 'code' | 'params'>): boolean {
  return e.code === 'ENGINE_TIMEOUT' && (e.params?.reason === 'stalled' || e.params?.reason === 'deadline');
}
