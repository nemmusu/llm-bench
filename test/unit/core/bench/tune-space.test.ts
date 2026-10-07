import { describe, expect, it } from 'vitest';
import { launchParamsSchema } from '../../../../src/contract/engines';
import type { LocalModel } from '../../../../src/contract/models';
import { capsFromOutputs, currentLlamaCaps } from '../../../../src/core/engines/llamacpp-native/caps';
import { isQuantizedKv, llamaFlashAttention, llamaKvArgs, llamaKvType, vllmKvDtype } from '../../../../src/core/engines/shared/kv-flags';
import { vllmServeArgs } from '../../../../src/core/engines/shared/vllm-args';
import { keptParams, llamaSpace, speculativeArgs, vllmSpace } from '../../../../src/core/bench/tune-space';
import { readFileSync } from 'node:fs';

const P = (o: object = {}) => launchParamsSchema.parse(o);
const HELP = readFileSync(new URL('../../../fixtures/llamacpp/help.stdout.txt', import.meta.url), 'utf8');

describe('KV cache and flash-attention flags', () => {
  it('K = V always; fp8 is q8_0 for llama.cpp; a quantized cache forces flash attention on', () => {
    expect(llamaKvArgs(P({ kvCacheType: 'q4_0' }))).toEqual(['-ctk', 'q4_0', '-ctv', 'q4_0']);
    expect(llamaKvArgs(P({ kvCacheType: 'fp8' }))).toEqual(['-ctk', 'q8_0', '-ctv', 'q8_0']);
    expect(llamaKvArgs(P({ kvCacheType: 'auto' }))).toEqual([]);
    expect(llamaKvArgs(P())).toEqual([]);
    expect(llamaKvType(P({ kvCacheType: 'f16' }))).toBe('f16');
    expect(isQuantizedKv('f16')).toBe(false);
    expect(isQuantizedKv(undefined)).toBe(false);
    expect(llamaFlashAttention(P({ kvCacheType: 'q8_0', flashAttention: 'off' }))).toBe('on');
    expect(llamaFlashAttention(P({ kvCacheType: 'f16', flashAttention: 'off' }))).toBe('off');
    expect(llamaFlashAttention(P())).toBe('auto');
  });

  it('vLLM: fp8 for any 8/4-bit request, auto when asked, else nothing; batch = chunked-prefill size', () => {
    expect(['fp8', 'q8_0', 'q4_0', 'auto', 'f16', undefined].map((k) => vllmKvDtype({ kvCacheType: k as 'fp8', extraArgs: [] }))).toEqual(['fp8', 'fp8', 'fp8', 'auto', undefined, undefined]);
    const args = vllmServeArgs(P({ kvCacheType: 'fp8', batchSize: 8192, parallel: 1, maxModelLen: 32768 }), { model: 'a/b', positional: true, host: 'h', port: 1, servedName: 's' });
    expect(args).toEqual(expect.arrayContaining(['--kv-cache-dtype', 'fp8', '--max-num-batched-tokens', '8192', '--max-num-seqs', '1', '--max-model-len', '32768']));
  });
});

