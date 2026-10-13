import { describe, expect, it } from 'vitest';
import { configKeyOf, configParamsOf, engineFamilyOf, engineReleaseOf } from '../../../src/contract/configs';
import { launchParamsSchema, type LaunchParams } from '../../../src/contract/engines';

const P = (over: Partial<LaunchParams> = {}): LaunchParams => launchParamsSchema.parse(over);

describe('configurations of SGLang, command engines and RoPE scaling', () => {
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

  it('reads RoPE scaling from every engine and from the params', () => {
    const llama = configParamsOf({ engineKind: 'llamacpp-native', argv: ['llama-server', '-c', '131072', '--rope-scaling', 'yarn', '--rope-scale', '4', '--yarn-orig-ctx', '32768'] });
    expect(llama.ropeScaling).toBe('yarn:4:32768');
    const linear = configParamsOf({ engineKind: 'llamacpp-native', argv: ['llama-server', '--rope-scaling', 'linear', '--rope-scale', '2', '--yarn-orig-ctx', '4096'] });
    expect(linear.ropeScaling).toBe('linear:2');
    // Unreadable values keep what an earlier occurrence said.
    const bad = configParamsOf({ engineKind: 'llamacpp-native', argv: ['llama-server', '--rope-scaling', 'yarn', '--rope-scale', '3', '--rope-scale', 'x', '--yarn-orig-ctx', '8192', '--yarn-orig-ctx', '-1'] });
    expect(bad.ropeScaling).toBe('yarn:3:8192');
    expect(configParamsOf({ engineKind: 'llamacpp-native', argv: ['llama-server', '--rope-scaling', 'none'] }).ropeScaling).toBeUndefined();
    const rope = { rope_type: 'yarn', factor: 4, original_max_position_embeddings: 32768 };
    const vllm = configParamsOf({ engineKind: 'vllm-native', argv: ['vllm', 'serve', 'm', '--hf-overrides', JSON.stringify({ rope_scaling: rope, max_position_embeddings: 131072 })] });
    expect(vllm.ropeScaling).toBe('yarn:4:32768');
    expect(vllm.other).toEqual(['--hf-overrides {"max_position_embeddings":131072}']);
    const legacy = configParamsOf({ engineKind: 'vllm-native', argv: ['vllm', 'serve', 'm', '--rope-scaling', JSON.stringify({ type: 'yarn', factor: 2, original_max_position_embeddings: 8192 })] });
    expect(legacy.ropeScaling).toBe('yarn:2:8192');
    const sglang = configParamsOf({ engineKind: 'sglang-docker', argv: ['python3', '-m', 'sglang.launch_server', '--json-model-override-args', JSON.stringify({ rope_scaling: rope })] });
    expect(sglang.ropeScaling).toBe('yarn:4:32768');
    expect(sglang.other).toEqual([]);
    // Overrides that are not JSON, or JSON without a rope_scaling object, stay as other settings.
    expect(configParamsOf({ engineKind: 'vllm-native', argv: ['vllm', 'serve', 'm', '--hf-overrides', 'nope'] }).other).toEqual(['--hf-overrides nope']);
    expect(configParamsOf({ engineKind: 'vllm-native', argv: ['vllm', 'serve', 'm', '--hf-overrides', '[1]'] }).other).toEqual(['--hf-overrides [1]']);
    expect(configParamsOf({ engineKind: 'vllm-native', argv: ['vllm', 'serve', 'm', '--rope-scaling', '{"factor":"x"}'] }).ropeScaling).toBeUndefined();
    expect(configParamsOf({ engineKind: 'vllm-native', argv: ['vllm', 'serve', 'm', '--rope-scaling', '[2]'] }).ropeScaling).toBe('[2]:1');
    // Params alone (no command line): the same text.
    expect(configParamsOf({ engineKind: 'llamacpp-native', params: P({ ropeScaling: { type: 'yarn', factor: 4, originalContext: 32768 } }) }).ropeScaling).toBe('yarn:4:32768');
    expect(configParamsOf({ engineKind: 'external', params: P({ ropeScaling: { type: 'yarn', factor: 4, originalContext: 32768 } }) }).ropeScaling).toBeUndefined();
  });

  it('keeps a custom engine apart from its base in the key', () => {
    const params = configParamsOf({ engineKind: 'llamacpp-native', params: P() });
    const base = configKeyOf({ engineKind: 'llamacpp-native', engineRelease: engineReleaseOf({ build: 'b11460' }), model: 'm', gpu: 'g', params });
    const fork = configKeyOf({ engineKind: 'llamacpp-native', engineRelease: engineReleaseOf({ build: 'b11460', customEngine: { id: 'prismml' } }), model: 'm', gpu: 'g', params });
    expect(fork).not.toBe(base);
    expect(engineReleaseOf({ build: 'b1', customEngine: { id: 'prismml' } })).toBe('custom:prismml b1');
  });
});
