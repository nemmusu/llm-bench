import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { launchParamsSchema } from '../../../../src/contract/engines';
import { AppError } from '../../../../src/contract/errors';
import type { Scenario } from '../../../../src/contract/results';
import {
  BenchRunner,
  buildLogExcerpt,
  exampleBody,
  LOG_EXCERPT_BYTES,
  LOG_EXCERPT_LINES,
  loadSequence,
  type RunInput,
  type RunnerDeps,
} from '../../../../src/core/bench/runner';
import { buildScenario } from '../../../../src/core/bench/scenarios';
import type { ScoreReference } from '../../../../src/core/bench/score';
import { hardware, modelIdentity } from '../store/fixtures';
import {
  displayCommand,
  events,
  FakeAdapter,
  FakeTelemetry,
  memoryRuns,
  modelTarget,
  SMALL_CORPUS,
  World,
  type AdapterOptions,
  type TelemetryOptions,
} from './fakes';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ref: ScoreReference = {
  version: 1,
  provisional: true,
  referenceModel: { repo: 'Qwen/Qwen3-4B-GGUF', file: 'Qwen3-4B-Q4_K_M.gguf' },
  D_ref: 250,
  P_ref: 12000,
  L_ref: 1.5,
};

interface SetupOptions {
  adapter?: AdapterOptions;
  telemetry?: TelemetryOptions;
  saveFails?: Error;
  deps?: Partial<RunnerDeps>;
  evict?: 'guaranteed' | 'not-guaranteed' | 'none';
}

function setup(o: SetupOptions = {}) {
  const world = new World();
  const adapter = new FakeAdapter(world, o.adapter);
  const telemetry = new FakeTelemetry(world, o.telemetry);
  const runs = memoryRuns(o.saveFails ? { fail: o.saveFails } : {});
  const ev = events();
  const cacheDir = mkdtempSync(path.join(os.tmpdir(), 'gb-runner-'));
  dirs.push(cacheDir);
  const evictCalls: { files: string[]; runningInstances: number }[] = [];
  const evict = o.evict ?? 'guaranteed';
  const runner = new BenchRunner({
    clock: world.clock,
    adapter,
    telemetry,
    runs,
    publish: ev.publish,
    fingerprint: async () => hardware(),
    displayCommand,
    ...(evict === 'none'
      ? {}
      : {
          evictCache: async (files: string[]) => {
            evictCalls.push({ files, runningInstances: adapter.instances.filter((i) => !i.stopped).length });
            world.cacheCold = true;
            return { guaranteed: evict === 'guaranteed' };
          },
        }),
    appVersion: '0.1.0-test',
    cacheDir,
    corpus: async () => SMALL_CORPUS,
    scoreReference: async () => ref,
    ownPids: () => [4242],
    vramSettleMs: 2000,
    ...o.deps,
  });
  return { world, adapter, telemetry, runs, ev, runner, evictCalls, cacheDir };
}

function input(over: Partial<RunInput> = {}): RunInput {
  return {
    runId: 'RUN1',
    engineConfig: { kind: 'llamacpp-native' },
    model: modelTarget(),
    params: launchParamsSchema.parse({}),
    scenario: buildScenario('quick'),
    port: 5555,
    marker: 'gpubench-test',
    allowSharedGpu: false,
    ...over,
  };
}

const custom = (steps: Scenario['steps']): Scenario => ({ profile: 'custom', seed: 7, steps });

describe('loadSequence', () => {
  it('interleaves cold and warm loads', () => {
    const seq = loadSequence(buildScenario('full')).map((l) => l.cache);
    expect(seq).toEqual(['cold', 'warm', 'cold', 'warm', 'cold', 'warm']);
    expect(loadSequence(buildScenario('standard')).map((l) => l.cache)).toEqual(['cold', 'warm', 'warm', 'warm']);
  });
  it('adds one unmeasured start when a server is needed but no load is measured', () => {
    expect(loadSequence(custom([{ kind: 'latency', promptTokens: [8], outputTokens: 2, warmup: 0, reps: 1 }]))).toEqual([
      { cache: 'warm', measured: false },
    ]);
    expect(loadSequence(custom([{ kind: 'llama-bench', pp: 1, tg: 1, reps: 1 }]))).toEqual([]);
  });
});

