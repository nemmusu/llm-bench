import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { launchParamsSchema, type EngineKind, type LaunchParams } from '../../../../src/contract/engines';
import { VRAM_RESERVE_MIB, type HubFile } from '../../../../src/contract/models';
import {
  availableNowMiB,
  bestQuant,
  CUDA_CONTEXT_MIB,
  DEFAULT_FIT_CONTEXT,
  estimateFit,
  FIT_NOTES,
  FIX_CONTEXT_STEP,
  fitFixes,
  fitParamsFrom,
  fitsFully,
  fitsNow,
  flagValue,
  kvLayoutOf,
  levelFor,
  levelRank,
  llamaComputeBytes,
  llamaKvBytes,
  levelNowOf,
  pickBest,
  quantChoices,
  usableMiB,
  vllmActivationMiB,
  vllmKvBytesPerSeq,
  VLLM_NON_TORCH_MIB,
} from '../../../../src/core/models/fit';
import type { KvLayout, ModelFactsEx } from '../../../../src/core/models/types';

const MIB = 1024 * 1024;
const GPU = { totalMiB: 32607, freeMiB: 30900 };

/** Llama-3.1-8B-like facts. */
const llama8b: ModelFactsEx = {
  architecture: 'llama',
  paramsB: 8.03,
  quant: 'Q4_K_M',
  contextLength: 131072,
  blockCount: 32,
  headCount: 32,
  headCountKv: 8,
  keyLength: 128,
  valueLength: 128,
  embeddingLength: 4096,
  vocabSize: 128256,
  feedForwardLength: 14336,
  kv: { groups: [{ layers: 32, kvHeads: 8, keyLength: 128, valueLength: 128 }], recurrentLayers: 0, recurrentBytesPerSeq: 0 },
};

