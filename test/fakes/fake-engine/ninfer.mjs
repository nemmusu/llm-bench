// Deterministic fake of NInfer's ninfer-serve (docs/serving.md): its stderr (start-up lines, the capacity
// line, per-request and periodic throughput lines, the reservation failure), /health, /v1/models and a
// streaming /v1/chat/completions with usage, llama.cpp-style timings and a prefix cache that only
// reuses a previous request's exact endpoint (its rendered prompt + answer), as NInfer does.
//
// Memory model (MiB): the runtime reservation is runtime + KV pool; what is available is the card's free
// memory minus the weights and the CUDA context. --kv-capacity auto takes all of it but 1 GiB, in pages
// of 64 tokens. Timing comes from the same behaviour profile as the other fakes (FAKE_ENGINE_PROFILE).
import http from 'node:http';
import { GpuState } from './gpu-state.mjs';

const MIB = 1024 * 1024;
/** KV elements per token (Qwen3.8-27B: 16 full-attention layers × 4 KV heads × 256 × K and V) and the MTP layer. */
const KV_TEXT = 16 * 4 * 256 * 2;
const KV_MTP = 4 * 256 * 2;
const KV_BYTES = { bf16: 2, int8: 1 + 2 / 64, fp8: 1 + 2 / 64, nvfp4: 0.5 + 1 / 16, k8v4: (1 + 2 / 64 + 0.5 + 1 / 16) / 2 };
const PAGE = 64;
const CONTEXT_MIB = 600;

/** Chat template of the fake (Qwen-like). */
export function render(messages) {
  return `${messages.map((m) => `<|im_start|>${m.role}\n${typeof m.content === 'string' ? m.content : ''}<|im_end|>\n`).join('')}<|im_start|>assistant\n`;
}

/** Tokens of a text: one per 4.3 characters (the calibration in LLM Bench finds this). */
export function tokens(text) {
  return Math.ceil(text.length / 4.3);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const pad = (n, w = 2) => String(n).padStart(w, '0');
function stamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
const fmt = (n) => n.toLocaleString('en-US');
const gib = (mib) => `${(mib / 1024).toFixed(2)} GiB`;

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
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'x-request-id': 'fake' });
  res.end(text);
}

/**
 * What a launch reserves: { kvTokens, mode, needMiB, availableMiB, runtimeMiB } (needMiB > availableMiB = it fails).
 * @param {{ maxContext: number, kvCapacity?: number | 'auto', kvDtype: string, spec: string, vision: boolean, concurrency: number }} o
 * @param {{ freeMiB?: number, weightsMiB?: number, runtimeMiB?: number }} m
 */
export function reservation(o, m = {}) {
  const perToken = (KV_TEXT + (o.spec === 'mtp' ? KV_MTP : 0)) * (KV_BYTES[o.kvDtype] ?? 2);
  const runtime = (m.runtimeMiB ?? 840) + (o.spec === 'mtp' ? 716 : 0) + Math.max(0, o.concurrency - 2) * 147;
  const weights = (m.weightsMiB ?? 18_944) + (o.vision ? 800 : 0) + (o.spec === 'mtp' ? 717 : 0);
  const available = (m.freeMiB ?? 31_000) - weights - CONTEXT_MIB;
  const mode = o.kvCapacity === 'auto' ? 'auto' : 'explicit';
  const kvTokens =
    o.kvCapacity === 'auto' ? Math.max(0, Math.floor(((available - 1024 - runtime) * MIB) / perToken / PAGE) * PAGE) : (o.kvCapacity ?? o.maxContext);
  const kvMiB = (kvTokens * perToken) / MIB;
  return { kvTokens, mode, perToken, weightsMiB: weights, runtimeMiB: runtime + kvMiB, needMiB: runtime + kvMiB, availableMiB: available };
}

