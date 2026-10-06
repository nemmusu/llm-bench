import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../../../../src/contract/errors';
import {
  cancelledError,
  classifyHttp,
  discard,
  errorFromPayload,
  errorMessageOf,
  httpError,
  joinUrl,
  jsonHeaders,
  payloadError,
  readJson,
  responseError,
  send,
} from '../../../../src/core/inference/http';
import { bodyStream, steppingClock } from './helpers';

const clock = steppingClock();

describe('joinUrl / jsonHeaders / cancelledError', () => {
  it('joins without double slashes', () => {
    expect(joinUrl('http://h:1/', '/health')).toBe('http://h:1/health');
    expect(joinUrl('http://h:1//', '/x')).toBe('http://h:1/x');
  });
  it('adds a bearer token only when configured', () => {
    expect(jsonHeaders(undefined)).not.toHaveProperty('authorization');
    expect(jsonHeaders('k')).toMatchObject({ authorization: 'Bearer k', 'content-type': 'application/json' });
  });
  it('cancelledError keeps an optional cause', () => {
    expect(cancelledError().code).toBe('CANCELLED');
    expect(cancelledError('why').cause).toBe('why');
  });
});

describe('send', () => {
  it('returns the response', async () => {
    const res = await send({ clock, fetch: async () => new Response('ok') }, 'http://x', {});
    expect(await res.text()).toBe('ok');
  });
  it('maps transport errors to ENDPOINT_UNREACHABLE', async () => {
    const err = await send({ clock, fetch: async () => Promise.reject(new TypeError('fetch failed')) }, 'http://x/y', {}).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('ENDPOINT_UNREACHABLE');
    expect((err as AppError).params).toEqual({ url: 'http://x/y' });
  });
  it('maps failures after our abort to CANCELLED', async () => {
    const ac = new AbortController();
    ac.abort();
    const err = (await send({ clock, fetch: async () => Promise.reject(new Error('aborted')) }, 'http://x', { signal: ac.signal }).catch(
      (e: unknown) => e,
    )) as AppError;
    expect(err.code).toBe('CANCELLED');
  });
});

describe('errorMessageOf', () => {
  it.each([
    [{ error: 'plain' }, 'plain'],
    [{ error: { message: 'nested', code: 400 } }, 'nested'],
    [{ message: 'top' }, 'top'],
    [{ detail: 'fastapi' }, 'fastapi'],
    [{ detail: [{ msg: 'a' }, { msg: 'b' }, 'x', null] }, 'a; b'],
  ])('reads %j', (body, msg) => {
    expect(errorMessageOf(body)).toBe(msg);
  });
  it.each([[null], ['str'], [{}], [{ error: { code: 1 } }], [{ error: 5 }], [{ detail: [{}] }]])('returns undefined for %j', (b) => {
    expect(errorMessageOf(b)).toBeUndefined();
  });
});

describe('classifyHttp', () => {
  it.each([
    [500, 'CUDA error: out of memory', 'ENGINE_OOM', undefined],
    [500, 'cudaMalloc failed', 'ENGINE_OOM', undefined],
    [400, 'the request exceeds the available context size', 'ENDPOINT_INVALID', 'context_exceeded'],
    [400, "This model's maximum context length is 4096 tokens", 'ENDPOINT_INVALID', 'context_exceeded'],
    [401, 'Invalid API Key', 'ENDPOINT_INVALID', 'auth'],
    [403, 'forbidden', 'ENDPOINT_INVALID', 'auth'],
    [404, 'The model `x` does not exist.', 'MODEL_NOT_FOUND', undefined],
    [404, 'File Not Found', 'ENDPOINT_INVALID', 'not_found'],
    [501, 'not supported', 'ENDPOINT_INVALID', 'not_supported'],
    [503, 'Loading model', 'ENDPOINT_UNREACHABLE', 'unavailable'],
    [500, 'boom', 'ENDPOINT_INVALID', undefined],
  ])('%i %s → %s', (status, msg, code, reason) => {
    expect(classifyHttp(status, msg)).toEqual(reason ? { code, reason } : { code });
  });
});

describe('httpError / responseError / payload errors', () => {
  it('uses the JSON message, status and a bounded detail', () => {
    const e = httpError(400, JSON.stringify({ error: { message: 'bad', code: 400 } }) + 'x'.repeat(5000), '/completion');
    expect(e.code).toBe('ENDPOINT_INVALID');
    expect(e.message).toContain('HTTP 400 from /completion');
    expect(e.detail?.length).toBe(2000);
  });
  it('falls back to the raw body, then to the status', () => {
    expect(httpError(500, '<html>oops</html>', '/x').message).toBe('HTTP 500 from /x: <html>oops</html>');
    expect(httpError(502, '  ', '/x').message).toBe('HTTP 502 from /x: HTTP 502');
  });
  it('puts reason in params when there is one', () => {
    expect(httpError(503, '{"error":{"message":"Loading model"}}', '/completion').params).toEqual({
      status: 503,
      path: '/completion',
      reason: 'unavailable',
    });
  });
  it('responseError reads the body (and survives an unreadable one)', async () => {
    expect((await responseError(new Response('{"error":"nope"}', { status: 400 }), '/t')).message).toContain('nope');
    const broken = new Response(bodyStream([], { error: new Error('reset') }), { status: 500 });
    expect((await responseError(broken, '/t')).message).toBe('HTTP 500 from /t: HTTP 500');
  });
  it('payloadError uses a numeric code as status', () => {
    expect(payloadError({ message: 'Loading model', code: 503 }, '/p').code).toBe('ENDPOINT_UNREACHABLE');
    expect(payloadError({ message: 'x', code: 'bad' }, '/p').params).toMatchObject({ status: 500 });
    expect(payloadError('plain text', '/p').message).toContain('plain text');
  });
  it('errorFromPayload only fires on objects with an error key', () => {
    expect(errorFromPayload(null, '/p')).toBeUndefined();
    expect(errorFromPayload(3, '/p')).toBeUndefined();
    expect(errorFromPayload({ content: 'x' }, '/p')).toBeUndefined();
    expect(errorFromPayload({ error: { message: 'm', code: 400 } }, '/p')?.code).toBe('ENDPOINT_INVALID');
  });
});

describe('readJson / discard', () => {
  const schema = z.object({ a: z.number() });
  it('parses and validates', async () => {
    expect(await readJson(new Response('{"a":1}'), schema, '/r')).toEqual({ a: 1 });
  });
  it('rejects non-JSON and wrong shapes as ENDPOINT_INVALID', async () => {
    const e1 = (await readJson(new Response('nope'), schema, '/r').catch((e: unknown) => e)) as AppError;
    expect(e1.code).toBe('ENDPOINT_INVALID');
    expect(e1.message).toContain('not JSON');
    const e2 = (await readJson(new Response('{"a":"x"}'), schema, '/r').catch((e: unknown) => e)) as AppError;
    expect(e2.message).toContain('Unexpected response');
    const e3 = (await readJson(new Response(bodyStream([], { error: new Error('x') })), schema, '/r').catch(
      (e: unknown) => e,
    )) as AppError;
    expect(e3.code).toBe('ENDPOINT_INVALID');
  });
  it('discard swallows body errors', async () => {
    await expect(discard(new Response('x'))).resolves.toBeUndefined();
    await expect(discard(new Response(bodyStream([], { error: new Error('x') })))).resolves.toBeUndefined();
  });
});
