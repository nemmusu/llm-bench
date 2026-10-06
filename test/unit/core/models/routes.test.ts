import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { AppError } from '../../../../src/contract/errors';
import { createModelsRoutes } from '../../../../src/core/models/routes';
import type { ModelsService } from '../../../../src/core/models/service';
import { errorResponse } from '../../../../src/core/server/http-error';

function app() {
  const calls: { fn: string; args: unknown[] }[] = [];
  const rec =
    (fn: string, result: unknown = { ok: fn }) =>
    (...args: unknown[]) => {
      calls.push({ fn, args });
      return Promise.resolve(result);
    };
  const svc = {
    list: rec('list', []),
    rescan: rec('rescan', []),
    search: rec('search', []),
    curated: rec('curated'),
    hubFiles: rec('hubFiles', []),
    hubModel: rec('hubModel', { repo: 'Qwen/Qwen3-4B-GGUF', downloads: 5 }),
    readme: rec('readme', { text: '# x', truncated: false }),
    remoteGgufFacts: rec('remoteGgufFacts'),
    related: rec('related', []),
    hubFit: rec('hubFit'),
    fit: rec('fit'),
    deleteLocal: (...args: unknown[]) => {
      calls.push({ fn: 'deleteLocal', args });
      if (args[0] === 'outside') return Promise.reject(new AppError('VALIDATION', 'outside'));
      return Promise.resolve();
    },
  } as unknown as ModelsService;
  const hono = new Hono();
  hono.onError((e, c) => errorResponse(c, e));
  createModelsRoutes(svc)(hono, {} as never);
  return { hono, calls };
}

const json = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

describe('models routes', () => {
  it('lists and rescans', async () => {
    const { hono, calls } = app();
    expect(await (await hono.request('/api/models/local')).json()).toEqual([]);
    expect((await hono.request('/api/models/rescan', { method: 'POST' })).status).toBe(200);
    expect(calls.map((c) => c.fn)).toEqual(['list', 'rescan']);
  });

  it('validates search queries', async () => {
    const { hono, calls } = app();
    expect((await hono.request('/api/models/search?q=qwen&format=gguf&sort=likes&limit=5&onlyFits=1')).status).toBe(200);
    expect(calls[0]?.args).toEqual(['qwen', { q: 'qwen', format: 'gguf', sort: 'likes', limit: 5, onlyFits: true }]);
    await hono.request('/api/models/search');
    expect(calls[1]?.args).toEqual(['', { q: '', format: 'any', sort: 'downloads', limit: 30, onlyFits: false }]);
    const bad = await hono.request('/api/models/search?format=exe');
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('VALIDATION');
    expect((await hono.request('/api/models/search?limit=1000')).status).toBe(400);
    expect((await hono.request('/api/models/search?onlyFits=maybe')).status).toBe(400);
  });

  it('serves the curated list with an optional VRAM', async () => {
    const { hono, calls } = app();
    await hono.request('/api/models/curated?vramGB=24');
    await hono.request('/api/models/curated');
    expect(calls.map((c) => c.args)).toEqual([[24], [undefined]]);
    expect((await hono.request('/api/models/curated?vramGB=-1')).status).toBe(400);
  });

  it('hub routes validate the repo id and parameters', async () => {
    const { hono, calls } = app();
    await hono.request('/api/models/hub/Qwen/Qwen3-4B-GGUF/files?revision=main');
    await hono.request('/api/models/hub/Qwen/Qwen3-4B-GGUF/files');
    await hono.request('/api/models/hub/Qwen/Qwen3-4B-GGUF/readme');
    await hono.request('/api/models/hub/Qwen/Qwen3-4B-GGUF/related');
    await hono.request('/api/models/hub/Qwen/Qwen3-4B-GGUF/gguf-facts?file=Qwen3-4B-Q4_K_M.gguf&revision=abc');
    expect(calls.map((c) => [c.fn, ...c.args])).toEqual([
      ['hubFiles', 'Qwen/Qwen3-4B-GGUF', 'main'],
      ['hubFiles', 'Qwen/Qwen3-4B-GGUF', undefined],
      ['readme', 'Qwen/Qwen3-4B-GGUF'],
      ['related', 'Qwen/Qwen3-4B-GGUF'],
      ['remoteGgufFacts', 'Qwen/Qwen3-4B-GGUF', 'Qwen3-4B-Q4_K_M.gguf', 'abc'],
    ]);
    expect((await hono.request('/api/models/hub/-bad/x/files')).status).toBe(400);
    expect((await hono.request('/api/models/hub/a/b/gguf-facts?file=readme.md')).status).toBe(400);
    expect((await hono.request('/api/models/hub/a/b/gguf-facts')).status).toBe(400);
  });

  it('serves one hub repo info', async () => {
    const { hono, calls } = app();
    expect(await (await hono.request('/api/models/hub/Qwen/Qwen3-4B-GGUF')).json()).toEqual({ repo: 'Qwen/Qwen3-4B-GGUF', downloads: 5 });
    await hono.request('/api/models/hub/Qwen/Qwen3-4B-GGUF?revision=abc');
    expect(calls.map((c) => [c.fn, ...c.args])).toEqual([
      ['hubModel', 'Qwen/Qwen3-4B-GGUF', undefined],
      ['hubModel', 'Qwen/Qwen3-4B-GGUF', 'abc'],
    ]);
    expect((await hono.request('/api/models/hub/-bad/x')).status).toBe(400);
    expect((await hono.request('/api/models/hub/a/b?revision=')).status).toBe(400);
  });

  it('fits a hub repo and a request body', async () => {
    const { hono, calls } = app();
    expect((await hono.request('/api/models/hub/a/b/fit', json({ engine: 'vllm-docker', revision: 'r1', params: { contextSize: 4096 } }))).status).toBe(200);
    await hono.request('/api/models/hub/a/b/fit', json({ engine: 'llamacpp-native' }));
    expect(calls[0]?.args).toEqual(['a/b', 'vllm-docker', { revision: 'r1', params: { contextSize: 4096, extraArgs: [], env: {} } }]);
    expect(calls[1]?.args).toEqual(['a/b', 'llamacpp-native', {}]);
    expect((await hono.request('/api/models/hub/a/b/fit', json({ engine: 'nope' }))).status).toBe(400);
    expect((await hono.request('/api/models/fit', json({ localId: 'x', engine: 'llamacpp-native' }))).status).toBe(200);
    expect(calls[2]?.args).toEqual([{ localId: 'x', engine: 'llamacpp-native' }]);
    expect((await hono.request('/api/models/fit', { method: 'POST', body: 'not json' })).status).toBe(400);
  });

  it('deletes local models, mapping refusals to 400', async () => {
    const { hono } = app();
    expect(await (await hono.request('/api/models/local/abc', { method: 'DELETE' })).json()).toEqual({ ok: true });
    const refused = await hono.request('/api/models/local/outside', { method: 'DELETE' });
    expect(refused.status).toBe(400);
  });
});
