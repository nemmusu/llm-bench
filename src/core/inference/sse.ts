import { createParser } from 'eventsource-parser';
import { AppError } from '../../contract/errors';
import { cancelledError, payloadError } from './http';

export interface SseOptions {
  signal?: AbortSignal;
  /** Path used in error messages (e.g. "/completion"). */
  path?: string;
  /** Cap on a single buffered event (protects against a server that never ends a line). */
  maxBufferSize?: number;
}

const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024;

function parseData(data: string, path: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    throw new AppError('ENDPOINT_INVALID', `Invalid JSON in stream from ${path}`, {
      params: { path },
      detail: data.slice(0, 500),
    });
  }
}

/** Error carried by an `error:` field or an `event: error` block (older llama.cpp streams errors this way). */
function streamError(value: string, path: string): AppError {
  let payload: unknown;
  try {
    payload = JSON.parse(value);
  } catch {
    payload = value;
  }
  const inner = payload && typeof payload === 'object' && 'error' in payload ? (payload as { error: unknown }).error : payload;
  return payloadError(inner, path);
}

/**
 * Reads a `text/event-stream` body and yields every `data:` payload parsed as JSON.
 *
 * Handles arbitrary chunk boundaries (bytes are decoded in streaming mode, so a UTF-8 character
 * split across chunks is fine), comments and unknown fields (ignored), a final event without its
 * blank line, and `data: [DONE]` (ends the iteration). Failures are AppErrors: transport errors →
 * ENDPOINT_UNREACHABLE, malformed payloads → ENDPOINT_INVALID, our signal → CANCELLED.
 */
export async function* readSseJson(res: Response, opts: SseOptions = {}): AsyncGenerator<unknown, void, undefined> {
  const path = opts.path ?? res.url;
  const body = res.body;
  if (!body) throw new AppError('ENDPOINT_INVALID', `Streaming response from ${path} has no body`, { params: { path } });
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const pending: { event: string | undefined; data: string }[] = [];
  let failure: AppError | undefined;
  const parser = createParser({
    onEvent: (m) => pending.push({ event: m.event, data: m.data }),
    onError: (err) => {
      // For unknown-field errors the parser always sets `value` (a bare "error" line gives "").
      if (err.type === 'unknown-field' && err.field === 'error') failure ??= streamError(String(err.value), path);
      else if (err.type === 'max-buffer-size-exceeded') {
        failure ??= new AppError('ENDPOINT_INVALID', `Stream event from ${path} is too large`, { params: { path } });
      }
      // Other unknown fields and invalid `retry:` values are harmless: ignore them.
    },
    maxBufferSize: opts.maxBufferSize ?? DEFAULT_MAX_BUFFER,
  });
  const signal = opts.signal;
  const onAbort = () => {
    reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  let ended = false;
  try {
    if (signal?.aborted) throw cancelledError(signal.reason);
    for (;;) {
      for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
        if (next.event === 'error') throw streamError(next.data, path);
        if (next.data === '[DONE]') return;
        yield parseData(next.data, path);
      }
      if (failure) throw failure;
      if (ended) return;
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (e) {
        if (signal?.aborted) throw cancelledError(e);
        throw new AppError('ENDPOINT_UNREACHABLE', `Stream from ${path} was interrupted`, {
          params: { path },
          detail: String(e),
          cause: e,
        });
      }
      if (signal?.aborted) throw cancelledError(signal.reason);
      if (chunk.done) {
        ended = true;
        // Flush the decoder and dispatch a last event that lacks its terminating blank line.
        parser.feed(`${decoder.decode()}\n\n`);
      } else {
        parser.feed(decoder.decode(chunk.value, { stream: true }));
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    // Consumer stopped early, [DONE] arrived, or an error: release the connection.
    if (!ended) await reader.cancel().catch(() => undefined);
  }
}
