/**
 * The prefix cache as an engine's Prometheus /metrics counts it (vLLM). Names vary by version:
 *   v0.9+  vllm:prefix_cache_queries_total / vllm:prefix_cache_hits_total   (counters, tokens)
 *   v0.8   vllm:gpu_prefix_cache_queries(_total) / vllm:gpu_prefix_cache_hits(_total)
 *   V0     vllm:gpu_prefix_cache_hit_rate                                    (gauge, 0..1, no counts)
 * Values of every label set (one per engine or model) are summed.
 */
export interface PrefixCacheReading {
  /** Prompt tokens looked up in the cache, since the engine started. */
  queries?: number;
  /** Of those, tokens found in the cache. */
  hits?: number;
  /** The old gauge: the engine's own hit rate. */
  hitRate?: number;
}

const COUNTER = /^vllm:(?:gpu_)?prefix_cache_(queries|hits)(?:_total)?(?:\{[^}]*\})?\s+(\S+)/;
const GAUGE = /^vllm:gpu_prefix_cache_hit_rate(?:\{[^}]*\})?\s+(\S+)/;

/** undefined when the text has none of these metrics. */
export function parsePrefixCacheMetrics(text: string): PrefixCacheReading | undefined {
  const out: PrefixCacheReading = {};
  for (const line of text.split(/\r?\n/)) {
    const c = COUNTER.exec(line);
    if (c) {
      const v = Number(c[2]);
      if (!Number.isFinite(v)) continue;
      const key = c[1] as 'queries' | 'hits';
      out[key] = (out[key] ?? 0) + v;
      continue;
    }
    const g = GAUGE.exec(line);
    if (g && Number.isFinite(Number(g[1]))) out.hitRate = Number(g[1]);
  }
  return Object.keys(out).length ? out : undefined;
}
