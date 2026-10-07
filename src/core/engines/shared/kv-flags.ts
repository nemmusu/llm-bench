/**
 * KV cache and flash-attention flags, the same for every llama.cpp launch (server native or Docker,
 * llama-bench). K and V always get the same type: mixed types run on slow kernels. A quantized cache
 * only works with flash attention, so a quantized type turns it on whatever was asked.
 */
import type { LaunchParams } from '../../../contract/engines';

export type LlamaKvType = 'f16' | 'q8_0' | 'q4_0';

/** The cache type to pass as -ctk/-ctv: fp8 (vLLM's 8-bit cache) is q8_0 here; unset / 'auto' = the default. */
export function llamaKvType(p: Pick<LaunchParams, 'kvCacheType'>): LlamaKvType | undefined {
  const kv = p.kvCacheType;
  if (kv === undefined || kv === 'auto') return undefined;
  return kv === 'fp8' ? 'q8_0' : kv;
}

export function isQuantizedKv(kv: LlamaKvType | undefined): boolean {
  return kv === 'q8_0' || kv === 'q4_0';
}

/** -fa value: 'on' with a quantized cache, else what the params say (default 'auto'). */
export function llamaFlashAttention(p: Pick<LaunchParams, 'kvCacheType' | 'flashAttention'>): 'auto' | 'on' | 'off' {
  return isQuantizedKv(llamaKvType(p)) ? 'on' : (p.flashAttention ?? 'auto');
}

/** `-ctk T -ctv T` (or nothing for the default cache). */
export function llamaKvArgs(p: Pick<LaunchParams, 'kvCacheType'>): string[] {
  const kv = llamaKvType(p);
  return kv === undefined ? [] : ['-ctk', kv, '-ctv', kv];
}

/** vLLM --kv-cache-dtype: fp8 for any 8/4-bit request (vLLM has no 4-bit KV), 'auto' when asked, else nothing. */
export function vllmKvDtype(p: Pick<LaunchParams, 'kvCacheType'>): 'auto' | 'fp8' | undefined {
  const kv = p.kvCacheType;
  if (kv === 'auto') return 'auto';
  return kv === 'fp8' || kv === 'q8_0' || kv === 'q4_0' ? 'fp8' : undefined;
}
