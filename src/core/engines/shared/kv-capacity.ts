/**
 * "Contesto tenuto in memoria": how many tokens the engine's KV cache holds, read from its start log.
 *
 *   vLLM       "GPU KV cache size: 889,820 tokens"
 *              "Maximum concurrency for 200,000 tokens per request: 4.45x"
 *   llama.cpp  "llama_context: n_ctx = 32768" (older builds: llama_new_context_with_model / llama_init_from_model),
 *              else the KV cells: "llama_kv_cache(_unified)(_iswa): size = … MiB ( 32768 cells, …)"; the
 *              biggest of the lines (SWA models print a smaller cache for the sliding window)
 *              "llama_context: n_seq_max = 4" + "n_ctx_seq = 8192" (older: n_ctx_per_seq): split slots
 */
import type { EngineKind } from '../../../contract/engines';
import type { KvCapacity } from '../../../contract/results';
import { parseVllmLoadReport } from './vllm-logs';

const num = (s: string): number => Number(s.replace(/,/g, ''));

export function vllmKvCapacity(lines: readonly string[]): KvCapacity | undefined {
  const report = parseVllmLoadReport(lines);
  if (report.kvCacheTokens === undefined || report.kvCacheTokens <= 0) return undefined;
  let at: number | undefined;
  for (const l of lines) {
    const m = /Maximum concurrency for ([\d,]+) tokens per request: ([\d.]+)x/.exec(l);
    if (m) at = num(m[1] as string);
  }
  return {
    tokens: report.kvCacheTokens,
    ...(at !== undefined && report.maxConcurrency !== undefined && report.maxConcurrency > 0
      ? { maxConcurrencyAtTokens: { tokens: at, concurrency: report.maxConcurrency } }
      : {}),
  };
}

const CTX = /\b(?:llama_context|llama_new_context_with_model|llama_init_from_model):\s+n_ctx\s+=\s+(\d+)/;
const CTX_SEQ = /\b(?:llama_context|llama_new_context_with_model|llama_init_from_model):\s+n_ctx_(?:seq|per_seq)\s+=\s+(\d+)/;
const SEQ_MAX = /\b(?:llama_context|llama_new_context_with_model|llama_init_from_model):\s+n_seq_max\s+=\s+(\d+)/;
const CELLS = /\bllama_kv_cache\w*:\s+size\s+=\s+[\d.]+\s+MiB\s+\(\s*(\d+)\s+cells/;

export function llamaKvCapacity(lines: readonly string[]): KvCapacity | undefined {
  let ctx: number | undefined;
  let perSeq: number | undefined;
  let seqs: number | undefined;
  let cells: number | undefined;
  for (const l of lines) {
    const c = CTX.exec(l);
    if (c) ctx = Number(c[1]);
    const p = CTX_SEQ.exec(l);
    if (p) perSeq = Number(p[1]);
    const s = SEQ_MAX.exec(l);
    if (s) seqs = Number(s[1]);
    const k = CELLS.exec(l);
    if (k) cells = Math.max(cells ?? 0, Number(k[1]));
  }
  const tokens = ctx ?? cells;
  if (tokens === undefined || tokens <= 0) return undefined;
  // Split slots: each of the n_seq_max requests holds n_ctx_seq tokens (a unified cache has n_ctx_seq = n_ctx).
  if (seqs !== undefined && seqs > 1 && perSeq !== undefined && perSeq > 0 && perSeq < tokens) {
    return { tokens, maxConcurrencyAtTokens: { tokens: perSeq, concurrency: seqs } };
  }
  return { tokens };
}

/** The KV capacity an engine's start log reports; undefined when it does not say (external endpoints never do). */
export function parseKvCapacity(lines: readonly string[], kind: EngineKind): KvCapacity | undefined {
  if (kind === 'vllm-docker' || kind === 'vllm-native') return vllmKvCapacity(lines);
  if (kind === 'llamacpp-native' || kind === 'llamacpp-docker') return llamaKvCapacity(lines);
  return undefined;
}
