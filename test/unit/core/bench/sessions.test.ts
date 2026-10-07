import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../../../../src/contract/errors';
import type { CurrentStep } from '../../../../src/contract/events';
import type { SessionsPoint, SessionsStep } from '../../../../src/contract/results';
import type { RequestMetrics } from '../../../../src/core/bench/metrics';
import { aggregateSessions, runSessions, soloRate, turnResult, type SessionsDeps, type TurnResult } from '../../../../src/core/bench/steps/sessions';
import { LlamaCppClient } from '../../../../src/core/inference/llamacpp-client';
import { OpenAiClient } from '../../../../src/core/inference/openai-client';
import type { GenerateRequest, InferenceClient, StreamEvent } from '../../../../src/core/inference/types';
import { systemClock } from '../../../../src/core/node-deps';
import { startFakeEngine, type FakeEngine } from '../../../fakes/fake-engine/server.mjs';

const STEP: SessionsStep = { kind: 'sessions', depth: 1000, levels: [1, 2], turns: 3, followupTokens: 20, outputTokens: 4 };

function metrics(o: Partial<RequestMetrics> & { sentAt: number; firstAt: number }): RequestMetrics {
  return {
    lastAt: o.firstAt + 30,
    endAt: o.firstAt + 30,
    ttftMs: o.firstAt - o.sentAt,
    totalMs: o.firstAt + 30 - o.sentAt,
    promptTokens: 1000,
    outputTokens: 4,
    tokensExact: true,
    outputExact: true,
    decodeTokens: 3,
    decodeTps: 100,
    itlMs: [],
    itlPerChunk: false,
    ...o,
  };
}

const turn = (t: number, m: RequestMetrics, extra: Partial<TurnResult> = {}): TurnResult => ({ turn: t, m, uncached: m.promptTokens, ...extra });

