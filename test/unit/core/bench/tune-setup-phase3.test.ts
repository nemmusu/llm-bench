/**
 * Phase 3 glue: the goal of a request, values that won before on this GPU, the setup of goal 'multi'
 * and vLLM's options, the run a "Ricontrollo rapido" re-checks, tune results remembered per build.
 */
import { describe, expect, it } from 'vitest';
import { launchParamsSchema, type LaunchParams } from '../../../../src/contract/engines';
import type { GpuSample } from '../../../../src/contract/hardware';
import type { RunResult, Tuning } from '../../../../src/contract/results';
import { buildScenario } from '../../../../src/core/bench/scenarios';
import {
  buildTuneSetup,
  expectFromRuns,
  expectFromSize,
  latestTuneRun,
  learnedOrder,
  recheckInputOf,
  recheckSource,
  SLOW_SHARE_BYTES_PER_SEC,
  tuneExpectOf,
  tuneGoalOf,
  tunedServerParams,
  tuneRunsFor,
  type TunePrepared,
} from '../../../../src/core/bench/tune-setup';
import { NINFER_EXPECT } from '../../../../src/core/bench/tune-ninfer';
import type { EngineAdapter } from '../../../../src/core/engines/types';
import type { FitCalibration } from '../../../../src/core/models/fit';
import { summaryOf } from '../../../../src/core/store/runs-repo';
import { DEFAULT_LOAD_MS, DEFAULT_SPEED } from '../../../../src/core/bench/tuner';
import { hardware, latencyPoint, makeRun, modelIdentity } from '../store/fixtures';
import { combo, concurrencyPoint, point } from './tune-helpers';

const P = (o: object = {}) => launchParamsSchema.parse(o);
const here = { hostId: 'host-a', gpuUuid: 'GPU-aaaa', gpuName: 'NVIDIA GeForce RTX 5090' };
const facts = { contextLength: 40960, blockCount: 48, headCount: 32, headCountKv: 4, keyLength: 128, valueLength: 128, embeddingLength: 2048, architecture: 'qwen3' };

/** A completed tune run: recommendation and runner-up, by build, goal and budget. */
function tuneRun(o: { id?: string; build?: string; createdAt?: string; tuning?: Partial<Tuning>; engine?: RunResult['engine']; recommended?: number | undefined } = {}): RunResult {
  const q4 = combo('q4_0', 40960, [point(1024, 100), point(40816, 50)], {
    params: P({ contextSize: 40960, kvCacheType: 'q4_0', ubatchSize: 2048, batchSize: 4096 }),
    variant: { kv: 'q4_0', fa: 'on', ub: 2048, b: 4096 },
  });
  const q8 = combo('q8_0', 32768, [point(1024, 120), point(32624, 70)], { params: P({ contextSize: 32768, kvCacheType: 'q8_0', ubatchSize: 512, batchSize: 2048 }) });
  const tuning: Tuning = { budget: 'fast', maxLaunches: 24, dimensions: [], capacity: [], depths: [], attempts: [], combinations: [q4, q8], recommended: 0, fastestByDepth: [], ...o.tuning };
  if ('recommended' in o && o.recommended === undefined) delete tuning.recommended;
  return makeRun({
    id: o.id ?? 'TUNE-A',
    createdAt: o.createdAt ?? '2026-10-06T10:00:00.000Z',
    scenario: { profile: 'tune', seed: 42, steps: [] },
    engine: o.engine ?? { kind: 'llamacpp-native', name: 'llama.cpp', build: o.build ?? 'b11438' },
    model: modelIdentity({ facts }),
    tuning,
  });
}

const multiTuning = (users = 4, perUserContext = 8192): Partial<Tuning> => ({
  goal: 'multi',
  multi: { users, perUserContext, promptTokens: perUserContext - 144, outputTokens: 128, turns: 3 },
  combinations: [
    combo('q8_0', users * perUserContext, [], { params: P({ contextSize: users * perUserContext, parallel: users, extraArgs: ['--no-kv-unified'] }), concurrency: [concurrencyPoint(users, 80)], kvLayout: 'split' }),
    combo('q4_0', users * perUserContext, [], { concurrency: [concurrencyPoint(users, 50)] }),
  ],
});

