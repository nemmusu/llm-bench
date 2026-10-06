import { open } from 'node:fs/promises';
import path from 'node:path';
import { gguf } from '@huggingface/gguf';
import { AppError, isAppError } from '../../contract/errors';
import { ftypeName, paramsFromLabel, quantFromFilename, round3 } from './quant';
import type { AttentionGroup, KvLayout, ModelFactsEx } from './types';

export interface GgufHeader {
  metadata: Record<string, unknown>;
  /** Sum of tensor element counts in this file (one shard for split models). */
  parameterCount: number;
  tensorCount: number;
  /** Total file size from Content-Range, when the source reports it. */
  fileSize?: number;
  /** Bytes of token_embd.weight when it is in this file and its type size is known. */
  tokenEmbdBytes?: number;
  /** true when the model has a separate output.weight (embeddings not tied). */
  hasOutputTensor: boolean;
}

/** [elements per block, bytes per block] by GGML tensor type id (ggml.h / ggml.c type_traits). */
const GGML_TYPE_SIZE: Record<number, [number, number]> = {
  0: [1, 4], 1: [1, 2], 2: [32, 18], 3: [32, 20], 6: [32, 22], 7: [32, 24], 8: [32, 34], 9: [32, 36],
  10: [256, 84], 11: [256, 110], 12: [256, 144], 13: [256, 176], 14: [256, 210], 15: [256, 292],
  16: [256, 66], 17: [256, 74], 18: [256, 98], 19: [256, 50], 20: [32, 18], 21: [256, 110], 22: [256, 82],
  23: [256, 136], 24: [1, 1], 25: [1, 2], 26: [1, 4], 27: [1, 8], 28: [1, 8], 29: [256, 56], 30: [1, 2],
  34: [256, 54], 35: [256, 66], 39: [32, 17],
};

/** Storage bytes of a tensor, or undefined for a type we do not know. */
export function tensorBytes(shape: readonly (bigint | number)[], dtype: number): number | undefined {
  const size = GGML_TYPE_SIZE[dtype];
  if (!size) return undefined;
  const elements = shape.reduce<number>((acc, d) => acc * Number(d), 1);
  return Math.ceil(elements / size[0]) * size[1];
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Parses the GGUF header (KV metadata + tensor infos) with @huggingface/gguf, which reads 2 MB
 * Range chunks through `fetchFn` until the header is complete. Never downloads tensor data.
 */
export async function parseGgufHeader(uri: string, fetchFn: typeof fetch): Promise<GgufHeader> {
  let fileSize: number | undefined;
  const tracking = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const res = await fetchFn(input, init);
    const total = /\/(\d+)\s*$/.exec(res.headers.get('content-range') ?? '')?.[1];
    if (total !== undefined) fileSize = Number(total);
    return res;
  }) as typeof fetch;
  try {
    const out = await gguf(uri, { fetch: tracking, computeParametersCount: true });
    const tok = out.tensorInfos.find((t) => t.name === 'token_embd.weight');
    return {
      metadata: out.metadata as Record<string, unknown>,
      parameterCount: out.parameterCount,
      tensorCount: out.tensorInfos.length,
      fileSize,
      tokenEmbdBytes: tok ? tensorBytes(tok.shape, tok.dtype) : undefined,
      hasOutputTensor: out.tensorInfos.some((t) => t.name === 'output.weight'),
    };
  } catch (e) {
    if (isAppError(e)) throw e;
    throw new AppError('MODEL_INVALID', `Not a readable GGUF file: ${errorMessage(e)}`, { cause: e });
  }
}

/**
 * A fetch that serves Range requests from a local file. Lets local and remote GGUF files share
 * one parser without the library's own file access (which bundlers cannot resolve).
 */
