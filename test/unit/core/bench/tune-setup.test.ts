import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { launchParamsSchema, type LaunchParams } from '../../../../src/contract/engines';
import type { GpuSample } from '../../../../src/contract/hardware';
import type { RunResult, RunSummary, Tuning } from '../../../../src/contract/results';
import { buildScenario } from '../../../../src/core/bench/scenarios';
import { buildTuneSetup, latestTuneRun, tunedServerParams, vllmTuneUtilization, type TunePrepared } from '../../../../src/core/bench/tune-setup';
import { capsFromOutputs } from '../../../../src/core/engines/llamacpp-native/caps';
import type { EngineAdapter } from '../../../../src/core/engines/types';
import { summaryOf } from '../../../../src/core/store/runs-repo';
import { hardware, makeRun, modelIdentity } from '../store/fixtures';
import { combo, point } from './tune-helpers';

const HELP = readFileSync(new URL('../../../fixtures/llamacpp/help.stdout.txt', import.meta.url), 'utf8');
const P = (o: object = {}) => launchParamsSchema.parse(o);

const sample = (over: Partial<GpuSample> = {}): GpuSample => ({
  t: 0,
  gpu: 0,
  utilPct: 1,
  memUsedMiB: 1600,
  memTotalMiB: 32607,
  powerW: 30,
  tempC: 40,
  smClockMHz: 200,
  memClockMHz: 400,
  pcieGen: 5,
  pcieWidth: 16,
  throttle: [],
  ...over,
});

const facts = { contextLength: 40960, blockCount: 48, headCount: 32, headCountKv: 4, keyLength: 128, valueLength: 128, embeddingLength: 2048 };

function prepared(over: Partial<TunePrepared> = {}, caps: unknown = capsFromOutputs('', HELP)): TunePrepared {
  return {
    model: {
      identity: modelIdentity({ facts }),
      local: { id: 'm', identity: modelIdentity(), paths: ['C:/m/a.gguf', 'C:/m/a-draft.gguf'], auxiliary: [{ kind: 'draft', path: 'C:/m/a-draft.gguf' }], dir: 'C:/m', origin: 'library', modifiedAt: '' },
    },
    adapter: { capabilities: async () => caps } as unknown as EngineAdapter,
    engine: { kind: 'llamacpp-native' },
    params: P({ threads: 4 }),
    launch: { modelBytes: 2_000_000_000 },
    scenario: buildScenario('tune'),
    ...over,
  };
}

