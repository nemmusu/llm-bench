import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { launchParamsSchema } from '../../../../src/contract/engines';
import type { Scenario, SessionsStep } from '../../../../src/contract/results';
import { BenchRunner, type RunInput } from '../../../../src/core/bench/runner';
import { hardware } from '../store/fixtures';
import { displayCommand, events, FakeAdapter, FakeTelemetry, memoryRuns, modelTarget, SMALL_CORPUS, World, type AdapterOptions } from './fakes';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(adapterOptions: AdapterOptions = {}) {
  const world = new World();
  const adapter = new FakeAdapter(world, adapterOptions);
  const ev = events();
  const runs = memoryRuns();
  const cacheDir = mkdtempSync(path.join(os.tmpdir(), 'gb-sessions-'));
  dirs.push(cacheDir);
  const runner = new BenchRunner({
    clock: world.clock,
    adapter,
    telemetry: new FakeTelemetry(world, { available: false }),
    runs,
    publish: ev.publish,
    fingerprint: async () => hardware(),
    displayCommand,
    appVersion: '0.1.0-test',
    cacheDir,
    corpus: async () => SMALL_CORPUS,
    ownPids: () => [],
  });
  return { world, adapter, ev, runs, runner };
}

const sessions = (over: Partial<SessionsStep> = {}): SessionsStep => ({ kind: 'sessions', depth: 300, levels: [1, 2], turns: 2, followupTokens: 16, outputTokens: 4, ...over });
const scenario = (...steps: Scenario['steps']): Scenario => ({ profile: 'custom', seed: 7, steps });

function input(over: Partial<RunInput> = {}): RunInput {
  return {
    runId: 'RUN1',
    engineConfig: { kind: 'llamacpp-native' },
    model: modelTarget(),
    params: launchParamsSchema.parse({ parallel: 2 }),
    scenario: scenario({ kind: 'load', cache: 'warm', reps: 1 }, sessions()),
    port: 5555,
    marker: 'gpubench-test',
    allowSharedGpu: false,
    ...over,
  };
}

const KV_LOG = ['llama_context: n_seq_max     = 2', 'llama_context: n_ctx         = 8192', 'llama_context: n_ctx_seq     = 4096', 'main: server is listening on http://127.0.0.1:5555'];

describe('BenchRunner: long conversations', () => {
  it('llama.cpp: levels in order, one slot per conversation, live steps and points, KV capacity and start progress', async () => {
    const { adapter, ev, runner } = setup({ parallel: 2, instance: { logs: ['llama_model_loader: loaded meta data with 35 key-value pairs', 'load_tensors: loading model tensors', ...KV_LOG] } });
    const result = await runner.run(input({ expectedLoadMs: { warm: 2500 } }), new AbortController().signal);
    expect(result.status).toBe('completed');
    expect(result.metrics.sessions.map((p) => p.sessions)).toEqual([1, 2]);
    expect(result.metrics.sessions[1]).toMatchObject({ depth: 300, turns: 2, requests: 4, errors: 0 });
    expect(result.metrics.kvCapacity).toEqual({ tokens: 8192, maxConcurrencyAtTokens: { tokens: 4096, concurrency: 2 } });
    // Probe + 2 messages alone + 2 × 2 at once; the conversations keep their slot and the cache on.
    const sent = adapter.client.requests.filter((r) => r.cachePrompt);
    expect(sent).toHaveLength(6);
    expect(sent.slice(2).map((r) => r.slot).sort()).toEqual([0, 0, 1, 1]);
    expect(ev.ofType('run.phase').some((e) => e.phase === 'sessions')).toBe(true);
    expect(ev.ofType('run.step').filter((e) => e.current.kind === 'sessions')).toHaveLength(6);
    expect(ev.ofType('run.point').filter((e) => e.live.stepKind === 'sessions').length).toBeGreaterThanOrEqual(8);
    // run.load: what the engine was doing, ending with ready; the usual warm load time comes along.
    const loads = ev.ofType('run.load');
    expect(loads[0]).toMatchObject({ runId: 'RUN1', stage: 'starting', elapsedMs: 0, expectedMs: 2500 });
    expect(loads.map((e) => e.stage)).toContain('metadata');
    expect(loads.at(-1)).toMatchObject({ stage: 'ready', expectedMs: 2500 });
  });

  it('vLLM: no slots to pin; a cold start gets the usual cold time', async () => {
    const { adapter, ev, runner } = setup({ kind: 'vllm-docker', client: { flavor: 'vllm' } });
    const result = await runner.run(
      input({
        engineConfig: { kind: 'vllm-docker' },
        params: launchParamsSchema.parse({}),
        scenario: scenario({ kind: 'load', cache: 'cold', reps: 1 }, sessions({ levels: [2] })),
        expectedLoadMs: { cold: 9000 },
      }),
      new AbortController().signal,
    );
    expect(result.status).toBe('completed');
    expect(adapter.client.requests.filter((r) => r.cachePrompt).every((r) => r.slot === undefined)).toBe(true);
    expect(ev.ofType('run.load')[0]).toMatchObject({ stage: 'container', expectedMs: 9000 });
    expect(result.metrics.kvCapacity).toBeUndefined();
  });

  it('time budget spent: the remaining levels are skipped and the result says so', async () => {
    const { runner } = setup({ parallel: 4 });
    const result = await runner.run(input({ params: launchParamsSchema.parse({ parallel: 4 }), scenario: scenario(sessions({ depth: 5000, levels: [1, 2, 4], maxSeconds: 1 })) }), new AbortController().signal);
    expect(result.status).toBe('completed');
    expect(result.metrics.sessions.map((p) => p.sessions)).toEqual([1]);
    expect(result.notes).toContainEqual({ code: 'sessions_budget', params: { sessions: 2, seconds: 1 } });
    expect(result.logExcerpt).toContain('long conversations stopped before 2 at once');
  });

  it('the engine dies during the conversations: the run fails as an engine exit', async () => {
    const hook = { crash: () => {} };
    const { adapter, runner } = setup({ parallel: 2, client: { onRequest: (n) => n === 4 && hook.crash() } });
    hook.crash = () => adapter.instances[0]?.crash(3);
    const result = await runner.run(input(), new AbortController().signal);
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('ENGINE_EXITED');
  });
});
