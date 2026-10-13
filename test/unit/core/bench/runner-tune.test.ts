/**
 * The runner's side of "Trova le impostazioni migliori" (its lab: launches, measurements, memory,
 * events, the saved result) and of the context-sweep step, on the fake machine of fakes.ts.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { launchParamsSchema } from '../../../../src/contract/engines';
import { AppError } from '../../../../src/contract/errors';
import type { Scenario } from '../../../../src/contract/results';
import { BenchRunner, recommendedOf, userContext, type RunInput, type RunnerDeps } from '../../../../src/core/bench/runner';
import { buildScenario } from '../../../../src/core/bench/scenarios';
import type { TuneSpace, TunerInput } from '../../../../src/core/bench/tuner';
import { hardware } from '../store/fixtures';
import { displayCommand, events, FakeAdapter, FakeTelemetry, memoryRuns, modelTarget, SMALL_CORPUS, World, type AdapterOptions, type TelemetryOptions } from './fakes';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(o: { adapter?: AdapterOptions; telemetry?: TelemetryOptions; deps?: Partial<RunnerDeps> } = {}) {
  const world = new World();
  const adapter = new FakeAdapter(world, o.adapter);
  const telemetry = new FakeTelemetry(world, o.telemetry);
  const runs = memoryRuns();
  const ev = events();
  const cacheDir = mkdtempSync(path.join(os.tmpdir(), 'gb-runner-tune-'));
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

/** Two KV types, no other dimension: the search is short and its order known. */
const space: TuneSpace = {
  kvLadder: ['f16', 'q4_0'],
  base: (kv) => ({ kv }),
  dimensions: [],
  contextFor: (users, perUser) => users * perUser,
  params: (v, ctx) => launchParamsSchema.parse({ contextSize: ctx, kvCacheType: v.kv, ...(typeof v.np === 'number' ? { parallel: v.np } : {}) }),
  tags: () => [],
};

function tuneInput(over: Partial<TunerInput> = {}, run: Partial<RunInput> = {}): RunInput {
  return {
    runId: 'TUNE1',
    engineConfig: { kind: 'llamacpp-native' },
    model: modelTarget(),
    params: launchParamsSchema.parse({}),
    scenario: buildScenario('tune'),
    port: 5555,
    marker: 'gpubench-tune',
    allowSharedGpu: false,
    tune: { space, budget: 'fast', sweep: { outputTokens: 64, reps: 1 }, modelContext: 8192, spillPossible: false, fidelity: false, ...over },
    ...run,
  };
}

