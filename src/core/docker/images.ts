import type { LocalImage } from '../../contract/docker';
import { AppError, isAppError } from '../../contract/errors';
import type { Logger } from '../deps';
import type { DockerApiProvider } from './api-provider';
import { classifyDockerError, type DockerCli } from './cli';
import type { ImageInfo } from './client';
import type { DockerHubClient } from './hub';
import { displayRepo, parseImageRef } from './image-ref';
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

  /** The API when it answers, else the CLI (same contract as inspect). */
  private async either<T>(viaApi: (api: Awaited<ReturnType<DockerApiProvider['get']>>) => Promise<T>, viaCli: (cli: DockerCli) => Promise<T>): Promise<T> {
    let api;
    try {
      api = await this.o.api.get();
    } catch (e) {
      if (!apiUnusable(e)) throw e;
      return viaCli(this.o.cli);
    }
    return viaApi(api);
  }

  /** The images of `repo` on this Docker, with their tags and digests there and whether a running container uses them. */
  async local(repo: string): Promise<LocalImage[]> {
    const want = displayRepo(parseImageRef(repo));
    const [images, containers] = await this.either<[ImageInfo[], { image: string; state: string }[]]>(
      (api) => Promise.all([api.listImages(), api.listContainers()]),
      (cli) => Promise.all([cli.listImages(), cli.ps([])]),
    );
    const running = containers.filter((c) => c.state === 'running').map((c) => normalRef(c.image));
    const out: LocalImage[] = [];
    for (const img of images) {
      const tags = img.repoTags.map(splitRef).filter((r) => r?.repo === want && r.tag !== undefined).map((r) => r?.tag as string);
      const digests = img.repoDigests.map(splitRef).filter((r) => r?.repo === want && r.digest !== undefined).map((r) => r?.digest as string);
      if (!tags.length && !digests.length) continue;
      const names = new Set([img.id, ...tags.map((t) => `${want}:${t}`), ...digests.map((d) => `${want}@${d}`)]);
      out.push({ id: img.id, tags, digests, sizeBytes: img.size, running: running.some((r) => names.has(r)) });
    }
    return out;
  }

  /**
   * Removes one image (a tag, or an id), never forced: a running server or test using it is refused
   * first (DOCKER_IMAGE_IN_USE, reason 'running'), a stopped container holding it by Docker itself.
   */
  async remove(ref: string): Promise<void> {
    const r = splitRef(ref);
    if (r) {
      const mine = (await this.local(r.repo)).find((i) => i.id === ref || (r.tag !== undefined && i.tags.includes(r.tag)) || (r.digest !== undefined && i.digests.includes(r.digest)));
      if (mine?.running) throw new AppError('DOCKER_IMAGE_IN_USE', `${ref} is in use`, { params: { image: ref, reason: 'running' } });
    }
    await this.either(
      (api) => api.removeImage(ref),
      (cli) => cli.removeImage(ref),
    );
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

/** "vllm/vllm-openai:v0.31.0", "docker.io/vllm/vllm-openai@sha256:…" → its repository as Docker prints it, tag and digest; undefined for an id. */
function splitRef(ref: string): { repo: string; tag?: string; digest?: string } | undefined {
  if (/^sha256:[0-9a-f]+$/.test(ref)) return undefined;
  try {
    const p = parseImageRef(ref);
    return { repo: displayRepo(p), ...(p.tag !== undefined ? { tag: p.tag } : {}), ...(p.digest !== undefined ? { digest: p.digest } : {}) };
  } catch {
    return undefined;
  }
}

/** A container's image as one of the names `local` compares (an id stays an id; a bare repository is :latest). */
function normalRef(image: string): string {
  const r = splitRef(image);
  if (!r) return image;
  return r.digest !== undefined ? `${r.repo}@${r.digest}` : `${r.repo}:${r.tag ?? 'latest'}`;
}
