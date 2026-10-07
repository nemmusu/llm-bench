import { z } from 'zod';
import { AppError, isAppError } from '../../contract/errors';
import { discard, errorFromPayload, jsonHeaders, joinUrl, readJson, responseError, send, type HttpDeps } from './http';
import { readSseJson } from './sse';
import type { EngineTimings, GenerateRequest, InferenceClient, StreamEvent, Usage } from './types';

export interface ClientOptions {
  /** Model name for OpenAI-style APIs (vLLM served model name, external endpoint model). */
  model?: string;
  /** Sent as `Authorization: Bearer …` (llama-server --api-key, vLLM --api-key, external servers). */
  apiKey?: string;
}

const tokenizeSchema = z.object({ tokens: z.array(z.number()) });
export const modelsSchema = z.object({ data: z.array(z.object({ id: z.string() })) });

const timingsSchema = z.object({
  prompt_n: z.number().optional(),
  prompt_ms: z.number().optional(),
  predicted_n: z.number().optional(),
  predicted_ms: z.number().optional(),
  draft_n: z.number().optional(),
  draft_n_accepted: z.number().optional(),
});

const chunkSchema = z.object({
  content: z.string().optional(),
  tokens: z.array(z.number()).optional(),
  stop: z.boolean().optional(),
  stop_type: z.string().optional(),
  tokens_predicted: z.number().optional(),
  tokens_evaluated: z.number().optional(),
  timings: timingsSchema.optional(),
});
type LlamaChunk = z.infer<typeof chunkSchema>;

/** llama.cpp stop_type → OpenAI-style finish reason. */
function finishReason(stopType: string | undefined): string | undefined {
  if (stopType === 'limit') return 'length';
  if (stopType === 'eos' || stopType === 'word') return 'stop';
  return stopType;
}

function toTimings(t: LlamaChunk['timings']): EngineTimings | undefined {
  if (!t) return undefined;
  const out: EngineTimings = {};
  if (t.prompt_n !== undefined) out.promptN = t.prompt_n;
  if (t.prompt_ms !== undefined) out.promptMs = t.prompt_ms;
  if (t.predicted_n !== undefined) out.predictedN = t.predicted_n;
  if (t.predicted_ms !== undefined) out.predictedMs = t.predicted_ms;
  if (t.draft_n !== undefined) out.draftN = t.draft_n;
  if (t.draft_n_accepted !== undefined) out.draftNAccepted = t.draft_n_accepted;
  return out;
}

function toUsage(c: LlamaChunk): Usage | undefined {
  const promptTokens = c.tokens_evaluated ?? c.timings?.prompt_n;
  const completionTokens = c.tokens_predicted ?? c.timings?.predicted_n;
  if (promptTokens === undefined && completionTokens === undefined) return undefined;
  return {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
  };
}

function chunkEvent(c: LlamaChunk, t: number): StreamEvent {
  return {
    kind: 'chunk',
    t,
    textLen: c.content?.length ?? 0,
    ...(c.tokens ? { tokens: c.tokens.length, ids: c.tokens } : {}),
    ...(c.content ? { text: c.content } : {}),
  };
}

/**
 * Client for llama.cpp `llama-server` native endpoints (/health, /tokenize, /completion).
 * Prompts go as token ids, the cache is disabled and EOS ignored so every request processes
 * exactly P prompt tokens and generates exactly N tokens.
 */
export class LlamaCppClient implements InferenceClient {
  readonly flavor = 'llamacpp' as const;
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

  /** /health: 200 = ready, 503 = still loading, anything else (or no answer) = not ready. Only cancellation throws. */
  async ready(signal?: AbortSignal): Promise<boolean> {
    try {
      const res = await send(this.deps, joinUrl(this.baseUrl, '/health'), this.init('GET', undefined, signal));
      await discard(res);
      return res.status === 200;
    } catch (e) {
      if (isAppError(e) && e.code === 'CANCELLED') throw e;
      return false;
    }
  }

  async tokenize(text: string, opts: { addSpecial?: boolean; signal?: AbortSignal } = {}): Promise<number[]> {
    const body = { content: text, add_special: opts.addSpecial ?? false };
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
    return {
      prompt: req.promptIds ?? req.promptText ?? '',
      n_predict: req.outputTokens,
      ignore_eos: true,
      temperature: 0,
      seed: req.seed,
      cache_prompt: false,
      return_tokens: true,
      stream: true,
    };
  }

  async *generate(req: GenerateRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent, void, undefined> {
    const path = '/completion';
    const res = await send(this.deps, joinUrl(this.baseUrl, path), this.init('POST', this.requestBody(req), signal));
    if (!res.ok) throw await responseError(res, path);
    for await (const raw of readSseJson(res, { path, ...(signal ? { signal } : {}) })) {
      const t = this.deps.clock.now();
      const err = errorFromPayload(raw, path);
      if (err) throw err;
      const parsed = chunkSchema.safeParse(raw);
      if (!parsed.success) continue; // unknown event shape: not ours to interpret
      const c = parsed.data;
      if (!c.stop) {
        yield chunkEvent(c, t);
        continue;
      }
      // Some builds put the last piece of text in the final chunk: report it before `done`.
      if ((c.content?.length ?? 0) > 0 || (c.tokens?.length ?? 0) > 0) yield chunkEvent(c, t);
      const usage = toUsage(c);
      const timings = toTimings(c.timings);
      const reason = finishReason(c.stop_type);
      yield {
        kind: 'done',
        t,
        ...(usage ? { usage } : {}),
        ...(timings ? { timings } : {}),
        ...(reason ? { finishReason: reason } : {}),
      };
      return;
    }
    throw new AppError('ENDPOINT_INVALID', `Stream from ${path} ended before the final chunk`, { params: { path } });
  }
}
