import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { diagnoseVllm, parseVllmLoadReport, vllmPhaseOf } from '../../../../../src/core/engines/shared/vllm-logs';
import { VLLM_FIXTURES } from '../../docker/helpers';

const log = (name: string) => readFileSync(path.join(VLLM_FIXTURES, name), 'utf8').split(/\r?\n/);
const EXIT = { code: 1, signal: null };

describe('vLLM phases', () => {
  it('marks every start-up phase once, in order (cold start with download)', () => {
    const marks: string[] = [];
    for (const l of log('ready-download.log')) {
      const p = vllmPhaseOf(l);
      if (p !== undefined && !marks.includes(p)) marks.push(p);
    }
    expect(marks).toEqual(['engine_init', 'model_load', 'load_tensors', 'compile', 'kv_cache', 'graph_capture', 'api_start']);
  });

  it('recognises the compile-cache hit and old engine wording', () => {
    expect(vllmPhaseOf('INFO [backends.py:164] Directly load the compiled graph(s) for dynamic shape from the cache, took 1.802 s')).toBe('compile');
    expect(vllmPhaseOf('INFO 01-01 [llm_engine.py:1] Initializing an LLM engine (v0.6.0) with config')).toBe('engine_init');
    expect(vllmPhaseOf('Capturing cudagraphs for decoding.')).toBe('graph_capture');
    expect(vllmPhaseOf('unrelated')).toBeUndefined();
  });
});

describe('parseVllmLoadReport', () => {
  it('extracts vLLM own timings from a cold start', () => {
    expect(parseVllmLoadReport(log('ready-download.log'))).toEqual({
      version: '0.11.0',
      downloadS: 6.523419,
      loadWeightsS: 0.51,
      modelLoadGiB: 1.1201,
      modelLoadS: 8.127893,
      compileS: 26.04,
      kvCacheGiB: 24.12,
      kvCacheTokens: 225744,
      maxConcurrency: 55.11,
      graphCaptureS: 6,
      graphCaptureGiB: 0.84,
      initEngineS: 39.88,
    });
  });
  it('handles the "GiB memory and" variant and missing GiB on graphs', () => {
    const r = parseVllmLoadReport([...log('ready-cached.log'), 'Graph capturing finished in 3 secs']);
    expect(r).toMatchObject({ modelLoadGiB: 1.1201, modelLoadS: 1.45221, compileS: 6.71, graphCaptureS: 3, graphCaptureGiB: 0.84 });
    expect(r.downloadS).toBeUndefined();
  });
});

