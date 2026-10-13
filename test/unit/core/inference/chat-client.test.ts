import { afterEach, describe, expect, it } from 'vitest';
import { ChatClient, CONTINUE_INSTRUCTION } from '../../../../src/core/inference/chat-client';
import { createInferenceClient } from '../../../../src/core/inference/client';
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

describe('ChatClient', () => {
  it('is the openai-chat flavor of createInferenceClient', () => {
    const c = createInferenceClient('openai-chat', 'http://x', deps(), { model: 'm' });
    expect(c).toBeInstanceOf(ChatClient);
    expect(c.flavor).toBe('openai-chat');
    expect(c.baseUrl).toBe('http://x');
  });

  it('ready(): /v1/models answers, and lists the model when one is configured', async () => {
    let status = 503;
    let models: string[] = [];
    server = await startServer((_req, res) => sendJson(res, status, { object: 'list', data: models.map((id) => ({ id })) }));
    const any = new ChatClient(server.url, deps());
    const named = new ChatClient(server.url, deps(), { model: 'gpubench-1' });
    expect(await any.ready()).toBe(false);
    expect(await named.ready()).toBe(false);
    status = 200;
    expect(await any.ready()).toBe(true);
    expect(await named.ready()).toBe(false);
    models = ['gpubench-1'];
    expect(await named.ready()).toBe(true);
    expect(await new ChatClient('http://127.0.0.1:1', deps()).ready()).toBe(false);
  });

  it('ready(): cancellation throws', async () => {
    const ac = new AbortController();
    ac.abort();
    const c = new ChatClient('http://x', { clock: steppingClock(), fetch: async () => Promise.reject(new Error('aborted')) });
    await expect(c.ready(ac.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('tokenize() is unsupported (text prompts)', async () => {
    await expect(new ChatClient('http://x', deps()).tokenize()).rejects.toMatchObject({ code: 'ENDPOINT_INVALID', params: { reason: 'tokenize_unsupported' } });
  });

  it('models() lists ids, sends the key and maps errors', async () => {
    let ok = true;
    server = await startServer((_req, res) => (ok ? sendJson(res, 200, { data: [{ id: 'qwen3.8-27b' }] }) : sendJson(res, 401, { error: { message: 'bad key' } })));
    const c = new ChatClient(server.url, deps(), { apiKey: 'k' });
    expect(await c.models()).toEqual(['qwen3.8-27b']);
    expect(server.requests[0]?.headers.authorization).toBe('Bearer k');
    ok = false;
    await expect(c.models()).rejects.toMatchObject({ code: 'ENDPOINT_INVALID', params: { reason: 'auth' } });
  });

  it('requestBody(): one user message after the instruction, standard fields only', () => {
    const c = new ChatClient('http://x', deps(), { model: 'gpubench-1' });
    expect(c.requestBody({ promptText: 'Once upon a time', outputTokens: 128, seed: 42 })).toEqual({
      model: 'gpubench-1',
      messages: [{ role: 'user', content: `${CONTINUE_INSTRUCTION}Once upon a time` }],
      max_tokens: 128,
      temperature: 0,
      seed: 42,
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(c.requestBody({ promptText: 't', outputTokens: 1, seed: 1, model: 'other' })).toMatchObject({ model: 'other' });
    const bare = new ChatClient('http://x', deps()).requestBody({ outputTokens: 1, seed: 1 });
    expect(bare).not.toHaveProperty('model');
    expect(bare.messages).toEqual([{ role: 'user', content: CONTINUE_INSTRUCTION }]);
  });

  it('generate(): role chunk, reasoning and content deltas, usage and timings at the end', async () => {
    server = await startServer((_req, res) =>
      sendSse(res, [
        { choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { reasoning_content: 'hmm' } }] },
        { choices: [{ index: 0, delta: { reasoning: 'ok', content: null } }] },
        { choices: [{ index: 0, delta: { content: 'AB' } }] },
        { choices: 'garbage' },
        { choices: [{ index: 0 }] },
        { choices: [{ index: 0, delta: null, finish_reason: 'length' }] },
        {
          choices: [],
          usage: { prompt_tokens: 4096, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 0 } },
          timings: { cache_n: 0, prompt_n: 4096, prompt_ms: 80, predicted_n: 4, predicted_ms: 30, draft_n: 6, draft_n_accepted: 3 },
        },
        '[DONE]',
      ]),
    );
    const c = new ChatClient(server.url, deps(), { model: 'm' });
    const events = await collect(c.generate({ promptText: 'p', outputTokens: 4, seed: 1 }, new AbortController().signal));
    expect(events.map((e) => (e.kind === 'chunk' ? (e.text ?? '') : 'done'))).toEqual(['', 'hmm', 'ok', 'AB', '', '', 'done']);
    expect(events.at(-1)).toEqual({
      kind: 'done',
      t: expect.any(Number),
      usage: { promptTokens: 4096, completionTokens: 4, cachedTokens: 0 },
      timings: { cacheN: 0, promptN: 4096, promptMs: 80, predictedN: 4, predictedMs: 30, draftN: 6, draftNAccepted: 3 },
      finishReason: 'length',
    });
    const req = server.requests[0];
    expect(req?.url).toBe('/v1/chat/completions');
    expect(JSON.parse(req?.body ?? '')).toMatchObject({ model: 'm', max_tokens: 4 });
  });

  it('generate(): a stream without usage still ends with done', async () => {
    server = await startServer((_req, res) => sendSse(res, [{ choices: [{ delta: { content: 'hi' } }] }, {}, { choices: [], usage: null }]));
    const events = await collect(new ChatClient(server.url, deps()).generate({ promptText: 'p', outputTokens: 2, seed: 1 }));
    expect(events).toEqual([
      { kind: 'chunk', t: expect.any(Number), textLen: 2, text: 'hi' },
      { kind: 'done', t: expect.any(Number) },
    ]);
  });

  it('generate(): token-id prompts are refused, HTTP and in-stream errors mapped', async () => {
    let mode = 'http';
    server = await startServer((_req, res) => {
      if (mode === 'http') sendJson(res, 400, { error: { message: 'context_length_exceeded: maximum context is 8192', code: 400 } });
      else sendSse(res, [{ error: { message: 'out of memory', code: 500 } }]);
    });
    const c = new ChatClient(server.url, deps());
    await expect(collect(c.generate({ promptIds: [1], outputTokens: 1, seed: 1 }))).rejects.toMatchObject({ params: { reason: 'token_ids_unsupported' } });
    await expect(collect(c.generate({ promptText: 'x', outputTokens: 1, seed: 1 }))).rejects.toMatchObject({ params: { reason: 'context_exceeded' } });
    mode = 'stream';
    await expect(collect(c.generate({ promptText: 'x', outputTokens: 1, seed: 1 }))).rejects.toMatchObject({ code: 'ENGINE_OOM' });
  });
});