describe('turnResult / soloRate / aggregateSessions', () => {
  it('cache and reading time come from the engine (llama.cpp timings, vLLM usage)', () => {
    const m = metrics({ sentAt: 0, firstAt: 500 });
    expect(turnResult(2, { kind: 'done', t: 1, timings: { cacheN: 990, promptN: 10, promptMs: 5 } }, m)).toEqual({ turn: 2, m, cached: 990, uncached: 10, enginePrefillMs: 5 });
    expect(turnResult(2, { kind: 'done', t: 1, usage: { cachedTokens: 992 } }, m)).toEqual({ turn: 2, m, cached: 992, uncached: 8 });
    // Nothing reported: everything counts as read, reuse unknown.
    expect(turnResult(1, undefined, m)).toEqual({ turn: 1, m, uncached: 1000 });
  });

  it('solo reading speed: the median alone, the fastest when several read at once', () => {
    const a = turn(1, metrics({ sentAt: 0, firstAt: 1000 }));
    const b = turn(1, metrics({ sentAt: 0, firstAt: 2000 }));
    expect(soloRate([a, b], 1)).toBe(750);
    expect(soloRate([a, b], 2)).toBe(1000);
    expect(soloRate([], 1)).toBeUndefined();
  });

  it('queue wait from the engine reading time, cache share of the later messages, server reading speed', () => {
    // Two conversations: the second one's reading starts when the first one's ends (1 s each).
    const first = [
      turn(1, metrics({ sentAt: 0, firstAt: 1000 }), { enginePrefillMs: 980 }),
      turn(1, metrics({ sentAt: 0, firstAt: 2000 }), { enginePrefillMs: 990 }),
    ];
    const later = [turn(2, metrics({ sentAt: 3000, firstAt: 3020, promptTokens: 1024 }), { cached: 1000, uncached: 24 }), turn(3, metrics({ sentAt: 4000, firstAt: 4040, promptTokens: 1048, decodeTps: 80 }), { cached: 1024, uncached: 24 })];
    const p = aggregateSessions(STEP, 2, [...first, ...later], { requests: 5, errors: 1 });
    expect(p).toMatchObject({ sessions: 2, depth: 1000, turns: 3, outputTokens: 4, followupTokens: 20, queueEstimated: false, requests: 5, errors: 1 });
    expect(p.firstTurn.queueWaitMs.values).toEqual([20, 1010]);
    expect(p.firstTurn.prefillTps.median).toBeCloseTo((1000 / 0.98 + 1000 / 0.99) / 2, 6);
    expect(p.firstTurn.ttftMs.max).toBe(2000);
    expect(p.laterTurns?.cachedShare?.values.map((v) => Math.round(v * 1000) / 1000)).toEqual([0.977, 0.977]);
    expect(p.laterTurns?.ttftMs.values).toEqual([20, 40]);
    expect(p.laterTurns?.decodeTps.values).toEqual([100, 80]);
    // 2000 tokens read while at least one first message was reading (0 → 2 s).
    expect(p.aggregatePrefillTps).toBe(1000);
  });

  it('estimated queue without engine timings; unknown reuse is never guessed', () => {
    const first = [turn(1, metrics({ sentAt: 0, firstAt: 1000 })), turn(1, metrics({ sentAt: 0, firstAt: 2100 }))];
    const later = [turn(2, metrics({ sentAt: 3000, firstAt: 3010 }))];
    const p = aggregateSessions(STEP, 2, [...first, ...later], { requests: 3, errors: 0, solo: 1000 });
    expect(p.queueEstimated).toBe(true);
    expect(p.firstTurn.queueWaitMs.values).toEqual([0, 1100]);
    // Client-side reading speed: the wait in the queue included.
    expect(p.firstTurn.prefillTps.values).toEqual([1000, 1000 / 2.1]);
    expect(p.laterTurns).toBeDefined();
    expect(p.laterTurns?.cachedShare).toBeUndefined();
    // Without the level-1 speed: the fastest request of the level stands for "alone".
    expect(aggregateSessions(STEP, 2, first, { requests: 2, errors: 0 }).firstTurn.queueWaitMs.values).toEqual([0, 1100]);
  });

  it('no successful request: empty statistics, no reading speed', () => {
    const p = aggregateSessions({ ...STEP, turns: 1 }, 1, [], { requests: 1, errors: 1 });
    expect(p.firstTurn.ttftMs.n).toBe(0);
    expect(p.firstTurn.queueWaitMs.n).toBe(0);
    expect(p.laterTurns).toBeUndefined();
    expect(p.aggregatePrefillTps).toBeUndefined();
    expect(p.queueEstimated).toBe(true);
    // A request with an empty prompt says nothing about the cache share.
    const odd = aggregateSessions(STEP, 1, [turn(1, metrics({ sentAt: 0, firstAt: 0 })), turn(2, metrics({ sentAt: 0, firstAt: 5, promptTokens: 0 }), { cached: 0, uncached: 0 })], { requests: 2, errors: 0 });
    expect(odd.laterTurns?.cachedShare).toBeUndefined();
    expect(odd.aggregatePrefillTps).toBeUndefined();
  });
});

interface ScriptOptions {
  flavor?: 'llamacpp' | 'vllm' | 'openai';
  /** Chunks carry token ids (llama.cpp). */
  ids?: boolean;
  timings?: boolean;
  usageCached?: boolean;
  fail?: (n: number, req: GenerateRequest) => Error | undefined;
  tokenizeFails?: boolean;
  /** Called before each request (e.g. to abort). */
  onRequest?: (n: number) => void;
  /** Chunks without text, done without usage. */
  bare?: boolean;
}

