import { createHash, type Hash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { AppError, isAppError } from '../../contract/errors';
import { discardBody, hubHttpError } from '../models/hub';
import { errorMessage } from '../models/gguf';

export interface DownloadFileOptions {
  fetch: typeof fetch;
  /** Hub resolve URL ({hf}/{repo}/resolve/{rev}/{file}); re-resolved when the signed URL expires. */
  url: string;
  /** Final path; data goes to `${dest}.part` until verified. */
  dest: string;
  expectedSize?: number;
  expectedSha256?: string;
  /** Auth headers for a URL (empty for other origins: signed CDN URLs never get the token). */
  authHeaders: (url: string) => Record<string, string>;
  signal: AbortSignal;
  /** Bytes of this file present on disk (called with the resume offset first). */
  onProgress: (bytes: number) => void;
  /** 'verifying' while an existing .part is re-hashed before resuming. */
  onPhase?: (phase: 'verifying' | 'downloading') => void;
  /** Commit sha the hub resolved the revision to (X-Repo-Commit). */
  onCommit?: (sha: string) => void;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  maxRetries?: number;
  backoffMs?: number;
  repo?: string;
  /** fs.rename by default (injectable to test antivirus locks). */
  renameFile?: (from: string, to: string) => Promise<void>;
}

export interface DownloadedFile {
  sha256: string;
  bytes: number;
}

/** Signed CDN URLs (S3 / CloudFront) answer 403 or 410 once expired: resolve again. */
class ExpiredUrl extends Error {}

const RETRYABLE_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_SOCKET']);
const MAX_HOPS = 5;
const MAX_RESOLVES = 3;
const MAX_BACKOFF_MS = 30_000;

export function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('Download aborted', 'AbortError');
}

/** Network drops, 5xx and 429 are worth retrying; auth, gating, 404 and disk errors are not. */
export function isRetryable(e: unknown): boolean {
  if (isAppError(e)) {
    if (e.code === 'HF_RATE_LIMITED') return true;
    return e.code === 'NETWORK' && Number(e.params?.status ?? 500) >= 500;
  }
  const err = e as { name?: string; code?: string; cause?: { code?: string } };
  if (err.name === 'TypeError') return true; // undici: "fetch failed", "terminated"
  return RETRYABLE_CODES.has(err.code ?? '') || RETRYABLE_CODES.has(err.cause?.code ?? '');
}

function backoff(attempt: number, base: number): number {
  return Math.min(MAX_BACKOFF_MS, base * 2 ** attempt);
}

async function hashExisting(file: string, hash: Hash, signal: AbortSignal): Promise<void> {
  for await (const chunk of createReadStream(file, { highWaterMark: 4 * 1024 * 1024, signal })) hash.update(chunk as Buffer);
}

/** Renames with retries: on Windows an antivirus may hold the fresh file for a moment. */
async function renameRetry(from: string, to: string, o: DownloadFileOptions): Promise<void> {
  const doRename = o.renameFile ?? rename;
  for (let attempt = 0; ; attempt++) {
    try {
      await doRename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e;
      await o.sleep(100 * (attempt + 1));
    }
  }
}

/**
 * Downloads one file with resume, retries and sha256 verification.
 *
 * - Data is appended to `<dest>.part`; on start an existing .part is re-hashed and the download
 *   continues with `Range: bytes=<size>-` (206 + Content-Range start must match, otherwise the
 *   .part is dropped and the download restarts cleanly, e.g. when a server ignores Range).
 * - The hub resolve URL is fetched with manual redirects to learn the signed CDN URL; the token is
 *   only ever sent to the hub origin. An expired signed URL (403/410) is resolved again.
 * - Network errors, 5xx and 429 retry with exponential backoff; the counter resets after progress.
 * - The finished file is checked (size, sha256) and atomically renamed to `dest`; a checksum
 *   mismatch deletes the .part and fails with DOWNLOAD_CHECKSUM.
 */
