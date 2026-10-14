// TensorRT-LLM's command line, click help, start log and failure diagnosis (core/engines/shared/trtllm.ts).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { launchParamsSchema } from '../../../../../src/contract/engines';
import { capacityHintOf, parseKvCapacity } from '../../../../../src/core/engines/shared/kv-capacity';
import { parseLoadProgress } from '../../../../../src/core/engines/shared/load-progress';
import { FlagGate } from '../../../../../src/core/engines/shared/standard-flags';
import {
  diagnoseTrtllm,
  packageOfLibrary,
  parseClickHelp,
  parseTrtllmVersion,
  probeClickHelp,
  trtllmContext,
  trtllmIgnored,
  trtllmKvCapacity,
  trtllmKvDtype,
  trtllmMessage,
  trtllmPhaseOf,
  trtllmProgress,
  trtllmServeArgs,
} from '../../../../../src/core/engines/shared/trtllm';

const HELP = readFileSync(path.join(__dirname, '../../../../fixtures/trtllm/help.stdout.txt'), 'utf8');
const p = (over: object = {}) => launchParamsSchema.parse(over);
const exit = { code: 1, signal: null };

describe('trtllm-serve arguments', () => {
  it('writes every setting explicitly, the model first', () => {
    const args = trtllmServeArgs(p({ contextSize: 8192, parallel: 2, batchSize: 4096, kvCacheType: 'q8_0', trtllm: { tensorParallel: 2, trustRemoteCode: true }, extraArgs: ['--log_level', 'info'] }), { model: 'nvidia/Qwen3-8B-FP8', host: '0.0.0.0', port: 8000, servedName: 'gpubench-x', revision: 'abc' });
    expect(args).toEqual([
      'nvidia/Qwen3-8B-FP8',
      '--host', '0.0.0.0',
      '--port', '8000',
      '--served_model_name', 'gpubench-x',
      '--hf_revision', 'abc',
      '--max_seq_len', '8192',
      '--max_batch_size', '2',
      '--max_num_tokens', '4096',
      '--kv_cache_free_gpu_memory_fraction', '0.9',
      '--kv_cache_dtype', 'fp8',
      '--tp_size', '2',
      '--enable_chunked_prefill',
      '--trust_remote_code',
      '--log_level', 'info',
    ]);
  });

  it('leaves out what is unset, and what an older build lacks', () => {
    const args = trtllmServeArgs(p({ trtllm: { chunkedPrefill: false, kvCacheFreeMemoryFraction: 0.5 } }), { model: 'm', host: 'h', port: 1, servedName: 's' });
    expect(args).toEqual(['m', '--host', 'h', '--port', '1', '--served_model_name', 's', '--max_seq_len', '4096', '--kv_cache_free_gpu_memory_fraction', '0.5']);
    const old = new FlagGate('trtllm', new Set(['--host', '--port', '--served_model_name', '--max_seq_len', '--revision']));
    const a = trtllmServeArgs(p({ maxModelLen: 2048, contextSize: 99, kvCacheType: 'auto' }), { model: 'm', host: 'h', port: 1, servedName: 's', revision: 'r' }, old);
    expect(a).toEqual(['m', '--host', 'h', '--port', '1', '--served_model_name', 's', '--revision', 'r', '--max_seq_len', '2048']);
    expect(old.missing.map((m) => m.flag)).toEqual(['--kv_cache_free_gpu_memory_fraction', '--kv_cache_dtype', '--enable_chunked_prefill']);
    expect(() => trtllmServeArgs(p(), { model: 'm', host: 'h', port: 1, servedName: 's' }, new FlagGate('trtllm', new Set(['--x'])))).toThrow(expect.objectContaining({ code: 'ENGINE_BAD_FLAG' }));
  });

  it('maps the KV cache type, the context and what trtllm-serve cannot take', () => {
    expect(trtllmKvDtype(p({ kvCacheType: 'fp8' }))).toBe('fp8');
    expect(trtllmKvDtype(p({ kvCacheType: 'q4_0' }))).toBe('fp8');
    expect(trtllmKvDtype(p({ kvCacheType: 'nvfp4' }))).toBe('nvfp4');
    expect(trtllmKvDtype(p({ kvCacheType: 'auto' }))).toBe('auto');
    expect(trtllmKvDtype(p({ kvCacheType: 'f16' }))).toBeUndefined();
    expect(trtllmKvDtype(p({ kvCacheType: 'fp8', trtllm: { kvCacheDtype: 'nvfp4' } }))).toBe('nvfp4');
    expect(trtllmKvDtype(p({ kvCacheType: 'fp8', extraArgs: ['--kv_cache_dtype', 'auto'] }))).toBeUndefined();
    expect(trtllmContext({ contextSize: 100 })).toBe(100);
    expect(trtllmContext({})).toBe(4096);
    expect(trtllmIgnored(p())).toEqual([]);
    expect(trtllmIgnored(p({ ropeScaling: { type: 'yarn', factor: 2, originalContext: 4096 }, dtype: 'bfloat16', quantization: 'fp8' })).map((m) => m.setting)).toEqual(['ropeScaling', 'dtype', 'quantization']);
  });
});

