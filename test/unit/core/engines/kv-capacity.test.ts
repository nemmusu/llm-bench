import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { llamaKvCapacity, parseKvCapacity, vllmKvCapacity } from '../../../../src/core/engines/shared/kv-capacity';
import { VLLM_FIXTURES } from '../docker/helpers';

const vllmLog = (name: string) => readFileSync(path.join(VLLM_FIXTURES, name), 'utf8').split(/\r?\n/);

describe('KV capacity: vLLM', () => {
  it('reads the cache size and how many requests of the max model length fit', () => {
    expect(vllmKvCapacity(vllmLog('ready-cached.log'))).toEqual({ tokens: 225_744, maxConcurrencyAtTokens: { tokens: 4096, concurrency: 55.11 } });
    // The lines the user's team page quoted (v0.10+ process prefixes).
    expect(
      parseKvCapacity(
        [
          '(EngineCore_DP0 pid=255) INFO 10-06 05:13:06 [kv_cache_utils.py:1087] GPU KV cache size: 889,820 tokens',
          '(EngineCore_DP0 pid=255) INFO 10-06 05:13:06 [kv_cache_utils.py:1091] Maximum concurrency for 200,000 tokens per request: 4.45x',
        ],
        'vllm-docker',
      ),
    ).toEqual({ tokens: 889_820, maxConcurrencyAtTokens: { tokens: 200_000, concurrency: 4.45 } });
  });

  it('size without the concurrency line, and nothing when the log has no size', () => {
    expect(parseKvCapacity(['INFO 10-06 09:20:33 [kv_cache_utils.py:1087] GPU KV cache size: 1,024 tokens'], 'vllm-native')).toEqual({ tokens: 1024 });
    expect(vllmKvCapacity(['GPU KV cache size: 0 tokens'])).toBeUndefined();
    expect(vllmKvCapacity(vllmLog('oom.log'))).toBeUndefined();
  });
});

describe('KV capacity: llama.cpp', () => {
  it('n_ctx of the context (b10997 llama_context), unified slots: no per-request split', () => {
    const lines = [
      'llama_context: constructing llama_context',
      'llama_context: n_seq_max     = 4',
      'llama_context: n_ctx         = 32768',
      'llama_context: n_ctx_seq     = 32768',
      'llama_context: kv_unified    = true',
      'llama_kv_cache: size = 4096.00 MiB ( 32768 cells,  32 layers,  4/1 seqs), K (f16): 2048.00 MiB, V (f16): 2048.00 MiB',
    ];
    expect(parseKvCapacity(lines, 'llamacpp-native')).toEqual({ tokens: 32768 });
  });

  it('split slots: each of n_seq_max requests holds n_ctx_seq (older builds: n_ctx_per_seq)', () => {
    expect(
      llamaKvCapacity([
        'llama_context: n_seq_max     = 4',
        'llama_context: n_ctx         = 32768',
        'llama_context: n_ctx_per_seq = 8192',
        'llama_kv_cache_unified: size = 4096.00 MiB ( 32768 cells,  32 layers,  4/4 seqs), K (f16): 2048.00 MiB, V (f16): 2048.00 MiB',
      ]),
    ).toEqual({ tokens: 32768, maxConcurrencyAtTokens: { tokens: 8192, concurrency: 4 } });
  });

  it('older builds name the context llama_new_context_with_model', () => {
    expect(llamaKvCapacity(['llama_new_context_with_model: n_ctx      = 8192', 'llama_kv_cache_init:      CUDA0 KV buffer size =  1024.00 MiB'], )).toEqual({ tokens: 8192 });
  });

  it('without n_ctx, the biggest KV cache (SWA models print a small window cache too)', () => {
    expect(
      parseKvCapacity(
        [
          'llama_kv_cache_unified_iswa: creating non-SWA KV cache, size = 16384 cells',
          'llama_kv_cache_unified: size =  640.00 MiB ( 16384 cells,   5 layers,  1/1 seqs), K (f16):  320.00 MiB, V (f16):  320.00 MiB',
          'llama_kv_cache_unified: size =  232.00 MiB (  1536 cells,  29 layers,  1/1 seqs), K (f16):  116.00 MiB, V (f16):  116.00 MiB',
        ],
        'llamacpp-docker',
      ),
    ).toEqual({ tokens: 16384 });
  });

  it('nothing to read, or an engine that never says', () => {
    expect(llamaKvCapacity(['main: server is listening on http://127.0.0.1:8080'])).toBeUndefined();
    expect(llamaKvCapacity(['llama_context: n_ctx         = 0'])).toBeUndefined();
    expect(parseKvCapacity(['GPU KV cache size: 1,024 tokens'], 'external')).toBeUndefined();
  });
});
