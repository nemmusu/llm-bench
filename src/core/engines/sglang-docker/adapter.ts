import path from 'node:path';
import type { EngineConfig, LaunchParams } from '../../../contract/engines';
import type { EngineIdentity } from '../../../contract/results';
import { containerName, dockerRunArgv, startContainer, type DockerEngineInstance } from '../../docker/container';
import type { DockerApiProvider } from '../../docker/api-provider';
import type { DockerHubClient } from '../../docker/hub';
import { parseImageRef } from '../../docker/image-ref';
import { HF_PLACEHOLDER } from '../command-display';
import type { EngineCaps, LaunchPlan, ModelTarget, PlanOptions } from '../types';
import type { EngineCompat } from '../shared/compat';
import { DockerEngineAdapter, type DockerEngineOptions, type DockerLaunchPlan } from '../shared/docker-engine';
import { modelReadyProbe } from '../shared/probes';
import { diagnoseSglang, SGLANG_CONTAINER_PORT, SGLANG_MODULE, sglangEnv, sglangPhaseOf, sglangServeArgs } from '../shared/sglang';
import { FlagGate, trustedFlags } from '../shared/standard-flags';
import { vllmModelSource } from '../shared/vllm-args';
import { probeArgparseHelp, type VllmHelp } from '../shared/vllm-help';
import { HF_CACHE_VOLUME } from '../vllm-docker/adapter';

/** The Python inside lmsysorg/sglang images (no server entrypoint: the command is given). */
export const SGLANG_IMAGE_PYTHON = 'python3';

/** A lmsysorg/sglang tag as offered in the UI. */
export interface SglangTagInfo {
  name: string;
  lastUpdated?: string;
  sizeBytes?: number;
  digest?: string;
  recommended: boolean;
  /** CUDA version of the image when its tag says (-cu130 → "13.0"). */
  cuda?: string;
}

export interface SglangDockerOptions extends DockerEngineOptions {
  hub: DockerHubClient;
  api?: DockerApiProvider;
  hfToken?: () => string | undefined;
}

export interface SglangDockerLaunchPlan extends DockerLaunchPlan {
  modelRepo?: string;
}

/** NVIDIA release tags: vX.Y.Z[.postN][-cuNNN][-runtime] (rocm, xpu, cann, nightly and dev builds are left out). */
const RELEASE_TAG = /^v\d+\.\d+\.\d+(?:\.post\d+)?(?:-cu\d+)?(?:-runtime)?$/;

/** "-cu130" → "13.0", "-cu129" → "12.9". */
export function sglangCudaOfTag(tag: string): string | undefined {
  const m = /-cu(\d+)(\d)\b/.exec(tag);
  return m ? `${m[1] as string}.${m[2] as string}` : undefined;
}

/** The tag of an image reference, when it is the lmsysorg/sglang image. */
export function sglangTagOf(image: string, compat: EngineCompat): string | undefined {
  try {
    const ref = parseImageRef(image);
    return ref.registry === undefined && ref.repository === compat.sglang.image ? (ref.tag ?? 'latest') : undefined;
  } catch {
    return undefined;
  }
}

/**
 * SGLang's image (lmsysorg/sglang) with Docker's GPU: on Windows through Docker Desktop and its WSL2
 * GPU, on Linux with the NVIDIA container toolkit. Same HF cache volume as vLLM (a model downloaded
 * once serves both).
 */
export class SglangDockerAdapter extends DockerEngineAdapter {
  readonly kind = 'sglang-docker' as const;
  protected readonly engineLabel = 'SGLang';
  private readonly helps = new Map<string, Promise<VllmHelp>>();

  constructor(private readonly s: SglangDockerOptions) {
    super(s);
  }

  protected defaultImage(compat: EngineCompat): string {
    return `${compat.sglang.image}:${compat.sglang.recommendedTag}`;
  }