describe('exampleBody / buildLogExcerpt', () => {
  it('summarizes token arrays and long texts', () => {
    expect(exampleBody({ prompt: [1, 2, 3], n: 1 })).toEqual({ prompt: '<3 token ids>', n: 1 });
    expect((exampleBody({ prompt: 'x'.repeat(300) }).prompt as string).length).toBe(201);
    expect(exampleBody({ prompt: 'short' })).toEqual({ prompt: 'short' });
  });
  it('shortens chat message texts and leaves other bodies alone', () => {
    const body = exampleBody({ messages: [{ role: 'user', content: 'y'.repeat(300) }, { role: 'user', content: 'ok' }, null, 'raw', { role: 'user', content: [] }] });
    const messages = body.messages as unknown[];
    expect(((messages[0] as { content: string }).content).length).toBe(201);
    expect(messages.slice(1)).toEqual([{ role: 'user', content: 'ok' }, null, 'raw', { role: 'user', content: [] }]);
    expect(exampleBody({ max_tokens: 1 })).toEqual({ max_tokens: 1 });
  });
  it('keeps the last lines within the line and byte budgets', () => {
    const many = buildLogExcerpt([{ label: 'warm-load 1', lines: Array.from({ length: 1000 }, (_, i) => `line ${i}`) }], ['note']);
    const lines = many.split('\n');
    expect(lines.length).toBe(LOG_EXCERPT_LINES);
    expect(lines.at(-1)).toBe('note');
    expect(lines.at(-2)).toBe('=== llm-bench ===');
    const wide = buildLogExcerpt([{ label: 'a', lines: Array.from({ length: 300 }, () => 'y'.repeat(1000)) }], []);
    expect(Buffer.byteLength(wide)).toBeLessThanOrEqual(LOG_EXCERPT_BYTES);
    const huge = buildLogExcerpt([{ label: 'a', lines: ['z'.repeat(LOG_EXCERPT_BYTES * 2)] }], []);
    expect(huge.length).toBe(LOG_EXCERPT_BYTES / 4);
    expect(buildLogExcerpt([], [])).toBe('');
  });
});

