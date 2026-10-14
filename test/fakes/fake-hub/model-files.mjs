// Tiny synthetic model files for tests and the fake hub: GGUF v2/v3 headers with real-looking
// metadata and tensor infos, safetensors headers, and deterministic filler bytes. Plain JS so
// `node fake-hub.mjs` runs without a build step; types are in model-files.d.mts.

export const GGUF_TYPE = Object.freeze({
  UINT8: 0, INT8: 1, UINT16: 2, INT16: 3, UINT32: 4, INT32: 5, FLOAT32: 6, BOOL: 7,
  STRING: 8, ARRAY: 9, UINT64: 10, INT64: 11, FLOAT64: 12,
});

/** Explicitly typed GGUF values (plain JS values are inferred, see inferValue). */
export const gv = {
  u8: (v) => ({ type: 0, value: v }),
  i8: (v) => ({ type: 1, value: v }),
  u16: (v) => ({ type: 2, value: v }),
  i16: (v) => ({ type: 3, value: v }),
  u32: (v) => ({ type: 4, value: v }),
  i32: (v) => ({ type: 5, value: v }),
  f32: (v) => ({ type: 6, value: v }),
  bool: (v) => ({ type: 7, value: v }),
  str: (v) => ({ type: 8, value: v }),
  u64: (v) => ({ type: 10, value: BigInt(v) }),
  i64: (v) => ({ type: 11, value: BigInt(v) }),
  f64: (v) => ({ type: 12, value: v }),
  arr: (sub, values) => ({ type: 9, sub, value: values }),
};

function inferValue(v) {
  if (v !== null && typeof v === 'object' && !Array.isArray(v) && 'type' in v) return v;
  if (typeof v === 'string') return { type: 8, value: v };
  if (typeof v === 'boolean') return { type: 7, value: v };
  if (typeof v === 'bigint') return { type: 10, value: v };
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) return { type: 6, value: v };
    if (v < 0) return { type: 5, value: v };
    return v > 0xffffffff ? { type: 10, value: BigInt(v) } : { type: 4, value: v };
  }
  if (Array.isArray(v)) {
    const first = v[0];
    let sub = 5;
    if (typeof first === 'string') sub = 8;
    else if (typeof first === 'boolean') sub = 7;
    else if (typeof first === 'number' && !Number.isInteger(first)) sub = 6;
    return { type: 9, sub, value: v };
  }
  throw new Error(`cannot infer a GGUF type for ${String(v)}`);
}

class Writer {
  constructor(version) {
    this.version = version;
    this.parts = [];
    this.length = 0;
  }
  push(buf) {
    this.parts.push(buf);
    this.length += buf.length;
  }
  num(type, v) {
    const sizes = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
    const b = Buffer.alloc(sizes[type]);
    switch (type) {
      case 0: b.writeUInt8(v); break;
      case 1: b.writeInt8(v); break;
      case 2: b.writeUInt16LE(v); break;
      case 3: b.writeInt16LE(v); break;
      case 4: b.writeUInt32LE(v); break;
      case 5: b.writeInt32LE(v); break;
      case 6: b.writeFloatLE(v); break;
      case 7: b.writeUInt8(v ? 1 : 0); break;
      case 10: b.writeBigUInt64LE(BigInt(v)); break;
      case 11: b.writeBigInt64LE(BigInt(v)); break;
      case 12: b.writeDoubleLE(v); break;
      default: throw new Error(`bad numeric type ${type}`);
    }
    this.push(b);
  }
  size(n) {
    this.num(this.version === 1 ? 4 : 10, n);
  }
  str(s) {
    const b = Buffer.from(s, 'utf8');
    this.size(b.length);
    this.push(b);
  }
  value(type, v, sub) {
    if (type === 8) return this.str(v);
    if (type === 9) {
      this.num(4, sub);
      this.size(v.length);
      for (const x of v) this.value(sub, x, undefined);
      return undefined;
    }
    return this.num(type, v);
  }
}