const repo = (runs: RunResult[]) => ({
  list: async () => runs.map((r) => summaryOf(r, `${r.id}.json`)),
  tried: async () => runs.map((r) => summaryOf(r, `${r.id}.json`)),
  get: async (id: string) => runs.find((r) => r.id === id),
});

describe('the question of a tune request', () => {
  it('goal, users and context per user (defaults 4 × 8K)', () => {
    expect(tuneGoalOf({})).toEqual({ goal: 'single' });
    expect(tuneGoalOf({ tune: { budget: 'fast', fidelity: false } })).toEqual({ goal: 'single' });
    expect(tuneGoalOf({ tune: { budget: 'fast', fidelity: false, goal: 'multi' } })).toEqual({ goal: 'multi', users: 4, perUserContext: 8192 });
    expect(tuneGoalOf({ tune: { budget: 'fast', fidelity: false, goal: 'multi', users: 8, perUserContext: 16384 } })).toEqual({ goal: 'multi', users: 8, perUserContext: 16384 });
  });

  it('tune runs of the same question; summaries carry goal, users, budget and build', () => {
    const single = summaryOf(tuneRun(), 'a');
    const multi = summaryOf(tuneRun({ id: 'M', tuning: multiTuning() }), 'b');
    expect(multi).toMatchObject({ tuneGoal: 'multi', tuneUsers: 4, tunePerUserContext: 8192, tuneBudget: 'fast', engineBuild: 'b11438' });
    expect(single).not.toHaveProperty('tuneGoal');
    expect(tuneRunsFor([single, multi], here, 'llamacpp-native')).toEqual([single]);
    expect(tuneRunsFor([single, multi], here, 'llamacpp-native', { goal: 'multi', users: 4, perUserContext: 8192 })).toEqual([multi]);
    expect(tuneRunsFor([single, multi], here, 'llamacpp-native', { goal: 'multi', users: 8 })).toEqual([]);
    expect(tuneRunsFor([single, multi], here, 'llamacpp-native', { goal: 'multi', perUserContext: 4096 })).toEqual([]);
    const empty = summaryOf(tuneRun({ id: 'E', tuning: { combinations: [] }, recommended: undefined }), 'c');
    expect(tuneRunsFor([empty], here, 'llamacpp-native')).toEqual([]);
    expect(tuneRunsFor([empty], here, 'llamacpp-native', { goal: 'single' }, false)).toEqual([empty]);
    expect(latestTuneRun([single, multi], here, 'llamacpp-native', { goal: 'multi' })).toBe(multi);
  });
});

