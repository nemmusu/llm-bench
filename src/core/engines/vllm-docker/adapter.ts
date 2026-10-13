import path from 'node:path';
import type { EngineConfig, LaunchParams } from '../../../contract/engines';
import type { EngineIdentity } from '../../../contract/results';
import { containerName, dockerRunArgv, startContainer, type DockerEngineInstance } from '../../docker/container';
import type { DockerApiProvider } from '../../docker/api-provider';
import type { DockerHubClient } from '../../docker/hub';
import { HF_PLACEHOLDER } from '../command-display';
import type { EngineCaps, LaunchPlan, ModelTarget, PlanOptions } from '../types';
import {
  parseVllmTag,
  suggestVllmTag,
  vllmCudaForTag,
  vllmPositionalModel,
  vllmTagOf,
  vllmTagSupportsSm,
  type EngineCompat,
} from '../shared/compat';
import { DockerEngineAdapter, type DockerEngineOptions, type DockerLaunchPlan } from '../shared/docker-engine';
import { modelReadyProbe } from '../shared/probes';
import { FlagGate, trustedFlags } from '../shared/standard-flags';
import { vllmModelSource, vllmServeArgs } from '../shared/vllm-args';
import { probeVllmHelp, type VllmHelp } from '../shared/vllm-help';
import { diagnoseVllm, vllmPhaseOf } from '../shared/vllm-logs';

export const VLLM_CONTAINER_PORT = 8000;
/** Persistent volumes: downloaded HF weights and vLLM's torch.compile cache survive container removal. */
export const HF_CACHE_VOLUME = 'gpubench-hf-cache';
export const VLLM_CACHE_VOLUME = 'gpubench-vllm-cache';

/** A vllm/vllm-openai tag as offered in the UI. */
export interface VllmTagInfo {
  name: string;
  lastUpdated?: string;
  sizeBytes?: number;
  digest?: string;
  recommended: boolean;
  /** Kernels for this PC's GPU (engine-compat.json); undefined when unknown. */
  supportsGpu?: boolean;
  /** CUDA version of the image (driver requirement). */
  cuda?: string;
}

export interface VllmDockerOptions extends DockerEngineOptions {
  hub: DockerHubClient;
  /** Engine API, to label our cache volumes (optional: `docker run` creates them anyway). */
  api?: DockerApiProvider;
  /** Hugging Face token (in memory, from the main process); passed to the container by name only. */
  hfToken?: () => string | undefined;
  /** Compute capability of the benchmarked GPU as "sm_120" (for tag advice). */
  gpuSm?: () => Promise<string | undefined>;
}

/** A vLLM Docker plan also remembers the HF repo (for error messages when the log does not name it). */
export interface VllmDockerLaunchPlan extends DockerLaunchPlan {
  modelRepo?: string;
}

/** Release tags and their CUDA variants; nightly/arch-specific/ubuntu variants are noise for users. */
const RELEASE_TAG = /^v\d+\.\d+\.\d+(?:\.\d+)?(?:-cu\d+)?$/;

/** vLLM's OpenAI server image (vllm/vllm-openai) with persistent HF and compile caches. */
export class VllmDockerAdapter extends DockerEngineAdapter {
  readonly kind = 'vllm-docker' as const;
  protected readonly engineLabel = 'vLLM';
  private readonly helps = new Map<string, Promise<VllmHelp>>();

  constructor(private readonly v: VllmDockerOptions) {
    super(v);
  }

  protected defaultImage(compat: EngineCompat): string {
    return `${compat.vllm.image}:${compat.vllm.recommendedTag}`;
  }

