// Benchmarks on SGLang, command engines and forks: what the plan asks of them and says about them.
import { afterEach, describe, expect, it } from 'vitest';
import { launchParamsSchema } from '../../../../src/contract/engines';
import { autoLaunchParams, buildScenario, VLLM_PROMPT_DETAILS_FLAG } from '../../../../src/core/bench/scenarios';
import { BenchService, launchWarnings, serverContextOf } from '../../../../src/core/bench/service';
import { SGLANG_FP8, sglangSpace } from '../../../../src/core/bench/tune-space';
import type { EngineAdapter, LaunchPlan } from '../../../../src/core/engines/types';
import { request, serviceSetup, TempDirs } from './service-helpers';

const tmp = new TempDirs();
afterEach(() => tmp.cleanup());
const P = (o: object = {}) => launchParamsSchema.parse(o);

describe('launch settings per engine', () => {
  it('SGLang gets vLLM-like settings, without vLLM-only flags', () => {
    const full = buildScenario('full');
    const sg = autoLaunchParams('sglang-docker', full, P(), 32768);
    expect(sg.maxModelLen).toBeGreaterThan(0);
    expect(sg.parallel).toBeGreaterThan(1);
    expect(sg.extraArgs).not.toContain(VLLM_PROMPT_DETAILS_FLAG);
    expect(autoLaunchParams('vllm-docker', full, P(), 32768).extraArgs).toContain(VLLM_PROMPT_DETAILS_FLAG);
    expect(serverContextOf('sglang-native', P({ maxModelLen: 8192 }))).toBe(8192);
  });

  it('a command engine gets a context and the users at once (for {ctx} and {parallel})', () => {
    const p = autoLaunchParams('command', buildScenario('standard'), P(), 32768);
    expect(p.contextSize).toBeGreaterThan(0);
    expect(p.parallel).toBe(4);
    expect(autoLaunchParams('command', buildScenario('standard'), P({ contextSize: 2048 })).contextSize).toBe(2048);
    expect(autoLaunchParams('command', { profile: 'custom', seed: 1, steps: [] }, P()).contextSize).toBeUndefined();
  });

  it('a fork that lacks flags gives one plain-words warning', () => {
    const plan = { engine: { kind: 'llamacpp-native', name: 'PrismML fork' }, unsupported: [{ flag: '-ub', setting: 'ubatchSize', effect: 'default' as const }, { flag: '-t', setting: 'threads', effect: 'default' as const }] };
    expect(launchWarnings(plan as Pick<LaunchPlan, 'engine' | 'unsupported'>)).toEqual([{ code: 'flag_unsupported', params: { engine: 'PrismML fork', flags: '-ub -t', settings: 'ubatchSize,threads' } }]);
    expect(launchWarnings({ engine: { kind: 'llamacpp-native', name: 'x' } })).toEqual([]);
  });
});

describe('the bench service', () => {
  it('previews a fork run with its warning, and stores it in the run notes', async () => {
    const s = serviceSetup(tmp);
    const base = s.deps.getAdapter('llamacpp-native');
    const forkAdapter: EngineAdapter = {
      ...base,
      kind: 'llamacpp-native',
      detect: (c) => base.detect(c),
      capabilities: (c) => base.capabilities(c),
      start: (p, sig) => base.start(p, sig),
      plan: async (...args) => ({ ...(await base.plan(...args)), unsupported: [{ flag: '-ub', setting: 'ubatchSize', effect: 'default' }] }),
    };
    const svc = new BenchService({ ...s.deps, getAdapter: () => forkAdapter });
    const plan = await svc.plan(request());
    expect(plan.warnings).toContainEqual({ code: 'flag_unsupported', params: { engine: 'llama.cpp', flags: '-ub', settings: 'ubatchSize' } });
    const server = await svc.planServer(request());
    expect(server.warnings.map((w) => w.code)).toContain('flag_unsupported');
  });

  it('a command engine has nothing to tune', async () => {
    const s = serviceSetup(tmp, { adapter: { kind: 'command' } });
    const svc = new BenchService(s.deps);
    await expect(svc.plan(request({ profile: 'tune', engine: { kind: 'command', command: 'srv --port {port}' } }))).rejects.toMatchObject({ code: 'VALIDATION', params: { reason: 'tune_command' } });
  });

  it('an SGLang server is sized by context length, like vLLM', async () => {
    const s = serviceSetup(tmp, { adapter: { kind: 'sglang-docker' } });
    const svc = new BenchService(s.deps);
    const plan = await svc.planServer(request({ engine: { kind: 'sglang-docker' } }));
    expect(plan.params.maxModelLen).toBe(plan.contextSize);
    expect(plan.params.contextSize).toBeUndefined();
  });
});

