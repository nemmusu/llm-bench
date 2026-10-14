/**
 * Spills in normal runs (Windows), with the real numbers of an RTX 5090 and a 27B model: 4 666 MiB of
 * shared memory, generation at 3.5 tok/s against the usual 53.7. And the tune runs' clock: progress
 * and time left re-sent during long requests, repetitions cut by the time limit.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { launchParamsSchema } from '../../../../src/contract/engines';
import type { Scenario } from '../../../../src/contract/results';
import { BenchRunner, PHASE_HEARTBEAT_MS, type RunInput, type RunnerDeps } from '../../../../src/core/bench/runner';
import { buildScenario } from '../../../../src/core/bench/scenarios';
import { BUDGETS, type TuneSpace, type TunerInput } from '../../../../src/core/bench/tuner';
import { hardware } from '../store/fixtures';
import { displayCommand, events, FakeAdapter, FakeTelemetry, memoryRuns, modelTarget, SMALL_CORPUS, World, type AdapterOptions, type TelemetryOptions } from './fakes';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(o: { adapter?: AdapterOptions; telemetry?: TelemetryOptions; deps?: Partial<RunnerDeps> } = {}) {
  const world = new World();
  const adapter = new FakeAdapter(world, o.adapter);
  const telemetry = new FakeTelemetry(world, { live: true, ...o.telemetry });
  const runs = memoryRuns();
  const ev = events();
  const cacheDir = mkdtempSync(path.join(os.tmpdir(), 'gb-runner-spill-'));
  dirs.push(cacheDir);
  const runner = new BenchRunner({
    clock: world.clock,
    adapter,
    telemetry,
    runs,
    publish: ev.publish,
    fingerprint: async () => hardware(),
    displayCommand,
    appVersion: '0.1.0-test',
    cacheDir,
    corpus: async () => SMALL_CORPUS,
    ownPids: () => [],
    vramSettleMs: 2000,
    ...o.deps,
  });
  return { world, adapter, telemetry, runs, ev, runner };
}

/** "Rapido" with -c 262144 (the run that spilled). */
function quick(over: Partial<RunInput> = {}): RunInput {
  return {
    runId: 'SPILL1',
    engineConfig: { kind: 'llamacpp-native' },
    model: modelTarget(),
    params: launchParamsSchema.parse({ contextSize: 262_144, kvCacheType: 'f16', flashAttention: 'auto' }),
    scenario: buildScenario('quick'),
    port: 5555,
    marker: 'gpubench-spill',
    allowSharedGpu: false,
    ...over,
  };
}

/** 3.5 tok/s: a token every 286 ms; 53.7 tok/s: every 18.6 ms. */
const SPILLED = { decodeMsPerToken: 1000 / 3.5 };
const NORMAL = { tps: 53.7, runIds: ['before'] };
const FIXES = { kvCacheType: 'q4_0' as const, maxContext: 200_704 };

describe('a normal run that spills (Windows)', () => {
  it('4 666 MiB of shared memory: flagged, said at once on the live screen (once), kept with what would fit', async () => {
    const s = setup({ telemetry: { processVram: { sharedMiB: 4666 } } });
    const result = await s.runner.run(quick({ fitFixes: FIXES }), new AbortController().signal);
    expect(result.validity[0]).toBe('shared_memory_spill');
    expect(result.metrics.vram.sharedPeakMiB).toBe(4666);
    expect(result.metrics.spill).toMatchObject({ by: ['shared-memory'], sharedPeakMiB: 4666, thresholdMiB: 1024, fixes: FIXES });
    expect(result.metrics.spill).not.toHaveProperty('normalDecodeTps');
    const live = s.ev.ofType('run.spill');
    expect(live).toHaveLength(1);
    expect(live[0]).toEqual({ type: 'run.spill', runId: 'SPILL1', spill: { by: ['shared-memory'], sharedPeakMiB: 4666, thresholdMiB: 1024 } });
  });

  it('generation collapsed on a short prompt (3.5 against the usual 53.7): flagged; with the shared memory too, said again', async () => {
    const collapse = setup({ adapter: { client: SPILLED } });
    const r1 = await collapse.runner.run(quick({ normalDecode: NORMAL }), new AbortController().signal);
    expect(r1.metrics.spill).toMatchObject({ by: ['decode-collapse'], normalDecodeTps: 53.7, normalRunIds: ['before'] });
    expect(r1.metrics.spill!.decodeTps).toBeCloseTo(3.5, 0);
    expect(collapse.ev.ofType('run.spill').map((e) => e.spill.by)).toEqual([['decode-collapse']]);

    const both = setup({ adapter: { client: SPILLED }, telemetry: { processVram: { sharedMiB: 4666 } } });
    const r2 = await both.runner.run(quick({ normalDecode: NORMAL, fitFixes: {} }), new AbortController().signal);
    expect(r2.metrics.spill?.by).toEqual(['shared-memory', 'decode-collapse']);
    expect(r2.metrics.spill).not.toHaveProperty('fixes');
    expect(both.ev.ofType('run.spill').map((e) => e.spill.by)).toEqual([['shared-memory'], ['shared-memory', 'decode-collapse']]);
  });

  it('the shared memory growing by 10 % or more is said again', async () => {
    let shared = 1500;
    const s = setup({ telemetry: { processVram: { sharedMiB: 1 } } });
    // The counters report what the engine holds now: more and more while it fills its KV cache.
    const rec = s.telemetry;
    const original = rec.startProcessVram.bind(rec);
    rec.startProcessVram = async (pids, interval) => {
      const session = await original(pids, interval);
      return session && Object.assign(session, { sharedPeakMiB: () => (shared += 400) });
    };
    await s.runner.run(quick(), new AbortController().signal);
    const said = s.ev.ofType('run.spill').map((e) => e.spill.sharedPeakMiB as number);
    expect(said.length).toBeGreaterThan(1);
    expect(said.every((v, i) => i === 0 || v >= said[i - 1]! * 1.1)).toBe(true);
  });

  it('not a spill: clean shared memory at 256K (376 MiB), Linux, a CPU offload chosen on purpose, an external endpoint', async () => {
    const clean = setup({ adapter: { client: { decodeMsPerToken: 1000 / 53.7 } }, telemetry: { processVram: { sharedMiB: 376 } } });
    const r1 = await clean.runner.run(quick({ normalDecode: NORMAL }), new AbortController().signal);
    expect(r1.validity).not.toContain('shared_memory_spill');
    expect(r1.metrics.vram.sharedPeakMiB).toBe(376);
    expect(r1.metrics).not.toHaveProperty('spill');

    const linux = setup({ adapter: { client: SPILLED }, telemetry: { processVram: { sharedMiB: 4666 } }, deps: { fingerprint: async () => hardware({ os: { platform: 'linux', release: '', arch: 'x64', name: 'Ubuntu', isWsl: false } }) } });
    expect((await linux.runner.run(quick({ normalDecode: NORMAL }), new AbortController().signal)).metrics).not.toHaveProperty('spill');

    const offload = setup({ adapter: { client: SPILLED } });
    const params = launchParamsSchema.parse({ contextSize: 8192, gpuLayers: 20 });
    expect((await offload.runner.run(quick({ params, normalDecode: NORMAL }), new AbortController().signal)).metrics).not.toHaveProperty('spill');

    const external = setup({ adapter: { kind: 'external', client: SPILLED } });
    expect((await external.runner.run(quick({ engineConfig: { kind: 'external', baseUrl: 'http://127.0.0.1:1' }, normalDecode: NORMAL }), new AbortController().signal)).metrics).not.toHaveProperty('spill');
  });
});

