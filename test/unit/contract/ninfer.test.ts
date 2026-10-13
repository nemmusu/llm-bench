import { describe, expect, it } from 'vitest';
import {
  engineRunsFormat,
  isNinferKind,
  NINFER_MODEL_CONTEXT,
  ninferAutoKvTokens,
  ninferFamilyOf,
  ninferFit,
  ninferFlags,
  ninferGpuSupported,
  ninferKindFor,
  ninferKvBytesPerToken,
  ninferMaxKvTokens,
  ninferMemory,
  ninferParamsText,
  ninferPresetOf,
  ninferPresetsFor,
  trainedContextOf,
} from '../../../src/contract/ninfer';

/** Qwen3.8-27B NVFP4 as published (text, vision, MTP and DFlash2 in one 23.7 GB file). */
const NVFP4 = { artifactBytes: 23_719_715_844, manifest: { name: 'qwen3.8-27b', components: ['text', 'vision', 'mtp', 'dflash2'] } };
const RTX_5090 = { totalMiB: 32_607 };

describe('NInfer kinds and formats', () => {
  it('maps platforms to kinds and recognises them', () => {
    expect(ninferKindFor('linux')).toBe('ninfer-native');
    expect(ninferKindFor('win32')).toBe('ninfer-wsl');
    expect(ninferKindFor('darwin')).toBeUndefined();
    expect(isNinferKind('ninfer-wsl')).toBe(true);
    expect(isNinferKind('ninfer-native')).toBe(true);
    expect(isNinferKind('vllm-docker')).toBe(false);
  });

  it('says which engines read which format', () => {
    expect(engineRunsFormat('ninfer-wsl', 'ninfer')).toBe(true);
    expect(engineRunsFormat('ninfer-native', 'gguf')).toBe(false);
    expect(engineRunsFormat('llamacpp-native', 'ninfer')).toBe(false);
    expect(engineRunsFormat('llamacpp-docker', 'gguf')).toBe(true);
    expect(engineRunsFormat('vllm-docker', 'safetensors')).toBe(true);
    expect(engineRunsFormat('vllm-docker', 'remote')).toBe(false);
    expect(engineRunsFormat('external', 'remote')).toBe(true);
    expect(engineRunsFormat('external', 'gguf')).toBe(false);
    expect(engineRunsFormat('command', 'safetensors')).toBe(true);
    expect(engineRunsFormat('command', 'gguf')).toBe(true);
    expect(engineRunsFormat('command', 'ninfer')).toBe(false);
  });

  it('runs on an RTX 5090 or a 32 GB card with compute capability 12.0', () => {
    expect(ninferGpuSupported({ name: 'NVIDIA GeForce RTX 5090' })).toBe(true);
    expect(ninferGpuSupported({ name: 'NVIDIA RTX PRO 6000 Blackwell', computeCapability: '12.0', memTotalMiB: 97_887 })).toBe(true);
    expect(ninferGpuSupported({ name: 'NVIDIA GeForce RTX 5080', computeCapability: '12.0', memTotalMiB: 16_303 })).toBe(false);
    expect(ninferGpuSupported({ name: 'NVIDIA GeForce RTX 4090', computeCapability: '8.9', memTotalMiB: 24_564 })).toBe(false);
    expect(ninferGpuSupported({ computeCapability: '12.0', memTotalMiB: null })).toBe(false);
    expect(ninferGpuSupported({})).toBe(false);
  });

  it('knows the trained context of a .ninfer artifact', () => {
    expect(trainedContextOf({ format: 'ninfer' })).toBe(NINFER_MODEL_CONTEXT);
    expect(trainedContextOf({ format: 'ninfer', facts: { contextLength: 131_072 } })).toBe(131_072);
    expect(trainedContextOf({ format: 'gguf', facts: {} })).toBeUndefined();
  });
});

