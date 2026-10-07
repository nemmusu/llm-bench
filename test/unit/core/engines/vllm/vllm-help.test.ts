/** What an installed vLLM accepts (`vllm serve --help=all` / `--help`) and its prefix-cache metrics. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseVllmHelp, probeVllmHelp } from '../../../../../src/core/engines/shared/vllm-help';
import { parsePrefixCacheMetrics } from '../../../../../src/core/inference/prefix-metrics';

const fixture = (name: string) => readFileSync(new URL(`../../../../fixtures/vllm/${name}`, import.meta.url), 'utf8');

describe('vLLM help', () => {
  it('every spelling and the listed choices (grouped v0.11-style help)', () => {
    const h = parseVllmHelp(fixture('help-all.stdout.txt'));
    for (const f of ['--block-size', '--kv-cache-dtype', '--cuda-graph-sizes', '--compilation-config', '-O', '--enable-prefix-caching', '--no-enable-prefix-caching', '--enable-prompt-tokens-details', '-q', '-h', '--help', '--max-num-seqs']) {
      expect(h.flags.has(f)).toBe(true);
    }
    expect(h.choices['--block-size']).toEqual(['1', '8', '16', '32', '64', '128']);
    expect(h.choices['--kv-cache-dtype']).toContain('fp8_e5m2');
    expect(h.choices['--dtype']).toEqual(['auto', 'bfloat16', 'float', 'float16', 'float32', 'half']);
    // Descriptions (indented further) and positional arguments are not options.
    expect(h.flags.has('model_tag')).toBe(false);
    expect([...h.flags].every((f) => f.startsWith('-'))).toBe(true);
  });

  it('an older api_server help: no block-size choices beyond its own, fp8 only', () => {
    const h = parseVllmHelp(fixture('help-old.stdout.txt'));
    expect(h.flags.has('--block-size')).toBe(false);
    expect(h.flags.has('--cuda-graph-sizes')).toBe(false);
    expect(h.choices['--kv-cache-dtype']).toEqual(['auto', 'fp8']);
    expect(parseVllmHelp('  --a {x,,y}\n  --c, , --d\n')).toEqual({ flags: new Set(['--a', '--c', '--d']), choices: { '--a': ['x', 'y'] } });
  });

  it('probes --help=all, then --help; failures and empty helps give nothing', async () => {
    const all = fixture('help-all.stdout.txt');
    const old = fixture('help-old.stdout.txt');
    const calls: string[][] = [];
    const run = (answers: Record<string, { code: number | null; stdout: string } | Error>) => async (args: string[]) => {
      calls.push(args);
      const a = answers[args[0] as string] as { code: number | null; stdout: string } | Error;
      if (a instanceof Error) throw a;
      return { ...a, stderr: '' };
    };
    expect((await probeVllmHelp(run({ '--help=all': { code: 0, stdout: all }, '--help': { code: 0, stdout: '' } }))).flags.has('--block-size')).toBe(true);
    expect(calls).toEqual([['--help=all']]);
    expect((await probeVllmHelp(run({ '--help=all': { code: 2, stdout: '' }, '--help': { code: 0, stdout: old } }))).choices['--kv-cache-dtype']).toEqual(['auto', 'fp8']);
    expect(await probeVllmHelp(run({ '--help=all': new Error('spawn'), '--help': { code: 0, stdout: 'usage: x\n  --help  show this\n' } }))).toEqual({ flags: new Set(), choices: {} });
    expect(await probeVllmHelp(run({ '--help=all': { code: 1, stdout: all }, '--help': { code: null, stdout: all } }))).toEqual({ flags: new Set(), choices: {} });
  });
});

describe('vLLM prefix-cache metrics', () => {
  it('the counters of every version (summed over label sets), or the old gauge', () => {
    const v1 = [
      '# HELP vllm:prefix_cache_queries_total Prefix cache queries.',
      '# TYPE vllm:prefix_cache_queries_total counter',
      'vllm:prefix_cache_queries_total{engine="0",model_name="m"} 1000.0',
      'vllm:prefix_cache_queries_total{engine="1",model_name="m"} 500.0',
      'vllm:prefix_cache_hits_total{engine="0",model_name="m"} 750.0',
      'vllm:num_requests_running{model_name="m"} 0.0',
    ].join('\n');
    expect(parsePrefixCacheMetrics(v1)).toEqual({ queries: 1500, hits: 750 });
    expect(parsePrefixCacheMetrics('vllm:gpu_prefix_cache_queries 10\nvllm:gpu_prefix_cache_hits 4\n')).toEqual({ queries: 10, hits: 4 });
    expect(parsePrefixCacheMetrics('vllm:prefix_cache_queries 7\r\nvllm:prefix_cache_hits_total 2')).toEqual({ queries: 7, hits: 2 });
    expect(parsePrefixCacheMetrics('vllm:gpu_prefix_cache_hit_rate{model_name="m"} 0.42')).toEqual({ hitRate: 0.42 });
    expect(parsePrefixCacheMetrics('vllm:prefix_cache_hits_total NaN-ish\nvllm:gpu_prefix_cache_hit_rate x')).toBeUndefined();
    expect(parsePrefixCacheMetrics('vllm:num_requests_running 0')).toBeUndefined();
  });
});
