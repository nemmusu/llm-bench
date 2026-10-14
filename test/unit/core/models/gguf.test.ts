import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { AppError } from '../../../../src/contract/errors';
import {
  errorMessage,
  factsFromGguf,
  groupLayers,
  localRangeFetch,
  parseGgufHeader,
  readLocalGgufFacts,
  tensorBytes,
} from '../../../../src/core/models/gguf';
import { gv, llamaLikeGguf, writeGguf } from '../../../fixtures/gguf/writer';
import { tempDir } from './helpers';
import { buildGguf as buildFakeGguf, llamaLikeGguf as fakeLlamaGguf } from '../../../fakes/fake-hub/model-files.mjs';

describe('factsFromGguf (pure)', () => {
  it('maps a plain GQA transformer', () => {
    const md = llamaLikeGguf({ arch: 'llama', layers: 32, heads: 32, kvHeads: 8, headDim: 128, embd: 4096, ctx: 131072, vocab: 4 }).metadata;
    const f = factsFromGguf(md, { parameterCount: 8.03e9, fileBytes: 4.92e9, fileName: 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf' });
    expect(f).toMatchObject({
      architecture: 'llama',
      name: 'Demo 0.6B',
      paramsB: 8.03,
      quant: 'Q4_K_M',
      bitsPerWeight: 4.9,
      contextLength: 131072,
      blockCount: 32,
      headCount: 32,
      headCountKv: 8,
      keyLength: 128,
      valueLength: 128,
      embeddingLength: 4096,
      fullAttentionLayers: 32,
      vocabSize: 4,
      feedForwardLength: 4096 * 3,
    });
    expect(f.kv).toEqual({ groups: [{ layers: 32, kvHeads: 8, keyLength: 128, valueLength: 128 }], recurrentLayers: 0, recurrentBytesPerSeq: 0 });
    expect(f.slidingWindow).toBeUndefined();
    // No chat template: whether it thinks is not known.
    expect(f).not.toHaveProperty('reasoning');
  });

  it('its chat template says whether it thinks', () => {
    const md = llamaLikeGguf({ arch: 'qwen3' }).metadata;
    expect(factsFromGguf({ ...md, 'tokenizer.chat_template': '{%- if enable_thinking is defined %}<think>' }).reasoning).toBe(true);
    expect(factsFromGguf({ ...md, 'tokenizer.chat_template': '<|start|>assistant<|channel|>analysis<|message|>' }).reasoning).toBe(true);
    expect(factsFromGguf({ ...md, 'tokenizer.chat_template': '{{ messages[0].content }}' }).reasoning).toBe(false);
  });

  it('handles per-layer KV heads and SWA head sizes (Gemma 4)', () => {
    const pattern = Array.from({ length: 12 }, (_, i) => i % 6 !== 5);
    const md = {
      'general.architecture': 'gemma4',
      'gemma4.block_count': 12,
      'gemma4.embedding_length': 5376,
      'gemma4.attention.head_count': 32,
      'gemma4.attention.head_count_kv': pattern.map((swa) => (swa ? 16 : 4)),
      'gemma4.attention.key_length': 512,
      'gemma4.attention.value_length': 512,
      'gemma4.attention.key_length_swa': 256,
      'gemma4.attention.value_length_swa': 256,
      'gemma4.attention.sliding_window': 1024,
      'gemma4.attention.sliding_window_pattern': pattern,
      'general.file_type': 15,
    };
    const f = factsFromGguf(md);
    expect(f.kv?.groups).toEqual([
      { layers: 10, kvHeads: 16, keyLength: 256, valueLength: 256, window: 1024 },
      { layers: 2, kvHeads: 4, keyLength: 512, valueLength: 512 },
    ]);
    expect(f).toMatchObject({ slidingWindow: 1024, slidingWindowLayers: 10, fullAttentionLayers: 2, headCountKv: 16, keyLength: 512, quant: 'Q4_K_M' });
  });

  it('uses llama.cpp hard-coded SWA patterns and numeric patterns', () => {
    const base = (arch: string, extra: Record<string, unknown>) => ({
      'general.architecture': arch,
      [`${arch}.block_count`]: 12,
      [`${arch}.attention.head_count`]: 8,
      [`${arch}.attention.head_count_kv`]: 4,
      [`${arch}.attention.sliding_window`]: 512,
      ...extra,
    });
    expect(factsFromGguf(base('gemma3', {})).slidingWindowLayers).toBe(10);
    expect(factsFromGguf(base('gemma2', {})).slidingWindowLayers).toBe(6);
    expect(factsFromGguf(base('mystery', { 'mystery.attention.sliding_window_pattern': 4 })).slidingWindowLayers).toBe(9);
    expect(factsFromGguf(base('mystery', { 'mystery.attention.sliding_window_pattern': 0 })).slidingWindowLayers).toBe(12);
    // Unknown pattern: counted as full attention (never underestimates the KV).
    const unknown = factsFromGguf(base('mystery', {}));
    expect(unknown.slidingWindowLayers).toBeUndefined();
    expect(unknown.fullAttentionLayers).toBe(12);
    // head_dim from embedding / heads when key_length is missing.
    expect(factsFromGguf({ ...base('mystery', {}), 'mystery.embedding_length': 1024 }).keyLength).toBe(128);
  });

  it('handles hybrid recurrent stacks (Qwen3.5 interval / explicit array) and skips NextN layers', () => {
    const md = {
      'general.architecture': 'qwen35',
      'qwen35.block_count': 65,
      'qwen35.nextn_predict_layers': 1,
      'qwen35.attention.head_count': 24,
      'qwen35.attention.head_count_kv': 4,
      'qwen35.attention.key_length': 256,
      'qwen35.attention.value_length': 256,
      'qwen35.full_attention_interval': 4,
      'qwen35.ssm.conv_kernel': 4,
      'qwen35.ssm.state_size': 128,
      'qwen35.ssm.group_count': 16,
      'qwen35.ssm.inner_size': 6144,
    };
    const f = factsFromGguf(md);
    expect(f.fullAttentionLayers).toBe(16);
    expect(f.kv?.recurrentLayers).toBe(48);
    const perLayer = 4 * (3 * (6144 + 2 * 16 * 128) + 128 * 6144);
    expect(f.kv?.recurrentBytesPerSeq).toBe(48 * perLayer);
    expect(f.blockCount).toBe(65);

    const arr = Array.from({ length: 8 }, (_, i) => (i + 1) % 4 !== 0);
    const g = factsFromGguf({ ...md, 'qwen35.block_count': 8, 'qwen35.nextn_predict_layers': 0, 'qwen35.attention.recurrent_layers': arr });
    expect(g.fullAttentionLayers).toBe(2);
    expect(g.kv?.recurrentLayers).toBe(6);

    // MTP draft files (gemma4-assistant): every block is a NextN block, so all of them count.
    const mtp = factsFromGguf({ 'general.architecture': 'a', 'a.block_count': 4, 'a.nextn_predict_layers': 4, 'a.attention.head_count_kv': 2 });
    expect(mtp.fullAttentionLayers).toBe(4);
  });

  it('handles SSM markers by zero KV heads (Jamba-style), parallel hybrids and pure SSM', () => {
    const jamba = factsFromGguf({
      'general.architecture': 'jamba',
      'jamba.block_count': 4,
      'jamba.attention.head_count': 8,
      'jamba.attention.head_count_kv': [0, 0, 8, 0, 0],
      'jamba.ssm.state_size': 16,
      'jamba.ssm.inner_size': 64,
    });
    expect(jamba.fullAttentionLayers).toBe(1);
    expect(jamba.kv?.recurrentLayers).toBe(3);
    // No conv kernel / groups: llama.cpp's Mamba-1 sizes.
    expect(jamba.kv?.recurrentBytesPerSeq).toBe(3 * 4 * (16 * 64));

    const falcon = factsFromGguf({
      'general.architecture': 'falcon-h1',
      'falcon-h1.block_count': 3,
      'falcon-h1.attention.head_count': 8,
      'falcon-h1.attention.head_count_kv': 2,
      'falcon-h1.ssm.state_size': 16,
      'falcon-h1.ssm.inner_size': 64,
      'falcon-h1.ssm.conv_kernel': 4,
    });
    expect(falcon.fullAttentionLayers).toBe(3);
    expect(falcon.kv?.recurrentLayers).toBe(3);

    const mamba = factsFromGguf({ 'general.architecture': 'mamba', 'mamba.block_count': 2, 'mamba.ssm.state_size': 16 });
    expect(mamba.kv?.groups).toEqual([]);
    expect(mamba.kv?.recurrentLayers).toBe(2);
    expect(mamba.kv?.recurrentBytesPerSeq).toBe(0);
    expect(mamba.headCountKv).toBeUndefined();

    // Layers with 0 KV heads and no SSM (DeciLM-style) have neither KV nor state.
    const deci = factsFromGguf({ 'general.architecture': 'deci', 'deci.block_count': 3, 'deci.attention.head_count_kv': [8, 0, 8] });
    expect(deci.fullAttentionLayers).toBe(2);
    expect(deci.kv?.recurrentLayers).toBe(0);
  });

  it('uses MLA latent sizes and array head counts', () => {
    const f = factsFromGguf({
      'general.architecture': 'deepseek2',
      'deepseek2.block_count': 2,
      'deepseek2.attention.head_count': [128, 128],
      'deepseek2.attention.head_count_kv': 1,
      'deepseek2.attention.key_length_mla': 576,
      'deepseek2.attention.value_length_mla': 512,
      'deepseek2.attention.key_length': 192,
      'deepseek2.expert_count': 256,
      'deepseek2.expert_used_count': 8,
      'deepseek2.vocab_size': 129280,
    });
    expect(f).toMatchObject({ headCount: 128, keyLength: 576, valueLength: 512, expertCount: 256, expertUsedCount: 8, vocabSize: 129280 });
    // Per-layer array shorter than the stack: missing entries mean no attention.
    const short = factsFromGguf({ 'general.architecture': 'x', 'x.block_count': 3, 'x.attention.head_count_kv': [4] });
    expect(short.fullAttentionLayers).toBe(1);
  });

  it('copes with sparse or odd metadata', () => {
    expect(factsFromGguf({})).toEqual({});
    const f = factsFromGguf({
      'general.architecture': 'x',
      'general.size_label': '7B',
      'general.file_type': 7,
      'x.block_count': 1n,
      'x.context_length': 2048n,
      'x.attention.head_count_kv': ['bad'],
      'x.attention.recurrent_layers': [1, 2],
    });
    expect(f).toMatchObject({ paramsB: 7, quant: 'Q8_0', blockCount: 1, contextLength: 2048 });
    // No head counts at all: the layer has no attention.
    expect(f.kv?.groups).toEqual([]);
    expect(factsFromGguf({ 'general.architecture': 'x', 'x.context_length': Number.NaN }).contextLength).toBeUndefined();
    expect(factsFromGguf({ 'general.architecture': '' })).toEqual({});
  });

  it('computes the CPU-resident embeddings share', () => {
    const f = factsFromGguf({}, { fileBytes: 1000, cpuOnlyBytes: 250 });
    expect(f.cpuOnlyFraction).toBe(0.25);
    expect(factsFromGguf({}, { fileBytes: 1000 }).cpuOnlyFraction).toBeUndefined();
  });

  it('groups layers by shape', () => {
    expect(
      groupLayers([
        { attn: true, recurrent: false, kvHeads: 2, k: 64, v: 64 },
        { attn: false, recurrent: true, kvHeads: 0, k: 64, v: 64 },
        { attn: true, recurrent: false, kvHeads: 2, k: 64, v: 64 },
        { attn: true, recurrent: false, kvHeads: 2, k: 64, v: 64, window: 8 },
      ]),
    ).toEqual([
      { layers: 2, kvHeads: 2, keyLength: 64, valueLength: 64 },
      { layers: 1, kvHeads: 2, keyLength: 64, valueLength: 64, window: 8 },
    ]);
  });

  it('sizes tensors by GGML type', () => {
    expect(tensorBytes([5376, 262144], 14)).toBe((5376 * 262144 * 210) / 256);
    expect(tensorBytes([10n, 3n], 0)).toBe(120);
    expect(tensorBytes([33], 8)).toBe(68);
    expect(tensorBytes([4], 999)).toBeUndefined();
    expect(errorMessage(new Error('x'))).toBe('x');
    expect(errorMessage('y')).toBe('y');
  });
});

describe('local GGUF files', () => {
  let t: ReturnType<typeof tempDir>;
  beforeEach(() => {
    t = tempDir('gb-gguf-');
  });
  afterEach(() => t.cleanup());

  it('reads metadata, parameter count, size and the token embedding through Range reads', async () => {
    const spec = llamaLikeGguf({ layers: 2, embd: 64, vocab: 32 });
    const file = writeGguf(path.join(t.dir, 'Demo-0.6B-Q8_0.gguf'), { ...spec, totalSize: 64 * 1024 });
    const h = await parseGgufHeader(`http://local.invalid/x`, localRangeFetch(file));
    expect(h.fileSize).toBe(64 * 1024);
    expect(h.tensorCount).toBe(spec.tensors.length);
    expect(h.hasOutputTensor).toBe(true);
    expect(h.tokenEmbdBytes).toBe((64 * 32 * 34) / 32);
    const facts = await readLocalGgufFacts([file]);
    expect(facts.quant).toBe('Q8_0');
    expect(facts.blockCount).toBe(2);
    expect(facts.cpuOnlyFraction).toBeCloseTo(2176 / 65536, 4);
    expect(facts.bitsPerWeight).toBeGreaterThan(0);
  });

  it("the fake world's demo GGUF: tensors that hold no parameters, its count read from its size label like a file whose tensors do not say", async () => {
    const file = path.join(t.dir, 'Qwen3-8B-Q4_K_M.gguf');
    const spec = fakeLlamaGguf({ name: 'Qwen3 8B', sizeLabel: '8B', sizeFromLabel: true });
    writeFileSync(file, buildFakeGguf({ ...spec, totalSize: 96 * 1024 }));
    const facts = await readLocalGgufFacts([file]);
    expect(facts).toMatchObject({ paramsB: 8, quant: 'Q4_K_M', blockCount: 4 });
    // Its size on disk says nothing about bits per weight: the quantization's own figure is used.
    expect(facts.bitsPerWeight).toBeUndefined();
    expect(spec.tensors).toHaveLength(fakeLlamaGguf().tensors.length);
  });

  it('sums parameters and bytes over split shards; tied embeddings stay on the GPU', async () => {
    const spec = llamaLikeGguf({ layers: 1, tied: true });
    const a = writeGguf(path.join(t.dir, 'm-00001-of-00002.gguf'), { ...spec, totalSize: 2048 });
    const b = writeGguf(path.join(t.dir, 'm-00002-of-00002.gguf'), { metadata: { 'split.count': 2 }, tensors: [{ name: 'blk.1.x', shape: [10], type: 0 }], totalSize: 1024 });
    const one = await readLocalGgufFacts([a]);
    const both = await readLocalGgufFacts([a, b]);
    // Tiny fixtures round to 0 B parameters; bits per weight still shows both shards were read.
    expect(both.bitsPerWeight).not.toBe(one.bitsPerWeight);
    expect(both.cpuOnlyFraction).toBeUndefined();
  });

  it('reads GGUF v2 files', async () => {
    const file = writeGguf(path.join(t.dir, 'v2.gguf'), { version: 2, metadata: { 'general.architecture': 'llama', 'llama.block_count': gv.u32(3) } });
    expect((await readLocalGgufFacts([file])).blockCount).toBe(3);
  });

  it('rejects non-GGUF and truncated files as MODEL_INVALID, and an empty list as MODEL_NOT_FOUND', async () => {
    const junk = path.join(t.dir, 'junk.gguf');
    writeFileSync(junk, 'definitely not gguf');
    await expect(readLocalGgufFacts([junk])).rejects.toMatchObject({ code: 'MODEL_INVALID' });
    const badVersion = path.join(t.dir, 'v9.gguf');
    writeFileSync(badVersion, Buffer.from('GGUF\x09\x00\x00\x00', 'latin1'));
    await expect(readLocalGgufFacts([badVersion])).rejects.toBeInstanceOf(AppError);
    // A header cut right after the version reads as an empty model (the parser zero-pads).
    const truncated = path.join(t.dir, 'trunc.gguf');
    writeFileSync(truncated, Buffer.from('GGUF\x03\x00\x00\x00', 'latin1'));
    expect(await readLocalGgufFacts([truncated])).toEqual({});
    await expect(readLocalGgufFacts([])).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' });
  });

  it('keeps AppErrors thrown by the fetch and needs explicit ranges', async () => {
    const failing = (() => Promise.reject(new AppError('HF_GATED', 'gated'))) as typeof fetch;
    await expect(parseGgufHeader('http://x.invalid/f.gguf', failing)).rejects.toMatchObject({ code: 'HF_GATED' });
    const file = writeGguf(path.join(t.dir, 'a.gguf'), llamaLikeGguf());
    await expect(localRangeFetch(file)('http://x')).rejects.toThrow(/byte range/);
    // Reads past the end return an empty 206.
    const res = await localRangeFetch(file)('http://x', { headers: { range: 'bytes=999999-1000000' } });
    expect(res.status).toBe(206);
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  it('reports a missing Content-Range as unknown size', async () => {
    const file = writeGguf(path.join(t.dir, 'b.gguf'), llamaLikeGguf());
    const inner = localRangeFetch(file);
    const stripped = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const res = await inner(input, init);
      return new Response(await res.arrayBuffer(), { status: 206 });
    }) as typeof fetch;
    const h = await parseGgufHeader('http://x.invalid/b.gguf', stripped);
    expect(h.fileSize).toBeUndefined();
    expect(h.tokenEmbdBytes).toBeGreaterThan(0);
  });

  it('reports no token embedding when the tensor is absent or of unknown type', async () => {
    const file = writeGguf(path.join(t.dir, 'c.gguf'), { metadata: { 'general.architecture': 'llama' }, tensors: [{ name: 'token_embd.weight', shape: [4, 4], type: 99 }] });
    const h = await parseGgufHeader('http://x.invalid/c.gguf', localRangeFetch(file));
    expect(h.tokenEmbdBytes).toBeUndefined();
    expect(h.hasOutputTensor).toBe(false);
    const none = writeGguf(path.join(t.dir, 'd.gguf'), { metadata: {} });
    expect((await parseGgufHeader('http://x.invalid/d.gguf', localRangeFetch(none))).tokenEmbdBytes).toBeUndefined();
  });
});