/** [elements per block, bytes per block] for the GGML types the fixtures use. */
const TYPE_SIZE = { 0: [1, 4], 1: [1, 2], 2: [32, 18], 8: [32, 34], 12: [256, 144], 14: [256, 210], 30: [1, 2] };

export function tensorDataBytes(shape, type) {
  const [block, bytes] = TYPE_SIZE[type] ?? [1, 1];
  const n = shape.reduce((a, b) => a * b, 1);
  return Math.ceil(n / block) * bytes;
}

/** Deterministic pseudo-random bytes (xorshift32) so served files have stable sha256. */
export function seededBytes(seed, length) {
  const out = new Uint8Array(length);
  let x = (seed >>> 0) || 0x9e3779b9;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

/**
 * Builds a GGUF file: header, KV metadata, tensor infos, aligned tensor data. `totalSize` pads
 * the file with seeded bytes (to emulate a big file); tensor data itself is seeded too.
 */
export function buildGguf({ metadata = {}, tensors = [], version = 3, alignment = 32, totalSize, seed = 1 } = {}) {
  const w = new Writer(version);
  w.push(Buffer.from('GGUF', 'latin1'));
  w.num(4, version);
  w.size(tensors.length);
  const entries = Object.entries(metadata);
  w.size(entries.length);
  for (const [k, raw] of entries) {
    const v = inferValue(raw);
    w.str(k);
    w.num(4, v.type);
    w.value(v.type, v.value, v.sub);
  }
  let offset = 0;
  const layout = tensors.map((t) => {
    const at = offset;
    const bytes = tensorDataBytes(t.shape, t.type ?? 0);
    offset += Math.ceil(bytes / alignment) * alignment;
    return { ...t, at, bytes };
  });
  for (const t of layout) {
    w.str(t.name);
    w.num(4, t.shape.length);
    for (const d of t.shape) w.num(10, d);
    w.num(4, t.type ?? 0);
    w.num(10, t.at);
  }
  const headerLen = Math.ceil(w.length / alignment) * alignment;
  const dataLen = offset;
  const size = Math.max(totalSize ?? 0, headerLen + dataLen);
  const out = Buffer.from(seededBytes(seed, size));
  Buffer.concat(w.parts).copy(out, 0);
  out.fill(0, w.length, headerLen);
  return new Uint8Array(out.buffer, out.byteOffset, out.length);
}

const ST_DTYPE_BYTES = { F64: 8, F32: 4, F16: 2, BF16: 2, I64: 8, I32: 4, I16: 2, I8: 1, U8: 1, BOOL: 1, F8_E4M3: 1, F8_E5M2: 1 };

/** Builds a safetensors file: u64 LE header length, JSON header, tensor data (seeded). */
export function buildSafetensors({ tensors = {}, metadata, totalSize, seed = 1 } = {}) {
  const header = {};
  if (metadata) header.__metadata__ = metadata;
  let offset = 0;
  for (const [name, t] of Object.entries(tensors)) {
    const n = t.shape.reduce((a, b) => a * b, 1) * (ST_DTYPE_BYTES[t.dtype] ?? 1);
    header[name] = { dtype: t.dtype, shape: t.shape, data_offsets: [offset, offset + n] };
    offset += n;
  }
  let json = JSON.stringify(header);
  json += ' '.repeat((8 - (json.length % 8)) % 8);
  const jsonBuf = Buffer.from(json, 'utf8');
  const size = Math.max(totalSize ?? 0, 8 + jsonBuf.length + offset);
  const out = Buffer.from(seededBytes(seed, size));
  out.writeBigUInt64LE(BigInt(jsonBuf.length), 0);
  jsonBuf.copy(out, 8);
  return new Uint8Array(out.buffer, out.byteOffset, out.length);
}

/**
 * Builds a .ninfer file as NInfer's container lays it out: "NINFER", the container version (00 03), the
 * manifest's length (u64 LE at byte 8), 16 bytes of checksum, the JSON manifest from byte 32 (padded
 * with spaces, as NInfer's converter does), then the weights (seeded). `layouts`: one tensor object per
 * layout (a GGUF-NInfer artifact: "gguf_blocks_v1" among them).
 */
export function buildNinfer({ name = 'qwen3.8-27b', components = ['text', 'mtp'], layouts = ['contiguous_le_v1', 'row_split_k128_v1'], version = 3, totalSize, seed = 1, proposal } = {}) {
  // As the real ones: NInfer's own artifacts store the optimized proposal head, GGUF-NInfer ones do not.
  const head = proposal ?? !layouts.includes('gguf_blocks_v1');
  const manifest = {
    components: Object.fromEntries(components.map((c) => [c, { config: {}, ...(c === 'text' && head ? { proposal: { head: 'proposal/head', token_ids: 'proposal/token_ids' } } : {}) }])),
    objects: [
      { id: 'resource/text/tokenizer.json', encoding: 'raw_bytes_v1', offset: 0, bytes: 16, kind: 'resource' },
      ...layouts.map((layout, i) => ({ id: `weight/${String(i).padStart(6, '0')}`, shape: [16, 16], format: layout === 'gguf_blocks_v1' ? 'gguf_q6_k' : 'bf16', layout, offset: 16 + i * 64, bytes: 64, kind: 'tensor' })),
    ],
    bindings: {},
    metadata: { name },
  };
  const json = Buffer.from(`${JSON.stringify(manifest)}${' '.repeat(64)}`, 'utf8');
  const size = Math.max(totalSize ?? 0, 32 + json.length + 16 + layouts.length * 64);
  const out = Buffer.from(seededBytes(seed, size));
  out.write('NINFER', 0, 'latin1');
  out.writeUInt16BE(version, 6);
  out.writeBigUInt64LE(BigInt(json.length), 8);
  json.copy(out, 32);
  return new Uint8Array(out.buffer, out.byteOffset, out.length);
}

/**
 * Metadata + tensors of a small decoder-only model that look like a real llama.cpp conversion.
 * `layers`, `kvHeads`… shape the KV facts; tensors are tiny so files stay a few KB.
 */
export function llamaLikeGguf({
  arch = 'qwen3',
  name = 'Demo 0.6B',
  sizeLabel = '0.6B',
  fileType = 15,
  layers = 4,
  heads = 16,
  kvHeads = 8,
  headDim = 128,
  embd = 64,
  ctx = 40960,
  vocab = 32,
  extra = {},
  tied = false,
} = {}) {
  const metadata = {
    'general.architecture': arch,
    'general.name': name,
    'general.size_label': sizeLabel,
    'general.file_type': fileType,
    'general.quantization_version': 2,
    [`${arch}.block_count`]: layers,
    [`${arch}.context_length`]: ctx,
    [`${arch}.embedding_length`]: embd,
    [`${arch}.feed_forward_length`]: embd * 3,
    [`${arch}.attention.head_count`]: heads,
    [`${arch}.attention.head_count_kv`]: kvHeads,
    [`${arch}.attention.key_length`]: headDim,
    [`${arch}.attention.value_length`]: headDim,
    'tokenizer.ggml.model': 'gpt2',
    'tokenizer.ggml.tokens': Array.from({ length: vocab }, (_, i) => `t${i}`),
    ...extra,
  };
  const tensors = [{ name: 'token_embd.weight', shape: [embd, vocab], type: 8 }];
  if (!tied) tensors.push({ name: 'output.weight', shape: [embd, vocab], type: 8 });
  tensors.push({ name: 'output_norm.weight', shape: [embd], type: 0 });
  for (let i = 0; i < layers; i++) {
    tensors.push({ name: `blk.${i}.attn_q.weight`, shape: [embd, embd], type: 8 });
    tensors.push({ name: `blk.${i}.ffn_up.weight`, shape: [embd, embd * 3], type: 8 });
  }
  return { metadata, tensors };
}