describe('values that won before on this GPU', () => {
  it('the recommended ubatch / batch of the latest tune runs here, the most frequent first', async () => {
    const a = tuneRun({ id: 'A' });
    const b = tuneRun({ id: 'B', createdAt: '2026-10-05T10:00:00.000Z' });
    // Saved before phase 3: no variant, read back from the params.
    const old = tuneRun({ id: 'C', createdAt: '2026-10-04T10:00:00.000Z', tuning: { combinations: [combo('q8_0', 32768, [point(1024, 1)], { params: P({ ubatchSize: 1024 }) })] } });
    const recheck = tuneRun({ id: 'R', tuning: { budget: 'recheck' } });
    const otherGpu = { ...tuneRun({ id: 'G' }), hardware: hardware({ gpus: [{ index: 0, uuid: 'GPU-bbbb', name: 'Other', vendor: 'nvidia', memoryTotalMiB: 1 }] }) };
    const out = await learnedOrder(repo([a, b, old, recheck, otherGpu]), here, 'llamacpp-native');
    expect(out).toEqual({ prefer: { ub: [2048, 1024], b: [4096] }, learned: { runs: 3, first: [{ key: 'ub', value: 2048 }, { key: 'b', value: 4096 }] } });
    // vLLM: batched tokens from the params.
    const v = tuneRun({ id: 'V', engine: { kind: 'vllm-docker', name: 'vLLM' }, tuning: { combinations: [combo('fp8', 8192, [point(1024, 1)], { params: P({ batchSize: 8192 }) })] } });
    const vNoBatch = tuneRun({ id: 'W', engine: { kind: 'vllm-docker', name: 'vLLM' }, tuning: { combinations: [combo('fp8', 8192, [point(1024, 1)])] } });
    expect((await learnedOrder(repo([v, vNoBatch]), here, 'vllm-docker'))?.prefer).toEqual({ bt: [8192] });
    expect(await learnedOrder(repo([vNoBatch]), here, 'vllm-docker')).toEqual({ prefer: {}, learned: { runs: 1, first: [] } });
    // Saved before phase 3 with a batch only.
    const batchOnly = tuneRun({ id: 'D', tuning: { combinations: [combo('q8_0', 32768, [point(1024, 1)], { params: P({ batchSize: 8192 }) })] } });
    expect((await learnedOrder(repo([batchOnly]), here, 'llamacpp-native'))?.prefer).toEqual({ b: [8192] });
    // Nothing usable: none.
    expect(await learnedOrder(repo([tuneRun({ id: 'N', recommended: undefined })]), here, 'llamacpp-native')).toBeUndefined();
    const broken = { ...repo([a]), get: () => Promise.reject(new Error('x')) };
    expect(await learnedOrder(broken, here, 'llamacpp-native')).toBeUndefined();
    // A card known by name only.
    expect(await learnedOrder(repo([a]), { hostId: 'h', gpuName: 'NVIDIA GeForce RTX 5090' }, 'llamacpp-native')).toBeDefined();
    expect(await learnedOrder(repo([a]), { hostId: 'h' }, 'llamacpp-native')).toBeUndefined();
  });

  it('a search cut short never compared its values, and a run that spilled never counts', async () => {
    const partial = tuneRun({ id: 'P', tuning: { combinations: [combo('q8_0', 32768, [point(1024, 1)], { params: P({ ubatchSize: 1024 }), partial: 'budget' })] } });
    expect(await learnedOrder(repo([partial]), here, 'llamacpp-native')).toBeUndefined();
    const spilled = { ...tuneRun({ id: 'S' }), validity: ['shared_memory_spill' as const] };
    expect(await learnedOrder(repo([spilled]), here, 'llamacpp-native')).toBeUndefined();
    expect(tuneRunsFor([summaryOf(spilled, 'S.json')], here, 'llamacpp-native')).toEqual([]);
  });
});

