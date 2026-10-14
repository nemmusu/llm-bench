import path from 'node:path';
import type { EngineConfig, LaunchParams } from '../../../contract/engines';
import { AppError } from '../../../contract/errors';
import type { EngineIdentity } from '../../../contract/results';
import { containerName, dockerRunArgv, startContainer, type DockerEngineInstance } from '../../docker/container';
import { llamaArgs } from '../llamacpp-native/args';
import { capsFromOutputs, parseHelp, type LlamaCaps } from '../llamacpp-native/caps';
import { diagnoseExit, llamaPhaseOf } from '../llamacpp-native/logs';
import { weightFiles, type LaunchPlan, type ModelTarget, type PlanOptions } from '../types';
import type { EngineCompat } from '../shared/compat';
import { DockerEngineAdapter, type DockerEngineConfig, type DockerLaunchPlan } from '../shared/docker-engine';
import { modelReadyProbe } from '../shared/probes';
import { withLlamaVision } from '../shared/reasoning-vision';
import { FlagGate, trustedFlags } from '../shared/standard-flags';

export const LLAMA_CONTAINER_PORT = 8080;
export const DEFAULT_CONTEXT = 4096;

/** Caps assumed when the image cannot be probed: a current llama-server (the default image is rebuilt daily). */
export function defaultLlamaCaps(): LlamaCaps {
  return {
    flags: new Set(),
    tokenIdsInPrompt: true,
    timings: true,
    minTokens: false,
    fitFlag: false,
    flashAttn: 'value',
    nglKeywords: [],
    cacheTypes: [],
    // Unknown build: one alias (the marker) is safe everywhere.
    aliasList: false,
    entries: [],
  };
}

/**
 * llama-server arguments inside the container; same rules as the native adapter (llamacpp-native/args.ts).
 * `gate` leaves out the flags the image's build does not know (default: pass everything).
 */
export function llamaServerArgs(
  params: LaunchParams,
  caps: LlamaCaps,
  o: { modelPath: string; marker: string; apiName?: string | undefined },
  gate = new FlagGate('llamacpp', undefined),
): string[] {
  return llamaArgs(params, caps, { modelPath: o.modelPath, host: '0.0.0.0', port: LLAMA_CONTAINER_PORT, marker: o.marker, apiName: o.apiName }, gate);
}

/** llama.cpp `server-cuda` image (ghcr.io/ggml-org/llama.cpp), GGUF model bind-mounted read-only. */
export class LlamaDockerAdapter extends DockerEngineAdapter {
  readonly kind = 'llamacpp-docker' as const;
  protected readonly engineLabel = 'llama.cpp';
  private readonly capsCache = new Map<string, Promise<LlamaCaps>>();

  protected defaultImage(compat: EngineCompat): string {
    return compat.llamacpp.dockerImage;
  }

  /**
   * `--version` / `--help` of the image's llama-server (two short containers, cached per image id).
   * Falls back to current-build defaults when the image is missing or the probe fails.
   */
  async capabilities(cfg: EngineConfig): Promise<LlamaCaps> {
    const image = await this.imageFor(cfg);
    const info = await this.o.images.inspect(image).catch(() => undefined);
    if (!info) return defaultLlamaCaps();
    const key = info.id || image;
    let p = this.capsCache.get(key);
    if (!p) {
      p = this.probe(image);
      this.capsCache.set(key, p);
    }
    return p;
  }

  private async probe(image: string): Promise<LlamaCaps> {
    const run = (flag: string) => this.o.cli.exec(['run', '--rm', '--pull', 'never', image, flag], { timeoutMs: 120_000 });
    const v = await run('--version');
    const h = await run('--help');
    const help = `${h.stdout}\n${h.stderr}`;
    if (h.code !== 0 || parseHelp(help).length === 0) {
      this.o.deps.log.warn('llama.cpp image probe failed, using defaults', { image, code: h.code });
      return defaultLlamaCaps();
    }
    return capsFromOutputs(`${v.stderr}\n${v.stdout}`, help);
  }