describe('NInfer memory', () => {
  it('reads the family from the metadata name or a file name', () => {
    expect(ninferFamilyOf('qwen3.6-35b-a3b')).toBe('moe-35b-a3b');
    expect(ninferFamilyOf('Qwen3.6-35B_A3B-NInfer')).toBe('moe-35b-a3b');
    expect(ninferFamilyOf('qwen3.8-27b')).toBe('dense-27b');
    expect(ninferFamilyOf(undefined)).toBe('dense-27b');
  });

  it('sizes the KV cache per token like NInfer reports it (int8 + MTP: 35 KiB on the 27B)', () => {
    expect(ninferKvBytesPerToken('dense-27b', 'int8', 'mtp') / 1024).toBeCloseTo(35.06, 2);
    expect(ninferKvBytesPerToken('dense-27b')).toBe(16 * 4 * 256 * 2 * 2);
    expect(ninferKvBytesPerToken('dense-27b', 'nvfp4')).toBeLessThan(ninferKvBytesPerToken('dense-27b', 'k8v4'));
    expect(ninferKvBytesPerToken('moe-35b-a3b', 'bf16', 'mtp')).toBe((10 * 2 * 256 * 2 + 2 * 256 * 2) * 2);
  });

  it('leaves on disk what the launch does not use', () => {
    // The tested launch: vision + MTP, DFlash2 left out → NInfer's own "weights ready | 20.0 GiB".
    const tested = ninferMemory({ ...NVFP4, params: { parallel: 2, ninfer: { vision: true, spec: 'mtp', deviceStateSlots: 2 } } });
    expect(tested.weightsMiB / 1024).toBeCloseTo(20.0, 1);
    expect(tested.overheadMiB).toBe(840 + 716 + 600);
    // No vision, no speculation: both heads stay on disk; without prefix reuse no state is cached.
    const bare = ninferMemory({ ...NVFP4, params: { ninfer: { prefixReuse: false } } });
    expect(bare.weightsMiB).toBe(Math.round(NVFP4.artifactBytes / 1024 / 1024 - 2140 - 717 - 800));
    expect(bare.overheadMiB).toBe(840 - 3 * 147 + 600);
    // DFlash keeps its drafter; no manifest = text + vision + MTP (nothing to leave out but what is there).
    expect(ninferMemory({ ...NVFP4, params: { ninfer: { spec: 'dflash2' } } }).weightsMiB).toBe(Math.round(NVFP4.artifactBytes / 1024 / 1024 - 717 - 800));
    expect(ninferMemory({ artifactBytes: 1024 * 1024 * 1000, label: 'model.ninfer' }).weightsMiB).toBe(0);
    // The MoE family: its parts are shares of the artifact.
    const moe = ninferMemory({ artifactBytes: 20_000 * 1024 * 1024, manifest: { name: 'qwen3.6-35b-a3b', components: ['text', 'mtp', 'dflash'] }, params: { ninfer: { spec: 'mtp' } } });
    expect(moe).toMatchObject({ family: 'moe-35b-a3b', weightsMiB: 20_000 - 1900 });
  });

  it('judges NInfer\'s recommended settings tight on an RTX 5090 and the tested ones a good fit', () => {
    const [recommended, tested] = ninferPresetsFor({ name: 'qwen3.8-27b' });
    const rec = ninferFit({ ...NVFP4, params: recommended?.params, gpu: { ...RTX_5090, freeMiB: 31_000 } });
    expect(rec).toMatchObject({ level: 'tight', contextSize: 240_000, availableMiB: 32_607 - 1024, maxConcurrency: 1, basis: 'file-size', notes: ['ninfer.estimate'], levelNow: 'tight', freeNowMiB: 31_000, busyMiB: 1607 });
    expect(rec.needMiB).toBeGreaterThan(29_000);
    const t = ninferFit({ ...NVFP4, params: tested?.params, gpu: RTX_5090 });
    expect(t.needMiB / 1024).toBeCloseTo(26.5, 1);
    expect(t).toMatchObject({ level: 'tight', maxConcurrency: 2 });
    expect(t.levelNow).toBeUndefined();
    // Defaults: 8K context, bf16, nothing else.
    expect(ninferFit({ ...NVFP4, gpu: RTX_5090 })).toMatchObject({ level: 'good', contextSize: 8192, kvMiB: Math.round((8192 * ninferKvBytesPerToken('dense-27b')) / 1024 / 1024) });
    // Too much: the whole trained context in bf16.
    expect(ninferFit({ ...NVFP4, params: { contextSize: 262_144 }, gpu: { ...RTX_5090, freeMiB: 30_000, ownMiB: 500 } })).toMatchObject({ level: 'no', levelNow: 'no', freeNowMiB: 30_500 });
  });

  it('sizes --kv-capacity auto from the memory left, as NInfer does', () => {
    const mem = ninferMemory({ ...NVFP4, params: { ninfer: { kvDtype: 'int8', spec: 'mtp' } } });
    const tokens = ninferAutoKvTokens(mem, 31_000);
    expect(tokens % 64).toBe(0);
    expect(tokens).toBeGreaterThan(200_000);
    expect(ninferAutoKvTokens(mem, 10_000)).toBe(0);
    const auto = ninferFit({ ...NVFP4, params: { contextSize: 65_536, ninfer: { kvCapacity: 'auto', kvDtype: 'int8', spec: 'mtp' } }, gpu: { ...RTX_5090, freeMiB: 30_000 } });
    expect(auto).toMatchObject({ level: 'tight', levelNow: 'tight', notes: ['ninfer.estimate', 'ninfer.auto-capacity'] });
    expect(auto.maxConcurrency).toBeGreaterThan(1);
    const crowded = ninferFit({ ...NVFP4, params: { contextSize: 65_536, ninfer: { kvCapacity: 'auto' } }, gpu: { ...RTX_5090, freeMiB: 21_000 } });
    expect(crowded).toMatchObject({ level: 'tight', levelNow: 'no', maxConcurrency: 0 });
    expect(ninferFit({ ...NVFP4, params: { contextSize: 262_144, ninfer: { kvCapacity: 'auto' } }, gpu: { totalMiB: 24_000 } })).toMatchObject({ level: 'no' });
  });

  it('predicts the largest capacity that fits', () => {
    const mem = ninferMemory({ ...NVFP4, params: { ninfer: { kvDtype: 'int8', spec: 'mtp', vision: true } } });
    const max = ninferMaxKvTokens(mem, 31_583);
    expect(max % 1024).toBe(0);
    expect(max).toBeGreaterThan(131_072);
    expect(ninferMaxKvTokens(mem, 22_000)).toBe(0);
    expect(ninferMaxKvTokens(mem, 23_000, 1_000_000)).toBe(0);
  });
});

