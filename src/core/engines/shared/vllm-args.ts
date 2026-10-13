import path from 'node:path';
import type { LaunchParams, RopeScaling } from '../../../contract/engines';
import { AppError } from '../../../contract/errors';
import type { ModelTarget } from '../types';
import { vllmKvDtype } from './kv-flags';
import { FlagGate } from './standard-flags';

export const VLLM_DEFAULT_MAX_MODEL_LEN = 4096;
/** vLLM's own default, passed explicitly so the stored command says what was used. */
export const VLLM_DEFAULT_GPU_MEMORY_UTILIZATION = 0.9;
export const VLLM_SEED = 0;

/** Where vLLM reads the model from. */
export type VllmModelSource =
  | { kind: 'repo'; repo: string; revision?: string }
  | {
      kind: 'local';
      /** Host folder to mount (Docker) or to pass as is (native). */
      hostDir: string;
      /** Folder name under /models in the container. */
      name: string;
      /** Path of the model inside hostDir ("" or "snapshots/<rev>" for an HF cache entry). */
      inner: string;
      /** Files read at load (cache eviction, cold-read estimate). */
      files: string[];
    };

const SNAPSHOT = /[\\/](models--[^\\/]+)[\\/]snapshots[\\/]([^\\/]+)[\\/]?$/;

/**
 * Local safetensors folders are served from disk; anything else from its HF repo (downloaded by
 * vLLM into the HF cache). An HF-cache snapshot is mounted from its `models--…` root because the
 * snapshot files are relative symlinks into ../../blobs.
 */
export function vllmModelSource(model: ModelTarget): VllmModelSource {
  const local = model.local;
  if (local && model.identity.format === 'safetensors') {
    const snap = SNAPSHOT.exec(local.dir);
    if (snap) {
      const root = local.dir.slice(0, snap.index + 1 + (snap[1] as string).length);
      return { kind: 'local', hostDir: root, name: snap[1] as string, inner: `snapshots/${snap[2] as string}`, files: local.paths };
    }
    const base = path.basename(local.dir.replace(/[\\/]+$/, '').replace(/\\/g, '/'));
    return { kind: 'local', hostDir: local.dir, name: base.replace(/[^A-Za-z0-9._-]/g, '_') || 'model', inner: '', files: local.paths };
  }
  const repo = model.repo ?? model.identity.repo;
  if (repo === undefined) {
    throw new AppError('MODEL_NOT_FOUND', 'No Hugging Face repository or local folder for this model', {
      params: { model: model.identity.displayName },
    });
  }
  const rev = model.identity.revision;
  return rev !== undefined && rev !== 'main' ? { kind: 'repo', repo, revision: rev } : { kind: 'repo', repo };
}

export interface VllmServeOptions {
  /** HF repo id or a path (inside the container for Docker). */
  model: string;
  /** `vllm serve <model>` (true) or the legacy `--model <model>`. */
  positional: boolean;
  host: string;
  port: number;
  servedName: string;
  /** Servers for other programs: listed first, so responses carry the model's own name. */
  apiName?: string | undefined;
  revision?: string;
}

/** The rope_scaling entry of a model config (vLLM --hf-overrides, SGLang --json-model-override-args). */
export function ropeScalingConfig(r: RopeScaling): { rope_type: string; factor: number; original_max_position_embeddings: number } {
  return { rope_type: r.type, factor: r.factor, original_max_position_embeddings: r.originalContext };
}

/**
 * Server arguments shared by vLLM Docker and native: everything explicit, so the record is exact.
 * `gate` leaves out the flags a build (a fork) does not list; by default everything is passed.
 */
export function vllmServeArgs(params: LaunchParams, o: VllmServeOptions, gate = new FlagGate('vllm', undefined)): string[] {
  const args = o.positional ? [o.model] : ['--model', o.model];
  // Several names are all accepted; the first one is what responses report.
  gate.push(args, '--served-model-name', ...(o.apiName !== undefined ? [o.apiName] : []), o.servedName);
  gate.push(args, '--host', o.host);
  gate.push(args, '--port', String(o.port));
  if (o.revision !== undefined) args.push('--revision', o.revision);
  gate.push(args, '--max-model-len', String(params.maxModelLen ?? params.contextSize ?? VLLM_DEFAULT_MAX_MODEL_LEN));
  gate.push(args, '--gpu-memory-utilization', String(params.gpuMemoryUtilization ?? VLLM_DEFAULT_GPU_MEMORY_UTILIZATION));
  if (params.parallel !== undefined) gate.push(args, '--max-num-seqs', String(params.parallel));
  const kv = vllmKvDtype(params);
  if (kv !== undefined) gate.push(args, '--kv-cache-dtype', kv);
  // Chunked-prefill size: prompt tokens processed per engine step (llama.cpp's batch).
  if (params.batchSize !== undefined) gate.push(args, '--max-num-batched-tokens', String(params.batchSize));
  gate.push(args, '--seed', String(VLLM_SEED));
  if (params.dtype !== undefined) gate.push(args, '--dtype', params.dtype);
  if (params.quantization !== undefined) gate.push(args, '--quantization', params.quantization);
  if (params.ropeScaling) {
    const rope = ropeScalingConfig(params.ropeScaling);
    // Current vLLM overrides the model config with --hf-overrides; older builds had --rope-scaling.
    if (gate.lists('--hf-overrides')) args.push('--hf-overrides', JSON.stringify({ rope_scaling: rope }));
    else if (gate.lists('--rope-scaling')) args.push('--rope-scaling', JSON.stringify(rope));
    else gate.note('--hf-overrides');
  }
  args.push(...params.extraArgs);
  return args;
}
