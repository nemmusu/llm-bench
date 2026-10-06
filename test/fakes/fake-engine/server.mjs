// Deterministic fake LLM server speaking the llama.cpp server API or vLLM's OpenAI API.
// Used in-process (startFakeEngine) and as a child process through cli.mjs, which mimics the
// llama-server / `vllm serve` command lines. Timing comes from a behaviour profile.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { GpuState } from './gpu-state.mjs';
import * as L from './logs.mjs';

/**
 * @typedef {object} FakeProfile
 * @property {number} [loadMsCold]      Load time when the cold marker exists (default 1200).
 * @property {number} [loadMsWarm]      Load time otherwise (default 300).
 * @property {number} [prefillTps]      Prompt tokens per second (default 4000).
 * @property {number} [decodeTps]       Generated tokens per second, single request (default 120).
 * @property {number} [tokensPerChunk]  Tokens per streamed chunk (default 1; >1 mimics MTP/speculative).
 * @property {number} [timeScale]       Multiplies every delay (default 1).
 * @property {boolean} [oomAtLoad]      Print CUDA OOM lines while loading weights and exit 1.
 * @property {boolean} [noKernelImage]  vLLM-style "no kernel image" failure at start-up.
 * @property {number} [crashAfterTokens] Die (exit 134) after this many generated tokens in total.
 * @property {number} [stallAfterTokens] Stop streaming (connection left open) after this many tokens.
 * @property {number} [httpErrorRate]   Fraction 0..1 of generation requests answered with HTTP 500 (seeded).
 * @property {string} [badFlag]         Reject this flag like llama-server does ("error: invalid argument").
 * @property {number} [eosAfter]        Tokens before a natural EOS when ignore_eos is false (default 48).
 * @property {number} [vramMiB]         VRAM the "model" occupies (default 4500).
 * @property {number} [nLayers]         Layers reported in the log (default 33).
 * @property {number} [seed]            PRNG seed (default 1).
 * @property {{ utilPct: number, powerW: number, tempC?: number }} [busy] Telemetry while computing.
 */

/** @returns {FakeProfile} */
export function readProfile(env = process.env) {
  const raw = env.FAKE_ENGINE_PROFILE;
  if (!raw) return {};
  const text = raw.trim().startsWith('{') ? raw : readFileSync(raw, 'utf8');
  return JSON.parse(text);
}

const BOS = 1;

/** Deterministic tokenizer: BOS + one id per 4 characters. */
export function tokenize(text, addSpecial = true) {
  const ids = addSpecial ? [BOS] : [];
  for (let i = 0; i < text.length; i += 4) {
    let h = 0;
    for (const ch of text.slice(i, i + 4)) h = (h * 31 + ch.codePointAt(0)) % 30011;
    ids.push(100 + h);
  }
  return ids;
}

/** Each generated id maps to a 4-character piece, so text length = 4 × tokens. */
export function piece(id) {
  if (id === BOS) return '';
  const a = 'abcdefghijklmnopqrstuvwxyz';
  return ` ${a[id % 26]}${a[Math.floor(id / 26) % 26]}${a[Math.floor(id / 676) % 26]}`;
}

export function detokenize(ids) {
  return ids.map(piece).join('');
}

function genId(seed, k) {
  return 1000 + ((seed * 7919 + k * 104729) % 30000);
}

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.setEncoding('utf8');
    req.on('data', (d) => (s += d));
    req.on('end', () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch {
        resolve(undefined);
      }
    });
  });
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/**
 * @typedef {object} FakeEngineOptions
 * @property {'llamacpp' | 'vllm'} [flavor]
 * @property {string} [host]
 * @property {number} [port]            0 = any free port.
 * @property {string} [model]           Model path (llama.cpp) or repo id (vLLM).
 * @property {string} [alias]           one model name (shorthand for `aliases: [alias]`).
 * @property {string[]} [aliases]       llama.cpp --alias a,b / vLLM --served-model-name a b (the first one is reported).
 * @property {number} [ctx]
 * @property {number} [np]              llama.cpp slots (-np); -1/undefined = auto (4).
 * @property {string} [flashAttn]
 * @property {FakeProfile} [profile]
 * @property {(line: string) => void} [log]
 * @property {string} [stateFile]       Fake nvidia-smi state (FAKE_NVIDIA_SMI_STATE).
 * @property {string} [coldMarker]      FAKE_ENGINE_COLD_MARKER: cold load when it exists (then deleted).
 * @property {boolean} [requireModelFile] llama.cpp: fail like the real server when -m does not exist.
 * @property {boolean} [watchdog]       Spawn the state watchdog (default true when stateFile is set).
 * @property {(code: number) => void} [onFatal] Simulated crash (default: close the server).
 */

