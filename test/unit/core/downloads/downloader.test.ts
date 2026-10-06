import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { AppError } from '../../../../src/contract/errors';
import { abortError, downloadFile, isRetryable, type DownloadFileOptions } from '../../../../src/core/downloads/downloader';
import { startFakeHub, type FakeHub } from '../../../fakes/fake-hub';

const REPO = 'ggml-org/Qwen3-0.6B-GGUF';
const FILE = 'Qwen3-0.6B-Q4_K_M.gguf';

describe('downloadFile', () => {
  let hub: FakeHub;
  let dir: string;
  let sleeps: number[];
  let token: string | undefined;

  beforeAll(async () => {
    hub = await startFakeHub();
  });
  afterAll(() => hub.close());
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'gb-dl-'));
    sleeps = [];
    token = undefined;
    hub.requests.length = 0;
    Object.assign(hub.behavior, { throttleBytesPerSec: 0, dropAfterBytes: 0, dropTimes: 0, tokenTtlMs: 3_600_000, ignoreRange: false, rateLimitNext: 0, failNext: undefined, corrupt: [] });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function opts(over: Partial<DownloadFileOptions> = {}, repo = REPO, file = FILE): DownloadFileOptions {
    const f = hub.file(repo, file);
    return {
      fetch: globalThis.fetch,
      url: `${hub.url}/${repo}/resolve/main/${file}`,
      dest: path.join(dir, ...file.split('/')),
      expectedSize: f.size,
      expectedSha256: f.sha256,
      authHeaders: (u): Record<string, string> => (token && u.startsWith(hub.url) ? { authorization: `Bearer ${token}` } : {}),
      signal: new AbortController().signal,
      onProgress: () => {},
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      maxRetries: 3,
      backoffMs: 10,
      repo,
      ...over,
    };
  }

  it('downloads through the signed CDN redirect, verifies and renames', async () => {
    token = 'hf_test_token';
    const progress: number[] = [];
    const commits: string[] = [];
    const r = await downloadFile(opts({ onProgress: (b) => progress.push(b), onCommit: (c) => commits.push(c) }));
    const f = hub.file(REPO, FILE);
    expect(r).toEqual({ sha256: f.sha256, bytes: f.size });
    expect(readFileSync(path.join(dir, FILE))).toEqual(f.bytes);
    expect(existsSync(path.join(dir, `${FILE}.part`))).toBe(false);
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(f.size);
    expect(commits).toEqual([hub.repo(REPO).sha]);
    const hubReq = hub.requests.find((q) => q.origin === 'hub');
    const cdnReq = hub.requests.find((q) => q.origin === 'cdn');
    expect(hubReq?.headers.authorization).toBe('Bearer hf_test_token');
    expect(cdnReq?.headers.authorization).toBeUndefined();
  });

  it('downloads small files the hub serves directly, without size or sha', async () => {
    const r = await downloadFile(opts({ expectedSize: undefined, expectedSha256: undefined }, REPO, 'params'));
    expect(readFileSync(path.join(dir, 'params'), 'utf8')).toBe('{"temperature": 0.6}');
    expect(r.bytes).toBe(20);
  });

  it('resumes from an existing .part (re-hashing it first) with a Range request', async () => {
    const f = hub.file(REPO, FILE);
    writeFileSync(path.join(dir, `${FILE}.part`), f.bytes.subarray(0, 40_000));
    const phases: string[] = [];
    const progress: number[] = [];
    const r = await downloadFile(opts({ onPhase: (p) => phases.push(p), onProgress: (b) => progress.push(b) }));
    expect(r.sha256).toBe(f.sha256);
    expect(phases).toEqual(['verifying', 'downloading']);
    expect(progress[0]).toBe(40_000);
    expect(hub.requests.find((q) => q.origin === 'cdn')?.headers.range).toBe('bytes=40000-');
  });

  it('finishes a complete .part without any request', async () => {
    const f = hub.file(REPO, FILE);
    writeFileSync(path.join(dir, `${FILE}.part`), f.bytes);
    await downloadFile(opts());
    expect(hub.requests).toHaveLength(0);
    expect(readFileSync(path.join(dir, FILE))).toEqual(f.bytes);
  });

  it('drops a .part larger than expected, and restarts when the server ignores Range', async () => {
    const f = hub.file(REPO, FILE);
    writeFileSync(path.join(dir, `${FILE}.part`), Buffer.alloc(f.size + 10));
    expect((await downloadFile(opts())).sha256).toBe(f.sha256);
    writeFileSync(path.join(dir, `${FILE}.part`), f.bytes.subarray(0, 1000));
    hub.behavior.ignoreRange = true;
    expect((await downloadFile(opts())).sha256).toBe(f.sha256);
  });

  it('restarts when a 206 starts at another offset', async () => {
    const f = hub.file(REPO, FILE);
    writeFileSync(path.join(dir, `${FILE}.part`), f.bytes.subarray(0, 5000));
    let first = true;
    const wrapped = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const res = await globalThis.fetch(input, init);
      if (first && String(input).startsWith(hub.cdnUrl)) {
        first = false;
        return new Response('xx', { status: 206, headers: { 'content-range': `bytes 7-8/${f.size}` } });
      }
      return res;
    }) as typeof fetch;
    expect((await downloadFile(opts({ fetch: wrapped }))).sha256).toBe(f.sha256);
  });

  it('retries dropped connections with exponential backoff and resumes', async () => {
    hub.behavior.dropAfterBytes = 30_000;
    hub.behavior.dropTimes = 2;
    const r = await downloadFile(opts());
    expect(r.sha256).toBe(hub.file(REPO, FILE).sha256);
    expect(sleeps).toEqual([10, 10]);
    const ranges = hub.requests.filter((q) => q.origin === 'cdn').map((q) => q.headers.range);
    expect(ranges[0]).toBeUndefined();
    expect(ranges[1]).toMatch(/^bytes=\d+-$/);
  });

  it('keeps going while drops still make progress, gives up when they do not', async () => {
    hub.behavior.dropAfterBytes = 20_000;
    hub.behavior.dropTimes = 99;
    // Every attempt adds 20 kB, so the retry budget is never exhausted.
    expect((await downloadFile(opts({ maxRetries: 1 }))).sha256).toBe(hub.file(REPO, FILE).sha256);
    hub.behavior.dropTimes = 0;
    rmSync(path.join(dir, FILE));
    sleeps.length = 0;
    hub.behavior.failNext = { status: 503, times: 99, match: 'cdn' };
    await expect(downloadFile(opts({ maxRetries: 2 }))).rejects.toMatchObject({ code: 'NETWORK', params: { status: 503 } });
    expect(sleeps).toEqual([10, 20]);
    hub.behavior.failNext = undefined;
  });

  it('re-resolves an expired signed URL', async () => {
    let expired = false;
    const wrapped = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (!expired && String(input).startsWith(hub.cdnUrl)) {
        expired = true;
        return new Response('Request has expired', { status: 403 });
      }
      return globalThis.fetch(input, init);
    }) as typeof fetch;
    await downloadFile(opts({ fetch: wrapped }));
    expect(hub.requests.filter((q) => q.url.includes('/resolve/'))).toHaveLength(2);
    expect(sleeps).toEqual([]);
  });

  it('fails when signed URLs keep expiring (410/403)', async () => {
    hub.behavior.tokenTtlMs = -1;
    await expect(downloadFile(opts())).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' });
    const gone = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      String(input).startsWith(hub.cdnUrl) ? new Response('gone', { status: 410 }) : globalThis.fetch(input, init)) as typeof fetch;
    hub.behavior.tokenTtlMs = 3_600_000;
    await expect(downloadFile(opts({ fetch: gone }))).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' });
  });

  it('deletes the .part on checksum or size mismatch', async () => {
    hub.behavior.corrupt = [`${REPO}/${FILE}`];
    await expect(downloadFile(opts())).rejects.toMatchObject({ code: 'DOWNLOAD_CHECKSUM', params: { file: FILE } });
    expect(existsSync(path.join(dir, `${FILE}.part`))).toBe(false);
    hub.behavior.corrupt = [];
    const f = hub.file(REPO, FILE);
    await expect(downloadFile(opts({ expectedSize: f.size - 1, expectedSha256: undefined }))).rejects.toMatchObject({ code: 'DOWNLOAD_CHECKSUM' });
    // Upper-case expected hashes are fine.
    expect((await downloadFile(opts({ expectedSha256: f.sha256.toUpperCase() }))).sha256).toBe(f.sha256);
  });

  it('fails when the remote file is shorter than expected (416 on resume)', async () => {
    const f = hub.file(REPO, FILE);
    await expect(downloadFile(opts({ expectedSize: f.size + 10, maxRetries: 2 }))).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' });
    expect(existsSync(path.join(dir, `${FILE}.part`))).toBe(false);
    // Unknown size: a 416 restarts the download, a server that always answers 416 is given up.
    writeFileSync(path.join(dir, `${FILE}.part`), f.bytes);
    expect((await downloadFile(opts({ expectedSize: undefined }))).sha256).toBe(f.sha256);
    const always416 = (async () => new Response(null, { status: 416 })) as unknown as typeof fetch;
    await expect(downloadFile(opts({ fetch: always416, expectedSize: undefined, maxRetries: 1 }))).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' });
  });

  it('retries bodies that end early without an error, then gives up', async () => {
    const f = hub.file(REPO, FILE);
    const short = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).startsWith(hub.cdnUrl)) {
        const range = new Headers(init?.headers).get('range');
        const start = range ? Number(/bytes=(\d+)-/.exec(range)?.[1]) : 0;
        return new Response(new Uint8Array(f.bytes.subarray(start, start + 1000)), { status: start ? 206 : 200, headers: start ? { 'content-range': `bytes ${start}-${start + 999}/${f.size}` } : {} });
      }
      return globalThis.fetch(input, init);
    }) as typeof fetch;
    // Each short body still makes progress: the download completes in 1 kB steps.
    expect((await downloadFile(opts({ fetch: short, maxRetries: 3 }))).sha256).toBe(f.sha256);
    expect(sleeps.length).toBeGreaterThan(10);
    rmSync(path.join(dir, FILE));
    sleeps.length = 0;
    const empty = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      String(input).startsWith(hub.cdnUrl) ? new Response(new Uint8Array(0), { status: 200 }) : globalThis.fetch(input, init)) as typeof fetch;
    await expect(downloadFile(opts({ fetch: empty, maxRetries: 2 }))).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED', message: expect.stringContaining('closing early') });
    expect(sleeps).toEqual([10, 20]);
  });

  it('maps gated, missing and rate-limited files', async () => {
    const gated = hub.file('google/gated-demo-it', 'gated-demo-it-Q4_K_M.gguf');
    await expect(downloadFile(opts({ expectedSize: gated.size }, 'google/gated-demo-it', 'gated-demo-it-Q4_K_M.gguf'))).rejects.toMatchObject({ code: 'HF_GATED', params: { repo: 'google/gated-demo-it' } });
    await expect(downloadFile({ ...opts(), url: `${hub.url}/${REPO}/resolve/main/nope.gguf` })).rejects.toMatchObject({ code: 'HF_NOT_FOUND' });
    expect(sleeps).toEqual([]);
    hub.behavior.rateLimitNext = 1;
    await downloadFile(opts());
    expect(sleeps).toEqual([10]);
  });

  it('retries hub and CDN server errors', async () => {
    hub.behavior.failNext = { status: 500, times: 2, match: '/resolve/' };
    await downloadFile(opts());
    expect(sleeps).toEqual([10, 20]);
    sleeps.length = 0;
    rmSync(path.join(dir, FILE));
    hub.behavior.failNext = { status: 502, times: 1, match: 'cdn' };
    await downloadFile(opts());
    expect(sleeps).toEqual([10]);
    hub.behavior.failNext = { status: 400, times: 1, match: 'cdn' };
    await expect(downloadFile(opts())).rejects.toMatchObject({ code: 'NETWORK', params: { status: 400 } });
  });

  it('follows same-origin redirects and rejects broken ones', async () => {
    const renamed = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).includes('/old-name/')) return new Response(null, { status: 307, headers: { location: `/${REPO}/resolve/main/${FILE}` } });
      return globalThis.fetch(input, init);
    }) as typeof fetch;
    await downloadFile({ ...opts({ fetch: renamed }), url: `${hub.url}/ggml-org/old-name/resolve/main/${FILE}` });
    expect(existsSync(path.join(dir, FILE))).toBe(true);

    const noLocation = (async () => new Response(null, { status: 302 })) as unknown as typeof fetch;
    await expect(downloadFile(opts({ fetch: noLocation }))).rejects.toMatchObject({ code: 'NETWORK', params: { status: 302 } });
    const loop = (async () => new Response(null, { status: 302, headers: { location: '/again' } })) as unknown as typeof fetch;
    await expect(downloadFile(opts({ fetch: loop, maxRetries: 0 }))).rejects.toMatchObject({ code: 'NETWORK', message: expect.stringContaining('redirects') });
  });

  it('maps unreachable servers and odd stream failures', async () => {
    const offline = { ...opts(), url: 'http://127.0.0.1:9/x/y/resolve/main/f.gguf' };
    await expect(downloadFile({ ...offline, maxRetries: 1 })).rejects.toMatchObject({ code: 'NETWORK' });
    expect(sleeps).toEqual([10]);
    const failingBody = (err: unknown) =>
      (async () =>
        new Response(
          new ReadableStream({
            pull(c) {
              c.error(err);
            },
          }),
          { status: 200 },
        )) as unknown as typeof fetch;
    await expect(downloadFile(opts({ fetch: failingBody(Object.assign(new Error('no space'), { code: 'ENOSPC' })) }))).rejects.toMatchObject({ code: 'DISK_FULL' });
    await expect(downloadFile(opts({ fetch: failingBody(Object.assign(new Error('denied'), { code: 'EACCES' })) }))).rejects.toMatchObject({ code: 'NETWORK', message: expect.stringContaining('interrupted') });
    await expect(downloadFile(opts({ fetch: failingBody(new AppError('HF_GATED', 'x')) }))).rejects.toMatchObject({ code: 'HF_GATED' });
    const thrower = (() => {
      throw new AppError('INTERNAL', 'boom');
    }) as unknown as typeof fetch;
    await expect(downloadFile(opts({ fetch: thrower, maxRetries: 0 }))).rejects.toMatchObject({ code: 'INTERNAL' });
    const weird = (() => Promise.reject('just a string')) as unknown as typeof fetch;
    await expect(downloadFile(opts({ fetch: weird }))).rejects.toMatchObject({ code: 'NETWORK', message: expect.stringContaining('just a string') });
  });

  it('aborts before, during and while backing off', async () => {
    const pre = new AbortController();
    pre.abort();
    await expect(downloadFile(opts({ signal: pre.signal }))).rejects.toMatchObject({ name: 'AbortError' });

    hub.behavior.throttleBytesPerSec = 64 * 1024;
    const ac = new AbortController();
    const p = downloadFile(opts({ signal: ac.signal, onProgress: (b) => b > 20_000 && ac.abort() }));
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(existsSync(path.join(dir, `${FILE}.part`))).toBe(true);
    hub.behavior.throttleBytesPerSec = 0;

    const reason = new Error('paused by user');
    const during = new AbortController();
    hub.behavior.failNext = { status: 500, times: 1, match: '/resolve/' };
    const q = downloadFile(
      opts({
        signal: during.signal,
        sleep: async (_ms, signal) => {
          during.abort(reason);
          signal?.throwIfAborted();
        },
      }),
    );
    await expect(q).rejects.toBe(reason);
    hub.behavior.failNext = undefined;
  });

  it('retries a rename blocked by an antivirus lock, then gives up; other errors fail at once', async () => {
    const f = hub.file(REPO, FILE);
    let calls = 0;
    const { rename } = await import('node:fs/promises');
    const flaky = async (a: string, b: string) => {
      if (++calls < 3) throw Object.assign(new Error('locked'), { code: calls === 1 ? 'EPERM' : 'EBUSY' });
      await rename(a, b);
    };
    await downloadFile(opts({ renameFile: flaky }));
    expect(calls).toBe(3);
    expect(sleeps).toEqual([100, 200]);
    expect(readFileSync(path.join(dir, FILE))).toEqual(f.bytes);
    const locked = async () => {
      throw Object.assign(new Error('locked'), { code: 'EACCES' });
    };
    await expect(downloadFile(opts({ renameFile: locked }))).rejects.toMatchObject({ code: 'EACCES' });
    const broken = async () => {
      throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
    };
    sleeps.length = 0;
    await expect(downloadFile(opts({ renameFile: broken }))).rejects.toMatchObject({ code: 'EXDEV' });
    expect(sleeps).toEqual([]);
  });

  it('uses default retry settings', async () => {
    const { maxRetries: _m, backoffMs: _b, ...rest } = opts();
    expect((await downloadFile(rest)).bytes).toBe(hub.file(REPO, FILE).size);
  });

  it('re-hashing an existing .part honours the abort signal', async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${FILE}.part`), Buffer.alloc(1000));
    const ac = new AbortController();
    ac.abort();
    await expect(downloadFile(opts({ signal: ac.signal }))).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('isRetryable / abortError', () => {
  it('retries transient failures only', () => {
    expect(isRetryable(new AppError('HF_RATE_LIMITED', 'x'))).toBe(true);
    expect(isRetryable(new AppError('NETWORK', 'x', { params: { status: 503 } }))).toBe(true);
    expect(isRetryable(new AppError('NETWORK', 'x', { params: { status: 404 } }))).toBe(false);
    expect(isRetryable(new AppError('NETWORK', 'x'))).toBe(true);
    expect(isRetryable(new AppError('HF_GATED', 'x'))).toBe(false);
    expect(isRetryable(new TypeError('fetch failed'))).toBe(true);
    expect(isRetryable(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isRetryable(Object.assign(new Error('x'), { cause: { code: 'UND_ERR_SOCKET' } }))).toBe(true);
    expect(isRetryable(new Error('x'))).toBe(false);
  });

  it('uses the abort reason when it is an Error', () => {
    const ac = new AbortController();
    const reason = new Error('why');
    ac.abort(reason);
    expect(abortError(ac.signal)).toBe(reason);
    const plain = new AbortController();
    plain.abort('text');
    expect(abortError(plain.signal).name).toBe('AbortError');
  });
});
