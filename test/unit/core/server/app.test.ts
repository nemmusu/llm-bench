import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { AppError } from '../../../../src/contract/errors';
import { CSP, createApp, hostAllowed, tokenMatches, type RouteModule } from '../../../../src/core/server/app';
import { parseBody } from '../../../../src/core/server/http-error';
import { tempDir, testContext, testDeps } from './helpers';

const TOKEN = 'secret-token';
const PORT = 4321;
const HOST = `127.0.0.1:${PORT}`;
const auth = { authorization: `Bearer ${TOKEN}`, host: HOST };

describe('tokenMatches / hostAllowed', () => {
  it('accepts only the exact bearer token', () => {
    expect(tokenMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(tokenMatches(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(tokenMatches(TOKEN, TOKEN)).toBe(false);
    expect(tokenMatches(undefined, TOKEN)).toBe(false);
  });

  it('accepts only our loopback host and port', () => {
    expect(hostAllowed(`127.0.0.1:${PORT}`, PORT)).toBe(true);
    expect(hostAllowed(`localhost:${PORT}`, PORT)).toBe(true);
    expect(hostAllowed(`127.0.0.1:${PORT + 1}`, PORT)).toBe(false);
    expect(hostAllowed('evil.example:80', PORT)).toBe(false);
    expect(hostAllowed(undefined, PORT)).toBe(false);
  });
});

describe('createApp', () => {
  let t: ReturnType<typeof tempDir>;
  beforeEach(() => {
    t = tempDir();
  });
  afterEach(() => t.cleanup());

  function makeApp(modules: RouteModule[] = [], uiDir?: string) {
    const deps = testDeps(t.dir);
    if (uiDir) deps.paths.uiDir = uiDir;
    const ctx = testContext(deps);
    const app = createApp(ctx, { token: TOKEN, port: () => PORT, modules, sseHeartbeatMs: 20 });
    return { app, ctx };
  }

  it('rejects foreign hosts before anything else', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/health', { headers: { ...auth, host: 'evil.example' } });
    expect(res.status).toBe(403);
  });

  it('requires the session token on /api', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/health', { headers: { host: HOST } });
    expect(res.status).toBe(401);
  });

  it('answers health with version and security headers', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/health', { headers: auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, version: '9.9.9' });
    expect(res.headers.get('content-security-policy')).toBe(CSP);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('reads and updates settings, rejecting invalid values', async () => {
    const { app } = makeApp();
    const get = await app.request('/api/settings', { headers: auth });
    expect(await get.json()).toMatchObject({ language: 'it', theme: 'system' });

    const put = await app.request('/api/settings', {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ language: 'en', expertMode: true }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ language: 'en', expertMode: true });

    const bad = await app.request('/api/settings', {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ language: 'fr' }),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()) as unknown).toMatchObject({ error: { code: 'VALIDATION' } });

    const notJson = await app.request('/api/settings', { method: 'PUT', headers: auth, body: '{nope' });
    expect(notJson.status).toBe(400);
  });

  it('returns 404 JSON for unknown API routes', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/nope', { headers: auth });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'VALIDATION' } });
  });

  it('maps AppErrors thrown by modules to status codes', async () => {
    const mod: RouteModule = (app) => {
      app.get('/api/boom', () => {
        throw new AppError('HF_GATED', 'gated repo');
      });
      app.get('/api/crash', () => {
        throw new Error('kaboom');
      });
      app.post('/api/echo', async (c) => c.json(await parseBody(c, z.object({ a: z.number() }))));
    };
    const { app } = makeApp([mod]);
    const gated = await app.request('/api/boom', { headers: auth });
    expect(gated.status).toBe(403);
    expect(await gated.json()).toEqual({ error: { code: 'HF_GATED', message: 'gated repo' } });
    const crash = await app.request('/api/crash', { headers: auth });
    expect(crash.status).toBe(500);
    expect(await crash.json()).toEqual({ error: { code: 'INTERNAL', message: 'kaboom' } });
    const echo = await app.request('/api/echo', { method: 'POST', headers: auth, body: JSON.stringify({ a: 1 }) });
    expect(await echo.json()).toEqual({ a: 1 });
  });

  it('streams server events, starting with hello', async () => {
    const { app, ctx } = makeApp();
    const res = await app.request('/api/events', { headers: auth });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let text = '';
    const readUntil = async (needle: string) => {
      while (!text.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += value;
      }
    };
    await readUntil('event: hello');
    expect(ctx.hub.size).toBe(1);
    ctx.hub.publish({ type: 'runs.changed' });
    await readUntil('event: runs.changed');
    // Heartbeat comment when idle.
    await readUntil(': ping');
    await reader.cancel();
    // The subscription is dropped once the client goes away.
    await new Promise((r) => setTimeout(r, 50));
    expect(ctx.hub.size).toBe(0);
  });

  it('uses the default heartbeat when none is configured', async () => {
    const ctx = testContext(testDeps(t.dir));
    const app = createApp(ctx, { token: TOKEN, port: () => PORT, modules: [] });
    const res = await app.request('/api/events', { headers: auth });
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    const { value } = await reader.read();
    expect(value).toContain('event: hello');
    await reader.cancel();
  });

  it('serves the UI and falls back to index.html for client routes', async () => {
    const ui = path.join(t.dir, 'ui');
    mkdirSync(path.join(ui, 'assets'), { recursive: true });
    writeFileSync(path.join(ui, 'index.html'), '<html>app</html>');
    writeFileSync(path.join(ui, 'assets', 'main-AbCdEf12.js'), 'console.log(1)');
    const { app } = makeApp([], ui);
    const index = await app.request('/', { headers: { host: HOST } });
    expect(await index.text()).toBe('<html>app</html>');
    expect(index.headers.get('cache-control')).toBe('no-cache');
    const asset = await app.request('/assets/main-AbCdEf12.js', { headers: { host: HOST } });
    expect(asset.headers.get('content-type')).toContain('text/javascript');
    expect(asset.headers.get('cache-control')).toContain('immutable');
    const deep = await app.request('/results/abc', { headers: { host: HOST } });
    expect(await deep.text()).toBe('<html>app</html>');
  });

  it('reports API-only mode when no UI folder is configured', async () => {
    const { app } = makeApp();
    const res = await app.request('/', { headers: { host: HOST } });
    expect(await res.text()).toContain('API only');
  });
});
