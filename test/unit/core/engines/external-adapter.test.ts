import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { launchParamsSchema } from '../../../../src/contract/engines';
import { ExternalAdapter, normalizeBaseUrl } from '../../../../src/core/engines/external/adapter';
import type { LaunchPlan, ModelTarget } from '../../../../src/core/engines/types';
import type { InferenceClient } from '../../../../src/core/inference/types';
import { systemClock } from '../../../../src/core/node-deps';
import { startFakeEngine, type FakeEngine } from '../../../fakes/fake-engine/server.mjs';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;
async function serve(handler: Handler): Promise<{ url: string; close: () => Promise<void> }> {
  const srv = http.createServer(handler);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
    close: () =>
      new Promise((r) => {
        srv.closeAllConnections();
        srv.close(() => r());
      }),
  };
}
const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

const createClient = vi.fn((flavor: string, baseUrl: string, opts?: { apiKey?: string }) => ({ flavor, baseUrl, opts }) as unknown as InferenceClient);
const adapter = (probeTimeoutMs?: number) =>
  new ExternalAdapter({ fetch, clock: systemClock, createClient, ...(probeTimeoutMs !== undefined ? { probeTimeoutMs } : {}) });
const model: ModelTarget = { identity: { displayName: 'm', format: 'remote', source: 'external', files: [], weakKey: 'm' }, servedName: 'm' };
const params = launchParamsSchema.parse({});

let llama: FakeEngine;
let vllm: FakeEngine;
let openai: { url: string; close: () => Promise<void> };
let keyed: { url: string; close: () => Promise<void> };
let odd: { url: string; close: () => Promise<void> };
beforeAll(async () => {
  llama = await startFakeEngine({ alias: 'tiny', profile: { loadMsWarm: 0 } });
  vllm = await startFakeEngine({ flavor: 'vllm', model: 'Qwen/Qwen3-0.6B', profile: { loadMsWarm: 0 } });
  await Promise.all([llama.loaded, vllm.loaded]);
  openai = await serve((req, res) => (req.url === '/v1/models' ? json(res, 200, { data: [{ id: 'gpt-x', owned_by: 'openai' }, 'junk'] }) : json(res, 404, {})));
  keyed = await serve((req, res) => {
    if (req.headers.authorization !== 'Bearer sk-good') return json(res, 401, { error: 'no' });
    if (req.url === '/v1/models') return json(res, 200, { data: [{ id: 'x' }] });
    if (req.url === '/props') return json(res, 200, { build_info: 7 });
    return json(res, 200, { version: '0.9.0' });
  });
  odd = await serve((req, res) => {
    if (req.url === '/v1/models') return json(res, 200, 'not json at all');
    if (req.url === '/props') return json(res, 200, { default_generation_settings: {} });
    return json(res, 500, 'boom');
  });
});
afterAll(async () => {
  await Promise.all([llama.close(), vllm.close(), openai.close(), keyed.close(), odd.close()]);
});

