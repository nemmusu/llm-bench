import { z } from 'zod';
import { AppError, isAppError } from '../../contract/errors';
import { discard, errorFromPayload, jsonHeaders, joinUrl, readJson, responseError, send, type HttpDeps } from './http';
import { modelsSchema, type ClientOptions } from './llamacpp-client';
import { readSseJson } from './sse';
import type { GenerateRequest, InferenceClient, StreamEvent, Usage } from './types';

const tokenizeSchema = z.object({ tokens: z.array(z.number()) });

const usageSchema = z.object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional() });
const chunkSchema = z.object({
  choices: z.array(z.object({ text: z.string().optional(), finish_reason: z.string().nullable().optional() })).optional(),
  usage: usageSchema.nullable().optional(),
});

function toUsage(u: z.infer<typeof usageSchema>): Usage {
  return {
    ...(u.prompt_tokens !== undefined ? { promptTokens: u.prompt_tokens } : {}),
    ...(u.completion_tokens !== undefined ? { completionTokens: u.completion_tokens } : {}),
  };
}

/**
 * Client for OpenAI-compatible `/v1/completions` servers: vLLM (flavor "vllm") and any other
 * compatible endpoint (flavor "openai"). vLLM gets `min_tokens`/`ignore_eos` (exact output length)
 * and `continuous_usage_stats` (exact tokens per chunk); a generic server only gets the standard
 * fields, because strict implementations reject unknown ones.
 */
export class OpenAiClient implements InferenceClient {
  readonly flavor: 'vllm' | 'openai';
  readonly baseUrl: string;
  private readonly deps: HttpDeps;
  private readonly opts: ClientOptions;

  constructor(flavor: 'vllm' | 'openai', baseUrl: string, deps: HttpDeps, opts: ClientOptions = {}) {
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

  /**
   * vLLM: /health 200 AND the model is listed in /v1/models (the API answers before weights are
   * loaded on some versions). Generic: /v1/models answers 2xx. Only cancellation throws.
   */
  async ready(signal?: AbortSignal): Promise<boolean> {
    try {
      if (this.flavor === 'vllm') {
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

  /** vLLM /tokenize. Generic OpenAI servers have no tokenizer endpoint: the runner falls back to text prompts. */
  async tokenize(text: string, opts: { addSpecial?: boolean; signal?: AbortSignal } = {}): Promise<number[]> {
    if (this.flavor !== 'vllm') {
      throw new AppError('ENDPOINT_INVALID', 'tokenize unsupported', { params: { reason: 'tokenize_unsupported' } });
    }
    const body = { model: this.opts.model, prompt: text, add_special_tokens: opts.addSpecial ?? false };
    const res = await send(this.deps, joinUrl(this.baseUrl, '/tokenize'), this.init('POST', body, opts.signal));
    if (!res.ok) throw await responseError(res, '/tokenize');
    return (await readJson(res, tokenizeSchema, '/tokenize')).tokens;
  }

  async models(signal?: AbortSignal): Promise<string[]> {
    const res = await send(this.deps, joinUrl(this.baseUrl, '/v1/models'), this.init('GET', undefined, signal));
    if (!res.ok) throw await responseError(res, '/v1/models');
    return (await readJson(res, modelsSchema, '/v1/models')).data.map((m) => m.id);
  }

  requestBody(req: GenerateRequest): Record<string, unknown> {
    const vllm = this.flavor === 'vllm';
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
      const textLen = choices.reduce((n, ch) => n + (ch.text?.length ?? 0), 0);
      // Continuous usage gives a running completion count: the delta is this chunk's exact tokens.
      const running = c.usage?.completion_tokens;
      let tokens: number | undefined;
      if (running !== undefined) {
        tokens = running - completionSoFar;
        completionSoFar = running;
      }
      yield { kind: 'chunk', t, textLen, ...(tokens !== undefined ? { tokens } : {}) };
    }
    yield {
      kind: 'done',
      t: this.deps.clock.now(),
      ...(usage ? { usage } : {}),
      ...(finish ? { finishReason: finish } : {}),
    };
  }
}