describe('SGLang search space', () => {
  const v = (o: Record<string, unknown>) => o as never;

  it('searches the batched tokens, the memory share and, thoroughly, both fp8 formats', () => {
    const space = sglangSpace({ budget: 'thorough', params: P({ extraArgs: ['--page-size', '16'] }), utilizations: [0.9, 0.85], users: 4, flags: new Set(['--cuda-graph-max-bs']), choices: { '--kv-cache-dtype': ['auto', ...SGLANG_FP8] } });
    expect(space.kvLadder).toEqual(['auto', 'fp8']);
    expect(space.base('fp8')).toEqual({ kv: 'fp8', bt: 2048, fp8: 'fp8_e5m2', np: 4 });
    expect(space.base('auto')).toEqual({ kv: 'auto', bt: 2048, np: 4 });
    expect(space.dimensions.map((d) => d.key)).toEqual(['bt', 'fp8']);
    expect(space.dimensions[1]?.values(v({ kv: 'fp8' }))).toEqual(['fp8_e5m2', 'fp8_e4m3']);
    expect(space.dimensions[1]?.values(v({ kv: 'auto' }))).toEqual([]);
    expect(space.startup).toEqual({ key: 'gmu', values: [0.9, 0.85] });
    expect(space.extensions).toEqual([{ graphs: 'small' }, { eager: true }]);
    expect(space.contextFor(4, 8192)).toBe(8192);
    expect(space.params(v({ kv: 'fp8', bt: 8192, fp8: 'fp8_e4m3', np: 4, gmu: 0.85, graphs: 'small' }), 32768)).toMatchObject({
      maxModelLen: 32768,
      kvCacheType: 'fp8',
      batchSize: 8192,
      parallel: 4,
      gpuMemoryUtilization: 0.85,
      extraArgs: ['--page-size', '16', '--cuda-graph-max-bs', '4', '--kv-cache-dtype', 'fp8_e4m3'],
    });
    expect(space.params(v({ kv: 'fp8', bt: 2048, fp8: 'fp8_e5m2', eager: true }), 4096).extraArgs).toEqual(['--page-size', '16', '--disable-cuda-graph']);
    expect(space.tags(v({ eager: true }))).toEqual(['eager']);
  });

  it('a quick search keeps to the essentials', () => {
    const space = sglangSpace({ budget: 'fast', params: P() });
    expect(space.dimensions.map((d) => d.key)).toEqual(['bt']);
    expect(space.dimensions[0]?.values(v({}))).toEqual([2048, 8192]);
    expect(space.startup).toBeUndefined();
    expect(space.extensions).toEqual([{ eager: true }]);
    expect(space.base('fp8')).toEqual({ kv: 'fp8', bt: 2048 });
    expect(space.params(v({ kv: 'auto', bt: 2048 }), 4096)).toMatchObject({ parallel: 1, extraArgs: [] });
    expect(space.params(v({ kv: 'auto', bt: 2048 }), 4096)).not.toHaveProperty('gpuMemoryUtilization');
    const single = sglangSpace({ budget: 'fast', params: P(), flags: new Set(['--cuda-graph-max-bs']) });
    expect(single.params(v({ kv: 'auto', bt: 2048, graphs: 'small' }), 4096).extraArgs).toEqual(['--cuda-graph-max-bs', '1']);
  });
});
