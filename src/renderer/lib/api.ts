import { createParser } from 'eventsource-parser';
import type { AppErrorData } from '../../contract/errors';
import type { ServerEvent } from '../../contract/events';
import type { Connection } from './connection';

/** Error thrown by the API client; carries the core's AppErrorData for the error catalog. */
export class ApiError extends Error {
  readonly data: AppErrorData;
  readonly status: number;
  constructor(data: AppErrorData, status: number) {
    super(data.message);
    this.name = 'ApiError';
    this.data = data;
    this.status = status;
  }
}

export interface ApiClient {
  get<T>(path: string, signal?: AbortSignal): Promise<T>;
  post<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
  del<T>(path: string): Promise<T>;
  /** Subscribes to /api/events; reconnects with backoff until the returned function is called. */
  events(onEvent: (e: ServerEvent) => void, onStatus?: (connected: boolean) => void): () => void;
}

export function createApiClient(conn: Connection, fetchFn: typeof fetch = fetch.bind(globalThis)): ApiClient {
  const headers = (json: boolean): Record<string, string> => ({
    authorization: `Bearer ${conn.token}`,
    ...(json ? { 'content-type': 'application/json' } : {}),
  });

  async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await fetchFn(conn.baseUrl + path, {
        method,
        headers: headers(body !== undefined),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      throw new ApiError({ code: 'INTERNAL', message: `Core unreachable: ${(e as Error).message}` }, 0);
    }
    const text = await res.text();
    const json: unknown = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      const err = (json as { error?: AppErrorData } | undefined)?.error ?? { code: 'INTERNAL', message: `HTTP ${res.status}` };
      throw new ApiError(err as AppErrorData, res.status);
    }
    return json as T;
  }

  function events(onEvent: (e: ServerEvent) => void, onStatus?: (connected: boolean) => void): () => void {
    let stopped = false;
    let controller: AbortController | undefined;
    let attempt = 0;
    const loop = async () => {
      while (!stopped) {
        controller = new AbortController();
        try {
          const res = await fetchFn(conn.baseUrl + '/api/events', { headers: headers(false), signal: controller.signal });
          if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
          attempt = 0;
          onStatus?.(true);
          const parser = createParser({
            onEvent: (ev) => {
              try {
                onEvent(JSON.parse(ev.data) as ServerEvent);
              } catch {
                /* ignore malformed event */
              }
            },
          });
          const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            parser.feed(value);
          }
        } catch {
          /* reconnect below */
        }
        if (stopped) break;
        onStatus?.(false);
        attempt++;
        await new Promise((r) => setTimeout(r, Math.min(5000, 250 * 2 ** attempt)));
      }
    };
    void loop();
    return () => {
      stopped = true;
      controller?.abort();
    };
  }

  return {
    get: (p, s) => request('GET', p, undefined, s),
    post: (p, b, s) => request('POST', p, b ?? {}, s),
    put: (p, b) => request('PUT', p, b ?? {}),
    del: (p) => request('DELETE', p),
    events,
  };
}
