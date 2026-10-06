import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { AppError } from '../../../../src/contract/errors';
import { createDownloadsRoutes } from '../../../../src/core/downloads/routes';
import type { DownloadService } from '../../../../src/core/downloads/service';
import { errorResponse } from '../../../../src/core/server/http-error';

describe('downloads routes', () => {
  function app() {
    const calls: { fn: string; args: unknown[] }[] = [];
    const rec = (fn: string) => (...args: unknown[]) => {
      calls.push({ fn, args });
      if (args[0] === 'missing') return Promise.reject(new AppError('VALIDATION', 'Unknown download'));
      return Promise.resolve({ id: String(args[0] ?? 'new'), fn });
    };
    const svc = { list: () => [{ id: 'a' }], add: rec('add'), pause: rec('pause'), resume: rec('resume'), cancel: rec('cancel') } as unknown as DownloadService;
    const hono = new Hono();
    hono.onError((e, c) => errorResponse(c, e));
    createDownloadsRoutes(svc)(hono, {} as never);
    return { hono, calls };
  }

  it('lists, adds (with defaults) and controls jobs', async () => {
    const { hono, calls } = app();
    expect(await (await hono.request('/api/downloads')).json()).toEqual([{ id: 'a' }]);
    const res = await hono.request('/api/downloads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo: 'o/r', files: ['x.gguf'] }) });
    expect(res.status).toBe(200);
    expect(calls[0]?.args).toEqual([{ repo: 'o/r', revision: 'main', files: ['x.gguf'] }]);
    for (const action of ['pause', 'resume', 'cancel']) {
      expect(await (await hono.request(`/api/downloads/j1/${action}`, { method: 'POST' })).json()).toEqual({ id: 'j1', fn: action });
    }
    expect((await hono.request('/api/downloads/missing/pause', { method: 'POST' })).status).toBe(400);
  });

  it('rejects invalid bodies', async () => {
    const { hono } = app();
    const empty = await hono.request('/api/downloads', { method: 'POST', body: JSON.stringify({ repo: 'o/r', files: [] }) });
    expect(empty.status).toBe(400);
    expect((await hono.request('/api/downloads', { method: 'POST', body: '{' })).status).toBe(400);
  });
});