describe('ExternalAdapter.detect / probe', () => {
  it('needs a URL', async () => {
    expect(await adapter().detect()).toEqual({ kind: 'external', installed: true, supported: true, available: false, problems: ['ENDPOINT_INVALID'] });
    expect(await adapter().detect({ kind: 'external' })).toMatchObject({ problems: ['ENDPOINT_INVALID'] });
  });

  it('recognises llama.cpp, vLLM and plain OpenAI servers', async () => {
    expect(await adapter().detect({ kind: 'external', baseUrl: llama.url })).toEqual({
      kind: 'external',
      installed: true,
      supported: true,
      available: true,
      location: llama.url,
      variant: 'llamacpp',
      version: 'b10997-fccf7166f',
      problems: [],
    });
    expect(await adapter().probe({ kind: 'external', baseUrl: `${vllm.url}/v1/` })).toEqual({ flavor: 'vllm', version: '0.12.0', models: ['Qwen/Qwen3-0.6B'] });
    const o = await adapter().detect({ kind: 'external', baseUrl: openai.url });
    expect(o).toMatchObject({ available: true, variant: 'openai' });
    expect(o.version).toBeUndefined();
  });

  it('autodetects from /props or /version when owned_by says nothing; explicit flavor wins', async () => {
    expect(await adapter().probe({ kind: 'external', baseUrl: keyed.url, apiKey: 'sk-good' })).toEqual({ flavor: 'llamacpp', models: ['x'] });
    expect(await adapter().probe({ kind: 'external', baseUrl: keyed.url, apiKey: 'sk-good', flavor: 'vllm' })).toEqual({
      flavor: 'vllm',
      version: '0.9.0',
      models: ['x'],
    });
    expect(await adapter().probe({ kind: 'external', baseUrl: odd.url })).toEqual({ flavor: 'llamacpp', models: [] });
    expect(await adapter().probe({ kind: 'external', baseUrl: llama.url, flavor: 'openai' })).toEqual({ flavor: 'openai', models: ['tiny'] });
  });

  it('rejected key, HTTP errors, unreachable, slow servers', async () => {
    expect((await adapter().detect({ kind: 'external', baseUrl: keyed.url, apiKey: 'sk-bad' })).problems).toEqual(['ENDPOINT_INVALID']);
    const err500 = await serve((_req, res) => json(res, 500, {}));
    await expect(adapter().probe({ kind: 'external', baseUrl: err500.url })).rejects.toMatchObject({ code: 'ENDPOINT_INVALID', params: { status: 500 } });
    await err500.close();
    expect((await adapter().detect({ kind: 'external', baseUrl: err500.url })).problems).toEqual(['ENDPOINT_UNREACHABLE']);
    const hang = await serve(() => {});
    await expect(adapter(100).probe({ kind: 'external', baseUrl: hang.url })).rejects.toMatchObject({ code: 'ENDPOINT_UNREACHABLE' });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    await expect(adapter().probe({ kind: 'external', baseUrl: hang.url }, ac.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    await hang.close();
  });

  it('capabilities per flavour', async () => {
    expect(await adapter().capabilities({ kind: 'external', baseUrl: llama.url })).toMatchObject({ tokenIdsInPrompt: true, timings: true, minTokens: false, version: 'b10997-fccf7166f' });
    expect(await adapter().capabilities({ kind: 'external', baseUrl: vllm.url })).toMatchObject({ tokenIdsInPrompt: true, timings: false, minTokens: true });
    const o = await adapter().capabilities({ kind: 'external', baseUrl: openai.url });
    expect(o).toMatchObject({ tokenIdsInPrompt: false, variant: 'openai', fitFlag: false });
    expect(o.version).toBeUndefined();
  });
});

describe('ExternalAdapter.plan / start', () => {
  it('plans without a command; the key stays out of the plan', async () => {
    const a = adapter();
    const plan = await a.plan({ kind: 'external', baseUrl: `${keyed.url}/v1`, apiKey: 'sk-good' }, model, params, { port: 0, marker: 'gpubench-x0000000' });
    expect(plan).toMatchObject({ argv: [], env: {}, host: '127.0.0.1', modelFiles: [], modelBytes: 0, engine: { kind: 'external', name: 'llama.cpp', variant: 'llamacpp' } });
    expect(JSON.stringify(plan)).not.toContain('sk-good');
    const v = await a.plan({ kind: 'external', baseUrl: vllm.url }, model, params, { port: 0, marker: 'm' });
    expect(v.engine).toEqual({ kind: 'external', name: 'vLLM', variant: 'vllm', version: '0.12.0' });
    const inst = await a.start(plan, new AbortController().signal);
    expect(createClient).toHaveBeenLastCalledWith('llamacpp', keyed.url, { apiKey: 'sk-good' });
    expect(await inst.waitReady()).toMatchObject({ phases: [] });
    expect(inst.logTail()).toEqual([]);
    const lines: unknown[] = [];
    for await (const l of inst.logs) lines.push(l);
    expect(lines).toEqual([]);
    expect(await inst.stop()).toEqual({ code: null, signal: null });
    expect(await inst.exited).toEqual({ code: null, signal: null });
  });

  it('unreachable at plan time: identity from cfg.flavor or plain OpenAI; default ports', async () => {
    const a = adapter(100);
    const https = await a.plan({ kind: 'external', baseUrl: 'https://127.0.0.1:1/', flavor: 'vllm' }, model, params, { port: 0, marker: 'm' });
    expect(https).toMatchObject({ port: 1, engine: { name: 'vLLM', variant: 'vllm' } });
    expect(https.engine.version).toBeUndefined();
    const defHttps = await a.plan({ kind: 'external', baseUrl: 'https://localhost:1' }, model, params, { port: 0, marker: 'm' });
    expect(defHttps.engine.name).toBe('OpenAI-compatible');
    expect(normalizeBaseUrl({ kind: 'external', baseUrl: 'https://example.invalid/api/v1/' })).toBe('https://example.invalid/api');
    const p443 = new URL('https://example.invalid/');
    expect(p443.port).toBe('');
  });

  it('start(): cancelled, rejected key, and plans not made by this adapter', async () => {
    const a = adapter();
    const plan = await a.plan({ kind: 'external', baseUrl: keyed.url, apiKey: 'sk-bad' }, model, params, { port: 0, marker: 'm' });
    await expect(a.start(plan, AbortSignal.abort())).rejects.toMatchObject({ code: 'CANCELLED' });
    const inst = await a.start(plan, new AbortController().signal);
    await expect(inst.waitReady()).rejects.toMatchObject({ code: 'ENDPOINT_INVALID', params: { status: 401 } });

    const port = Number(new URL(vllm.url).port);
    const foreign: LaunchPlan = { ...plan, host: '127.0.0.1', port, engine: { kind: 'external', name: 'vLLM', variant: 'vllm' } };
    const i2 = await a.start(foreign, new AbortController().signal);
    expect(createClient).toHaveBeenLastCalledWith('vllm', vllm.url, {});
    await expect(i2.waitReady(new AbortController().signal)).resolves.toMatchObject({ phases: [] });
    const bare: LaunchPlan = { ...foreign, engine: { kind: 'external', name: '?' } };
    await a.start(bare, new AbortController().signal);
    expect(createClient).toHaveBeenLastCalledWith('openai', vllm.url, {});
  });

  it('normalizeBaseUrl rejects missing and malformed URLs; port defaults', async () => {
    expect(() => normalizeBaseUrl({ kind: 'external' })).toThrow(/No endpoint/);
    expect(() => normalizeBaseUrl({ kind: 'external', baseUrl: 'not a url' })).toThrow(/Invalid endpoint/);
    const a = adapter(50);
    const http80 = await a.plan({ kind: 'external', baseUrl: 'http://127.0.0.1' }, model, params, { port: 0, marker: 'm' });
    expect(http80.port).toBe(80);
    const https443 = await a.plan({ kind: 'external', baseUrl: 'https://127.0.0.1' }, model, params, { port: 0, marker: 'm' });
    expect(https443.port).toBe(443);
  });
});