/** One KV type, no other dimension, a 4K model: one capacity check and one screening. */
const space: TuneSpace = {
  kvLadder: ['f16'],
  base: (kv) => ({ kv }),
  dimensions: [],
  contextFor: (users, perUser) => users * perUser,
  params: (v, ctx) => launchParamsSchema.parse({ contextSize: ctx, kvCacheType: v.kv }),
  tags: () => [],
};

function tuneRun(over: Partial<TunerInput> = {}): RunInput {
  const scenario: Scenario = buildScenario('tune');
  return {
    ...quick(),
    runId: 'TUNE1',
    scenario,
    tune: { space, budget: 'fast', sweep: { outputTokens: 64, reps: 1 }, modelContext: 4096, spillPossible: false, fidelity: false, ...over },
  };
}

describe('a tune run’s clock', () => {
  it('re-sends its progress and time left every few seconds during a long request', async () => {
    // A token every 1.5 s: a 64-token answer takes 96 s, the 32-token probe 48 s.
    const s = setup({ adapter: { client: { decodeMsPerToken: 1500 } } });
    const result = await s.runner.run(tuneRun({ limitMs: 600_000 }), new AbortController().signal);
    const phases = s.ev.ofType('run.phase').filter((e) => e.remainingSeconds !== undefined);
    // Far more than the phase changes: the heartbeat, at most every PHASE_HEARTBEAT_MS.
    expect(phases.length).toBeGreaterThan(20);
    expect(PHASE_HEARTBEAT_MS).toBe(5000);
    const progress = phases.map((e) => e.progress);
    expect(progress.at(-1)!).toBeGreaterThan(progress[0]!);
    expect(result.tuning!.estimateSeconds).toBeGreaterThan(0);
  });

  it('a repetition that would end past the time limit is not made: the point keeps the one made', async () => {
    // 10 s per start, a 64-token answer in 29 s (under a minute: two repetitions asked).
    const s = setup({ adapter: { warmMs: 10_000, client: { decodeMsPerToken: 450 } } });
    const result = await s.runner.run(tuneRun({ limitMs: 1 }), new AbortController().signal);
    const t = result.tuning!;
    expect(t.stoppedBy).toBe('budget');
    expect(t.limitSeconds).toBe(BUDGETS.fast.minMs / 1000);
    const screen = t.attempts.find((a) => a.stage === 'variant')!;
    expect(screen.points[1]).toMatchObject({ promptTokens: 4016, decodeTps: { n: 1 } });
    // The screening's deepest point (the context full, measured first) was asked twice, made once; the 1K one not at all.
    expect(screen.skipped).toEqual([{ depth: 1024, predictedMs: expect.any(Number) }]);
    expect(t.combinations).toHaveLength(1);
    expect(t.combinations[0]).toMatchObject({ partial: 'budget', maxContext: 4096 });
    // The run reads as that partly measured combination.
    expect(result.metrics.contextSweep).toEqual(t.combinations[0]!.sweep);
  });

  it('tune runs keep the shared memory of their recommended launch, never a spill flag', async () => {
    const s = setup({ telemetry: { processVram: { sharedMiB: 120 } } });
    const result = await s.runner.run(tuneRun({ spillPossible: true }), new AbortController().signal);
    expect(result.metrics.vram.sharedPeakMiB).toBe(120);
    expect(result.validity).not.toContain('shared_memory_spill');
    expect(s.ev.ofType('run.spill')).toEqual([]);
  });
});