describe('buildTuneSetup', () => {
  const deps = (o: { samples?: GpuSample[] | 'throw'; platform?: 'win32' | 'linux'; wsl?: boolean; fingerprint?: 'throw' } = {}) => ({
    telemetry: { snapshot: async () => (o.samples === 'throw' ? Promise.reject(new Error('x')) : (o.samples ?? [sample()])) },
    fingerprint: async () => {
      if (o.fingerprint === 'throw') throw new Error('no fp');
      return hardware({ os: { platform: o.platform ?? 'win32', release: '', arch: 'x64', name: '', isWsl: o.wsl ?? false } });
    },
  });

  it('llama.cpp on Windows: spills possible, the estimate on the free VRAM, speculative decoding and the MoE fallback from the build', async () => {
    const moe = prepared({ model: { ...prepared().model, identity: modelIdentity({ facts: { ...facts, expertCount: 128 } }) } });
    const s = await buildTuneSetup(deps(), { engine: { kind: 'llamacpp-native' }, tune: { budget: 'thorough', fidelity: true } }, moe);
    expect(s).toMatchObject({ budget: 'thorough', fidelity: true, spillPossible: true, modelContext: 40960, sweep: { outputTokens: 128, reps: 2 }, offload: { layers: 48, moe: true } });
    expect(s.space.kvLadder).toEqual(['f16', 'q8_0', 'q4_0']);
    expect(s.space.dimensions.map((d) => d.key)).toEqual(['fa', 'ub', 'b', 'draft']);
    expect(s.space.params({ ...s.space.base('f16'), draft: true }, 8192).extraArgs).toEqual(['--spec-type', 'draft-simple', '-md', 'C:/m/a-draft.gguf', '-ngld', 'all']);
    const est = s.predict!(s.space.params(s.space.base('f16'), 8192));
    expect(est).toMatchObject({ availableMiB: 32607 - 1600, contextSize: 8192, basis: 'file-size' });
  });

  it('defaults (fast, no fidelity), Linux without spills, WSL with them, no GPU reading, no caps, no facts', async () => {
    const p = prepared({ model: { identity: modelIdentity() }, launch: { modelBytes: 0 }, scenario: { profile: 'tune', seed: 1, steps: [] } }, undefined);
    const s = await buildTuneSetup(deps({ samples: 'throw', platform: 'linux' }), { engine: { kind: 'llamacpp-docker' } }, p);
    expect(s).toMatchObject({ budget: 'fast', fidelity: false, spillPossible: false, sweep: { outputTokens: 128, reps: 2 } });
    expect(s).not.toHaveProperty('predict');
    expect(s).not.toHaveProperty('offload');
    expect(s).not.toHaveProperty('modelContext');
    expect(s.space.dimensions.map((d) => d.key)).toEqual(['fa', 'ub']);
    expect((await buildTuneSetup(deps({ platform: 'linux', wsl: true }), { engine: { kind: 'llamacpp-native' } }, prepared())).spillPossible).toBe(true);
    expect((await buildTuneSetup(deps({ fingerprint: 'throw' }), { engine: { kind: 'llamacpp-native' } }, prepared())).spillPossible).toBe(false);
    // No memory reading: no estimate. Caps that fail: no speculative decoding, offload by layers.
    const noMem = await buildTuneSetup(deps({ samples: [sample({ memUsedMiB: null })] }), { engine: { kind: 'llamacpp-native' } }, prepared({ adapter: { capabilities: () => Promise.reject(new Error('x')) } as unknown as EngineAdapter }));
    expect(noMem).not.toHaveProperty('predict');
    expect(noMem.offload).toEqual({ layers: 48, moe: false });
    expect(noMem.space.dimensions.map((d) => d.key)).toEqual(['fa', 'ub']);
    // Size from the identity when the files were not stat'ed.
    const sized = await buildTuneSetup(deps(), { engine: { kind: 'llamacpp-native' } }, prepared({ launch: { modelBytes: 0 } }));
    expect(sized.predict!(P({ contextSize: 4096 }))?.weightsMiB).toBeGreaterThan(0);
    const unsized = await buildTuneSetup(deps(), { engine: { kind: 'llamacpp-native' } }, prepared({ launch: { modelBytes: 0 }, model: { identity: { ...modelIdentity({ facts }), sizeBytes: undefined } } }));
    expect(unsized.predict!(P({ contextSize: 4096 }))?.basis).toBe('params-heuristic');
  });

  it('vLLM: auto / fp8, the memory share fitted to the free VRAM, eager as a last resort', async () => {
    const s = await buildTuneSetup(deps({ samples: [sample({ memUsedMiB: 2000 })] }), { engine: { kind: 'vllm-docker' } }, prepared({ engine: { kind: 'vllm-docker' } }));
    expect(s.space.extensions).toEqual([{ eager: true }]);
    expect(s.space.kvLadder).toEqual(['auto', 'fp8']);
    // The memory share fitted to the free VRAM first, then the usual steps below it.
    expect(s.space.startup).toEqual({ key: 'gmu', values: [0.91, 0.9, 0.85, 0.8] });
    const tight = await buildTuneSetup(deps({ samples: [sample({ memUsedMiB: 30000 })] }), { engine: { kind: 'vllm-native' } }, prepared());
    expect(tight.space.startup).toBeUndefined();
    expect(tight.space.params(tight.space.base('auto'), 8192)).not.toHaveProperty('gpuMemoryUtilization');
    expect(vllmTuneUtilization(undefined)).toBeUndefined();
    expect(vllmTuneUtilization({ totalMiB: 32000, freeMiB: 31000 })).toBe(0.94);
    expect(vllmTuneUtilization({ totalMiB: 32000, freeMiB: 32000 })).toBe(0.95);
  });

  it('SGLang: the same memory share fitting, its own space (graphs off as the last resort)', async () => {
    const s = await buildTuneSetup(deps({ samples: [sample({ memUsedMiB: 2000 })] }), { engine: { kind: 'sglang-docker' } }, prepared({ engine: { kind: 'sglang-docker' } }));
    expect(s.space.kvLadder).toEqual(['auto', 'fp8']);
    expect(s.space.startup).toEqual({ key: 'gmu', values: [0.91, 0.9, 0.85, 0.8] });
    expect(s.space.params({ ...s.space.base('auto'), eager: true }, 4096).extraArgs).toContain('--disable-cuda-graph');
  });
});

