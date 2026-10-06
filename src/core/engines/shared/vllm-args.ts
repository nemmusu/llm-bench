import path from 'node:path';
import type { LaunchParams } from '../../../contract/engines';
import { AppError } from '../../../contract/errors';
import type { ModelTarget } from '../types';

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

/** Server arguments shared by vLLM Docker and native: everything explicit, so the record is exact. */
export function vllmServeArgs(params: LaunchParams, o: VllmServeOptions): string[] {
  const args = o.positional ? [o.model] : ['--model', o.model];
  // Several names are all accepted; the first one is what responses report.
  args.push('--served-model-name', ...(o.apiName !== undefined ? [o.apiName] : []), o.servedName, '--host', o.host, '--port', String(o.port));
  if (o.revision !== undefined) args.push('--revision', o.revision);
  args.push('--max-model-len', String(params.maxModelLen ?? params.contextSize ?? VLLM_DEFAULT_MAX_MODEL_LEN));
  args.push('--gpu-memory-utilization', String(params.gpuMemoryUtilization ?? VLLM_DEFAULT_GPU_MEMORY_UTILIZATION));
  if (params.parallel !== undefined) args.push('--max-num-seqs', String(params.parallel));
  args.push('--seed', String(VLLM_SEED));
  if (params.dtype !== undefined) args.push('--dtype', params.dtype);
  if (params.quantization !== undefined) args.push('--quantization', params.quantization);
  args.push(...params.extraArgs);
  return args;
}