describe('BenchRunner — tune runs', () => {
  it('runs the search on its own launches and saves it, described by the recommended combination', async () => {
    // f16 at 8K runs out of memory (first launch), everything else loads.
    let starts = 0;
    const s = setup({
      adapter: { failStart: () => (++starts === 1 ? new AppError('ENGINE_OOM', 'cudaMalloc failed: out of memory') : undefined), client: { bos: 1, pieces: 'ids' } },
      telemetry: { live: true },
    });
    const result = await s.runner.run(tuneInput({ fidelity: true }), new AbortController().signal);
    expect(result.status).toBe('completed');
    const t = result.tuning!;
    // Capacity checks, then each type screened at its largest context; on these short contexts the
    // screening measured the whole grid: it is the sweep, no other launch.
    expect(t.attempts.map((a) => `${a.stage} ${a.kvType}@${a.contextSize} ${a.outcome}`)).toEqual([
      'capacity f16@8192 oom',
      'capacity f16@4096 ok',
      'capacity q4_0@8192 ok',
      'variant q4_0@8192 ok',
      'variant f16@4096 ok',
      'fidelity f16@4096 ok',
      'fidelity q4_0@4096 ok',
    ]);
    expect(t.estimateSeconds).toBeGreaterThan(0);
    expect(t.limitSeconds).toBeGreaterThanOrEqual(t.estimateSeconds!);
    expect(t.attempts[0]!.error).toMatchObject({ code: 'ENGINE_OOM' });
    expect(t.attempts[1]!.vramPeakMiB).toBe(4000);
    expect(t.fidelity).toMatchObject({ referenceKv: 'f16', comparedKv: 'q4_0', tokens: 128, identical: 128 });
    const rec = t.combinations[t.recommended!]!;
    expect(rec).toMatchObject({ kvType: 'q4_0', maxContext: 8192 });
    expect(rec.sweep.map((p) => p.promptTokens)).toEqual([1024, 4096, 8112]);
    // The run itself reads as its recommendation.
    expect(result.launch.params).toMatchObject({ contextSize: 8192, kvCacheType: 'q4_0' });
    expect(result.metrics.contextSweep).toEqual(rec.sweep);
    expect(result.metrics.latency).toEqual([]);
    expect(s.runs.saved[0]!.tuning).toEqual(t);
    // Live: the search after every change, every engine that became ready, every measurement.
    expect(s.ev.ofType('run.tune').length).toBeGreaterThan(10);
    expect(s.ev.ofType('run.tune').some((e) => e.current?.stage === 'fidelity')).toBe(true);
    expect(s.ev.ofType('run.launch')).toHaveLength(6);
    expect(s.ev.ofType('run.launch')[0]!.launch).toMatchObject({ contextSize: 4096, params: { kvCacheType: 'f16' }, engineLabel: 'llama.cpp b11438 (CUDA 13.4)' });
    const points = s.ev.ofType('run.point').map((e) => e.live);
    expect(new Set(points.map((p) => p.stepKind))).toEqual(new Set(['tune-probe', 'tune-screen']));
    expect(points.every((p) => 'attempt' in p && p.attempt !== undefined)).toBe(true);
    expect(s.ev.ofType('run.step').map((e) => e.current.kind)).toEqual(expect.arrayContaining(['load', 'tune-probe', 'tune-screen', 'fidelity']));
    const phases = [...new Set(s.ev.ofType('run.phase').map((e) => e.phase))];
    expect(phases).toEqual(['prepare', 'tune-capacity', 'tune-variants', 'fidelity', 'cleanup']);
    // Progress follows the search's own forecast, never past 98 % before the cleanup, with the time left.
    const searching = s.ev.ofType('run.phase').filter((e) => e.phase !== 'cleanup' && e.phase !== 'prepare');
    expect(searching.every((e) => e.progress <= 0.98 && e.remainingSeconds !== undefined)).toBe(true);
    expect(s.ev.ofType('run.phase').find((e) => e.phase === 'cleanup')!.remainingSeconds).toBeUndefined();
    expect(s.adapter.instances.every((i) => i.stopped)).toBe(true);
    // The first launch never started: its attempt has no log.
    expect(result.logExcerpt).toContain('=== tune 2 (capacity) ===');
    expect(result.logExcerpt).not.toContain('=== tune 1 (capacity) ===');
  });

  it('a start that fails or a server that never gets ready count as "does not load"; the engine is stopped', async () => {
    const s = setup({
      adapter: {
        perStart: (n) => (n === 1 ? { failReady: new AppError('ENGINE_OOM', 'cudaMalloc failed') } : undefined),
        client: { pieces: 'text', tokenizeUnsupported: true },
      },
      telemetry: { processVram: { others: () => [] } },
    });
    const result = await s.runner.run(tuneInput({ fidelity: true }), new AbortController().signal);
    const t = result.tuning!;
    expect(t.attempts[0]).toMatchObject({ contextSize: 8192, outcome: 'oom', loadMs: 0, error: { code: 'ENGINE_OOM' } });
    expect(s.adapter.instances[0]!.stopped).toBe(true);
    // Per-process memory (Windows counters / nvidia-smi) when the OS attributes it.
    expect(t.attempts.filter((a) => a.outcome === 'ok').every((a) => a.vramPeakMiB === 4000)).toBe(true);
    // Text prompts (no tokenizer): the fidelity check compares text pieces.
    expect(t.fidelity).toMatchObject({ referenceKv: 'f16', comparedKv: 'q4_0', tokens: 128, identical: 128 });
  });

  it('the shared GPU memory of the engine process feeds the spill check (Windows)', async () => {
    // A little pinned host memory is normal; gigabytes would be a spill (see tuner.test.ts).
    const s = setup({ telemetry: { processVram: { sharedMiB: 100 } } });
    const result = await s.runner.run(tuneInput({ spillPossible: true }), new AbortController().signal);
    const ref = result.tuning!.attempts[0]!;
    expect(ref).toMatchObject({ stage: 'reference', outcome: 'ok', sharedPeakMiB: 100, vramPeakMiB: 4000 });
    expect(result.tuning!.attempts.every((a) => a.outcome === 'ok' && a.sharedPeakMiB === 100)).toBe(true);
  });

  it('vLLM: the KV capacity from the server log bounds the search', async () => {
    const vspace: TuneSpace = { ...space, kvLadder: ['auto', 'fp8'], params: (v, ctx) => launchParamsSchema.parse({ maxModelLen: ctx, kvCacheType: v.kv }) };
    const s = setup({ adapter: { kind: 'vllm-docker', instance: { logs: ['INFO [kv_cache_utils.py:849] GPU KV cache size: 6,000 tokens'] } } });
    const result = await s.runner.run(tuneInput({ space: vspace }, { engineConfig: { kind: 'vllm-docker' } }), new AbortController().signal);
    const t = result.tuning!;
    expect(t.attempts[0]).toMatchObject({ kvType: 'auto', contextSize: 8192, outcome: 'ok' });
    // vLLM said 6 000 tokens: 8K is impossible after all, its exact capacity (5K) is tried and kept.
    expect(t.attempts[1]).toMatchObject({ kvType: 'auto', contextSize: 5120, outcome: 'ok' });
    expect(t.capacity[0]).toMatchObject({ kvType: 'auto', measuredMax: 5120 });
  });

  it('a model the engine build cannot read ends the run at its first launch, with that error', async () => {
    let starts = 0;
    const unsupported = new AppError('ENGINE_MODEL_UNSUPPORTED', 'NInfer cannot read this model (layout gguf_blocks_v1)', {
      params: { engine: 'NInfer', reason: 'layout', value: 'gguf_blocks_v1', template: 'ninfer-all', variant: 'NInfer-all' },
    });
    // Windows: the search starts with its reference launch (the user's three "tune 1/2/3 (reference)").
    const s = setup({ adapter: { failStart: () => (++starts, unsupported) } });
    const run = await s.runner.run(tuneInput({ spillPossible: true }), new AbortController().signal);
    expect(starts).toBe(1);
    expect(run.tuning?.attempts.map((a) => [a.stage, a.outcome, a.error?.code])).toEqual([['reference', 'error', 'ENGINE_MODEL_UNSUPPORTED']]);
    expect(run.status).toBe('failed');
    expect(run.error).toMatchObject({ code: 'ENGINE_MODEL_UNSUPPORTED', params: { value: 'gguf_blocks_v1', template: 'ninfer-all' } });
    expect(run.tuning?.stoppedBy).toBe('failed');
  });

  it('a search where no launch ever started is never "completed": it fails with the last launch\'s error', async () => {
    const s = setup({ adapter: { failStart: () => new AppError('ENGINE_EXITED', 'ninfer-serve exited with 1', { params: { code: '1' } }) } });
    const run = await s.runner.run(tuneInput({ spillPossible: true }), new AbortController().signal);
    expect(run.status).toBe('failed');
    expect(run.error).toMatchObject({ code: 'ENGINE_EXITED', params: { code: '1' } });
    expect(run.tuning?.attempts.length).toBeGreaterThan(0);
    expect(run.tuning?.attempts.every((a) => a.outcome === 'error')).toBe(true);
    expect(run.tuning?.stoppedBy).toBe('failed');
    expect(run.tuning?.combinations).toEqual([]);
    // An error that says no more than its words and its log: the same.
    const bare = setup({ adapter: { failStart: () => new AppError('ENGINE_EXITED', 'exited', { detail: 'last lines' }) } });
    expect((await bare.runner.run(tuneInput(), new AbortController().signal)).error).toEqual({ code: 'ENGINE_EXITED', message: 'exited', detail: 'last lines' });
    // Out of memory everywhere is a finding (nothing fits), not a failure to start.
    const oom = setup({ adapter: { failStart: () => new AppError('ENGINE_OOM', 'cudaMalloc failed: out of memory') } });
    expect((await oom.runner.run(tuneInput(), new AbortController().signal)).status).toBe('completed');
  });

  it('failures that repeat on every launch fail the run; cancelling stops it', async () => {
    const bad = setup({ adapter: { failStart: () => new AppError('ENGINE_BAD_FLAG', 'Rejected argument: -ctk', { params: { flag: '-ctk' } }) } });
    const failed = await bad.runner.run(tuneInput(), new AbortController().signal);
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatchObject({ code: 'ENGINE_BAD_FLAG', params: { flag: '-ctk' } });
    // What the search knew is kept: nothing measured yet, the launch that failed with its error.
    expect(failed.tuning?.attempts).toHaveLength(1);
    expect(failed.tuning?.attempts[0]).toMatchObject({ outcome: 'error', error: { code: 'ENGINE_BAD_FLAG' }, points: [] });

    const ac = new AbortController();
    const cancelStart = setup({
      adapter: {
        failStart: (n) => {
          if (n !== 2) return undefined;
          ac.abort();
          return new Error('interrupted');
        },
      },
    });
    expect((await cancelStart.runner.run(tuneInput(), ac.signal)).status).toBe('cancelled');

    const ac2 = new AbortController();
    const cancelReady = setup({
      adapter: {
        perStart: (n) => {
          if (n !== 2) return undefined;
          ac2.abort();
          return { failReady: new Error('aborted') };
        },
      },
    });
    expect((await cancelReady.runner.run(tuneInput(), ac2.signal)).status).toBe('cancelled');

    const ac3 = new AbortController();
    const cancelMeasure = setup({ adapter: { client: { onRequest: (n) => (n === 5 ? ac3.abort() : undefined) } } });
    expect((await cancelMeasure.runner.run(tuneInput(), ac3.signal)).status).toBe('cancelled');
  });

  it('fidelity with an engine that returns neither ids nor text (nothing to compare), no BOS', async () => {
    let starts = 0;
    const s = setup({ adapter: { failStart: () => (++starts === 1 ? new AppError('ENGINE_OOM', 'oom') : undefined) } });
    const result = await s.runner.run(tuneInput({ fidelity: true }), new AbortController().signal);
    expect(result.tuning!.fidelity).toEqual({ referenceKv: 'f16', comparedKv: 'q4_0', promptTokens: 1024, tokens: 0, identical: 0 });
  });

  it('recommendedOf: nothing without a recommendation or its launch record', () => {
    expect(recommendedOf(undefined, new Map())).toBeUndefined();
    const t = { recommended: 0, attempts: [], combinations: [] } as unknown as Parameters<typeof recommendedOf>[0];
    expect(recommendedOf(t, new Map())).toBeUndefined();
  });
});