describe('BenchRunner — happy paths', () => {
  it('quick profile: warm load, first token, latency with exact token-id prompts, saved + events', async () => {
    const s = setup({ adapter: { client: { bos: 1, timings: true } } });
    const result = await s.runner.run(input(), new AbortController().signal);

    expect(result.status).toBe('completed');
    expect(s.runs.saved).toHaveLength(1);
    expect(result.id).toBe('RUN1');
    expect(result.app).toEqual({ name: 'llm-bench', version: '0.1.0-test' });
    expect(result.metrics.load.warmMs?.values).toEqual([2000]);
    expect(result.metrics.load.coldMs).toBeUndefined();
    expect(result.metrics.load.phases.map((p) => p.name)).toEqual(['init', 'load_tensors']);
    expect(result.metrics.firstTokenAfterLoadMs).toBeGreaterThan(0);
    const point = result.metrics.latency[0];
    expect(point?.promptTokens).toBe(512);
    expect(point?.decodeTps.n).toBe(3);
    expect(point?.decodeTps.median).toBeCloseTo(200);
    expect(point?.prefillTpsEngine?.median).toBeCloseTo(10_000);
    expect(point?.itlPerChunk).toBe(false);

    // 1 first-token probe + 1 warmup + 3 reps, every latency prompt exact, BOS first, all different.
    const reqs = s.adapter.client.requests;
    expect(reqs).toHaveLength(5);
    expect(reqs[0]?.promptText).toBeDefined();
    const prompts = reqs.slice(1).map((r) => r.promptIds ?? []);
    expect(prompts.every((p) => p.length === 512 && p[0] === 1)).toBe(true);
    expect(new Set(prompts.map((p) => p.slice(1, 9).join(','))).size).toBe(4);

    expect(result.launch.argv).toContain('gpubench-test');
    expect(result.launch.display.powershell.startsWith('& llama-server')).toBe(true);
    expect(result.launch.requestExample).toMatchObject({ prompt: '<512 token ids>', n_predict: 128 });
    expect(result.engine).toMatchObject({ name: 'llama.cpp', build: 'b11438' });
    expect(result.hardware.hostId).toBe('host-a');
    expect(result.validity).toEqual([]);
    expect(result.metrics.vram).toEqual({ baselineMiB: 1600, peakMiB: 5600, deltaMiB: 4000, method: 'total-delta' });
    expect(result.metrics.energy.avgPowerW).toBeCloseTo(450);
    expect(result.metrics.energy.tokensPerJoule).toBeGreaterThan(0);
    expect(result.metrics.thermals).toEqual({ maxTempC: 60, throttleReasons: [] });
    expect(result.metrics.score).toBeUndefined();
    expect(result.telemetry?.t.length).toBeGreaterThan(5);
    expect(result.telemetry?.marks.map((m) => m.label)).toContain('warm-load 1');
    expect(result.logExcerpt).toContain('=== warm-load 1 ===');
    expect(s.adapter.instances.every((i) => i.stopped)).toBe(true);

    const phases = s.ev.ofType('run.phase');
    expect(phases[0]).toMatchObject({ phase: 'prepare', progress: 0 });
    expect([...new Set(phases.map((p) => p.phase))]).toEqual(['prepare', 'warm-load', 'decode', 'cleanup']);
    const progress = phases.map((p) => p.progress);
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);
    expect(progress.at(-1)).toBeGreaterThanOrEqual(0.99);
    expect(s.ev.ofType('run.live').some((e) => e.loadMs === 2000)).toBe(true);
    expect(s.ev.ofType('run.live').filter((e) => e.decodeTps !== undefined)).toHaveLength(3);
    expect(s.ev.ofType('run.log').flatMap((e) => e.lines)).toEqual(['llama server listening', 'load_tensors: loading model']);
    expect(s.ev.ofType('telemetry').length).toBeGreaterThan(0);
    expect(s.ev.ofType('run.error')).toEqual([]);
    const last = s.ev.list.slice(-2);
    expect(last[0]).toMatchObject({ type: 'run.done', runId: 'RUN1', summary: { status: 'completed', decodeTps: point?.decodeTps.median } });
    expect(last[1]).toEqual({ type: 'runs.changed' });
  });

  it('standard profile: evicted cold loads interleaved with warm loads, prefill/decode/concurrency, score', async () => {
    const s = setup({ adapter: { parallel: 4, coldMs: 9000, warmMs: 1500 } });
    const result = await s.runner.run(input({ scenario: buildScenario('standard'), vramEstimateMiB: 4200, note: 'my note' }), new AbortController().signal);

    expect(result.status).toBe('completed');
    expect(result.metrics.load.coldMs?.values).toEqual([9000]);
    expect(result.metrics.load.warmMs?.values).toEqual([1500, 1500, 1500]);
    expect(s.evictCalls).toEqual([{ files: ['C:/models/m.gguf'], runningInstances: 0 }]);
    expect(result.metrics.load.coldReadBytesPerSec).toBeCloseTo(5e9 / ((9000 - 200) / 1000));
    expect(result.metrics.latency.map((p) => p.promptTokens)).toEqual([512, 4096]);
    expect(result.metrics.concurrency.map((c) => c.level)).toEqual([1, 2, 3, 4]);
    expect(result.metrics.concurrency[3]).toMatchObject({ level: 4, requests: 16, errors: 0 });
    expect(result.metrics.vram.estimateMiB).toBe(4200);
    expect(result.metrics.score?.referenceVersion).toBe(1);
    expect(result.metrics.score?.value).toBeGreaterThan(0);
    expect(result.note).toBe('my note');
    expect(s.adapter.instances).toHaveLength(4);
    expect(s.adapter.instances.every((i) => i.stopped)).toBe(true);
    const phases = [...new Set(s.ev.ofType('run.phase').map((p) => p.phase))];
    expect(phases).toEqual(['prepare', 'cold-load', 'warm-load', 'prefill', 'decode', 'concurrency', 'cleanup']);
    expect(s.ev.ofType('run.phase').find((p) => p.phase === 'prefill')?.detail).toBe('4096');
    // The corpus was tokenized once (cached for the next run).
    const before = s.adapter.client.tokenizeCalls;
    await s.runner.run(input({ runId: 'RUN2' }), new AbortController().signal);
    expect(s.adapter.client.tokenizeCalls).toBe(before);
  });

  it('secrets are redacted in the stored launch record', async () => {
    const s = setup({
      deps: {
        redact: (argv, env) => ({
          argv: argv.map((a) => (a === 'gpubench-test' ? '<MARKER>' : a)),
          env: Object.fromEntries(Object.keys(env).map((k) => [k, '<HIDDEN>'])),
        }),
      },
    });
    const result = await s.runner.run(input(), new AbortController().signal);
    expect(result.launch.argv).toContain('<MARKER>');
    expect(result.launch.env).toEqual({ CUDA_VISIBLE_DEVICES: '<HIDDEN>' });
    expect(result.launch.display.bash).toContain('<MARKER>');
  });

  it('llama.cpp with fewer slots than a concurrency level skips it with a note', async () => {
    const s = setup();
    const result = await s.runner.run(
      input({ scenario: custom([{ kind: 'concurrency', levels: [1, 2], promptTokens: 16, outputTokens: 4, requestsPerWorker: 1 }]) }),
      new AbortController().signal,
    );
    expect(result.metrics.concurrency.map((c) => c.level)).toEqual([1]);
    expect(result.logExcerpt).toContain('concurrency level 2 skipped');
    expect(result.metrics.load.warmMs).toBeUndefined();
  });

  it('vLLM-style engines serve any level; docker engines flag approximate VRAM', async () => {
    const s = setup({ adapter: { kind: 'vllm-docker', client: { flavor: 'vllm' } } });
    const result = await s.runner.run(
      input({
        engineConfig: { kind: 'vllm-docker' },
        model: modelTarget({ servedName: 'qwen' }),
        scenario: custom([{ kind: 'concurrency', levels: [2], promptTokens: 16, outputTokens: 4, requestsPerWorker: 2 }]),
      }),
      new AbortController().signal,
    );
    expect(result.metrics.concurrency[0]).toMatchObject({ level: 2, requests: 4 });
    expect(result.validity).toContain('vram_approximate');
    expect(s.adapter.client.requests.every((r) => r.model === 'qwen')).toBe(true);
  });

  it('chat servers: text calibrated on their own counts; a prompt far from the length asked makes counts approximate', async () => {
    const s = setup({
      adapter: {
        kind: 'external',
        client: { flavor: 'openai', tokenizeUnsupported: true, promptTokensOf: (chars) => (chars < 12_000 ? Math.round(chars / 4) + 30 : Math.round(chars / 3)) },
      },
      telemetry: { available: false },
    });
    const result = await s.runner.run(
      input({ engineConfig: { kind: 'external', baseUrl: 'http://127.0.0.1:9999' }, scenario: custom([{ kind: 'latency', promptTokens: [64, 4096], outputTokens: 4, warmup: 0, reps: 1 }]) }),
      new AbortController().signal,
    );
    expect(result.notes?.some((n) => n.code === 'text_prompts_calibrated' && n.params?.overhead === 30)).toBe(true);
    expect(result.validity).toContain('tokens_approximate');
  });

  it('endpoints without /tokenize: text prompts, approximate counts, per-chunk ITL, inexact output', async () => {
    const s = setup({
      adapter: { kind: 'external', client: { flavor: 'openai', tokenizeUnsupported: true, reportTokens: false, usage: false, shortBy: 2 } },
      telemetry: { available: false },
    });
    const result = await s.runner.run(
      input({
        engineConfig: { kind: 'external', baseUrl: 'http://127.0.0.1:9999' },
        scenario: custom([
          { kind: 'latency', promptTokens: [64], outputTokens: 8, warmup: 0, reps: 2 },
          { kind: 'concurrency', levels: [1], promptTokens: 16, outputTokens: 8, requestsPerWorker: 1 },
        ]),
        slowSharedFilesystem: true,
      }),
      new AbortController().signal,
    );
    expect(result.status).toBe('completed');
    // One calibration request within the scenario's own longest prompt (64 tokens: 16 first), then the prompts.
    expect(s.adapter.client.requests.slice(1).map((r) => r.promptText?.length)).toEqual([64, 256, 256, 64]);
    expect(result.metrics.latency[0]?.itlPerChunk).toBe(true);
    expect(result.metrics.firstTokenAfterLoadMs).toBeGreaterThan(0);
    expect(result.metrics.concurrency).toHaveLength(1);
    // No VRAM measured at all (no telemetry): nothing to qualify.
    expect(result.validity).toEqual(['output_not_exact', 'tokens_approximate', 'slow_shared_filesystem', 'energy_unavailable']);
    expect(result.logExcerpt).toContain('tokenize unsupported');
    expect(result.telemetry).toBeUndefined();
    expect(result.metrics.vram).toEqual({});
    expect(s.telemetry.sessions).toBe(0);
  });

  it('llama-bench runs after the server is stopped (native only); skipped otherwise', async () => {
    const calls: number[] = [];
    let s = setup({
      deps: {
        llamaBench: async (_plan, step) => {
          calls.push(s.adapter.instances.filter((i) => !i.stopped).length);
          return [{ test: `pp${step.pp}`, tps: 9000, stddev: 10 }];
        },
      },
    });
    const scenario = custom([
      { kind: 'latency', promptTokens: [16], outputTokens: 2, warmup: 0, reps: 1 },
      { kind: 'llama-bench', pp: 512, tg: 128, reps: 1 },
    ]);
    const r1 = await s.runner.run(input({ scenario }), new AbortController().signal);
    expect(r1.metrics.llamaBench).toEqual([{ test: 'pp512', tps: 9000, stddev: 10 }]);
    expect(calls).toEqual([0]);

    s = setup();
    const r2 = await s.runner.run(input({ scenario }), new AbortController().signal);
    expect(r2.metrics.llamaBench).toEqual([]);
    expect(r2.logExcerpt).toContain('llama-bench skipped');

    s = setup({ adapter: { kind: 'llamacpp-docker' }, deps: { llamaBench: async () => [] } });
    const r3 = await s.runner.run(input({ engineConfig: { kind: 'llamacpp-docker' }, scenario }), new AbortController().signal);
    expect(r3.logExcerpt).toContain('llama-bench skipped');
  });

  it('a load-only scenario never tokenizes the corpus', async () => {
    const s = setup({ evict: 'not-guaranteed', adapter: { modelBytes: 8 * 1024 ** 3, coldMs: 2100, warmMs: 2000 } });
    const result = await s.runner.run(input({ scenario: custom([{ kind: 'load', cache: 'cold', reps: 1 }, { kind: 'load', cache: 'warm', reps: 1 }]) }), new AbortController().signal);
    expect(s.adapter.client.tokenizeCalls).toBe(0);
    expect(result.validity).toEqual(['cold_not_guaranteed', 'cold_probably_cached']);
    expect(result.metrics.latency).toEqual([]);
    expect(result.metrics.energy).toEqual({});
  });

  it('without an evictCache dependency cold loads are not guaranteed', async () => {
    const s = setup({ evict: 'none' });
    const result = await s.runner.run(input({ scenario: custom([{ kind: 'load', cache: 'cold', reps: 1 }]) }), new AbortController().signal);
    expect(result.validity).toContain('cold_not_guaranteed');
    expect(result.metrics.load.coldReadBytesPerSec).toBeCloseTo(5e9 / 1.8);
  });

  it('rates that cannot be computed are left out of live events', async () => {
    const s = setup({ adapter: { client: { prefillTps: Number.POSITIVE_INFINITY, firstChunkDelayMs: 0 } } });
    const result = await s.runner.run(input({ scenario: custom([{ kind: 'latency', promptTokens: [8], outputTokens: 1, warmup: 0, reps: 1 }]) }), new AbortController().signal);
    expect(result.status).toBe('completed');
    const live = s.ev.ofType('run.live').filter((e) => e.tokens !== undefined);
    expect(live).toEqual([{ type: 'run.live', runId: 'RUN1', ttftMs: 0, tokens: 1 }]);
  });
});

