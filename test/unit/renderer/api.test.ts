import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient } from '../../../src/renderer/lib/api';
import { resolveConnection } from '../../../src/renderer/lib/connection';

const conn = { baseUrl: 'http://127.0.0.1:5000', token: 'tok' };

function json(body: unknown, status = 200): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('createApiClient requests', () => {
  it('sends the bearer token and parses JSON', async () => {
    const fetchFn = vi.fn(async () => json({ ok: true }));
    const api = createApiClient(conn, fetchFn as unknown as typeof fetch);
    await expect(api.get('/api/health')).resolves.toEqual({ ok: true });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:5000/api/health');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(init.body).toBeUndefined();
  });

  it('posts an empty object by default, puts and deletes', async () => {
    const fetchFn = vi.fn(async () => json(undefined));
    const api = createApiClient(conn, fetchFn as unknown as typeof fetch);
    const signal = new AbortController().signal;
    await expect(api.post('/api/runs', undefined, signal)).resolves.toBeUndefined();
    await api.put('/api/settings', { theme: 'dark' });
    await api.put('/api/settings');
    await api.del('/api/runs/1');
    await api.get('/api/x', signal);
    const calls = fetchFn.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]![1].body).toBe('{}');
    expect(calls[0]![1].signal).toBe(signal);
    expect((calls[0]![1].headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(calls[1]![1].body).toBe('{"theme":"dark"}');
    expect(calls[2]![1].body).toBe('{}');
    expect(calls[3]![1].method).toBe('DELETE');
    expect(calls[4]![1].signal).toBe(signal);
  });

  it('turns error responses into ApiError with the core data', async () => {
    const api = createApiClient(conn, (async () => json({ error: { code: 'ENGINE_OOM', message: 'oom' } }, 500)) as unknown as typeof fetch);
    const err = await api.get('/api/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
    expect((err as ApiError).data.code).toBe('ENGINE_OOM');
    expect((err as ApiError).message).toBe('oom');
  });

  it('falls back to INTERNAL when the error body is missing', async () => {
    const api = createApiClient(conn, (async () => json(undefined, 404)) as unknown as typeof fetch);
    const err = (await api.get('/api/x').catch((e: unknown) => e)) as ApiError;
    expect(err.data).toEqual({ code: 'INTERNAL', message: 'HTTP 404' });
  });

  it('reports an unreachable core as ApiError status 0', async () => {
    const api = createApiClient(conn, (async () => {
      throw new TypeError('connection refused');
    }) as unknown as typeof fetch);
    const err = (await api.get('/api/x').catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(0);
    expect(err.data.message).toContain('connection refused');
  });

  it('rethrows aborts untouched', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const api = createApiClient(conn, (async () => {
      throw abort;
    }) as unknown as typeof fetch);
    await expect(api.get('/api/x')).rejects.toBe(abort);
  });

  it('uses the global fetch by default', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ v: 1 }));
    await expect(createApiClient(conn).get('/a')).resolves.toEqual({ v: 1 });
    spy.mockRestore();
  });
});

function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('createApiClient events', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('parses events, skips malformed ones and reconnects with backoff', async () => {
    const responses = [
      sseResponse(['event: hello\ndata: {"type":"hello","version":"1"}\n\n', 'data: not-json\n\n', 'data: {"type":"runs.changed"}\n\n']),
      new Response('nope', { status: 503 }),
    ];
    const fetchFn = vi.fn(async () => responses.shift() ?? new Promise<Response>(() => undefined));
    const api = createApiClient(conn, fetchFn as unknown as typeof fetch);
    const events: unknown[] = [];
    const status: boolean[] = [];
    const stop = api.events(
      (e) => events.push(e),
      (ok) => status.push(ok),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual([{ type: 'hello', version: '1' }, { type: 'runs.changed' }]);
    expect(status).toEqual([true, false]);
    // First retry after 500 ms (250·2¹), second after 1 s.
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(status).toEqual([true, false, false]);
    stop();
  });

  it('stops cleanly and works without a status callback', async () => {
    let signal: AbortSignal | undefined;
    const fetchFn = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          signal = init.signal ?? undefined;
          signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
    );
    const api = createApiClient(conn, fetchFn as unknown as typeof fetch);
    const stop = api.events(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(signal?.aborted).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('caps the backoff at 5 s and treats a body-less response as a failure', async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 200 }));
    const api = createApiClient(conn, fetchFn as unknown as typeof fetch);
    const stop = api.events(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(5000);
    const calls = fetchFn.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchFn.mock.calls.length).toBe(calls + 1);
    stop();
  });
});

describe('resolveConnection', () => {
  afterEach(() => {
    sessionStorage.clear();
    window.history.replaceState(null, '', '/');
  });

  it('asks the Electron bridge when present', async () => {
    const bridge = { connection: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:1', token: 'b' })) };
    const fake = { gpubench: bridge } as unknown as Window;
    await expect(resolveConnection(fake)).resolves.toEqual({ baseUrl: 'http://127.0.0.1:1', token: 'b' });
  });

  it('takes the token from the query, stores it and strips it from the URL', async () => {
    window.history.replaceState(null, '', '/?token=abc&x=1#/results');
    const c = await resolveConnection();
    expect(c.token).toBe('abc');
    expect(c.baseUrl).toBe(window.location.origin);
    expect(sessionStorage.getItem('gpubench.token')).toBe('abc');
    expect(window.location.search).toBe('?x=1');
    expect(window.location.hash).toBe('#/results');
  });

  it('reuses the stored token after a reload', async () => {
    sessionStorage.setItem('gpubench.token', 'kept');
    await expect(resolveConnection()).resolves.toMatchObject({ token: 'kept' });
  });

  it('survives an unavailable sessionStorage', async () => {
    const broken = {
      location: new URL('http://127.0.0.1:9/?token=t1'),
      history: { replaceState: vi.fn() },
      get sessionStorage(): Storage {
        throw new Error('denied');
      },
    } as unknown as Window;
    await expect(resolveConnection(broken)).resolves.toEqual({ baseUrl: 'http://127.0.0.1:9', token: 't1' });
    const noToken = {
      location: new URL('http://127.0.0.1:9/'),
      history: { replaceState: vi.fn() },
      get sessionStorage(): Storage {
        throw new Error('denied');
      },
    } as unknown as Window;
    await expect(resolveConnection(noToken)).resolves.toEqual({ baseUrl: 'http://127.0.0.1:9', token: '' });
  });
});
