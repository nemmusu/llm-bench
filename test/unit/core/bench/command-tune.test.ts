// "Trova le impostazioni migliori" on a program with an OpenAI API: what its placeholders let the search
// try ({ctx} always, {kv} in the user's list, {ubatch}, {batch}, {parallel}), how a plan asks for it, and
// the users a run with several of them passes to {parallel}.
import { describe, expect, it } from 'vitest';
import { launchParamsSchema } from '../../../../src/contract/engines';
import type { RunResult, Tuning } from '../../../../src/contract/results';
import { autoLaunchParams, buildScenario } from '../../../../src/core/bench/scenarios';
import { BenchService } from '../../../../src/core/bench/service';
import { buildTuneSetup, learnedOrder, type TunePrepared } from '../../../../src/core/bench/tune-setup';
import { commandSpace } from '../../../../src/core/bench/tune-space';
import type { EngineAdapter, EngineCaps } from '../../../../src/core/engines/types';
import { summaryOf } from '../../../../src/core/store/runs-repo';
import { hardware, makeRun, modelIdentity } from '../store/fixtures';
import { request, serviceSetup, TempDirs } from './service-helpers';
import { combo, point } from './tune-helpers';
import { afterEach } from 'vitest';

const tmp = new TempDirs();
afterEach(() => tmp.cleanup());
const P = (o: object = {}) => launchParamsSchema.parse(o);
const caps = (command?: EngineCaps['command']): EngineCaps => ({ flags: new Set(), tokenIdsInPrompt: false, timings: false, minTokens: false, fitFlag: false, variant: 'openai', ...(command ? { command } : {}) });

