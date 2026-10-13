import { afterAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { launchParamsSchema, type LaunchParams } from '../../../../src/contract/engines';
import type { RunResult, Tuning } from '../../../../src/contract/results';
import { buildScenario } from '../../../../src/core/bench/scenarios';
import { buildTuneSetup, tunedServerParams } from '../../../../src/core/bench/tune-setup';
import type { EngineAdapter } from '../../../../src/core/engines/types';
import { summaryOf } from '../../../../src/core/store/runs-repo';
import { tempDir } from '../docker/helpers';
import { ninferModel } from '../engines/ninfer/helpers';
import { hardware, makeRun } from '../store/fixtures';
import { combo, point } from './tune-helpers';

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups) c();
});
const P = (o: object = {}) => launchParamsSchema.parse(o);
/** A NInfer build's capabilities: the KV types its --help lists (absent = the help did not say). */
const caps = (kvDtypes?: string[]) =>
  ({
    capabilities: async () => ({ flags: new Set(['--kv-dtype']), tokenIdsInPrompt: false, timings: true, minTokens: false, fitFlag: false, ...(kvDtypes ? { choices: { '--kv-dtype': kvDtypes } } : {}) }),
  }) as unknown as EngineAdapter;

describe('"Trova le impostazioni migliori" with NInfer', () => {
  it('searches NInfer\'s own space with its own estimate', async () => {
    const t = tempDir('gb-tune-setup-ninfer-');
    cleanups.push(t.cleanup);
    const model = ninferModel(path.join(t.dir, 'm'));
    const deps = {
      telemetry: { snapshot: async () => [{ t: 0, gpu: 0, utilPct: 1, memUsedMiB: 1600, memTotalMiB: 32_607, powerW: 30, tempC: 40, smClockMHz: 0, memClockMHz: 0, pcieGen: 5, pcieWidth: 16, throttle: [] }] },
      fingerprint: async () => hardware(),
    };
    const input = await buildTuneSetup(
      deps as never,
      { engine: { kind: 'ninfer-wsl' }, tune: { budget: 'thorough' } as never },
      { model, adapter: caps(), engine: { kind: 'ninfer-wsl' }, params: P({ ninfer: { prefixReuse: false, thinking: false } }), launch: { modelBytes: 4096 }, scenario: buildScenario('tune') },
    );
    expect(input.space.dimensions.map((d) => d.key)).toEqual(['spec', 'draft', 'lmhead', 'kv8', 'vision']);
    // "Più utenti": NInfer's lanes for them.
    const multi = await buildTuneSetup(
      deps as never,
      { engine: { kind: 'ninfer-wsl' }, tune: { budget: 'fast', goal: 'multi', users: 4 } as never },
      { model, adapter: caps(), engine: { kind: 'ninfer-wsl' }, params: P(), launch: { modelBytes: 4096 }, scenario: buildScenario('tune') },
    );
    expect(multi.space.base('bf16')).toMatchObject({ np: 4 });
    expect(input.predict?.(P({ contextSize: 4096 }))).toMatchObject({ basis: 'file-size', notes: ['ninfer.estimate'] });
    expect(input.space.kvLadder).toEqual(['bf16', 'int8', 'k8v4', 'nvfp4']);
    // A variant whose --help lists rk8v4 (NInfer-all): searched after int8; a build without k8v4 is not asked for it.
    const variant = await buildTuneSetup(
      deps as never,
      { engine: { kind: 'ninfer-wsl', customEngineId: 'ninfer-all' }, tune: { budget: 'thorough' } as never },
      {
        model,
        adapter: caps(['bf16', 'int8', 'fp8', 'rk8v4', 'rk4v4', 'nvfp4']),
        engine: { kind: 'ninfer-wsl' },
        params: P(),
        launch: { modelBytes: 4096 },
        scenario: buildScenario('tune'),
      },
    );
    expect(variant.space.kvLadder).toEqual(['bf16', 'int8', 'rk8v4', 'nvfp4']);
    expect(variant.space.params(variant.space.base('rk8v4'), 65_536).ninfer).toMatchObject({ kvDtype: 'rk8v4', kvCapacity: 65_536 });
    // Its estimate counts rk8v4 as k8v4: an 8-bit K and a 4-bit V, about 3/4 of int8.
    const int8 = variant.predict?.(variant.space.params(variant.space.base('int8'), 131_072)) as { kvMiB: number };
    const rk = variant.predict?.(variant.space.params(variant.space.base('rk8v4'), 131_072)) as { kvMiB: number };
    expect(rk.kvMiB / int8.kvMiB).toBeCloseTo(0.77, 1);
    // A build that lists no rk8v4 (and no k8v4): neither is searched.
    const plain = await buildTuneSetup(
      deps as never,
      { engine: { kind: 'ninfer-wsl' }, tune: { budget: 'thorough' } as never },
      { model, adapter: caps(['bf16', 'int8', 'fp8', 'nvfp4']), engine: { kind: 'ninfer-wsl' }, params: P(), launch: { modelBytes: 4096 }, scenario: buildScenario('tune') },
    );
    expect(plain.space.kvLadder).toEqual(['bf16', 'int8', 'nvfp4']);
    // A build that cannot be asked: the official ladder.
    const failing = { capabilities: async () => Promise.reject(new Error('gone')) } as unknown as EngineAdapter;
    const official = await buildTuneSetup(
      deps as never,
      { engine: { kind: 'ninfer-wsl' }, tune: { budget: 'fast' } as never },
      { model, adapter: failing, engine: { kind: 'ninfer-wsl' }, params: P(), launch: { modelBytes: 4096 }, scenario: buildScenario('tune') },
    );
    expect(official.space.kvLadder).toEqual(['bf16', 'int8', 'nvfp4']);
  });

  it('a server from the search keeps NInfer\'s own prefix reuse and thinking', async () => {
    const params: LaunchParams = P({ contextSize: 131_072, parallel: 1, ninfer: { kvCapacity: 131_072, kvDtype: 'int8', spec: 'mtp', draftTokens: 3, prefixReuse: false, thinking: false } });
    const tuning: Tuning = {
      budget: 'fast',
      maxLaunches: 24,
      dimensions: [],
      capacity: [],
      depths: [1024],
      attempts: [],
      combinations: [combo('int8', 131_072, [point(1024, 120)], { params })],
      recommended: 0,
      fastestByDepth: [{ depth: 1024, combination: 0 }],
    };
    const run: RunResult = makeRun({ id: 'TUNE-N', engine: { kind: 'ninfer-wsl', name: 'NInfer' }, scenario: { profile: 'tune', seed: 42, steps: [] }, tuning });
    const runs = { tried: async () => [summaryOf(run, 'f.json')], get: async () => run };
    const here = { hostId: 'host-a', gpuUuid: 'GPU-aaaa', gpuName: 'NVIDIA GeForce RTX 5090' };
    const served = await tunedServerParams(runs, here, { engine: { kind: 'ninfer-wsl' }, model: {} }, { identity: run.model as never });
    expect(served?.params.ninfer).toEqual({ kvCapacity: 131_072, kvDtype: 'int8', spec: 'mtp', draftTokens: 3 });
  });
});
