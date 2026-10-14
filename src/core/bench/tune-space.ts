/**
 * What "Trova le impostazioni migliori" searches, per engine family. Every dimension is a list of
 * values (the current one is skipped while descending); the tuner itself knows nothing about engines.
 *
 * llama.cpp: KV f16 / q8_0 / q4_0 (K = V; quantized forces flash attention on) and a fork's own types its
 * build lists, placed by size (contract/kv-cache.ts llamaKvLadder: "Veloce" the two most compact), flash attention
 * on/off (off only with f16), -ub (prompt tokens the GPU processes together: faster prompt reading,
 * but a bigger compute buffer that costs context): 512 / 2048, "Accurata" 256 … 4096 (4096 only when
 * the build lists -ub and the VRAM estimate allows it at that context); "Accurata" also -b in
 * {ub, 2048, 4096, 8192} with b ≥ ub; speculative decoding when the library groups a compatible
 * draft/MTP file with the model and the build supports it. Every layer on the GPU; threads, mmap and
 * mlock do not matter fully on the GPU and are left alone.
 *  - goal 'single': one slot (-np 1: llama-server splits the context across slots);
 *  - goal 'multi': -np N with the context N × the context per user, the pool split per user
 *    (--no-kv-unified) or shared (--kv-unified) as the build allows, --cache-reuse 256 on/off when
 *    the build has it.
 *
 * vLLM: KV auto / fp8 (no 4-bit KV), --max-num-batched-tokens (chunked-prefill size), the memory share
 * (--gpu-memory-utilization) from the highest that fits the free VRAM down, "Accurata" also
 * --block-size 16/32 and fp8_e4m3 vs fp8_e5m2 when the installed vLLM lists them; one sequence
 * (--max-num-seqs 1) or N for goal 'multi'. Beyond the largest context: smaller CUDA graph capture
 * sizes (when vLLM has a flag for them), then --enforce-eager.
 *
 * SGLang: the same shape as vLLM: KV auto / fp8 (fp8_e5m2; "Accurata" also fp8_e4m3 when the installed
 * SGLang lists both), --chunked-prefill-size, the memory share (--mem-fraction-static) fitted to the free
 * VRAM, --max-running-requests 1 or N for goal 'multi'. Beyond the largest context: CUDA graphs only up
 * to the users at once (--cuda-graph-max-bs), then none (--disable-cuda-graph).
 *
 * A program with an OpenAI API: what its commands' placeholders take (commandSpace).
 *
 * TensorRT-LLM: KV auto / fp8 (fp8 when the installed trtllm-serve lists it; "Accurata" also nvfp4 when listed), --max_num_tokens (prompt
 * tokens per step, chunked prefill on), --max_batch_size 1 or N for goal 'multi'. Its KV pool takes its share
 * of whatever memory is free after the weights by itself (--kv_cache_free_gpu_memory_fraction, left at the
 * user's value or 0.9): no memory share to fit, and no CUDA graph flag to trade for context.
 */
import type { CommandKvType, CommandSetting } from '../../contract/custom-engines';
import type { LaunchParams } from '../../contract/engines';
import { llamaKvLadder } from '../../contract/kv-cache';
import type { TuneBudget, TuneTag } from '../../contract/results';
import type { LocalModel } from '../../contract/models';
import type { LlamaCaps } from '../engines/llamacpp-native/caps';
import type { DimValue, Dimension, TuneSpace, Variant } from './tuner';

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

// 'recheck' never searches: it loads earlier combinations as they were.
const UBATCH: Record<TuneBudget, number[]> = { fast: [512, 2048], thorough: [512, 256, 1024, 2048], recheck: [] };
/** The largest ubatch tried ("Accurata"), when the build and the VRAM allow it. */
export const BIG_UBATCH = 4096;
const BATCH = [2048, 4096, 8192] as const;
const BATCHED_TOKENS: Record<TuneBudget, number[]> = { fast: [2048, 8192], thorough: [2048, 8192, 16384], recheck: [] };
/** --cache-reuse chunk tried by goal 'multi' (tokens). */
export const CACHE_REUSE = 256;
/** vLLM's default --block-size on CUDA, and the other one tried. */
export const VLLM_BLOCK_SIZES = [16, 32] as const;
/** vLLM memory shares tried from the top down (the first is the one fitted to the free VRAM). */
export const VLLM_UTILIZATION_STEPS = [0.9, 0.85, 0.8] as const;

