import { createHash } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { AppError } from '../../contract/errors';

export interface DownloadOptions {
  fetch: typeof globalThis.fetch;
  url: string;
  dest: string;
  signal?: AbortSignal;
  /** Expected sha256 (hex). Verified on the streamed bytes; a mismatch deletes the file. */
  sha256?: string;
  onProgress?: (bytesDone: number, bytesTotal: number | undefined) => void;
  headers?: Record<string, string>;
}

export interface DownloadResult {
  bytes: number;
  sha256: string;
}

/**
 * Streams `url` to `dest`, hashing on the fly (no second read of a 500 MB archive). Engine
 * archives are small enough that resume is not worth it; model downloads have their own
 * resumable downloader.
 */
export async function downloadFile(opts: DownloadOptions): Promise<DownloadResult> {
  const { signal } = opts;
  await fs.mkdir(path.dirname(opts.dest), { recursive: true });
  let res: Response;
  try {
    res = await opts.fetch(opts.url, {
      redirect: 'follow',
      ...(opts.headers ? { headers: opts.headers } : {}),
      ...(signal ? { signal } : {}),
    });
  } catch (e) {
    throw failure(e, signal, opts.url);
  }
  if (!res.ok || !res.body) {
    throw new AppError('DOWNLOAD_FAILED', `HTTP ${res.status} for ${opts.url}`, {
      params: { status: res.status, url: opts.url },
    });
  }
  const lengthHeader = Number(res.headers.get('content-length'));
  const total = Number.isFinite(lengthHeader) && lengthHeader > 0 ? lengthHeader : undefined;
  const hash = createHash('sha256');
  let done = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      done += chunk.length;
      opts.onProgress?.(done, total);
      cb(null, chunk);
    },
  });
  try {
    const body = Readable.fromWeb(res.body as unknown as NodeReadableStream<Uint8Array>);
    await pipeline(body, meter, createWriteStream(opts.dest), ...(signal ? [{ signal }] : []));
  } catch (e) {
    await fs.rm(opts.dest, { force: true });
    throw failure(e, signal, opts.url);
  }
  const sha256 = hash.digest('hex');
  if (opts.sha256 && opts.sha256.toLowerCase() !== sha256) {
    await fs.rm(opts.dest, { force: true });
    throw new AppError('DOWNLOAD_CHECKSUM', `Checksum mismatch for ${path.basename(opts.dest)}`, {
      params: { file: path.basename(opts.dest), expected: opts.sha256.toLowerCase(), actual: sha256 },
    });
  }
  return { bytes: done, sha256 };
}

function failure(e: unknown, signal: AbortSignal | undefined, url: string): AppError {
  if (signal?.aborted) return new AppError('CANCELLED', 'Download cancelled', { cause: e });
  if ((e as NodeJS.ErrnoException).code === 'ENOSPC') return new AppError('DISK_FULL', 'No space left on device', { cause: e });
  return new AppError('DOWNLOAD_FAILED', `Download failed: ${String(e)}`, { params: { url }, cause: e });
}
