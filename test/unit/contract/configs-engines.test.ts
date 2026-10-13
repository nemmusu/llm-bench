import { describe, expect, it } from 'vitest';
import { configKeyOf, configParamsOf, engineFamilyOf, engineReleaseOf } from '../../../src/contract/configs';
import { launchParamsSchema, type LaunchParams } from '../../../src/contract/engines';

const P = (over: Partial<LaunchParams> = {}): LaunchParams => launchParamsSchema.parse(over);

describe('configurations of SGLang, command engines and forks', () => {
  it('reads SGLang flags into the vLLM-like fields', () => {
    const argv = [
      '/venv/bin/python',
      '-X',
      'gpubench=gpubench-1',
      '-m',
      'sglang.launch_server',
      '--model-path',
      '/models/qwen',
      '--served-model-name',
      'qwen',
      '--host',
      '127.0.0.1',
      '--port',
      '30000',
      '--context-length',
      '32768',
      '--mem-fraction-static',
      '0.8',
      '--max-running-requests',
      '4',
      '--kv-cache-dtype',
      'fp8_e5m2',
      '--chunked-prefill-size',
      '8192',
      '--random-seed',
      '0',
      '--enable-cache-report',
      '--disable-cuda-graph',
    ];
    expect(configParamsOf({ engineKind: 'sglang-native', argv, params: P() })).toEqual({
      contextSize: 32768,
      gpuMemoryUtilization: 0.8,
      parallel: 4,
      cacheTypeK: 'fp8_e5m2',
      cacheTypeV: 'fp8_e5m2',
      maxNumBatchedTokens: 8192,
      enforceEager: true,
      other: [],
    });
    expect(engineFamilyOf('sglang-docker')).toBe('vllm');
    expect(engineFamilyOf('command')).toBe('external');
  });

  it('reads RoPE scaling from SGLang overrides (the recipes shape)', () => {
    const rope = { rope_type: 'yarn', factor: 4, original_max_position_embeddings: 32768 };
    const sglang = configParamsOf({ engineKind: 'sglang-docker', argv: ['python3', '-m', 'sglang.launch_server', '--json-model-override-args', JSON.stringify({ rope_scaling: rope })] });
    expect(sglang.ropeScaling).toEqual({ type: 'yarn', factor: 4, originalContext: 32768 });
    expect(sglang.other).toEqual([]);
  });

  it('keeps a custom engine apart from its base in the key', () => {
    const params = configParamsOf({ engineKind: 'llamacpp-native', params: P() });
    const base = configKeyOf({ engineKind: 'llamacpp-native', engineRelease: engineReleaseOf({ build: 'b11460' }), model: 'm', gpu: 'g', params });
    const fork = configKeyOf({ engineKind: 'llamacpp-native', engineRelease: engineReleaseOf({ build: 'b11460', customEngine: { id: 'prismml' } }), model: 'm', gpu: 'g', params });
    expect(fork).not.toBe(base);
    expect(engineReleaseOf({ build: 'b1', customEngine: { id: 'prismml' } })).toBe('custom:prismml b1');
  });
});
