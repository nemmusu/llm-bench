import { z } from 'zod';
import { AppError, isAppError } from '../../contract/errors';
import { discard, errorFromPayload, jsonHeaders, joinUrl, readJson, responseError, send, type HttpDeps } from './http';
import { modelsSchema, type ClientOptions } from './llamacpp-client';
import { parsePrefixCacheMetrics, type PrefixCacheReading } from './prefix-metrics';
import { readSseJson } from './sse';
import type { GenerateRequest, InferenceClient, StreamEvent, Usage } from './types';

const tokenizeSchema = z.object({ tokens: z.array(z.number()) });

const usageSchema = z.object({
  prompt_tokens: z.number().optional(),
  completion_tokens: z.number().optional(),
  /** vLLM with --enable-prompt-tokens-details: how much of the prompt came from the prefix cache. */
  prompt_tokens_details: z.object({ cached_tokens: z.number().nullable().optional() }).nullable().optional(),
});
const chunkSchema = z.object({
  choices: z.array(z.object({ text: z.string().optional(), finish_reason: z.string().nullable().optional() })).optional(),
  usage: usageSchema.nullable().optional(),
});

function toUsage(u: z.infer<typeof usageSchema>): Usage {
  return {
    ...(u.prompt_tokens !== undefined ? { promptTokens: u.prompt_tokens } : {}),
    ...(u.completion_tokens !== undefined ? { completionTokens: u.completion_tokens } : {}),
    ...(typeof u.prompt_tokens_details?.cached_tokens === 'number' ? { cachedTokens: u.prompt_tokens_details.cached_tokens } : {}),
  };
}

/** Flavors served by this client: vLLM, SGLang and any other OpenAI-compatible server. */
export type OpenAiFlavor = 'vllm' | 'sglang' | 'openai';

/**
 * Client for OpenAI-compatible `/v1/completions` servers: vLLM (flavor "vllm"), SGLang ("sglang")
 * and any other compatible endpoint ("openai"). vLLM and SGLang get `min_tokens`/`ignore_eos`
 * (exact output length) and `continuous_usage_stats` (exact tokens per chunk), and take token-id
 * prompts; a generic server only gets the standard fields, because strict implementations reject
 * unknown ones. SGLang reports prefix-cache reuse in usage.prompt_tokens_details.cached_tokens
 * (--enable-cache-report).
 */
export class OpenAiClient implements InferenceClient {
  readonly flavor: OpenAiFlavor;
  readonly baseUrl: string;
  private readonly deps: HttpDeps;
  private readonly opts: ClientOptions;

  constructor(flavor: OpenAiFlavor, baseUrl: string, deps: HttpDeps, opts: ClientOptions = {}) {
    this.flavor = flavor;
    this.baseUrl = baseUrl;
    this.deps = deps;
    this.opts = opts;
  }

  private init(method: 'GET' | 'POST', body: unknown, signal: AbortSignal | undefined): RequestInit {
    return {
      method,
      headers: jsonHeaders(this.opts.apiKey),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    };
  }

  /** vLLM and SGLang: the engine extensions (exact lengths, token ids, /health, /tokenize). */
  private get engine(): boolean {
    return this.flavor !== 'openai';
  }

  /**
   * vLLM / SGLang: /health 200 AND the model is listed in /v1/models (the API answers before weights
   * are loaded on some versions). Generic: /v1/models answers 2xx. Only cancellation throws.
   */
  async ready(signal?: AbortSignal): Promise<boolean> {
    try {
      if (this.engine) {
        const health = await send(this.deps, joinUrl(this.baseUrl, '/health'), this.init('GET', undefined, signal));
        await discard(health);
        if (health.status !== 200) return false;
        const ids = await this.models(signal);
        return this.opts.model ? ids.includes(this.opts.model) : ids.length > 0;
      }
      const res = await send(this.deps, joinUrl(this.baseUrl, '/v1/models'), this.init('GET', undefined, signal));
      await discard(res);
      return res.ok;
    } catch (e) {
      if (isAppError(e) && e.code === 'CANCELLED') throw e;
      return false;
    }
  }