  async plan(cfg: DockerEngineConfig, model: ModelTarget, params: LaunchParams, opts: PlanOptions): Promise<DockerLaunchPlan> {
    const image = await this.imageFor(cfg);
    // In a preview, a GGUF still to download is mounted from where the download will put it.
    const { files, pending } = weightFiles(model, opts.preview);
    const main = files[0];
    if (main === undefined) {
      throw new AppError('MODEL_NOT_FOUND', 'No local GGUF file for this model', { params: { model: model.identity.displayName } });
    }
    const hostPath = this.o.deps.platform === 'win32' ? path.win32 : path.posix;
    const volume = cfg.modelVolume;
    // Split GGUFs: every shard sits next to the first one, so mounting its folder is enough.
    const mount = volume !== undefined ? `${volume}:/models:ro` : `${hostPath.dirname(main)}:/models:ro`;
    const caps = await this.capabilities(cfg);
    const gate = new FlagGate('llamacpp', trustedFlags('llamacpp', caps.flags));
    // The model's image projector unless vision is switched off, then every file the arguments name
    // (a draft model, a projector): next to the model, or mounted on its own.
    const launched = withLlamaVision(params, model, gate);
    const aux = this.containerArgs(launched.extraArgs, 'llamacpp', volume !== undefined ? [] : [{ hostDir: hostPath.dirname(main), containerDir: '/models' }]);
    const docker = await this.o.cli.command();
    const env = { ...params.env };
    const argv = dockerRunArgv({
      docker,
      marker: opts.marker,
      hostPort: opts.port,
      containerPort: LLAMA_CONTAINER_PORT,
      volumes: [mount, ...aux.volumes],
      envNames: Object.keys(env),
      image,
      args: llamaServerArgs({ ...launched, extraArgs: aux.args }, caps, { modelPath: `/models/${hostPath.basename(main)}`, marker: opts.marker, apiName: opts.apiName }, gate),
    });
    const engine: EngineIdentity = { kind: this.kind, name: 'llama.cpp', image, variant: /cuda13/.test(image) ? 'cuda13' : 'cuda' };
    const digest = await this.imageDigest(image);
    if (digest !== undefined) engine.imageDigest = digest;
    if (caps.version !== undefined) engine.version = caps.version;
    if (caps.build !== undefined) engine.build = caps.build;
    return {
      kind: this.kind,
      argv,
      env,
      host: '127.0.0.1',
      port: opts.port,
      params,
      engine,
      // A named volume lives inside Docker: there is no host file to evict from the page cache.
      modelFiles: volume !== undefined ? [] : files,
      modelBytes: await this.filesBytes(files, model.identity.sizeBytes),
      marker: opts.marker,
      image,
      containerName: containerName(opts.marker),
      slowSharedFilesystem: this.slowShare(volume === undefined),
      ...(pending ? { pending: ['model' as const] } : {}),
      ...(gate.missing.length > 0 ? { unsupported: gate.missing } : {}),
    };
  }

  async start(plan: LaunchPlan, signal: AbortSignal): Promise<DockerEngineInstance> {
    const image = plan.engine.image as string;
    await this.requireImage(image);
    const { deps } = this.o;
    const baseUrl = `http://${plan.host}:${plan.port}`;
    return startContainer({
      cli: this.o.cli,
      proc: deps.proc,
      clock: deps.clock,
      log: deps.log,
      plan,
      client: this.o.createClient('llamacpp', baseUrl),
      probe: modelReadyProbe(deps.fetch, baseUrl, plan.marker, plan.apiKey),
      phaseOf: llamaPhaseOf,
      diagnose: diagnoseExit,
      signal,
      onNoGpu: (detail) => this.o.environment.noteGpuFailure(image, detail),
      onHang: this.o.environment.reportHang,
      ...(this.o.pollMs !== undefined ? { pollMs: this.o.pollMs } : {}),
      ...(this.o.readyTimeoutMs !== undefined ? { readyTimeoutMs: this.o.readyTimeoutMs } : {}),
      ...(this.o.stopTimeoutSec !== undefined ? { stopTimeoutSec: this.o.stopTimeoutSec } : {}),
    });
  }
}
