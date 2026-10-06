import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Clock } from '../../../../src/core/deps';

export interface Recorded {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

export interface TestServer {
  url: string;
  requests: Recorded[];
  close(): Promise<void>;
}

/** Local HTTP server on 127.0.0.1:0 (tests stay offline). */
export async function startServer(
  handler: (req: Recorded, res: ServerResponse) => void | Promise<void>,
): Promise<TestServer> {
  const requests: Recorded[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (d: string) => (body += d));
    req.on('end', () => {
      const rec: Recorded = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body };
      requests.push(rec);
      void handler(rec, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Writes SSE `data:` events, then ends the response. */
export function sendSse(res: ServerResponse, payloads: (unknown | string)[], opts: { raw?: string } = {}): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const p of payloads) res.write(`data: ${typeof p === 'string' ? p : JSON.stringify(p)}\n\n`);
  if (opts.raw) res.write(opts.raw);
  res.end();
}

/** Monotonic fake clock: every now() call advances by `step` ms, so chunk timestamps are distinct. */
export function steppingClock(step = 10, start = 1000): Clock & { t: number } {
  const c = {
    t: start,
    now() {
      c.t += step;
      return c.t;
    },
    wall: () => Date.UTC(2026, 9, 6),
    sleep: async () => undefined,
  };
  return c;
}

export function bodyStream(chunks: (string | Uint8Array)[], opts: { error?: Error; cancel?: () => void } = {}): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(ctrl) {
      for (const c of chunks) ctrl.enqueue(typeof c === 'string' ? enc.encode(c) : c);
      if (opts.error) ctrl.error(opts.error);
      else ctrl.close();
    },
    ...(opts.cancel ? { cancel: opts.cancel } : {}),
  });
}
