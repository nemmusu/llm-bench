import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../../../../src/contract/errors';
import { LlamaCppClient } from '../../../../src/core/inference/llamacpp-client';
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

describe('LlamaCppClient', () => {
  it('ready(): 200 true, 503 false, unreachable false', async () => {
    let status = 503;
    server = await startServer((_req, res) => sendJson(res, status, status === 200 ? { status: 'ok' } : { error: { message: 'Loading model', code: 503 } }));
    const c = new LlamaCppClient(server.url, deps());
    expect(c.flavor).toBe('llamacpp');
    expect(c.baseUrl).toBe(server.url);
    expect(await c.ready()).toBe(false);
    status = 200;
    expect(await c.ready()).toBe(true);
    expect(server.requests.at(-1)?.url).toBe('/health');
    expect(await new LlamaCppClient('http://127.0.0.1:1', deps()).ready()).toBe(false);
  });

  it('ready() rethrows cancellation', async () => {
    const ac = new AbortController();
    ac.abort();
    const c = new LlamaCppClient('http://127.0.0.1:1', { clock: steppingClock(), fetch: async () => Promise.reject(new Error('aborted')) });
    await expect(c.ready(ac.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('tokenize() posts content/add_special and sends the API key', async () => {
    server = await startServer((req, res) => sendJson(res, 200, { tokens: JSON.parse(req.body).add_special ? [1, 9, 10] : [9, 10] }));
    const c = new LlamaCppClient(server.url, deps(), { apiKey: 'secret' });
    expect(await c.tokenize('Hello')).toEqual([9, 10]);
    expect(await c.tokenize('Hello', { addSpecial: true, signal: new AbortController().signal })).toEqual([1, 9, 10]);
    expect(JSON.parse(server.requests[0]?.body ?? '')).toEqual({ content: 'Hello', add_special: false });
    expect(server.requests[0]?.headers.authorization).toBe('Bearer secret');
  });

  it('tokenize() maps HTTP errors', async () => {
    server = await startServer((_req, res) => sendJson(res, 400, { error: { message: 'bad', code: 400 } }));
    await expect(new LlamaCppClient(server.url, deps()).tokenize('x')).rejects.toMatchObject({ code: 'ENDPOINT_INVALID' });
  });

  it('models() lists ids and maps errors', async () => {
    let ok = true;
    server = await startServer((_req, res) => (ok ? sendJson(res, 200, { data: [{ id: 'm1' }, { id: 'm2' }] }) : sendJson(res, 404, { error: 'File Not Found' })));
    const c = new LlamaCppClient(server.url, deps());
    expect(await c.models()).toEqual(['m1', 'm2']);
    expect(server.requests[0]?.url).toBe('/v1/models');
    ok = false;
    await expect(c.models()).rejects.toMatchObject({ code: 'ENDPOINT_INVALID', params: { reason: 'not_found' } });
  });

  it('requestBody() is the exact /completion body', () => {
    const c = new LlamaCppClient('http://x', deps());
    expect(c.requestBody({ promptIds: [1, 2, 3], outputTokens: 128, seed: 42 })).toEqual({
      prompt: [1, 2, 3],
      n_predict: 128,
      ignore_eos: true,
      temperature: 0,
      seed: 42,
      cache_prompt: false,
      return_tokens: true,
      stream: true,
    });
    expect(c.requestBody({ promptText: 'hi', outputTokens: 1, seed: 1 }).prompt).toBe('hi');
    expect(c.requestBody({ outputTokens: 1, seed: 1 }).prompt).toBe('');
  });

  it('generate() streams chunks with token counts and ends with usage + timings', async () => {
    server = await startServer((_req, res) =>
      sendSse(res, [
        { content: 'Hel', tokens: [10], stop: false },
        { content: '', tokens: [], stop: false },
        { content: 'lo wor', tokens: [11, 12], stop: false },
        { tokens: [13] },
        { unrelated: true, stop: 'not-a-boolean' },
        {
          content: '',
          tokens: [],
          stop: true,
          stop_type: 'limit',
          tokens_predicted: 3,
          tokens_evaluated: 512,
          timings: { prompt_n: 512, prompt_ms: 40, predicted_n: 3, predicted_ms: 20, draft_n: 4, draft_n_accepted: 3 },
        },
      ]),
    );
    const c = new LlamaCppClient(server.url, deps());
    const events = await collect(c.generate({ promptIds: [1, 2], outputTokens: 3, seed: 7 }));
    expect(events.map((e) => e.kind)).toEqual(['chunk', 'chunk', 'chunk', 'chunk', 'done']);
    expect(events[3]).toMatchObject({ textLen: 0, tokens: 1 });
    events.splice(3, 1);
    expect(events[0]).toMatchObject({ kind: 'chunk', textLen: 3, tokens: 1 });
    expect(events[1]).toMatchObject({ textLen: 0, tokens: 0 });
    expect(events[2]).toMatchObject({ textLen: 6, tokens: 2 });
    expect(events[3]).toEqual({
      kind: 'done',
      t: expect.any(Number),
      usage: { promptTokens: 512, completionTokens: 3 },
      timings: { promptN: 512, promptMs: 40, predictedN: 3, predictedMs: 20, draftN: 4, draftNAccepted: 3 },
      finishReason: 'length',
    });
    const ts = events.map((e) => e.t);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
    expect(JSON.parse(server.requests[0]?.body ?? '')).toMatchObject({ prompt: [1, 2], n_predict: 3, stream: true });
    expect(server.requests[0]?.url).toBe('/completion');
  });

  it('generate() reports text carried by the final chunk and maps stop types', async () => {
    const finals = [
      { content: 'end', stop: true, stop_type: 'eos', timings: { prompt_n: 4 } },
      { content: '', tokens: [5], stop: true, stop_type: 'word' },
      { stop: true, stop_type: 'none', timings: { predicted_n: 2 } },
      { stop: true },
    ];
    let i = 0;
    server = await startServer((_req, res) => sendSse(res, [finals[i++]]));
    const c = new LlamaCppClient(server.url, deps());
    const a = await collect(c.generate({ promptText: 'x', outputTokens: 1, seed: 1 }));
    expect(a.map((e) => e.kind)).toEqual(['chunk', 'done']);
    expect(a[1]).toMatchObject({ finishReason: 'stop', usage: { promptTokens: 4 }, timings: { promptN: 4 } });
    const b = await collect(c.generate({ promptText: 'x', outputTokens: 1, seed: 1 }));
    expect(b[0]).toMatchObject({ kind: 'chunk', tokens: 1, textLen: 0 });
    expect(b[1]).toMatchObject({ finishReason: 'stop' });
    expect(b[1]).not.toHaveProperty('usage');
    const d = await collect(c.generate({ promptText: 'x', outputTokens: 1, seed: 1 }));
    expect(d).toEqual([{ kind: 'done', t: expect.any(Number), usage: { completionTokens: 2 }, timings: { predictedN: 2 }, finishReason: 'none' }]);
    const e = await collect(c.generate({ promptText: 'x', outputTokens: 1, seed: 1 }));
    expect(e).toEqual([{ kind: 'done', t: expect.any(Number) }]);
  });

  it('generate() fails on HTTP errors, in-stream errors and truncated streams', async () => {
    let mode = 'http';
    server = await startServer((_req, res) => {
      if (mode === 'http') sendJson(res, 400, { error: { code: 400, message: 'the request exceeds the available context size' } });
      else if (mode === 'payload') sendSse(res, [{ content: 'a', stop: false }, { error: { code: 500, message: 'CUDA error: out of memory' } }]);
      else sendSse(res, [{ content: 'a', stop: false }]);
    });
    const c = new LlamaCppClient(server.url, deps());
    const run = () => collect(c.generate({ promptIds: [1], outputTokens: 4, seed: 1 }, new AbortController().signal));
    await expect(run()).rejects.toMatchObject({ code: 'ENDPOINT_INVALID', params: { reason: 'context_exceeded' } });
    mode = 'payload';
    await expect(run()).rejects.toMatchObject({ code: 'ENGINE_OOM' });
    mode = 'truncated';
    const err = await run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).message).toContain('ended before the final chunk');
  });
});