describe('BenchRunner — context sweep and live steps', () => {
  const sweepScenario = (over: object = {}): Scenario => ({
    profile: 'custom',
    seed: 3,
    steps: [{ kind: 'context-sweep', depths: [1024, 4096, 8000], fractions: false, outputTokens: 32, reps: 2, ...over }],
  });

  it('measures each depth on the same engine, shallow first, and stores the points', async () => {
    const s = setup({ adapter: { client: { timings: true } } });
    const r = await s.runner.run(tuneInputless(sweepScenario()), new AbortController().signal);
    expect(r.metrics.contextSweep.map((p) => [p.promptTokens, p.decodeTps.n])).toEqual([
      [1024, 2],
      [4096, 2],
      [8000, 2],
    ]);
    expect(s.adapter.instances).toHaveLength(1);
    const steps = s.ev.ofType('run.step').map((e) => e.current).filter((c) => c.kind === 'context-sweep');
    expect(steps[0]).toEqual({ kind: 'context-sweep', promptTokens: 1024, depth: 1024, outputTokens: 32, rep: 1, reps: 2 });
    const live = s.ev.ofType('run.point').map((e) => e.live);
    expect(live.filter((p) => p.stepKind === 'context-sweep')).toHaveLength(6);
    expect(s.ev.ofType('run.phase').some((e) => e.phase === 'context-sweep' && e.detail === '8000')).toBe(true);
    expect(r.telemetry?.marks.map((m) => m.label)).toContain('context 4096');
    expect(s.ev.ofType('run.launch')).toHaveLength(1);
  });

  it('stops when its time budget is spent, and says where', async () => {
    const s = setup({ adapter: { client: { prefillTps: 100 } } });
    const r = await s.runner.run(tuneInputless(sweepScenario({ maxSeconds: 60 })), new AbortController().signal);
    expect(r.metrics.contextSweep.map((p) => p.promptTokens)).toEqual([1024]);
    expect(r.notes).toContainEqual({ code: 'context_sweep_budget', params: { depth: 4096, seconds: 60 } });
    expect(r.logExcerpt).toContain('context sweep stopped at 4096 tokens');
  });

  it('live steps for loads, first token, latency warm-ups and llama-bench; per-user context at each level', async () => {
    const s = setup({ adapter: { parallel: 4 }, deps: { llamaBench: async () => [{ test: 'pp512', tps: 1, stddev: 0 }] } });
    const scenario: Scenario = {
      profile: 'custom',
      seed: 1,
      steps: [
        { kind: 'load', cache: 'warm', reps: 1 },
        { kind: 'latency', promptTokens: [64], outputTokens: 8, warmup: 1, reps: 1 },
        { kind: 'concurrency', levels: [2], promptTokens: 64, outputTokens: 8, requestsPerWorker: 1 },
        { kind: 'llama-bench', pp: 512, tg: 128, reps: 2 },
      ],
    };
    const r = await s.runner.run(tuneInputless(scenario, { params: launchParamsSchema.parse({ contextSize: 4096, parallel: 4 }) }), new AbortController().signal);
    const kinds = s.ev.ofType('run.step').map((e) => e.current);
    expect(kinds[0]).toEqual({ kind: 'load', label: 'warm', rep: 1, reps: 1 });
    expect(kinds).toContainEqual({ kind: 'first-token', outputTokens: 1 });
    expect(kinds).toContainEqual({ kind: 'latency', promptTokens: 64, outputTokens: 8, rep: 1, reps: 1, warmup: true });
    expect(kinds).toContainEqual({ kind: 'concurrency', concurrency: 2, promptTokens: 64, outputTokens: 8, rep: 2, reps: 2 });
    expect(kinds).toContainEqual({ kind: 'llama-bench', promptTokens: 512, outputTokens: 128, reps: 2 });
    expect(r.metrics.concurrency[0]).toMatchObject({ level: 2, promptTokens: 64, outputTokens: 8, contextPerUser: 1024, contextShared: false });
    expect(s.ev.ofType('run.point').map((e) => e.live.stepKind)).toEqual(['latency', 'concurrency']);
  });

  it('userContext: split slots, unified KV, vLLM pool, unknown context', () => {
    const p = (o: object) => launchParamsSchema.parse(o);
    expect(userContext({ kind: 'llamacpp-native', argv: [], params: p({ contextSize: 8192, parallel: 4 }) })).toEqual({ contextPerUser: 2048, contextShared: false });
    expect(userContext({ kind: 'llamacpp-docker', argv: ['--kv-unified'], params: p({ contextSize: 8192, parallel: 4 }) })).toEqual({ contextPerUser: 8192, contextShared: true });
    expect(userContext({ kind: 'llamacpp-native', argv: [], params: p({ contextSize: 8192 }) })).toEqual({ contextPerUser: 8192, contextShared: false });
    expect(userContext({ kind: 'vllm-docker', argv: [], params: p({ maxModelLen: 16384 }) })).toEqual({ contextPerUser: 16384, contextShared: true });
    expect(userContext({ kind: 'external', argv: [], params: p({}) })).toEqual({});
  });
});

/** A normal (non-tune) run input. */
function tuneInputless(scenario: Scenario, over: Partial<RunInput> = {}): RunInput {
  const { tune: _tune, ...rest } = tuneInput({}, { scenario, ...over });
  return rest;
}