describe('what a search expects before it measures (its forecast)', () => {
  const model = modelIdentity({ facts });
  const at = (id: string, over: Partial<RunResult>): RunResult => makeRun({ id, model, ...over });

  it('the newest clean run of this model and engine here: its points as speeds at known depths, its load time', async () => {
    const quick = at('Q', { metrics: { ...makeRun().metrics, latency: [latencyPoint(512, 53.7, 1810)] } });
    expect(await expectFromRuns(repo([quick]), here, 'llamacpp-native', model)).toEqual({ anchors: [{ depth: 512, prefillTps: 1810, decodeTps: 53.7 }], loadMs: 1500 });
    // Only a cold load: that one.
    const cold = at('C', { metrics: { ...makeRun().metrics, load: { coldMs: makeRun().metrics.load.coldMs!, phases: [] } } });
    expect((await expectFromRuns(repo([cold]), here, 'llamacpp-native', model))?.loadMs).toBe(9000);
    // A tune run: its launches say how long a start takes.
    const t = tuneRun({ id: 'T' });
    t.model = model;
    t.metrics = { ...t.metrics, load: { phases: [] }, latency: [], contextSweep: [point(1024, 55.9, { prefill: 1810 })] };
    t.tuning!.attempts = [
      { stage: 'capacity', kvType: 'f16', contextSize: 4096, outcome: 'ok', loadMs: 9900, params: P(), points: [], command: { argv: [], powershell: '', bash: '' } },
      { stage: 'capacity', kvType: 'f16', contextSize: 8192, outcome: 'oom', loadMs: 1, params: P(), points: [], command: { argv: [], powershell: '', bash: '' } },
    ];
    expect(await expectFromRuns(repo([t]), here, 'llamacpp-native', model)).toEqual({ anchors: [{ depth: 1024, prefillTps: 1810, decodeTps: 55.9 }], loadMs: 9900 });
    t.tuning!.attempts = [];
    expect(await expectFromRuns(repo([t]), here, 'llamacpp-native', model)).toEqual({ anchors: [{ depth: 1024, prefillTps: 1810, decodeTps: 55.9 }] });
  });

  it('speeds never from a run that spilled, failed, measured nothing or cannot be read; nothing from another engine, PC, card or model', async () => {
    const good = at('G', { createdAt: '2026-10-01T10:00:00.000Z' });
    const spilled = at('S', { createdAt: '2026-10-06T10:00:00.000Z', validity: ['shared_memory_spill'] });
    const empty = at('E', { createdAt: '2026-10-05T10:00:00.000Z', metrics: { ...makeRun().metrics, latency: [] } });
    const gone = at('X', { createdAt: '2026-10-04T10:00:00.000Z' });
    const failed = at('F', { status: 'failed' });
    const others = [
      at('D', { engine: { kind: 'llamacpp-docker', name: 'llama.cpp' } }),
      at('H', { hardware: hardware({ hostId: 'elsewhere' }) }),
      at('K', { hardware: hardware({ gpus: [{ index: 0, uuid: 'GPU-zzzz', name: 'Other', vendor: 'nvidia', memoryTotalMiB: 1 }] }) }),
      makeRun({ id: 'M', model: modelIdentity({ weakKey: 'other', facts }) }),
    ];
    const runs = [spilled, empty, gone, good, failed, ...others];
    const store = { ...repo(runs), get: async (id: string) => (id === 'X' ? Promise.reject(new Error('gone')) : runs.find((r) => r.id === id)) };
    const out = await expectFromRuns(store, here, 'llamacpp-native', model);
    expect(out?.anchors).toHaveLength(2);
    // A run that spilled or failed still says how long a start takes here (the newest that measured one).
    expect(out?.loadMs).toBe(1500);
    expect(await expectFromRuns(repo([spilled, failed, ...others]), here, 'llamacpp-native', model)).toEqual({ loadMs: 1500 });
    expect(await expectFromRuns(repo(others), here, 'llamacpp-native', model)).toBeUndefined();
    // The same file by its hash.
    const hashed = at('H2', { model: modelIdentity({ facts, sha256: 'abc', weakKey: 'renamed' }) });
    expect(await expectFromRuns(repo([hashed]), here, 'llamacpp-native', { sha256: 'abc', weakKey: 'x' })).toBeDefined();
  });

  it('the start time of a search that failed: its launches that loaded (NInfer reading a 21.5 GiB model from /mnt/c, RTX 5090)', async () => {
    const attempt = (outcome: 'ok' | 'oom' | 'spill', loadMs: number) => ({ stage: 'capacity' as const, kvType: 'bf16' as const, contextSize: 4096, outcome, loadMs, params: P(), points: [], command: { argv: [], powershell: '', bash: '' } });
    const failed = tuneRun({ id: 'NF', engine: { kind: 'ninfer-wsl', name: 'NInfer' } });
    failed.model = model;
    failed.status = 'failed';
    failed.metrics = { ...failed.metrics, load: { phases: [] }, latency: [], contextSweep: [] };
    // The real starts of that search: 93.9 s, 101.3 s, 97.4 s, 90.3 s; the ones that ran out of memory or spilled do not count.
    failed.tuning!.attempts = [attempt('ok', 93_854), attempt('oom', 105_257), attempt('spill', 120_133), attempt('ok', 101_318), attempt('ok', 97_442), attempt('ok', 90_325)];
    expect(await expectFromRuns(repo([failed]), here, 'ninfer-wsl', model)).toEqual({ loadMs: 97_442 });
    // A completed run measured later gives the speeds, the failed one still the start time.
    const done = at('ND', { createdAt: '2026-10-07T10:00:00.000Z', engine: { kind: 'ninfer-wsl', name: 'NInfer' }, metrics: { ...makeRun().metrics, load: { phases: [] }, latency: [latencyPoint(1024, 84.9, 3226)] } });
    expect(await expectFromRuns(repo([done, failed]), here, 'ninfer-wsl', model)).toEqual({ anchors: [{ depth: 1024, prefillTps: 3226, decodeTps: 84.9 }], loadMs: 97_442 });
    // Unreadable, or no launch that loaded: nothing.
    expect(await expectFromRuns({ ...repo([failed]), get: () => Promise.reject(new Error('gone')) }, here, 'ninfer-wsl', model)).toBeUndefined();
    failed.tuning!.attempts = [attempt('oom', 105_257)];
    expect(await expectFromRuns(repo([failed]), here, 'ninfer-wsl', model)).toBeUndefined();
  });

  it('a model read through a slow shared filesystem never starts faster than it is read (~240 MiB/s)', () => {
    const usual = expectFromSize(17.6e9);
    const seen = { anchors: [{ depth: 1024, prefillTps: 3226, decodeTps: 84.9 }], loadMs: 20_000 };
    // 21.5 GiB through WSL's /mnt/c: 91.7 s, where NInfer usually starts in 15 s.
    expect(tuneExpectOf(undefined, NINFER_EXPECT, 21.5 * 1024 ** 3)).toEqual({ anchors: NINFER_EXPECT.anchors, loadMs: 91_733 });
    expect(SLOW_SHARE_BYTES_PER_SEC).toBe(240 * 1024 * 1024);
    // Earlier runs measured here win, and a longer start than the reading stays.
    expect(tuneExpectOf(seen, usual, 21.5 * 1024 ** 3)).toEqual({ anchors: seen.anchors, loadMs: 91_733 });
    expect(tuneExpectOf({ loadMs: 120_000 }, usual, 21.5 * 1024 ** 3)).toEqual({ anchors: usual.anchors, loadMs: 120_000 });
    // A local disk: what was expected.
    expect(tuneExpectOf(seen, usual)).toEqual(seen);
    expect(tuneExpectOf({ anchors: seen.anchors }, usual)).toEqual({ anchors: seen.anchors, loadMs: usual.loadMs });
  });

  it('else what the model’s size suggests: a 17.6 GB model reads ~2 000 tok/s and generates ~58', () => {
    expect(expectFromSize(17.6e9)).toEqual({ anchors: [{ depth: 1024, prefillTps: 2135, decodeTps: 58 }], loadMs: 11_835 });
    expect(expectFromSize(0.1e9).anchors[0]).toMatchObject({ prefillTps: 20_000, decodeTps: 300 });
    expect(expectFromSize(undefined)).toEqual({ anchors: [DEFAULT_SPEED], loadMs: DEFAULT_LOAD_MS });
  });
});