export function localRangeFetch(filePath: string): typeof fetch {
  return (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('range') ?? '');
    if (!range) throw new Error('Local GGUF reads need an explicit byte range');
    const fh = await open(filePath, 'r');
    try {
      const size = (await fh.stat()).size;
      const start = Number(range[1]);
      const end = Math.min(Number(range[2]), size - 1);
      const len = Math.max(0, end - start + 1);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, start);
      return new Response(buf, { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${size}` } });
    } finally {
      await fh.close();
    }
  }) as typeof fetch;
}

/** Placeholder URL for local reads: the library only accepts http(s) URIs when given a fetch. */
function localUri(filePath: string): string {
  return `http://local.invalid/${encodeURIComponent(filePath)}`;
}

/** Reads facts from local GGUF files; `paths` are all shards of one model, first shard first. */
export async function readLocalGgufFacts(paths: string[]): Promise<ModelFactsEx> {
  let head: GgufHeader | undefined;
  let params = 0;
  let bytes = 0;
  for (const p of paths) {
    const h = await parseGgufHeader(localUri(p), localRangeFetch(p));
    head ??= h;
    params += h.parameterCount;
    bytes += h.fileSize as number;
  }
  if (!head) throw new AppError('MODEL_NOT_FOUND', 'No GGUF file given');
  return factsFromGguf(head.metadata, {
    parameterCount: params,
    fileBytes: bytes,
    fileName: path.basename(paths[0] as string),
    cpuOnlyBytes: head.hasOutputTensor ? head.tokenEmbdBytes : undefined,
  });
}

// ---- metadata → facts -------------------------------------------------------------------------

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'bigint') return Number(v);
  return undefined;
}

function numArr(v: unknown): number[] | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined;
  const out = v.map(num);
  return out.every((x) => x !== undefined) ? (out as number[]) : undefined;
}

function boolArr(v: unknown): boolean[] | undefined {
  return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'boolean') ? (v as boolean[]) : undefined;
}