export async function downloadFile(o: DownloadFileOptions): Promise<DownloadedFile> {
  const part = `${o.dest}.part`;
  const maxRetries = o.maxRetries ?? 5;
  const base = o.backoffMs ?? 1000;
  const hubOrigin = new URL(o.url).origin;
  await mkdir(path.dirname(o.dest), { recursive: true });

  let hash = createHash('sha256');
  let have = (await stat(part).catch(() => undefined))?.size ?? 0;
  const restart = async () => {
    await rm(part, { force: true });
    hash = createHash('sha256');
    have = 0;
  };
  if (o.expectedSize !== undefined && have > o.expectedSize) await restart();
  if (have > 0) {
    o.onPhase?.('verifying');
    await hashExisting(part, hash, o.signal);
    o.onPhase?.('downloading');
  }
  o.onProgress(have);

  let signed: string | undefined;
  let attempt = 0;
  let resolves = 0;

  /** Opens the byte stream from `have`: hub resolve (manual redirects), then the signed URL. */
  const openStream = async (): Promise<Response> => {
    const range: Record<string, string> = have > 0 ? { range: `bytes=${have}-` } : {};
    if (!signed) {
      let url = o.url;
      for (let hop = 0; hop < MAX_HOPS && !signed; hop++) {
        const res = await o.fetch(url, { redirect: 'manual', headers: { ...o.authHeaders(url), ...range }, signal: o.signal });
        const commit = res.headers.get('x-repo-commit');
        if (commit) o.onCommit?.(commit);
        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get('location');
          await discardBody(res);
          if (!location) throw new AppError('NETWORK', 'Redirect without Location', { params: { status: res.status } });
          url = new URL(location, url).toString();
          // Same-origin hops (renamed repos) keep resolving; another origin is the signed CDN URL.
          if (new URL(url).origin !== hubOrigin) signed = url;
          continue;
        }
        if (!res.ok && res.status !== 416) {
          await discardBody(res);
          throw hubHttpError(res, o.repo);
        }
        return res; // small files are served by the hub directly
      }
      if (!signed) throw new AppError('NETWORK', 'Too many redirects resolving the download');
    }
    const res = await o.fetch(signed, { headers: range, signal: o.signal });
    if (res.status === 403 || res.status === 410) {
      await discardBody(res);
      signed = undefined;
      throw new ExpiredUrl();
    }
    if (!res.ok && res.status !== 416) {
      await discardBody(res);
      throw hubHttpError(res, o.repo);
    }
    return res;
  };

  for (;;) {
    if (o.expectedSize !== undefined && have === o.expectedSize) break;
    let res: Response;
    try {
      res = await openStream();
    } catch (e) {
      if (o.signal.aborted) throw abortError(o.signal);
      if (e instanceof ExpiredUrl) {
        if (++resolves > MAX_RESOLVES) throw new AppError('DOWNLOAD_FAILED', 'The download link keeps expiring', { params: { file: path.basename(o.dest) } });
        continue;
      }
      if (isRetryable(e) && attempt < maxRetries) {
        await o.sleep(backoff(attempt++, base), o.signal);
        continue;
      }
      throw isAppError(e) ? e : new AppError('NETWORK', `Download failed: ${errorMessage(e)}`, { cause: e });
    }

    if (res.status === 416) {
      // Nothing past our offset. With a known size the remote file is shorter than the listing
      // said (it changed): fail instead of looping. Without one, start over once more.
      await discardBody(res);
      await restart();
      if (o.expectedSize !== undefined || ++attempt > maxRetries) {
        throw new AppError('DOWNLOAD_FAILED', 'The remote file is shorter than expected', { params: { file: path.basename(o.dest) } });
      }
      continue;
    }
    if (have > 0) {
      const start = /^bytes (\d+)-/.exec(res.headers.get('content-range') ?? '')?.[1];
      // 200 = Range ignored (full body follows); a 206 at another offset cannot be appended either.
      if (res.status !== 206 || Number(start) !== have) {
        await restart();
        if (res.status !== 200) {
          await discardBody(res);
          continue;
        }
      }
    }

    const fh = await open(part, have > 0 ? 'a' : 'w');
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        await fh.write(chunk);
        hash.update(chunk);
        have += chunk.length;
        attempt = 0;
        o.onProgress(have);
      }
    } catch (e) {
      if (o.signal.aborted) throw abortError(o.signal);
      if ((e as NodeJS.ErrnoException).code === 'ENOSPC') throw new AppError('DISK_FULL', 'The disk is full', { cause: e });
      if (isRetryable(e) && attempt < maxRetries) {
        await o.sleep(backoff(attempt++, base), o.signal);
        continue;
      }
      throw isAppError(e) ? e : new AppError('NETWORK', `Download interrupted: ${errorMessage(e)}`, { cause: e });
    } finally {
      await fh.close();
    }
    if (o.expectedSize === undefined || have >= o.expectedSize) break;
    // The body ended early without an error: resume from what we have.
    if (attempt >= maxRetries) throw new AppError('DOWNLOAD_FAILED', 'The connection keeps closing early', { params: { file: path.basename(o.dest) } });
    await o.sleep(backoff(attempt++, base), o.signal);
  }

  const sha256 = hash.digest('hex');
  const sizeOk = o.expectedSize === undefined || have === o.expectedSize;
  if (!sizeOk || (o.expectedSha256 && sha256 !== o.expectedSha256.toLowerCase())) {
    await rm(part, { force: true });
    throw new AppError('DOWNLOAD_CHECKSUM', `Checksum mismatch for ${path.basename(o.dest)}`, {
      params: { file: path.basename(o.dest), expected: o.expectedSha256 ?? '', actual: sha256, bytes: have },
    });
  }
  await renameRetry(part, o.dest, o);
  return { sha256, bytes: have };
}
