import { describe, expect, it } from 'vitest';
import {
  bareName,
  configIdOf,
  configKeyOf,
  configParamsOf,
  configsQuerySchema,
  configTagsOf,
  engineFamilyOf,
  engineReleaseOf,
  gpuKeyOf,
  modelKeyOf,
  stableStringify,
  type LaunchInput,
} from '../../../src/contract/configs';
import { launchParamsSchema, type LaunchParams } from '../../../src/contract/engines';

const P = (over: Partial<LaunchParams> = {}): LaunchParams => launchParamsSchema.parse(over);
const llama = (argv: string[], params: Partial<LaunchParams> = {}, more: Partial<LaunchInput> = {}) =>
  configParamsOf({ engineKind: 'llamacpp-native', argv: ['llama-server', ...argv], params: P(params), ...more });
const vllm = (argv: string[], params: Partial<LaunchParams> = {}, more: Partial<LaunchInput> = {}) =>
  configParamsOf({ engineKind: 'vllm-native', argv: ['vllm', 'serve', 'Qwen/Qwen3-8B', ...argv], params: P(params), ...more });

describe('configuration settings from a launch', () => {
  it('gives the same settings for the same flags in any order, without identity, paths and logs', () => {
    const a = llama(['-m', 'C:\\models\\a.gguf', '--host', '127.0.0.1', '--port', '41873', '--alias', 'gpubench-1', '-c', '32768', '-ctk', 'q8_0', '-ctv', 'q8_0', '-fa', 'on', '-ub', '1024', '-b', '4096', '--no-webui', '--fit', 'off', '--seed', '42', '--metrics', '--log-file', 'x.log', '-v']);
    const b = llama(['-b', '4096', '--fit', 'off', '-fa', 'on', '--port', '5555', '-ub', '1024', '--ctx-size', '32768', '--cache-type-v', 'q8_0', '--cache-type-k', 'Q8_0', '-m', '/m/b.gguf', '--alias', 'gpubench-2', '--log-disable']);
    expect(a).toEqual(b);
    expect(a).toEqual({ contextSize: 32768, cacheTypeK: 'q8_0', cacheTypeV: 'q8_0', flashAttention: 'on', ubatchSize: 1024, batchSize: 4096, other: [] });
    expect(configKeyOf({ engineKind: 'llamacpp-native', engineRelease: 'b1', model: 'm', gpu: 'g', params: a })).toBe(
      configKeyOf({ gpu: 'g', model: 'm', params: b, engineRelease: 'b1', engineKind: 'llamacpp-native' }),
    );
  });

  it('drops explicit engine defaults: unset and default are the same configuration', () => {
    const explicit = llama(['-c', '8192', '-ngl', 'all', '-fa', 'auto', '-b', '2048', '-ub', '512', '-ctk', 'f16', '-ctv', 'f16']);
    const unset = llama(['-c', '8192', '-ngl', '999']);
    expect(explicit).toEqual(unset);
    expect(unset).toEqual({ contextSize: 8192, other: [] });
    // -1 and a count at the model's layers are "all" too; fewer layers stay (partial offload).
    expect(llama(['-ngl', '-1'])).toEqual({ other: [] });
    expect(llama(['-ngl', '36'], {}, { blockCount: 36 })).toEqual({ other: [] });
    expect(llama(['-ngl', '20'], {}, { blockCount: 36 }).gpuLayers).toBe(20);
    expect(llama(['--gpu-layers', '0']).gpuLayers).toBe(0);
    expect(llama(['--n-gpu-layers', 'lots']).gpuLayers).toBeUndefined();
  });

  it('reads old runs from the saved argv when their params say nothing, and params when there is no argv', () => {
    const argvOnly = llama(['-c', '4096', '-np', '4', '--kv-unified', '-t', '16'], {});
    const paramsOnly = configParamsOf({ engineKind: 'llamacpp-native', params: P({ contextSize: 4096, parallel: 4, threads: 16 }) });
    expect(argvOnly).toEqual(paramsOnly);
    // What really ran wins: the extra arguments came last and changed the context.
    expect(llama(['-c', '4096', '-c', '8192'], { contextSize: 4096, extraArgs: ['-c', '8192'] }).contextSize).toBe(8192);
    // Params fill in what the argv does not say.
    expect(llama(['-c', '4096'], { flashAttention: 'on', kvCacheType: 'q4_0', batchSize: 1024, ubatchSize: 256, gpuLayers: 10 })).toMatchObject({
      flashAttention: 'on',
      cacheTypeK: 'q4_0',
      cacheTypeV: 'q4_0',
      batchSize: 1024,
      ubatchSize: 256,
      gpuLayers: 10,
    });
    expect(configParamsOf({ engineKind: 'llamacpp-docker', params: P({ kvCacheType: 'auto', extraArgs: ['--n-cpu-moe', '12', '--mlock'] }) })).toEqual({ cpuMoe: 12, other: ['--mlock'] });
    expect(configParamsOf({ engineKind: 'llamacpp-native' })).toEqual({ other: [] });
  });

  it('reads the context of -c 0 from the model, and ignores invalid values', () => {
    expect(llama(['-c', '0'], {}, { modelContext: 40960 }).contextSize).toBe(40960);
    expect(llama(['-c', '0']).contextSize).toBeUndefined();
    expect(llama(['-c', '-5', '-b', 'x', '-ub', '0', '-np', 'many', '-t', '', '--n-cpu-moe', '-2'])).toEqual({ other: [] });
    expect(llama(['-c', 'big']).contextSize).toBeUndefined();
  });

  it('reads flash attention as a switch or with a value', () => {
    expect(llama(['-fa']).flashAttention).toBe('on');
    expect(llama(['-fa', '-c', '1024']).flashAttention).toBe('on');
    expect(llama(['-fa', 'off', '-c', '1024'])).toEqual({ flashAttention: 'off', contextSize: 1024, other: [] });
    expect(llama(['--flash-attn', '1']).flashAttention).toBe('on');
    expect(llama(['--flash-attn=disabled']).flashAttention).toBe('off');
    expect(llama(['--flash-attn=weird']).flashAttention).toBe('on');
    expect(llama(['-fa', 'auto']).flashAttention).toBeUndefined();
  });

  it('keeps K and V cache types apart, and MoE experts on the CPU', () => {
    expect(llama(['-ctk', 'q8_0', '-ctv', 'q4_0'])).toMatchObject({ cacheTypeK: 'q8_0', cacheTypeV: 'q4_0' });
    expect(llama(['--cpu-moe']).cpuMoe).toBe('all');
    expect(llama(['-cmoe', '-ncmoe', '4']).cpuMoe).toBe(4);
    expect(llama(['--n-cpu-moe', '0']).cpuMoe).toBeUndefined();
  });

  it('reads speculative decoding (draft model as a bare file name)', () => {
    expect(llama(['-md', 'C:\\models\\Qwen3-0.6B-Q8_0.gguf', '--draft-max', '16', '--draft-min', '2'])).toMatchObject({
      draftModel: 'Qwen3-0.6B-Q8_0.gguf',
      draftMax: 16,
      draftMin: 2,
    });
    expect(llama(['--model-draft', '/m/d.gguf', '--draft', '8', '--draft-n-min', 'x']).draftMax).toBe(8);
    expect(llama(['--draft-n', 'x']).draftMax).toBeUndefined();
    expect(vllm(['--speculative-config', '{"num_speculative_tokens": 3, "model": "/models/eagle", "nested": [{"model": 1}]}']).speculative).toBe(
      '{"model":"eagle","nested":[{"model":1}],"num_speculative_tokens":3}',
    );
    expect(vllm(['--speculative-config', 'ngram']).speculative).toBe('ngram');
    expect(vllm(['--speculative-model', 'org/draft', '--num-speculative-tokens', '5']).speculative).toBe('{"model":"draft","num_speculative_tokens":5}');
    expect(vllm(['--num-speculative-tokens', 'x']).speculative).toBeUndefined();
  });

  it('reads vLLM settings and drops its defaults', () => {
    const v = vllm(['--served-model-name', 'api', 'gpubench-x', '--host', '127.0.0.1', '--port', '8000', '--max-model-len', '16384', '--gpu-memory-utilization', '0.84', '--max-num-seqs', '8', '--kv-cache-dtype', 'fp8', '--max-num-batched-tokens', '8192', '--enforce-eager', '--seed', '0', '--dtype', 'bfloat16', '--quantization', 'fp8', '--revision', 'abc']);
    expect(v).toEqual({
      contextSize: 16384,
      gpuMemoryUtilization: 0.84,
      parallel: 8,
      cacheTypeK: 'fp8',
      cacheTypeV: 'fp8',
      maxNumBatchedTokens: 8192,
      enforceEager: true,
      dtype: 'bfloat16',
      quantization: 'fp8',
      other: [],
    });
    expect(vllm(['--gpu-memory-utilization', '0.9', '--kv-cache-dtype', 'auto', '--dtype', 'auto'])).toEqual({ other: [] });
    expect(vllm(['--gpu-memory-utilization', 'high', '--gpu-memory-utilization', ''])).toEqual({ other: [] });
    // Params alone: vLLM reads its own fields (q8_0/q4_0 become its fp8 cache, f16 is its default).
    const p = configParamsOf({ engineKind: 'vllm-docker', params: P({ maxModelLen: 8192, contextSize: 4096, kvCacheType: 'q4_0', gpuMemoryUtilization: 0.8, dtype: 'half', quantization: 'awq', parallel: 4, batchSize: 99, flashAttention: 'on' }) });
    expect(p).toEqual({ contextSize: 8192, cacheTypeK: 'fp8', cacheTypeV: 'fp8', gpuMemoryUtilization: 0.8, dtype: 'half', quantization: 'awq', parallel: 4, other: [] });
    expect(configParamsOf({ engineKind: 'vllm-docker', params: P({ contextSize: 4096, kvCacheType: 'f16' }) })).toEqual({ contextSize: 4096, other: [] });
    expect(configParamsOf({ engineKind: 'vllm-docker', params: P({ kvCacheType: 'fp8' }) }).cacheTypeK).toBe('fp8');
  });

  it('reads a Docker command after its image (or skips docker flags when the image is not in it)', () => {
    const argv = ['docker', 'run', '-d', '--rm', '--name', 'gpubench-1', '--label', 'gpubench=1', '--gpus', 'all', '-p', '127.0.0.1:1:8080', '-v', 'C:\\m:/models:ro', '-e', 'HF_TOKEN', 'ghcr.io/ggml-org/llama.cpp:server-cuda', '-m', '/models/a.gguf', '-c', '4096', '-fa', 'on'];
    const found = configParamsOf({ engineKind: 'llamacpp-docker', argv, image: 'ghcr.io/ggml-org/llama.cpp:server-cuda' });
    expect(found).toEqual({ contextSize: 4096, flashAttention: 'on', other: [] });
    const missing = configParamsOf({ engineKind: 'llamacpp-docker', argv, image: 'other:tag' });
    // The image itself is a value of the last docker flag here; every docker flag is skipped.
    expect(missing).toEqual({ contextSize: 4096, flashAttention: 'on', other: [] });
  });

  it('keeps any other flag (paths as bare names, regexes as written), sorted', () => {
    const o = llama(['--override-tensor', 'blk\\.\\d+\\.ffn=CPU', '--mlock', '--lora', 'D:\\loras\\x.gguf', '--rope-scaling=yarn', '-sm', 'row', '--chat-template-file', './t.jinja', '-x']);
    expect(o.other).toEqual(['--chat-template-file t.jinja', '--lora x.gguf', '--mlock', '--override-tensor blk\\.\\d+\\.ffn=CPU', '-sm row', '-x']);
    // RoPE scaling is a setting of its own (recipes, YaRN).
    expect(o.ropeScaling).toEqual({ type: 'yarn' });
    // Values that look like paths: absolute, relative, home, known file types.
    expect(llama(['--a', '/x/y', '--b', '../z', '--c', '~/w', '--d', 'f.bin', '--e', 'plain/text']).other).toEqual(['--a y', '--b z', '--c w', '--d f.bin', '--e plain/text']);
    // A lone "-" or a negative number is a value, not a flag.
    expect(llama(['--offset', '-3', '-']).other).toEqual(['--offset -3 -']);
  });

  it('RoPE scaling is one setting whichever engine says it (recipes, YaRN)', () => {
    const yarn = { type: 'yarn', factor: 9.375, originalContext: 32768 };
    expect(llama(['--rope-scaling', 'YaRN', '--rope-scale', '9.375', '--yarn-orig-ctx', '32768'])).toEqual({ ropeScaling: yarn, other: [] });
    // The same from the launch params (no command line), for vLLM too.
    expect(configParamsOf({ engineKind: 'llamacpp-native', params: P({ ropeScaling: { type: 'yarn', factor: 9.375, originalContext: 32768 } }) })).toEqual({ ropeScaling: yarn, other: [] });
    expect(configParamsOf({ engineKind: 'vllm-docker', params: P({ ropeScaling: { type: 'yarn', factor: 9.375, originalContext: 32768 } }) }).ropeScaling).toEqual(yarn);
    // vLLM: --hf-overrides (other overrides stay a flag of their own), the older --rope-scaling JSON; SGLang.
    const json = '{"rope_type":"yarn","factor":9.375,"original_max_position_embeddings":32768}';
    expect(vllm(['--hf-overrides', `{"rope_scaling":${json},"max_position_embeddings":307200}`])).toEqual({ ropeScaling: yarn, other: ['--hf-overrides {"max_position_embeddings":307200}'] });
    expect(vllm(['--rope-scaling', json])).toEqual({ ropeScaling: yarn, other: [] });
    expect(configParamsOf({ engineKind: 'sglang-docker', argv: ['python3', '-m', 'sglang.launch_server', '--json-model-override-args', `{"rope_scaling":${json}}`] }).ropeScaling).toEqual(yarn);
    // "type" spelled the old way, and 4 decimals: equal settings, equal key.
    expect(vllm(['--rope-scaling', '{"type":"YARN","factor":2.3450381679,"original_max_position_embeddings":131000}']).ropeScaling).toEqual({ type: 'yarn', factor: 2.345, originalContext: 131000 });
  });

  it('RoPE scaling that changes nothing is no setting; what cannot be read stays as written', () => {
    expect(llama(['--rope-scaling', 'none', '--rope-scale', '4'])).toEqual({ other: [] });
    expect(llama(['--rope-scaling', 'yarn', '--rope-scale', '1'])).toEqual({ other: [] });
    expect(llama(['--yarn-orig-ctx', '32768'])).toEqual({ other: [] });
    // A bare factor: llama.cpp's linear scaling.
    expect(llama(['--rope-scale', '2'])).toEqual({ ropeScaling: { type: 'linear', factor: 2 }, other: [] });
    expect(llama(['--rope-scaling', 'yarn'])).toEqual({ ropeScaling: { type: 'yarn' }, other: [] });
    expect(llama(['--rope-scaling', '--rope-scale', '0', '--yarn-orig-ctx', 'x'])).toEqual({ other: [] });
    expect(vllm(['--hf-overrides'])).toEqual({ other: [] });
    expect(vllm(['--hf-overrides', 'not json'])).toEqual({ other: ['--hf-overrides not json'] });
    expect(vllm(['--hf-overrides', '[1]'])).toEqual({ other: ['--hf-overrides [1]'] });
    expect(vllm(['--hf-overrides', '{"rope_scaling":null}'])).toEqual({ other: ['--hf-overrides {"rope_scaling":null}'] });
    expect(vllm(['--hf-overrides', '{"rope_scaling":[1]}'])).toEqual({ other: ['--hf-overrides {"rope_scaling":[1]}'] });
    expect(vllm(['--hf-overrides', '{"max_position_embeddings":131072}'])).toEqual({ other: ['--hf-overrides {"max_position_embeddings":131072}'] });
    expect(vllm(['--hf-overrides', '{"rope_scaling":{"factor":-1,"original_max_position_embeddings":"x"}}'])).toEqual({ other: [] });
  });

  it('ignores flags given without their value, and stray words after a switch', () => {
    expect(llama(['-ctk'])).toEqual({ other: [] });
    expect(llama(['-c'])).toEqual({ other: [] });
    expect(llama(['-ngl'])).toEqual({ other: [] });
    expect(vllm(['--gpu-memory-utilization'])).toEqual({ other: [] });
    expect(llama(['-ctv', '--kv-cache-dtype', '-md', '--speculative-config', '--speculative-model', '--dtype', '--quantization'])).toEqual({ other: [] });
    expect(llama(['--n-cpu-moe', 'x', '--max-num-batched-tokens', '0', '-ctk', 'auto'])).toEqual({ other: [] });
    expect(vllm(['--enforce-eager', 'stray', '--num-speculative-tokens', '5'])).toEqual({ enforceEager: true, speculative: '{"num_speculative_tokens":5}', other: [] });
  });

  it('tells a split KV pool from a unified one (more than one slot only) and reads --cache-reuse', () => {
    expect(llama(['-np', '4', '--kv-unified'])).toEqual({ parallel: 4, kvLayout: 'unified', other: [] });
    expect(llama(['-np', '4', '-kvu'])).toEqual(llama(['--kv-unified', '-np', '4']));
    expect(llama(['-np', '4', '--no-kv-unified'])).toEqual({ parallel: 4, kvLayout: 'split', other: [] });
    expect(llama(['-np', '4', '-no-kvu']).kvLayout).toBe('split');
    // A command line with several slots and no flag: llama-server splits (the pool is shared only with automatic slots).
    expect(llama(['-np', '4']).kvLayout).toBe('split');
    // Params alone: LLM Bench adds --kv-unified itself, unless the extra arguments say otherwise.
    expect(configParamsOf({ engineKind: 'llamacpp-native', params: P({ parallel: 4 }) }).kvLayout).toBe('unified');
    expect(configParamsOf({ engineKind: 'llamacpp-native', params: P({ parallel: 4, extraArgs: ['--no-kv-unified'] }) }).kvLayout).toBe('split');
    // One slot: the layout makes no difference.
    expect(llama(['-np', '1', '--kv-unified'])).toEqual({ parallel: 1, other: [] });
    expect(llama(['--kv-unified'])).toEqual({ other: [] });
    expect(llama(['-np', '4', '--kv-unified', '--cache-reuse', '256'])).toEqual({ parallel: 4, kvLayout: 'unified', cacheReuse: 256, other: [] });
    expect(llama(['--cache-reuse', '0'])).toEqual({ other: [] });
    expect(llama(['--cache-reuse', 'x', '--cache-reuse', '-1'])).toEqual({ other: [] });
    // vLLM's pool is always shared: no layout.
    expect(vllm(['--max-num-seqs', '4']).kvLayout).toBeUndefined();
  });

  it('reads vLLM block size, CUDA graph sizes and the fp8 cache variants as settings of their own', () => {
    expect(vllm(['--block-size', '32', '--cuda-graph-sizes', '4', '1', '2', '2'])).toEqual({ blockSize: 32, cudaGraphSizes: [1, 2, 4], other: [] });
    expect(vllm(['--block-size', '16'])).toEqual({ other: [] });
    expect(vllm(['--block-size', 'big', '--cuda-graph-sizes', '1', 'x'])).toEqual({ other: [] });
    expect(vllm(['--cuda-graph-sizes', '1,2,8'])).toEqual({ cudaGraphSizes: [1, 2, 8], other: [] });
    expect(vllm(['--compilation-config', '{"cudagraph_capture_sizes": [8, 1, 4]}'])).toEqual({ cudaGraphSizes: [1, 4, 8], other: [] });
    expect(vllm(['-O', '{"level": 3, "cudagraph_capture_sizes": [2, 1]}'])).toEqual({ cudaGraphSizes: [1, 2], other: ['--compilation-config {"level":3}'] });
    expect(vllm(['--compilation-config', '{"cudagraph_capture_sizes": "all"}']).other).toEqual(['--compilation-config {"cudagraph_capture_sizes":"all"}']);
    expect(vllm(['--compilation-config', '3'])).toEqual({ other: ['--compilation-config 3'] });
    expect(vllm(['--compilation-config', '{level:3}'])).toEqual({ other: ['--compilation-config {level:3}'] });
    expect(vllm(['--compilation-config', '{"level": 3}'])).toEqual({ other: ['--compilation-config {"level":3}'] });
    expect(vllm(['--compilation-config', '[1]'])).toEqual({ other: ['--compilation-config [1]'] });
    expect(vllm(['--compilation-config'])).toEqual({ other: [] });
    expect(vllm(['--cuda-graph-sizes'])).toEqual({ other: [] });
    // The fp8 formats stay apart from plain fp8 (what was passed is what ran).
    expect(vllm(['--kv-cache-dtype', 'fp8_e5m2'])).toEqual({ cacheTypeK: 'fp8_e5m2', cacheTypeV: 'fp8_e5m2', other: [] });
    expect(configParamsOf({ engineKind: 'vllm-docker', params: P({ kvCacheType: 'fp8', extraArgs: ['--kv-cache-dtype', 'fp8_e4m3'] }) }).cacheTypeK).toBe('fp8_e4m3');
    // Reporting cached tokens changes nothing about how the engine runs.
    expect(vllm(['--enable-prompt-tokens-details'])).toEqual({ other: [] });
  });

  it('has nothing to say about an external server', () => {
    expect(configParamsOf({ engineKind: 'external', argv: ['x', '-c', '1'], params: P({ contextSize: 4096 }) })).toEqual({ other: [] });
  });
});

