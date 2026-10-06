import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  discardBody,
  fileKind,
  groupKeyFor,
  HubClient,
  hubHttpError,
  readCapped,
  README_MAX_BYTES,
  requestedRange,
  toHubFile,
  toHubModel,
} from '../../../../src/core/models/hub';
import { startFakeHub, type FakeHub } from '../../../fakes/fake-hub';

const fixture = (name: string): unknown => JSON.parse(readFileSync(path.join('test', 'fixtures', 'hf', name), 'utf8'));

describe('parsing real Hugging Face responses', () => {
  it('maps search results (GGUF and safetensors)', () => {
    const gguf = (fixture('search-qwen3-4b-gguf.json') as Record<string, unknown>[]).map(toHubModel);
    const unsloth = gguf.find((m) => m.repo === 'unsloth/Qwen3.5-4B-GGUF');
    expect(unsloth).toMatchObject({ author: 'unsloth', name: 'Qwen3.5-4B-GGUF', formats: ['gguf'], baseModel: 'Qwen/Qwen3.5-4B', license: 'apache-2.0', gated: false, paramsB: 4 });
    expect(unsloth?.downloads).toBeGreaterThan(0);
    expect(unsloth?.updatedAt).toMatch(/^20/);
    const any = (fixture('search-qwen3-4b-any.json') as Record<string, unknown>[]).map(toHubModel);
    const st = any.find((m) => m.formats.includes('safetensors'));
    expect(st?.paramsB).toBeGreaterThan(4);
    expect(st?.pipelineTag).toBeDefined();
  });

  it('maps a gated repo', () => {
    const m = toHubModel(fixture('info-llama-3.1-8b-gated.json') as Record<string, unknown>);
    expect(m).toMatchObject({ repo: 'meta-llama/Llama-3.1-8B-Instruct', gated: 'manual', license: 'llama3.1', baseModel: 'meta-llama/Meta-Llama-3.1-8B', formats: ['safetensors'] });
  });

  it('maps a real GGUF repo tree (quants, mmproj, MTP folder, LFS sha256)', () => {
    const entries = (fixture('tree-gemma-4-12b-it-gguf.json') as Record<string, unknown>[]).filter((e) => e.type === 'file');
    const files = entries.map(toHubFile);
    const byPath = new Map(files.map((f) => [f.path, f]));
    expect(byPath.get('gemma-4-12b-it-UD-Q4_K_XL.gguf')).toMatchObject({ kind: 'weights', quant: 'UD-Q4_K_XL', groupKey: 'gemma-4-12b-it-UD-Q4_K_XL.gguf' });
    expect(byPath.get('gemma-4-12b-it-Q4_K_M.gguf')?.sha256).toBe('0a270ec9fe6b34f4a0d33992b6135117b484ebc4766ab76b51d4ae8c457e4c42');
    expect(byPath.get('gemma-4-12b-it-Q4_K_M.gguf')?.sizeBytes).toBe(7121861440);
    expect(byPath.get('mmproj-F16.gguf')?.kind).toBe('mmproj');
    expect(byPath.get('MTP/mtp-gemma-4-12b-it-Q8_0.gguf')?.kind).toBe('mtp');
    expect(byPath.get('mtp-gemma-4-12b-it.gguf')?.kind).toBe('mtp');
    expect(byPath.get('MTP/README.md')?.kind).toBe('other');
    expect(byPath.get('imatrix_unsloth.gguf_file')?.kind).toBe('other');
    expect(byPath.get('.gitattributes')?.sha256).toBeUndefined();
  });
});