describe('BenchRunner — shared GPU', () => {
  const llm = { pid: 1234, name: 'llama-server.exe', knownLlm: true };

  it('refuses when another LLM server holds the GPU (and still saves the run)', async () => {
    const s = setup({ telemetry: { users: [llm, { pid: 9, name: 'dwm.exe', knownLlm: false }] } });
    const result = await s.runner.run(input(), new AbortController().signal);
    expect(result.status).toBe('failed');
    expect(result.error).toMatchObject({ code: 'VRAM_BUSY', params: { names: 'llama-server.exe', pids: '1234' } });
    expect(s.adapter.instances).toHaveLength(0);
    expect(result.launch.argv).toContain('gpubench-test');
    expect(result.engine.name).toBe('llama.cpp');
    expect(s.runs.saved).toHaveLength(1);
    const types = s.ev.list.map((e) => e.type).slice(-3);
    expect(types).toEqual(['run.error', 'run.done', 'runs.changed']);
    expect(s.ev.ofType('run.done')[0]?.summary.status).toBe('failed');
  });

  it('proceeds when allowed and flags gpu_shared', async () => {
    const s = setup({ telemetry: { users: [llm] } });
    const result = await s.runner.run(input({ allowSharedGpu: true }), new AbortController().signal);
    expect(result.status).toBe('completed');
    expect(result.validity).toContain('gpu_shared');
    expect(result.logExcerpt).toContain('GPU shared with llama-server.exe (LLM server, PID 1234)');
  });

  const users = [
    { pid: 2260, name: 'dwm', knownLlm: false, kind: 'system' as const, memMiB: 3300 },
    { pid: 33864, name: 'firefox.exe', knownLlm: false, kind: 'app' as const, memMiB: 2900 },
    { pid: 29192, name: 'vmwp', knownLlm: false, kind: 'vm' as const, memMiB: 18000 },
  ];

  it('refuses when VMs/apps hold the VRAM the model needs (free 6607 < need 9000), naming only what must close', async () => {
    const s = setup({ telemetry: { users } });
    s.world.baselineMiB = 26_000;
    const result = await s.runner.run(input({ vramEstimateMiB: 9000 }), new AbortController().signal);
    expect(result.status).toBe('failed');
    expect(result.error).toEqual({
      code: 'VRAM_BUSY',
      message: 'Other processes hold the VRAM this model needs',
      params: { names: 'vmwp', pids: '29192', freeMiB: 6607, needMiB: 9000 },
    });
    expect(s.adapter.instances).toHaveLength(0);
    expect(result.logExcerpt).toContain('GPU shared with firefox.exe (PID 33864) 2.8 GB, vmwp (WSL/VM, PID 29192) 17.6 GB');
  });

  it('runs when allowed, when it fits, or when closing them would not be enough', async () => {
    for (const [need, allow] of [
      [9000, true],
      [6000, false],
      [40_000, false],
    ] as const) {
      const s = setup({ telemetry: { users } });
      s.world.baselineMiB = 26_000;
      const result = await s.runner.run(input({ vramEstimateMiB: need, allowSharedGpu: allow }), new AbortController().signal);
      expect(result.status, `need ${need}`).toBe('completed');
      expect(result.validity).toContain('gpu_shared');
    }
    // Without memory readings the free VRAM is unknown: no refusal.
    const blind = setup({ telemetry: { users, memNull: true } });
    expect((await blind.runner.run(input({ vramEstimateMiB: 90_000 }), new AbortController().signal)).status).toBe('completed');
  });
});

