// Contract of the fake engine relied upon by the inference/bench tests of other modules.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { detokenize, piece, readProfile, startFakeEngine, tokenize, type FakeEngine } from '../../../fakes/fake-engine/server.mjs';
import { pickFreePort } from '../../../../src/core/process/ports';

const CLI = fileURLToPath(new URL('../../../fakes/fake-engine/cli.mjs', import.meta.url));
const engines: FakeEngine[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.close()));
});
async function start(o: Parameters<typeof startFakeEngine>[0]) {
  const e = await startFakeEngine(o);
  engines.push(e);
  return e;
}

async function sse(res: Response): Promise<unknown[]> {
  const text = await res.text();
  return text
    .split('\n\n')
    .map((b) => b.trim())
    .filter((b) => b.startsWith('data: '))
    .map((b) => b.slice(6))
    .map((d) => (d === '[DONE]' ? d : JSON.parse(d)));
}
const post = (url: string, body: unknown) => fetch(url, { method: 'POST', body: JSON.stringify(body) });

describe('tokenizer', () => {
  it('BOS + one id per 4 characters; generated pieces are 4 characters', () => {
    expect(tokenize('abcdefgh')).toHaveLength(3);
    expect(tokenize('abcdefgh', false)).toHaveLength(2);
    expect(piece(1)).toBe('');
    expect(piece(1234)).toHaveLength(4);
    expect(detokenize([1, 1000, 1001])).toHaveLength(8);
  });

  it('profile from inline JSON or a file', () => {
    expect(readProfile({})).toEqual({});
    expect(readProfile({ FAKE_ENGINE_PROFILE: '{"decodeTps":50}' })).toEqual({ decodeTps: 50 });
    const f = path.join(mkdtempSync(path.join(os.tmpdir(), 'gb-fe-')), 'p.json');
    writeFileSync(f, '{"loadMsWarm":5}');
    expect(readProfile({ FAKE_ENGINE_PROFILE: f })).toEqual({ loadMsWarm: 5 });
  });
});