/** Scalar, or the max of a per-layer array (head_count and feed_forward_length can be either). */
function maxOf(v: unknown): number | undefined {
  const arr = numArr(v);
  return arr ? Math.max(...arr) : num(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Architectures whose sliding-window layer pattern llama.cpp hard-codes instead of storing it in
 * the GGUF (llama_hparams::set_swa_pattern: layer i is SWA iff i % n < n - 1).
 */
const SWA_PATTERN_BY_ARCH: Record<string, number> = { gemma2: 2, gemma3: 6, cohere2: 4, 'gpt-oss': 2, exaone4: 4 };

function swaPredicate(pattern: unknown, arch: string, window: number | undefined): (i: number) => boolean {
  if (!window) return () => false;
  const arr = boolArr(pattern);
  if (arr) return (i) => arr[i] === true;
  const n = num(pattern) ?? SWA_PATTERN_BY_ARCH[arch];
  // Unknown pattern: count the layer as full attention, which can only overestimate the KV.
  if (n === undefined) return () => false;
  return (i) => n === 0 || i % n < n - 1;
}

export interface LayerShape {
  attn: boolean;
  recurrent: boolean;
  kvHeads: number;
  k: number;
  v: number;
  window?: number;
}

/** Bytes of one recurrent layer's state per sequence, as llama.cpp sizes it (n_embd_r + n_embd_s, f32). */
function recurrentLayerBytes(get: (k: string) => unknown): number {
  const state = num(get('ssm.state_size'));
  const inner = num(get('ssm.inner_size'));
  if (!state || !inner) return 0;
  const conv = num(get('ssm.conv_kernel')) ?? 1;
  const groups = num(get('ssm.group_count')) ?? 0;
  return 4 * ((conv - 1) * (inner + 2 * groups * state) + state * inner);
}

function layerShapes(get: (k: string) => unknown, arch: string, blockCount: number, keyLength: number, valueLength: number): LayerShape[] {
  // MTP / NextN heads are counted in block_count but do not get a KV cache in the main model.
  const nextn = num(get('nextn_predict_layers')) ?? 0;
  const n = blockCount - nextn > 0 ? blockCount - nextn : blockCount;
  const kvRaw = get('attention.head_count_kv');
  const kvArr = numArr(kvRaw);
  const kvScalar = num(kvRaw) ?? maxOf(get('attention.head_count')) ?? 0;
  const kSwa = num(get('attention.key_length_swa')) ?? keyLength;
  const vSwa = num(get('attention.value_length_swa')) ?? valueLength;
  const window = num(get('attention.sliding_window'));
  const isSwa = swaPredicate(get('attention.sliding_window_pattern'), arch, window);
  const recurrentArr = boolArr(get('attention.recurrent_layers'));
  const interval = num(get('full_attention_interval'));
  const marked = recurrentArr !== undefined || interval !== undefined;
  const hasSsm = get('ssm.state_size') !== undefined;
  const zeros = kvArr?.includes(0) === true;
  const shapes: LayerShape[] = [];
  for (let i = 0; i < n; i++) {
    const kvHeads = kvArr ? (kvArr[i] ?? 0) : kvScalar;
    let recurrent: boolean;
    if (recurrentArr) recurrent = recurrentArr[i] === true;
    else if (interval) recurrent = (i + 1) % interval !== 0;
    // Jamba/Granite-H/Nemotron-H mark SSM layers with 0 KV heads; Falcon-H1 runs both in every layer.
    else recurrent = hasSsm && (!zeros || kvHeads === 0);
    const attn = kvHeads > 0 && !(marked && recurrent);
    const swa = attn && isSwa(i);
    shapes.push({ attn, recurrent, kvHeads, k: swa ? kSwa : keyLength, v: swa ? vSwa : valueLength, window: swa ? window : undefined });
  }
  return shapes;
}

export function groupLayers(shapes: LayerShape[]): AttentionGroup[] {
  const groups = new Map<string, AttentionGroup>();
  for (const s of shapes) {
    if (!s.attn) continue;
    const key = `${s.kvHeads}|${s.k}|${s.v}|${s.window ?? ''}`;
    const g = groups.get(key);
    if (g) g.layers++;
    else groups.set(key, { layers: 1, kvHeads: s.kvHeads, keyLength: s.k, valueLength: s.v, ...(s.window ? { window: s.window } : {}) });
  }
  return [...groups.values()];
}

export interface GgufFactsOptions {
  parameterCount?: number;
  /** Bytes of all shards (needed for bitsPerWeight and cpuOnlyFraction). */
  fileBytes?: number;
  fileName?: string;
  /** Weights llama.cpp keeps in RAM: token_embd when output.weight is separate. */
  cpuOnlyBytes?: number;
}

/** Maps GGUF KV metadata to facts. Pure: works on metadata from local or remote headers. */
export function factsFromGguf(md: Record<string, unknown>, opts: GgufFactsOptions = {}): ModelFactsEx {
  const arch = str(md['general.architecture']) ?? '';
  const get = (k: string): unknown => md[`${arch}.${k}`];
  const facts: ModelFactsEx = {};
  const set = <K extends keyof ModelFactsEx>(k: K, v: ModelFactsEx[K] | undefined) => {
    if (v !== undefined) facts[k] = v;
  };
  set('architecture', str(md['general.architecture']));
  set('name', str(md['general.name']));

  const params = opts.parameterCount ? opts.parameterCount / 1e9 : paramsFromLabel(str(md['general.size_label']));
  if (params) set('paramsB', round3(params));
  const fromName = opts.fileName ? quantFromFilename(opts.fileName) : undefined;
  set('quant', fromName ?? ftypeName(num(md['general.file_type'])));
  if (opts.fileBytes && opts.parameterCount) set('bitsPerWeight', Math.round(((opts.fileBytes * 8) / opts.parameterCount) * 100) / 100);
  if (opts.fileBytes && opts.cpuOnlyBytes) set('cpuOnlyFraction', Math.round((opts.cpuOnlyBytes / opts.fileBytes) * 1e4) / 1e4);

  set('contextLength', num(get('context_length')));
  const embd = num(get('embedding_length'));
  set('embeddingLength', embd);
  const heads = maxOf(get('attention.head_count'));
  set('headCount', heads);
  const keyLength = num(get('attention.key_length_mla')) ?? num(get('attention.key_length')) ?? (embd && heads ? Math.floor(embd / heads) : undefined);
  const valueLength = num(get('attention.value_length_mla')) ?? num(get('attention.value_length')) ?? keyLength;
  set('keyLength', keyLength);
  set('valueLength', valueLength);
  set('expertCount', num(get('expert_count')));
  set('expertUsedCount', num(get('expert_used_count')));
  set('feedForwardLength', maxOf(get('feed_forward_length')));
  const tokens = md['tokenizer.ggml.tokens'];
  set('vocabSize', num(get('vocab_size')) ?? (Array.isArray(tokens) ? tokens.length : undefined));

  const blockCount = num(get('block_count'));
  set('blockCount', blockCount);
  if (blockCount) {
    const shapes = layerShapes(get, arch, blockCount, keyLength ?? 128, valueLength ?? 128);
    const groups = groupLayers(shapes);
    const attn = shapes.filter((s) => s.attn);
    const swa = attn.filter((s) => s.window !== undefined);
    const recurrentLayers = shapes.filter((s) => s.recurrent).length;
    const kv: KvLayout = { groups, recurrentLayers, recurrentBytesPerSeq: recurrentLayers * recurrentLayerBytes(get) };
    facts.kv = kv;
    if (attn.length > 0) set('headCountKv', Math.max(...attn.map((s) => s.kvHeads)));
    if (swa.length > 0) {
      set('slidingWindow', (swa[0] as LayerShape).window);
      set('slidingWindowLayers', swa.length);
    }
    set('fullAttentionLayers', attn.length - swa.length);
  }
  return facts;
}
