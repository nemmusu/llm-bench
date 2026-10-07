import { afterEach, describe, expect, it } from 'vitest';
import { createInferenceClient } from '../../../../src/core/inference/client';
import { LlamaCppClient } from '../../../../src/core/inference/llamacpp-client';
import { OpenAiClient } from '../../../../src/core/inference/openai-client';
import type { StreamEvent } from '../../../../src/core/inference/types';
import { sendJson, sendSse, startServer, steppingClock, type TestServer } from './helpers';

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const deps = () => ({ fetch: globalThis.fetch, clock: steppingClock() });

describe('createInferenceClient', () => {
  it('picks the client by flavor', () => {
    expect(createInferenceClient('llamacpp', 'http://x', deps())).toBeInstanceOf(LlamaCppClient);
    const v = createInferenceClient('vllm', 'http://x', deps(), { model: 'm' });
    expect(v).toBeInstanceOf(OpenAiClient);
    expect(v.flavor).toBe('vllm');
    expect(createInferenceClient('openai', 'http://x', deps()).flavor).toBe('openai');
  });
});

describe('OpenAiClient (vLLM)', () => {
  it('ready(): needs /health 200 and the model listed', async () => {
    let health = 503;
    let models: string[] = [];
    server = await startServer((req, res) => {
      if (req.url === '/health') sendJson(res, health, {});
      else sendJson(res, 200, { object: 'list', data: models.map((id) => ({ id, object: 'model' })) });
    });
    const c = new OpenAiClient('vllm', server.url, deps(), { model: 'qwen' });
    expect(await c.ready()).toBe(false);
    health = 200;
    expect(await c.ready()).toBe(false);
    models = ['qwen'];
    expect(await c.ready()).toBe(true);
    // Without a configured model any listed model means ready.
    const anyModel = new OpenAiClient('vllm', server.url, deps());
    expect(await anyModel.ready()).toBe(true);
    models = [];
    expect(await anyModel.ready()).toBe(false);
  });

  it('ready(): unreachable is false, cancellation throws', async () => {
    expect(await new OpenAiClient('vllm', 'http://127.0.0.1:1', deps()).ready()).toBe(false);
    const ac = new AbortController();
    ac.abort();
    const c = new OpenAiClient('openai', 'http://x', { clock: steppingClock(), fetch: async () => Promise.reject(new Error('aborted')) });
    await expect(c.ready(ac.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('tokenize() posts model/prompt/add_special_tokens', async () => {
    server = await startServer((req, res) => {
      if (req.url !== '/tokenize') return sendJson(res, 404, {});
      const b = JSON.parse(req.body);
      sendJson(res, 200, { count: 2, max_model_len: 4096, tokens: b.add_special_tokens ? [1, 5, 6] : [5, 6] });
    });
    const c = new OpenAiClient('vllm', server.url, deps(), { model: 'qwen', apiKey: 'k' });
    expect(await c.tokenize('hi')).toEqual([5, 6]);
    expect(await c.tokenize('hi', { addSpecial: true, signal: new AbortController().signal })).toEqual([1, 5, 6]);
    expect(JSON.parse(server.requests[0]?.body ?? '')).toEqual({ model: 'qwen', prompt: 'hi', add_special_tokens: false });
    expect(server.requests[0]?.headers.authorization).toBe('Bearer k');
  });

  it('tokenize() maps HTTP errors', async () => {
    server = await startServer((_req, res) => sendJson(res, 404, { detail: 'Not Found' }));
    await expect(new OpenAiClient('vllm', server.url, deps()).tokenize('x')).rejects.toMatchObject({ code: 'ENDPOINT_INVALID' });
  });

  it('models() lists ids and maps errors', async () => {
    let ok = true;
    server = await startServer((_req, res) => (ok ? sendJson(res, 200, { data: [{ id: 'a' }] }) : sendJson(res, 401, { error: { message: 'bad key' } })));
    const c = new OpenAiClient('vllm', server.url, deps());
    expect(await c.models()).toEqual(['a']);
    ok = false;
    await expect(c.models()).rejects.toMatchObject({ code: 'ENDPOINT_INVALID', params: { reason: 'auth' } });
  });

  it('requestBody(): exact length controls for vLLM', () => {
    const c = new OpenAiClient('vllm', 'http://x', deps(), { model: 'qwen' });
    expect(c.requestBody({ promptIds: [1, 2], outputTokens: 256, seed: 42 })).toEqual({
      model: 'qwen',
      prompt: [1, 2],
      max_tokens: 256,
      temperature: 0,
      seed: 42,
      stream: true,
      stream_options: { include_usage: true, continuous_usage_stats: true },
      min_tokens: 256,
      ignore_eos: true,
    });
    expect(c.requestBody({ promptText: 't', outputTokens: 1, seed: 1, model: 'other' })).toMatchObject({ model: 'other', prompt: 't' });
    expect(c.requestBody({ outputTokens: 1, seed: 1 }).prompt).toBe('');
  });

  it('generate(): exact tokens per chunk from continuous usage, final usage chunk → done', async () => {
    server = await startServer((_req, res) =>
      sendSse(
        res,
        [
          { choices: [{ index: 0, text: 'A', finish_reason: null }], usage: { prompt_tokens: 512, completion_tokens: 1 } },
          { choices: [{ index: 0, text: 'BC', finish_reason: null }], usage: { prompt_tokens: 512, completion_tokens: 3 } },
          { choices: 'garbage' },
          { choices: [{ index: 0, text: 'D', finish_reason: 'length' }], usage: { prompt_tokens: 512, completion_tokens: 4 } },
          { choices: [], usage: { prompt_tokens: 512, completion_tokens: 4, total_tokens: 516 } },
          '[DONE]',
        ],
      ),
    );
    const c = new OpenAiClient('vllm', server.url, deps(), { model: 'qwen' });
    const events = await collect(c.generate({ promptIds: [1], outputTokens: 4, seed: 1 }, new AbortController().signal));
    expect(events.map((e) => (e.kind === 'chunk' ? e.tokens : 'done'))).toEqual([1, 2, 1, 'done']);
    expect(events[1]).toMatchObject({ textLen: 2 });
    expect(events[3]).toMatchObject({ kind: 'done', usage: { promptTokens: 512, completionTokens: 4 }, finishReason: 'length' });
    expect(server.requests[0]?.url).toBe('/v1/completions');
  });

  it('generate(): maps HTTP and in-stream errors', async () => {
    let mode = 'http';
    server = await startServer((_req, res) => {
      if (mode === 'http') sendJson(res, 404, { object: 'error', message: 'The model `x` does not exist.', code: 404 });
      else sendSse(res, [{ error: { object: 'error', message: 'maximum context length is 2048 tokens', code: 400 } }]);
    });
    const c = new OpenAiClient('vllm', server.url, deps(), { model: 'x' });
    await expect(collect(c.generate({ promptIds: [1], outputTokens: 4, seed: 1 }))).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' });
    mode = 'stream';
    await expect(collect(c.generate({ promptIds: [1], outputTokens: 4, seed: 1 }))).rejects.toMatchObject({
      params: { reason: 'context_exceeded' },
    });
  });
});

describe('OpenAiClient (generic OpenAI)', () => {
  it('ready() is /v1/models answering', async () => {
    let status = 500;
    server = await startServer((_req, res) => sendJson(res, status, { data: [] }));
    const c = new OpenAiClient('openai', server.url, deps());
    expect(await c.ready()).toBe(false);
    status = 200;
    expect(await c.ready()).toBe(true);
  });

  it('tokenize() is unsupported', async () => {
    await expect(new OpenAiClient('openai', 'http://x', deps()).tokenize('x')).rejects.toMatchObject({
      code: 'ENDPOINT_INVALID',
      params: { reason: 'tokenize_unsupported' },
    });
  });

  it('requestBody() sends only standard fields', () => {
    const body = new OpenAiClient('openai', 'http://x', deps()).requestBody({ promptText: 'p', outputTokens: 8, seed: 3 });
    expect(body).toEqual({ prompt: 'p', max_tokens: 8, temperature: 0, seed: 3, stream: true, stream_options: { include_usage: true } });
  });

  it('generate() without usage: chunks without token counts, done at end of stream', async () => {
    server = await startServer((_req, res) => sendSse(res, [{ choices: [{ text: 'hi' }] }, { choices: [{ text: '' }, {}] }, { choices: [], usage: null }]));
    const c = new OpenAiClient('openai', server.url, deps());
    const events = await collect(c.generate({ promptText: 'p', outputTokens: 2, seed: 1 }));
    expect(events).toEqual([
      { kind: 'chunk', t: expect.any(Number), textLen: 2, text: 'hi' },
      { kind: 'chunk', t: expect.any(Number), textLen: 0 },
      { kind: 'done', t: expect.any(Number) },
    ]);
  });

  it('generate() with partial usage objects and usage-only chunks', async () => {
    server = await startServer((_req, res) =>
      sendSse(res, [{ choices: [{ text: 'a' }], usage: { prompt_tokens: 3 } }, { usage: { completion_tokens: 1 } }]),
    );
    const c = new OpenAiClient('openai', server.url, deps());
    const events = await collect(c.generate({ promptText: 'p', outputTokens: 1, seed: 1 }));
    expect(events).toEqual([
      { kind: 'chunk', t: expect.any(Number), textLen: 1, text: 'a' },
      { kind: 'done', t: expect.any(Number), usage: { completionTokens: 1 } },
    ]);
  });
});