describe('trtllm-serve help', () => {
  it('reads every click option, its aliases and its choices', () => {
    const h = parseClickHelp(HELP);
    for (const f of ['--host', '--port', '--served_model_name', '--max_seq_len', '--tp_size', '--tensor_parallel_size', '--free_gpu_memory_fraction', '--trust_remote_code', '--enable_chunked_prefill', '--telemetry']) expect(h.flags).toContain(f);
    expect(h.choices['--kv_cache_dtype']).toEqual(['auto', 'fp8', 'nvfp4']);
    // "[pytorch]" alone is no choice list, nor is a description in brackets.
    expect(h.choices['--backend']).toBeUndefined();
    expect(h.choices['--tokenizer']).toBeUndefined();
    // Two spellings that both list the choices: the first list is kept.
    expect([...parseClickHelp('  --a, x  not a spelling').flags]).toEqual(['--a']);
    expect(parseClickHelp('  --a [x|y], --b [z|w]  two').choices).toEqual({ '--a': ['x', 'y'], '--b': ['x', 'y'] });
  });

  it('trusts only a help that is trtllm-serve’s', async () => {
    expect((await probeClickHelp(async () => ({ code: 0, stdout: HELP, stderr: '' }))).flags.size).toBeGreaterThan(20);
    expect((await probeClickHelp(async () => ({ code: 0, stdout: '  --foo  x', stderr: '' }))).flags.size).toBe(0);
    expect((await probeClickHelp(async () => ({ code: 1, stdout: HELP, stderr: '' }))).flags.size).toBe(0);
    expect((await probeClickHelp(() => Promise.reject(new Error('x')))).flags.size).toBe(0);
  });

  it('reads the version after the import banner', () => {
    expect(parseTrtllmVersion('[TensorRT-LLM] TensorRT-LLM version: 1.4.0rc0\n1.4.0rc0\n')).toBe('1.4.0rc0');
    expect(parseTrtllmVersion('1.2.1\n')).toBe('1.2.1');
    expect(parseTrtllmVersion('1.2.0rc6.post2')).toBe('1.2.0rc6.post2');
    expect(parseTrtllmVersion('nothing')).toBeUndefined();
  });
});

describe('trtllm-serve start log', () => {
  const lines = [
    '[TensorRT-LLM] TensorRT-LLM version: 1.4.0rc0',
    '[10/14/2026-10:00:05] [TRT-LLM] [I] Using LLM with PyTorch backend',
    'Fetching 11 files: 100%|██████████| 11/11',
    'Loading weights:  50%|█████     | 2/4 [00:00<00:00, 40.20it/s]Loading weights: 100%|██████████| 4/4 [00:00<00:00, 40.20it/s]',
    '[10/14/2026-10:00:06] [TRT-LLM] [I] Loading weights concurrently',
    '[10/14/2026-10:00:06] [TRT-LLM] [I] Memory used after loading model weights (inside torch) in memory usage profiling: 15.27 GiB',
    '[10/14/2026-10:00:07] [TRT-LLM] [I] [MemUsageChange] Allocated 21.41 GiB for max tokens in paged KV cache (175360).',
    '[10/14/2026-10:00:07] [TRT-LLM] [I] [kv cache manager] Primary pool',
    '[10/14/2026-10:00:08] [TRT-LLM] [I] Run generation only CUDA graph warmup for batch size=1',
    '[10/14/2026-10:00:08] [TRT-LLM] [I] [Autotuner] Autotuning process starts ...',
    'INFO:     Started server process [1]',
    'INFO:     Application startup complete.',
  ];

  it('marks the phases and the stages of the load', () => {
    expect(lines.map(trtllmPhaseOf).filter(Boolean)).toEqual(['engine_init', 'engine_init', 'load_tensors', 'load_tensors', 'kv_cache', 'graph_capture', 'api_start', 'warmup']);
    expect(lines.map((l) => trtllmProgress(l)?.stage)).toEqual(['metadata', 'metadata', 'weights', 'weights', 'weights', 'memory-profile', 'kv-cache', 'kv-cache', 'cuda-graphs', 'warmup', 'api-server', 'ready']);
    expect(trtllmProgress(lines[3] as string)).toEqual({ stage: 'weights', done: 4, total: 4, fraction: 1 });
    expect(trtllmProgress('Loading weights:   0%|          | 0/0 [00:00]')).toEqual({ stage: 'weights', done: 0, total: 0 });
    expect(trtllmProgress('something else')).toBeUndefined();
    expect(parseLoadProgress(lines[6] as string, 'trtllm-docker')?.stage).toBe('kv-cache');
    expect(trtllmMessage('[10/14/2026-10:00:07] [TRT-LLM] [W] careful')).toBe('careful');
    expect(trtllmMessage('INFO:     Started server process [1]')).toBe('Started server process [1]');
  });

  it('reads the KV capacity', () => {
    expect(trtllmKvCapacity(lines)).toEqual({ tokens: 175360 });
    expect(trtllmKvCapacity(['nothing'])).toBeUndefined();
    expect(parseKvCapacity(lines, 'trtllm-native')).toEqual({ tokens: 175360 });
    expect(capacityHintOf(lines, 'trtllm-docker')).toBe(175360);
  });
});