describe('buildTuneSetup, phase 3', () => {
  const sample = (over: Partial<GpuSample> = {}): GpuSample => ({ t: 0, gpu: 0, utilPct: 1, memUsedMiB: 1600, memTotalMiB: 32607, powerW: 30, tempC: 40, smClockMHz: 200, memClockMHz: 400, pcieGen: 5, pcieWidth: 16, throttle: [], ...over });
  const deps = (o: { runs?: RunResult[]; calibration?: FitCalibration } = {}) => ({
    telemetry: { snapshot: async () => [sample()] },
    fingerprint: async () => hardware({ os: { platform: 'linux', release: '', arch: 'x64', name: '', isWsl: false } }),
    ...(o.runs ? { runs: repo(o.runs), here: async () => here } : {}),
    ...(o.calibration ? { calibration: async () => o.calibration } : {}),
  });
  const prepared = (kind: 'llamacpp-native' | 'vllm-docker', caps: unknown): TunePrepared => ({
    model: { identity: modelIdentity({ facts }) },
    adapter: { capabilities: async () => caps } as unknown as EngineAdapter,
    engine: { kind },
    params: P(),
    launch: { modelBytes: 2_000_000_000 },
    scenario: buildScenario('tune'),
  });
  const llamaCaps = { flags: new Set(['--kv-unified', '--no-kv-unified', '--cache-reuse', '-ub', '--n-cpu-moe', '--model-draft']), entries: [], nglKeywords: [] };

  it('goal "Più utenti": users and context per user, -np in every launch, no CPU offload, the past order and the calibrated estimate', async () => {
    const calibration: FitCalibration = { scale: 2, offsetMiB: 0, samples: 3, errorPct: 4, scope: 'model' };
    const s = await buildTuneSetup(deps({ runs: [tuneRun()], calibration }), { engine: { kind: 'llamacpp-native' }, tune: { budget: 'thorough', fidelity: false, goal: 'multi', users: 6, perUserContext: 4096 } }, prepared('llamacpp-native', llamaCaps));
    expect(s).toMatchObject({ goal: 'multi', multi: { users: 6, perUserContext: 4096, turns: 3 }, learned: { runs: 1 } });
    expect(s).not.toHaveProperty('offload');
    expect(s.space.base('f16')).toMatchObject({ np: 6, layout: 'unified', reuse: 0 });
    expect(s.space.dimensions.map((d) => d.key)).toEqual(['layout', 'reuse', 'fa', 'ub', 'b']);
    expect(s.space.dimensions.find((d) => d.key === 'ub')!.values(s.space.base('f16'))[0]).toBe(2048);
    expect(s.predict!(P({ contextSize: 4096 }))?.calibration).toEqual({ samples: 3, errorPct: 4, scope: 'model', rawNeedMiB: expect.any(Number) });
  });

  it('vLLM: its listed options, users; a recheck input passed through, no past order for a recheck', async () => {
    const vcaps = { flags: new Set(['--cuda-graph-sizes']), choices: { '--block-size': ['16', '32'] } };
    const recheck = { previousRunId: 'X', previousCreatedAt: 'y', checks: [] };
    const s = await buildTuneSetup(deps({ runs: [tuneRun()] }), { engine: { kind: 'vllm-docker' }, tune: { budget: 'recheck', fidelity: false, goal: 'multi', users: 4 } }, prepared('vllm-docker', vcaps), recheck);
    expect(s).toMatchObject({ budget: 'recheck', recheck, multi: { users: 4, perUserContext: 8192 } });
    expect(s).not.toHaveProperty('learned');
    expect(s.space.base('auto')).toEqual({ kv: 'auto', bt: 2048, np: 4 });
    expect(s.space.extensions).toEqual([{ graphs: 'small' }, { eager: true }]);
    const noChoices = await buildTuneSetup(deps(), { engine: { kind: 'vllm-docker' }, tune: { budget: 'thorough', fidelity: false } }, prepared('vllm-docker', { flags: new Set() }));
    expect(noChoices.space.dimensions.map((d) => d.key)).toEqual(['bt']);
    const failing = await buildTuneSetup({ ...deps(), runs: repo([]), here: () => Promise.reject(new Error('x')), calibration: () => Promise.reject(new Error('y')) }, { engine: { kind: 'llamacpp-native' } }, prepared('llamacpp-native', llamaCaps));
    expect(failing).not.toHaveProperty('learned');
    expect(failing.predict!(P({ contextSize: 4096 }))).not.toHaveProperty('calibration');
  });

  it('a Docker Desktop bind mount (Windows, macOS) reads the model slowly: no start faster than ~240 MiB/s', async () => {
    const llama = (slowSharedFilesystem: boolean): TunePrepared => ({ ...prepared('llamacpp-native', llamaCaps), engine: { kind: 'llamacpp-docker' }, launch: { modelBytes: 2_000_000_000, slowSharedFilesystem } });
    const req = { engine: { kind: 'llamacpp-docker' as const }, tune: { budget: 'fast' as const, fidelity: false } };
    // 2 GB: ~3.1 s from what its size suggests, 7.9 s to read it through the share.
    expect((await buildTuneSetup(deps(), req, llama(false))).expect?.loadMs).toBe(3118);
    expect((await buildTuneSetup(deps(), req, llama(true))).expect?.loadMs).toBe(7947);
  });

  it('vLLM: the batched tokens that won here come first; the help unreadable: the defaults; past runs unreadable: no order', async () => {
    const v = tuneRun({ id: 'V', engine: { kind: 'vllm-docker', name: 'vLLM' }, tuning: { combinations: [combo('fp8', 8192, [point(1024, 1)], { params: P({ batchSize: 8192 }) })] } });
    const broken = { ...prepared('vllm-docker', undefined), adapter: { capabilities: () => Promise.reject(new Error('no docker')) } as unknown as EngineAdapter };
    const s = await buildTuneSetup(deps({ runs: [v] }), { engine: { kind: 'vllm-docker' }, tune: { budget: 'fast', fidelity: false } }, broken);
    expect(s.learned).toEqual({ runs: 1, first: [{ key: 'bt', value: 8192 }] });
    expect(s.space.dimensions.find((d) => d.key === 'bt')!.values(s.space.base('auto'))[0]).toBe(8192);
    expect(s.space.dimensions.map((d) => d.key)).toEqual(['bt']);
    const unreadable = { ...deps(), runs: { list: () => Promise.reject(new Error('disk')), get: async () => undefined }, here: async () => here };
    expect(await buildTuneSetup(unreadable, { engine: { kind: 'llamacpp-native' } }, prepared('llamacpp-native', llamaCaps))).not.toHaveProperty('learned');
  });
});

