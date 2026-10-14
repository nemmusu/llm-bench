import type { z } from 'zod';
import { AppError, isAppError, type ErrorCode } from '../../contract/errors';
import type { Clock } from '../deps';

/** What every inference client needs from the outside world (injected so tests can fake it). */
export interface HttpDeps {
  fetch: typeof globalThis.fetch;
  clock: Clock;
}

/** Bytes of an error body kept in AppError.detail (bodies can be whole HTML pages). */
const DETAIL_MAX = 2000;

export function joinUrl(baseUrl: string, path: string): string {
  return baseUrl.replace(/\/+$/, '') + path;
}

export function cancelledError(cause?: unknown): AppError {
  return new AppError('CANCELLED', 'Request aborted', cause === undefined ? {} : { cause });
}

/** fetch() that maps transport failures to AppError (CANCELLED when our signal fired, else ENDPOINT_UNREACHABLE). */
export async function send(deps: HttpDeps, url: string, init: RequestInit): Promise<Response> {
  try {
    return await deps.fetch(url, init);
  } catch (e) {
    if (init.signal?.aborted) throw cancelledError(e);
    throw new AppError('ENDPOINT_UNREACHABLE', `Cannot reach ${url}`, { params: { url }, detail: String(e), cause: e });
  }
}

/** Extracts a human message from the error shapes used by llama.cpp, vLLM/OpenAI and FastAPI. */
export function errorMessageOf(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const o = body as Record<string, unknown>;
  const err = o.error;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && typeof (err as Record<string, unknown>).message === 'string') {
    return (err as Record<string, string>).message;
  }
  if (typeof o.message === 'string') return o.message;
  if (typeof o.detail === 'string') return o.detail;
  if (Array.isArray(o.detail)) {
    const msgs = o.detail.map((d) => (d && typeof d === 'object' ? (d as Record<string, unknown>).msg : undefined));
    const text = msgs.filter((m): m is string => typeof m === 'string').join('; ');
    return text || undefined;
  }
  return undefined;
}

/**
 * A prompt longer than the server's context, refused before any of it is read, in each engine's words:
 * NInfer (`context_length_exceeded`, "prepared prompt exceeds Engine max_context 262144"), vLLM ("This
 * model's maximum context length is 4096 tokens…"), SGLang ("The input (N tokens) is longer than the
 * model's context length (M tokens)"), llama.cpp (`exceed_context_size_error`, "the request exceeds
 * the available context size"), OpenAI and compatible servers (`context_length_exceeded`).
 */
const CONTEXT_EXCEEDED = /context_length_exceeded|exceed_context_size_error|\bmax_context\b|maximum context|context (?:size|length|window)|exceeds the available context|prompt is too long/i;
/** The codes of such a refusal, read in the whole error body too (where the message may say less). */
const CONTEXT_EXCEEDED_CODE = /\b(?:context_length_exceeded|exceed_context_size_error)\b/;

/** An error message (and its whole body, `body`) saying the prompt does not fit the server's context. */
export function promptExceedsContext(message: string, body = ''): boolean {
  return CONTEXT_EXCEEDED.test(message) || CONTEXT_EXCEEDED_CODE.test(body);
}

/** A request failed because the server refused its prompt as longer than the context (reason 'context_exceeded'). */
export function isContextExceeded(e: unknown): boolean {
  return isAppError(e) && e.params?.reason === 'context_exceeded';
}

/**
 * Maps an HTTP failure to an error code. `reason` (in params) lets the renderer pick a more
 * precise message. 503 means "reachable but not serving" (llama.cpp answers 503 "Loading model"
 * while it loads): we report ENDPOINT_UNREACHABLE because the user's remedy is the same (wait /
 * check the server); ENGINE_TIMEOUT stays reserved for the adapters' ready deadline. `body`: the
 * whole error body, where some engines put the code of a refusal (`context_length_exceeded`).
 */
export function classifyHttp(status: number, message: string, body = ''): { code: ErrorCode; reason?: string } {
  if (/out of memory|\boom\b|cudaMalloc failed/i.test(message)) return { code: 'ENGINE_OOM' };
  if (promptExceedsContext(message, body)) return { code: 'ENDPOINT_INVALID', reason: 'context_exceeded' };
  if (status === 401 || status === 403) return { code: 'ENDPOINT_INVALID', reason: 'auth' };
  if (status === 404) {
    return /model/i.test(message) ? { code: 'MODEL_NOT_FOUND' } : { code: 'ENDPOINT_INVALID', reason: 'not_found' };
  }
  if (status === 501) return { code: 'ENDPOINT_INVALID', reason: 'not_supported' };
  if (status === 503) return { code: 'ENDPOINT_UNREACHABLE', reason: 'unavailable' };
  return { code: 'ENDPOINT_INVALID' };
}

export function httpError(status: number, bodyText: string, path: string): AppError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    parsed = undefined;
  }
  const message = errorMessageOf(parsed) ?? (bodyText.trim().slice(0, 300) || `HTTP ${status}`);
  const { code, reason } = classifyHttp(status, message, bodyText);
  return new AppError(code, `HTTP ${status} from ${path}: ${message}`, {
    params: { status, path, ...(reason ? { reason } : {}) },
    detail: bodyText.slice(0, DETAIL_MAX),
  });
}

/** Builds the AppError for a non-2xx response, reading (and so releasing) its body. */
export async function responseError(res: Response, path: string): Promise<AppError> {
  const text = await res.text().catch(() => '');
  return httpError(res.status, text, path);
}

/** AppError for an error object found inside a stream (`{"error": inner}`); `inner.code` is the HTTP status when numeric. */
export function payloadError(inner: unknown, path: string): AppError {
  const code = inner && typeof inner === 'object' ? (inner as Record<string, unknown>).code : undefined;
  return httpError(typeof code === 'number' ? code : 500, JSON.stringify({ error: inner }), path);
}

/** Error object embedded in a stream payload (`{"error": {...}}`), if any. */
export function errorFromPayload(payload: unknown, path: string): AppError | undefined {
  if (!payload || typeof payload !== 'object' || !('error' in payload)) return undefined;
  return payloadError((payload as { error: unknown }).error, path);
}

/** Reads a JSON body and validates it; anything unexpected is ENDPOINT_INVALID. */
export async function readJson<T extends z.ZodType>(res: Response, schema: T, path: string): Promise<z.infer<T>> {
  const text = await res.text().catch(() => '');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new AppError('ENDPOINT_INVALID', `Response from ${path} is not JSON`, {
      params: { path },
      detail: text.slice(0, DETAIL_MAX),
    });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError('ENDPOINT_INVALID', `Unexpected response from ${path}`, {
      params: { path },
      detail: text.slice(0, DETAIL_MAX),
    });
  }
  return parsed.data;
}

/** Drains and ignores a body (keeps the connection reusable). */
export async function discard(res: Response): Promise<void> {
  await res.arrayBuffer().catch(() => undefined);
}

export function jsonHeaders(apiKey: string | undefined): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  };
}