describe('KV and compute building blocks', () => {
  const layout: KvLayout = {
    groups: [
      { layers: 10, kvHeads: 16, keyLength: 256, valueLength: 256, window: 1024 },
      { layers: 2, kvHeads: 4, keyLength: 512, valueLength: 512 },
    ],
    recurrentLayers: 3,
    recurrentBytesPerSeq: 1000,
  };

  it('llama.cpp: pads to 256, caps SWA at window + ubatch, scales with slots unless unified', () => {
    const full = 2 * 4 * 1024 * 2;
    const swaPerCell = 10 * 16 * 512 * 2;
    expect(llamaKvBytes(layout, 8000, 512, 1, false, 2)).toBe(2 * 4 * 1024 * 8192 * 2 + swaPerCell * 1536 + 1000);
    expect(llamaKvBytes(layout, 8192, 512, 4, false, 2)).toBe(full * 8192 * 4 + swaPerCell * 4 * 1536 + 4000);
    expect(llamaKvBytes(layout, 8192, 512, 4, true, 2)).toBe(full * 8192 + swaPerCell * Math.min(8192, 4096 + 512) + 4000);
    // Short contexts: the SWA cache is never larger than the context.
    expect(llamaKvBytes(layout, 256, 512, 1, false, 2)).toBe(full * 256 + swaPerCell * 256 + 1000);
  });

  it('vLLM: per sequence, SWA capped at the window', () => {
    expect(vllmKvBytesPerSeq(layout, 4096, 1)).toBe(2 * 4 * 1024 * 4096 + 10 * 16 * 512 * 1024 + 1000);
  });

  it('compute buffer grows with ubatch and ctx, more without flash attention', () => {
    const a = llamaComputeBytes(llama8b, 8192, 512, 'auto');
    expect(a).toBe(128256 * 512 * 4 + 512 * (4 * 4096 + 3 * 14336) * 4 + 8192 * 512 * 4);
    expect(llamaComputeBytes(llama8b, 16384, 512, 'on')).toBeGreaterThan(a);
    expect(llamaComputeBytes(llama8b, 8192, 1024, 'on')).toBeGreaterThan(a);
    expect(llamaComputeBytes(llama8b, 8192, 512, 'off')).toBe(a + 2 * 32 * 8192 * 512 * 4);
    expect(llamaComputeBytes({}, 1024, 512, undefined)).toBe(152064 * 512 * 4 + 512 * (4 * 4096 + 3 * 4 * 4096) * 4 + 1024 * 512 * 4);
  });

  it('vLLM activation peak by size', () => {
    expect(vllmActivationMiB(undefined)).toBe(2048);
    expect(vllmActivationMiB(0.6)).toBe(1024);
    expect(vllmActivationMiB(8)).toBe(1536);
    expect(vllmActivationMiB(32)).toBe(2048);
  });

  it('builds a layout from scalar facts when the exact one is missing', () => {
    expect(kvLayoutOf({}).assumed).toBe(true);
    expect(kvLayoutOf({}).layout.groups).toEqual([{ layers: 32, kvHeads: 8, keyLength: 128, valueLength: 128 }]);
    const swa = kvLayoutOf({ blockCount: 6, headCount: 8, embeddingLength: 2048, slidingWindow: 512, slidingWindowLayers: 4, fullAttentionLayers: 2 });
    expect(swa.assumed).toBe(false);
    expect(swa.layout.groups).toEqual([
      { layers: 2, kvHeads: 8, keyLength: 256, valueLength: 256 },
      { layers: 4, kvHeads: 8, keyLength: 256, valueLength: 256, window: 512 },
    ]);
    // slidingWindowLayers without a window, or more than the stack: clamped.
    expect(kvLayoutOf({ blockCount: 4, slidingWindowLayers: 2 }).layout.groups[0]?.layers).toBe(4);
    expect(kvLayoutOf({ blockCount: 4, slidingWindow: 8, slidingWindowLayers: 9, headCountKv: 2, keyLength: 64 }).layout.groups).toEqual([{ layers: 4, kvHeads: 2, keyLength: 64, valueLength: 64, window: 8 }]);
    expect(kvLayoutOf({ blockCount: 4, slidingWindow: 8 }).layout.groups).toHaveLength(1);
  });

  it('levels and ranks', () => {
    expect(levelFor(0.6, true)).toBe('perfect');
    expect(levelFor(0.85, true)).toBe('good');
    expect(levelFor(0.98, true)).toBe('tight');
    expect(levelFor(0.99, true)).toBeUndefined();
    expect(levelFor(0.99, false)).toBe('no');
    expect(levelRank('perfect')).toBeLessThan(levelRank('no'));
  });

  it('maps launch params', () => {
    expect(fitParamsFrom(undefined)).toEqual({});
    expect(fitParamsFrom({ extraArgs: [], env: {} })).toEqual({});
    expect(
      fitParamsFrom({ contextSize: 1, kvCacheType: 'q8_0', ubatchSize: 2, parallel: 3, flashAttention: 'on', gpuMemoryUtilization: 0.5, maxModelLen: 4, extraArgs: [], env: {} }),
    ).toEqual({ contextSize: 1, kvCacheType: 'q8_0', ubatchSize: 2, parallel: 3, kvUnified: true, flashAttention: 'on', gpuMemoryUtilization: 0.5, maxModelLen: 4 });
    // llama.cpp -c is the whole context: one pool shared by the slots (GPU Bench's --kv-unified), or split by them.
    expect(fitParamsFrom({ contextSize: 32768, parallel: 4, extraArgs: ['--no-kv-unified'], env: {} })).toEqual({ contextSize: 8192, parallel: 4, kvUnified: false });
    expect(fitParamsFrom({ parallel: 4, extraArgs: ['-no-kvu'], env: {} })).toEqual({ parallel: 4, kvUnified: false });
    expect(fitParamsFrom({ contextSize: 32768, parallel: 1, extraArgs: ['--no-kv-unified'], env: {} })).toEqual({ contextSize: 32768, parallel: 1 });
  });

  it('several slots: the same KV cache whether the pool is shared or split (it was counted once per slot)', () => {
    const shared = estimateFit({ facts: llama8b, fileBytes: 4920739232, gpu: GPU, engine: 'llamacpp-native', params: fitParamsFrom({ contextSize: 32768, parallel: 4, extraArgs: [], env: {} }) });
    const split = estimateFit({ facts: llama8b, fileBytes: 4920739232, gpu: GPU, engine: 'llamacpp-native', params: fitParamsFrom({ contextSize: 32768, parallel: 4, extraArgs: ['--no-kv-unified'], env: {} }) });
    const one = estimateFit({ facts: llama8b, fileBytes: 4920739232, gpu: GPU, engine: 'llamacpp-native', params: fitParamsFrom({ contextSize: 32768, extraArgs: [], env: {} }) });
    expect(shared.kvMiB).toBe(one.kvMiB);
    expect(split.kvMiB).toBe(one.kvMiB);
  });
});