describe('file classification', () => {
  it('classifies repo files', () => {
    expect(fileKind('config.json')).toBe('config');
    expect(fileKind('generation_config.json')).toBe('config');
    expect(fileKind('model.safetensors.index.json')).toBe('config');
    expect(fileKind('params.json')).toBe('config');
    expect(fileKind('tokenizer.json')).toBe('tokenizer');
    expect(fileKind('tokenizer.model')).toBe('tokenizer');
    expect(fileKind('spm.model')).toBe('tokenizer');
    expect(fileKind('vocab.json')).toBe('tokenizer');
    expect(fileKind('merges.txt')).toBe('tokenizer');
    expect(fileKind('chat_template.jinja')).toBe('tokenizer');
    expect(fileKind('model-00001-of-00004.safetensors')).toBe('weights');
    expect(fileKind('pytorch_model-00001-of-00002.bin')).toBe('weights');
    expect(fileKind('eagle3-gpt-oss-20b-BF16.gguf')).toBe('other');
    expect(fileKind('Qwen3-0.6B-draft-Q8_0.gguf')).toBe('other');
    expect(fileKind('Model.Q4_K_M.mmproj-f16.gguf')).toBe('mmproj');
    expect(fileKind('LICENSE')).toBe('other');
    expect(groupKeyFor('Q4_K_M/Model-Q4_K_M-00002-of-00003.gguf')).toBe('Q4_K_M/Model-Q4_K_M');
    expect(groupKeyFor('Model-Q4_K_M-00001-of-00003.gguf')).toBe('Model-Q4_K_M');
    expect(groupKeyFor('single.gguf')).toBe('single.gguf');
  });

  it('copes with sparse entries', () => {
    expect(toHubFile({ path: 'x.bin' })).toEqual({ path: 'x.bin', sizeBytes: 0, kind: 'other' });
    expect(toHubFile({ path: 'a.gguf', size: 5, lfs: { oid: 'not-sha' } })).toEqual({ path: 'a.gguf', sizeBytes: 5, kind: 'weights', groupKey: 'a.gguf' });
    const m = toHubModel({ id: 'loner', gated: true, gguf: { total: 2e9 }, tags: ['base_model:x/y', 'base_model:quantized:x/z', 'license:mit'], cardData: { base_model: ['a/b'] } });
    expect(m).toMatchObject({ author: '', name: 'loner', gated: true, formats: ['gguf'], paramsB: 2, baseModel: 'a/b', license: 'mit' });
    expect(toHubModel({ modelId: 'o/n', tags: ['base_model:x/y'] }).baseModel).toBe('x/y');
    expect(toHubModel({ id: 'o/n' })).toEqual({ repo: 'o/n', author: 'o', name: 'n', downloads: 0, likes: 0, gated: false, formats: [], tags: [] });
  });
});

