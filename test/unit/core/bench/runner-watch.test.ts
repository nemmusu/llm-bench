/**
 * The runner's side of the live spill watch, the request deadlines and the stall guard: the tune
 * launch given up at the telemetry heartbeat (its load or its request aborted), deadlines and the stall
 * guard on real timers (short ones here), a cancelled or failed search kept as far as it went.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { launchParamsSchema } from '../../../../src/contract/engines';
import { AppError } from '../../../../src/contract/errors';
import type { ServerEvent } from '../../../../src/contract/events';
import type { Scenario } from '../../../../src/contract/results';
import { BenchRunner, type RunInput, type RunnerDeps } from '../../../../src/core/bench/runner';
import { buildScenario } from '../../../../src/core/bench/scenarios';
import type { TuneSpace, TunerInput } from '../../../../src/core/bench/tuner';
import { hardware } from '../store/fixtures';
import { displayCommand, events, FakeAdapter, FakeTelemetry, memoryRuns, modelTarget, SMALL_CORPUS, World, type AdapterOptions, type TelemetryOptions } from './fakes';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(o: { adapter?: AdapterOptions; telemetry?: TelemetryOptions; deps?: Partial<RunnerDeps>; world?: (w: World) => void } = {}) {
  const world = new World();
  o.world?.(world);
  const adapter = new FakeAdapter(world, o.adapter);
  const telemetry = new FakeTelemetry(world, o.telemetry);
  const runs = memoryRuns();
  const ev = events();
  const cacheDir = mkdtempSync(path.join(os.tmpdir(), 'gb-runner-watch-'));
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

const space: TuneSpace = {
  kvLadder: ['f16', 'q4_0'],
  base: (kv) => ({ kv }),
  dimensions: [],
  contextFor: (users, perUser) => users * perUser,
  params: (v, ctx) => launchParamsSchema.parse({ contextSize: ctx, kvCacheType: v.kv }),
  tags: () => [],
};

function tuneInput(over: Partial<TunerInput> = {}): RunInput {
  return {
    runId: 'WATCH1',
    engineConfig: { kind: 'llamacpp-native' },
    model: modelTarget(),
    params: launchParamsSchema.parse({}),
    scenario: buildScenario('tune'),
    port: 5555,
    marker: 'gpubench-tune',
    allowSharedGpu: false,
    tune: { space, budget: 'fast', sweep: { outputTokens: 64, reps: 1 }, modelContext: 8192, spillPossible: true, fidelity: false, ...over },
  };
}

function normalInput(scenario: Scenario): RunInput {
  const { tune: _tune, ...rest } = tuneInput();
  return { ...rest, scenario, params: launchParamsSchema.parse({ contextSize: 4096, parallel: 2 }) };
}

const signal = () => new AbortController().signal;

describe('the live spill watch of a tune launch', () => {
  it('shared memory crossing the rule during the probe: the request is aborted, the attempt shown before its engine stops, the search goes on', async () => {
    let shared = 100;
    const shown: boolean[] = [];
    const holder: { adapter?: FakeAdapter } = {};
    const s = setup({
      adapter: {
        // Every launch starts clean; the 2nd one's probe (request 2) takes 1 338 MiB and never answers.
        perStart: () => {
          shared = 100;
          return undefined;
        },
        client: { onRequest: (n) => (n === 2 ? (shared = 1338) : undefined), hang: (n) => (n === 2 ? 'ticking' : undefined) },
      },
      telemetry: { live: true, processVram: { sharedMiB: () => shared } },
      deps: {
        publish: (e: ServerEvent) => {
          if (e.type === 'run.tune' && e.tuning.attempts.length === 2 && shown.length === 0) shown.push(holder.adapter!.instances[1]!.stopped);
        },
      },
    });
    holder.adapter = s.adapter;
    const r = await s.runner.run(tuneInput(), signal());
    expect(r.status).toBe('completed');
    const t = r.tuning!;
    expect(t.attempts[1]).toMatchObject({ stage: 'capacity', kvType: 'f16', contextSize: 8192, outcome: 'spill', spill: 'shared-memory', sharedPeakMiB: 1338, points: [] });
    expect(shown).toEqual([false]);
    expect(s.adapter.instances[1]!.stopped).toBe(true);
    expect(t.capacity[0]).toMatchObject({ kvType: 'f16', measuredMax: 4096, bound: 'found', failedAt: 8192 });
    // The search went on: q4_0 holds 8K and was measured.
    expect(t.combinations.some((c) => c.kvType === 'q4_0' && c.maxContext === 8192)).toBe(true);
  });

  it('a spill seen while it loads aborts the wait for ready', async () => {
    let shared = 100;
    const s = setup({
      adapter: {
        perStart: (n) => {
          shared = n === 2 ? 4666 : 100;
          // The load moves the clock in steps: the heartbeats in between see the counters.
          return n === 2 ? { readySteps: 8 } : undefined;
        },
      },
      telemetry: { live: true, processVram: { sharedMiB: () => shared } },
    });
    const r = await s.runner.run(tuneInput(), signal());
    expect(r.tuning!.attempts[1]).toMatchObject({ contextSize: 8192, outcome: 'spill', spill: 'shared-memory', sharedPeakMiB: 4666, points: [] });
    expect(r.tuning!.attempts[1]!.loadMs).toBeLessThan(2000);
    expect(s.adapter.instances[1]!.stopped).toBe(true);
    expect(r.status).toBe('completed');
  });

  it('the card full (nvidia-smi: every process) and 600 MiB more shared than the reference: given up once loaded', async () => {
    let shared = 100;
    const s = setup({
      // Other programs hold 28 000 MiB: with the engine's 4 000 the 32 607 MiB card is full (≥ 31 583).
      world: (w) => (w.baselineMiB = 28_000),
      adapter: {
        perStart: (n) => {
          shared = n === 2 ? 700 : 100;
          return undefined;
        },
      },
      telemetry: { live: true, processVram: { sharedMiB: () => shared } },
      deps: { vramSettleMs: 0 },
    });
    const r = await s.runner.run({ ...tuneInput(), allowSharedGpu: true }, signal());
    expect(r.tuning!.attempts[0]).toMatchObject({ stage: 'reference', outcome: 'ok', sharedPeakMiB: 100 });
    expect(r.tuning!.attempts[1]).toMatchObject({ contextSize: 8192, outcome: 'spill', spill: 'shared-memory', sharedPeakMiB: 700, points: [] });
  });
});

describe('deadlines and the stall guard', () => {
  it('a tune request past its deadline: "too slow", its engine stopped, the search goes on lower', async () => {
    // Linux-like (no spill watch); the first request never answers. Expected speeds so fast that the
    // deadline is its floor (here 50 ms of real time).
    const s = setup({ adapter: { client: { hang: (n) => (n === 1 ? 'still' : undefined) } } });
    const r = await s.runner.run(tuneInput({ spillPossible: false, minRequestTimeoutMs: 50, expect: { anchors: [{ depth: 1024, prefillTps: 1e9, decodeTps: 1e9 }] } }), signal());
    expect(r.status).toBe('completed');
    expect(r.tuning!.attempts[0]).toMatchObject({ stage: 'capacity', contextSize: 8192, outcome: 'spill', spill: 'too-slow', error: { code: 'ENGINE_TIMEOUT', params: { reason: 'deadline', ms: 50 } } });
    expect(s.adapter.instances[0]!.stopped).toBe(true);
    expect(r.tuning!.attempts[1]).toMatchObject({ stage: 'capacity', contextSize: 4096, outcome: 'ok' });
  });

  it('a normal run whose engine stops answering fails with "the engine did not answer in time", instead of waiting forever', async () => {
    const scenario: Scenario = { profile: 'custom', seed: 1, steps: [{ kind: 'latency', promptTokens: [64], outputTokens: 8, warmup: 0, reps: 2 }] };
    // Request 1 is the first token after the load; request 3 (the 2nd repetition) never answers.
    const s = setup({ adapter: { client: { hang: (n) => (n === 3 ? 'still' : undefined) } }, deps: { stall: { idleMs: 30, minPrefillTps: 1e9 } } });
    const r = await s.runner.run(normalInput(scenario), signal());
    expect(r.status).toBe('failed');
    expect(r.error).toMatchObject({ code: 'ENGINE_TIMEOUT', params: { reason: 'stalled', ms: 30 } });
    expect(s.adapter.instances.every((i) => i.stopped)).toBe(true);
  });

  it('a user whose request stalls among several counts as a failed request; the level goes on', async () => {
    const scenario: Scenario = { profile: 'custom', seed: 1, steps: [{ kind: 'concurrency', levels: [2], promptTokens: 64, outputTokens: 8, requestsPerWorker: 1 }] };
    const s = setup({ adapter: { client: { hang: (n) => (n === 3 ? 'still' : undefined) } }, deps: { stall: { idleMs: 30, minPrefillTps: 1e9 } } });
    const r = await s.runner.run(normalInput(scenario), signal());
    expect(r.status).toBe('completed');
    expect(r.metrics.concurrency[0]).toMatchObject({ level: 2, errors: 1 });
  });
});

describe('a search the run ends', () => {
  it('cancelled: the result says so and keeps what was measured; failed: the same with its error', async () => {
    const ac = new AbortController();
    const cancelled = setup({ adapter: { client: { onRequest: (n) => (n === 2 ? ac.abort() : undefined) } } });
    const r = await cancelled.runner.run(tuneInput(), ac.signal);
    expect(r.status).toBe('cancelled');
    const t = r.tuning!;
    expect(t.stoppedBy).toBe('cancelled');
    // The reference (4K) loaded: f16 holds at least that; q4_0 was never launched.
    expect(t.capacity.map((c) => [c.kvType, c.measuredMax, c.bound, c.skipped])).toEqual([
      ['f16', 4096, 'cancelled', undefined],
      ['q4_0', undefined, undefined, 'cancelled'],
    ]);
    expect(t.combinations.every((c) => c.partial === 'cancelled')).toBe(true);

    let starts = 0;
    const failed = setup({ adapter: { failStart: () => (++starts === 2 ? new AppError('ENGINE_BAD_FLAG', 'Rejected argument: -ctk', { params: { flag: '-ctk' } }) : undefined) } });
    const f = await failed.runner.run(tuneInput(), signal());
    expect(f.status).toBe('failed');
    expect(f.tuning!.stoppedBy).toBe('failed');
    expect(f.tuning!.capacity.map((c) => [c.kvType, c.measuredMax, c.bound, c.skipped])).toEqual([
      ['f16', 4096, 'failed', undefined],
      ['q4_0', undefined, undefined, 'failed'],
    ]);
  });
});
