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
 * @property {FakeMemory} [memory]        VRAM model: what fits, what spills, what runs out of memory.
 * @property {FakeSpeed} [speed]          How speed depends on depth, ubatch, KV type, spill and offload.
 * @property {'all' | 'old' | 'none'} [vllmHelp] vLLM `serve --help`: 'all' (default) = a v0.11-style grouped help that
 *   takes --help=all (block size, fp8_e4m3/e5m2, CUDA graph sizes); 'old' = an old api_server help (rejects --help=all,
 *   none of those options); 'none' = the help fails.
 * @property {'counters' | 'gauge' | 'none'} [vllmMetrics] vLLM /metrics: prefix-cache counters (default, V1), the old
 *   gpu_prefix_cache_hit_rate gauge, or no /metrics at all (404).
 */

/**
 * VRAM model (MiB) for "Trova le impostazioni migliori" tests: need = weights on the GPU + KV cache
 * (per 1024 tokens of context, f16; q8_0 = 34/64 and q4_0 = 18/64 of it; vLLM fp8 = 1/2) + compute
 * buffer (per 512 ubatch tokens). Above totalMiB the load fails with CUDA OOM, unless `spillMiB` > 0:
 * up to totalMiB + spillMiB it loads but spills (Windows), and generation collapses (FakeSpeed.spill).
 * vLLM: the KV pool is gpu-memory-utilization × totalMiB − weights − 1024 (− 512 more for CUDA graphs
 * unless --enforce-eager; explicit capture sizes take 512 × count / 67, vLLM's default list having 67)
 * rounded down to whole blocks (--block-size, default 16); it logs "GPU KV cache size: N tokens" and
 * refuses a longer max-model-len. When gpu-memory-utilization × totalMiB is more than `freeMiB`, it
 * refuses to start ("Free memory on device … is less than desired GPU memory utilization").
 * Offload (--n-cpu-moe N or -ngl < layers) moves N/layers of the weights to the CPU.
 * @typedef {object} FakeMemory
 * @property {number} totalMiB
 * @property {number} weightsMiB
 * @property {number} kvMiBPer1k
 * @property {number} [computeMiBPer512] default 300
 * @property {number} [spillMiB]         default 0 (no spill: over the limit = OOM)
 * @property {number} [layers]           default 32 (offload granularity)
 * @property {number} [freeMiB]          vLLM: free VRAM at start-up (default totalMiB)
 */

/**
 * @typedef {object} FakeSpeed
 * @property {number} [depthSlowdown]      generation divided by (1 + k × depth / 32768); default 0
 * @property {number} [prefillDepthSlowdown] prompt reading divided by (1 + k × depth / 32768); default 0
 * @property {number} [faOffDepthFactor]   flash attention off multiplies the depth slowdowns; default 2
 * @property {number} [ubatchExponent]     prompt reading × (ubatch / 512)^e (diminishing returns); default 0
 * @property {Record<string, number>} [kvDecodeFactor] generation × factor per KV type (default 1)
 * @property {number} [spillFactor]        generation × factor while spilling; default 0.07
 * @property {number} [offloadPenalty]     generation × (1 − penalty × share on the CPU); default 0.7
 * @property {number} [unifiedDecodeFactor] llama.cpp: generation × factor with one KV pool shared by several slots; default 1
 * @property {number} [eagerDecodeFactor]  vLLM: generation × factor without a CUDA graph for the batch (--enforce-eager, or more
 *   requests at once than the largest captured size); default 0.85
 * @property {Record<string, number>} [blockSizeDecodeFactor] vLLM: generation × factor per --block-size (default 1)
 */

const KV_SHARE = { f16: 1, auto: 1, q8_0: 34 / 64, q4_0: 18 / 64, fp8: 0.5 };
/** vLLM's default CUDA graph capture list (1, 2, 4, 8, 16 … 512) has this many sizes. */
const VLLM_DEFAULT_GRAPHS = 67;

/**
 * What a launch needs and gets under the memory model.
 * @param {FakeMemory} m
 * @param {{ flavor: string, ctx: number, kvType?: string, ubatch?: number, nCpuMoe?: number, gpuLayers?: number, gpuMemoryUtilization?: number, eager?: boolean, blockSize?: number, graphSizes?: number[] }} o
 */