/** Values that won before go first, the rest keep their order (ordering only: nothing is dropped). */
export function preferFirst<T extends DimValue>(values: readonly T[], prefer: readonly DimValue[] | undefined): T[] {
  if (!prefer?.length) return [...values];
  const first = prefer.filter((p): p is T => values.includes(p as T));
  return [...new Set([...first, ...values])];
}

export interface LlamaSpaceOptions {
  budget: TuneBudget;
  /** The user's launch parameters (only what the search does not set is kept). */
  params: LaunchParams;
  /** Speculative decoding arguments, when a compatible draft/MTP file and the build's support exist (goal 'single' only). */
  draftArgs?: string[];
  /** Goal 'multi': users at once (-np). */
  users?: number;
  /** Options of the build (llama-server --help); unknown = the bare minimum (no 4096 ubatch, no layout or reuse choice). */
  flags?: ReadonlySet<string>;
  /** Values that won in earlier tune runs on this GPU, by dimension key: tried first. */
  prefer?: Readonly<Record<string, readonly DimValue[]>>;
  /** The -ctk values the build lists (EngineCaps.choices): a fork's own types join the KV ladder. */
  cacheTypes?: readonly string[] | undefined;
}

/** llama.cpp KV layouts of goal 'multi' this build can be told to use, the default first. */
export function llamaLayouts(flags: ReadonlySet<string>): ('unified' | 'split')[] {
  if (!flags.has('--kv-unified')) return ['split'];
  return flags.has('--no-kv-unified') ? ['unified', 'split'] : ['unified'];
}

