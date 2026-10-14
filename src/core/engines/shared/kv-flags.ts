/**
 * KV cache and flash-attention flags, the same for every llama.cpp launch (server native or Docker,
 * llama-bench). K and V always get the same type: mixed types run on slow kernels. A quantized cache
 * only works with flash attention, so a quantized type turns it on whatever was asked.
 */
import type { LaunchParams } from '../../../contract/engines';
import { isFullPrecisionKv } from '../../../contract/kv-cache';

/** f16, q8_0, q4_0, or a type the build lists (a fork's turbo3…). */
export type LlamaKvType = string;

/** The cache type to pass as -ctk/-ctv: fp8 (vLLM's 8-bit cache) is q8_0 here; unset / 'auto' = the default. */
export function llamaKvType(p: Pick<LaunchParams, 'kvCacheType'>): LlamaKvType | undefined {
  const kv = p.kvCacheType;
  if (kv === undefined || kv === 'auto') return undefined;
  return kv === 'fp8' ? 'q8_0' : kv;
}

/** Every type but f32 / f16 / bf16 is quantized (llama.cpp's q8_0, q4_0…, a fork's turbo3…). */
export function isQuantizedKv(kv: LlamaKvType | undefined): boolean {
  return kv !== undefined && !isFullPrecisionKv(kv);
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

/** Spellings of llama-server's KV layout switch (one pool for every slot, or one per slot). */
const KV_LAYOUT_FLAGS = new Set(['--kv-unified', '-kvu', '--no-kv-unified', '-no-kvu']);

/**
 * `--kv-unified` when LLM Bench chooses the layout: more than one slot, a build that knows the flag, and
 * extra arguments that do not choose it themselves (the tuner's "contesto diviso per utente" passes
 * --no-kv-unified). One pool for every slot: a single long prompt can use the whole context.
 */
export function llamaKvLayoutArgs(p: Pick<LaunchParams, 'parallel' | 'extraArgs'>, flags: ReadonlySet<string>): string[] {
  if (p.parallel === undefined || p.parallel <= 1 || !flags.has('--kv-unified')) return [];
  return p.extraArgs.some((a) => KV_LAYOUT_FLAGS.has(a)) ? [] : ['--kv-unified'];
}

/**
 * vLLM --kv-cache-dtype: fp8 for any 8/4-bit request (vLLM has no 4-bit KV), 'auto' when asked, else
 * nothing. Extra arguments that set it themselves (the tuner's fp8_e4m3 / fp8_e5m2) win: nothing then.
 */
export function vllmKvDtype(p: Pick<LaunchParams, 'kvCacheType' | 'extraArgs'>): 'auto' | 'fp8' | undefined {
  if (p.extraArgs.includes('--kv-cache-dtype')) return undefined;
  const kv = p.kvCacheType;
  if (kv === 'auto') return 'auto';
  return kv === 'fp8' || kv === 'q8_0' || kv === 'q4_0' ? 'fp8' : undefined;
}