/**
 * Starts the fake engine. Resolves once the port is bound (llama.cpp binds before loading;
 * vLLM only after loading). `loaded` resolves when the model is "loaded" and rejects on a
 * simulated load failure. Bind failures reject the returned promise.
 * @param {FakeEngineOptions} [o]
 */
export async function startFakeEngine(o = {}) {
  const flavor = o.flavor ?? 'llamacpp';
  const p = o.profile ?? {};
  const scale = p.timeScale ?? 1;
  const log = o.log ?? (() => {});
  const out = (lines) => lines.forEach((l) => log(l));
  const host = o.host ?? '127.0.0.1';
  const model = o.model ?? 'model.gguf';
  const aliases = o.aliases ?? [o.alias ?? model];
  const alias = aliases[0];
  const ctx = o.ctx ?? 4096;
  const np = o.np && o.np > 0 ? o.np : 4;
  const vramMiB = p.vramMiB ?? 4500;
  const busyLoad = p.busy ?? { utilPct: 97, powerW: 450, tempC: 68 };
  const gpu = new GpuState(o.stateFile, { watchdog: o.watchdog });
  const rand = mulberry32(p.seed ?? 1);
  const c = { model, host, port: o.port ?? 8080, ctx, np, nLayers: p.nLayers ?? 33, vramMiB, flashAttn: o.flashAttn ?? 'auto' };

  let loaded = false;
  let closed = false;
  let totalTokens = 0;
  let active = 0;
  let nextTask = 0;
  const waiting = [];
  const sockets = new Set();
  const stalled = new Set();

  const fatal = (code, lines) => {
    out(lines);
    gpu.release();
    if (o.onFatal) o.onFatal(code);
    else void close();
  };

  const acquireSlot = async () => {
    if (active < np) {
      active++;
      return;
    }
    await new Promise((r) => waiting.push(r));
  };
  const releaseSlot = () => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };

  /** Generation shared by both flavours. `emit` sends one chunk of `ids`. */
  async function generate(res, { promptN, n, perChunk, emit, finish }) {
    await acquireSlot();
    const slot = active - 1;
    const task = nextTask++;
    let aborted = false;
    res.on('close', () => {
      aborted = !res.writableFinished;
    });
    if (flavor === 'llamacpp') out(L.llamaTaskStart(slot, task, promptN, ctx));
    gpu.setLoad(busyLoad);
    const t0 = performance.now();
    await sleep(((promptN / (p.prefillTps ?? 4000)) * 1000) * scale);
    const tPrefill = performance.now();
    const seed = (p.seed ?? 1) + task;
    let k = 0;
    // Time at which the last emitted token was due. Targets are relative to it, not to "now":
    // Windows timers fire with ~15.6 ms granularity, so an oversleep is caught up by emitting
    // the overdue chunks back to back and the average rate stays exact.
    let due = tPrefill;
    try {
      while (k < n && !aborted && !closed) {
        const m = Math.min(perChunk, n - k);
        const perToken = (1000 / (p.decodeTps ?? 120)) * scale * (1 + 0.15 * Math.max(0, Math.min(active, np) - 1));
        const target = due + m * perToken;
        const now = performance.now();
        if (target > now) await sleep(target - now);
        if (aborted || closed) break;
        due = target;
        const batch = [];
        for (let j = 0; j < m; j++) {
          k++;
          totalTokens++;
          batch.push(genId(seed, k));
          if (p.crashAfterTokens !== undefined && totalTokens >= p.crashAfterTokens) {
            fatal(134, L.llamaCrash());
            res.destroy();
            return;
          }
        }
        emit(batch, k);
        if (p.stallAfterTokens !== undefined && totalTokens >= p.stallAfterTokens) {
          stalled.add(res);
          return;
        }
      }
      if (aborted || closed) return;
      const tEnd = performance.now();
      const timings = { promptN, promptMs: tPrefill - t0, predictedN: k, predictedMs: tEnd - tPrefill };
      finish(timings);
      if (flavor === 'llamacpp') out(L.llamaTaskDone(slot, task, timings));
    } finally {
      if (!stalled.has(res)) {
        releaseSlot();
        if (active === 0) gpu.setLoad(null);
      }
    }
  }

  const errorJson = (code, message, type) => ({ error: { code, message, type } });

  async function handleLlama(req, res, url) {
    if (url.pathname === '/health') {
      if (!loaded) return sendJson(res, 503, errorJson(503, 'Loading model', 'unavailable_error'));
      return sendJson(res, 200, { status: 'ok' });
    }
    if (!loaded) return sendJson(res, 503, errorJson(503, 'Loading model', 'unavailable_error'));
    if (url.pathname === '/props' && req.method === 'GET') {
      return sendJson(res, 200, {
        default_generation_settings: { n_ctx: ctx, params: { temperature: 0.8, n_predict: -1 } },
        total_slots: np,
        model_alias: alias,
        model_path: model,
        modalities: { vision: false, audio: false },
        build_info: 'b10997-fccf7166f',
      });
    }
    if (url.pathname === '/v1/models' || url.pathname === '/models') {
      return sendJson(res, 200, {
        models: [{ name: alias, model: alias, type: 'model', capabilities: ['completion'] }],
        object: 'list',
        data: [{ id: alias, aliases, object: 'model', created: 1_760_000_000, owned_by: 'llamacpp', meta: { n_ctx_train: 131072, size: vramMiB * 1048576 } }],
      });
    }
    if (req.method !== 'POST') return sendJson(res, 404, errorJson(404, 'File Not Found', 'not_found_error'));
    const body = await readBody(req);
    if (body === undefined) return sendJson(res, 400, errorJson(400, 'Invalid JSON', 'invalid_request_error'));
    if (url.pathname === '/tokenize') {
      const ids = tokenize(String(body.content ?? ''), body.add_special === true);
      return sendJson(res, 200, { tokens: ids });
    }
    if (url.pathname === '/detokenize') {
      return sendJson(res, 200, { content: detokenize(Array.isArray(body.tokens) ? body.tokens : []) });
    }
    if (url.pathname === '/completion' || url.pathname === '/completions') {
      if (p.httpErrorRate && rand() < p.httpErrorRate) {
        return sendJson(res, 500, errorJson(500, 'Internal server error (fake)', 'server_error'));
      }
      const prompt = body.prompt;
      const ids = Array.isArray(prompt) && prompt.every((x) => typeof x === 'number') ? prompt : tokenize(String(prompt ?? ''), true);
      const promptN = ids.length;
      if (promptN > ctx) {
        return sendJson(res, 400, {
          error: { code: 400, message: 'the request exceeds the available context size, try increasing it', type: 'exceed_context_size_error', n_prompt_tokens: promptN, n_ctx: ctx },
        });
      }
      const room = ctx - promptN;
      const nPredict = typeof body.n_predict === 'number' && body.n_predict >= 0 ? body.n_predict : Infinity;
      const ignoreEos = body.ignore_eos === true;
      const n = Math.min(room, nPredict, ignoreEos ? Infinity : (p.eosAfter ?? 48));
      const stopType = n === nPredict || n === room ? 'limit' : 'eos';
      const returnTokens = body.return_tokens === true;
      const stream = body.stream === true;
      let text = '';
      if (stream) res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const final = (t, content) => ({
        index: 0,
        content,
        tokens: [],
        id_slot: 0,
        stop: true,
        model: alias,
        tokens_predicted: t.predictedN,
        tokens_evaluated: promptN,
        generation_settings: { n_predict: body.n_predict ?? -1, seed: body.seed ?? -1, temperature: body.temperature ?? 0.8, ignore_eos: ignoreEos },
        prompt: '',
        has_new_line: false,
        truncated: false,
        stop_type: stopType,
        stopping_word: '',
        tokens_cached: promptN + t.predictedN,
        timings: {
          cache_n: 0,
          prompt_n: t.promptN,
          prompt_ms: t.promptMs,
          prompt_per_token_ms: t.promptMs / Math.max(1, t.promptN),
          prompt_per_second: (t.promptN / Math.max(t.promptMs, 0.001)) * 1000,
          predicted_n: t.predictedN,
          predicted_ms: t.predictedMs,
          predicted_per_token_ms: t.predictedMs / Math.max(1, t.predictedN),
          predicted_per_second: (t.predictedN / Math.max(t.predictedMs, 0.001)) * 1000,
        },
      });
      await generate(res, {
        promptN,
        n,
        perChunk: Math.max(1, p.tokensPerChunk ?? 1),
        emit: (batch, k) => {
          const content = detokenize(batch);
          text += content;
          if (!stream) return;
          const chunk = { index: 0, content, ...(returnTokens ? { tokens: batch } : {}), stop: false, id_slot: 0, tokens_predicted: k, tokens_evaluated: promptN };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        },
        finish: (t) => {
          if (stream) {
            res.write(`data: ${JSON.stringify(final(t, ''))}\n\n`);
            res.end();
          } else sendJson(res, 200, final(t, text));
        },
      });
      return;
    }
    return sendJson(res, 404, errorJson(404, 'File Not Found', 'not_found_error'));
  }

  async function handleVllm(req, res, url) {
    if (url.pathname === '/health') {
      res.writeHead(200);
      return res.end();
    }
    if (url.pathname === '/version') return sendJson(res, 200, { version: '0.12.0' });
    if (url.pathname === '/v1/models') {
      return sendJson(res, 200, {
        object: 'list',
        data: aliases.map((id) => ({ id, object: 'model', created: 1_760_000_000, owned_by: 'vllm', root: model, parent: null, max_model_len: ctx })),
      });
    }
    if (req.method !== 'POST') return sendJson(res, 404, { detail: 'Not Found' });
    const body = await readBody(req);
    if (body === undefined) return sendJson(res, 400, { object: 'error', message: 'Invalid JSON', type: 'BadRequestError', code: 400 });
    if (body.model !== undefined && !aliases.includes(body.model)) {
      return sendJson(res, 404, { object: 'error', message: `The model \`${body.model}\` does not exist.`, type: 'NotFoundError', code: 404 });
    }
    if (url.pathname === '/tokenize') {
      const ids = tokenize(String(body.prompt ?? ''), body.add_special_tokens !== false);
      return sendJson(res, 200, { count: ids.length, max_model_len: ctx, tokens: ids, token_strs: null });
    }
    if (url.pathname === '/v1/completions') {
      if (p.httpErrorRate && rand() < p.httpErrorRate) {
        return sendJson(res, 500, { object: 'error', message: 'Internal server error (fake)', type: 'InternalServerError', code: 500 });
      }
      const prompt = body.prompt;
      const ids = Array.isArray(prompt) && prompt.every((x) => typeof x === 'number') ? prompt : tokenize(String(prompt ?? ''), true);
      const promptN = ids.length;
      const maxTokens = typeof body.max_tokens === 'number' ? body.max_tokens : 16;
      if (promptN + maxTokens > ctx) {
        return sendJson(res, 400, { object: 'error', message: `This model's maximum context length is ${ctx} tokens.`, type: 'BadRequestError', code: 400 });
      }
      const minTokens = typeof body.min_tokens === 'number' ? body.min_tokens : 0;
      const n = body.ignore_eos === true ? maxTokens : Math.min(maxTokens, Math.max(minTokens, p.eosAfter ?? 48));
      const finishReason = n === maxTokens ? 'length' : 'stop';
      const stream = body.stream === true;
      const includeUsage = body.stream_options?.include_usage === true;
      const continuous = body.stream_options?.continuous_usage_stats === true;
      const id = `cmpl-fake${nextTask}`;
      const created = Math.floor(Date.now() / 1000);
      const usage = (k) => ({ prompt_tokens: promptN, total_tokens: promptN + k, completion_tokens: k });
      let text = '';
      if (stream) res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      await generate(res, {
        promptN,
        n,
        perChunk: Math.max(1, p.tokensPerChunk ?? 1),
        emit: (batch, k) => {
          const content = detokenize(batch);
          text += content;
          if (!stream) return;
          const chunk = {
            id,
            object: 'text_completion',
            created,
            model: alias,
            choices: [{ index: 0, text: content, logprobs: null, finish_reason: k === n ? finishReason : null, stop_reason: null }],
            usage: continuous ? usage(k) : null,
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        },
        finish: (t) => {
          if (!stream) {
            sendJson(res, 200, {
              id,
              object: 'text_completion',
              created,
              model: alias,
              choices: [{ index: 0, text, logprobs: null, finish_reason: finishReason, stop_reason: null }],
              usage: usage(t.predictedN),
            });
            return;
          }
          if (includeUsage) res.write(`data: ${JSON.stringify({ id, object: 'text_completion', created, model: alias, choices: [], usage: usage(t.predictedN) })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        },
      });
      return;
    }
    return sendJson(res, 404, { detail: 'Not Found' });
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const handler = flavor === 'vllm' ? handleVllm : handleLlama;
    handler(req, res, url).catch((e) => {
      if (!res.headersSent) sendJson(res, 500, errorJson(500, String(e), 'server_error'));
      else res.destroy();
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  const bind = () =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(o.port ?? 0, host, () => {
        server.off('error', reject);
        resolve(server.address().port);
      });
    });

  async function close() {
    if (closed) return;
    closed = true;
    for (const r of stalled) r.destroy();
    await new Promise((r) => {
      server.close(() => r(undefined));
      for (const s of sockets) s.destroy();
    });
    gpu.release();
  }

  const cold = o.coldMarker !== undefined && existsSync(o.coldMarker);
  const loadMs = (cold ? (p.loadMsCold ?? 1200) : (p.loadMsWarm ?? 300)) * scale;

  async function loadLlama() {
    await sleep(loadMs * 0.05);
    out(L.llamaModelMeta(c));
    if (o.requireModelFile && !existsSync(model)) throw Object.assign(new Error('model'), { lines: L.llamaMissingModel(c) });
    await sleep(loadMs * 0.05);
    out(L.llamaLoadTensorsStart(c));
    for (let i = 1; i <= 5; i++) {
      await sleep((loadMs * 0.6) / 5);
      if (p.oomAtLoad && i === 3) throw Object.assign(new Error('oom'), { lines: L.llamaOom(c) });
      gpu.setMem(Math.round(vramMiB * 0.85 * (i / 5)));
    }
    out(L.llamaContext(c));
    gpu.setMem(vramMiB);
    await sleep(loadMs * 0.15);
    out(L.llamaWarmup());
    gpu.setLoad(busyLoad);
    await sleep(loadMs * 0.1);
    gpu.setLoad(null);
  }

  async function loadVllm() {
    out(L.vllmBanner(c));
    await sleep(loadMs * 0.1);
    if (p.noKernelImage) throw Object.assign(new Error('nokernel'), { lines: L.vllmNoKernelImage() });
    await sleep(loadMs * 0.4);
    gpu.setMem(Math.round(vramMiB * 0.6));
    out(L.vllmWeights((loadMs * 0.4) / 1000));
    if (p.oomAtLoad) throw Object.assign(new Error('oom'), { lines: L.vllmOom() });
    out(L.vllmModelLoaded(c, (loadMs * 0.5) / 1000));
    await sleep(loadMs * 0.4);
    gpu.setMem(vramMiB);
    gpu.setLoad(busyLoad);
    await sleep(loadMs * 0.1);
    gpu.setLoad(null);
  }

  const finishLoad = () => {
    loaded = true;
    if (cold) rmSync(/** @type {string} */ (o.coldMarker), { force: true });
  };

  let port;
  let loadedPromise;
  if (flavor === 'llamacpp') {
    out(L.llamaBanner(c));
    try {
      port = await bind();
    } catch (e) {
      out(L.llamaBindFailed(c));
      gpu.release();
      throw e;
    }
    c.port = port;
    out(L.llamaListening(c));
    loadedPromise = loadLlama().then(
      () => {
        finishLoad();
        out(L.llamaReady(c));
      },
      (e) => {
        fatal(1, e.lines ?? [String(e)]);
        throw e;
      },
    );
  } else {
    // vLLM loads first and binds the HTTP port afterwards.
    loadedPromise = loadVllm().then(
      async () => {
        try {
          port = await bind();
        } catch (e) {
          fatal(1, L.vllmPortInUse(c));
          throw e;
        }
        c.port = port;
        finishLoad();
        out(L.vllmReady(c, loadMs / 1000));
      },
      (e) => {
        fatal(1, e.lines ?? [String(e)]);
        throw e;
      },
    );
    port = o.port ?? 0;
  }
  loadedPromise.catch(() => {});

  return {
    get port() {
      return c.port;
    },
    get url() {
      return `http://${host}:${c.port}`;
    },
    loaded: loadedPromise,
    get totalTokens() {
      return totalTokens;
    },
    close,
  };
}
