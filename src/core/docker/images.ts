import { AppError, isAppError } from '../../contract/errors';
import type { Logger } from '../deps';
import type { DockerApiProvider } from './api-provider';
import { classifyDockerError, type DockerCli } from './cli';
import type { ImageInfo } from './client';
import type { DockerHubClient } from './hub';
import { parseImageRef } from './image-ref';
import { PullAggregator, type PullProgress } from './pull-progress';

export interface ImageServiceOptions {
  api: DockerApiProvider;
  cli: DockerCli;
  hub?: DockerHubClient;
  log?: Logger;
}

/** The Engine API could not be used at all (as opposed to "it answered with an error"). */
function apiUnusable(e: unknown): boolean {
  return isAppError(e) && (e.code === 'DOCKER_NOT_RUNNING' || e.code === 'DOCKER_UNSUPPORTED');
}

/**
 * Images through the Engine API (byte-level pull progress, sizes), falling back to the CLI when
 * the API endpoint cannot be reached although the CLI works (TLS/ssh contexts, odd pipe ACLs).
 */
export class ImageService {
  constructor(private readonly o: ImageServiceOptions) {}

  async inspect(ref: string): Promise<ImageInfo | undefined> {
    parseImageRef(ref);
    try {
      return await (await this.o.api.get()).imageInspect(ref);
    } catch (e) {
      if (!apiUnusable(e)) throw e;
      return this.o.cli.imageInspect(ref);
    }
  }

  /** `expectedBytes` (the image's download size, when known) keeps the progress bar from going back. */
  async pull(ref: string, onProgress: (p: PullProgress) => void, signal?: AbortSignal, expectedBytes?: number): Promise<{ digest?: string }> {
    parseImageRef(ref);
    let api;
    try {
      api = await this.o.api.get();
    } catch (e) {
      if (!apiUnusable(e)) throw e;
      this.o.log?.info('docker API unusable, pulling through the CLI', { error: (e as AppError).code });
      return this.pullCli(ref, onProgress, signal);
    }
    return api.pull(ref, onProgress, signal, expectedBytes);
  }

  /** CLI pull: layer counts only (the non-TTY output has no byte figures). */
  private async pullCli(ref: string, onProgress: (p: PullProgress) => void, signal?: AbortSignal): Promise<{ digest?: string }> {
    const mp = await this.o.cli.spawn(['pull', ref], { runId: 'docker-pull', marker: 'docker-pull' });
    const onAbort = () => void mp.stop();
    signal?.addEventListener('abort', onAbort, { once: true });
    const agg = new PullAggregator();
    const tail: string[] = [];
    try {
      for await (const l of mp.lines) {
        tail.push(l.text);
        if (tail.length > 50) tail.shift();
        const m = /^([0-9a-f]{6,}): (.+)$/.exec(l.text.trim());
        if (m) onProgress(agg.push({ id: m[1] as string, status: (m[2] as string).trim() }));
        else if (/^(Digest|Status): /.test(l.text.trim())) onProgress(agg.push({ status: l.text.trim() }));
      }
      const exit = await mp.exited;
      if (signal?.aborted) throw new AppError('CANCELLED', 'Image pull cancelled');
      if (exit.code !== 0) {
        const err = classifyDockerError({ code: exit.code, stdout: '', stderr: tail.join('\n') }, 'DOCKER_PULL_FAILED');
        (err.params as Record<string, string | number | boolean>).image = ref;
        throw err;
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
    onProgress({ ...agg.snapshot(), status: 'done' });
    return agg.digest !== undefined ? { digest: agg.digest } : {};
  }

  /** Download size before pulling (Docker Hub only; other registries: undefined = unknown). */
  async downloadSize(ref: string, signal?: AbortSignal): Promise<number | undefined> {
    if (!this.o.hub) return undefined;
    return this.o.hub.imageSize(ref, signal).catch((e: unknown) => {
      this.o.log?.warn('docker hub size lookup failed', { ref, error: String(e) });
      return undefined;
    });
  }
}
