/**
 * NVIDIA TensorRT-LLM in its NGC image (nvcr.io/nvidia/tensorrt-llm/release:<tag>) with Docker's GPU: on
 * Windows through Docker Desktop and its WSL2 GPU, on Linux with the NVIDIA container toolkit. The image's
 * entrypoint (nvidia_entrypoint.sh) runs the command given: `trtllm-serve serve <model> …`. Same HF cache
 * volume as vLLM and SGLang (a model downloaded once serves all three).
 */
import path from 'node:path';
import type { EngineConfig, LaunchParams } from '../../../contract/engines';
import { AppError } from '../../../contract/errors';
import type { EngineIdentity } from '../../../contract/results';
import { classifyDockerError } from '../../docker/cli';
import { containerName, dockerRunArgv, startContainer, type DockerEngineInstance } from '../../docker/container';
import type { DockerApiProvider } from '../../docker/api-provider';
import { parseImageRef } from '../../docker/image-ref';
import { HF_PLACEHOLDER } from '../command-display';
import type { EngineCaps, InstallPlan, LaunchPlan, ModelTarget, PlanOptions } from '../types';
import type { EngineCompat } from '../shared/compat';
import { DockerEngineAdapter, type DockerEngineOptions, type DockerLaunchPlan } from '../shared/docker-engine';
import { modelReadyProbe } from '../shared/probes';
import { FlagGate, trustedFlags } from '../shared/standard-flags';
import { diagnoseTrtllm, probeClickHelp, TRTLLM_CONTAINER_PORT, TRTLLM_PROGRAM, TRTLLM_SERVE, trtllmIgnored, trtllmPhaseOf, trtllmServeArgs } from '../shared/trtllm';
import { vllmModelSource } from '../shared/vllm-args';
import type { VllmHelp } from '../shared/vllm-help';
import { HF_CACHE_VOLUME } from '../vllm-docker/adapter';
import type { NgcRegistry } from './ngc';
import { compareTrtllmTags, isTrtllmReleaseTag, parseTrtllmTag, type TrtllmTagVersion } from './tags';

/** Flags the TensorRT-LLM docs give its containers: shared memory for the workers, no locked-memory or stack limits. */
export const TRTLLM_RUN_FLAGS = ['--ipc=host', '--ulimit', 'memlock=-1', '--ulimit', 'stack=67108864'] as const;
/** NVIDIA's registry (NGC). */
export const NGC_HOST = 'nvcr.io';
/** Tags whose download size is looked up for the list (each costs two registry requests). */
export const SIZED_TAGS = 6;

/** A TensorRT-LLM tag as offered in the UI. */
export interface TrtllmTagInfo {
  name: string;
  recommended: boolean;
  /** A release candidate (X.Y.ZrcN): newer kernels, less tested than a stable X.Y.Z. */
  prerelease: boolean;
  sizeBytes?: number;
  digest?: string;
}

export interface TrtllmDockerOptions extends DockerEngineOptions {
  ngc: Pick<NgcRegistry, 'listTags' | 'tagInfo'>;
  api?: DockerApiProvider;
  hfToken?: () => string | undefined;
}

export interface TrtllmDockerLaunchPlan extends DockerLaunchPlan {
  modelRepo?: string;
}

/** The tag of an image reference, when it is TensorRT-LLM's release image. */
export function trtllmTagOf(image: string, compat: EngineCompat): string | undefined {
  try {
    const ref = parseImageRef(image);
    return `${ref.registry ?? ''}/${ref.repository}` === compat.trtllm.image ? (ref.tag ?? 'latest') : undefined;
  } catch {
    return undefined;
  }
}

/** "nvcr.io/nvidia/tensorrt-llm/release" → "nvidia/tensorrt-llm/release" (the registry path). */
export function registryPath(image: string): string {
  return parseImageRef(image).repository;
}

export class TrtllmDockerAdapter extends DockerEngineAdapter {
  readonly kind = 'trtllm-docker' as const;
  protected readonly engineLabel = 'TensorRT-LLM';
  private readonly helps = new Map<string, Promise<VllmHelp>>();

  constructor(private readonly t: TrtllmDockerOptions) {
    super(t);
  }

  protected defaultImage(compat: EngineCompat): string {
    return `${compat.trtllm.image}:${compat.trtllm.recommendedTag}`;
  }