describe('diagnoseVllm (synthetic fixtures modelled on real logs)', () => {
  const d = (name: string, ctx = {}) => diagnoseVllm(log(name), EXIT, ctx);

  it('no kernel image (sm_120 on an old image) suggests a tag', () => {
    const e = d('no-kernel-image.log', { suggestTag: 'v0.31.0' });
    expect(e.code).toBe('ENGINE_NO_KERNEL_IMAGE');
    expect(e.params).toEqual({ code: '1', sm: 'sm_120', suggestedTag: 'v0.31.0' });
    expect(e.detail?.split('\n')[0]).toContain('no kernel image is available');
    // The PyTorch warning alone is enough.
    expect(diagnoseVllm(['NVIDIA GeForce RTX 5090 with CUDA capability sm_120 is not compatible with the current PyTorch installation.'], EXIT).params).toEqual({
      code: '1',
      sm: 'sm_120',
    });
    expect(diagnoseVllm(['RuntimeError: CUDA error: no kernel image is available for execution on the device'], EXIT).params).toEqual({ code: '1' });
  });

  it('VRAM held by other processes', () => {
    expect(d('vram-busy.log')).toMatchObject({
      code: 'VRAM_BUSY',
      params: { freeGiB: 12.61, totalGiB: 31.37, utilization: 0.9, desiredGiB: 28.23 },
    });
  });

  it('out of memory and no cache blocks', () => {
    expect(d('oom.log').code).toBe('ENGINE_OOM');
    expect(d('no-cache-blocks.log').code).toBe('ENGINE_OOM');
  });

  it('context too large for the KV cache or the model', () => {
    expect(d('kv-too-small.log')).toMatchObject({
      code: 'MODEL_TOO_LARGE',
      params: { reason: 'kv-cache', maxModelLen: 40960, estimatedMaxModelLen: 9536 },
    });
    expect(diagnoseVllm(['ValueError: The model is too large for the KV cache'], EXIT).params).toEqual({ code: '1', reason: 'kv-cache' });
    expect(
      diagnoseVllm(['The model\'s max seq len (32768) is larger than the maximum number of tokens that can be stored in KV cache (12000).'], EXIT).params,
    ).toMatchObject({ maxModelLen: 32768 });
    expect(d('max-model-len.log')).toMatchObject({ code: 'MODEL_TOO_LARGE', params: { reason: 'context', maxModelLen: 65536, modelMaxLen: 40960 } });
    expect(diagnoseVllm(['max_model_len (9000) is larger than allowed'], EXIT).params).toEqual({ code: '1', reason: 'context', maxModelLen: 9000 });
  });

  it('Hugging Face access problems', () => {
    expect(d('gated-401.log')).toMatchObject({ code: 'HF_AUTH_REQUIRED', params: { repo: 'meta-llama/Llama-3.2-1B-Instruct' } });
    expect(d('gated-403.log')).toMatchObject({ code: 'HF_GATED', params: { repo: 'google/gemma-3-1b-it' } });
    expect(d('repo-not-found.log')).toMatchObject({ code: 'HF_NOT_FOUND', params: { repo: 'nobody/does-not-exist' } });
    expect(diagnoseVllm(['GatedRepoError: 401 Client Error', 'Cannot access gated repo'], EXIT, { repo: 'a/b' }).params).toEqual({ code: '1', repo: 'a/b' });
    expect(diagnoseVllm(['huggingface_hub.errors.HfHubHTTPError: Invalid user token.'], EXIT)).toMatchObject({
      code: 'HF_AUTH_REQUIRED',
      params: { reason: 'invalid-token' },
    });
    expect(diagnoseVllm(['429 Client Error: Too Many Requests for url'], EXIT).code).toBe('HF_RATE_LIMITED');
    expect(diagnoseVllm(["OSError: We couldn't connect to 'https://huggingface.co' to load this file"], EXIT).code).toBe('NETWORK');
  });

  it('rejected arguments', () => {
    expect(d('bad-flag.log')).toMatchObject({ code: 'ENGINE_BAD_FLAG', params: { flag: '--bogus-flag' } });
    expect(d('invalid-choice.log')).toMatchObject({ code: 'ENGINE_BAD_FLAG', params: { flag: '--dtype' } });
    expect(diagnoseVllm(['vllm serve: error: argument --tp/--tensor-parallel-size: invalid int value'], EXIT).params).toMatchObject({ flag: '--tp' });
  });

  it('port, driver, GPU visibility, model and spawn errors', () => {
    expect(d('port-in-use.log').code).toBe('ENGINE_PORT_IN_USE');
    expect(diagnoseVllm(['RuntimeError: The NVIDIA driver on your system is too old (found version 12020).'], EXIT).code).toBe('DRIVER_TOO_OLD');
    expect(diagnoseVllm(['RuntimeError: No CUDA GPUs are available'], EXIT).code).toBe('GPU_NOT_FOUND');
    expect(diagnoseVllm(['RuntimeError: No CUDA GPUs are available'], EXIT, { docker: true }).code).toBe('DOCKER_NO_GPU');
    expect(diagnoseVllm(['OSError: /models/x does not appear to have a file named config.json.'], EXIT).code).toBe('MODEL_INVALID');
    expect(diagnoseVllm(['Error: spawn /opt/vllm/bin/vllm ENOENT'], { code: null, signal: null }).code).toBe('ENGINE_START_FAILED');
  });

  it('falls back to ENGINE_EXITED with the tail as detail', () => {
    const e = diagnoseVllm(['line a', 'line b'], { code: null, signal: 'SIGKILL' });
    expect(e).toMatchObject({ code: 'ENGINE_EXITED', params: { code: 'SIGKILL' }, detail: 'line a\nline b' });
    const long = diagnoseVllm(Array.from({ length: 100 }, (_, i) => `l${i}`), EXIT);
    expect(long.detail?.split('\n')).toHaveLength(40);
  });
});
