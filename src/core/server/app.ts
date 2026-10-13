import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { settingsSchema, type Settings } from '../../contract/settings';
import type { ServerEvent } from '../../contract/events';
import type { CoreContext } from '../context';
import { errorResponse, parseBody } from './http-error';
import { serveStatic } from './static';

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join('; ');

export function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice('Bearer '.length));
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

/** Only our own loopback origin may talk to the core (blocks DNS-rebinding pages). */
export function hostAllowed(host: string | undefined, port: number): boolean {
  if (!host) return false;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

export type RouteModule = (app: Hono, ctx: CoreContext) => void;

export interface AppOptions {
  token: string;
  /** Port the server is bound to; resolved lazily because it is only known after listen(). */
  port: () => number;
  modules: RouteModule[];
  /** Heartbeat interval for SSE (keeps proxies and Electron from timing out). */
  sseHeartbeatMs?: number;
}

export function createApp(ctx: CoreContext, opts: AppOptions): Hono {
  const app = new Hono();

  app.use('*', async (c, next) => {
    if (!hostAllowed(c.req.header('host'), opts.port())) return c.text('Forbidden host', 403);
    await next();
    c.header('content-security-policy', CSP);
    c.header('x-content-type-options', 'nosniff');
    c.header('referrer-policy', 'no-referrer');
    c.header('cross-origin-opener-policy', 'same-origin');
    c.header('cross-origin-resource-policy', 'same-origin');
  });

  app.use('/api/*', async (c, next) => {
    if (!tokenMatches(c.req.header('authorization'), opts.token)) {
      return c.json({ error: { code: 'VALIDATION', message: 'Missing or invalid session token' } }, 401);
    }
    await next();
  });

  app.onError((e, c) => errorResponse(c, e));

  app.get('/api/health', (c) => c.json({ ok: true as const, version: ctx.deps.appVersion, pid: process.pid }));

  app.get('/api/settings', async (c) => c.json(await ctx.settings.get()));
  app.put('/api/settings', async (c) => {
    // zod fills defaults for keys that are absent, so only the keys actually sent are kept:
    // a patch like { theme } must never reset the other settings.
    const raw = await parseBody(c, z.record(z.string(), z.unknown()));
    const parsed = settingsSchema.partial().strict().parse(raw);
    const patch = Object.fromEntries(Object.entries(parsed).filter(([k]) => k in raw)) as Partial<Settings>;
    return c.json(await ctx.settings.update(patch));
  });

  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      const queue: ServerEvent[] = [];
      let wake: (() => void) | undefined;
      const unsubscribe = ctx.hub.subscribe((e) => {
        queue.push(e);
        wake?.();
      });
      let closed = false;
      stream.onAbort(() => {
        closed = true;
        unsubscribe();
        wake?.();
      });
      await stream.writeSSE({ event: 'hello', data: JSON.stringify({ type: 'hello', version: ctx.deps.appVersion }) });
      const heartbeatMs = opts.sseHeartbeatMs ?? 15000;
      while (!closed) {
        const next = queue.shift();
        if (next) {
          await stream.writeSSE({ event: next.type, data: JSON.stringify(next) });
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, heartbeatMs);
        });
        wake = undefined;
        if (!closed && queue.length === 0) await stream.write(': ping\n\n');
      }
    }),
  );

  for (const register of opts.modules) register(app, ctx);

  app.all('/api/*', (c) => c.json({ error: { code: 'VALIDATION', message: 'Unknown API route' } }, 404));

  app.get('*', async (c) => {
    if (!ctx.deps.paths.uiDir) return c.text('LLM Bench core (API only)', 200);
    return serveStatic(ctx.deps.paths.uiDir, new URL(c.req.url).pathname);
  });

  return app;
}