  /**
   * vLLM / SGLang /tokenize (same request and `tokens` answer). Generic OpenAI servers, and SGLang
   * builds without the endpoint (404/405), have no tokenizer: the runner falls back to text prompts.
   */
  async tokenize(text: string, opts: { addSpecial?: boolean; signal?: AbortSignal } = {}): Promise<number[]> {
    const unsupported = () => new AppError('ENDPOINT_INVALID', 'tokenize unsupported', { params: { reason: 'tokenize_unsupported' } });
    if (!this.engine) throw unsupported();
    const body = { model: this.opts.model, prompt: text, add_special_tokens: opts.addSpecial ?? false };
    const res = await send(this.deps, joinUrl(this.baseUrl, '/tokenize'), this.init('POST', body, opts.signal));
    if (this.flavor === 'sglang' && (res.status === 404 || res.status === 405)) {
      await discard(res);
      throw unsupported();
    }
    if (!res.ok) throw await responseError(res, '/tokenize');
    return (await readJson(res, tokenizeSchema, '/tokenize')).tokens;
  }

  /**
   * vLLM's prefix-cache counters from its Prometheus /metrics; undefined for other servers, when the
   * endpoint is missing or says nothing about the prefix cache. Only cancellation throws.
   */
  async prefixCache(signal?: AbortSignal): Promise<PrefixCacheReading | undefined> {
    if (this.flavor !== 'vllm') return undefined;
    try {
      const res = await send(this.deps, joinUrl(this.baseUrl, '/metrics'), this.init('GET', undefined, signal));
      if (!res.ok) {
        await discard(res);
        return undefined;
      }
      return parsePrefixCacheMetrics(await res.text());
    } catch (e) {
      if (isAppError(e) && e.code === 'CANCELLED') throw e;
      return undefined;
    }
  }

  async models(signal?: AbortSignal): Promise<string[]> {
    const res = await send(this.deps, joinUrl(this.baseUrl, '/v1/models'), this.init('GET', undefined, signal));
    if (!res.ok) throw await responseError(res, '/v1/models');
    return (await readJson(res, modelsSchema, '/v1/models')).data.map((m) => m.id);
  }

  requestBody(req: GenerateRequest): Record<string, unknown> {
    const vllm = this.engine;
    const model = req.model ?? this.opts.model;
    return {
      ...(model !== undefined ? { model } : {}),
      prompt: req.promptIds ?? req.promptText ?? '',
      max_tokens: req.outputTokens,
      temperature: 0,
      seed: req.seed,
      stream: true,
      stream_options: vllm ? { include_usage: true, continuous_usage_stats: true } : { include_usage: true },
      ...(vllm ? { min_tokens: req.outputTokens, ignore_eos: true } : {}),
    };
  }

  async *generate(req: GenerateRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent, void, undefined> {
    const path = '/v1/completions';
    const res = await send(this.deps, joinUrl(this.baseUrl, path), this.init('POST', this.requestBody(req), signal));
    if (!res.ok) throw await responseError(res, path);
    let usage: Usage | undefined;
    let finish: string | undefined;
    let completionSoFar = 0;
    for await (const raw of readSseJson(res, { path, ...(signal ? { signal } : {}) })) {
      const t = this.deps.clock.now();
      const err = errorFromPayload(raw, path);
      if (err) throw err;
      const parsed = chunkSchema.safeParse(raw);
      if (!parsed.success) continue;
      const c = parsed.data;
      if (c.usage) usage = toUsage(c.usage);
      const choices = c.choices ?? [];
      // The last usage-only chunk (choices: []) carries totals, not text.
      if (choices.length === 0) continue;
      for (const ch of choices) if (ch.finish_reason) finish = ch.finish_reason;
      const text = choices.map((ch) => ch.text ?? '').join('');
      // Continuous usage gives a running completion count: the delta is this chunk's exact tokens.
      const running = c.usage?.completion_tokens;
      let tokens: number | undefined;
      if (running !== undefined) {
        tokens = running - completionSoFar;
        completionSoFar = running;
      }
      yield { kind: 'chunk', t, textLen: text.length, ...(tokens !== undefined ? { tokens } : {}), ...(text ? { text } : {}) };
    }
    yield {
      kind: 'done',
      t: this.deps.clock.now(),
      ...(usage ? { usage } : {}),
      ...(finish ? { finishReason: finish } : {}),
    };
  }
}