describe('estimateFit — llama.cpp', () => {
  it('uses the file size and sums weights + KV + overhead', () => {
    const fit = estimateFit({ facts: llama8b, fileBytes: 4920739232, gpu: GPU, engine: 'llamacpp-native' });
    expect(fit.basis).toBe('file-size');
    expect(fit.contextSize).toBe(DEFAULT_FIT_CONTEXT);
    expect(fit.weightsMiB).toBe(Math.round(4920739232 / MIB));
    expect(fit.kvMiB).toBe(1024);
    expect(fit.overheadMiB).toBe(CUDA_CONTEXT_MIB + Math.round(llamaComputeBytes(llama8b, 8192, 512, undefined) / MIB));
    expect(fit.needMiB).toBe(fit.weightsMiB + fit.kvMiB + fit.overheadMiB);
    // The verdict counts the card's total minus the fixed reserve; what is free now comes alongside.
    expect(fit.availableMiB).toBe(GPU.totalMiB - VRAM_RESERVE_MIB);
    expect(fit).toMatchObject({ level: 'perfect', levelNow: 'perfect', totalMiB: GPU.totalMiB, freeNowMiB: GPU.freeMiB, busyMiB: GPU.totalMiB - GPU.freeMiB });
    expect(fit.notes).toEqual([]);
  });

  it('subtracts CPU-resident embeddings, uses quantized KV, flags context beyond the model', () => {
    const fit = estimateFit({
      facts: { ...llama8b, contextLength: 4096, cpuOnlyFraction: 0.1 },
      fileBytes: 1000 * MIB,
      gpu: GPU,
      engine: 'llamacpp-docker',
      params: { contextSize: 8192, kvCacheType: 'q8_0' },
    });
    expect(fit.weightsMiB).toBe(900);
    expect(fit.kvMiB).toBe(Math.round((32 * 8 * 256 * 8192 * (34 / 32)) / MIB));
    expect(fit.notes).toEqual([FIT_NOTES.embeddingsOnCpu, FIT_NOTES.contextOverModel]);
    const q4 = estimateFit({ facts: llama8b, fileBytes: MIB, gpu: GPU, engine: 'llamacpp-native', params: { kvCacheType: 'q4_0' } });
    expect(q4.kvMiB).toBe(Math.round((32 * 8 * 256 * 8192 * (18 / 32)) / MIB));
    // A context extended with YaRN on purpose is not "beyond the model".
    const yarn = fitParamsFrom({ contextSize: 131_072, ropeScaling: { type: 'yarn', factor: 4, originalContext: 32_768 }, extraArgs: [], env: {} });
    expect(yarn.ropeScaling).toEqual({ factor: 4, originalContext: 32_768 });
    const facts32k = { ...llama8b, contextLength: 32_768 };
    expect(estimateFit({ facts: facts32k, fileBytes: MIB, gpu: GPU, engine: 'llamacpp-native', params: yarn }).notes).toEqual([FIT_NOTES.contextExtended]);
    expect(estimateFit({ facts: facts32k, fileBytes: MIB, gpu: GPU, engine: 'llamacpp-native', params: { ...yarn, contextSize: 262_144 } }).notes).toContain(FIT_NOTES.contextOverModel);
    // Default context is capped by the model's own maximum.
    expect(estimateFit({ facts: { ...llama8b, contextLength: 2048 }, fileBytes: MIB, gpu: GPU, engine: 'llamacpp-native' }).contextSize).toBe(2048);
  });

  it('falls back to params × bytes-per-param (llmfit) without a file size', () => {
    const fit = estimateFit({ facts: llama8b, gpu: GPU, engine: 'llamacpp-native' });
    expect(fit.basis).toBe('params-heuristic');
    expect(fit.weightsMiB).toBe(Math.round((8.03e9 * 0.58) / MIB));
    expect(fit.notes).toContain(FIT_NOTES.paramsHeuristic);
    const unknown = estimateFit({ facts: {}, fileBytes: 0, gpu: GPU, engine: 'external' });
    expect(unknown.notes).toEqual([FIT_NOTES.external, FIT_NOTES.paramsHeuristic, FIT_NOTES.paramsUnknown, FIT_NOTES.kvAssumed]);
    expect(unknown.weightsMiB).toBe(Math.round((7e9 * 0.58) / MIB));
  });

  it('notes sliding windows and recurrent state', () => {
    const fit = estimateFit({
      facts: { blockCount: 2, kv: { groups: [{ layers: 1, kvHeads: 1, keyLength: 1, valueLength: 1, window: 4 }], recurrentLayers: 1, recurrentBytesPerSeq: 10 } },
      fileBytes: MIB,
      gpu: GPU,
      engine: 'llamacpp-native',
    });
    expect(fit.notes).toEqual([FIT_NOTES.slidingWindow, FIT_NOTES.recurrent]);
  });

  it('levels by utilization of the total minus the reserve, whatever is free', () => {
    const at = (totalMiB: number) => estimateFit({ facts: llama8b, fileBytes: 4920739232, gpu: { totalMiB, freeMiB: 1000 }, engine: 'llamacpp-native' });
    const need = at(32607).needMiB;
    expect(at(Math.ceil(need / 0.6) + VRAM_RESERVE_MIB).level).toBe('perfect');
    expect(at(Math.ceil(need / 0.8) + VRAM_RESERVE_MIB).level).toBe('good');
    expect(at(Math.ceil(need / 0.95) + VRAM_RESERVE_MIB).level).toBe('tight');
    // With only 1000 MiB free right now, a launch now would not even get one layer on the card.
    expect(at(32607).levelNow).toBe('no');
  });

  it('a busy card keeps its verdict; levelNow, the partial offload and the fixes follow what is free now', () => {
    const busy = { totalMiB: 32607, freeMiB: 7000 };
    const fit = estimateFit({ facts: llama8b, fileBytes: 4920739232, gpu: busy, engine: 'llamacpp-native', params: { contextSize: 32768 } });
    expect(fit.level).toBe('perfect');
    expect(fit.levelNow).toBe('partial');
    expect(fit.busyMiB).toBe(32607 - 7000);
    expect(fit.maxGpuLayers).toBeGreaterThanOrEqual(1);
    expect(fit.maxGpuLayers).toBeLessThan(32);
    expect(fit.notes).toContain(FIT_NOTES.partialOffload);
    expect(levelNowOf(fit)).toBe('partial');
    expect(fitsNow(fit)).toBe(false);
    expect(fitsFully(fit)).toBe(true);
    expect(availableNowMiB(fit)).toBe(7000);
    const p = launchParamsSchema.parse({ contextSize: 32768 });
    const estimate = (q: LaunchParams) => estimateFit({ facts: llama8b, fileBytes: 4920739232, gpu: busy, engine: 'llamacpp-native', params: fitParamsFrom(q) });
    expect(fitFixes('llamacpp-native', p, fit, estimate)).toMatchObject({ maxContext: expect.any(Number) });
    // What GPU Bench's own engines hold is in use, but not "other programs".
    expect(estimateFit({ facts: llama8b, fileBytes: 1, gpu: { ...busy, ownMiB: 20000 }, engine: 'llamacpp-native' }).busyMiB).toBe(32607 - 7000 - 20000);
    // An idle headless card (everything free): a launch now still keeps the reserve.
    expect(availableNowMiB(estimateFit({ facts: llama8b, fileBytes: 1, gpu: { totalMiB: 32607, freeMiB: 32607 }, engine: 'llamacpp-native' }))).toBe(usableMiB({ totalMiB: 32607 }));
    // Without the free VRAM (older estimates), the verdict stands for both.
    expect(levelNowOf({ level: 'good' })).toBe('good');
    expect(availableNowMiB({ availableMiB: 777 })).toBe(777);
    expect(usableMiB({ totalMiB: 512 })).toBe(1);
  });

  it('partial offload: largest -ngl that fits, else no', () => {
    const fit = estimateFit({ facts: llama8b, fileBytes: 4920739232, gpu: { totalMiB: 5000, freeMiB: 4900 }, engine: 'llamacpp-native' });
    expect(fit.level).toBe('partial');
    expect(fit.levelNow).toBe('partial');
    expect(fit.maxGpuLayers).toBeGreaterThanOrEqual(1);
    expect(fit.maxGpuLayers).toBeLessThan(32);
    expect(fit.notes).toContain(FIT_NOTES.partialOffload);
    const none = estimateFit({ facts: llama8b, fileBytes: 4920739232, gpu: { totalMiB: 2048, freeMiB: 900 }, engine: 'llamacpp-native' });
    expect(none.level).toBe('no');
    expect(none.maxGpuLayers).toBeUndefined();
    // Heuristic bytes per weight when bitsPerWeight is unknown, fallbacks for missing shapes.
    const bare = estimateFit({ facts: { paramsB: 70 }, gpu: { totalMiB: 24576, freeMiB: 24000 }, engine: 'llamacpp-native' });
    expect(bare.level).toBe('partial');
    expect(estimateFit({ facts: { ...llama8b, bitsPerWeight: 4.9 }, fileBytes: 4920739232, gpu: { totalMiB: 5000, freeMiB: 4000 }, engine: 'llamacpp-native' }).level).toBe('partial');
  });

  it('counts the draft / MTP model (weights + its KV at the same context) and the image projector the launch loads', () => {
    const params = { contextSize: 8192, ubatchSize: 512 };
    const input = { facts: llama8b, fileBytes: 4920739232, gpu: GPU, engine: 'llamacpp-native' as const, params };
    const base = estimateFit(input);
    expect(base).not.toHaveProperty('draftMiB');
    const small: ModelFactsEx = { ...llama8b, blockCount: 4, kv: { groups: [{ layers: 4, kvHeads: 8, keyLength: 128, valueLength: 128 }], recurrentLayers: 0, recurrentBytesPerSeq: 0 } };
    const kv = (layout: KvLayout) => llamaKvBytes(layout, 8192, 512, 1, false, 2);
    const both = estimateFit({ ...input, extras: { draft: { bytes: 500 * MIB, facts: small }, mmprojBytes: 900 * MIB } });
    expect(both.draftMiB).toBe(Math.round((500 * MIB + kv(small.kv as KvLayout)) / MIB));
    expect(both.mmprojMiB).toBe(900);
    expect(both.needMiB).toBe(base.needMiB + (both.draftMiB as number) + 900);
    // An MTP head, or a draft whose layout could not be read: about one layer of the model's KV.
    const oneLayer = kv(llama8b.kv as KvLayout) / 32;
    expect(estimateFit({ ...input, extras: { draft: { bytes: 300 * MIB, facts: { mtpOnly: true } } } }).draftMiB).toBe(Math.round((300 * MIB + oneLayer) / MIB));
    expect(estimateFit({ ...input, extras: { draft: { bytes: 300 * MIB } } }).draftMiB).toBe(Math.round((300 * MIB + oneLayer) / MIB));
    // They stay on the GPU: fewer layers fit when the card is short.
    const tight = { ...input, gpu: { totalMiB: 5000, freeMiB: 4900 } };
    expect(estimateFit({ ...tight, extras: { mmprojBytes: 900 * MIB } }).maxGpuLayers).toBeLessThan(estimateFit(tight).maxGpuLayers as number);
  });

  it('reads the draft and projector flags of a launch', () => {
    expect(flagValue(['-c', '8192', '-md', '/m/mtp.gguf'], ['-md', '--model-draft'])).toBe('/m/mtp.gguf');
    expect(flagValue(['--mmproj=/m/mmproj.gguf'], ['-mm', '--mmproj'])).toBe('/m/mmproj.gguf');
    expect(flagValue(['-ngl', '99'], ['-md'])).toBeUndefined();
  });

  it('never divides by zero free VRAM', () => {
    const fit = estimateFit({ facts: llama8b, fileBytes: MIB, gpu: { totalMiB: 1, freeMiB: 0 }, engine: 'llamacpp-native' });
    expect(fit.availableMiB).toBe(1);
    expect(Number.isFinite(fit.utilization)).toBe(true);
    expect(fit.level).toBe('no');
  });
});

