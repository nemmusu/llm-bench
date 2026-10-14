import { z } from 'zod';
import { AppError, isAppError } from '../../contract/errors';
import { discard, errorFromPayload, jsonHeaders, joinUrl, readJson, responseError, send, type HttpDeps } from './http';
import { modelsSchema, timingsSchema, toTimings, type ClientOptions } from './llamacpp-client';
import { toUsage, usageSchema } from './openai-client';
import { readSseJson } from './sse';
import type { EngineTimings, GenerateRequest, InferenceClient, StreamEvent, Usage } from './types';

/**
 * Put before every benchmark prompt: the prompt is a passage of a novel, and a chat model asked to
 * continue it keeps writing (an answer as long as the request allows), where the bare passage often
 * gets a short comment. Chat servers have no ignore_eos: this is what keeps the output close to the
 * length asked for. Its tokens are counted with the prompt (the server's usage says how many).
 */
export const CONTINUE_INSTRUCTION = 'Continue the following text.\n\n';

const deltaSchema = z.object({
  content: z.string().nullable().optional(),
  /** Thinking models stream their reasoning separately (NInfer, vLLM, SGLang: reasoning_content; some: reasoning). */
  reasoning_content: z.string().nullable().optional(),
  reasoning: z.string().nullable().optional(),
});
const chunkSchema = z.object({
  choices: z.array(z.object({ delta: deltaSchema.nullable().optional(), finish_reason: z.string().nullable().optional() })).optional(),
  usage: usageSchema.nullable().optional(),
  /** llama.cpp-style timings some servers add to the last chunk (llama-server, NInfer). */
  timings: timingsSchema.optional(),
});

const unsupported = (reason: string, what: string) => new AppError('ENDPOINT_INVALID', `${what} unsupported`, { params: { reason } });

/**
 * Client for OpenAI-compatible `/v1/chat/completions` servers (flavor 'openai-chat'): servers that
 * have no `/v1/completions`, such as NInfer, and custom OpenAI servers set to "chat". Prompts are
 * text (chat servers take no token ids and have no /tokenize: the runner sends text and calibrates
 * its length on the prompt_tokens the server reports), sent as one user message after
 * CONTINUE_INSTRUCTION. Only standard fields are sent (strict servers reject unknown ones);
 * temperature 0 and the seed keep runs repeatable. What the server reports is used as is: usage
 * (prompt, completion and cached tokens) and, when present, llama.cpp-style `timings` (the engine's
 * own reading and generation times, draft acceptance, prefix-cache hits).
 */
export class ChatClient implements InferenceClient {
  readonly flavor = 'openai-chat' as const;
  readonly baseUrl: string;
  private readonly deps: HttpDeps;
  private readonly opts: ClientOptions;

  constructor(baseUrl: string, deps: HttpDeps, opts: ClientOptions = {}) {
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

  /** /v1/models answers 2xx (and lists the configured model, when there is one). Only cancellation throws. */
  async ready(signal?: AbortSignal): Promise<boolean> {
    try {
      if (this.opts.model !== undefined) return (await this.models(signal)).includes(this.opts.model);
      const res = await send(this.deps, joinUrl(this.baseUrl, '/v1/models'), this.init('GET', undefined, signal));
      await discard(res);
      return res.ok;
    } catch (e) {
      if (isAppError(e) && e.code === 'CANCELLED') throw e;
      return false;
    }
  }

  /** Chat servers have no tokenizer endpoint: the runner falls back to text prompts. */
  tokenize(): Promise<number[]> {
    return Promise.reject(unsupported('tokenize_unsupported', 'tokenize'));
  }

  async models(signal?: AbortSignal): Promise<string[]> {
    const res = await send(this.deps, joinUrl(this.baseUrl, '/v1/models'), this.init('GET', undefined, signal));
    if (!res.ok) throw await responseError(res, '/v1/models');
    return (await readJson(res, modelsSchema, '/v1/models')).data.map((m) => m.id);
  }

  requestBody(req: GenerateRequest): Record<string, unknown> {
    const model = req.model ?? this.opts.model;
    // A conversation goes as its turns (the instruction opens the first message), anything else as one message.
    const turns = req.chat?.length ? req.chat : [{ role: 'user' as const, content: req.promptText ?? '' }];
    return {
      ...(model !== undefined ? { model } : {}),
      messages: turns.map((m, i) => (i === 0 ? { role: m.role, content: `${CONTINUE_INSTRUCTION}${m.content}` } : { role: m.role, content: m.content })),
      max_tokens: req.outputTokens,
      temperature: 0,
      seed: req.seed,
      stream: true,
      stream_options: { include_usage: true },
      // Only when asked (reasoning switched off): strict servers reject fields they do not know.
      ...(this.opts.chatTemplateKwargs ? { chat_template_kwargs: this.opts.chatTemplateKwargs } : {}),
    };
  }

  async *generate(req: GenerateRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent, void, undefined> {
    if (req.promptIds !== undefined) throw unsupported('token_ids_unsupported', 'token-id prompts');
    const path = '/v1/chat/completions';
    const res = await send(this.deps, joinUrl(this.baseUrl, path), this.init('POST', this.requestBody(req), signal));
    if (!res.ok) throw await responseError(res, path);
    let usage: Usage | undefined;
    let timings: EngineTimings | undefined;
    let finish: string | undefined;
    for await (const raw of readSseJson(res, { path, ...(signal ? { signal } : {}) })) {
      const t = this.deps.clock.now();
      const err = errorFromPayload(raw, path);
      if (err) throw err;
      const parsed = chunkSchema.safeParse(raw);
      if (!parsed.success) continue;
      const c = parsed.data;
      if (c.usage) usage = toUsage(c.usage);
      if (c.timings) timings = toTimings(c.timings);
      const choices = c.choices ?? [];
      // The last usage-only chunk (choices: []) carries totals, not text.
      if (choices.length === 0) continue;
      for (const ch of choices) if (ch.finish_reason) finish = ch.finish_reason;
      // Reasoning is generated output too: it takes the same time per token as the answer.
      const text = choices.map((ch) => `${ch.delta?.reasoning_content ?? ch.delta?.reasoning ?? ''}${ch.delta?.content ?? ''}`).join('');
      yield { kind: 'chunk', t, textLen: text.length, ...(text ? { text } : {}) };
    }
    yield {
      kind: 'done',
      t: this.deps.clock.now(),
      ...(usage ? { usage } : {}),
      ...(timings ? { timings } : {}),
      ...(finish ? { finishReason: finish } : {}),
    };
  }
}