describe('"Ricontrollo rapido": what to re-check', () => {
  const model = { identity: modelIdentity({ facts }) };
  const req = (tune: object = {}) => ({ engine: { kind: 'llamacpp-native' as const }, tune: { budget: 'recheck' as const, fidelity: false, ...tune } });

  it('the run asked for, else the latest with the same question; it must be a tune with a recommendation', async () => {
    const a = tuneRun({ id: 'A' });
    const m = tuneRun({ id: 'M', tuning: multiTuning() });
    const runs = repo([a, m, makeRun({ id: 'Q' })]);
    expect((await recheckSource(runs, here, req(), model))?.id).toBe('A');
    expect((await recheckSource(runs, here, req({ goal: 'multi' }), model))?.id).toBe('M');
    expect((await recheckSource(runs, here, req({ recheckOf: 'M' }), model))?.id).toBe('M');
    expect(await recheckSource(runs, here, req({ recheckOf: 'Q' }), model)).toBeUndefined();
    expect(await recheckSource(runs, here, req({ recheckOf: 'nope' }), model)).toBeUndefined();
    expect(await recheckSource(repo([tuneRun({ id: 'N', recommended: undefined })]), here, req({ recheckOf: 'N' }), model)).toBeUndefined();
    expect(await recheckSource({ tried: () => Promise.reject(new Error('x')), get: async () => undefined }, here, req(), model)).toBeUndefined();
    expect(await recheckSource({ ...runs, get: () => Promise.reject(new Error('x')) }, here, req(), model)).toBeUndefined();
    const sha = { identity: modelIdentity({ facts, sha256: 'abc' }) };
    expect((await recheckSource(runs, here, req(), sha))?.id).toBe('A');
  });

  it('the recommendation, then its runner-up; builds and the multi question carried', () => {
    const input = recheckInputOf(tuneRun({ build: 'b10000' }), 'b11438');
    expect(input).toMatchObject({ previousRunId: 'TUNE-A', previousBuild: 'b10000', currentBuild: 'b11438' });
    expect(input.checks.map((c) => [c.role, c.combination.kvType, c.combination.maxContext])).toEqual([
      ['recommended', 'q4_0', 40960],
      ['runner-up', 'q8_0', 32768],
    ]);
    const alone = recheckInputOf(tuneRun({ tuning: { combinations: [tuneRun().tuning!.combinations[0]!] } }), undefined);
    expect(alone.checks.map((c) => c.role)).toEqual(['recommended']);
    expect(alone).not.toHaveProperty('currentBuild');
    const multi = recheckInputOf(tuneRun({ tuning: multiTuning(), engine: { kind: 'llamacpp-native', name: 'llama.cpp' } }), 'b1');
    expect(multi).toMatchObject({ multi: { users: 4 }, checks: [{ role: 'recommended' }, { role: 'runner-up' }] });
    expect(multi).not.toHaveProperty('previousBuild');
  });
});

