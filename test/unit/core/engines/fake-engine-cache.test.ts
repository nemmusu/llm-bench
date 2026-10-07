import { afterEach, describe, expect, it } from 'vitest';
import { parseKvCapacity } from '../../../../src/core/engines/shared/kv-capacity';
import { parseLoadProgress } from '../../../../src/core/engines/shared/load-progress';
import { commonPrefix, startFakeEngine, type FakeEngine } from '../../../fakes/fake-engine/server.mjs';

const engines: FakeEngine[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.close();
});

async function start(o: Parameters<typeof startFakeEngine>[0]) {
  const lines: string[] = [];
  const e = await startFakeEngine({ ...o, log: (l) => lines.push(l) });
  engines.push(e);
  await e.loaded;
  return { e, lines };
}

const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const prompt = (n: number, from = 0) => Array.from({ length: n }, (_, i) => 100 + from + i);

describe('fake engine: prefix cache and one-at-a-time reading', () => {
  it('commonPrefix', () => {
    expect(commonPrefix([1, 2, 3], [1, 2, 4])).toBe(2);
    expect(commonPrefix([], [1])).toBe(0);
  });

  it('llama.cpp: a slot reuses its last prompt + answer with cache_prompt, never without', async () => {
    const { e } = await start({ flavor: 'llamacpp', ctx: 8192, np: 2, profile: { loadMsWarm: 1, prefillTps: 100_000, decodeTps: 5000 } });
    const first = await (await post(`${e.url}/completion`, { prompt: prompt(400), n_predict: 4, ignore_eos: true, cache_prompt: true, id_slot: 1, return_tokens: true })).json();
    expect(first).toMatchObject({ id_slot: 1, timings: { cache_n: 0, prompt_n: 400 } });
    // The fake generates 1000 + ((seed × 7919 + k × 104729) mod 30000), seed = 1 + task number.
    const answer = [1, 2, 3, 4].map((k) => 1000 + ((1 * 7919 + k * 104729) % 30000));
    const again = await (await post(`${e.url}/completion`, { prompt: [...prompt(400), ...answer, 7, 8], n_predict: 4, ignore_eos: true, cache_prompt: true, id_slot: 1 })).json();
    expect(again.timings).toMatchObject({ cache_n: 404, prompt_n: 2 });
    // Another slot, or the cache off: everything is read again.
    const other = await (await post(`${e.url}/completion`, { prompt: prompt(400), n_predict: 1, cache_prompt: true, id_slot: 0 })).json();
    expect(other.timings.cache_n).toBe(0);
    const off = await (await post(`${e.url}/completion`, { prompt: prompt(400), n_predict: 1, id_slot: 1 })).json();
    expect(off.timings.cache_n).toBe(0);
  });

  it('two long prompts at once: the second is read after the first', async () => {
    const { e } = await start({ flavor: 'llamacpp', ctx: 16384, np: 2, profile: { loadMsWarm: 1, prefillTps: 20_000, decodeTps: 5000 } });
    const t0 = performance.now();
    const ttft = async (from: number) => {
      const res = await post(`${e.url}/completion`, { prompt: prompt(4000, from), n_predict: 1, stream: true });
      const reader = res.body!.getReader();
      await reader.read();
      const t = performance.now() - t0;
      while (!(await reader.read()).done);
      return t;
    };
    const [a, b] = (await Promise.all([ttft(0), ttft(9000)])).sort((x, y) => x - y);
    // 4000 tokens at 20 000 tok/s = 200 ms each.
    expect(b! - a!).toBeGreaterThan(120);
  });

  it('vLLM: block cache on by default, cached tokens only with --enable-prompt-tokens-details; KV lines', async () => {
    const { e, lines } = await start({ flavor: 'vllm', alias: 'm', ctx: 4096, kvTokens: 889_820, promptTokensDetails: true, profile: { loadMsWarm: 20, prefillTps: 100_000, decodeTps: 5000 } });
    await post(`${e.url}/v1/completions`, { model: 'm', prompt: prompt(100), max_tokens: 2 });
    const again = await (await post(`${e.url}/v1/completions`, { model: 'm', prompt: [...prompt(100), 5, 6], max_tokens: 2 })).json();
    // Whole 16-token blocks of the 100 shared tokens.
    expect(again.usage.prompt_tokens_details).toEqual({ cached_tokens: 96 });
    expect(parseKvCapacity(lines, 'vllm-docker')).toEqual({ tokens: 889_820, maxConcurrencyAtTokens: { tokens: 4096, concurrency: 217.24 } });
    const stages = lines.map((l) => parseLoadProgress(l, 'vllm-docker')?.stage).filter(Boolean);
    expect(new Set(stages)).toEqual(new Set(['weights', 'compile', 'memory-profile', 'kv-cache', 'cuda-graphs', 'warmup', 'api-server', 'ready']));

    const { e: quiet } = await start({ flavor: 'vllm', alias: 'm', ctx: 4096, prefixCaching: false, profile: { loadMsWarm: 1, prefillTps: 100_000, decodeTps: 5000 } });
    await post(`${quiet.url}/v1/completions`, { model: 'm', prompt: prompt(100), max_tokens: 2 });
    const plain = await (await post(`${quiet.url}/v1/completions`, { model: 'm', prompt: prompt(100), max_tokens: 2 })).json();
    expect(plain.usage).not.toHaveProperty('prompt_tokens_details');
  });
});