describe('llama.cpp flavour', () => {
  it('503 while loading, then the llama-server API', async () => {
    const lines: string[] = [];
    const e = await start({ alias: 'gpubench-a', ctx: 64, profile: { loadMsWarm: 200, decodeTps: 2000, tokensPerChunk: 3 }, log: (l) => lines.push(l) });
    const loading = await fetch(`${e.url}/health`);
    expect(loading.status).toBe(503);
    expect(await loading.json()).toEqual({ error: { code: 503, message: 'Loading model', type: 'unavailable_error' } });
    expect((await fetch(`${e.url}/props`)).status).toBe(503);
    await e.loaded;
    expect(await (await fetch(`${e.url}/health`)).json()).toEqual({ status: 'ok' });
    expect(lines.some((l) => l.startsWith('main: server is listening on'))).toBe(true);
    expect(await (await fetch(`${e.url}/props`)).json()).toMatchObject({ total_slots: 4, default_generation_settings: { n_ctx: 64 } });
    expect(await (await fetch(`${e.url}/v1/models`)).json()).toMatchObject({ data: [{ id: 'gpubench-a', owned_by: 'llamacpp' }] });
    expect(await (await post(`${e.url}/tokenize`, { content: 'abcdefgh', add_special: true })).json()).toEqual({ tokens: tokenize('abcdefgh') });
    expect(await (await post(`${e.url}/detokenize`, { tokens: [1000] })).json()).toEqual({ content: piece(1000) });

    const chunks = (await sse(await post(`${e.url}/completion`, { prompt: [1, 5, 6, 7], n_predict: 10, ignore_eos: true, stream: true, return_tokens: true }))) as {
      tokens?: number[];
      stop: boolean;
      timings?: { prompt_n: number; predicted_n: number };
      stop_type?: string;
    }[];
    const content = chunks.filter((c) => !c.stop);
    expect(content.map((c) => c.tokens?.length)).toEqual([3, 3, 3, 1]);
    expect(chunks.at(-1)).toMatchObject({ stop: true, stop_type: 'limit', timings: { prompt_n: 4, predicted_n: 10 } });

    const eos = (await (await post(`${e.url}/completion`, { prompt: 'hello there', n_predict: 100 })).json()) as { tokens_predicted: number; stop_type: string };
    expect(eos).toMatchObject({ tokens_predicted: 48, stop_type: 'eos' });
    const over = await post(`${e.url}/completion`, { prompt: Array(65).fill(5) });
    expect(over.status).toBe(400);
    const roomLimited = (await (await post(`${e.url}/completion`, { prompt: Array(60).fill(5), ignore_eos: true })).json()) as { tokens_predicted: number };
    expect(roomLimited.tokens_predicted).toBe(4);
    expect((await fetch(`${e.url}/nope`)).status).toBe(404);
    expect((await post(`${e.url}/nope`, {})).status).toBe(404);
    expect((await fetch(`${e.url}/completion`, { method: 'POST', body: '{bad' })).status).toBe(400);
    expect(lines.some((l) => /eval time = .* \/ +10 tokens/.test(l))).toBe(true);
  });

  it('decode rate follows the profile (catch-up scheduling survives coarse timers)', async () => {
    const e = await start({ profile: { loadMsWarm: 0, decodeTps: 400, prefillTps: 100_000 } });
    await e.loaded;
    const t0 = performance.now();
    const r = (await (await post(`${e.url}/completion`, { prompt: [1, 2], n_predict: 200, ignore_eos: true })).json()) as { timings: { predicted_n: number } };
    const ms = performance.now() - t0;
    expect(r.timings.predicted_n).toBe(200);
    expect(ms).toBeGreaterThan(400);
    expect(ms).toBeLessThan(1500);
  });

  it('slots: more requests than -np queue up and still complete', async () => {
    const e = await start({ np: 2, profile: { loadMsWarm: 0, decodeTps: 1000 } });
    await e.loaded;
    const res = await Promise.all([1, 2, 3].map(() => post(`${e.url}/completion`, { prompt: [1], n_predict: 20, ignore_eos: true }).then((r) => r.json())));
    expect(res.map((r) => (r as { tokens_predicted: number }).tokens_predicted)).toEqual([20, 20, 20]);
  });

  it('failure modes: HTTP 500 rate, stall, crash, OOM at load, missing model, bind failure', async () => {
    const flaky = await start({ profile: { loadMsWarm: 0, httpErrorRate: 1 } });
    await flaky.loaded;
    expect((await post(`${flaky.url}/completion`, { prompt: [1] })).status).toBe(500);

    const stall = await start({ profile: { loadMsWarm: 0, stallAfterTokens: 3, decodeTps: 1000 } });
    await stall.loaded;
    const ac = new AbortController();
    const res = await fetch(`${stall.url}/completion`, { method: 'POST', body: JSON.stringify({ prompt: [1], n_predict: 50, ignore_eos: true, stream: true }), signal: ac.signal });
    const reader = res.body!.getReader();
    let got = '';
    const deadline = Date.now() + 400;
    while (Date.now() < deadline && (got.match(/"stop":false/g) ?? []).length < 3) {
      const { value } = await reader.read();
      got += new TextDecoder().decode(value);
    }
    expect((got.match(/"stop":false/g) ?? []).length).toBe(3);
    ac.abort();

    let fatal = -1;
    const crash = await start({ profile: { loadMsWarm: 0, crashAfterTokens: 5 }, onFatal: (c) => (fatal = c) });
    await crash.loaded;
    await expect(post(`${crash.url}/completion`, { prompt: [1], n_predict: 50, ignore_eos: true }).then((r) => r.text())).rejects.toThrow();
    expect(fatal).toBe(134);

    const oomLines: string[] = [];
    const oom = await start({ profile: { loadMsWarm: 50, oomAtLoad: true }, log: (l) => oomLines.push(l) });
    await expect(oom.loaded).rejects.toThrow('oom');
    expect(oomLines.some((l) => l.includes('cudaMalloc failed: out of memory'))).toBe(true);

    const missing = await start({ model: path.join(os.tmpdir(), 'gb-none.gguf'), requireModelFile: true, profile: { loadMsWarm: 0 } });
    await expect(missing.loaded).rejects.toThrow('model');

    const port = flaky.port;
    const bindLines: string[] = [];
    await expect(startFakeEngine({ port, log: (l) => bindLines.push(l) })).rejects.toThrow();
    expect(bindLines.some((l) => l.includes("couldn't bind HTTP server socket"))).toBe(true);
  });

  it('cold marker selects loadMsCold and is consumed', async () => {
    const marker = path.join(mkdtempSync(path.join(os.tmpdir(), 'gb-fe-')), 'cold');
    writeFileSync(marker, '');
    const t0 = performance.now();
    const e = await start({ coldMarker: marker, profile: { loadMsCold: 300, loadMsWarm: 0 } });
    await e.loaded;
    expect(performance.now() - t0).toBeGreaterThan(250);
    const { existsSync } = await import('node:fs');
    expect(existsSync(marker)).toBe(false);
  });
});