/** Scripted engine: reads 1 token per 0.1 ms, caches the longest earlier prompt+answer prefix, 1 ms per generated token. */
class ScriptClient implements InferenceClient {
  readonly flavor: 'llamacpp' | 'vllm' | 'openai';
  readonly baseUrl = 'http://script';
  readonly requests: GenerateRequest[] = [];
  private readonly seen: (number[] | string)[] = [];
  constructor(
    private readonly clock: { t: number },
    private readonly o: ScriptOptions = {},
  ) {
    this.flavor = o.flavor ?? 'llamacpp';
  }
  async ready() {
    return true;
  }
  async models() {
    return ['m'];
  }
  requestBody(req: GenerateRequest) {
    return { prompt: req.promptIds ?? req.promptText };
  }
  async tokenize(text: string): Promise<number[]> {
    if (this.o.tokenizeFails) throw new AppError('ENDPOINT_INVALID', 'tokenize unsupported', { params: { reason: 'tokenize_unsupported' } });
    return Array.from(text, (c) => 500 + ((c.codePointAt(0) as number) % 100));
  }
  async *generate(req: GenerateRequest): AsyncGenerator<StreamEvent, void, undefined> {
    this.requests.push(req);
    const n = this.requests.length;
    this.o.onRequest?.(n);
    await Promise.resolve();
    const err = this.o.fail?.(n, req);
    if (err) throw err;
    const prompt = req.promptIds ?? (req.promptText as string);
    const length = typeof prompt === 'string' ? Math.round(prompt.length / 4) : prompt.length;
    let cached = 0;
    for (const s of this.seen) {
      let i = 0;
      while (i < s.length && i < prompt.length && s[i] === prompt[i]) i++;
      cached = Math.max(cached, typeof prompt === 'string' ? Math.round(i / 4) : i);
    }
    cached = Math.min(cached, length - 1);
    this.clock.t += (length - cached) / 10;
    const out: number[] = [];
    for (let k = 0; k < req.outputTokens; k++) {
      const id = 9000 + n * 10 + k;
      out.push(id);
      yield { kind: 'chunk', t: this.clock.t, textLen: 4, tokens: 1, ...(this.o.ids ? { ids: [id] } : {}), ...(this.o.bare ? {} : { text: ` t${k % 10}a` }) };
      this.clock.t += 1;
    }
    this.seen.push(typeof prompt === 'string' ? `${prompt}${out.map((_, k) => ` t${k % 10}a`).join('')}` : [...prompt, ...out]);
    yield {
      kind: 'done',
      t: this.clock.t,
      ...(this.o.bare ? {} : { usage: { promptTokens: length, completionTokens: req.outputTokens, ...(this.o.usageCached ? { cachedTokens: cached } : {}) } }),
      ...(this.o.timings ? { timings: { cacheN: cached, promptN: length - cached, promptMs: (length - cached) / 10 } } : {}),
    };
  }
}

const CORPUS_IDS = Array.from({ length: 4000 }, (_, i) => 100 + ((i * 7919) % 20000));

function deps(client: InferenceClient, clock: { t: number }, over: Partial<SessionsDeps> = {}) {
  let rep = 0;
  const steps: CurrentStep[] = [];
  const points: SessionsPoint[] = [];
  const recorded: RequestMetrics[] = [];
  const levels: number[] = [];
  const d: SessionsDeps = {
    client,
    now: () => clock.t,
    signal: new AbortController().signal,
    seed: 42,
    tokens: CORPUS_IDS,
    bos: 1,
    corpus: 'The quick brown fox jumps over the lazy dog. '.repeat(400),
    nextRep: () => rep++,
    step: (c) => steps.push(c),
    point: (p) => points.push(p),
    record: (m) => recorded.push(m),
    alive: () => undefined,
    levelDone: (n) => levels.push(n),
    ...over,
  };
  return { d, steps, points, recorded, levels };
}

