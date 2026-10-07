import { promises as fs } from 'node:fs';
import { z } from 'zod';
import type { EngineConfig, EngineStatus, LaunchParams } from '../../../contract/engines';
import { AppError, toAppErrorData } from '../../../contract/errors';
import type { CoreDeps } from '../../deps';
import type { DockerCli } from '../../docker/cli';
import { codeForState, type DockerEnvironment } from '../../docker/environment';
import type { ImageInfo } from '../../docker/client';
import { digestFor, parseImageRef } from '../../docker/image-ref';
import type { ImageService } from '../../docker/images';
import type { EngineAdapter, EngineCaps, EngineInstance, InstallPlan, LaunchPlan, ModelTarget, ProgressSink } from '../types';
import type { ModelClientFactory } from './client';
import { loadEngineCompat, type EngineCompat } from './compat';

export type DockerAdapterDeps = Pick<CoreDeps, 'clock' | 'proc' | 'fetch' | 'platform' | 'log' | 'paths'>;

/** Docker-only settings next to EngineConfig (engineConfigSchema has no `modelVolume` field yet: zod strips it from API input). */
export type DockerEngineConfig = EngineConfig & {
  /** Serve the model from this named volume (where the user copied it) instead of a bind mount. */
  modelVolume?: string;
};

/** A Docker LaunchPlan: also says which image runs and whether the model is read through a slow share. */
export interface DockerLaunchPlan extends LaunchPlan {
  image: string;
  containerName: string;
  /** Windows/macOS bind mount: Docker Desktop reads it through its VM file share (validity flag slow_shared_filesystem). */
  slowSharedFilesystem: boolean;
}

export interface DockerEngineOptions {
  deps: DockerAdapterDeps;
  cli: DockerCli;
  environment: DockerEnvironment;
  images: ImageService;
  createClient: ModelClientFactory;
  /** Defaults to resources/engine-compat.json. */
  loadCompat?: () => Promise<EngineCompat>;
  readyTimeoutMs?: number;
  pollMs?: number;
  stopTimeoutSec?: number;
}

const installDataSchema = z.object({ image: z.string() });

/** Detection, image install (pull with progress) and image checks shared by the Docker engines. */
export abstract class DockerEngineAdapter implements EngineAdapter {
  abstract readonly kind: 'llamacpp-docker' | 'vllm-docker';
  private compatP: Promise<EngineCompat> | undefined;

  constructor(protected readonly o: DockerEngineOptions) {}

  protected abstract defaultImage(compat: EngineCompat): string;
  /** Short engine label for the install confirmation ("llama.cpp", "vLLM"). */
  protected abstract readonly engineLabel: string;

  abstract capabilities(cfg: EngineConfig): Promise<EngineCaps>;
  abstract plan(cfg: EngineConfig, model: ModelTarget, params: LaunchParams, opts: { port: number; marker: string }): Promise<DockerLaunchPlan>;
  abstract start(plan: LaunchPlan, signal: AbortSignal): Promise<EngineInstance>;

  compat(): Promise<EngineCompat> {
    this.compatP ??= (this.o.loadCompat ?? (() => loadEngineCompat(this.o.deps.paths.resourcesDir)))();
    return this.compatP;
  }

  /** cfg.image or the default from engine-compat.json, validated (it becomes a CLI argument). */
  async imageFor(cfg?: EngineConfig): Promise<string> {
    const image = cfg?.image ?? this.defaultImage(await this.compat());
    parseImageRef(image);
    return image;
  }

  async detect(cfg?: EngineConfig): Promise<EngineStatus> {
    const status: EngineStatus = { kind: this.kind, available: false, installed: false, problems: [], supported: true };
    let image: string;
    try {
      image = await this.imageFor(cfg);
    } catch (e) {
      status.problems.push(toAppErrorData(e).code);
      return status;
    }
    status.location = image;
    const tag = parseImageRef(image).tag;
    if (tag !== undefined) status.version = tag;
    const docker = await this.o.environment.status();
    const problem = codeForState(docker.state);
    // "no GPU" still lets us look at the images; the other states mean no daemon to ask.
    if (problem !== undefined && docker.state !== 'no-gpu') {
      status.problems.push(problem);
      return status;
    }
    const info = await this.o.images.inspect(image).catch((e: unknown) => {
      status.problems.push(toAppErrorData(e).code);
      return undefined;
    });
    status.installed = info !== undefined;
    if (!status.installed && status.problems.length === 0) status.problems.push('ENGINE_NOT_INSTALLED');
    if (problem !== undefined) status.problems.push(problem);
    status.available = status.installed && problem === undefined;
    status.variant = /cuda13/.test(image) ? 'cuda13' : 'cuda';
    return status;
  }

  async installPlan(cfg: EngineConfig): Promise<InstallPlan> {
    const image = await this.imageFor(cfg);
    const bytes = (await this.o.images.downloadSize(image)) ?? 0;
    return {
      kind: this.kind,
      label: `${this.engineLabel} (${image})`,
      bytes,
      items: [{ label: image, bytes }],
      data: { image },
    };
  }

  async install(plan: InstallPlan, progress: ProgressSink, signal: AbortSignal): Promise<void> {
    const { image } = installDataSchema.parse(plan.data);
    await this.o.images.pull(
      image,
      (p) =>
        progress({
          stage: p.status === 'done' ? 'done' : p.status === 'extracting' ? 'extract' : 'download',
          bytesDone: p.bytesDone,
          ...(p.bytesTotal > 0 ? { bytesTotal: p.bytesTotal } : {}),
        }),
      signal,
      plan.bytes > 0 ? plan.bytes : undefined,
    );
  }

  /** The image must be local before t0: pulling never counts as load time. */
  protected async requireImage(image: string): Promise<ImageInfo> {
    const info = await this.o.images.inspect(image);
    if (!info) {
      throw new AppError('ENGINE_NOT_INSTALLED', `Docker image not present: ${image}`, { params: { image, reason: 'image-missing', kind: this.kind } });
    }
    return info;
  }

  /** Digest of the local image for the run's identity (best effort: plan() also works before the pull). */
  protected async imageDigest(image: string): Promise<string | undefined> {
    const info = await this.o.images.inspect(image).catch(() => undefined);
    return info ? digestFor(image, info.repoDigests) : undefined;
  }

  /** Sum of the files' sizes, or `fallback` when they cannot be read (e.g. a named volume). */
  protected async filesBytes(files: readonly string[], fallback: number | undefined): Promise<number> {
    const sizes = await Promise.all(files.map((f) => fs.stat(f).then((s) => s.size, () => 0)));
    const total = sizes.reduce((a, b) => a + b, 0);
    return total > 0 ? total : (fallback ?? 0);
  }

  /** Docker Desktop (Windows/macOS) serves bind mounts through its VM share: slow first reads. */
  protected slowShare(bindMount: boolean): boolean {
    return bindMount && this.o.deps.platform !== 'linux';
  }
}