describe('trtllm-serve failures', () => {
  const d = (line: string, ctx = {}) => diagnoseTrtllm(['start', line], exit, ctx);

  it('names the most specific cause', () => {
    expect(d('Error: spawn /x/python ENOENT')).toMatchObject({ code: 'ENGINE_START_FAILED' });
    expect(d("ModuleNotFoundError: No module named 'tensorrt_llm'")).toMatchObject({ code: 'ENGINE_NOT_INSTALLED', params: { reason: 'trtllm_missing' } });
    expect(d('ImportError: libmpi.so.40: cannot open shared object file: No such file or directory', { distro: 'Ubuntu' })).toMatchObject({ code: 'ENGINE_MISSING_LIBRARY', params: { library: 'libmpi.so.40', package: 'libopenmpi-dev', distro: 'Ubuntu' } });
    expect(d('ImportError: libfoo.so.2: cannot open shared object file')).toMatchObject({ params: { package: 'libfoo2' } });
    expect(d('RuntimeError: TRTLLMGenFusedMoE does not support SM120')).toMatchObject({ code: 'ENGINE_NO_KERNEL_IMAGE' });
    expect(d('max_seq_len (65536) is larger than max_position_embeddings (40960)')).toMatchObject({ code: 'MODEL_TOO_LARGE', params: { maxModelLen: 65536, modelMaxLen: 40960 } });
    expect(d('RuntimeError: Not enough GPU memory to allocate the KV cache for max_seq_len=1')).toMatchObject({ code: 'ENGINE_OOM', params: { reason: 'kv-cache' } });
    expect(d('torch.OutOfMemoryError: CUDA out of memory.')).toMatchObject({ code: 'ENGINE_OOM' });
    expect(d('Cannot access gated repo for url https://huggingface.co/meta/llama/resolve/main/config.json')).toMatchObject({ code: 'HF_AUTH_REQUIRED', params: { repo: 'meta/llama' } });
    expect(d('RepositoryNotFoundError: 404', { repo: 'a/b' })).toMatchObject({ code: 'HF_NOT_FOUND', params: { repo: 'a/b' } });
    expect(d('RepositoryNotFoundError: 404')).not.toHaveProperty('params.repo');
    expect(d('ValueError: Unknown architecture for AutoModelForCausalLM: Qwen3_5ForCausalLM')).toMatchObject({ code: 'ENGINE_MODEL_UNSUPPORTED', params: { reason: 'architecture', value: 'Qwen3_5ForCausalLM' } });
    expect(d("Model architectures ['Foo'] are not supported")).toMatchObject({ params: { value: 'Foo' } });
    expect(d('Unsupported architecture: Bar')).toMatchObject({ params: { value: 'Bar' } });
    expect(d('ValueError: Unsupported quantization algo: W4A8_X')).toMatchObject({ code: 'ENGINE_MODEL_UNSUPPORTED', params: { reason: 'quantization', value: 'W4A8_X' } });
    expect(d('Error: No such option: --foo')).toMatchObject({ code: 'ENGINE_BAD_FLAG', params: { flag: '--foo' } });
    expect(d("Error: Invalid value for '--kv_cache_dtype': 'x' is not one of 'auto', 'fp8', 'nvfp4'.")).toMatchObject({ params: { flag: '--kv_cache_dtype' } });
    expect(d('Error: Got unexpected extra argument (bar)')).toMatchObject({ params: { flag: 'bar' } });
    expect(d('OSError: [Errno 98] Address already in use')).toMatchObject({ code: 'ENGINE_PORT_IN_USE' });
    expect(d('CUDA driver version is insufficient for CUDA runtime version')).toMatchObject({ code: 'DRIVER_TOO_OLD' });
    expect(d('RuntimeError: No CUDA GPUs are available', { docker: true })).toMatchObject({ code: 'DOCKER_NO_GPU' });
    expect(d('RuntimeError: No CUDA GPUs are available')).toMatchObject({ code: 'GPU_NOT_FOUND' });
    expect(diagnoseTrtllm([], { code: null, signal: 'SIGKILL' })).toMatchObject({ code: 'ENGINE_EXITED', params: { code: 'SIGKILL' } });
  });

  it('knows Open MPI’s package', () => {
    expect(packageOfLibrary('libmpi.so.40')).toBe('libopenmpi-dev');
    expect(packageOfLibrary('libopen-pal.so.40')).toBe('libopenmpi-dev');
    expect(packageOfLibrary('libgomp.so.1')).toBe('libgomp1');
  });
});
