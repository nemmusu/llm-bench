/**
 * Text prompts (servers without a tokenizer: NInfer, chat and plain OpenAI endpoints): where they are
 * calibrated, and a prompt the server refuses as longer than its context sent again shorter.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { launchParamsSchema } from '../../../../src/contract/engines';
import { fullContextPoint, type Scenario } from '../../../../src/contract/results';
import { BenchRunner, TEXT_RETRY_SHARES, type RunInput } from '../../../../src/core/bench/runner';
import { buildScenario } from '../../../../src/core/bench/scenarios';
import type { TuneSpace } from '../../../../src/core/bench/tuner';
import { httpError } from '../../../../src/core/inference/http';
import type { GenerateRequest } from '../../../../src/core/inference/types';
import { hardware } from '../store/fixtures';
import { displayCommand, events, FakeAdapter, FakeTelemetry, memoryRuns, modelTarget, SMALL_CORPUS, World, type AdapterOptions } from './fakes';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(adapter: AdapterOptions) {
  const world = new World();
  const fake = new FakeAdapter(world, adapter);
  const cacheDir = mkdtempSync(path.join(os.tmpdir(), 'gb-runner-text-'));
  dirs.push(cacheDir);
  const runner = new BenchRunner({
    clock: world.clock,
    adapter: fake,
    telemetry: new FakeTelemetry(world, { available: false }),
    runs: memoryRuns(),
    publish: events().publish,
    fingerprint: async () => hardware(),
    displayCommand,
    appVersion: '0.1.0-test',
    cacheDir,
    corpus: async () => SMALL_CORPUS,
    ownPids: () => [],
    vramSettleMs: 2000,
  });
  return { adapter: fake, runner };
}

/** NInfer's refusal of the deepest prompt of a sweep (HTTP 400 before reading anything). */
const refusal = (context: number) =>
  httpError(
    400,
    JSON.stringify({ error: { code: 'context_length_exceeded', message: `prepared prompt exceeds Engine max_context ${context}`, param: 'messages', type: 'invalid_request_error' } }),
    '/v1/chat/completions',
  );

/** The server's count: 4 characters per token on short texts, a little more tokens on long ones (the calibration misses ~0.5 %). */
const count = (chars: number): number => Math.round(chars / (chars < 10_000 ? 4 : 3.98));
const tooLong = (req: GenerateRequest, context: number): boolean => count(req.promptText?.length ?? 0) + req.outputTokens > context;

const input = (scenario: Scenario, over: Partial<RunInput> = {}): RunInput => ({
  runId: 'TEXT1',
  engineConfig: { kind: 'external', baseUrl: 'http://127.0.0.1:9999' },
  model: modelTarget(),
  params: launchParamsSchema.parse({}),
  scenario,
  port: 5555,
  marker: 'gpubench-text',
  allowSharedGpu: false,
  ...over,
});
const latency = (promptTokens: number[]): Scenario => ({ profile: 'custom', seed: 7, steps: [{ kind: 'latency', promptTokens, outputTokens: 32, warmup: 0, reps: 1 }] });