describe('configuration tags, identity and key', () => {
  it('tags CPU offload, eager and draft', () => {
    expect(configTagsOf({ other: [] })).toEqual([]);
    expect(configTagsOf({ other: [], gpuLayers: 10, enforceEager: true, draftModel: 'd' })).toEqual(['cpu-offload', 'eager', 'draft']);
    expect(configTagsOf({ other: [], cpuMoe: 'all', speculative: '{}' })).toEqual(['cpu-offload', 'draft']);
  });

  it('names engines, models and cards', () => {
    expect(engineFamilyOf('llamacpp-docker')).toBe('llamacpp');
    expect(engineFamilyOf('vllm-native')).toBe('vllm');
    expect(engineFamilyOf('external')).toBe('external');
    expect(modelKeyOf({ format: 'safetensors', repo: 'Qwen/Qwen3-8B', weakKey: 'w' })).toBe('repo:Qwen/Qwen3-8B@main');
    expect(modelKeyOf({ format: 'safetensors', repo: 'Qwen/Qwen3-8B', revision: 'abc', weakKey: 'w' })).toBe('repo:Qwen/Qwen3-8B@abc');
    expect(modelKeyOf({ format: 'gguf', sha256: 'ff', weakKey: 'w' })).toBe('sha256:ff');
    expect(modelKeyOf({ format: 'safetensors', weakKey: 'w' })).toBe('weak:w');
    expect(gpuKeyOf({ hostId: 'h', gpuUuid: 'GPU-1', gpuName: 'RTX' })).toBe('gpu:GPU-1');
    expect(gpuKeyOf({ hostId: 'h', gpuName: 'RTX' })).toBe('host:h:RTX');
    expect(gpuKeyOf({ hostId: 'h' })).toBe('host:h:none');
    expect(engineReleaseOf({ build: 'b1', version: 'v', variant: 'cuda-13.4' })).toBe('b1 cuda-13.4');
    expect(engineReleaseOf({ image: 'vllm/vllm-openai:v0.12.0', version: 'v0.12.0' })).toBe('vllm/vllm-openai:v0.12.0 v0.12.0');
    expect(bareName('C:\\a\\b.gguf')).toBe('b.gguf');
    expect(bareName('/')).toBe('/');
  });

  it('writes canonical JSON and short stable ids', () => {
    expect(stableStringify({ b: 1, a: [1, undefined, { d: undefined, c: 'x' }], z: null })).toBe('{"a":[1,null,{"c":"x"}],"b":1,"z":null}');
    const id = configIdOf('{"a":1}');
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(configIdOf('{"a":1}')).toBe(id);
    expect(configIdOf('{"a":2}')).not.toBe(id);
    expect(configIdOf('')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('parses the configs query', () => {
    expect(configsQuerySchema.parse({ gpu: 'all', minContext: '32768', engine: 'vllm-docker' })).toEqual({ gpu: 'all', minContext: 32768, engine: 'vllm-docker' });
    expect(configsQuerySchema.safeParse({ minContext: 'x' }).success).toBe(false);
  });
});