describe('estimateFit — vLLM', () => {
  it('budget = utilization × total; KV for max_model_len; reports concurrency', () => {
    const fit = estimateFit({ facts: llama8b, fileBytes: 16e9, gpu: GPU, engine: 'vllm-docker', params: { maxModelLen: 8192 } });
    expect(fit.availableMiB).toBe(Math.round(0.9 * GPU.totalMiB));
    expect(fit.kvMiB).toBe(1024);
    expect(fit.overheadMiB).toBe(1536 + VLLM_NON_TORCH_MIB);
    const kvBudget = fit.availableMiB - fit.weightsMiB - fit.overheadMiB;
    expect(fit.maxConcurrency).toBe(Math.floor(kvBudget / 1024));
    expect(['perfect', 'good', 'tight']).toContain(fit.level);
    // fp8 KV for quantized cache types; contextSize used when maxModelLen is unset.
    const fp8 = estimateFit({ facts: llama8b, fileBytes: 16e9, gpu: GPU, engine: 'vllm-native', params: { contextSize: 8192, kvCacheType: 'q4_0', parallel: 2 } });
    expect(fp8.kvMiB).toBe(1024);
    const q8 = estimateFit({ facts: llama8b, fileBytes: 16e9, gpu: GPU, engine: 'vllm-native', params: { contextSize: 8192, kvCacheType: 'q8_0' } });
    expect(q8.kvMiB).toBe(512);
    // vLLM's own fp8 name, and llama.cpp reading it as an 8-bit cache too (1 byte per element).
    expect(estimateFit({ facts: llama8b, fileBytes: 16e9, gpu: GPU, engine: 'vllm-native', params: { contextSize: 8192, kvCacheType: 'fp8' } }).kvMiB).toBe(512);
    expect(estimateFit({ facts: llama8b, fileBytes: MIB, gpu: GPU, engine: 'llamacpp-native', params: { contextSize: 8192, kvCacheType: 'fp8' } }).kvMiB).toBe(512);
  });

  it('a budget above the free VRAM: the card fits it, a start right now does not', () => {
    const fit = estimateFit({ facts: llama8b, fileBytes: 2e9, gpu: { totalMiB: 32607, freeMiB: 20000 }, engine: 'vllm-docker' });
    expect(fit.level).toBe('perfect');
    expect(fit.levelNow).toBe('no');
    expect(fit.notes).toContain(FIT_NOTES.budgetOverFree);
    const lower = estimateFit({ facts: llama8b, fileBytes: 2e9, gpu: { totalMiB: 32607, freeMiB: 20000 }, engine: 'vllm-docker', params: { gpuMemoryUtilization: 0.5 } });
    expect(lower.levelNow).toBe(lower.level);
    expect(lower.notes).not.toContain(FIT_NOTES.budgetOverFree);
  });

  it('needs room for at least one sequence of max_model_len', () => {
    const fit = estimateFit({ facts: llama8b, fileBytes: 26e9, gpu: GPU, engine: 'vllm-docker', params: { maxModelLen: 131072 } });
    expect(fit.level).toBe('no');
    expect(fit.notes).toContain(FIT_NOTES.kvTooSmall);
    expect(fit.maxConcurrency).toBe(0);
    const tight = estimateFit({ facts: llama8b, fileBytes: 24.3e9, gpu: GPU, engine: 'vllm-docker', params: { maxModelLen: 8192 } });
    expect(tight.level).toBe('tight');
    // Weights alone over budget.
    expect(estimateFit({ facts: llama8b, fileBytes: 40e9, gpu: GPU, engine: 'vllm-docker' }).level).toBe('no');
    // No attention at all (pure SSM): no concurrency figure.
    const ssm = estimateFit({ facts: { kv: { groups: [], recurrentLayers: 0, recurrentBytesPerSeq: 0 } }, fileBytes: 1e9, gpu: GPU, engine: 'vllm-docker' });
    expect(ssm.maxConcurrency).toBeUndefined();
  });
});