/**
 * @param {object} o
 * @param {string} o.model           artifact path (only printed)
 * @param {string} [o.host]
 * @param {number} [o.port]
 * @param {string} [o.modelId]       --model-id (default qwen3.8-27b)
 * @param {number} [o.maxContext]
 * @param {number | 'auto'} [o.kvCapacity]
 * @param {number} [o.concurrency]
 * @param {string} [o.kvDtype]
 * @param {string} [o.spec]          'off' | 'mtp' | 'dflash' | 'dflash2'
 * @param {number} [o.draftTokens]
 * @param {boolean} [o.vision]
 * @param {boolean} [o.prefixReuse]
 * @param {number} [o.statsMs]       --log-stats-interval-ms
 * @param {Record<string, any>} [o.profile] FAKE_ENGINE_PROFILE (loadMsWarm, prefillTps, decodeTps, tokensPerChunk, timeScale, eosAfter, ninfer: memory)
 * @param {(line: string) => void} [o.log]
 * @param {string} [o.stateFile]     FAKE_NVIDIA_SMI_STATE
 * @param {(code: number) => void} [o.onFatal]
 */
export async function startFakeNinfer(o) {
  const p = o.profile ?? {};
  const scale = p.timeScale ?? 1;
  const log = (level, msg) => (o.log ?? (() => {}))(`${stamp()}  ${level.padEnd(5)} ${msg}`);
  const modelId = o.modelId ?? 'qwen3.8-27b';
  const maxContext = o.maxContext ?? 8192;
  const lanes = o.concurrency ?? 1;
  const spec = o.spec ?? 'off';
  const kvDtype = o.kvDtype ?? 'bf16';
  const plan = reservation({ maxContext, kvCapacity: o.kvCapacity, kvDtype, spec, vision: o.vision === true, concurrency: lanes }, p.ninfer);
  const gpu = new GpuState(o.stateFile);
  const fatal = (code) => {
    gpu.release();
    if (o.onFatal) o.onFatal(code);
  };

  // ---- start-up
  const load = (p.loadMsWarm ?? 400) * scale;
  log('INFO', 'starting engine');
  await sleep(load * 0.1);
  log('INFO', `loading weights | ${(plan.weightsMiB / 1024).toFixed(1)} GiB`);
  gpu.setMem(Math.round(plan.weightsMiB / 2));
  await sleep(load * 0.4);
  gpu.setMem(Math.round(plan.weightsMiB));
  log('INFO', `weights ready | ${(plan.weightsMiB / 1024).toFixed(1)} GiB | ${(load / 2000).toFixed(1)}s | 7.25 GiB/s`);
  if (plan.needMiB > plan.availableMiB || plan.kvTokens < maxContext) {
    log('ERROR', 'startup failed | finalizing target | 4.06 ms');
    log('FATAL', `server failed during startup | requested Engine runtime reservation requires ${Math.round(plan.needMiB * MIB)} bytes, but only ${Math.round(plan.availableMiB * MIB)} bytes are available for runtime capacity`);
    fatal(1);
    throw new Error('reservation failed');
  }
  if (o.prefixReuse !== false) {
    log('INFO', 'pinning host state | 1.15 GiB');
    log('INFO', 'host state pinned | 1.15 GiB | 462 ms');
  }
  await sleep(load * 0.3);
  gpu.setMem(Math.round(plan.weightsMiB + plan.runtimeMiB + CONTEXT_MIB));
  log('INFO', `CUDA graphs ready | ${(load / 5000).toFixed(1)}s`);
  await sleep(load * 0.2);
  log('INFO', `engine ready | ${modelId} | total ${(load / 1000).toFixed(1)}s | weights ${(plan.weightsMiB / 1024).toFixed(1)} GiB | CUDA sync spin`);
  log('INFO', `capacity | KV ${fmt(plan.kvTokens)} tokens, ${kvDtype}, ${plan.mode} | pages ${fmt(plan.kvTokens / PAGE)}/${fmt(plan.kvTokens / PAGE)} | runtime ${gib(plan.runtimeMiB)} | free ${gib(Math.max(0, plan.availableMiB - plan.needMiB))}`);

  // ---- serving
  const busyLoad = p.busy ?? { utilPct: 97, powerW: 520, tempC: 66 };
  /** Endpoints of earlier requests (rendered prompt + answer) a later prompt can start with. */
  const endpoints = [];
  let prefillTail = Promise.resolve();
  let running = 0;
  const waiting = [];
  let seq = 0;
  const window = { prefill: 0, decode: 0 };
  const sockets = new Set();
  let closed = false;

  const acquire = () =>
    new Promise((resolve) => {
      if (running < lanes) {
        running++;
        resolve(undefined);
      } else waiting.push(resolve);
    });
  const release = () => {
    const next = waiting.shift();
    if (next) next(undefined);
    else running--;
  };

  async function chat(req, res, body) {
    const id = ++seq;
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (body.model !== modelId) return sendJson(res, 404, { error: { message: `model '${body.model}' not found`, type: 'invalid_request_error', code: 'model_not_found' } });
    const prompt = render(messages);
    const promptN = tokens(prompt);
    const maxTokens = typeof body.max_completion_tokens === 'number' ? body.max_completion_tokens : typeof body.max_tokens === 'number' ? body.max_tokens : 8192;
    if (promptN + maxTokens > maxContext) {
      return sendJson(res, 400, { error: { message: `context_length_exceeded: prompt ${promptN} + output ${maxTokens} exceeds the context ceiling ${maxContext}`, type: 'invalid_request_error', code: 'context_length_exceeded' } });
    }
    log('INFO', `req#${id} started | openai-chat stream | ${messages.length} message${messages.length === 1 ? '' : 's'} | max output ${fmt(maxTokens)} | thinking off`);
    await acquire();
    gpu.setLoad(busyLoad);
    // A hit is only an exact earlier endpoint the prompt starts with (NInfer's private_endpoint).
    const hit = o.prefixReuse === false ? undefined : endpoints.filter((e) => prompt.startsWith(e)).sort((a, b) => b.length - a.length)[0];
    const cached = hit ? Math.min(tokens(hit), promptN - 1) : 0;
    let aborted = false;
    res.on('close', () => {
      aborted = !res.writableFinished;
    });
    const turn = prefillTail;
    let done;
    prefillTail = new Promise((r) => (done = r));
    await turn;
    const t0 = performance.now();
    await sleep((((promptN - cached) / (p.prefillTps ?? 8000)) * 1000) * scale);
    const tPrefill = performance.now();
    done();
    window.prefill += promptN - cached;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-request-id': `fake-${id}` });
    const write = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const base = { id: `chatcmpl-${id}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: modelId };
    write({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, logprobs: null, finish_reason: null }] });
    const n = p.eosAfter !== undefined ? Math.min(maxTokens, p.eosAfter) : maxTokens;
    const perChunk = Math.max(1, spec === 'off' ? 1 : (p.tokensPerChunk ?? 2));
    let k = 0;
    let answer = '';
    let due = tPrefill;
    while (k < n && !aborted && !closed) {
      const m = Math.min(perChunk, n - k);
      const target = due + ((m * 1000) / (p.decodeTps ?? 150)) * scale * (1 + 0.15 * Math.max(0, running - 1));
      const now = performance.now();
      if (target > now) await sleep(target - now);
      due = target;
      let text = '';
      for (let j = 0; j < m; j++) text += ` w${(k + j) % 97}`;
      k += m;
      answer += text;
      window.decode += m;
      write({ ...base, choices: [{ index: 0, delta: { content: text }, logprobs: null, finish_reason: null }] });
    }
    if (!aborted && !closed) {
      const finish = k >= maxTokens ? 'length' : 'stop';
      const tEnd = performance.now();
      write({ ...base, choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: finish }] });
      if (body.stream_options?.include_usage === true) {
        write({
          ...base,
          choices: [],
          usage: { prompt_tokens: promptN, completion_tokens: k, total_tokens: promptN + k, prompt_tokens_details: { cached_tokens: cached }, completion_tokens_details: { reasoning_tokens: 0 } },
          timings: {
            cache_n: cached,
            prompt_n: promptN - cached,
            prompt_ms: tPrefill - t0,
            predicted_n: k,
            predicted_ms: tEnd - tPrefill,
            ...(spec !== 'off' ? { draft_n: Math.round(k * 1.5), draft_n_accepted: Math.round(k * 0.6) } : {}),
          },
        });
      }
      res.write('data: [DONE]\n\n');
      res.end();
      endpoints.push(prompt + answer);
      if (endpoints.length > 16) endpoints.shift();
      const tps = (n) => (n >= 1000 ? `${(n / 1000).toFixed(2)}k` : n.toFixed(1));
      log('INFO', `req#${id} done | openai-chat | ${finish === 'length' ? 'output limit' : 'stop token'} | prompt ${fmt(promptN)} | output ${fmt(k)} | cache ${fmt(cached)} (${((cached / promptN) * 100).toFixed(1)}%) | TTFT ${Math.round(tPrefill - t0)} ms | total ${((tEnd - t0) / 1000).toFixed(1)}s | prefill ${tps(((promptN - cached) / Math.max(1, tPrefill - t0)) * 1000)} tok/s | decode ${tps((k / Math.max(1, tEnd - tPrefill)) * 1000)} tok/s`);
    }
    release();
    if (running === 0) gpu.setLoad(null);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/health') return sendJson(res, 200, { status: 'ok' });
    if (url.pathname === '/v1/models' && req.method === 'GET') {
      return sendJson(res, 200, { object: 'list', data: [{ id: modelId, object: 'model', created: 1_760_000_000, owned_by: 'ninfer', max_model_len: maxContext }] });
    }
    if (url.pathname === '/v1/completions') return sendJson(res, 404, { error: { message: 'not found', type: 'invalid_request_error', code: 'not_found' } });
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      const body = await readBody(req);
      if (body === undefined) return sendJson(res, 400, { error: { message: 'malformed JSON', type: 'invalid_request_error', code: 'invalid_json' } });
      return chat(req, res, body);
    }
    return sendJson(res, 404, { error: { message: 'not found', type: 'invalid_request_error', code: 'not_found' } });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((resolve, reject) => {
    server.once('error', (e) => {
      log('FATAL', `server failed during startup | failed to bind ${o.host ?? '127.0.0.1'}:${o.port ?? 8080}: ${e.code === 'EADDRINUSE' ? 'Address already in use' : String(e)}`);
      fatal(1);
      reject(e);
    });
    server.listen(o.port ?? 8080, o.host ?? '127.0.0.1', () => resolve(undefined));
  });
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  log('INFO', `listening on http://${o.host ?? '127.0.0.1'}:${port} | model ${modelId} | auth disabled`);
  const statsMs = o.statsMs ?? 5000;
  const stats =
    statsMs > 0
      ? setInterval(() => {
          if (window.prefill === 0 && window.decode === 0) return;
          const s = statsMs / 1000;
          log('INFO', `throughput | ${s.toFixed(1)}s | prefill ${(window.prefill / s).toFixed(1)} tok/s (${fmt(window.prefill)} tok) | decode ${(window.decode / s).toFixed(1)} tok/s (${fmt(window.decode)} tok) | running ${running} | batch 1.00 | host 1.0% (50.0 ms)`);
          window.prefill = 0;
          window.decode = 0;
        }, statsMs)
      : undefined;
  return {
    port,
    url: `http://${o.host ?? '127.0.0.1'}:${port}`,
    kvTokens: plan.kvTokens,
    async close() {
      closed = true;
      if (stats) clearInterval(stats);
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(() => r(undefined)));
      log('INFO', 'server stopped');
      gpu.release();
    },
  };
}