export function llamaSpace(o: LlamaSpaceOptions): TuneSpace {
  const kept = keptParams(o.params);
  const flags = o.flags ?? new Set<string>();
  const multi = o.users !== undefined && o.users > 1;
  const draft = multi ? undefined : o.draftArgs;
  const layouts = llamaLayouts(flags);
  const reuse = multi && flags.has('--cache-reuse') ? [0, CACHE_REUSE] : [0];
  const bigUb = o.budget === 'thorough' && (flags.has('-ub') || flags.has('--ubatch-size'));
  const ubatch = [...UBATCH[o.budget], ...(bigUb ? [BIG_UBATCH] : [])];
  const dims: Dimension[] = [];
  if (multi && layouts.length > 1) dims.push({ key: 'layout', values: () => layouts });
  if (reuse.length > 1) dims.push({ key: 'reuse', values: () => reuse });
  dims.push({ key: 'fa', values: (v) => (v.kv === 'f16' ? ['on', 'off'] : ['on']) });
  // The biggest ubatch is tried only where the VRAM estimate says its compute buffer fits.
  dims.push({ key: 'ub', values: () => preferFirst(ubatch, o.prefer?.ub), prune: (v) => v === BIG_UBATCH });
  if (o.budget === 'thorough') {
    dims.push({ key: 'b', values: (v) => preferFirst([...new Set([v.b as number, v.ub as number, ...BATCH])].filter((b) => b >= (v.ub as number)), o.prefer?.b) });
  }
  if (draft) dims.push({ key: 'draft', values: () => [false, true] });
  return {
    kvLadder: llamaKvLadder(o.budget, o.cacheTypes),
    base: (kv) => ({
      kv,
      fa: 'on',
      ub: 512,
      b: 2048,
      ...(draft ? { draft: false } : {}),
      ...(multi ? { np: o.users as number, layout: layouts[0] as string, reuse: 0 } : {}),
    }),
    dimensions: dims,
    contextFor: (users, perUser) => users * perUser,
    params: (v, ctx) => {
      const extra = [...kept.extraArgs];
      if (v.draft === true) extra.push(...(draft as string[]));
      if (v.ncmoe !== undefined) extra.push('--n-cpu-moe', String(v.ncmoe));
      // Unified is what the adapter passes for several slots; split needs saying (when the build can).
      if (v.layout === 'split' && flags.has('--no-kv-unified')) extra.push('--no-kv-unified');
      if (typeof v.reuse === 'number' && v.reuse > 0) extra.push('--cache-reuse', String(v.reuse));
      return {
        ...kept,
        contextSize: ctx,
        kvCacheType: v.kv as string,
        flashAttention: v.fa as 'on' | 'off',
        ubatchSize: v.ub as number,
        // llama.cpp clamps ub to b: b is at least ub.
        batchSize: Math.max(v.b as number, v.ub as number),
        parallel: typeof v.np === 'number' ? v.np : 1,
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
  /**
   * --gpu-memory-utilization values, highest first: the first is fitted to the free VRAM, the next
   * ones are tried when vLLM refuses to start ("less than desired GPU memory utilization"). Empty /
   * undefined = vLLM's default.
   */
  utilizations?: readonly number[];
  /** Goal 'multi': users at once (--max-num-seqs). */
  users?: number;
  /** Options of the installed vLLM (`vllm serve --help=all`) and the choices it lists. */
  flags?: ReadonlySet<string>;
  choices?: Readonly<Record<string, readonly string[]>>;
  prefer?: Readonly<Record<string, readonly DimValue[]>>;
}

/** The memory shares to try, highest first: the one fitted to the free VRAM, then the usual steps below it. */
export function vllmUtilizations(fitted: number | undefined): number[] {
  const top = fitted ?? 0.95;
  return [top, ...VLLM_UTILIZATION_STEPS.filter((u) => u < top - 0.001)];
}

/** CUDA graph capture sizes when only a few are captured: powers of two up to the users at once (at least 1, 2, 4). */
export function smallGraphSizes(users: number): number[] {
  const out = [1, 2, 4];
  while ((out.at(-1) as number) < users) out.push((out.at(-1) as number) * 2);
  return out;
}

/** The flag that sets the capture sizes, as the installed vLLM spells it; undefined when it has none. */
export function graphSizeArgs(flags: ReadonlySet<string>, sizes: readonly number[]): string[] | undefined {
  if (flags.has('--cuda-graph-sizes')) return ['--cuda-graph-sizes', ...sizes.map(String)];
  if (flags.has('--compilation-config')) return ['--compilation-config', JSON.stringify({ cudagraph_capture_sizes: sizes })];
  return undefined;
}

export function vllmSpace(o: VllmSpaceOptions): TuneSpace {
  const kept = keptParams(o.params);
  const flags = o.flags ?? new Set<string>();
  const users = o.users !== undefined && o.users > 1 ? o.users : undefined;
  const thorough = o.budget === 'thorough';
  const blocks = o.choices?.['--block-size'] ?? [];
  const sizes = thorough && VLLM_BLOCK_SIZES.every((b) => blocks.includes(String(b))) ? [...VLLM_BLOCK_SIZES] : undefined;
  const dtypes = o.choices?.['--kv-cache-dtype'] ?? [];
  const fp8 = thorough && dtypes.includes('fp8_e4m3') && dtypes.includes('fp8_e5m2') ? ['fp8_e4m3', 'fp8_e5m2'] : undefined;
  const graphs = graphSizeArgs(flags, smallGraphSizes(users ?? 1));
  const dims: Dimension[] = [{ key: 'bt', values: () => preferFirst(BATCHED_TOKENS[o.budget], o.prefer?.bt) }];
  if (sizes) dims.push({ key: 'bs', values: () => sizes });
  if (fp8) dims.push({ key: 'fp8', values: (v) => (v.kv === 'fp8' ? fp8 : []) });
  const utilizations = o.utilizations ?? [];
  return {
    kvLadder: ['auto', 'fp8'],
    base: (kv) => ({
      kv,
      bt: 2048,
      ...(sizes ? { bs: VLLM_BLOCK_SIZES[0] } : {}),
      ...(fp8 && kv === 'fp8' ? { fp8: fp8[0] as string } : {}),
      ...(users ? { np: users } : {}),
    }),
    dimensions: dims,
    ...(utilizations.length ? { startup: { key: 'gmu', values: utilizations } } : {}),
    // Beyond the largest context: memory from the CUDA graphs (fewer capture sizes, then none).
    extensions: [...(graphs ? [{ graphs: 'small' }] : []), { eager: true }],
    contextFor: (_users, perUser) => perUser,
    params: (v, ctx) => {
      const extra = [...kept.extraArgs];
      if (v.eager === true) extra.push('--enforce-eager');
      else if (v.graphs === 'small') extra.push(...(graphs as string[]));
      if (typeof v.bs === 'number' && v.bs !== VLLM_BLOCK_SIZES[0]) extra.push('--block-size', String(v.bs));
      if (typeof v.fp8 === 'string' && v.kv === 'fp8') extra.push('--kv-cache-dtype', v.fp8);
      // Conversations of goal 'multi': the cached prompt tokens are reported only when asked.
      if (users && flags.has('--enable-prompt-tokens-details')) extra.push('--enable-prompt-tokens-details');
      return {
        ...kept,
        maxModelLen: ctx,
        kvCacheType: v.kv as 'auto' | 'fp8',
        batchSize: v.bt as number,
        parallel: typeof v.np === 'number' ? v.np : 1,
        ...(typeof v.gmu === 'number' ? { gpuMemoryUtilization: v.gmu } : {}),
        extraArgs: extra,
      };
    },
    tags: (v) => tagsOf(v),
  };
}

export type SglangSpaceOptions = VllmSpaceOptions;

/** SGLang's KV formats tried by "Accurata", the default (what kvCacheType 'fp8' becomes) first. */
export const SGLANG_FP8 = ['fp8_e5m2', 'fp8_e4m3'] as const;

export function sglangSpace(o: SglangSpaceOptions): TuneSpace {
  const kept = keptParams(o.params);
  const flags = o.flags ?? new Set<string>();
  const users = o.users !== undefined && o.users > 1 ? o.users : undefined;
  const dtypes = o.choices?.['--kv-cache-dtype'] ?? [];
  const fp8 = o.budget === 'thorough' && SGLANG_FP8.every((d) => dtypes.includes(d)) ? [...SGLANG_FP8] : undefined;
  const dims: Dimension[] = [{ key: 'bt', values: () => preferFirst(BATCHED_TOKENS[o.budget], o.prefer?.bt) }];
  if (fp8) dims.push({ key: 'fp8', values: (v) => (v.kv === 'fp8' ? fp8 : []) });
  const utilizations = o.utilizations ?? [];
  const smallGraphs = flags.has('--cuda-graph-max-bs');
  return {
    kvLadder: ['auto', 'fp8'],
    base: (kv) => ({ kv, bt: 2048, ...(fp8 && kv === 'fp8' ? { fp8: fp8[0] as string } : {}), ...(users ? { np: users } : {}) }),
    dimensions: dims,
    ...(utilizations.length ? { startup: { key: 'gmu', values: utilizations } } : {}),
    // Beyond the largest context: memory from the CUDA graphs (only up to the users at once, then none).
    extensions: [...(smallGraphs ? [{ graphs: 'small' }] : []), { eager: true }],
    contextFor: (_users, perUser) => perUser,
    params: (v, ctx) => {
      const extra = [...kept.extraArgs];
      if (v.eager === true) extra.push('--disable-cuda-graph');
      else if (v.graphs === 'small') extra.push('--cuda-graph-max-bs', String(users ?? 1));
      if (typeof v.fp8 === 'string' && v.kv === 'fp8' && v.fp8 !== SGLANG_FP8[0]) extra.push('--kv-cache-dtype', v.fp8);
      return {
        ...kept,
        maxModelLen: ctx,
        kvCacheType: v.kv as 'auto' | 'fp8',
        batchSize: v.bt as number,
        parallel: typeof v.np === 'number' ? v.np : 1,
        ...(typeof v.gmu === 'number' ? { gpuMemoryUtilization: v.gmu } : {}),
        extraArgs: extra,
      };
    },
    tags: (v) => tagsOf(v),
  };
}

export interface CommandSpaceOptions {
  budget: TuneBudget;
  params: LaunchParams;
  /** The LLM Bench settings the program's commands take (contract COMMAND_SETTINGS keys). */
  settings: readonly CommandSetting[];
  /** The values {kv} takes, the most precise first. */
  kvTypes: readonly CommandKvType[];
  /** Goal 'multi': users at once ({parallel}). */
  users?: number;
  prefer?: Readonly<Record<string, readonly DimValue[]>>;
}

/**
 * A program with an OpenAI API, through the placeholders its commands use: the context ({ctx}, always:
 * without it there is nothing to search), the KV types {kv} takes in the user's list, the most precise
 * first (without {kv}: one, 'auto', the program's own); {ubatch} 512 / 2048 ("Accurata" 256 … 2048) and
 * {batch} 2048 / 8192 ("Accurata" also 16384) when it takes them; {parallel} the users of goal 'multi'.
 * Goal 'multi' launches users × the context per user: what a program that shares its context among its
 * users needs (one that gives each its own has room to spare).
 */
export function commandSpace(o: CommandSpaceOptions): TuneSpace {
  const kept = keptParams(o.params);
  const has = (s: CommandSetting) => o.settings.includes(s);
  const users = o.users !== undefined && o.users > 1 ? o.users : undefined;
  const dims: Dimension[] = [];
  if (has('ubatch')) dims.push({ key: 'ub', values: () => preferFirst(UBATCH[o.budget], o.prefer?.ub) });
  if (has('batch')) dims.push({ key: 'b', values: () => preferFirst(BATCHED_TOKENS[o.budget], o.prefer?.b) });
  return {
    kvLadder: has('kv') ? [...o.kvTypes] : ['auto'],
    base: (kv) => ({ kv, ...(has('ubatch') ? { ub: 512 } : {}), ...(has('batch') ? { b: 2048 } : {}), ...(users ? { np: users } : {}) }),
    dimensions: dims,
    contextFor: (n, perUser) => n * perUser,
    params: (v, ctx) => ({
      ...kept,
      contextSize: ctx,
      ...(has('kv') ? { kvCacheType: v.kv as LaunchParams['kvCacheType'] } : {}),
      ...(typeof v.ub === 'number' ? { ubatchSize: v.ub } : {}),
      ...(typeof v.b === 'number' ? { batchSize: v.b } : {}),
      ...(has('parallel') ? { parallel: typeof v.np === 'number' ? v.np : 1 } : {}),
    }),
    tags: (v) => tagsOf(v),
  };
}

export interface TrtllmSpaceOptions {
  budget: TuneBudget;
  params: LaunchParams;
  /** Goal 'multi': users at once (--max_batch_size). */
  users?: number | undefined;
  /** The choices trtllm-serve's --help lists (--kv_cache_dtype). */
  choices?: Readonly<Record<string, readonly string[]>> | undefined;
  prefer?: Readonly<Record<string, readonly DimValue[]>> | undefined;
}

export function trtllmSpace(o: TrtllmSpaceOptions): TuneSpace {
  const kept = keptParams(o.params);
  // The search chooses the KV type: a KV type of the user's own would override every combination.
  const { kvCacheDtype: _kv, ...own } = kept.trtllm ?? {};
  const trtllm = Object.keys(own).length > 0 ? { trtllm: own } : {};
  const users = o.users !== undefined && o.users > 1 ? o.users : undefined;
  const dtypes = o.choices?.['--kv_cache_dtype'];
  // NVFP4 (a prototype, Blackwell only) is tried by "Accurata" alone, when the installed trtllm-serve lists it.
  const ladder = ['auto', ...(!dtypes || dtypes.includes('fp8') ? ['fp8'] : []), ...(o.budget === 'thorough' && dtypes?.includes('nvfp4') ? ['nvfp4'] : [])];
  return {
    kvLadder: ladder,
    base: (kv) => ({ kv, bt: 2048, ...(users ? { np: users } : {}) }),
    dimensions: [{ key: 'bt', values: () => preferFirst(BATCHED_TOKENS[o.budget], o.prefer?.bt) }],
    contextFor: (_users, perUser) => perUser,
    params: (v, ctx) => {
      const { trtllm: _t, ...rest } = kept;
      return {
        ...rest,
        ...trtllm,
        contextSize: ctx,
        kvCacheType: v.kv as string,
        batchSize: v.bt as number,
        parallel: typeof v.np === 'number' ? v.np : 1,
        extraArgs: [...kept.extraArgs],
      };
    },
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
