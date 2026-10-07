/** The prefix cache over a level of "Conversazioni lunghe": vLLM's own counters, its old gauge, else the cached tokens. */
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionsStep } from '../../../../src/contract/results';
import type { RequestMetrics } from '../../../../src/core/bench/metrics';
import { prefixCacheOf, runSessions, type TurnResult } from '../../../../src/core/bench/steps/sessions';
import { LlamaCppClient } from '../../../../src/core/inference/llamacpp-client';
import { OpenAiClient } from '../../../../src/core/inference/openai-client';
import type { InferenceClient } from '../../../../src/core/inference/types';
import { systemClock } from '../../../../src/core/node-deps';
import { startFakeEngine, type FakeEngine, type FakeProfile } from '../../../fakes/fake-engine/server.mjs';

const r = (promptTokens: number, cached?: number): TurnResult => ({ turn: 1, m: { promptTokens } as RequestMetrics, uncached: promptTokens - (cached ?? 0), ...(cached !== undefined ? { cached } : {}) });

describe('prefixCacheOf', () => {
  it('counters before and after the level, else the gauge, else what every response said', () => {
    expect(prefixCacheOf([], { queries: 100, hits: 50 }, { queries: 1100, hits: 850 })).toEqual({ queries: 1000, hits: 800, hitRate: 0.8, source: 'metrics' });
    // Counters that did not move: the gauge, then the responses.
    expect(prefixCacheOf([r(10, 5)], { queries: 100, hits: 50 }, { queries: 100, hits: 50, hitRate: 0.3 })).toEqual({ hitRate: 0.3, source: 'metrics-gauge' });
    expect(prefixCacheOf([r(10, 5)], { queries: 100 }, { queries: 200 })).toEqual({ queries: 10, hits: 5, hitRate: 0.5, source: 'cached-tokens' });
    expect(prefixCacheOf([r(10, 5)], undefined, { hitRate: 1.4 })).toEqual({ hitRate: 1, source: 'metrics-gauge' });
    expect(prefixCacheOf([r(1000, 0), r(1100, 1000)])).toEqual({ queries: 2100, hits: 1000, hitRate: 1000 / 2100, source: 'cached-tokens' });
    // A response that did not say: nothing (never guessed).
    expect(prefixCacheOf([r(1000, 0), r(1100)])).toBeUndefined();
    expect(prefixCacheOf([])).toBeUndefined();
    expect(prefixCacheOf([r(0, 0)])).toBeUndefined();
  });
});

describe('runSessions with vLLM /metrics (fake engine, HTTP)', () => {
  let engine: FakeEngine | undefined;
  afterEach(async () => {
    await engine?.close();
    engine = undefined;
  });
  const http = { fetch: globalThis.fetch, clock: systemClock };
  const step: SessionsStep = { kind: 'sessions', depth: 2000, levels: [2], turns: 3, followupTokens: 64, outputTokens: 8 };
  const deps = (client: InferenceClient, over: object = {}) => {
    let rep = 0;
    return {
      client,
      now: () => performance.now(),
      signal: new AbortController().signal,
      seed: 42,
      tokens: Array.from({ length: 4000 }, (_, i) => 100 + ((i * 7919) % 20000)),
      bos: 1,
      corpus: 'x',
      model: 'm',
      nextRep: () => rep++,
      step: () => undefined,
      point: () => undefined,
      record: () => undefined,
      alive: () => undefined,
      ...(client.prefixCache ? { prefixCache: () => client.prefixCache!() } : {}),
      ...over,
    };
  };
  const start = async (profile: FakeProfile) => {
    engine = await startFakeEngine({ flavor: 'vllm', alias: 'm', ctx: 32768, profile: { loadMsWarm: 1, prefillTps: 50_000, decodeTps: 4000, ...profile } });
    await engine.loaded;
    return new OpenAiClient('vllm', engine.url, http, { model: 'm' });
  };

  it('the counters of this level only (read before and after)', async () => {
    const client = await start({});
    // Something read before the level: not counted.
    await runSessions({ ...step, turns: 1 }, deps(client));
    const run = await runSessions(step, deps(client));
    const p = run.points[0]!.prefixCache!;
    expect(p.source).toBe('metrics');
    expect(p.queries).toBeGreaterThan(2 * 3 * 2000);
    expect(p.hitRate).toBeGreaterThan(0.5);
  });

  it('the old gauge; no /metrics and no cached tokens: nothing said; a failing read never fails the level', async () => {
    const gauge = await start({ vllmMetrics: 'gauge' });
    expect((await runSessions(step, deps(gauge))).points[0]!.prefixCache).toMatchObject({ source: 'metrics-gauge' });
    await engine!.close();
    const none = await start({ vllmMetrics: 'none' });
    expect((await runSessions(step, deps(none))).points[0]!.prefixCache).toBeUndefined();
    const broken = await runSessions(step, deps(none, { prefixCache: () => Promise.reject(new Error('x')) }));
    expect(broken.points[0]!.prefixCache).toBeUndefined();
  });

  it('llama.cpp: no counters, the cached tokens of every response', async () => {
    engine = await startFakeEngine({ flavor: 'llamacpp', ctx: 32768, np: 2, kvUnified: false, profile: { loadMsWarm: 1, prefillTps: 50_000, decodeTps: 4000 } });
    await engine.loaded;
    const run = await runSessions(step, deps(new LlamaCppClient(engine.url, http), { slots: 2 }));
    expect(run.points[0]!.prefixCache).toMatchObject({ source: 'cached-tokens' });
    expect(run.points[0]!.prefixCache!.hitRate).toBeGreaterThan(0.5);
  });
});
