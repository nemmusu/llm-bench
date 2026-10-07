/** Phase 3 search spaces: "Più utenti", values that won before, vLLM memory share, block size, fp8, CUDA graphs. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { launchParamsSchema } from '../../../../src/contract/engines';
import { BIG_UBATCH, graphSizeArgs, llamaLayouts, llamaSpace, preferFirst, smallGraphSizes, vllmSpace, vllmUtilizations } from '../../../../src/core/bench/tune-space';
import { capsFromOutputs } from '../../../../src/core/engines/llamacpp-native/caps';
import { llamaKvLayoutArgs, vllmKvDtype } from '../../../../src/core/engines/shared/kv-flags';
import { vllmServeArgs } from '../../../../src/core/engines/shared/vllm-args';

const P = (o: object = {}) => launchParamsSchema.parse(o);
const HELP = readFileSync(new URL('../../../fixtures/llamacpp/help.stdout.txt', import.meta.url), 'utf8');

describe('phase 3 spaces', () => {
  const caps = capsFromOutputs('', HELP);

  it('llama.cpp "Più utenti": -np N, the pool split or shared as the build allows, --cache-reuse on/off', () => {
    expect(llamaLayouts(caps.flags)).toEqual(['unified', 'split']);
    expect(llamaLayouts(new Set(['--kv-unified']))).toEqual(['unified']);
    expect(llamaLayouts(new Set())).toEqual(['split']);
    const s = llamaSpace({ budget: 'fast', params: P({ extraArgs: ['--metrics'] }), users: 4, flags: caps.flags, draftArgs: ['-md', 'd.gguf'] });
    expect(s.base('q8_0')).toEqual({ kv: 'q8_0', fa: 'on', ub: 512, b: 2048, np: 4, layout: 'unified', reuse: 0 });
    expect(s.dimensions.map((d) => d.key)).toEqual(['layout', 'reuse', 'fa', 'ub']);
    expect(s.contextFor(4, 8192)).toBe(32768);
    expect(s.params(s.base('q8_0'), 32768)).toMatchObject({ contextSize: 32768, parallel: 4, extraArgs: ['--metrics'] });
    expect(s.params({ ...s.base('q8_0'), layout: 'split', reuse: 256 }, 32768).extraArgs).toEqual(['--metrics', '--no-kv-unified', '--cache-reuse', '256']);
    // A build that cannot be told to split: nothing to pass (and nothing to choose).
    const plain = llamaSpace({ budget: 'fast', params: P(), users: 4 });
    expect(plain.base('f16')).toMatchObject({ layout: 'split', reuse: 0 });
    expect(plain.dimensions.map((d) => d.key)).toEqual(['fa', 'ub']);
    expect(plain.params({ ...plain.base('f16'), layout: 'split' }, 32768).extraArgs).toEqual([]);
    // Thorough: the biggest ubatch with a build that lists -ub, pruned by the estimate.
    const big = llamaSpace({ budget: 'thorough', params: P(), flags: caps.flags });
    const ub = big.dimensions.find((d) => d.key === 'ub')!;
    expect(ub.values(big.base('f16'))).toEqual([512, 256, 1024, 2048, BIG_UBATCH]);
    expect([512, BIG_UBATCH].map((v) => ub.prune!(v))).toEqual([false, true]);
  });

  it('values that won before go first, nothing is dropped', () => {
    expect(preferFirst([512, 2048], [2048])).toEqual([2048, 512]);
    expect(preferFirst([512, 2048], [4096, 2048])).toEqual([2048, 512]);
    expect(preferFirst([512, 2048], undefined)).toEqual([512, 2048]);
    expect(preferFirst([512, 2048], [])).toEqual([512, 2048]);
    const s = llamaSpace({ budget: 'thorough', params: P(), prefer: { ub: [2048], b: [8192] } });
    const dims = Object.fromEntries(s.dimensions.map((d) => [d.key, d]));
    expect(dims.ub!.values(s.base('f16'))).toEqual([2048, 512, 256, 1024]);
    expect(dims.b!.values(s.base('f16'))).toEqual([8192, 2048, 512, 4096]);
    expect(vllmSpace({ budget: 'fast', params: P(), prefer: { bt: [8192] } }).dimensions[0]!.values({ kv: 'auto' })).toEqual([8192, 2048]);
  });

  it('vLLM: memory shares from the top down, block size and fp8 formats when listed, CUDA graph flags, users', () => {
    expect(vllmUtilizations(0.95)).toEqual([0.95, 0.9, 0.85, 0.8]);
    expect(vllmUtilizations(0.87)).toEqual([0.87, 0.85, 0.8]);
    expect(vllmUtilizations(0.9)).toEqual([0.9, 0.85, 0.8]);
    expect(vllmUtilizations(0.5)).toEqual([0.5]);
    expect(vllmUtilizations(undefined)).toEqual([0.95, 0.9, 0.85, 0.8]);
    expect(smallGraphSizes(1)).toEqual([1, 2, 4]);
    expect(smallGraphSizes(6)).toEqual([1, 2, 4, 8]);
    expect(graphSizeArgs(new Set(['--cuda-graph-sizes', '--compilation-config']), [1, 2, 4])).toEqual(['--cuda-graph-sizes', '1', '2', '4']);
    expect(graphSizeArgs(new Set(['--compilation-config']), [1, 2])).toEqual(['--compilation-config', '{"cudagraph_capture_sizes":[1,2]}']);
    expect(graphSizeArgs(new Set(), [1])).toBeUndefined();
    const choices = { '--block-size': ['16', '32'], '--kv-cache-dtype': ['auto', 'fp8', 'fp8_e4m3', 'fp8_e5m2'] };
    const flags = new Set(['--compilation-config', '--enable-prompt-tokens-details']);
    const s = vllmSpace({ budget: 'thorough', params: P(), users: 6, flags, choices });
    expect(s.dimensions.map((d) => [d.key, d.values(s.base('fp8'))])).toEqual([
      ['bt', [2048, 8192, 16384]],
      ['bs', [16, 32]],
      ['fp8', ['fp8_e4m3', 'fp8_e5m2']],
    ]);
    expect(s.dimensions[2]!.values(s.base('auto'))).toEqual([]);
    expect(s.base('fp8')).toEqual({ kv: 'fp8', bt: 2048, bs: 16, fp8: 'fp8_e4m3', np: 6 });
    expect(s.base('auto')).toEqual({ kv: 'auto', bt: 2048, bs: 16, np: 6 });
    expect(s.extensions).toEqual([{ graphs: 'small' }, { eager: true }]);
    expect(s.contextFor(6, 8192)).toBe(8192);
    expect(s.params({ ...s.base('fp8'), bs: 32, graphs: 'small' }, 8192)).toMatchObject({
      maxModelLen: 8192,
      parallel: 6,
      extraArgs: ['--compilation-config', '{"cudagraph_capture_sizes":[1,2,4,8]}', '--block-size', '32', '--kv-cache-dtype', 'fp8_e4m3', '--enable-prompt-tokens-details'],
    });
    // Eager wins over the capture sizes; "Veloce" or a vLLM without the choices: nothing extra.
    expect(s.params({ ...s.base('auto'), eager: true, graphs: 'small' }, 8192).extraArgs).toEqual(['--enforce-eager', '--enable-prompt-tokens-details']);
    const fast = vllmSpace({ budget: 'fast', params: P(), flags, choices });
    expect(fast.dimensions.map((d) => d.key)).toEqual(['bt']);
    expect(fast.base('fp8')).toEqual({ kv: 'fp8', bt: 2048 });
    expect(vllmSpace({ budget: 'thorough', params: P(), choices: { '--block-size': ['16'] } }).dimensions.map((d) => d.key)).toEqual(['bt']);
    expect(vllmSpace({ budget: 'fast', params: P() }).extensions).toEqual([{ eager: true }]);
  });

  it('the KV layout flag is added for several slots unless the extra arguments choose it', () => {
    const flags = new Set(['--kv-unified']);
    expect(llamaKvLayoutArgs(P({ parallel: 4 }), flags)).toEqual(['--kv-unified']);
    expect(llamaKvLayoutArgs(P({ parallel: 4, extraArgs: ['--no-kv-unified'] }), flags)).toEqual([]);
    expect(llamaKvLayoutArgs(P({ parallel: 4, extraArgs: ['-kvu'] }), flags)).toEqual([]);
    expect(llamaKvLayoutArgs(P({ parallel: 1 }), flags)).toEqual([]);
    expect(llamaKvLayoutArgs(P(), flags)).toEqual([]);
    expect(llamaKvLayoutArgs(P({ parallel: 4 }), new Set())).toEqual([]);
    // vLLM: an fp8 format in the extra arguments replaces --kv-cache-dtype fp8.
    expect(vllmKvDtype(P({ kvCacheType: 'fp8', extraArgs: ['--kv-cache-dtype', 'fp8_e5m2'] }))).toBeUndefined();
    const args = vllmServeArgs(P({ kvCacheType: 'fp8', extraArgs: ['--kv-cache-dtype', 'fp8_e5m2'] }), { model: 'a/b', positional: true, host: 'h', port: 1, servedName: 's' });
    expect(args.filter((a) => a === '--kv-cache-dtype')).toHaveLength(1);
    expect(args.slice(args.indexOf('--kv-cache-dtype'))).toEqual(['--kv-cache-dtype', 'fp8_e5m2']);
  });
});