describe('HubClient against the fake hub', () => {
  let hub: FakeHub;
  let token: string | undefined;
  let client: HubClient;

  beforeAll(async () => {
    hub = await startFakeHub();
  });
  afterAll(() => hub.close());
  beforeEach(() => {
    token = undefined;
    hub.requests.length = 0;
    Object.assign(hub.behavior, { rateLimitNext: 0, failNext: undefined, ignoreRange: false, treePageSize: 0 });
    client = new HubClient({ fetch: globalThis.fetch, baseUrl: `${hub.url}/`, getToken: () => token });
  });

  it('searches with filter, sort, limit and expand fields', async () => {
    const res = await client.search(' qwen ', { format: 'gguf', sort: 'likes', limit: 500 });
    expect(res.map((m) => m.repo)).toEqual(['ggml-org/Qwen3-0.6B-GGUF']);
    const url = new URL(hub.requests[0]?.url as string, hub.url);
    expect(url.searchParams.get('search')).toBe('qwen');
    expect(url.searchParams.getAll('filter')).toEqual(['gguf']);
    expect(url.searchParams.get('sort')).toBe('likes');
    expect(url.searchParams.get('direction')).toBe('-1');
    expect(url.searchParams.get('limit')).toBe('100');
    expect(url.searchParams.getAll('expand[]')).toContain('cardData');
    const one = await client.search('', { format: 'any', limit: 0 });
    expect(one).toHaveLength(1);
    expect(new URL(hub.requests[1]?.url as string, hub.url).searchParams.get('limit')).toBe('1');
    const st = await client.search('', { format: 'safetensors' });
    expect(st.map((m) => m.repo)).toEqual(['Qwen/Qwen3-0.6B']);
    const trending = await client.search('');
    expect(trending[0]?.repo).toBe('Qwen/Qwen3-0.6B');
  });

  it('finds GGUF conversions of a base model, by tag or by name', async () => {
    expect((await client.related('Qwen/Qwen3-0.6B')).map((m) => m.repo)).toEqual(['ggml-org/Qwen3-0.6B-GGUF']);
    expect((await client.related('someone/Qwen3-0.6B')).map((m) => m.repo)).toEqual(['ggml-org/Qwen3-0.6B-GGUF']);
    expect(await client.related('ggml-org/Qwen3-0.6B-GGUF')).toEqual([]);
  });

  it('reads repo info with the commit sha', async () => {
    const info = await client.info('ggml-org/Qwen3-0.6B-GGUF');
    expect(info.sha).toBe(hub.repo('ggml-org/Qwen3-0.6B-GGUF').sha);
    expect(info.private).toBe(false);
    const pinned = await client.info('ggml-org/Qwen3-0.6B-GGUF', info.sha);
    expect(pinned.repo).toBe('ggml-org/Qwen3-0.6B-GGUF');
    await expect(client.info('private-org/secret-model')).rejects.toMatchObject({ code: 'HF_AUTH_REQUIRED' });
    token = 'hf_test_token';
    expect((await client.info('private-org/secret-model')).private).toBe(true);
    await expect(client.info('nobody/nothing')).rejects.toMatchObject({ code: 'HF_NOT_FOUND', params: { repo: 'nobody/nothing', status: 404 } });
    token = 'hf_wrong';
    await expect(client.info('ggml-org/Qwen3-0.6B-GGUF')).rejects.toMatchObject({ code: 'HF_AUTH_REQUIRED' });
  });

  it('lists files with kinds, split groups and LFS sha256, following pages', async () => {
    const files = await client.files('unsloth/Demo-31B-it-GGUF');
    const shards = files.filter((f) => f.groupKey === 'Q4_K_M/Demo-31B-it-Q4_K_M');
    expect(shards).toHaveLength(2);
    expect(shards[0]?.sha256).toBe(hub.file('unsloth/Demo-31B-it-GGUF', shards[0]?.path as string).sha256);
    expect(files.find((f) => f.path === 'mmproj-F16.gguf')?.kind).toBe('mmproj');
    expect(files.find((f) => f.path.startsWith('MTP/'))?.kind).toBe('mtp');
    hub.behavior.treePageSize = 2;
    client.clearCache();
    const paged = await client.files('unsloth/Demo-31B-it-GGUF');
    expect(paged.map((f) => f.path).sort()).toEqual(files.map((f) => f.path).sort());
    expect(hub.requests.filter((r) => r.url.includes('/tree/')).length).toBeGreaterThan(2);
    await expect(client.files('unsloth/Demo-31B-it-GGUF', 'v9')).rejects.toMatchObject({ code: 'HF_NOT_FOUND' });
  });

  it('reads the model card, capped', async () => {
    expect(await client.readme('ggml-org/Qwen3-0.6B-GGUF')).toEqual({ text: '# Qwen3 0.6B GGUF\n\nDemo model card.\n', truncated: false });
    hub.addRepo({ id: 'big/card', readme: 'x'.repeat(README_MAX_BYTES + 5000), files: [] });
    const big = await client.readme('big/card');
    expect(big.truncated).toBe(true);
    expect(big.text.length).toBe(README_MAX_BYTES);
    await expect(client.readme('unsloth/no-such')).rejects.toMatchObject({ code: 'HF_AUTH_REQUIRED' });
  });

  it('reads remote GGUF facts through Range requests (single file and split shard)', async () => {
    const single = await client.ggufFacts('ggml-org/Qwen3-0.6B-GGUF', 'Qwen3-0.6B-Q4_K_M.gguf');
    expect(single.fileBytes).toBe(96 * 1024);
    expect(single.facts).toMatchObject({ architecture: 'qwen3', blockCount: 4, quant: 'Q4_K_M', headCountKv: 8 });
    const ranged = hub.requests.filter((r) => r.origin === 'cdn');
    expect(ranged.every((r) => typeof r.headers.range === 'string')).toBe(true);
    const split = await client.ggufFacts('unsloth/Demo-31B-it-GGUF', 'Q4_K_M/Demo-31B-it-Q4_K_M-00001-of-00002.gguf');
    expect(split.facts.paramsB).toBe(31);
    expect(split.facts.bitsPerWeight).toBeUndefined();
    expect(split.facts.kv?.groups).toEqual([
      { layers: 4, kvHeads: 16, keyLength: 256, valueLength: 256, window: 1024 },
      { layers: 2, kvHeads: 4, keyLength: 512, valueLength: 512 },
    ]);
    // Cached: no new requests.
    const before = hub.requests.length;
    await client.ggufFacts('ggml-org/Qwen3-0.6B-GGUF', 'Qwen3-0.6B-Q4_K_M.gguf');
    expect(hub.requests.length).toBe(before);
  });

  it('keeps working when the CDN ignores Range', async () => {
    hub.behavior.ignoreRange = true;
    const f = await client.ggufFacts('ggml-org/Qwen3-0.6B-GGUF', 'Qwen3-0.6B-Q8_0.gguf');
    expect(f.facts.quant).toBe('Q8_0');
    expect(f.fileBytes).toBe(160 * 1024);
  });

  it('copes with servers that report no sizes, tied embeddings and one-shard "splits"', async () => {
    hub.addRepo({
      id: 'tied/Tiny-GGUF',
      files: [
        { path: 'tiny-Q4_0-00001-of-00001.gguf', gguf: { metadata: { 'general.architecture': 'llama', 'general.size_label': '1B' }, tensors: [{ name: 'token_embd.weight', shape: [8, 8], type: 0 }] } },
      ],
    });
    const f = await client.ggufFacts('tied/Tiny-GGUF', 'tiny-Q4_0-00001-of-00001.gguf');
    expect(f.facts.cpuOnlyFraction).toBeUndefined();
    expect(f.facts.bitsPerWeight).toBeGreaterThan(0);
    // A proxy that strips Content-Range / Content-Length and answers 200 to Range requests.
    const stripping = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const res = await globalThis.fetch(input, init);
      return new Response(await res.arrayBuffer(), { status: res.ok ? 200 : res.status });
    }) as typeof fetch;
    const bare = new HubClient({ fetch: stripping, baseUrl: hub.url, getToken: () => undefined });
    const g = await bare.ggufFacts('ggml-org/Qwen3-0.6B-GGUF', 'Qwen3-0.6B-Q4_K_M.gguf');
    expect(g.fileBytes).toBeUndefined();
    expect(g.facts.blockCount).toBe(4);
  });

  it('maps gated access to HF_GATED (no token, or license not accepted)', async () => {
    const file = 'gated-demo-it-Q4_K_M.gguf';
    await expect(client.ggufFacts('google/gated-demo-it', file)).rejects.toMatchObject({ code: 'HF_GATED', params: { repo: 'google/gated-demo-it', status: 401 } });
    token = 'hf_test_token';
    await expect(client.ggufFacts('google/gated-demo-it', file)).rejects.toMatchObject({ code: 'HF_GATED', params: { status: 403 } });
    hub.setAccepted('google/gated-demo-it', true);
    expect((await client.ggufFacts('google/gated-demo-it', file)).facts.name).toBe('Gated');
    const cdnReq = hub.requests.find((r) => r.origin === 'cdn');
    expect(cdnReq?.headers.authorization).toBeUndefined();
    const hubReq = hub.requests.filter((r) => r.url.includes('/resolve/')).at(-1);
    expect(hubReq?.headers.authorization).toBe('Bearer hf_test_token');
    hub.setAccepted('google/gated-demo-it', false);
  });

  it('reads safetensors facts from config.json + file list + info', async () => {
    const { facts, fileBytes } = await client.configFacts('Qwen/Qwen3-0.6B');
    expect(fileBytes).toBe(hub.file('Qwen/Qwen3-0.6B', 'model.safetensors').size);
    expect(facts).toMatchObject({ architecture: 'Qwen3ForCausalLM', blockCount: 28, headCountKv: 8, quant: 'BF16', paramsB: 0.752, name: 'Qwen/Qwen3-0.6B' });
    hub.addRepo({ id: 'nobody/no-params', files: [{ path: 'config.json', content: '{"num_hidden_layers": 2}' }] });
    expect((await client.configFacts('nobody/no-params')).facts.paramsB).toBeUndefined();
  });

  it('maps rate limits, server errors, bad payloads and network failures', async () => {
    hub.behavior.rateLimitNext = 1;
    await expect(client.search('a')).rejects.toMatchObject({ code: 'HF_RATE_LIMITED' });
    hub.behavior.failNext = { status: 503, times: 1 };
    await expect(client.search('zzz-none')).rejects.toMatchObject({ code: 'NETWORK', params: { status: 503 } });
    // Failures are not cached.
    expect(await client.search('zzz-none')).toEqual([]);

    const garbage = new HubClient({ fetch: (async () => new Response('<html>', { status: 200 })) as typeof fetch, baseUrl: hub.url, getToken: () => undefined });
    await expect(garbage.search('x')).rejects.toMatchObject({ code: 'NETWORK' });
    const notArray = new HubClient({ fetch: (async () => Response.json({ a: 1 })) as typeof fetch, baseUrl: hub.url, getToken: () => undefined });
    await expect(notArray.search('x')).rejects.toMatchObject({ code: 'NETWORK' });
    await expect(notArray.files('a/b')).rejects.toMatchObject({ code: 'NETWORK' });
    expect(await notArray.info('a/b')).toMatchObject({ repo: 'a/b' });
    const nullInfo = new HubClient({ fetch: (async () => Response.json(null)) as typeof fetch, baseUrl: hub.url, getToken: () => undefined });
    expect((await nullInfo.info('a/b')).sha).toBeUndefined();
    const weirdTree = new HubClient({ fetch: (async () => Response.json([null, { type: 'file' }, { type: 'directory', path: 'd' }, { type: 'file', path: 'x.gguf', size: 1 }])) as typeof fetch, baseUrl: hub.url, getToken: () => undefined });
    expect((await weirdTree.files('a/b')).map((f) => f.path)).toEqual(['x.gguf']);
    const searchJunk = new HubClient({ fetch: (async () => Response.json([null, { id: 'noslash' }, { id: 'o/n' }])) as typeof fetch, baseUrl: hub.url, getToken: () => undefined });
    expect((await searchJunk.search('')).map((m) => m.repo)).toEqual(['o/n']);

    const offline = new HubClient({ fetch: globalThis.fetch, baseUrl: 'http://127.0.0.1:9', getToken: () => undefined });
    await expect(offline.search('x')).rejects.toMatchObject({ code: 'NETWORK' });
    const aborting = new HubClient({
      fetch: (() => Promise.reject(new DOMException('stop', 'AbortError'))) as typeof fetch,
      baseUrl: hub.url,
      getToken: () => undefined,
    });
    await expect(aborting.search('x')).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('caches by token presence with TTL and bounded size', async () => {
    let now = 0;
    const c = new HubClient({ fetch: globalThis.fetch, baseUrl: hub.url, getToken: () => token, now: () => now, cacheTtlMs: 1000, maxCacheEntries: 2 });
    await c.search('qwen');
    await c.search('qwen');
    expect(hub.requests).toHaveLength(1);
    token = 'hf_test_token';
    await c.search('qwen');
    expect(hub.requests).toHaveLength(2);
    now = 5000;
    await c.search('qwen');
    expect(hub.requests).toHaveLength(3);
    await c.search('a');
    await c.search('b');
    now = 5001;
    await c.search('qwen');
    expect(hub.requests).toHaveLength(6);
  });

  it('sends the token only to the hub origin and encodes resolve URLs', () => {
    expect(client.authHeaders(`${hub.url}/x`)).toEqual({});
    token = 'hf_test_token';
    expect(client.authHeaders(`${hub.url}/api/models`)).toEqual({ authorization: 'Bearer hf_test_token' });
    expect(client.authHeaders(`${hub.cdnUrl}/cdn/x`)).toEqual({});
    expect(client.resolveUrl('o/n', 'refs/pr/1', 'dir/a b#.gguf')).toBe(`${hub.url}/o/n/resolve/refs%2Fpr%2F1/dir/a%20b%23.gguf`);
  });
});