/** A completed tune run whose recommendation is q4_0 at 40K with ub 2048. */
function tuneRun(over: Partial<RunResult> = {}): RunResult {
  const params: LaunchParams = P({ contextSize: 40960, kvCacheType: 'q4_0', flashAttention: 'on', ubatchSize: 2048, batchSize: 2048, parallel: 1, extraArgs: ['--metrics'], env: { A: '1' } });
  const tuning: Tuning = {
    budget: 'fast',
    maxLaunches: 24,
    dimensions: [],
    capacity: [],
    depths: [1024],
    attempts: [],
    combinations: [combo('q4_0', 40960, [point(1024, 100)], { params })],
    recommended: 0,
    fastestByDepth: [{ depth: 1024, combination: 0 }],
  };
  return makeRun({ id: 'TUNE-A', scenario: { profile: 'tune', seed: 42, steps: [] }, tuning, ...over });
}

const here = { hostId: 'host-a', gpuUuid: 'GPU-aaaa', gpuName: 'NVIDIA GeForce RTX 5090' };

describe('tune recommendation for "Avvia solo il server"', () => {
  const summary = (r: RunResult, over: Partial<RunSummary> = {}): RunSummary => ({ ...summaryOf(r, 'f.json'), ...over });

  it('latestTuneRun: completed, measured, this PC and card, same engine family', () => {
    const ok = summary(tuneRun());
    expect(latestTuneRun([ok], here, 'llamacpp-docker')).toBe(ok);
    expect(latestTuneRun([ok], here, 'vllm-docker')).toBeUndefined();
    expect(latestTuneRun([ok], { hostId: 'host-a' }, 'llamacpp-native')).toBe(ok);
    expect(latestTuneRun([summary(tuneRun(), { gpuUuid: undefined } as Partial<RunSummary>)], here, 'llamacpp-native')).toBeDefined();
    for (const bad of [
      summary(makeRun()),
      summary(tuneRun(), { status: 'failed' }),
      summary(tuneRun(), { tunedCombinations: 0 }),
      summary(tuneRun(), { tunedCombinations: undefined } as Partial<RunSummary>),
      summary(tuneRun(), { hostId: 'other' }),
      summary(tuneRun(), { gpuUuid: 'GPU-bbbb' }),
    ]) {
      expect(latestTuneRun([bad], here, 'llamacpp-native')).toBeUndefined();
    }
    const vllmRun = summary(tuneRun({ engine: { kind: 'vllm-docker', name: 'vLLM' } }));
    expect(latestTuneRun([vllmRun], here, 'vllm-native')).toBe(vllmRun);
    expect(latestTuneRun([summary(tuneRun({ engine: { kind: 'external', name: 'x' } }))], here, 'external')).toBeDefined();
  });

  it('the recommended combination, the user’s explicit choices winning', async () => {
    const run = tuneRun();
    const runs = { tried: async () => [summary(run)], get: async () => run };
    const model = { identity: modelIdentity({ sha256: 'abc' }) };
    const plain = await tunedServerParams(runs, here, { engine: { kind: 'llamacpp-native' }, model: { localId: 'm' } }, model);
    expect(plain).toEqual({
      params: run.tuning!.combinations[0]!.params,
      tuned: { runId: 'TUNE-A', createdAt: run.createdAt, contextSize: 40960, kvCacheType: 'q4_0' },
    });
    const mine = await tunedServerParams(runs, here, { engine: { kind: 'llamacpp-native' }, model: {}, params: P({ threads: 8, ubatchSize: 512, extraArgs: ['--no-mmap'], env: { B: '2' } }) }, model);
    expect(mine?.params).toMatchObject({ contextSize: 40960, kvCacheType: 'q4_0', threads: 8, ubatchSize: 512, extraArgs: ['--no-mmap'], env: { A: '1', B: '2' } });
    const keepArgs = await tunedServerParams(runs, here, { engine: { kind: 'llamacpp-native' }, model: {}, params: P() }, model);
    expect(keepArgs?.params.extraArgs).toEqual(['--metrics']);
  });

  it('nothing without a usable tune run', async () => {
    const model = { identity: modelIdentity() };
    const req = { engine: { kind: 'llamacpp-native' as const }, model: {} };
    expect(await tunedServerParams({ tried: async () => [], get: async () => undefined }, here, req, model)).toBeUndefined();
    expect(await tunedServerParams({ tried: () => Promise.reject(new Error('x')), get: async () => undefined }, here, req, model)).toBeUndefined();
    const run = tuneRun();
    const s = summaryOf(run, 'f');
    expect(await tunedServerParams({ tried: async () => [s], get: () => Promise.reject(new Error('gone')) }, here, req, model)).toBeUndefined();
    const noRec = tuneRun({ tuning: { ...run.tuning!, recommended: undefined } as Tuning });
    expect(await tunedServerParams({ tried: async () => [s], get: async () => noRec }, here, req, model)).toBeUndefined();
    expect(await tunedServerParams({ tried: async () => [s], get: async () => makeRun() }, here, req, model)).toBeUndefined();
  });
});