describe('vLLM flavour', () => {
  it('listens only after loading; OpenAI completions with usage', async () => {
    const lines: string[] = [];
    const port = await pickFreePort();
    const e = await start({ flavor: 'vllm', port, model: 'Qwen/Qwen3-0.6B', ctx: 256, profile: { loadMsWarm: 150, decodeTps: 2000, tokensPerChunk: 2 }, log: (l) => lines.push(l) });
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
    await e.loaded;
    expect(lines.some((l) => l.includes('Loading weights took'))).toBe(true);
    expect((await fetch(`${e.url}/health`)).status).toBe(200);
    expect(await (await fetch(`${e.url}/version`)).json()).toEqual({ version: '0.12.0' });
    expect(await (await fetch(`${e.url}/v1/models`)).json()).toMatchObject({ data: [{ id: 'Qwen/Qwen3-0.6B', owned_by: 'vllm', max_model_len: 256 }] });
    expect(await (await post(`${e.url}/tokenize`, { model: 'Qwen/Qwen3-0.6B', prompt: 'abcd' })).json()).toMatchObject({ count: 2, tokens: tokenize('abcd') });

    const events = await sse(
      await post(`${e.url}/v1/completions`, {
        model: 'Qwen/Qwen3-0.6B',
        prompt: [1, 2, 3],
        max_tokens: 6,
        min_tokens: 6,
        ignore_eos: true,
        stream: true,
        stream_options: { include_usage: true, continuous_usage_stats: true },
      }),
    );
    expect(events.at(-1)).toBe('[DONE]');
    const usage = events.at(-2) as { choices: unknown[]; usage: { completion_tokens: number; prompt_tokens: number } };
    expect(usage).toMatchObject({ choices: [], usage: { completion_tokens: 6, prompt_tokens: 3 } });
    const content = events.slice(0, -2) as { choices: { finish_reason: string | null }[]; usage: { completion_tokens: number } }[];
    expect(content.map((c) => c.usage.completion_tokens)).toEqual([2, 4, 6]);
    expect(content.at(-1)?.choices[0]?.finish_reason).toBe('length');

    const plain = (await (await post(`${e.url}/v1/completions`, { model: 'Qwen/Qwen3-0.6B', prompt: 'hi', max_tokens: 100, min_tokens: 10 })).json()) as {
      usage: { completion_tokens: number };
      choices: { finish_reason: string }[];
    };
    expect(plain.usage.completion_tokens).toBe(48);
    expect(plain.choices[0]?.finish_reason).toBe('stop');
    expect((await post(`${e.url}/v1/completions`, { model: 'other', prompt: 'x' })).status).toBe(404);
    expect((await post(`${e.url}/v1/completions`, { prompt: Array(300).fill(1), max_tokens: 1 })).status).toBe(400);
  });

  it('no kernel image / OOM at start-up', async () => {
    const lines: string[] = [];
    const nk = await start({ flavor: 'vllm', profile: { loadMsWarm: 20, noKernelImage: true }, log: (l) => lines.push(l) });
    await expect(nk.loaded).rejects.toThrow();
    expect(lines.some((l) => l.includes('no kernel image is available'))).toBe(true);
    const oom = await start({ flavor: 'vllm', profile: { loadMsWarm: 20, oomAtLoad: true } });
    await expect(oom.loaded).rejects.toThrow();
  });

  it('cli: `serve <model>` mimics the vllm command line', async () => {
    const port = await pickFreePort();
    const child = spawn(process.execPath, [CLI, 'serve', 'facebook/opt-125m', '--host', '127.0.0.1', '--port', String(port), '--served-model-name', 'opt', '--enforce-eager'], {
      env: { ...process.env, FAKE_ENGINE_PROFILE: '{"loadMsWarm":100}' },
      stdio: 'ignore',
      windowsHide: true,
    });
    try {
      let ok = false;
      for (let i = 0; i < 100 && !ok; i++) {
        ok = await fetch(`http://127.0.0.1:${port}/v1/models`)
          .then(async (r) => ((await r.json()) as { data: { id: string }[] }).data[0]?.id === 'opt')
          .catch(() => false);
        if (!ok) await new Promise((r) => setTimeout(r, 50));
      }
      expect(ok).toBe(true);
    } finally {
      child.kill();
    }
  });
});