describe('estimateFit — properties (fast-check)', () => {
  const facts = fc.record({
    blockCount: fc.integer({ min: 1, max: 128 }),
    headCountKv: fc.integer({ min: 1, max: 64 }),
    keyLength: fc.constantFrom(64, 128, 256),
    slidingWindow: fc.option(fc.integer({ min: 128, max: 8192 }), { nil: undefined }),
    slidingWindowLayers: fc.option(fc.integer({ min: 0, max: 64 }), { nil: undefined }),
    vocabSize: fc.integer({ min: 1000, max: 300000 }),
    embeddingLength: fc.integer({ min: 256, max: 16384 }),
    paramsB: fc.double({ min: 0.1, max: 200, noNaN: true }),
  });
  const engine = fc.constantFrom<EngineKind>('llamacpp-native', 'llamacpp-docker', 'vllm-docker', 'vllm-native', 'external');
  const fileBytes = fc.option(fc.integer({ min: 1, max: 200e9 }), { nil: undefined });
  const params = fc.record({
    kvCacheType: fc.constantFrom<'f16' | 'q8_0' | 'q4_0' | 'auto'>('f16', 'q8_0', 'q4_0', 'auto'),
    ubatchSize: fc.integer({ min: 1, max: 4096 }),
    parallel: fc.integer({ min: 1, max: 16 }),
    kvUnified: fc.boolean(),
    flashAttention: fc.constantFrom<'auto' | 'on' | 'off'>('auto', 'on', 'off'),
  });

  it('more context never decreases the need', () => {
    fc.assert(
      fc.property(facts, engine, fileBytes, params, fc.integer({ min: 1, max: 262144 }), fc.integer({ min: 0, max: 262144 }), (f, e, b, p, ctx, extra) => {
        const gpu = { totalMiB: 32607, freeMiB: 30000 };
        const a = estimateFit({ facts: f, fileBytes: b, gpu, engine: e, params: { ...p, contextSize: ctx } });
        const c = estimateFit({ facts: f, fileBytes: b, gpu, engine: e, params: { ...p, contextSize: ctx + extra } });
        return c.needMiB >= a.needMiB;
      }),
    );
  });

  it('more free VRAM never makes the level worse', () => {
    fc.assert(
      fc.property(facts, engine, fileBytes, params, fc.integer({ min: 0, max: 98304 }), fc.integer({ min: 0, max: 98304 }), (f, e, b, p, free, extra) => {
        const total = 98304;
        const lo = estimateFit({ facts: f, fileBytes: b, gpu: { totalMiB: total, freeMiB: free }, engine: e, params: p });
        const hi = estimateFit({ facts: f, fileBytes: b, gpu: { totalMiB: total, freeMiB: Math.min(total, free + extra) }, engine: e, params: p });
        return levelRank(hi.level) <= levelRank(lo.level);
      }),
    );
  });

  it('utilization is need / available and the parts add up', () => {
    fc.assert(
      fc.property(facts, engine, fileBytes, params, fc.integer({ min: 0, max: 98304 }), (f, e, b, p, free) => {
        const fit = estimateFit({ facts: f, fileBytes: b, gpu: { totalMiB: 98304, freeMiB: free }, engine: e, params: p });
        return Math.abs(fit.utilization - fit.needMiB / fit.availableMiB) < 1e-12 && fit.needMiB === fit.weightsMiB + fit.kvMiB + fit.overheadMiB;
      }),
    );
  });
});