describe('runSessions with a scripted engine', () => {
  it('llama.cpp: each conversation keeps its slot, re-sends prompt + answer ids + new text, reuse and queue from the engine', async () => {
    const clock = { t: 0 };
    const client = new ScriptClient(clock, { ids: true, timings: true });
    const { d, steps, points, recorded, levels } = deps(client, clock, { slots: 2, model: 'm' });
    const run = await runSessions(STEP, d);
    expect(run.skippedFrom).toBeUndefined();
    expect(run.points.map((p) => p.sessions)).toEqual([1, 2]);
    expect(levels).toEqual([1, 2]);
    // 3 messages alone, then 3 × 2.
    expect(client.requests).toHaveLength(9);
    expect(recorded).toHaveLength(9);
    const [a1, a2, a3] = client.requests;
    expect(a1).toMatchObject({ outputTokens: 4, seed: 42, model: 'm', cachePrompt: true, slot: 0 });
    expect(a1?.promptIds).toHaveLength(1000);
    expect(a1?.promptIds?.[0]).toBe(1);
    // Message 2 = message 1 + its 4 answer ids + 20 new tokens.
    expect(a2?.promptIds?.slice(0, 1000)).toEqual(a1?.promptIds);
    expect(a2?.promptIds?.slice(1000, 1004)).toEqual([9010, 9011, 9012, 9013]);
    expect(a2?.promptIds).toHaveLength(1024);
    expect(a3?.promptIds).toHaveLength(1048);
    // Level 2: two conversations on slots 0 and 1, with different starts (no shared prefix besides BOS).
    const level2 = client.requests.slice(3).filter((r) => r.promptIds?.length === 1000);
    expect(level2.map((r) => r.slot).sort()).toEqual([0, 1]);
    expect(level2[0]?.promptIds?.slice(1, 50)).not.toEqual(level2[1]?.promptIds?.slice(1, 50));
    const [one, two] = run.points as [SessionsPoint, SessionsPoint];
    expect(one.queueEstimated).toBe(false);
    expect(one.laterTurns?.cachedShare?.min).toBeGreaterThan(0.95);
    expect(two.requests).toBe(6);
    expect(two.errors).toBe(0);
    expect(two.laterTurns?.cachedShare?.n).toBe(4);
    // Live: a step before every message, a point after every message plus one per level.
    expect(steps).toHaveLength(9);
    expect(steps[0]).toEqual({ kind: 'sessions', concurrency: 1, depth: 1000, promptTokens: 1000, outputTokens: 4, turn: 1, turns: 3, rep: 1, reps: 3 });
    expect(points).toHaveLength(11);
    expect(points.at(-1)).toEqual(two);
  });

  it('vLLM: no slots to pin, the answer is tokenized like a chat client sends it back, cached tokens from usage', async () => {
    const clock = { t: 0 };
    const client = new ScriptClient(clock, { flavor: 'vllm', usageCached: true });
    const { d } = deps(client, clock);
    const run = await runSessions({ ...STEP, levels: [2] }, d);
    expect(client.requests.every((r) => r.slot === undefined && r.cachePrompt === true)).toBe(true);
    const second = client.requests.find((r) => (r.promptIds?.length ?? 0) > 1000);
    // " t0a t1a t2a t3a": 16 characters, one id each in the script tokenizer.
    expect(second?.promptIds).toHaveLength(1000 + 16 + 20);
    expect(run.points[0]?.queueEstimated).toBe(true);
    expect(run.points[0]?.laterTurns?.cachedShare?.n).toBe(4);
  });

  it('more conversations than slots: none is pinned', async () => {
    const clock = { t: 0 };
    const client = new ScriptClient(clock, { ids: true });
    await runSessions({ ...STEP, levels: [2], turns: 1 }, deps(client, clock, { slots: 1 }).d);
    expect(client.requests.map((r) => r.slot)).toEqual([undefined, undefined]);
  });

  it('text prompts when the endpoint cannot tokenize: the conversation grows as text', async () => {
    const clock = { t: 0 };
    const client = new ScriptClient(clock, { flavor: 'openai' });
    const { d } = deps(client, clock, { tokens: undefined, bos: undefined } as Partial<SessionsDeps>);
    delete (d as { tokens?: unknown }).tokens;
    delete (d as { bos?: unknown }).bos;
    const run = await runSessions({ ...STEP, levels: [1], turns: 2 }, d);
    const [first, second] = client.requests;
    expect(typeof first?.promptText).toBe('string');
    expect(second?.promptText?.startsWith(first?.promptText as string)).toBe(true);
    expect(second?.promptText).toContain(' t0a t1a t2a t3a');
    // The server's own prompt count is used for text prompts.
    expect(run.points[0]?.firstTurn.ttftMs.n).toBe(1);
    expect(run.points[0]?.laterTurns?.cachedShare).toBeUndefined();
  });

  it('without BOS, answers without text, text prompts without a server count', async () => {
    const clock = { t: 0 };
    const noBos = new ScriptClient(clock, { flavor: 'vllm', bare: true });
    const { d } = deps(noBos, clock);
    delete (d as { bos?: unknown }).bos;
    await runSessions({ ...STEP, levels: [1], turns: 2 }, d);
    expect(noBos.requests[0]?.promptIds?.[0]).not.toBe(1);
    // No answer text to send back: only the new text is added.
    expect(noBos.requests[1]?.promptIds).toHaveLength(1000 + 20);

    const text = new ScriptClient(clock, { flavor: 'openai', bare: true });
    const t = deps(text, clock);
    delete (t.d as { tokens?: unknown }).tokens;
    const run = await runSessions({ ...STEP, levels: [1], turns: 1 }, t.d);
    expect(run.points[0]?.firstTurn.ttftMs.n).toBe(1);
  });

  it('failed messages count as errors and end that conversation; a failed answer tokenization too', async () => {
    const clock = { t: 0 };
    const failing = new ScriptClient(clock, { ids: true, fail: (n) => (n === 2 ? new AppError('ENDPOINT_INVALID', 'boom') : undefined) });
    const run = await runSessions({ ...STEP, levels: [1] }, deps(failing, clock).d);
    expect(run.points[0]).toMatchObject({ requests: 2, errors: 1 });
    expect(run.points[0]?.laterTurns).toBeUndefined();

    const noTokenizer = new ScriptClient(clock, { flavor: 'vllm', tokenizeFails: true });
    const run2 = await runSessions({ ...STEP, levels: [1] }, deps(noTokenizer, clock).d);
    expect(run2.points[0]).toMatchObject({ requests: 1, errors: 1 });
  });

  it('a dead engine fails the run instead of counting errors', async () => {
    const clock = { t: 0 };
    const client = new ScriptClient(clock, { ids: true });
    let calls = 0;
    const dead = new AppError('ENGINE_EXITED', 'gone');
    const { d } = deps(client, clock, {
      alive: () => {
        if (++calls > 2) throw dead;
      },
    });
    await expect(runSessions(STEP, d)).rejects.toBe(dead);
  });

  it('cancelled while sending or between messages: CANCELLED', async () => {
    const clock = { t: 0 };
    const ac = new AbortController();
    const client = new ScriptClient(clock, { ids: true, fail: () => (ac.signal.aborted ? new Error('aborted') : undefined), onRequest: (n) => n === 2 && ac.abort() });
    await expect(runSessions(STEP, deps(client, clock, { signal: ac.signal }).d)).rejects.toMatchObject({ code: 'CANCELLED' });

    const ac2 = new AbortController();
    const tokenizing = new ScriptClient(clock, { flavor: 'vllm' });
    tokenizing.tokenize = async () => {
      ac2.abort();
      throw new Error('aborted');
    };
    await expect(runSessions(STEP, deps(tokenizing, clock, { signal: ac2.signal }).d)).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('time budget: a level that would not fit is skipped with the ones after it', async () => {
    const clock = { t: 0 };
    const client = new ScriptClient(clock, { ids: true, timings: true });
    // Short first messages: every level fits in 1 s of script time.
    const run = await runSessions({ ...STEP, levels: [1, 2, 4], maxSeconds: 1 }, deps(client, clock, { slots: 4 }).d);
    expect(run.points.map((p) => p.sessions)).toEqual([1, 2, 4]);
    clock.t = 0;
    const slow = await runSessions({ ...STEP, depth: 3000, levels: [1, 2, 4], maxSeconds: 1 }, deps(new ScriptClient(clock, { ids: true }), clock, { slots: 4 }).d);
    // 3000-token first messages: level 1 takes ~0.32 s, level 2 ~0.63 s more; level 4 would not fit.
    expect(slow.points.map((p) => p.sessions)).toEqual([1, 2]);
    expect(slow.skippedFrom).toBe(4);
  });
});

describe('runSessions on the fake engine (HTTP, real time)', () => {
  let engine: FakeEngine | undefined;
  afterEach(async () => {
    await engine?.close();
    engine = undefined;
  });
  const http = { fetch: globalThis.fetch, clock: systemClock };
  const step: SessionsStep = { kind: 'sessions', depth: 3000, levels: [1, 2], turns: 3, followupTokens: 64, outputTokens: 8 };
  const real = (client: InferenceClient, over: Partial<SessionsDeps> = {}) => deps(client, { t: 0 }, { now: () => performance.now(), ...over }).d;

  it('llama.cpp: the context is read once, the second conversation waits for the first one to be read', async () => {
    engine = await startFakeEngine({ flavor: 'llamacpp', ctx: 32768, np: 2, profile: { loadMsWarm: 1, prefillTps: 20_000, decodeTps: 2000 } });
    await engine.loaded;
    const run = await runSessions(step, real(new LlamaCppClient(engine.url, http), { slots: 2 }));
    const [one, two] = run.points as [SessionsPoint, SessionsPoint];
    expect(one.queueEstimated).toBe(false);
    expect(one.laterTurns?.cachedShare?.min).toBeGreaterThan(0.95);
    expect(two.laterTurns?.cachedShare?.min).toBeGreaterThan(0.95);
    // 3000 tokens at 20 000 tok/s = 150 ms: the second conversation's reading starts after the first one's.
    expect(two.firstTurn.queueWaitMs.max).toBeGreaterThan(100);
    expect(one.firstTurn.queueWaitMs.max).toBeLessThan(100);
    // Later messages read only the new part: much quicker than the first one.
    expect(one.laterTurns?.ttftMs.median).toBeLessThan(one.firstTurn.ttftMs.median);
    expect(two.aggregatePrefillTps).toBeGreaterThan(5000);
  });

  it('vLLM: cached tokens only with --enable-prompt-tokens-details, queue estimated', async () => {
    engine = await startFakeEngine({ flavor: 'vllm', alias: 'm', ctx: 32768, promptTokensDetails: true, profile: { loadMsWarm: 1, prefillTps: 20_000, decodeTps: 2000 } });
    await engine.loaded;
    const client = new OpenAiClient('vllm', engine.url, http, { model: 'm' });
    const run = await runSessions({ ...step, levels: [2] }, real(client, { model: 'm' }));
    expect(run.points[0]?.queueEstimated).toBe(true);
    expect(run.points[0]?.laterTurns?.cachedShare?.min).toBeGreaterThan(0.9);
    await engine.close();

    engine = await startFakeEngine({ flavor: 'vllm', alias: 'm', ctx: 32768, profile: { loadMsWarm: 1, prefillTps: 20_000, decodeTps: 2000 } });
    await engine.loaded;
    const quiet = await runSessions({ ...step, levels: [1], turns: 2 }, real(new OpenAiClient('vllm', engine.url, http, { model: 'm' }), { model: 'm' }));
    expect(quiet.points[0]?.laterTurns?.cachedShare).toBeUndefined();
  });
});
