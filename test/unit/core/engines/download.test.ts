import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { downloadFile } from '../../../../src/core/engines/download';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'gb-dl-'));
const DATA = Buffer.alloc(300_000, 7);
const SHA = createHash('sha256').update(DATA).digest('hex');

let base = '';
let server: http.Server;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/file') {
      res.writeHead(200, { 'content-length': String(DATA.length), 'x-auth': String(req.headers.authorization) });
      res.end(DATA);
    } else if (req.url === '/chunked') {
      res.writeHead(200);
      res.write(DATA.subarray(0, 1000));
      res.end(DATA.subarray(1000));
    } else if (req.url === '/slow') {
      res.writeHead(200, { 'content-length': String(DATA.length) });
      res.write(DATA.subarray(0, 1000));
      // never finishes: the client aborts
    } else if (req.url === '/reset') {
      res.writeHead(200, { 'content-length': String(DATA.length) });
      res.write(DATA.subarray(0, 1000), () => res.destroy());
    } else {
      res.writeHead(404);
      res.end('nope');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

describe('downloadFile', () => {
  it('streams to disk, reports progress and verifies sha256', async () => {
    const dest = path.join(tmp(), 'sub', 'f.bin');
    const progress: [number, number | undefined][] = [];
    const res = await downloadFile({
      fetch,
      url: `${base}/file`,
      dest,
      sha256: SHA.toUpperCase(),
      headers: { authorization: 'Bearer t' },
      onProgress: (d, t) => progress.push([d, t]),
    });
    expect(res).toEqual({ bytes: DATA.length, sha256: SHA });
    expect(readFileSync(dest).equals(DATA)).toBe(true);
    expect(progress.at(-1)).toEqual([DATA.length, DATA.length]);
  });

  it('works without content-length or progress callback', async () => {
    const dest = path.join(tmp(), 'c.bin');
    const progress: (number | undefined)[] = [];
    await downloadFile({ fetch, url: `${base}/chunked`, dest, onProgress: (_d, t) => progress.push(t) });
    expect(progress.every((t) => t === undefined)).toBe(true);
    expect((await downloadFile({ fetch, url: `${base}/chunked`, dest })).sha256).toBe(SHA);
  });

  it('checksum mismatch deletes the file', async () => {
    const dest = path.join(tmp(), 'f.bin');
    await expect(downloadFile({ fetch, url: `${base}/file`, dest, sha256: '0'.repeat(64) })).rejects.toMatchObject({
      code: 'DOWNLOAD_CHECKSUM',
      params: { actual: SHA },
    });
    expect(existsSync(dest)).toBe(false);
  });

  it('HTTP errors, missing body, network errors', async () => {
    const dir = tmp();
    await expect(downloadFile({ fetch, url: `${base}/missing`, dest: path.join(dir, 'a') })).rejects.toMatchObject({
      code: 'DOWNLOAD_FAILED',
      params: { status: 404 },
    });
    const noBody = (async () => new Response(null, { status: 200 })) as typeof fetch;
    await expect(downloadFile({ fetch: noBody, url: 'http://x/', dest: path.join(dir, 'b') })).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' });
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(downloadFile({ fetch: down, url: 'http://x/', dest: path.join(dir, 'c') })).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' });
    await expect(downloadFile({ fetch, url: `${base}/reset`, dest: path.join(dir, 'd') })).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' });
    expect(existsSync(path.join(dir, 'd'))).toBe(false);
  });

  it('abort before or during the transfer → CANCELLED, partial file removed', async () => {
    const dir = tmp();
    await expect(downloadFile({ fetch, url: `${base}/file`, dest: path.join(dir, 'a'), signal: AbortSignal.abort() })).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    const ac = new AbortController();
    const p = downloadFile({ fetch, url: `${base}/slow`, dest: path.join(dir, 'b'), signal: ac.signal, onProgress: () => ac.abort() });
    await expect(p).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(existsSync(path.join(dir, 'b'))).toBe(false);
  });

  it('disk full is reported as DISK_FULL', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        c.error(Object.assign(new Error('no space'), { code: 'ENOSPC' }));
      },
    });
    const full = (async () => new Response(body, { status: 200 })) as typeof fetch;
    await expect(downloadFile({ fetch: full, url: 'http://x/', dest: path.join(tmp(), 'f') })).rejects.toMatchObject({ code: 'DISK_FULL' });
  });
});