export function memoryPlan(m, o) {
  const layers = m.layers ?? 32;
  const cpu = o.nCpuMoe !== undefined ? Math.min(1, o.nCpuMoe / layers) : o.gpuLayers !== undefined && o.gpuLayers < layers ? 1 - o.gpuLayers / layers : 0;
  const weights = m.weightsMiB * (1 - cpu);
  const kvPerToken = (m.kvMiBPer1k * (KV_SHARE[o.kvType ?? 'f16'] ?? 1)) / 1024;
  const compute = (m.computeMiBPer512 ?? 300) * ((o.ubatch ?? 512) / 512);
  if (o.flavor === 'vllm') {
    const util = o.gpuMemoryUtilization ?? 0.9;
    if (util * m.totalMiB > (m.freeMiB ?? m.totalMiB)) return { cpuShare: cpu, needMiB: util * m.totalMiB, vramMiB: 0, capacity: 0, outcome: 'busy' };
    const graphs = o.eager ? 0 : 512 * Math.min(1, (o.graphSizes?.length ?? VLLM_DEFAULT_GRAPHS) / VLLM_DEFAULT_GRAPHS);
    const pool = util * m.totalMiB - weights - 1024 - graphs;
    // An explicit block size rounds the pool down to whole blocks.
    const block = o.blockSize ?? 1;
    const capacity = Math.max(0, Math.floor(pool / kvPerToken / block) * block);
    const need = weights + 1024 + Math.max(0, pool);
    return { cpuShare: cpu, needMiB: need, vramMiB: Math.min(need, m.totalMiB), capacity, outcome: o.ctx > capacity ? 'kv-too-small' : 'ok' };
  }
  const need = weights + kvPerToken * o.ctx + compute;
  const outcome = need <= m.totalMiB ? 'ok' : need <= m.totalMiB + (m.spillMiB ?? 0) ? 'spill' : 'oom';
  return { cpuShare: cpu, needMiB: need, vramMiB: Math.round(Math.min(need, m.totalMiB)), outcome };
}

/**
 * Prompt reading and generation speeds (tokens/s) of a request at `depth` prompt tokens.
 * @param {FakeProfile} p
 * @param {{ depth: number, flashAttn?: string, kvType?: string, kvTypeV?: string, kvFormat?: string, ubatch?: number, spill?: boolean, cpuShare?: number, unified?: boolean, eager?: boolean, blockSize?: number }} o
 */
export function speeds(p, o) {
  const s = p.speed ?? {};
  const fa = o.flashAttn === 'off' ? (s.faOffDepthFactor ?? 2) : 1;
  const d = o.depth / 32768;
  let decode = (p.decodeTps ?? 120) / (1 + (s.depthSlowdown ?? 0) * fa * d);
  let prefill = ((p.prefillTps ?? 4000) * ((o.ubatch ?? 512) / 512) ** (s.ubatchExponent ?? 0)) / (1 + (s.prefillDepthSlowdown ?? 0) * fa * d);
  decode *= s.kvDecodeFactor?.[o.kvFormat ?? o.kvType ?? 'f16'] ?? s.kvDecodeFactor?.[o.kvType ?? 'f16'] ?? 1;
  if (o.unified) decode *= s.unifiedDecodeFactor ?? 1;
  if (o.eager) decode *= s.eagerDecodeFactor ?? 0.85;
  if (o.blockSize !== undefined) decode *= s.blockSizeDecodeFactor?.[String(o.blockSize)] ?? 1;
  // Mixed K/V types run on slow generic kernels.
  if ((o.kvType ?? 'f16') !== (o.kvTypeV ?? o.kvType ?? 'f16')) decode *= 0.5;
  if (o.spill) {
    decode *= s.spillFactor ?? 0.07;
    prefill *= 0.3;
  }
  decode *= 1 - (s.offloadPenalty ?? 0.7) * (o.cpuShare ?? 0);
  return { decode, prefill };
}

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

/** vLLM progress bars of the fake: checkpoint shards and CUDA graphs. */
const SHARDS = 4;
const GRAPHS = 8;

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
 * @property {boolean} [prefixCaching] vLLM: reuse cached prompt prefixes (default true, like vLLM V1; --no-enable-prefix-caching).
 * @property {boolean} [promptTokensDetails] vLLM: report usage.prompt_tokens_details.cached_tokens (--enable-prompt-tokens-details).
 * @property {number} [kvTokens] GPU KV cache size in tokens reported by vLLM (default 164816).
 * @property {boolean} [kvUnified] llama.cpp --kv-unified / --no-kv-unified (default: unified only with automatic slots).
 * @property {number} [cacheReuse] llama.cpp --cache-reuse N (accepted; a plain prefix is reused anyway).
 * @property {string} [kvFormat]   vLLM fp8_e4m3 / fp8_e5m2 (kvType is then 'fp8').
 * @property {number} [blockSize]  vLLM --block-size.
 * @property {number[]} [graphSizes] vLLM CUDA graph capture sizes.
 */