describe('quantChoices / bestQuant', () => {
  const file = (p: string, gb: number, extra: Partial<HubFile> = {}): HubFile => ({
    path: p,
    sizeBytes: gb * 1024 ** 3,
    kind: 'weights',
    groupKey: p.replace(/-\d{5}-of-\d{5}\.gguf$/, ''),
    quant: /(Q\d_\w+|BF16|F16)/.exec(p)?.[1],
    ...extra,
  });
  const files: HubFile[] = [
    file('m-Q4_K_M.gguf', 4.6),
    file('m-Q8_0.gguf', 8.0),
    file('BF16/m-BF16-00001-of-00002.gguf', 10),
    file('BF16/m-BF16-00002-of-00002.gguf', 5),
    { path: 'mmproj-F16.gguf', sizeBytes: 1e9, kind: 'mmproj' },
    { path: 'README.md', sizeBytes: 10, kind: 'other' },
  ];

  it('groups split shards and sorts by size', () => {
    const choices = quantChoices(files, llama8b, GPU, 'llamacpp-native');
    expect(choices.map((c) => c.groupKey)).toEqual(['BF16/m-BF16', 'm-Q8_0.gguf', 'm-Q4_K_M.gguf']);
    expect(choices[0]?.files).toHaveLength(2);
    expect(choices[0]?.quant).toBe('BF16');
  });

  it('picks the best quant that fits well, else a tight one, else none', () => {
    expect(bestQuant(files, llama8b, GPU, 'llamacpp-native')?.groupKey).toBe('BF16/m-BF16');
    expect(bestQuant(files, llama8b, { totalMiB: 16384, freeMiB: 13000 }, 'llamacpp-native', { contextSize: 4096 })?.groupKey).toBe('m-Q8_0.gguf');
    // Q8_0 would only be 'tight' here: a smaller quant that fits well wins.
    const q8 = quantChoices(files, llama8b, GPU, 'llamacpp-native', { contextSize: 4096 }).find((c) => c.groupKey === 'm-Q8_0.gguf')!.fit.needMiB;
    const tightCard = { totalMiB: Math.ceil(q8 / 0.95) + VRAM_RESERVE_MIB, freeMiB: 1000 };
    expect(quantChoices(files, llama8b, tightCard, 'llamacpp-native', { contextSize: 4096 }).find((c) => c.groupKey === 'm-Q8_0.gguf')?.fit.level).toBe('tight');
    expect(bestQuant(files, llama8b, tightCard, 'llamacpp-native', { contextSize: 4096 })?.groupKey).toBe('m-Q4_K_M.gguf');
    expect(bestQuant(files, llama8b, { totalMiB: 8192, freeMiB: 6400 }, 'llamacpp-native', { contextSize: 2048 })?.groupKey).toBe('m-Q4_K_M.gguf');
    expect(bestQuant(files, llama8b, { totalMiB: 4096, freeMiB: 3000 }, 'llamacpp-native')).toBeUndefined();
    // Only tight choices: the best of them.
    expect(pickBest([{ fit: { level: 'partial' } }, { fit: { level: 'tight' } }] as never)).toEqual({ fit: { level: 'tight' } });
  });

  it('tells apart the same quant label on several files (community quants, nerkyor-style)', () => {
    const named = (p: string, gb: number): HubFile => ({ path: p, sizeBytes: gb * 1e9, kind: 'weights', groupKey: p, quant: /-(Q\d[A-Za-z0-9_]*?)-/.exec(p)?.[1] as string });
    const choices = quantChoices(
      [
        named('GGUF/Coder-Q4LynnStyle-MTP.gguf', 19.6),
        named('GGUF/Coder-Q4LynnStyle-Q8MTP.gguf', 19.8),
        named('GGUF/Coder-Q8_0-MTP.gguf', 29),
        { path: 'GGUF/odd.gguf', sizeBytes: 1e9, kind: 'weights', quant: 'Q2_K' },
        { path: 'GGUF/odd2.gguf', sizeBytes: 2e9, kind: 'weights', quant: 'Q2_K' },
        { path: 'nolabel.gguf', sizeBytes: 3e9, kind: 'weights' },
      ],
      llama8b,
      GPU,
      'llamacpp-native',
    );
    expect(choices.map((c) => c.quant)).toEqual(['Q8_0', 'Q4LynnStyle · Q8MTP', 'Q4LynnStyle · MTP', 'Q4_K_M', 'Q2_K · odd2', 'Q2_K · odd']);
  });

  it('treats safetensors weights as one option and ignores .bin duplicates', () => {
    const st: HubFile[] = [
      { path: 'model-00001-of-00002.safetensors', sizeBytes: 5e9, kind: 'weights' },
      { path: 'model-00002-of-00002.safetensors', sizeBytes: 3e9, kind: 'weights' },
      { path: 'pytorch_model.bin', sizeBytes: 8e9, kind: 'weights' },
    ];
    const choices = quantChoices(st, { ...llama8b, quant: 'BF16' }, GPU, 'vllm-docker', { maxModelLen: 4096 });
    expect(choices).toHaveLength(1);
    expect(choices[0]).toMatchObject({ groupKey: '*weights', sizeBytes: 8e9, quant: 'BF16' });
    const binOnly = quantChoices([{ path: 'pytorch_model.bin', sizeBytes: 1e9, kind: 'weights' }], {}, GPU, 'vllm-docker');
    expect(binOnly[0]?.quant).toBeUndefined();
    // GGUF without groupKey falls back to its path.
    expect(quantChoices([{ path: 'x.gguf', sizeBytes: 1, kind: 'weights' }], {}, GPU, 'llamacpp-native')[0]?.groupKey).toBe('x.gguf');
  });
});