describe('HTTP helpers', () => {
  it('maps HF error responses', () => {
    const r = (status: number, headers: Record<string, string> = {}) => new Response(null, { status, headers });
    expect(hubHttpError(r(401, { 'x-error-code': 'GatedRepo' }), 'a/b')).toMatchObject({ code: 'HF_GATED', params: { repo: 'a/b' } });
    expect(hubHttpError(r(403))).toMatchObject({ code: 'HF_GATED', message: expect.stringContaining('the repo') });
    expect(hubHttpError(r(401, { 'x-error-message': 'Invalid username or password.' }))).toMatchObject({ code: 'HF_AUTH_REQUIRED', detail: 'Invalid username or password.' });
    expect(hubHttpError(r(404, { 'x-error-code': 'EntryNotFound' })).message).toContain('EntryNotFound');
    expect(hubHttpError(r(404)).message).toContain('HTTP 404');
    expect(hubHttpError(r(429)).code).toBe('HF_RATE_LIMITED');
    expect(hubHttpError(r(502))).toMatchObject({ code: 'NETWORK', params: { status: 502 } });
  });

  it('discards bodies safely', async () => {
    await discardBody(new Response('x'));
    await discardBody(new Response(null, { status: 204 }));
    const used = new Response('y');
    const reader = used.body?.getReader();
    await expect(discardBody(used)).resolves.toBeUndefined();
    reader?.releaseLock();
  });

  it('reads a capped slice of a stream', async () => {
    const res = () => new Response(new Blob([new Uint8Array([0, 1, 2]), new Uint8Array([3, 4, 5]), new Uint8Array([6, 7])]).stream());
    expect(Array.from((await readCapped(res(), 5, 2)).bytes)).toEqual([2, 3, 4]);
    expect(Array.from((await readCapped(res(), 6, 4)).bytes)).toEqual([4, 5]);
    expect(await readCapped(res(), 100)).toMatchObject({ truncated: false });
    expect((await readCapped(res(), 8)).truncated).toBe(false);
    const cut = await readCapped(res(), 4);
    expect(cut.truncated).toBe(true);
    expect(Array.from(cut.bytes)).toEqual([0, 1, 2, 3]);
    expect(requestedRange({ headers: { range: 'bytes=10-19' } })).toEqual([10, 19]);
    expect(() => requestedRange({})).toThrow(/explicit byte range/);
  });
});
