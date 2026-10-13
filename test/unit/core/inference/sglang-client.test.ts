import { afterEach, describe, expect, it } from 'vitest';
import { createInferenceClient } from '../../../../src/core/inference/client';
import { OpenAiClient } from '../../../../src/core/inference/openai-client';
import type { StreamEvent } from '../../../../src/core/inference/types';
import { sendJson, sendSse, startServer, steppingClock, type TestServer } from './helpers';

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});
const deps = () => ({ fetch: globalThis.fetch, clock: steppingClock() });

describe('OpenAiClient (SGLang)', () => {
  it('is built for the sglang flavor and speaks like vLLM', async () => {
    const c = createInferenceClient('sglang', 'http://x', deps(), { model: 'm' });
    expect(c).toBeInstanceOf(OpenAiClient);
    expect(c.flavor).toBe('sglang');
    expect(c.requestBody({ promptIds: [1, 2], outputTokens: 8, seed: 3 })).toMatchObject({ model: 'm', prompt: [1, 2], min_tokens: 8, ignore_eos: true, stream_options: { include_usage: true, continuous_usage_stats: true } });
    expect(await (c as OpenAiClient).prefixCache()).toBeUndefined();
  });

  it('ready() needs /health and the served name', async () => {
    server = await startServer((req, res) => (req.url === '/health' ? sendJson(res, 200, {}) : sendJson(res, 200, { data: [{ id: 'gpubench-1' }] })));
    expect(await new OpenAiClient('sglang', server.url, deps(), { model: 'gpubench-1' }).ready()).toBe(true);
    expect(await new OpenAiClient('sglang', server.url, deps(), { model: 'other' }).ready()).toBe(false);
  });

  it('tokenizes with /tokenize; a build without it falls back to text prompts', async () => {
    let status = 200;
    server = await startServer((req, res) => {
      if (req.url !== '/tokenize') return sendJson(res, 404, {});
      if (status !== 200) return sendJson(res, status, { detail: 'Not Found' });
      return sendJson(res, 200, { tokens: [1, 7, 8], count: 3, max_model_len: 4096 });
    });
    const c = new OpenAiClient('sglang', server.url, deps(), { model: 'm' });
    expect(await c.tokenize('hello', { addSpecial: true })).toEqual([1, 7, 8]);
    status = 404;
    await expect(c.tokenize('hello')).rejects.toMatchObject({ code: 'ENDPOINT_INVALID', params: { reason: 'tokenize_unsupported' } });
    status = 405;
    await expect(c.tokenize('hello')).rejects.toMatchObject({ params: { reason: 'tokenize_unsupported' } });
    status = 500;
    await expect(c.tokenize('hello')).rejects.toMatchObject({ code: 'ENDPOINT_INVALID' });
  });

  it('reads the cached prompt tokens SGLang reports', async () => {
    server = await startServer((_req, res) =>
      sendSse(res, [
        { choices: [{ text: 'ab', finish_reason: null }], usage: { prompt_tokens: 10, completion_tokens: 1 } },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 9 } } },
      ]),
    );
    const out: StreamEvent[] = [];
    for await (const e of new OpenAiClient('sglang', server.url, deps(), { model: 'm' }).generate({ promptIds: [1], outputTokens: 2, seed: 1 })) out.push(e);
    expect(out.at(-1)).toMatchObject({ kind: 'done', usage: { promptTokens: 10, completionTokens: 2, cachedTokens: 9 } });
  });
});