describe('NInfer built-in settings and flags', () => {
  it('offers NInfer\'s recommended settings and the tested ones for the 27B, DFlash for the 35B-A3B', () => {
    const dense = ninferPresetsFor({ name: 'qwen3.8-27b' });
    expect(dense.map((p) => p.id)).toEqual(['ninfer-recommended', 'rtx5090-tested']);
    expect(dense[0]?.params).toEqual({
      contextSize: 240_000,
      parallel: 2,
      ninfer: { kvCapacity: 240_000, kvDtype: 'fp8', deviceStateSlots: 2, hostStateSlots: 8, hostKvMib: 8192, spec: 'mtp', draftTokens: 3, lmHeadDraft: true, preserveThinking: true },
    });
    expect(dense[1]?.params).toMatchObject({ contextSize: 65_536, parallel: 2, ninfer: { kvCapacity: 131_072, kvDtype: 'int8', vision: true } });
    const moe = ninferPresetsFor({ label: 'Qwen3.6-35B-A3B-NInfer' });
    expect(moe.map((p) => p.id)).toEqual(['ninfer-recommended']);
    expect(moe[0]?.params.ninfer).toMatchObject({ spec: 'dflash', draftTokens: 7 });
  });

  it('recognises a launch made from a preset', () => {
    const presets = ninferPresetsFor({ name: 'qwen3.8-27b' });
    const tested = presets[1]?.params;
    expect(ninferPresetOf({ ...tested, ninfer: { ...tested?.ninfer, prefixReuse: undefined } }, presets)).toBe('rtx5090-tested');
    expect(ninferPresetOf({ contextSize: 65_536, parallel: 2, ninfer: { kvDtype: 'int8' } }, presets)).toBeUndefined();
    expect(ninferPresetOf({ contextSize: 65_536, parallel: 2 }, presets)).toBeUndefined();
  });

  it('turns the settings into ninfer-serve flags, in launch order', () => {
    expect(ninferFlags(undefined)).toEqual([]);
    expect(ninferFlags({ kvCapacity: 'auto', kvDtype: 'int8', spec: 'mtp', vision: true, deviceStateSlots: 2, hostStateSlots: 8, hostKvMib: 8192, thinking: false, preserveThinking: true })).toEqual([
      '--kv-capacity',
      'auto',
      '--kv-dtype',
      'int8',
      '--spec',
      'mtp',
      '--draft-tokens',
      '3',
      '--vision',
      '--device-state-slots',
      '2',
      '--host-state-slots',
      '8',
      '--host-kv-mib',
      '8192',
      '--no-thinking',
      '--preserve-thinking',
    ]);
    // Without prefix reuse the cache slots are left out (NInfer refuses them together).
    expect(ninferFlags({ spec: 'dflash2', lmHeadDraft: true, prefixReuse: false, deviceStateSlots: 2 })).toEqual(['--spec', 'dflash2', '--draft-tokens', '7', '--lm-head-draft', '--no-prefix-reuse']);
    expect(ninferFlags({ spec: 'off', draftTokens: 4, lmHeadDraft: true })).toEqual([]);
    expect(ninferFlags({ vision: true })).toEqual(['--vision']);
    expect(ninferParamsText({ kvDtype: 'fp8', spec: 'dflash', draftTokens: 9 })).toBe('--kv-dtype fp8 --spec dflash --draft-tokens 9');
    expect(ninferParamsText(undefined)).toBe('');
  });
});