  /**
   * vLLM takes token-id prompts, honours min_tokens and reports usage (no llama.cpp timings). Its
   * options come from the image's own `--help=all` (a short container, cached per image id); a
   * missing image or a failed probe gives none (the tuner then skips its optional dimensions).
   */
  async capabilities(cfg: EngineConfig): Promise<EngineCaps> {
    const image = await this.imageFor(cfg);
    const tag = vllmTagOf(image, await this.compat());
    const info = await this.o.images.inspect(image).catch(() => undefined);
    let help: VllmHelp = { flags: new Set(), choices: {} };
    if (info) {
      const key = info.id || image;
      let p = this.helps.get(key);
      if (!p) {
        p = probeVllmHelp((args) => this.o.cli.exec(['run', '--rm', '--pull', 'never', image, ...args], { timeoutMs: 300_000 }));
        this.helps.set(key, p);
      }
      help = await p;
    }
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

  async plan(cfg: EngineConfig, model: ModelTarget, params: LaunchParams, opts: PlanOptions): Promise<VllmDockerLaunchPlan> {
    const compat = await this.compat();
    const image = await this.imageFor(cfg);
    const tag = vllmTagOf(image, compat);
    const src = vllmModelSource(model);
    const volumes = [`${HF_CACHE_VOLUME}:/root/.cache/huggingface`, `${VLLM_CACHE_VOLUME}:/root/.cache/vllm`];
    let modelRef: string;
    if (src.kind === 'local') {
      volumes.push(`${src.hostDir}:/models/${src.name}:ro`);
      modelRef = path.posix.join('/models', src.name, src.inner);
    } else {
      modelRef = src.repo;
    }
    // A draft model named in the arguments (--speculative-config's "model"): mounted too, its path rewritten.
    const aux = this.containerArgs(params.extraArgs, 'vllm', src.kind === 'local' ? [{ hostDir: src.hostDir, containerDir: `/models/${src.name}` }] : []);
    volumes.push(...aux.volumes);
    // Only a placeholder in the plan: the token value is added to the docker CLI's environment at start.
    const env: Record<string, string> = { ...params.env };
    if (this.v.hfToken?.()) env.HF_TOKEN = HF_PLACEHOLDER;
    // A fork's options (its check), or the image's own when the RoPE flag must be chosen.
    const known = opts.knownFlags ?? (params.ropeScaling ? (await this.capabilities(cfg)).flags : undefined);
    const gate = new FlagGate('vllm', trustedFlags('vllm', known));
    const argv = dockerRunArgv({
      docker: await this.o.cli.command(),
      marker: opts.marker,
      hostPort: opts.port,
      containerPort: VLLM_CONTAINER_PORT,
      // Shared memory for PyTorch workers (the vLLM docs' recommended setting).
      extraRunFlags: ['--ipc=host'],
      volumes,
      envNames: Object.keys(env),
      image,
      args: vllmServeArgs({ ...params, extraArgs: aux.args }, {
        model: modelRef,
        positional: vllmPositionalModel(compat, tag),
        host: '0.0.0.0',
        port: VLLM_CONTAINER_PORT,
        servedName: opts.marker,
        apiName: opts.apiName,
        ...(src.kind === 'repo' && src.revision !== undefined ? { revision: src.revision } : {}),
      }, gate),
    });
    const engine: EngineIdentity = { kind: this.kind, name: 'vLLM', image };
    if (tag !== undefined && parseVllmTag(tag)) engine.version = tag;
    const digest = await this.imageDigest(image);
    if (digest !== undefined) engine.imageDigest = digest;
    const files = src.kind === 'local' ? src.files : [];
    const out: VllmDockerLaunchPlan = {
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
    await this.ensureVolumes();
    const token = this.v.hfToken?.();
    const secretEnv: Record<string, string> = plan.env.HF_TOKEN !== undefined && token ? { HF_TOKEN: token } : {};
    const sm = await this.v.gpuSm?.().catch(() => undefined);
    const suggestTag = suggestVllmTag(await this.compat(), sm);
    const repo = (plan as VllmDockerLaunchPlan).modelRepo;
    const baseUrl = `http://${plan.host}:${plan.port}`;
    return startContainer({
      cli: this.o.cli,
      proc: deps.proc,
      clock: deps.clock,
      log: deps.log,
      plan,
      secretEnv,
      client: this.o.createClient('vllm', baseUrl, { model: plan.marker }),
      probe: modelReadyProbe(deps.fetch, baseUrl, plan.marker, plan.apiKey),
      phaseOf: vllmPhaseOf,
      diagnose: (lines, exit) => diagnoseVllm(lines, exit, { docker: true, suggestTag, ...(repo !== undefined ? { repo } : {}) }),
      signal,
      onNoGpu: (detail) => this.o.environment.noteGpuFailure(image, detail),
      ...(this.o.pollMs !== undefined ? { pollMs: this.o.pollMs } : {}),
      ...(this.o.readyTimeoutMs !== undefined ? { readyTimeoutMs: this.o.readyTimeoutMs } : {}),
      ...(this.o.stopTimeoutSec !== undefined ? { stopTimeoutSec: this.o.stopTimeoutSec } : {}),
    });
  }

  /** Our cache volumes carry the gpubench label (best effort: `docker run` creates them anyway). */
  private async ensureVolumes(): Promise<void> {
    try {
      if (!this.v.api) return;
      const api = await this.v.api.get();
      for (const name of [HF_CACHE_VOLUME, VLLM_CACHE_VOLUME]) await api.ensureVolume(name, { gpubench: '1' });
    } catch (e) {
      this.o.deps.log.debug('cache volume labelling skipped', { error: String(e) });
    }
  }

  /** Release tags from Docker Hub, newest first, annotated for this GPU. */
  async tags(opts: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<VllmTagInfo[]> {
    const compat = await this.compat();
    const sm = await this.v.gpuSm?.().catch(() => undefined);
    const list = await this.v.hub.listTags(compat.vllm.image, 'v', opts);
    return list
      .filter((t) => RELEASE_TAG.test(t.name))
      .map((t) => {
        const info: VllmTagInfo = { ...t, recommended: t.name === compat.vllm.recommendedTag };
        const supports = sm === undefined ? undefined : vllmTagSupportsSm(compat, t.name, sm);
        if (supports !== undefined) info.supportsGpu = supports;
        const cuda = vllmCudaForTag(compat, t.name);
        if (cuda !== undefined) info.cuda = cuda;
        return info;
      });
  }
}
