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
      { model, adapter: {} as EngineAdapter, engine: { kind: 'ninfer-wsl' }, params: P({ ninfer: { prefixReuse: false, thinking: false } }), launch: { modelBytes: 4096 }, scenario: buildScenario('tune') },
    );
    expect(input.space.dimensions.map((d) => d.key)).toEqual(['spec', 'draft', 'lmhead', 'kv8', 'vision']);
    // "Più utenti": NInfer's lanes for them.
    const multi = await buildTuneSetup(
      deps as never,
      { engine: { kind: 'ninfer-wsl' }, tune: { budget: 'fast', goal: 'multi', users: 4 } as never },
      { model, adapter: {} as EngineAdapter, engine: { kind: 'ninfer-wsl' }, params: P(), launch: { modelBytes: 4096 }, scenario: buildScenario('tune') },
    );
    expect(multi.space.base('bf16')).toMatchObject({ np: 4 });
    expect(input.predict?.(P({ contextSize: 4096 }))).toMatchObject({ basis: 'file-size', notes: ['ninfer.estimate'] });
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
