import { stat } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { AppError } from '../../contract/errors';
import type { ModelIdentity } from '../../contract/models';
import type { Platform } from '../deps';
import { readJsonFile, writeFileAtomic } from '../store/atomic';
import { fileKey } from './paths';

/**
 * Weak model key, usable before the sha256 is known (and for hub files never downloaded):
 *
 *   `${repo ?? 'local'}/${basename(file) ?? ''}/${quant ?? ''}/${sizeBytes ?? 0}`
 *
 * - repo: HF repo id ("Qwen/Qwen3-4B-GGUF"); "local" when unknown;
 * - file: basename of the main file (first shard for split GGUF, first weights file for
 *   safetensors), without folders, so "Q4_K_M/x-00001-of-00002.gguf" and a local copy agree;
 * - quant: label parsed from the file name (quantFromFilename), "" when unknown;
 * - sizeBytes: bytes of all weight files of the model (every shard), 0 when unknown.
 */
export function weakKey(id: Pick<ModelIdentity, 'repo' | 'file' | 'quant' | 'sizeBytes'>): string {
  const file = (id.file ?? '').split(/[\\/]/).pop();
  return `${id.repo ?? 'local'}/${file}/${id.quant ?? ''}/${id.sizeBytes ?? 0}`;
}

export interface HashOptions {
  onProgress?: (bytesDone: number) => void;
  signal?: AbortSignal;
  progressEveryMs?: number;
}

/*
 * Worker source kept as a string and started with `eval: true`, so the bundled core (single
 * file) does not need a separate worker entry point. Hashing a 20 GB file takes ~10 s of CPU,
 * which must not block the HTTP server's event loop.
 */
const WORKER_CODE = `
const { parentPort, workerData } = require('node:worker_threads');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const hash = createHash('sha256');
let done = 0;
let last = 0;
const stream = fs.createReadStream(workerData.file, { highWaterMark: 4 * 1024 * 1024 });
stream.on('data', (buf) => {
  hash.update(buf);
  done += buf.length;
  const now = Date.now();
  if (now - last >= workerData.everyMs) {
    last = now;
    parentPort.postMessage({ type: 'progress', done });
  }
});
stream.on('error', (e) => parentPort.postMessage({ type: 'error', message: String(e.message), code: String(e.code) }));
stream.on('end', () => parentPort.postMessage({ type: 'done', hash: hash.digest('hex'), done }));
`;

type WorkerMsg = { type: 'progress'; done: number } | { type: 'done'; hash: string } | { type: 'error'; message: string; code: string };

function abortError(): Error {
  return new DOMException('Hashing aborted', 'AbortError');
}

/** sha256 of a file computed in a worker thread. Rejects with AbortError when `signal` fires. */
export function sha256File(file: string, opts: HashOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(abortError());
      return;
    }
    const worker = new Worker(WORKER_CODE, { eval: true, workerData: { file, everyMs: opts.progressEveryMs ?? 250 } });
    // Settling twice is harmless (a promise ignores the second call); terminate() is idempotent.
    const finish = (fn: () => void) => {
      opts.signal?.removeEventListener('abort', onAbort);
      void worker.terminate();
      fn();
    };
    const onAbort = () => finish(() => reject(abortError()));
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    worker.on('message', (m: WorkerMsg) => {
      if (m.type === 'progress') opts.onProgress?.(m.done);
      else if (m.type === 'done') finish(() => resolve(m.hash));
      else {
        const code = m.code === 'ENOENT' ? 'MODEL_NOT_FOUND' : 'INTERNAL';
        finish(() => reject(new AppError(code, `Cannot hash ${file}: ${m.message}`)));
      }
    });
    worker.on('error', (e) => finish(() => reject(e)));
  });
}

/** sha256 per file, valid while path + size + mtime are unchanged. Stored as JSON in the cache dir. */
export class HashCache {
  private data: Record<string, string> | undefined;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    readonly file: string,
    private readonly platform: Platform,
  ) {}

  private async load(): Promise<Record<string, string>> {
    if (this.data) return this.data;
    let raw: unknown;
    try {
      raw = await readJsonFile(this.file);
    } catch {
      raw = {};
    }
    const entries = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? Object.entries(raw as Record<string, unknown>) : [];
    const data: Record<string, string> = {};
    for (const [k, v] of entries) if (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)) data[k] = v;
    this.data = data;
    return data;
  }

  async get(p: string, size: number, mtimeMs: number): Promise<string | undefined> {
    return (await this.load())[fileKey(p, size, mtimeMs, this.platform)];
  }

  async set(p: string, size: number, mtimeMs: number, sha256: string): Promise<void> {
    const data = await this.load();
    data[fileKey(p, size, mtimeMs, this.platform)] = sha256;
    const json = JSON.stringify(data);
    this.writing = this.writing.then(() => writeFileAtomic(this.file, json)).catch(() => undefined);
    await this.writing;
  }
}

export interface HashQueueOptions {
  cache: HashCache;
  hasher?: typeof sha256File;
  onProgress?: (p: { file: string; bytesDone: number; bytesTotal: number }) => void;
}

interface QueueEntry {
  file: string;
  promise: Promise<string>;
  resolve: (h: string) => void;
  reject: (e: unknown) => void;
}

/**
 * Background hashing, one file at a time so a benchmark never competes with several readers.
 * pause() (call it while a benchmark runs) aborts the current file; it restarts on resume().
 */
export class HashQueue {
  private queue: QueueEntry[] = [];
  private byFile = new Map<string, QueueEntry>();
  private paused = false;
  private running = false;
  private abort: AbortController | undefined;
  private readonly hasher: typeof sha256File;

  constructor(private readonly opts: HashQueueOptions) {
    this.hasher = opts.hasher ?? sha256File;
  }

  get pending(): number {
    return this.queue.length;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** Resolves with the file's sha256 (from cache when unchanged). Same file twice → same promise. */
  enqueue(file: string): Promise<string> {
    const existing = this.byFile.get(file);
    if (existing) return existing.promise;
    let resolve!: (h: string) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<string>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const entry: QueueEntry = { file, promise, resolve, reject };
    this.queue.push(entry);
    this.byFile.set(file, entry);
    void this.pump();
    return promise;
  }

  pause(): void {
    this.paused = true;
    this.abort?.abort();
  }

  resume(): void {
    this.paused = false;
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (!this.paused && this.queue.length > 0) {
        const entry = this.queue[0] as QueueEntry;
        try {
          entry.resolve(await this.hashOne(entry.file));
        } catch (e) {
          // Paused mid-file: keep it at the head of the queue for resume().
          if (this.paused && (e as Error).name === 'AbortError') break;
          entry.reject(e);
        }
        this.queue.shift();
        this.byFile.delete(entry.file);
      }
    } finally {
      this.running = false;
    }
  }

  private async hashOne(file: string): Promise<string> {
    const st = await stat(file).catch((e: unknown) => {
      throw new AppError('MODEL_NOT_FOUND', `Cannot hash ${file}: file not found`, { cause: e });
    });
    const cached = await this.opts.cache.get(file, st.size, st.mtimeMs);
    if (cached) return cached;
    this.abort = new AbortController();
    const hash = await this.hasher(file, {
      signal: this.abort.signal,
      onProgress: (bytesDone) => this.opts.onProgress?.({ file, bytesDone, bytesTotal: st.size }),
    });
    await this.opts.cache.set(file, st.size, st.mtimeMs, hash);
    return hash;
  }
}