  /**
   * Token-id prompts, min_tokens and continuous usage like vLLM. Options from the image's own
   * `trtllm-serve serve --help` (click, cached per image id; the program imports CUDA, so the probe gets
   * the GPU too); a missing image or a failed probe gives none.
   */
  async capabilities(cfg: EngineConfig): Promise<EngineCaps> {
    const image = await this.imageFor(cfg);
    const info = await this.o.images.inspect(image).catch(() => undefined);
    let help: VllmHelp = { flags: new Set(), choices: {} };
    if (info) {
      const key = `${info.id}|${image}`;
      let p = this.helps.get(key);
      if (!p) {
        p = probeClickHelp(() => this.o.cli.exec(['run', '--rm', '--pull', 'never', '--gpus', 'all', image, TRTLLM_PROGRAM, TRTLLM_SERVE, '--help'], { timeoutMs: 300_000 }));
        this.helps.set(key, p);
      }
      help = await p;
    }
    const tag = trtllmTagOf(image, await this.compat());
    return {
      ...(tag !== undefined ? { version: tag } : {}),
      flags: help.flags,
      choices: help.choices,
      tokenIdsInPrompt: true,
      timings: false,
      minTokens: true,
      fitFlag: false,
    };
  }

  /** An NGC image's download size from NGC (Docker Hub knows nothing of it; 0 = unknown); another image's as for every Docker engine. */
  override async installPlan(cfg: EngineConfig): Promise<InstallPlan> {
    const image = await this.imageFor(cfg);
    const ref = parseImageRef(image);
    if (ref.registry !== NGC_HOST) return super.installPlan(cfg);
    const bytes = (await this.t.ngc.tagInfo(ref.repository, ref.tag ?? 'latest').catch(() => undefined))?.sizeBytes ?? 0;
    return { kind: this.kind, label: `${this.engineLabel} (${image})`, bytes, items: [{ label: image, bytes }], data: { image } };
  }

  async plan(cfg: EngineConfig, model: ModelTarget, params: LaunchParams, opts: PlanOptions): Promise<TrtllmDockerLaunchPlan> {
    const image = await this.imageFor(cfg);
    const src = vllmModelSource(model);
    const volumes = [`${HF_CACHE_VOLUME}:/root/.cache/huggingface`];
    let modelRef: string;
    if (src.kind === 'local') {
      volumes.push(`${src.hostDir}:/models/${src.name}:ro`);
      modelRef = path.posix.join('/models', src.name, src.inner);
    } else {
      modelRef = src.repo;
    }
    const env: Record<string, string> = { ...params.env };
    if (this.t.hfToken?.()) env.HF_TOKEN = HF_PLACEHOLDER;
    const gate = new FlagGate('trtllm', trustedFlags('trtllm', opts.knownFlags));
    const args = trtllmServeArgs(
      params,
      {
        model: modelRef,
        host: '0.0.0.0',
        port: TRTLLM_CONTAINER_PORT,
        servedName: opts.apiName ?? opts.marker,
        ...(src.kind === 'repo' && src.revision !== undefined ? { revision: src.revision } : {}),
      },
      gate,
    );
    const argv = dockerRunArgv({
      docker: await this.o.cli.command(),
      marker: opts.marker,
      hostPort: opts.port,
      containerPort: TRTLLM_CONTAINER_PORT,
      extraRunFlags: [...TRTLLM_RUN_FLAGS],
      volumes,
      envNames: Object.keys(env),
      image,
      args: [TRTLLM_PROGRAM, TRTLLM_SERVE, ...args],
    });
    const engine: EngineIdentity = { kind: this.kind, name: 'TensorRT-LLM', image };
    const tag = trtllmTagOf(image, await this.compat());
    if (tag !== undefined && tag !== 'latest') engine.version = tag;
    const digest = await this.imageDigest(image);
    if (digest !== undefined) engine.imageDigest = digest;
    const files = src.kind === 'local' ? src.files : [];
    const unsupported = [...gate.missing, ...trtllmIgnored(params)];
    const out: TrtllmDockerLaunchPlan = {
      kind: this.kind,
      argv,
      env,
      host: '127.0.0.1',
      port: opts.port,
      params,
      engine,
      modelFiles: files,
      modelBytes: await this.filesBytes(files, model.identity.sizeBytes),
      marker: opts.marker,
      image,
      containerName: containerName(opts.marker),
      slowSharedFilesystem: this.slowShare(src.kind === 'local'),
      ...(unsupported.length > 0 ? { unsupported } : {}),
    };
    if (src.kind === 'repo') out.modelRepo = src.repo;
    return out;
  }

