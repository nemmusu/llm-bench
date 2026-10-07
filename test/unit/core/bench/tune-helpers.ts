/** Shared builders for the sweep / ranking / tuner tests. */
import type { LatencyPoint, Stat, TuneCombination } from '../../../../src/contract/results';

export function stat(median: number, cv = 0): Stat {
  return { n: 2, median, mean: median, min: median, max: median, stddev: median * cv, cv, values: [median, median] };
}

export function point(promptTokens: number, decode: number, o: { prefill?: number; ttft?: number; cv?: number; engine?: boolean } = {}): LatencyPoint {
  const prefill = o.prefill ?? 5000;
  return {
    promptTokens,
    outputTokens: 128,
    ttftMs: stat(o.ttft ?? (promptTokens / prefill) * 1000, o.cv),
    prefillTps: stat(prefill, o.cv),
    ...(o.engine ? { prefillTpsEngine: stat(prefill, o.cv) } : {}),
    decodeTps: stat(decode, o.cv),
    itlP50Ms: 1000 / decode,
    itlP95Ms: 1000 / decode,
    itlPerChunk: false,
    totalMs: stat(1000),
  };
}

export function combo(kvType: TuneCombination['kvType'], maxContext: number, sweep: LatencyPoint[], over: Partial<TuneCombination> = {}): TuneCombination {
  return {
    params: { contextSize: maxContext, kvCacheType: kvType, extraArgs: [], env: {} },
    kvType,
    maxContext,
    sweep,
    command: { argv: ['llama-server'], powershell: 'llama-server', bash: 'llama-server' },
    outcome: 'ok',
    tags: [],
    ...over,
  };
}
