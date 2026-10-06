import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HashCache, HashQueue, sha256File, weakKey } from '../../../../src/core/models/hash';
import { seededBytes } from '../../../fixtures/gguf/writer';
import { tempDir } from './helpers';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

describe('weakKey', () => {
  it('is repo/file basename/quant/size with documented fallbacks', () => {
    expect(weakKey({ repo: 'Qwen/Qwen3-4B-GGUF', file: 'Qwen3-4B-Q4_K_M.gguf', quant: 'Q4_K_M', sizeBytes: 2497280256 })).toBe('Qwen/Qwen3-4B-GGUF/Qwen3-4B-Q4_K_M.gguf/Q4_K_M/2497280256');
    expect(weakKey({ repo: 'u/r', file: 'Q4_K_M/x-00001-of-00002.gguf', quant: 'Q4_K_M', sizeBytes: 5 })).toBe('u/r/x-00001-of-00002.gguf/Q4_K_M/5');
    expect(weakKey({ file: 'C:\\models\\a.gguf' })).toBe('local/a.gguf//0');
    expect(weakKey({})).toBe('local///0');
  });
});

describe('sha256File (worker thread)', () => {
  let t: ReturnType<typeof tempDir>;
  beforeEach(() => {
    t = tempDir('gb-hash-');
  });
  afterEach(() => t.cleanup());

  it('hashes a file and reports progress', async () => {
    const data = seededBytes(7, 9 * 1024 * 1024);
    const file = path.join(t.dir, 'big.bin');
    writeFileSync(file, data);
    const progress: number[] = [];
    const h = await sha256File(file, { onProgress: (b) => progress.push(b), progressEveryMs: 0 });
    expect(h).toBe(sha(data));
    expect(progress.at(-1)).toBe(data.length);
    expect(await sha256File(file)).toBe(sha(data));
  });

  it('maps a missing file to MODEL_NOT_FOUND and other read errors to INTERNAL', async () => {
    await expect(sha256File(path.join(t.dir, 'nope.bin'))).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' });
    await expect(sha256File(t.dir)).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('rejects when the worker itself crashes', async () => {
    await expect(sha256File({} as unknown as string)).rejects.toThrow();
  });

  it('aborts before start and while running', async () => {
    const file = path.join(t.dir, 'f.bin');
    writeFileSync(file, seededBytes(1, 1024));
    const pre = new AbortController();
    pre.abort();
    await expect(sha256File(file, { signal: pre.signal })).rejects.toMatchObject({ name: 'AbortError' });
    const big = path.join(t.dir, 'g.bin');
    writeFileSync(big, seededBytes(2, 32 * 1024 * 1024));
    const ac = new AbortController();
    const p = sha256File(big, { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('HashCache', () => {
  let t: ReturnType<typeof tempDir>;
  beforeEach(() => {
    t = tempDir('gb-hashcache-');
  });
  afterEach(() => t.cleanup());

  it('stores by path + size + mtime and persists to JSON', async () => {
    const file = path.join(t.dir, 'cache', 'hashes.json');
    const c = new HashCache(file, 'linux');
    const h = 'a'.repeat(64);
    expect(await c.get('/m/a.gguf', 10, 1000.7)).toBeUndefined();
    await c.set('/m/a.gguf', 10, 1000.7, h);
    expect(await c.get('/m/a.gguf', 10, 1000.2)).toBe(h);
    expect(await c.get('/m/a.gguf', 11, 1000)).toBeUndefined();
    const again = new HashCache(file, 'linux');
    expect(await again.get('/m/a.gguf', 10, 1000)).toBe(h);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ [`${path.resolve('/m/a.gguf')}|10|1000`]: h });
  });

  it('ignores corrupt or foreign cache content', async () => {
    const file = path.join(t.dir, 'hashes.json');
    writeFileSync(file, JSON.stringify({ k: 'not-a-hash', j: 'b'.repeat(64) }));
    const c = new HashCache(file, 'win32');
    expect(await c.get('x', 1, 1)).toBeUndefined();
    writeFileSync(file, '[1,2]');
    expect(await new HashCache(file, 'linux').get('x', 1, 1)).toBeUndefined();
    writeFileSync(file, 'null');
    expect(await new HashCache(file, 'linux').get('x', 1, 1)).toBeUndefined();
  });

  it('survives an unwritable cache location', async () => {
    const blocker = path.join(t.dir, 'blocker');
    writeFileSync(blocker, 'file, not a dir');
    const c = new HashCache(path.join(blocker, 'hashes.json'), 'linux');
    await c.set('/a', 1, 1, 'c'.repeat(64));
    expect(await c.get('/a', 1, 1)).toBe('c'.repeat(64));
  });
});

describe('HashQueue', () => {
  let t: ReturnType<typeof tempDir>;
  beforeEach(() => {
    t = tempDir('gb-hashq-');
  });
  afterEach(() => t.cleanup());

  function setup(hasher?: typeof sha256File) {
    const cache = new HashCache(path.join(t.dir, 'hashes.json'), 'linux');
    const progress: number[] = [];
    const q = new HashQueue({ cache, ...(hasher ? { hasher } : {}), onProgress: (p) => progress.push(p.bytesDone) });
    return { q, cache, progress };
  }

  it('hashes one file at a time, dedupes and uses the cache', async () => {
    const a = path.join(t.dir, 'a.bin');
    const b = path.join(t.dir, 'b.bin');
    writeFileSync(a, seededBytes(1, 1000));
    writeFileSync(b, seededBytes(2, 2000));
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const hasher: typeof sha256File = async (file, opts) => {
      calls++;
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      opts?.onProgress?.(5);
      active--;
      return sha(readFileSync(file));
    };
    const { q, progress } = setup(hasher);
    const p1 = q.enqueue(a);
    expect(q.enqueue(a)).toBe(p1);
    const p2 = q.enqueue(b);
    expect(q.pending).toBe(2);
    expect(await p1).toBe(sha(readFileSync(a)));
    expect(await p2).toBe(sha(readFileSync(b)));
    expect(maxActive).toBe(1);
    expect(progress).toEqual([5, 5]);
    // Cached now: no new hashing.
    expect(await q.enqueue(a)).toBe(sha(readFileSync(a)));
    expect(calls).toBe(2);
    // Changed file → hashed again.
    utimesSync(a, new Date(), new Date(Date.now() + 5000));
    await q.enqueue(a);
    expect(calls).toBe(3);
  });

  it('pauses (aborting the current file) and resumes from it', async () => {
    const a = path.join(t.dir, 'a.bin');
    writeFileSync(a, seededBytes(3, 100));
    let calls = 0;
    const hasher: typeof sha256File = (file, opts) =>
      new Promise((resolve, reject) => {
        calls++;
        const timer = setTimeout(() => resolve(sha(readFileSync(file))), 30);
        opts?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    const { q } = setup(hasher);
    const p = q.enqueue(a);
    await new Promise((r) => setTimeout(r, 5));
    q.pause();
    expect(q.isPaused).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(q.pending).toBe(1);
    q.resume();
    expect(await p).toBe(sha(readFileSync(a)));
    expect(calls).toBe(2);
    expect(q.pending).toBe(0);
  });

  it('rejects missing files and hashing errors without stopping the queue', async () => {
    const ok = path.join(t.dir, 'ok.bin');
    writeFileSync(ok, 'x');
    const hasher: typeof sha256File = async (file) => {
      if (file.endsWith('ok.bin')) return sha(readFileSync(file));
      throw new Error('disk on fire');
    };
    const { q } = setup(hasher);
    const bad = path.join(t.dir, 'bad.bin');
    writeFileSync(bad, 'y');
    const missing = q.enqueue(path.join(t.dir, 'missing.bin'));
    const failing = q.enqueue(bad);
    const good = q.enqueue(ok);
    await expect(missing).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' });
    await expect(failing).rejects.toThrow('disk on fire');
    expect(await good).toBe(sha(Buffer.from('x')));
  });

  it('uses the real worker by default', async () => {
    mkdirSync(path.join(t.dir, 'd'));
    const f = path.join(t.dir, 'd', 'x.bin');
    writeFileSync(f, 'hello');
    const { q } = setup();
    expect(await q.enqueue(f)).toBe(sha(Buffer.from('hello')));
  });
});