  async start(plan: LaunchPlan, signal: AbortSignal): Promise<DockerEngineInstance> {
    const image = plan.engine.image as string;
    await this.requireImage(image);
    const { deps } = this.o;
    await this.ensureVolume();
    const token = this.t.hfToken?.();
    const secretEnv: Record<string, string> = plan.env.HF_TOKEN !== undefined && token ? { HF_TOKEN: token } : {};
    const repo = (plan as TrtllmDockerLaunchPlan).modelRepo;
    const baseUrl = `http://${plan.host}:${plan.port}`;
    const served = plan.argv[plan.argv.indexOf('--served_model_name') + 1] as string;
    return startContainer({
      cli: this.o.cli,
      proc: deps.proc,
      clock: deps.clock,
      log: deps.log,
      plan,
      secretEnv,
      client: this.o.createClient('trtllm', baseUrl, { model: served }),
      probe: modelReadyProbe(deps.fetch, baseUrl, served, plan.apiKey),
      phaseOf: trtllmPhaseOf,
      diagnose: (lines, exit) => diagnoseTrtllm(lines, exit, { docker: true, ...(repo !== undefined ? { repo } : {}) }),
      signal,
      onNoGpu: (detail) => this.o.environment.noteGpuFailure(image, detail),
      onHang: this.o.environment.reportHang,
      ...(this.o.pollMs !== undefined ? { pollMs: this.o.pollMs } : {}),
      ...(this.o.readyTimeoutMs !== undefined ? { readyTimeoutMs: this.o.readyTimeoutMs } : {}),
      ...(this.o.stopTimeoutSec !== undefined ? { stopTimeoutSec: this.o.stopTimeoutSec } : {}),
    });
  }

  /**
   * "Rimuovi": `docker image rm <image>` (the HF cache volume with its models stays). Docker refuses it
   * while a container of the image runs: said as ENGINE_UPDATE_FAILED with reason 'busy'.
   */
  async remove(cfg: EngineConfig): Promise<void> {
    const image = await this.imageFor(cfg);
    const out = await this.o.cli.exec(['image', 'rm', image], { timeoutMs: 120_000 });
    if (out.code === 0 || /No such image/i.test(out.stderr)) return;
    if (/is using its referenced image|image is being used by running container/i.test(out.stderr)) {
      throw new AppError('ENGINE_UPDATE_FAILED', 'A container of this image is running', { params: { reason: 'busy', image }, detail: out.stderr.slice(-2000) });
    }
    throw classifyDockerError(out);
  }

  /** The shared HF cache volume carries the gpubench label (best effort). */
  private async ensureVolume(): Promise<void> {
    try {
      if (!this.t.api) return;
      await (await this.t.api.get()).ensureVolume(HF_CACHE_VOLUME, { gpubench: '1' });
    } catch (e) {
      this.o.deps.log.debug('cache volume labelling skipped', { error: String(e) });
    }
  }

  /** The digest and size of an NGC image's tag ("Aggiorna": a newer image under the same tag); undefined for other registries. */
  async remoteTag(image: string): Promise<TrtllmTagInfo | undefined> {
    const ref = parseImageRef(image);
    if (ref.registry !== NGC_HOST || ref.digest !== undefined) return undefined;
    const name = ref.tag ?? 'latest';
    const t = await this.t.ngc.tagInfo(ref.repository, name, { refresh: true });
    const compat = await this.compat();
    return { ...t, recommended: name === compat.trtllm.recommendedTag, prerelease: parseTrtllmTag(name)?.rc !== undefined };
  }

  /**
   * Release tags from NGC (stable X.Y.Z and release candidates; nightlies left out), newest first, the
   * recommended one marked; the newest few (and the recommended one) with their size and digest.
   */
  async tags(opts: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<TrtllmTagInfo[]> {
    const compat = await this.compat();
    const repo = registryPath(compat.trtllm.image);
    const names = (await this.t.ngc.listTags(repo, opts)).filter(isTrtllmReleaseTag).sort((a, b) => compareTrtllmTags(b, a));
    return Promise.all(
      names.map(async (name, i): Promise<TrtllmTagInfo> => {
        const recommended = name === compat.trtllm.recommendedTag;
        const info: TrtllmTagInfo = { name, recommended, prerelease: (parseTrtllmTag(name) as TrtllmTagVersion).rc !== undefined };
        if (i >= SIZED_TAGS && !recommended) return info;
        const t = await this.t.ngc.tagInfo(repo, name, opts).catch(() => undefined);
        if (t?.sizeBytes !== undefined) info.sizeBytes = t.sizeBytes;
        if (t?.digest !== undefined) info.digest = t.digest;
        return info;
      }),
    );
  }
}
