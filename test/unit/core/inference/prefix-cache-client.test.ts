import { afterEach, describe, expect, it } from 'vitest';
import { OpenAiClient } from '../../../../src/core/inference/openai-client';
import { sendJson, startServer, steppingClock, type TestServer } from './helpers';

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const deps = () => ({ fetch: globalThis.fetch, clock: steppingClock() });

describe('OpenAiClient: the prefix cache vLLM counts itself', () => {
  it('reads /metrics; nothing for other servers, a missing endpoint or no counters; cancellation still throws', async () => {
    let status = 200;
    let text = 'vllm:prefix_cache_queries_total{model_name="m"} 100\nvllm:prefix_cache_hits_total{model_name="m"} 60\n';
    server = await startServer((req, res) => {
      if (req.url !== '/metrics') return sendJson(res, 404, {});
      res.writeHead(status, { 'content-type': 'text/plain' });
      res.end(text);
    });
    const c = new OpenAiClient('vllm', server.url, deps());
    expect(await c.prefixCache()).toEqual({ queries: 100, hits: 60 });
    text = 'vllm:num_requests_running 0\n';
    expect(await c.prefixCache()).toBeUndefined();
    status = 404;
    expect(await c.prefixCache()).toBeUndefined();
    expect(await new OpenAiClient('openai', server.url, deps()).prefixCache()).toBeUndefined();
    expect(await new OpenAiClient('vllm', 'http://127.0.0.1:9', deps()).prefixCache()).toBeUndefined();
    const ac = new AbortController();
    ac.abort();
    await expect(c.prefixCache(ac.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
