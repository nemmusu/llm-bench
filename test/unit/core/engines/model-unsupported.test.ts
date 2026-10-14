/**
 * A model the engine build cannot read (ENGINE_MODEL_UNSUPPORTED), from each engine's own words: NInfer's
 * start-up failure on the user's RTX 5090 (a GGUF-NInfer artifact on the official build), llama.cpp's
 * unknown architecture or tensor type, vLLM's unsupported architecture. Every launch would fail the same:
 * the tuner stops at the first one.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FATAL_CODES } from '../../../../src/core/bench/tuner';
import { diagnoseExit } from '../../../../src/core/engines/llamacpp-native/logs';
import { diagnoseNinfer, modelUnsupported, startupFailure, unreadableModel } from '../../../../src/core/engines/ninfer/logs';
import { diagnoseVllm } from '../../../../src/core/engines/shared/vllm-logs';
import { NINFER_FIXTURES } from './ninfer/helpers';

const lines = (file: string) => readFileSync(path.join(NINFER_FIXTURES, file), 'utf8').split(/\r?\n/).filter(Boolean);
const exit = { code: 1, signal: null };

describe('NInfer: a model this build cannot read', () => {
  it('the real lines: "unknown tensor layout: gguf_blocks_v1", with the variant that reads it', () => {
    const real = lines('serve-gguf-blocks.log');
    expect(startupFailure(real)).toBe('weight/000130: unknown tensor layout: gguf_blocks_v1');
    const e = diagnoseNinfer(real, exit, { build: '81c8ce093b2c' });
    expect(e.code).toBe('ENGINE_MODEL_UNSUPPORTED');
    expect(e.params).toEqual({ engine: 'NInfer', reason: 'layout', value: 'gguf_blocks_v1', build: '81c8ce093b2c', template: 'ninfer-all', variant: 'NInfer-all' });
    expect(e.detail).toContain('planning runtime');
    expect(FATAL_CODES.has(e.code)).toBe(true);
  });

  it('an unknown format, an older container (with NInfer\'s own upgrade command), a model family it does not run', () => {
    const d = (text: string) => diagnoseNinfer([`2026-10-13 21:01:51.829  FATAL server failed during startup | ${text}`], exit);
    expect(d('weight/000007: unknown tensor format: q3_k_gguf').params).toEqual({ engine: 'NInfer', reason: 'format', value: 'q3_k_gguf' });
    expect(d('/m/a.ninfer: NInfer v2 artifact is not supported. Upgrade to v3 with: python3 tools/upgrade_ninfer_v2_to_v3.py INPUT.ninfer OUTPUT.ninfer').params).toEqual({
      engine: 'NInfer',
      reason: 'container',
      value: 'v2',
      needs: 'v3',
      command: 'python3 tools/upgrade_ninfer_v2_to_v3.py INPUT.ninfer OUTPUT.ninfer',
    });
    expect(unreadableModel('NInfer v1 artifact is not supported')).toEqual({ reason: 'container', value: 'v1' });
    expect(d("unsupported model architecture: 'Gemma4ForCausalLM'").params).toMatchObject({ reason: 'architecture', value: 'Gemma4ForCausalLM' });
    expect(unreadableModel('all fine')).toBeUndefined();
    // Without a build or the lines: only what is known.
    expect(modelUnsupported('NInfer', { reason: 'layout', value: 'x' })).toMatchObject({ code: 'ENGINE_MODEL_UNSUPPORTED', params: { engine: 'NInfer', reason: 'layout', value: 'x' }, detail: undefined });
  });

  it('the other start-up failures in NInfer\'s words', () => {
    const d = (text: string) => diagnoseNinfer(['2026-10-13 21:01:50.687  INFO  starting engine', text], exit);
    // A container that is not v3 at all: an invalid artifact.
    expect(d('… FATAL server failed during startup | /m/a.ninfer: expected NInfer v3 entry magic')).toMatchObject({ code: 'MODEL_INVALID', params: { reason: 'ninfer-artifact' } });
    // A KV type the build does not have (a variant's rk8v4 on the official build).
    expect(d('ninfer-serve: invalid kv-dtype: rk8v4')).toMatchObject({ code: 'ENGINE_BAD_FLAG', params: { flag: '--kv-dtype', value: 'rk8v4' } });
    // --lm-head-draft on a GGUF-NInfer artifact (seen on the RTX 5090, NInfer-all e408e428).
    expect(d('2026-10-14 13:16:29.280  ERROR selected proposal head is absent from artifact')).toMatchObject({ code: 'ENGINE_BAD_FLAG', params: { flag: '--lm-head-draft', reason: 'proposal_head_missing' } });
    expect(d('… ERROR cannot bind 127.0.0.1:18080')).toMatchObject({ code: 'ENGINE_PORT_IN_USE' });
    // Anything else NInfer says: its words are the message.
    expect(d('2026-10-13 21:01:51.829  FATAL server failed during startup | cuBLAS handle creation failed')).toMatchObject({ code: 'ENGINE_EXITED', message: 'ninfer-serve exited with 1: cuBLAS handle creation failed' });
    expect(d('2026-10-13 21:01:51.829  FATAL warmup failed | 3.2s | CUDA graph capture failed')).toMatchObject({ code: 'ENGINE_EXITED', message: 'ninfer-serve exited with 1: CUDA graph capture failed' });
    expect(startupFailure(['nothing here'])).toBeUndefined();
  });
});

describe('the other engines: an architecture or a tensor type this build does not know', () => {
  it('llama.cpp', () => {
    const arch = diagnoseExit(
      ["llama_model_load: error loading model: error loading model architecture: unknown model architecture: 'qwen35'", 'llama_model_load_from_file_impl: failed to load model'],
      exit,
    );
    expect(arch).toMatchObject({ code: 'ENGINE_MODEL_UNSUPPORTED', params: { engine: 'llama.cpp', reason: 'architecture', value: 'qwen35', code: '1' } });
    const type = diagnoseExit(["gguf_init_from_file_impl: tensor 'blk.0.attn_q.weight' has invalid ggml type 42 (NONE)", 'gguf_init_from_file_impl: failed to read tensor info'], exit);
    expect(type).toMatchObject({ code: 'ENGINE_MODEL_UNSUPPORTED', params: { engine: 'llama.cpp', reason: 'format', value: 'ggml type 42' } });
    // A file that cannot be read for another reason is still an invalid model.
    expect(diagnoseExit(['llama_model_load: error loading model: tensor data is not within file bounds'], exit).code).toBe('MODEL_INVALID');
  });

  it('vLLM', () => {
    const e = diagnoseVllm(["ValueError: Model architectures ['Qwen3NextForCausalLM'] are not supported for now. Supported architectures: dict_keys(['LlamaForCausalLM'])"], exit);
    expect(e).toMatchObject({ code: 'ENGINE_MODEL_UNSUPPORTED', params: { engine: 'vLLM', reason: 'architecture', value: 'Qwen3NextForCausalLM' } });
  });
});