  /**
   * Token-id prompts, min_tokens and usage like vLLM. Options from the image's own
   * `python3 -m sglang.launch_server --help` (argparse, cached per image id); a missing image or a
   * failed probe gives none.
   */
  async capabilities(cfg: EngineConfig): Promise<EngineCaps> {
    const image = await this.imageFor(cfg);
    const info = await this.o.images.inspect(image).catch(() => undefined);
    let help: VllmHelp = { flags: new Set(), choices: {} };
    if (info) {
      const key = info.id || image;
      let p = this.helps.get(key);
      if (!p) {
        p = probeArgparseHelp(() => this.o.cli.exec(['run', '--rm', '--pull', 'never', image, SGLANG_IMAGE_PYTHON, ...SGLANG_MODULE, '--help'], { timeoutMs: 300_000 }));
        this.helps.set(key, p);
      }
      help = await p;
    }
    const tag = sglangTagOf(image, await this.compat());
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

  async plan(cfg: EngineConfig, model: ModelTarget, params: LaunchParams, opts: PlanOptions): Promise<SglangDockerLaunchPlan> {
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
    // A draft model named in the arguments: mounted too, its path rewritten.
    const aux = this.containerArgs(params.extraArgs, 'sglang', src.kind === 'local' ? [{ hostDir: src.hostDir, containerDir: `/models/${src.name}` }] : []);
    volumes.push(...aux.volumes);
    const env = sglangEnv(params);
    if (this.s.hfToken?.()) env.HF_TOKEN = HF_PLACEHOLDER;
    const gate = new FlagGate('sglang', trustedFlags('sglang', opts.knownFlags));
    const args = sglangServeArgs(
      { ...params, extraArgs: aux.args },
      {
        model: modelRef,
        host: '0.0.0.0',
        port: SGLANG_CONTAINER_PORT,
        servedName: opts.apiName ?? opts.marker,
        ...(src.kind === 'repo' && src.revision !== undefined ? { revision: src.revision } : {}),
      },
      gate,
    );
    const argv = dockerRunArgv({
      docker: await this.o.cli.command(),
      marker: opts.marker,
      hostPort: opts.port,
      containerPort: SGLANG_CONTAINER_PORT,
      // PyTorch workers share memory through /dev/shm (the SGLang docs' setting).
      extraRunFlags: ['--ipc=host'],
      volumes,
      envNames: Object.keys(env),
      image,
      args: [SGLANG_IMAGE_PYTHON, ...SGLANG_MODULE, ...args],
    });
    const engine: EngineIdentity = { kind: this.kind, name: 'SGLang', image };
    const tag = sglangTagOf(image, await this.compat());
    if (tag !== undefined && tag !== 'latest') engine.version = tag;
    const digest = await this.imageDigest(image);
    if (digest !== undefined) engine.imageDigest = digest;
    const files = src.kind === 'local' ? src.files : [];
    const out: SglangDockerLaunchPlan = {
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
      ...(gate.missing.length > 0 ? { unsupported: gate.missing } : {}),
    };
    if (src.kind === 'repo') out.modelRepo = src.repo;
    return out;
  }

  async start(plan: LaunchPlan, signal: AbortSignal): Promise<DockerEngineInstance> {
    const image = plan.engine.image as string;
    await this.requireImage(image);
    const { deps } = this.o;
    await this.ensureVolume();
    const token = this.s.hfToken?.();
    const secretEnv: Record<string, string> = plan.env.HF_TOKEN !== undefined && token ? { HF_TOKEN: token } : {};
    const repo = (plan as SglangDockerLaunchPlan).modelRepo;
    const baseUrl = `http://${plan.host}:${plan.port}`;
    const served = plan.argv[plan.argv.indexOf('--served-model-name') + 1] as string;
    return startContainer({
      cli: this.o.cli,
      proc: deps.proc,
      clock: deps.clock,
      log: deps.log,
      plan,
      secretEnv,
      client: this.o.createClient('sglang', baseUrl, { model: served }),
      probe: modelReadyProbe(deps.fetch, baseUrl, served),
      phaseOf: sglangPhaseOf,
      diagnose: (lines, exit) => diagnoseSglang(lines, exit, { docker: true, ...(repo !== undefined ? { repo } : {}) }),
      signal,
      onNoGpu: (detail) => this.o.environment.noteGpuFailure(image, detail),
      ...(this.o.pollMs !== undefined ? { pollMs: this.o.pollMs } : {}),
      ...(this.o.readyTimeoutMs !== undefined ? { readyTimeoutMs: this.o.readyTimeoutMs } : {}),
      ...(this.o.stopTimeoutSec !== undefined ? { stopTimeoutSec: this.o.stopTimeoutSec } : {}),
    });
  }

  /** The shared HF cache volume carries the gpubench label (best effort). */
  private async ensureVolume(): Promise<void> {
    try {
      if (!this.s.api) return;
      await (await this.s.api.get()).ensureVolume(HF_CACHE_VOLUME, { gpubench: '1' });
    } catch (e) {
      this.o.deps.log.debug('cache volume labelling skipped', { error: String(e) });
    }
  }

  /** Release tags from Docker Hub, newest first, the recommended one marked. */
  async tags(opts: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<SglangTagInfo[]> {
    const compat = await this.compat();
    const list = await this.s.hub.listTags(compat.sglang.image, 'v', opts);
    return list
      .filter((t) => RELEASE_TAG.test(t.name))
      .map((t) => {
        const info: SglangTagInfo = { ...t, recommended: t.name === compat.sglang.recommendedTag };
        const cuda = sglangCudaOfTag(t.name);
        if (cuda !== undefined) info.cuda = cuda;
        return info;
      });
  }
}