describe('text prompts refused as longer than the context', () => {
  it('are sent again a little shorter: the point keeps what the server read', async () => {
    const s = setup({ kind: 'external', client: { flavor: 'openai-chat', tokenizeUnsupported: true, promptTokensOf: count, failOn: (_n, req) => (tooLong(req, 8192) ? refusal(8192) : undefined) } });
    const result = await s.runner.run(input(latency([64, 8150])), new AbortController().signal);
    expect(result.status).toBe('completed');
    const deep = s.adapter.client.requests.filter((r) => (r.promptText?.length ?? 0) > 30_000).map((r) => r.promptText!.length);
    // 32 600 characters (8 191 tokens + 32 to write) and 99.7 % of them refused, 99 % read.
    expect(deep).toEqual([32_600, 32_502, 32_274]);
    expect(result.metrics.latency.find((p) => p.promptTokens === 8150)).toMatchObject({ promptTokensReported: 8109 });
    expect(result.logExcerpt).toContain('text prompt of 32600 characters refused as longer than the context: sent again with 32502 characters');
  });

  it('go through as the error after the last try; other errors and token-id prompts are never sent again', async () => {
    const always = setup({ kind: 'external', client: { flavor: 'openai-chat', tokenizeUnsupported: true, failOn: (_n, req) => ((req.promptText?.length ?? 0) > 10_000 ? refusal(2048) : undefined) } });
    const failed = await always.runner.run(input(latency([8150])), new AbortController().signal);
    expect(failed).toMatchObject({ status: 'failed', error: { code: 'ENDPOINT_INVALID', params: { reason: 'context_exceeded' } } });
    expect(always.adapter.client.requests.filter((r) => (r.promptText?.length ?? 0) > 10_000)).toHaveLength(1 + TEXT_RETRY_SHARES.length);
    // An answer that is not a refusal of the length.
    const broken = setup({ kind: 'external', client: { flavor: 'openai-chat', tokenizeUnsupported: true, failOn: (_n, req) => ((req.promptText?.length ?? 0) > 10_000 ? httpError(500, 'boom', '/v1/chat/completions') : undefined) } });
    expect((await broken.runner.run(input(latency([8150])), new AbortController().signal)).status).toBe('failed');
    expect(broken.adapter.client.requests.filter((r) => (r.promptText?.length ?? 0) > 10_000)).toHaveLength(1);
    // Token ids: the length is exact, a refusal is final.
    const ids = setup({ client: { pieces: 'ids', failOn: (_n, req) => ((req.promptIds?.length ?? 0) > 1000 ? refusal(1024) : undefined) } });
    const exact = await ids.runner.run(input(latency([2048]), { engineConfig: { kind: 'llamacpp-native' } }), new AbortController().signal);
    expect(exact.error).toMatchObject({ params: { reason: 'context_exceeded' } });
    expect(ids.adapter.client.requests.filter((r) => (r.promptIds?.length ?? 0) > 1000)).toHaveLength(1);
  });
});

describe('text prompts of "Trova le impostazioni migliori"', () => {
  const space: TuneSpace = {
    kvLadder: ['f16', 'q4_0'],
    base: (kv) => ({ kv }),
    dimensions: [],
    contextFor: (users, perUser) => users * perUser,
    params: (v, ctx) => launchParamsSchema.parse({ contextSize: ctx, kvCacheType: v.kv }),
    tags: () => [],
  };
  const tune = (): RunInput =>
    input(buildScenario('tune'), {
      engineConfig: { kind: 'llamacpp-native' },
      tune: { space, budget: 'fast', sweep: { outputTokens: 64, reps: 1 }, modelContext: 8192, spillPossible: false, fidelity: false },
    });

  it('are calibrated on prompts the search sends anyway, never on a few characters', async () => {
    // A chat server adds its template and the instruction to every prompt (~19 tokens): calibrated on
    // a 1-token prompt (4 characters, 19 tokens) that read as 0.21 characters per token.
    const s = setup({ client: { pieces: 'text', tokenizeUnsupported: true, promptTokensOf: (chars) => Math.round(chars / 4.3) + 19 } });
    const result = await s.runner.run(tune(), new AbortController().signal);
    expect(result.status).toBe('completed');
    expect(s.adapter.client.requests.slice(0, 2).map((r) => r.promptText?.length)).toEqual([1024, 4096]);
    expect(result.notes).toContainEqual({ code: 'text_prompts_calibrated', params: { charsPerToken: 4.3, overhead: 19 } });
  });

  it('the deepest prompt of a sweep refused as too long is read a little shorter: the context-full speed is measured', async () => {
    const s = setup({ client: { pieces: 'text', tokenizeUnsupported: true, promptTokensOf: count, failOn: (_n, req) => (tooLong(req, s.adapter.plans.at(-1)!.params.contextSize!) ? refusal(8192) : undefined) } });
    const result = await s.runner.run(tune(), new AbortController().signal);
    expect(result.status).toBe('completed');
    const t = result.tuning!;
    expect(t.attempts.every((a) => a.error === undefined)).toBe(true);
    const rec = t.combinations[t.recommended!]!;
    expect(rec.maxContext).toBe(8192);
    expect(fullContextPoint(rec)).toMatchObject({ promptTokens: 8112, promptTokensReported: 8128 });
  });
});
