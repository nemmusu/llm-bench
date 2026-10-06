/** Swallows a rejection on best-effort cleanup paths (`p.catch(ignore)`). */
export function ignore(): undefined {
  return undefined;
}

export interface TimeoutSignal {
  signal: AbortSignal;
  /** Always call when done: clears the timer and detaches from the parent. */
  clear(): void;
}

/**
 * A signal aborted after `ms` or when `parent` aborts. Built from a plain controller and timer
 * (not AbortSignal.any + AbortSignal.timeout) so nothing can be garbage-collected while a
 * request is still waiting on a server that accepted the connection but never answers.
 */
export function timeoutSignal(ms: number, parent?: AbortSignal): TimeoutSignal {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new DOMException(`Timed out after ${ms} ms`, 'TimeoutError')), ms);
  const onAbort = () => ac.abort(parent?.reason);
  if (parent?.aborted) ac.abort(parent.reason);
  else parent?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: ac.signal,
    clear: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}
