import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { launchParamsSchema, type LaunchParams } from '../../../../src/contract/engines';
import { configParts } from '../../../../src/renderer/components/bench/summary';
import { CONFIG_DEFAULTS, configLabelOf, launchLabelOf, LLAMA_DEFAULTS, useConfigLabel, VLLM_DEFAULTS } from '../../../../src/renderer/components/presets/config-label';
import { createFormatters, I18nProvider } from '../../../../src/renderer/i18n';

const it_ = createFormatters('it');
const en = createFormatters('en');
const P = (over: Partial<LaunchParams> = {}): LaunchParams => launchParamsSchema.parse(over);

describe('useConfigLabel', () => {
  it('says context and KV cache always, the rest only when it differs from the defaults', () => {
    const wrapper = ({ children }: { children: ReactNode }) => <I18nProvider lang="it">{children}</I18nProvider>;
    const { result } = renderHook(() => useConfigLabel(), { wrapper });
    const label = result.current(P({ contextSize: 32768, kvCacheType: 'q8_0', flashAttention: 'on', ubatchSize: 2048, batchSize: 4096 }), 'llamacpp-native');
    expect(label.parts).toEqual(['Contesto 32.768', 'cache KV q8_0', 'flash attention', 'ub 2048', 'b 4096']);
    expect(label.text).toBe('Contesto 32.768 · cache KV q8_0 · flash attention · ub 2048 · b 4096');
    // Defaults only: still the context (or "predefinito") and the cache type.
    expect(result.current(P({ batchSize: 2048, ubatchSize: 512, flashAttention: 'auto' }), 'llamacpp-docker').text).toBe('Contesto predefinito · cache KV f16');
    expect(result.current(P({ maxModelLen: 8192, gpuMemoryUtilization: 0.9 }), 'vllm-docker').text).toBe('Contesto 8192 · cache KV auto');
  });

  it('exports the defaults it compares against', () => {
    expect(CONFIG_DEFAULTS).toEqual({ llamacpp: LLAMA_DEFAULTS, vllm: VLLM_DEFAULTS });
    expect(LLAMA_DEFAULTS).toMatchObject({ cacheType: 'f16', batchSize: 2048, ubatchSize: 512 });
    expect(VLLM_DEFAULTS).toMatchObject({ cacheType: 'auto', gpuMemoryUtilization: 0.9 });
  });

  it('shows CPU offload, eager and draft, also as the tuner tags them', () => {
    expect(launchLabelOf(P({ contextSize: 4096, gpuLayers: 20, extraArgs: ['--n-cpu-moe', '8', '-md', 'C:\\m\\d.gguf'] }), 'llamacpp-native', en, { blockCount: 36 }).parts).toEqual([
      'Context 4,096',
      'KV cache f16',
      '20 layers on GPU',
      '8 MoE layers on the CPU',
      'speculative decoding (d.gguf)',
    ]);
    expect(launchLabelOf(P({ gpuLayers: 40 }), 'llamacpp-native', it_, { blockCount: 36, tags: ['cpu-offload', 'eager', 'draft', 'eager'] }).parts).toEqual([
      'Contesto predefinito',
      'cache KV f16',
      'parte sulla CPU',
      'modalità eager',
      'decodifica speculativa',
    ]);
    expect(
      launchLabelOf(P({ maxModelLen: 16384, kvCacheType: 'fp8', gpuMemoryUtilization: 0.8, parallel: 8, extraArgs: ['--max-num-batched-tokens', '8192', '--enforce-eager', '--speculative-config', '{"method":"ngram"}'] }), 'vllm-native', it_, { tags: ['eager', 'draft'] }).parts,
    ).toEqual(['Contesto 16.384', 'cache KV fp8', 'batch 8192 token', '8 slot paralleli', 'memoria GPU 80%', 'modalità eager', 'decodifica speculativa (ngram)']);
  });

  it('leaves the context out for a table with its own column', () => {
    expect(configLabelOf('llamacpp-native', { contextSize: 8192, other: [] }, it_, { context: false }).text).toBe('Cache KV f16');
    // An external server: nothing known, nothing said.
    expect(configLabelOf('external', { other: [] }, it_)).toEqual({ parts: [], text: '' });
  });
});

describe('configParts', () => {
  it('words every setting', () => {
    expect(
      configParts(
        'llamacpp-native',
        { contextSize: 1024, cacheTypeK: 'q8_0', cacheTypeV: 'q4_0', gpuLayers: 0, cpuMoe: 'all', flashAttention: 'off', parallel: 1, threads: 8, draftMax: 4, dtype: 'f16', quantization: 'q', other: ['--mlock', '-sm row'] },
        it_,
        { allGpu: true, tags: ['draft', 'cpu-offload'] },
      ),
    ).toEqual(['contesto 1024', 'cache KV q8_0 (K) / q4_0 (V)', 'solo processore', 'esperti MoE sulla CPU', 'senza flash attention', '8 thread', 'decodifica speculativa', 'f16', 'q', 'argomenti extra: --mlock -sm row']);
    expect(configParts('llamacpp-native', { other: [] }, it_, { allGpu: true })).toEqual(['tutto in GPU']);
    expect(configParts('vllm-docker', { other: [], speculative: '{"model":5}' }, it_)).toEqual(['decodifica speculativa']);
    expect(configParts('vllm-docker', { other: [], speculative: 'not json' }, it_)).toEqual(['decodifica speculativa']);
    expect(configParts('vllm-docker', { other: [], speculative: '{"model":"eagle"}', cacheTypeK: 'fp8', cacheTypeV: 'fp8' }, it_, { context: 'never' })).toEqual([
      'cache KV fp8',
      'decodifica speculativa (eagle)',
    ]);
  });
});