describe('BenchRunner — per-process VRAM', () => {
  const vmwpUser = (memMiB: number) => ({ pid: 29192, name: 'vmwp', knownLlm: false, kind: 'vm' as const, memMiB });
  const dwm = { pid: 2260, mib: 3300, name: 'dwm' };

  it('native llama.cpp: the engine\'s own peak is the headline while a WSL server grows meanwhile', async () => {
    let t0 = 0;
    const grown = (t: number) => t - t0 > 1500;
    const s = setup({
      telemetry: {
        users: [vmwpUser(18000), { pid: 1, name: 'vmmem', knownLlm: false, kind: 'vm' }],
        processVram: { engineMiB: 4100.4, others: (t) => [{ pid: 29192, mib: grown(t) ? 28000 : 18000, name: 'vmwp' }, dwm] },
      },
    });
    t0 = s.world.clock.now();
    s.world.othersGrowthMiB = (t) => (grown(t) ? 10_000 : 0);
    const result = await s.runner.run(input({ vramEstimateMiB: 4274 }), new AbortController().signal);
    expect(result.status).toBe('completed');
    expect(result.metrics.vram).toEqual({
      baselineMiB: 1600,
      peakMiB: 15_600,
      deltaMiB: 14_000,
      estimateMiB: 4274,
      processPeakMiB: 4100,
      method: 'process',
    });
    expect(result.validity).toEqual(['gpu_shared']);
    expect(result.logExcerpt).toContain('GPU shared with vmwp (WSL/VM, PID 29192) 17.6 GB');
    expect(result.logExcerpt).toContain('other GPU processes changed their VRAM by up to 10000 MiB during the run');
    // The PID source follows the running instance: before/after the run there is none.
    const pids = s.telemetry.processVramPids[0] as () => number[];
    expect(pids()).toEqual([]);
    const ticks = s.telemetry.recorders[0]!.samples;
    expect(ticks[0]!.engine).toEqual([]);
    expect(ticks.some((t) => t.engine[0] === 7001 && Math.round(t.engineMiB) === 4100)).toBe(true);
  });

  it('native engine the OS does not list (WSL): total-delta, not flagged without evidence of drift', async () => {
    const s = setup({ telemetry: { processVram: { engineMiB: null } } });
    const result = await s.runner.run(input(), new AbortController().signal);
    expect(result.metrics.vram).toMatchObject({ deltaMiB: 4000, method: 'total-delta' });
    expect(result.metrics.vram.processPeakMiB).toBeUndefined();
    expect(result.validity).toEqual([]);
  });

  it('native engine listed with no memory while others grow: total-delta flagged approximate', async () => {
    let t0 = 0;
    const s = setup({ telemetry: { processVram: { engineMiB: 0, others: (t) => [{ pid: 29192, mib: t - t0 > 1500 ? 28000 : 18000, name: 'vmwp' }] } } });
    t0 = s.world.clock.now();
    s.world.othersGrowthMiB = (t) => (t - t0 > 1500 ? 10_000 : 0);
    const result = await s.runner.run(input(), new AbortController().signal);
    expect(result.metrics.vram).toMatchObject({ deltaMiB: 14_000, method: 'total-delta' });
    expect(result.validity).toEqual(['vram_approximate']);
    expect(result.logExcerpt).toContain('changed their VRAM by up to 10000 MiB');
  });

  it('Docker: the helper PID is never the engine; exact enough with a clean VM, approximate when the VM is shared', async () => {
    const docker = { adapter: { kind: 'llamacpp-docker' as const } };
    const clean = setup({ ...docker, telemetry: { processVram: { others: () => [{ pid: 29192, mib: 300, name: 'vmwp' }, dwm] } } });
    const r1 = await clean.runner.run(input({ engineConfig: { kind: 'llamacpp-docker' } }), new AbortController().signal);
    expect(r1.metrics.vram).toMatchObject({ deltaMiB: 4000, method: 'total-delta' });
    expect(r1.metrics.vram.processPeakMiB).toBeUndefined();
    expect(clean.telemetry.recorders[0]!.samples.every((t) => t.engine.length === 0)).toBe(true);
    expect(r1.validity).toEqual([]);

    const shared = setup({ ...docker, telemetry: { users: [vmwpUser(18000)], processVram: {} } });
    const r2 = await shared.runner.run(input({ engineConfig: { kind: 'llamacpp-docker' } }), new AbortController().signal);
    expect(r2.validity).toEqual(['gpu_shared', 'vram_approximate']);

    const unknown = setup(docker);
    const r3 = await unknown.runner.run(input({ engineConfig: { kind: 'llamacpp-docker' } }), new AbortController().signal);
    expect(r3.validity).toEqual(['vram_approximate']);
  });

  it('external endpoints with telemetry: always approximate (loaded before the baseline)', async () => {
    const s = setup({ adapter: { kind: 'external', noPid: true }, telemetry: { processVram: {} } });
    const result = await s.runner.run(input({ engineConfig: { kind: 'external', baseUrl: 'http://127.0.0.1:9999' } }), new AbortController().signal);
    expect(result.metrics.vram.method).toBe('total-delta');
    expect(result.validity).toEqual(['vram_approximate']);
  });

  it('a sampler without per-process support: total-delta', async () => {
    const s = setup({ telemetry: { processVram: {} } });
    (s.telemetry as { startProcessVram?: unknown }).startProcessVram = undefined;
    const result = await s.runner.run(input(), new AbortController().signal);
    expect(result.metrics.vram).toMatchObject({ deltaMiB: 4000, method: 'total-delta' });
    expect(s.telemetry.recorders).toEqual([]);
  });

  it('a failing per-process sampler never fails the run', async () => {
    const broken = setup({ telemetry: { processVram: { startThrows: true } } });
    const r1 = await broken.runner.run(input(), new AbortController().signal);
    expect(r1.status).toBe('completed');
    expect(r1.metrics.vram.method).toBe('total-delta');

    const stuck = setup({ telemetry: { processVram: { stopThrows: true } } });
    const r2 = await stuck.runner.run(input(), new AbortController().signal);
    expect(r2.status).toBe('completed');
    expect(r2.metrics.vram).toMatchObject({ processPeakMiB: 4000, method: 'process' });
  });
});