/** vLLM caches whole blocks of this many tokens. */
const VLLM_BLOCK = 16;

/** Length of the common prefix of two token arrays. */
export function commonPrefix(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

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
  // llama.cpp: one KV pool for every slot with --kv-unified, or by default when the slot count is automatic.
  const unified = flavor === 'llamacpp' && (o.kvUnified ?? !(o.np && o.np > 0));
  /** Tokens one request can hold: llama.cpp splits -c across the slots unless the pool is unified. */
  const slotCtx = flavor === 'llamacpp' && !unified ? Math.floor(ctx / np) : ctx;
  const vramMiB = p.vramMiB ?? 4500;
  const busyLoad = p.busy ?? { utilPct: 97, powerW: 450, tempC: 68 };
  const gpu = new GpuState(o.stateFile, { watchdog: o.watchdog });
  const rand = mulberry32(p.seed ?? 1);
  // The memory model (when the profile has one) decides what loads, what spills and how much VRAM it holds.
  const mem = p.memory
    ? memoryPlan(p.memory, { flavor, ctx, kvType: o.kvType, ubatch: o.ubatch, nCpuMoe: o.nCpuMoe, gpuLayers: o.gpuLayers, gpuMemoryUtilization: o.gpuMemoryUtilization, eager: o.eager, blockSize: o.blockSize, graphSizes: o.graphSizes })
    : undefined;
  const c = { model, host, port: o.port ?? 8080, ctx, np, nLayers: p.nLayers ?? 33, vramMiB: mem ? mem.vramMiB : vramMiB, flashAttn: o.flashAttn ?? 'auto', kvType: o.kvType ?? 'f16', kvCapacity: mem?.capacity, kvTokens: o.kvTokens ?? mem?.capacity ?? 164_816 };
  /** vLLM without a CUDA graph for this many requests at once runs eagerly. */
  const eagerAt = (busy) => flavor === 'vllm' && (o.eager === true || (o.graphSizes !== undefined && busy > Math.max(...o.graphSizes)));
  const rates = (depth, busy = 1) =>
    speeds(p, {
      depth,
      flashAttn: o.flashAttn,
      kvType: o.kvType,
      kvTypeV: o.kvTypeV,
      kvFormat: o.kvFormat,
      ubatch: o.ubatch,
      spill: mem?.outcome === 'spill',
      cpuShare: mem?.cpuShare,
      unified: unified && np > 1,
      eager: eagerAt(busy),
      blockSize: o.blockSize,
    });
  /** vLLM /metrics: prompt tokens looked up in the prefix cache and found there. */
  const prefixStats = { queries: 0, hits: 0 };

  let loaded = false;
  let closed = false;
  let totalTokens = 0;
  let nextTask = 0;
  /** llama.cpp slots: busy flags and what each one holds (prompt + answer of its last request). */
  const slotBusy = Array.from({ length: np }, () => false);
  const slotCache = Array.from({ length: np }, () => []);
  /** Requests waiting for a slot; `want` = their id_slot, if any. */
  const waiting = [];
  /** vLLM prefix cache: recent sequences (prompt + answer), newest last, within the KV cache size. */
  const prefixCache = [];
  /** Prompts are read one at a time (like one GPU reading long prompts); answers are generated together. */
  let prefillTail = Promise.resolve();
  const sockets = new Set();
  const stalled = new Set();

  const fatal = (code, lines) => {
    out(lines);
    gpu.release();
    if (o.onFatal) o.onFatal(code);
    else void close();
  };

  const busySlots = () => slotBusy.filter(Boolean).length;
  /** A free slot: the one asked for (id_slot), else the first free one; undefined = wait. */
  const pickSlot = (want) => {
    if (want !== undefined && want < np) return slotBusy[want] ? undefined : want;
    const free = slotBusy.indexOf(false);
    return free < 0 ? undefined : free;
  };
  const acquireSlot = (want) =>
    new Promise((resolve) => {
      const slot = pickSlot(want);
      if (slot === undefined) waiting.push({ want, resolve });
      else {
        slotBusy[slot] = true;
        resolve(slot);
      }
    });
  const releaseSlot = (slot) => {
    slotBusy[slot] = false;
    const k = waiting.findIndex((w) => pickSlot(w.want) !== undefined);
    if (k < 0) return;
    const [w] = waiting.splice(k, 1);
    const next = pickSlot(w.want);
    slotBusy[next] = true;
    w.resolve(next);
  };
  /** Waits for the reading of earlier prompts; resolves to the function that lets the next one read. */
  const prefillTurn = () => {
    let release;
    const prev = prefillTail;
    prefillTail = new Promise((r) => (release = r));
    return prev.then(() => release);
  };
  /** Tokens of `ids` the cache already holds. */
  const cachedFor = (ids, slot, usePromptCache) => {
    if (flavor === 'llamacpp') {
      // llama.cpp re-reads at least the last prompt token.
      return usePromptCache ? Math.min(commonPrefix(slotCache[slot], ids), Math.max(0, ids.length - 1)) : 0;
    }
    if (o.prefixCaching === false) return 0;
    const best = prefixCache.reduce((m, seq) => Math.max(m, commonPrefix(seq, ids)), 0);
    // Whole blocks only, and never the last token (vLLM recomputes it).
    return Math.floor(Math.min(best, Math.max(0, ids.length - 1)) / VLLM_BLOCK) * VLLM_BLOCK;
  };
  const remember = (seq, slot) => {
    if (flavor === 'llamacpp') {
      slotCache[slot] = seq;
      return;
    }
    prefixCache.push(seq);
    let total = prefixCache.reduce((n, x) => n + x.length, 0);
    while (total > c.kvTokens && prefixCache.length > 1) total -= prefixCache.shift().length;
  };

  /**
   * Generation shared by both flavours. `emit` sends one chunk of ids. The part of the prompt the
   * cache holds is not read again; reading waits for the prompts sent before (one at a time).
   */
  async function generate(res, { ids, n, perChunk, emit, finish, want, usePromptCache }) {
    const promptN = ids.length;
    const slot = await acquireSlot(want);
    const task = nextTask++;
    let aborted = false;
    res.on('close', () => {
      aborted = !res.writableFinished;
    });
    if (flavor === 'llamacpp') out(L.llamaTaskStart(slot, task, promptN, ctx));
    gpu.setLoad(busyLoad);
    const release = await prefillTurn();
    const cached = cachedFor(ids, slot, usePromptCache);
    const t0 = performance.now();
    const rate = rates(promptN, busySlots());
    prefixStats.queries += promptN;
    prefixStats.hits += cached;
    await sleep((((promptN - cached) / rate.prefill) * 1000) * scale);
    const tPrefill = performance.now();
    release();
    const generated = [];
    const seed = (p.seed ?? 1) + task;
    let k = 0;
    // Time at which the last emitted token was due. Targets are relative to it, not to "now":
    // Windows timers fire with ~15.6 ms granularity, so an oversleep is caught up by emitting
    // the overdue chunks back to back and the average rate stays exact.
    let due = tPrefill;
    try {
      while (k < n && !aborted && !closed) {
        const m = Math.min(perChunk, n - k);
        const perToken = (1000 / rate.decode) * scale * (1 + 0.15 * Math.max(0, busySlots() - 1));
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
          generated.push(genId(seed, k));
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
      // promptN = tokens actually read (llama.cpp prompt_n); the reading time excludes the wait for a turn.
      const timings = { cacheN: cached, promptN: promptN - cached, promptMs: tPrefill - t0, predictedN: k, predictedMs: tEnd - tPrefill };
      remember([...ids, ...generated], slot);
      finish(timings);
      if (flavor === 'llamacpp') out(L.llamaTaskDone(slot, task, timings));
    } finally {
      if (!stalled.has(res)) {
        releaseSlot(slot);
        if (busySlots() === 0) gpu.setLoad(null);
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
      if (promptN > slotCtx) {
        return sendJson(res, 400, {
          error: { code: 400, message: 'the request exceeds the available context size, try increasing it', type: 'exceed_context_size_error', n_prompt_tokens: promptN, n_ctx: slotCtx },
        });
      }
      const room = slotCtx - promptN;
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
        id_slot: slotOf,
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
          cache_n: t.cacheN,
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
      const want = typeof body.id_slot === 'number' && body.id_slot >= 0 ? body.id_slot : undefined;
      const slotOf = want ?? 0;
      await generate(res, {
        ids,
        n,
        perChunk: Math.max(1, p.tokensPerChunk ?? 1),
        want,
        usePromptCache: body.cache_prompt === true,
        emit: (batch, k) => {
          const content = detokenize(batch);
          text += content;
          if (!stream) return;
          const chunk = { index: 0, content, ...(returnTokens ? { tokens: batch } : {}), stop: false, id_slot: slotOf, tokens_predicted: k, tokens_evaluated: promptN };
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
    if (url.pathname === '/metrics' && req.method === 'GET') {
      const style = p.vllmMetrics ?? 'counters';
      if (style === 'none') return sendJson(res, 404, { detail: 'Not Found' });
      const labels = `{engine="0",model_name="${alias}"}`;
      const lines =
        style === 'gauge'
          ? ['# HELP vllm:gpu_prefix_cache_hit_rate GPU prefix cache block hit rate.', '# TYPE vllm:gpu_prefix_cache_hit_rate gauge', `vllm:gpu_prefix_cache_hit_rate${labels} ${prefixStats.queries ? prefixStats.hits / prefixStats.queries : 0}`]
          : [
              '# HELP vllm:prefix_cache_queries_total Prefix cache queries, in terms of number of queried tokens.',
              '# TYPE vllm:prefix_cache_queries_total counter',
              `vllm:prefix_cache_queries_total${labels} ${prefixStats.queries.toFixed(1)}`,
              '# HELP vllm:prefix_cache_hits_total Prefix cache hits, in terms of number of cached tokens.',
              '# TYPE vllm:prefix_cache_hits_total counter',
              `vllm:prefix_cache_hits_total${labels} ${prefixStats.hits.toFixed(1)}`,
            ];
      const text = `${['# HELP vllm:num_requests_running Number of requests in model execution batches.', '# TYPE vllm:num_requests_running gauge', `vllm:num_requests_running${labels} 0.0`, ...lines].join('\n')}\n`;
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
      return res.end(text);
    }
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
      let cachedTokens = 0;
      const usage = (k) => ({
        prompt_tokens: promptN,
        total_tokens: promptN + k,
        completion_tokens: k,
        ...(o.promptTokensDetails ? { prompt_tokens_details: { cached_tokens: cachedTokens } } : {}),
      });
      let text = '';
      if (stream) res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      await generate(res, {
        ids,
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
          cachedTokens = t.cacheN;
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
      if ((p.oomAtLoad || mem?.outcome === 'oom') && i === 3) throw Object.assign(new Error('oom'), { lines: L.llamaOom(c) });
      gpu.setMem(Math.round(c.vramMiB * 0.85 * (i / 5)));
    }
    out(L.llamaContext(c));
    gpu.setMem(c.vramMiB);
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
    if (mem?.outcome === 'busy') {
      const m = /** @type {FakeMemory} */ (p.memory);
      throw Object.assign(new Error('busy'), { lines: L.vllmVramBusy(m.freeMiB ?? m.totalMiB, m.totalMiB, o.gpuMemoryUtilization ?? 0.9) });
    }
    // Checkpoint shards one by one (a tqdm bar in the real log).
    for (let i = 0; i <= SHARDS; i++) {
      out([L.vllmShards(i, SHARDS)]);
      if (i < SHARDS) await sleep((loadMs * 0.4) / SHARDS);
    }
    gpu.setMem(Math.round(c.vramMiB * 0.6));
    out(L.vllmWeights((loadMs * 0.4) / 1000));
    if (p.oomAtLoad) throw Object.assign(new Error('oom'), { lines: L.vllmOom() });
    out(L.vllmModelLoaded(c, (loadMs * 0.5) / 1000));
    await sleep(loadMs * 0.2);
    out(L.vllmCompile((loadMs * 0.2) / 1000));
    out(L.vllmKvCache(c));
    if (mem?.outcome === 'kv-too-small') throw Object.assign(new Error('kv'), { lines: L.vllmKvTooSmall(c) });
    for (let i = 0; i <= GRAPHS; i += GRAPHS / 4) {
      out([L.vllmGraphs(i, GRAPHS)]);
      if (i < GRAPHS) await sleep((loadMs * 0.2) / 4);
    }
    out(L.vllmGraphsDone((loadMs * 0.2) / 1000));
    gpu.setMem(c.vramMiB);
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
