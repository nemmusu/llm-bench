import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../../../src/contract/errors';
import { readSseJson } from '../../../../src/core/inference/sse';
import { bodyStream } from './helpers';

async function collect(res: Response, opts: Parameters<typeof readSseJson>[1] = {}): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const v of readSseJson(res, opts)) out.push(v);
  return out;
}

async function failure(p: Promise<unknown>): Promise<AppError> {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(AppError);
  return e as AppError;
}

const sse = (chunks: (string | Uint8Array)[], opts?: Parameters<typeof bodyStream>[1]) => new Response(bodyStream(chunks, opts));

describe('readSseJson', () => {
  it('yields JSON payloads, skips comments and unknown fields, stops at [DONE]', async () => {
    const res = sse([': hello\n\n', 'data: {"a":1}\n\n', 'foo: bar\nretry: x\n\n', 'data: [1,2]\n\n', 'data: [DONE]\n\n', 'data: {"late":1}\n\n']);
    expect(await collect(res, { path: '/c' })).toEqual([{ a: 1 }, [1, 2]]);
  });

  it('handles CRLF, multi-line data and a final event without its blank line', async () => {
    const res = sse(['data: {"a":\r\n', 'data: 2}\r\n\r\n', 'data: {"tail":true}']);
    expect(await collect(res)).toEqual([{ a: 2 }, { tail: true }]);
  });

  it('decodes UTF-8 characters split across chunks', async () => {
    const bytes = new TextEncoder().encode('data: {"s":"é€😀"}\n\n');
    const parts = Array.from(bytes, (b) => new Uint8Array([b]));
    expect(await collect(sse(parts))).toEqual([{ s: 'é€😀' }]);
  });

  it('property: any chunking of any event sequence yields the same payloads', async () => {
    const payload = fc.record({ i: fc.integer(), s: fc.string({ unit: 'grapheme', maxLength: 20 }) });
    await fc.assert(
      fc.asyncProperty(
        fc.array(payload, { maxLength: 15 }),
        fc.array(fc.nat(), { maxLength: 30 }),
        fc.boolean(),
        async (events, cuts, crlf) => {
          const nl = crlf ? '\r\n' : '\n';
          const text = events.map((e) => `: c${nl}data: ${JSON.stringify(e)}${nl}${nl}`).join('');
          const bytes = new TextEncoder().encode(text);
          const points = [...new Set(cuts.map((c) => (bytes.length ? c % bytes.length : 0)))].sort((a, b) => a - b);
          const chunks: Uint8Array[] = [];
          let prev = 0;
          for (const p of [...points, bytes.length]) {
            chunks.push(bytes.slice(prev, p));
            prev = p;
          }
          expect(await collect(sse(chunks))).toEqual(events);
        },
      ),
      { numRuns: 150 },
    );
  });

  it('rejects a response without a body', async () => {
    const e = await failure(collect(new Response(null), { path: '/x' }));
    expect(e.code).toBe('ENDPOINT_INVALID');
    expect(e.params).toEqual({ path: '/x' });
  });

  it('rejects invalid JSON data', async () => {
    const e = await failure(collect(sse(['data: {nope\n\n'])));
    expect(e.code).toBe('ENDPOINT_INVALID');
    expect(e.detail).toBe('{nope');
  });

  it('turns an `error:` field into an AppError (llama.cpp style)', async () => {
    const e = await failure(collect(sse(['data: {"a":1}\n\n', 'error: {"code":503,"message":"Loading model"}\n\n'])));
    expect(e.code).toBe('ENDPOINT_UNREACHABLE');
    const e2 = await failure(collect(sse(['error: not json\n\n'])));
    expect(e2.message).toContain('not json');
    const e3 = await failure(collect(sse(['error: {"error":{"message":"cuda out of memory"}}\n\n'])));
    expect(e3.code).toBe('ENGINE_OOM');
    const e4 = await failure(collect(sse(['error\n\n'])));
    expect(e4.code).toBe('ENDPOINT_INVALID');
    // The first error wins.
    const e5 = await failure(collect(sse(['error: {"message":"first"}\nerror: {"message":"second"}\n\n'])));
    expect(e5.message).toContain('first');
  });

  it('turns an `event: error` block into an AppError', async () => {
    const e = await failure(collect(sse(['event: error\ndata: {"message":"bad request","code":400}\n\n'])));
    expect(e.code).toBe('ENDPOINT_INVALID');
    expect(e.message).toContain('bad request');
  });

  it('fails when one event exceeds the buffer cap', async () => {
    const e = await failure(collect(sse([`data: "${'x'.repeat(100)}`]), { maxBufferSize: 10 }));
    expect(e.message).toContain('too large');
  });

  it('maps a broken connection to ENDPOINT_UNREACHABLE', async () => {
    const e = await failure(collect(sse(['data: {"a":1}\n\n'], { error: new Error('socket hang up') })));
    expect(e.code).toBe('ENDPOINT_UNREACHABLE');
    const ac = new AbortController();
    const e2 = await failure(collect(sse(['data: {"a":1}\n\n'], { error: new Error('reset') }), { signal: ac.signal }));
    expect(e2.code).toBe('ENDPOINT_UNREACHABLE');
  });

  it('works with a signal that never fires', async () => {
    expect(await collect(sse(['data: 1\n\n', 'data: 2\n\n']), { signal: new AbortController().signal })).toEqual([1, 2]);
  });

  it('is CANCELLED when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    expect((await failure(collect(sse(['data: 1\n\n']), { signal: ac.signal }))).code).toBe('CANCELLED');
  });

  it('is CANCELLED when aborted while waiting for data (even if cancel throws)', async () => {
    const ac = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise(() => undefined),
      cancel: () => {
        throw new Error('cannot cancel');
      },
    });
    const p = collect(new Response(body), { signal: ac.signal });
    setTimeout(() => ac.abort(), 5);
    expect((await failure(p)).code).toBe('CANCELLED');
  });

  it('is CANCELLED when the body errors because of our abort', async () => {
    const ac = new AbortController();
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start: (c) => {
        ctrl = c;
      },
    });
    const p = collect(new Response(body), { signal: ac.signal });
    // fetch errors the body and fires the signal in the same tick: the rejected read is seen after the abort.
    setTimeout(() => {
      ctrl.error(new DOMException('aborted', 'AbortError'));
      ac.abort();
    }, 5);
    expect((await failure(p)).code).toBe('CANCELLED');
  });

  it('cancels the body when the consumer stops early', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start: (c) => c.enqueue(new TextEncoder().encode('data: 1\n\ndata: 2\n\n')),
      cancel: () => {
        cancelled = true;
        throw new Error('ignored');
      },
    });
    for await (const v of readSseJson(new Response(body))) {
      expect(v).toBe(1);
      break;
    }
    expect(cancelled).toBe(true);
  });
});