describe('BenchRunner — failures', () => {
  it('cancellation mid-latency: engine stopped, partial data, status cancelled', async () => {
    const ac = new AbortController();
    const s = setup({ adapter: { client: { onRequest: (n) => n === 3 && ac.abort() } } });
    const result = await s.runner.run(input(), ac.signal);
    expect(result.status).toBe('cancelled');
    expect(result.error).toEqual({ code: 'CANCELLED', message: 'Run cancelled' });
    expect(s.adapter.instances[0]?.stopped).toBe(true);
    expect(result.metrics.load.warmMs?.n).toBe(1);
    expect(s.ev.ofType('run.error')[0]?.error.code).toBe('CANCELLED');
  });

  it('cancellation before anything started', async () => {
    const ac = new AbortController();
    ac.abort();
    const s = setup();
    const result = await s.runner.run(input(), ac.signal);
    expect(result.status).toBe('cancelled');
    expect(s.adapter.instances).toHaveLength(0);
  });

  it('cancellation while waiting for VRAM to settle', async () => {
    const ac = new AbortController();
    const s = setup();
    s.world.leakMiB = 3000;
    let snapshots = 0;
    const snap = s.telemetry.snapshot.bind(s.telemetry);
    s.telemetry.snapshot = async () => {
      if (++snapshots === 3) ac.abort();
      return snap();
    };
    const result = await s.runner.run(input({ scenario: custom([{ kind: 'load', cache: 'warm', reps: 2 }]) }), ac.signal);
    expect(result.status).toBe('cancelled');
  });

  it('a load failure (OOM) fails the run and stops the instance', async () => {
    const s = setup({ adapter: { instance: { failReady: new AppError('ENGINE_OOM', 'cudaMalloc failed') } } });
    const result = await s.runner.run(input(), new AbortController().signal);
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('ENGINE_OOM');
    expect(s.adapter.instances[0]?.stopped).toBe(true);
    expect(result.metrics.load.warmMs).toBeUndefined();
  });

  it('a start failure fails the run', async () => {
    const s = setup({ adapter: { failStart: () => new AppError('ENGINE_PORT_IN_USE', 'port busy') } });
    const result = await s.runner.run(input(), new AbortController().signal);
    expect(result.error?.code).toBe('ENGINE_PORT_IN_USE');
  });

  it('a planning failure keeps a fallback launch record', async () => {
    const s = setup({ adapter: { failPlan: new Error('bad flag') } });
    const result = await s.runner.run(input(), new AbortController().signal);
    expect(result.error).toEqual({ code: 'INTERNAL', message: 'bad flag' });
    expect(result.launch).toMatchObject({ argv: [], host: '127.0.0.1', port: 5555 });
    expect(result.engine).toEqual({ kind: 'llamacpp-native', name: 'llamacpp-native' });
  });

  it('client errors after the engine died are reported as ENGINE_EXITED', async () => {
    const s = setup({
      adapter: {
        client: {
          failOn: (n) => {
            if (n !== 3) return undefined;
            s.adapter.instances[0]?.crash(139);
            return new AppError('ENDPOINT_UNREACHABLE', 'connection refused');
          },
        },
      },
    });
    const result = await s.runner.run(input(), new AbortController().signal);
    expect(result.error).toMatchObject({ code: 'ENGINE_EXITED', params: { exitCode: 139 }, detail: 'connection refused' });
  });

  it('other errors are kept even if the engine exited; signal exits are described', async () => {
    const s = setup({
      adapter: {
        client: {
          failOn: (n) => {
            if (n !== 2) return undefined;
            s.adapter.instances[0]?.crash(1);
            return new AppError('ENGINE_OOM', 'oom');
          },
        },
      },
    });
    expect((await s.runner.run(input(), new AbortController().signal)).error?.code).toBe('ENGINE_OOM');
  });

  it('concurrency: failed requests are counted; a dead engine aborts the step', async () => {
    const step: Scenario['steps'][number] = { kind: 'concurrency', levels: [2], promptTokens: 16, outputTokens: 4, requestsPerWorker: 2 };
    let s = setup({
      adapter: { parallel: 2, client: { failOn: (n) => (n === 3 ? new AppError('ENDPOINT_INVALID', 'HTTP 500') : undefined) } },
    });
    let result = await s.runner.run(input({ scenario: custom([step]) }), new AbortController().signal);
    expect(result.metrics.concurrency[0]).toMatchObject({ requests: 4, errors: 1 });

    for (const exit of [
      { code: null, signal: 'SIGKILL' },
      { code: null, signal: null },
    ]) {
      s = setup({
        adapter: {
          parallel: 2,
          client: {
            failOn: (n) => {
              if (n !== 2) return undefined;
              const inst = s.adapter.instances[0];
              (inst as unknown as { resolveExit: (e: unknown) => void }).resolveExit(exit);
              return new AppError('ENDPOINT_UNREACHABLE', 'reset');
            },
          },
        },
      });
      result = await s.runner.run(input({ scenario: custom([step]) }), new AbortController().signal);
      expect(result.error).toMatchObject({ code: 'ENGINE_EXITED', params: { exitCode: -1 } });
      expect(result.error?.message).toContain(exit.signal ?? 'unknown');
    }
  });

  it('cancellation during concurrency', async () => {
    const ac = new AbortController();
    const s = setup({ adapter: { parallel: 2, client: { onRequest: (n) => n === 3 && ac.abort() } } });
    const result = await s.runner.run(
      input({ scenario: custom([{ kind: 'concurrency', levels: [2], promptTokens: 16, outputTokens: 4, requestsPerWorker: 3 }]) }),
      ac.signal,
    );
    expect(result.status).toBe('cancelled');
  });

  it('a stream without output fails the request', async () => {
    const s = setup({ adapter: { client: { silent: (n) => n === 2 } } });
    const result = await s.runner.run(input(), new AbortController().signal);
    expect(result.error?.code).toBe('ENDPOINT_INVALID');
  });

  it('a silent first-token probe is tolerated', async () => {
    const s = setup({ adapter: { client: { silent: (n) => n === 1 } } });
    const result = await s.runner.run(input(), new AbortController().signal);
    expect(result.status).toBe('completed');
    expect(result.metrics.firstTokenAfterLoadMs).toBeUndefined();
  });

  it('tokenizer errors other than "unsupported" fail the run', async () => {
    const s = setup({ adapter: { client: { tokenizeError: new AppError('ENDPOINT_UNREACHABLE', 'down') } } });
    expect((await s.runner.run(input(), new AbortController().signal)).error?.code).toBe('ENDPOINT_UNREACHABLE');
    const t = setup({ adapter: { client: { tokenizeError: new Error('weird') as AppError } } });
    expect((await t.runner.run(input(), new AbortController().signal)).error?.code).toBe('INTERNAL');
  });

  it('a save failure is published and rethrown', async () => {
    const s = setup({ saveFails: new AppError('DISK_FULL', 'no space') });
    await expect(s.runner.run(input(), new AbortController().signal)).rejects.toMatchObject({ code: 'DISK_FULL' });
    expect(s.ev.ofType('run.error')[0]?.error.code).toBe('DISK_FULL');
    expect(s.ev.ofType('run.done')).toEqual([]);
  });
});