describe('fitFixes: what would make a launch fit (the "Usa cache q4_0" / "Contesto massimo che entra" buttons)', () => {
  const gpu = { totalMiB: 12288, freeMiB: 12000 };
  const estimate = (p: LaunchParams, engine: EngineKind = 'llamacpp-native') => estimateFit({ facts: llama8b, fileBytes: 4.9e9, gpu, engine, params: fitParamsFrom(p) });
  const P = (o: object) => launchParamsSchema.parse(o);

  it('a long context with every layer on the GPU: the q4_0 cache at the same context, and the largest context that fits', () => {
    const p = P({ contextSize: 131_072 });
    const fixes = fitFixes('llamacpp-native', p, estimate(p), estimate)!;
    expect(fixes.kvCacheType).toBe('q4_0');
    expect(fitsFully(estimate({ ...p, kvCacheType: 'q4_0', flashAttention: 'on' }))).toBe(true);
    const max = fixes.maxContext!;
    expect(max % FIX_CONTEXT_STEP).toBe(0);
    expect(fitsFully(estimate({ ...p, contextSize: max }))).toBe(true);
    expect(fitsFully(estimate({ ...p, contextSize: max + FIX_CONTEXT_STEP }))).toBe(false);
  });

  it('already q4_0: only the context; nothing when it fits, for vLLM and external endpoints, or when not even 1K fits', () => {
    const q4 = P({ contextSize: 524_288, kvCacheType: 'q4_0' });
    expect(fitFixes('llamacpp-native', q4, estimate(q4), estimate)).toEqual({ maxContext: expect.any(Number) });
    const small = P({ contextSize: 4096 });
    expect(fitFixes('llamacpp-docker', small, estimate(small), estimate)).toBeUndefined();
    expect(fitFixes('vllm-docker', small, { level: 'no', contextSize: 4096 }, estimate)).toBeUndefined();
    expect(fitFixes('external', small, { level: 'no', contextSize: 4096 }, estimate)).toBeUndefined();
    const never = () => ({ level: 'no' as const });
    expect(fitFixes('llamacpp-native', small, { level: 'no', contextSize: 4096 }, never)).toBeUndefined();
    // No context chosen: the one the estimate assumed.
    expect(fitFixes('llamacpp-native', P({}), { level: 'partial', contextSize: 8192 }, (p) => ({ level: (p.contextSize ?? 8192) <= 2048 ? 'good' : 'partial' }))).toEqual({ maxContext: 2048 });
  });
});
