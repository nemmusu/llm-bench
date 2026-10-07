/**
 * What "Trova le impostazioni migliori" searches, per engine family. Every dimension is a list of
 * values (the first is the default); the tuner itself knows nothing about engines.
 *
 * llama.cpp: KV f16 / q8_0 / q4_0 (K = V; quantized forces flash attention on), flash attention
 * on/off (off only with f16), -ub 256…2048 (prompt tokens the GPU processes together: faster prompt
 * reading, but a bigger compute buffer that costs context), -b ≥ ub, speculative decoding when the
 * library groups a compatible draft/MTP file with the model and the build supports it. Always one
 * slot (-np 1: llama-server splits the context across slots), every layer on the GPU; threads, mmap
 * and mlock do not matter fully on the GPU and are left alone.
 *
 * vLLM: KV auto / fp8 (no 4-bit KV), --max-num-batched-tokens (chunked-prefill size), one sequence
 * (--max-num-seqs 1), the memory share fitted to the free VRAM, --enforce-eager only as a last resort.
 */
import type { LaunchParams } from '../../contract/engines';
import type { TuneBudget, TuneTag } from '../../contract/results';
import type { LocalModel } from '../../contract/models';
import type { LlamaCaps } from '../engines/llamacpp-native/caps';
import type { Dimension, TuneSpace, Variant } from './tuner';

/** Launch parameters the search sets itself; the user's other choices (threads, env, extra args…) are kept. */
const SEARCHED: readonly (keyof LaunchParams)[] = [
  'contextSize',
  'maxModelLen',
  'kvCacheType',
  'flashAttention',
  'ubatchSize',
  'batchSize',
  'parallel',
  'gpuLayers',
  'gpuMemoryUtilization',
];

export function keptParams(p: LaunchParams): LaunchParams {
  const out: LaunchParams = { ...p, extraArgs: [...p.extraArgs], env: { ...p.env } };
  for (const k of SEARCHED) delete out[k];
  return out;
}

const UBATCH: Record<TuneBudget, number[]> = { fast: [512, 2048], thorough: [512, 256, 1024, 2048] };
const BATCHED_TOKENS: Record<TuneBudget, number[]> = { fast: [2048, 8192], thorough: [2048, 8192, 16384] };

export interface LlamaSpaceOptions {
  budget: TuneBudget;
  /** The user's launch parameters (only what the search does not set is kept). */
  params: LaunchParams;
  /** Speculative decoding arguments, when a compatible draft/MTP file and the build's support exist. */
  draftArgs?: string[];
}

export function llamaSpace(o: LlamaSpaceOptions): TuneSpace {
  const kept = keptParams(o.params);
  const draft = o.draftArgs;
  const dims: Dimension[] = [
    { key: 'fa', values: (v) => (v.kv === 'f16' ? ['on', 'off'] : ['on']) },
    { key: 'ub', values: () => UBATCH[o.budget] },
  ];
  if (o.budget === 'thorough') dims.push({ key: 'b', values: (v) => [...new Set([Math.max(2048, v.ub as number), 4096])] });
  if (draft) dims.push({ key: 'draft', values: () => [false, true] });
  return {
    kvLadder: ['f16', 'q8_0', 'q4_0'],
    base: (kv) => ({ kv, fa: 'on', ub: 512, b: 2048, ...(draft ? { draft: false } : {}) }),
    dimensions: dims,
    params: (v, ctx) => {
      const extra = [...kept.extraArgs];
      if (v.draft === true) extra.push(...(draft as string[]));
      if (v.ncmoe !== undefined) extra.push('--n-cpu-moe', String(v.ncmoe));
      return {
        ...kept,
        contextSize: ctx,
        kvCacheType: v.kv as LaunchParams['kvCacheType'],
        flashAttention: v.fa as 'on' | 'off',
        ubatchSize: v.ub as number,
        batchSize: v.b as number,
        parallel: 1,
        ...(v.ngl !== undefined ? { gpuLayers: v.ngl as number } : {}),
        extraArgs: extra,
      };
    },
    tags: (v) => tagsOf(v),
  };
}

export interface VllmSpaceOptions {
  budget: TuneBudget;
  params: LaunchParams;
  /** --gpu-memory-utilization fitted to the free VRAM (undefined = vLLM's default). */
  gpuMemoryUtilization?: number;
}

export function vllmSpace(o: VllmSpaceOptions): TuneSpace {
  const kept = keptParams(o.params);
  return {
    kvLadder: ['auto', 'fp8'],
    base: (kv) => ({ kv, bt: 2048 }),
    dimensions: [{ key: 'bt', values: () => BATCHED_TOKENS[o.budget] }],
    params: (v, ctx) => ({
      ...kept,
      maxModelLen: ctx,
      kvCacheType: v.kv as 'auto' | 'fp8',
      batchSize: v.bt as number,
      parallel: 1,
      ...(o.gpuMemoryUtilization !== undefined ? { gpuMemoryUtilization: o.gpuMemoryUtilization } : {}),
      extraArgs: v.eager === true ? [...kept.extraArgs, '--enforce-eager'] : [...kept.extraArgs],
    }),
    tags: (v) => tagsOf(v),
  };
}

function tagsOf(v: Variant): TuneTag[] {
  const tags: TuneTag[] = [];
  if (v.ncmoe !== undefined || v.ngl !== undefined) tags.push('cpu-offload');
  if (v.eager === true) tags.push('eager');
  if (v.draft === true) tags.push('draft');
  return tags;
}

/**
 * Speculative decoding for this model with this build, or undefined: a draft or MTP file the library
 * grouped with the model, and the flags to use it in `llama-server --help`. Nothing is downloaded.
 */
export function speculativeArgs(model: Pick<LocalModel, 'auxiliary'> | undefined, caps: Pick<LlamaCaps, 'flags' | 'entries' | 'nglKeywords'>): string[] | undefined {
  const aux = model?.auxiliary.find((a) => a.kind === 'mtp' || a.kind === 'draft');
  if (!aux || !caps.flags.has('--model-draft')) return undefined;
  const wanted = aux.kind === 'mtp' ? 'draft-mtp' : /eagle/i.test(aux.path) ? 'draft-eagle3' : 'draft-simple';
  const spec = caps.entries.find((e) => e.names.includes('--spec-type'));
  // Builds without --spec-type only know plain draft models.
  if (!spec) return wanted === 'draft-simple' ? ['-md', aux.path, ...draftLayers(caps)] : undefined;
  if (!(spec.placeholder ?? '').split(',').includes(wanted)) return undefined;
  return ['--spec-type', wanted, '-md', aux.path, ...draftLayers(caps)];
}

function draftLayers(caps: Pick<LlamaCaps, 'flags' | 'nglKeywords'>): string[] {
  return caps.flags.has('--gpu-layers-draft') ? ['-ngld', caps.nglKeywords.includes('all') ? 'all' : '999'] : [];
}