describe('search spaces', () => {
  const user = P({ contextSize: 999, kvCacheType: 'f16', threads: 8, gpuLayers: 3, extraArgs: ['--metrics'], env: { A: '1' } });

  it('keeps the user’s own choices that the search does not set', () => {
    expect(keptParams(user)).toEqual({ threads: 8, extraArgs: ['--metrics'], env: { A: '1' } });
  });

  it('llama.cpp fast: kv ladder, FA off only with f16, ub 512 vs 2048, -np 1, every layer on the GPU', () => {
    const s = llamaSpace({ budget: 'fast', params: user });
    expect(s.kvLadder).toEqual(['f16', 'q8_0', 'q4_0']);
    expect(s.base('q4_0')).toEqual({ kv: 'q4_0', fa: 'on', ub: 512, b: 2048 });
    expect(s.dimensions.map((d) => [d.key, d.values(s.base('f16')), d.values(s.base('q8_0'))])).toEqual([
      ['fa', ['on', 'off'], ['on']],
      ['ub', [512, 2048], [512, 2048]],
    ]);
    expect(s.params(s.base('q8_0'), 32768)).toEqual({
      threads: 8,
      env: { A: '1' },
      contextSize: 32768,
      kvCacheType: 'q8_0',
      flashAttention: 'on',
      ubatchSize: 512,
      batchSize: 2048,
      parallel: 1,
      extraArgs: ['--metrics'],
    });
    expect(s.tags(s.base('f16'))).toEqual([]);
    // Last resorts: experts or layers on the CPU, tagged.
    const moe = { ...s.base('q4_0'), ncmoe: 12 };
    expect(s.params(moe, 4096).extraArgs).toEqual(['--metrics', '--n-cpu-moe', '12']);
    expect(s.params({ ...s.base('q4_0'), ngl: 20 }, 4096).gpuLayers).toBe(20);
    expect(s.tags(moe)).toEqual(['cpu-offload']);
  });

  it('llama.cpp thorough: more ubatch values, batch ≥ ubatch, and speculative decoding when available', () => {
    const s = llamaSpace({ budget: 'thorough', params: P(), draftArgs: ['-md', 'draft.gguf'] });
    expect(s.base('f16')).toEqual({ kv: 'f16', fa: 'on', ub: 512, b: 2048, draft: false });
    const dims = Object.fromEntries(s.dimensions.map((d) => [d.key, d]));
    expect(dims.ub!.values(s.base('f16'))).toEqual([512, 256, 1024, 2048]);
    expect(dims.b!.values({ ...s.base('f16'), ub: 512 })).toEqual([2048, 4096]);
    expect(dims.b!.values({ ...s.base('f16'), ub: 4096 })).toEqual([4096]);
    expect(dims.draft!.values(s.base('f16'))).toEqual([false, true]);
    const spec = { ...s.base('f16'), draft: true };
    expect(s.params(spec, 8192).extraArgs).toEqual(['-md', 'draft.gguf']);
    expect(s.tags(spec)).toEqual(['draft']);
  });

  it('vLLM: auto / fp8, batched tokens, one sequence, the fitted memory share, eager as a last resort', () => {
    const s = vllmSpace({ budget: 'thorough', params: P({ dtype: 'bfloat16' }), gpuMemoryUtilization: 0.93 });
    expect(s.kvLadder).toEqual(['auto', 'fp8']);
    expect(s.dimensions.map((d) => [d.key, d.values(s.base('auto'))])).toEqual([['bt', [2048, 8192, 16384]]]);
    expect(s.params(s.base('fp8'), 40960)).toEqual({ dtype: 'bfloat16', env: {}, maxModelLen: 40960, kvCacheType: 'fp8', batchSize: 2048, parallel: 1, gpuMemoryUtilization: 0.93, extraArgs: [] });
    const eager = { ...s.base('fp8'), eager: true };
    expect(s.params(eager, 4096).extraArgs).toEqual(['--enforce-eager']);
    expect(s.tags(eager)).toEqual(['eager']);
    expect(vllmSpace({ budget: 'fast', params: P() }).params({ kv: 'auto', bt: 2048 }, 4096)).not.toHaveProperty('gpuMemoryUtilization');
    expect(vllmSpace({ budget: 'fast', params: P() }).dimensions[0]!.values({ kv: 'auto' })).toEqual([2048, 8192]);
  });
});

describe('speculative decoding arguments', () => {
  const model = (kind: 'mtp' | 'draft' | 'mmproj', file = 'm-draft.gguf'): Pick<LocalModel, 'auxiliary'> => ({ auxiliary: [{ kind, path: `C:/m/${file}` }] });
  const caps = capsFromOutputs('', HELP);

  it('a draft model, an EAGLE head or an MTP file the build can use', () => {
    expect(speculativeArgs(model('draft'), caps)).toEqual(['--spec-type', 'draft-simple', '-md', 'C:/m/m-draft.gguf', '-ngld', 'all']);
    expect(speculativeArgs(model('draft', 'm-eagle3.gguf'), caps)).toEqual(['--spec-type', 'draft-eagle3', '-md', 'C:/m/m-eagle3.gguf', '-ngld', 'all']);
    expect(speculativeArgs(model('mtp', 'm-mtp.gguf'), caps)).toEqual(['--spec-type', 'draft-mtp', '-md', 'C:/m/m-mtp.gguf', '-ngld', 'all']);
  });

  it('nothing without a file, without the flags, or with a type the build does not know', () => {
    expect(speculativeArgs(undefined, caps)).toBeUndefined();
    expect(speculativeArgs(model('mmproj'), caps)).toBeUndefined();
    expect(speculativeArgs(model('draft'), currentLlamaCaps())).toBeUndefined();
    // An older build: -md without --spec-type (plain draft models only), -ngld with a number.
    const old = { flags: new Set(['--model-draft', '--gpu-layers-draft']), entries: [], nglKeywords: [] };
    expect(speculativeArgs(model('draft'), old)).toEqual(['-md', 'C:/m/m-draft.gguf', '-ngld', '999']);
    expect(speculativeArgs(model('mtp', 'm-mtp.gguf'), old)).toBeUndefined();
    expect(speculativeArgs(model('draft'), { flags: new Set(['--model-draft']), entries: [], nglKeywords: [] })).toEqual(['-md', 'C:/m/m-draft.gguf']);
    const noTypes = { flags: new Set(['--model-draft', '--spec-type']), entries: [{ names: ['--spec-type'], desc: 'x' }], nglKeywords: [] };
    expect(speculativeArgs(model('mtp', 'm-mtp.gguf'), noTypes)).toBeUndefined();
  });
});