describe('BenchRunner — degraded telemetry and engines', () => {
  it('survives every telemetry/fingerprint call failing', async () => {
    const s = setup({
      telemetry: { users: 'throw', snapshot: 'throw', stopThrows: true },
      deps: { fingerprint: async () => Promise.reject(new Error('no wmi')), scoreReference: async () => Promise.reject(new Error('x')) },
    });
    const result = await s.runner.run(input({ scenario: buildScenario('standard'), model: modelTarget({ identity: modelIdentity() }) }), new AbortController().signal);
    expect(result.status).toBe('completed');
    expect(result.hardware.hostId).toBe('unknown');
    expect(result.telemetry).toBeUndefined();
    expect(result.metrics.score).toBeUndefined();
    expect(result.validity).toContain('energy_unavailable');
  });

  it('telemetry.available() throwing means no telemetry', async () => {
    const s = setup({ telemetry: { available: 'throw' } });
    const result = await s.runner.run(input(), new AbortController().signal);
    expect(result.status).toBe('completed');
    expect(s.telemetry.sessions).toBe(0);
  });

  it('VRAM that does not come back to the baseline is noted after a bounded wait', async () => {
    const s = setup({ telemetry: { snapshot: 'throw-after-first' } });
    s.world.leakMiB = 0;
    const r1 = await s.runner.run(input({ scenario: custom([{ kind: 'load', cache: 'warm', reps: 2 }]) }), new AbortController().signal);
    expect(r1.logExcerpt).not.toContain('VRAM did not return');

    const t = setup();
    t.world.leakMiB = 3000;
    const r2 = await t.runner.run(input({ scenario: custom([{ kind: 'load', cache: 'warm', reps: 2 }]) }), new AbortController().signal);
    expect(r2.logExcerpt).toContain('VRAM did not return to the baseline');
    expect(r2.metrics.load.warmMs?.n).toBe(2);
  });

  it('missing memory/utilization readings and an engine that reports no slot count', async () => {
    const s = setup({ telemetry: { memNull: true, utilPct: null }, adapter: { parallel: null }, deps: { vramSettleMs: undefined } });
    const result = await s.runner.run(
      input({
        scenario: custom([
          { kind: 'load', cache: 'warm', reps: 2 },
          { kind: 'concurrency', levels: [1, 2], promptTokens: 16, outputTokens: 4, requestsPerWorker: 1 },
        ]),
      }),
      new AbortController().signal,
    );
    expect(result.status).toBe('completed');
    expect(result.metrics.concurrency.map((c) => c.level)).toEqual([1]);
    expect(result.metrics.vram).toEqual({});
    expect(result.validity).not.toContain('gpu_shared');
  });

  it('throttling, busy baseline and power-less telemetry are flagged', async () => {
    const s = setup({ telemetry: { throttle: ['hw_thermal_slowdown'], powerW: null, utilPct: 60 } });
    const result = await s.runner.run(input(), new AbortController().signal);
    expect(result.metrics.thermals.throttleReasons).toEqual(['hw_thermal_slowdown']);
    expect(result.validity).toEqual(['gpu_shared', 'throttling', 'energy_unavailable']);
  });

  it('log batching, broken log streams, failing stop and rejected exit promises', async () => {
    const lines = Array.from({ length: 150 }, (_, i) => `line ${i}`);
    const s = setup({
      adapter: {
        perStart: (n) =>
          n === 1
            ? { logs: lines, logGapMs: 1, stopError: new Error('kill failed'), exitRejects: true }
            : { logs: ['a', 'b', 'c'], logGapMs: 300, failLogs: new Error('pipe closed') },
      },
    });
    const result = await s.runner.run(input({ scenario: custom([{ kind: 'load', cache: 'warm', reps: 2 }]) }), new AbortController().signal);
    expect(result.status).toBe('completed');
    const batches = s.ev.ofType('run.log').map((e) => e.lines);
    expect(batches.flat()).toEqual(expect.arrayContaining(lines));
    expect(batches.some((b) => b.length === 100)).toBe(true);
    expect(result.logExcerpt).toContain('engine stop failed: kill failed');
  });
});