describe('tune results remembered per engine build', () => {
  const model = { identity: modelIdentity({ facts }) };
  const req = (params?: LaunchParams) => ({ engine: { kind: 'llamacpp-native' as const }, model: {}, ...(params ? { params } : {}) });
  const newer = tuneRun({ id: 'NEW', build: 'b10997', createdAt: '2026-10-06T12:00:00.000Z' });
  const older = tuneRun({ id: 'OLD', build: 'b11438', createdAt: '2026-10-05T12:00:00.000Z' });

  it('the tune with the build in use first; only an older build: marked, with both builds', async () => {
    const runs = repo([newer, older]);
    expect((await tunedServerParams(runs, here, req(), model, async () => 'b11438'))?.tuned).toMatchObject({ runId: 'OLD' });
    expect((await tunedServerParams(runs, here, req(), model, async () => 'b10997'))?.tuned).toMatchObject({ runId: 'NEW' });
    const other = await tunedServerParams(runs, here, req(), model, async () => 'b12000');
    expect(other?.tuned).toEqual({ runId: 'NEW', createdAt: newer.createdAt, contextSize: 40960, kvCacheType: 'q4_0', otherBuild: { build: 'b10997', current: 'b12000' } });
    // The build in use unknown (or not asked): the latest, unmarked.
    expect((await tunedServerParams(runs, here, req(), model, async () => undefined))?.tuned.otherBuild).toBeUndefined();
    expect((await tunedServerParams(runs, here, req(), model, () => Promise.reject(new Error('x'))))?.tuned.runId).toBe('NEW');
    expect((await tunedServerParams(runs, here, req(), model))?.tuned.runId).toBe('NEW');
    // A run without a build cannot be told apart.
    const noBuild = tuneRun({ id: 'NB', engine: { kind: 'llamacpp-native', name: 'llama.cpp' } });
    expect((await tunedServerParams(repo([noBuild]), here, req(), model, async () => 'b1'))?.tuned.otherBuild).toBeUndefined();
  });

  it('the newest run with the build in use decides even when nothing fits any more; several slots ask for a "Più utenti" run', async () => {
    const gone = tuneRun({ id: 'GONE', build: 'b11438', createdAt: '2026-10-07T12:00:00.000Z', tuning: { budget: 'recheck', combinations: [] }, recommended: undefined });
    expect(await tunedServerParams(repo([gone, older]), here, req(), model, async () => 'b11438')).toBeUndefined();
    // Another build in use: the newest that measured something.
    expect((await tunedServerParams(repo([gone, older]), here, req(), model, async () => 'b9'))?.tuned.runId).toBe('OLD');
    const m = tuneRun({ id: 'M4', tuning: multiTuning(4) });
    const four = await tunedServerParams(repo([older, m]), here, req(P({ parallel: 4 })), model, async () => 'b11438');
    expect(four).toMatchObject({ tuned: { runId: 'M4', goal: 'multi', users: 4, contextSize: 32768 }, params: { parallel: 4, extraArgs: ['--no-kv-unified'] } });
    expect(await tunedServerParams(repo([older, m]), here, req(P({ parallel: 8 })), model, async () => 'b11438')).toBeUndefined();
    const fitting = tuneRun({ id: 'F', tuning: { ...multiTuning(16), multi: { ...multiTuning(16).multi!, fittingUsers: 8 } } });
    expect((await tunedServerParams(repo([fitting]), here, req(P({ parallel: 16 })), model))?.tuned.users).toBe(8);
  });
});

