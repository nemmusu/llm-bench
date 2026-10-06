import { performance } from 'node:perf_hooks';
import type { Clock, Logger } from './deps';

export const systemClock: Clock = {
  now: () => performance.now(),
  wall: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'));
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};

export type LogSink = (line: string) => void;

/** JSON-lines logger. Secrets must never be passed in `data` (see redact()). */
export function createLogger(sink: LogSink, minLevel: 'debug' | 'info' | 'warn' | 'error' = 'info'): Logger {
  const order = { debug: 0, info: 1, warn: 2, error: 3 } as const;
  const emit = (level: keyof typeof order, msg: string, data?: Record<string, unknown>) => {
    if (order[level] < order[minLevel]) return;
    sink(JSON.stringify({ t: new Date().toISOString(), level, msg, ...(data ? { data } : {}) }));
  };
  return {
    debug: (m, d) => emit('debug', m, d),
    info: (m, d) => emit('info', m, d),
    warn: (m, d) => emit('warn', m, d),
    error: (m, d) => emit('error', m, d),
  };
}