describe('the search space of a program', () => {
  it('KV types, ubatch and batch only when its commands take them; users for goal multi', () => {
    const full = commandSpace({ budget: 'fast', params: P({ threads: 4, kvCacheType: 'q4_0', extraArgs: ['--x'] }), settings: ['ctx', 'kv', 'parallel', 'batch', 'ubatch'], kvTypes: ['f16', 'q8_0'], users: 4, prefer: { ub: [2048] } });
    expect(full.kvLadder).toEqual(['f16', 'q8_0']);
    expect(full.dimensions.map((d) => [d.key, d.values({})])).toEqual([
      ['ub', [2048, 512]],
      ['b', [2048, 8192]],
    ]);
    expect(full.base('q8_0')).toEqual({ kv: 'q8_0', ub: 512, b: 2048, np: 4 });
    expect(full.contextFor(4, 8192)).toBe(32768);
    // The user's other settings stay, the searched ones are the search's.
    expect(full.params({ kv: 'q8_0', ub: 2048, b: 8192, np: 4 }, 16384)).toEqual({ threads: 4, contextSize: 16384, kvCacheType: 'q8_0', ubatchSize: 2048, batchSize: 8192, parallel: 4, extraArgs: ['--x'], env: {} });
    expect(full.params({ kv: 'f16' }, 4096)).toMatchObject({ kvCacheType: 'f16', parallel: 1 });
    expect(full.tags({ kv: 'f16' })).toEqual([]);
    // Only {ctx}: one KV type (the program's own), nothing else to try.
    const ctx = commandSpace({ budget: 'thorough', params: P(), settings: ['ctx'], kvTypes: ['f16'] });
    expect(ctx.kvLadder).toEqual(['auto']);
    expect(ctx.dimensions).toEqual([]);
    expect(ctx.base('auto')).toEqual({ kv: 'auto' });
    expect(ctx.params({ kv: 'auto' }, 8192)).toEqual({ contextSize: 8192, extraArgs: [], env: {} });
    const thorough = commandSpace({ budget: 'thorough', params: P(), settings: ['ctx', 'batch'], kvTypes: ['f16'], users: 1 });
    expect(thorough.dimensions.map((d) => d.values({}))).toEqual([[2048, 8192, 16384]]);
    expect(thorough.base('auto')).toEqual({ kv: 'auto', b: 2048 });
  });

  it('the tuner gets it from the engine’s capabilities', async () => {
    const prepared = (c: EngineCaps): TunePrepared => ({
      model: { identity: modelIdentity() },
      adapter: { capabilities: async () => c } as unknown as EngineAdapter,
      engine: { kind: 'command', customEngineId: 'srv' },
      params: P(),
      launch: { modelBytes: 1_000_000_000 },
      scenario: buildScenario('tune'),
    });
    const deps = { telemetry: { snapshot: async () => [] }, fingerprint: async () => hardware() };
    const s = await buildTuneSetup(deps, { engine: { kind: 'command' }, tune: { budget: 'fast', fidelity: false, goal: 'multi', users: 2 } }, prepared(caps({ settings: ['ctx', 'kv', 'parallel'], kvTypes: ['auto', 'fp8'] })));
    expect(s.space.kvLadder).toEqual(['auto', 'fp8']);
    expect(s.space.base('fp8')).toEqual({ kv: 'fp8', np: 2 });
    expect(s).not.toHaveProperty('offload');
    const single = await buildTuneSetup(deps, { engine: { kind: 'command' } }, prepared(caps({ settings: ['ctx', 'ubatch'], kvTypes: ['f16'] })));
    expect(single.space.dimensions.map((d) => d.key)).toEqual(['ub']);
  });

  it('ubatch and batch that won before are tried first, as for llama.cpp', async () => {
    const here = { hostId: 'host-a', gpuUuid: 'GPU-aaaa', gpuName: 'NVIDIA GeForce RTX 5090' };
    const run = (id: string, c: Tuning['combinations'][number]): RunResult => {
      const tuning: Tuning = { budget: 'fast', maxLaunches: 24, dimensions: [], capacity: [], depths: [], attempts: [], combinations: [c], recommended: 0, fastestByDepth: [] };
      return makeRun({ id, scenario: { profile: 'tune', seed: 42, steps: [] }, engine: { kind: 'command', name: 'Srv' }, model: modelIdentity(), tuning });
    };
    const withVariant = run('A', combo('f16', 8192, [point(1024, 1)], { variant: { kv: 'f16', ub: 2048 } }));
    // Saved without its variant: read back from the params like llama.cpp's.
    const old = run('B', combo('f16', 8192, [point(1024, 1)], { params: P({ ubatchSize: 2048, batchSize: 4096 }) }));
    const runs = [withVariant, old];
    const repo = { list: async () => runs.map((r) => summaryOf(r, `${r.id}.json`)), get: async (id: string) => runs.find((r) => r.id === id) };
    expect((await learnedOrder(repo, here, 'command'))?.prefer).toEqual({ ub: [2048], b: [4096] });
  });
});

describe('plans of a program', () => {
  it('a run with several users passes them to {parallel}', () => {
    const p = autoLaunchParams('command', buildScenario('full'), P(), 32768);
    expect(p.parallel).toBeGreaterThan(1);
    expect(autoLaunchParams('command', buildScenario('full'), P({ parallel: 2 }), 32768).parallel).toBe(2);
  });

  it('the search is offered when its commands take {ctx}', async () => {
    const s = serviceSetup(tmp, { adapter: { kind: 'command' } });
    s.adapter.capabilities = async () => caps({ settings: ['ctx', 'kv'], kvTypes: ['f16', 'q8_0'] });
    const svc = new BenchService(s.deps);
    const plan = await svc.plan(request({ profile: 'tune', engine: { kind: 'command', customEngineId: 'srv' } }));
    expect(plan.scenario.profile).toBe('tune');
    expect(plan.tuneSeconds?.fast).toBeGreaterThan(0);
    s.adapter.capabilities = async () => caps({ settings: ['kv'], kvTypes: ['f16'] });
    await expect(svc.plan(request({ profile: 'tune', engine: { kind: 'command', customEngineId: 'srv' } }))).rejects.toMatchObject({ code: 'VALIDATION', params: { reason: 'tune_command' } });
    s.adapter.capabilities = () => Promise.reject(new Error('gone'));
    await expect(svc.plan(request({ profile: 'tune', engine: { kind: 'command', customEngineId: 'srv' } }))).rejects.toMatchObject({ params: { reason: 'tune_command' } });
  });
});
