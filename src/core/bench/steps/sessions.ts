/**
 * "Conversazioni lunghe": N conversations at once, each with its own long context. The first message
 * reads the whole context; every later one re-sends the conversation so far (previous prompt +
 * previous answer) plus some new text, with the engine's prefix cache ON, so only the new part
 * should be read again. Measured per request: time to the first token, how much of the prompt came
 * from the cache, the reading speed of what was read, the generation speed and the time spent
 * waiting for the other conversations' reading (queue).
 *
 * Queue wait: TTFT − the engine's own reading time when the engine reports it (llama.cpp timings);
 * otherwise TTFT − tokens to read / the reading speed of one conversation alone (level 1, else the
 * fastest request of the level), flagged `queueEstimated`. Cache reuse is only what the engine says
 * (llama.cpp timings.cache_n, vLLM usage.prompt_tokens_details.cached_tokens): never guessed.
 */
import type { CurrentStep } from '../../../contract/events';
import { AppError } from '../../../contract/errors';
import type { SessionsPoint, SessionsStep, Stat } from '../../../contract/results';
import type { GenerateRequest, InferenceClient, StreamEvent } from '../../inference/types';
import { fromStream, unionMs, type RequestMetrics } from '../metrics';
import { buildPrompt, buildTextPrompt, CHARS_PER_TOKEN } from '../prompts';
import { summarize } from '../stats';

export interface SessionsDeps {
  client: InferenceClient;
  /** Monotonic ms. */
  now(): number;
  signal: AbortSignal;
  seed: number;
  /** The corpus as token ids (prompts are sent as ids)… */
  tokens?: readonly number[];
  bos?: number;
  /** …or, for endpoints that cannot tokenize, its text. */
  corpus: string;
  /** Model name for OpenAI-style APIs. */
  model?: string;
  /** A new request number: every prompt starts at its own corpus offset, so conversations never share a prefix. */
  nextRep(): number;
  /** llama.cpp slots: with at least one per conversation, each conversation keeps its own. Absent: no slots (vLLM). */
  slots?: number;
  /** run.step before every request. */
  step(current: CurrentStep): void;
  /** run.point after every message and at the end of each level. */
  point(p: SessionsPoint): void;
  /** Every measured request (energy windows, exactness flags). */
  record(m: RequestMetrics): void;
  /** Throws when the engine is gone: that fails the run instead of counting errors. */
  alive(): void;
  /** A level is done: progress. */
  levelDone?(sessions: number): void;
}

export interface SessionsRun {
  points: SessionsPoint[];
  /** First level not measured because the time budget was spent. */
  skippedFrom?: number;
}

/** One measured message of a conversation. */
export interface TurnResult {
  /** 1 = the first message (whole context). */
  turn: number;
  m: RequestMetrics;
  /** Tokens the engine took from its cache; undefined = it did not say. */
  cached?: number;
  /** Tokens it had to read (the engine's count when reported, else prompt − cached). */
  uncached: number;
  /** The engine's own reading time of this request (llama.cpp timings.prompt_ms). */
  enginePrefillMs?: number;
}

type Prompt = { ids: number[] } | { text: string };
type Done = Extract<StreamEvent, { kind: 'done' }>;
type Chunk = Extract<StreamEvent, { kind: 'chunk' }>;

/** What one finished request says about the cache and the engine's own reading time. */
export function turnResult(turn: number, done: Done | undefined, m: RequestMetrics): TurnResult {
  const cached = done?.timings?.cacheN ?? done?.usage?.cachedTokens;
  const read = done?.timings?.promptN ?? m.promptTokens - (cached ?? 0);
  const ms = done?.timings?.promptMs;
  return { turn, m, ...(cached !== undefined ? { cached } : {}), uncached: Math.max(0, read), ...(ms !== undefined ? { enginePrefillMs: ms } : {}) };
}

const defined = (xs: readonly (number | undefined)[]): number[] => xs.filter((x): x is number => x !== undefined);
const perSecond = (tokens: number, ms: number): number | undefined => (ms > 0 ? (tokens / ms) * 1000 : undefined);

/** Reading speed seen by the client: tokens read / TTFT (the wait in the queue included). */
const clientRate = (r: TurnResult): number | undefined => perSecond(r.uncached, r.m.ttftMs);

/** The reading speed of one conversation alone, from first messages: their median at level 1, else the fastest. */
export function soloRate(first: readonly TurnResult[], sessions: number): number | undefined {
  const rates = defined(first.map(clientRate));
  if (!rates.length) return undefined;
  const s = summarize(rates);
  return sessions === 1 ? s.median : s.max;
}

/**
 * A level from its requests. `solo` = the reading speed of one conversation alone, for the queue
 * wait estimate when the engine does not report its own reading time.
 */
export function aggregateSessions(
  step: Pick<SessionsStep, 'depth' | 'turns' | 'outputTokens' | 'followupTokens'>,
  sessions: number,
  results: readonly TurnResult[],
  o: { requests: number; errors: number; solo?: number },
): SessionsPoint {
  const first = results.filter((r) => r.turn === 1);
  const later = results.filter((r) => r.turn > 1);
  const engineQueue = first.length > 0 && first.every((r) => r.enginePrefillMs !== undefined);
  const solo = o.solo ?? soloRate(first, sessions);
  const queue = first.map((r) =>
    engineQueue ? r.m.ttftMs - (r.enginePrefillMs as number) : solo !== undefined ? r.m.ttftMs - (r.uncached / solo) * 1000 : undefined,
  );
  const prefill = first.map((r) => (r.enginePrefillMs !== undefined ? perSecond(r.uncached, r.enginePrefillMs) : clientRate(r)));
  const shares = defined(later.map((r) => (r.cached === undefined || r.m.promptTokens <= 0 ? undefined : Math.min(1, r.cached / r.m.promptTokens))));
  const reading = unionMs(first.map((r) => [r.m.sentAt, r.m.firstAt] as const));
  const readTotal = first.reduce((n, r) => n + r.uncached, 0);
  const decode = (xs: readonly TurnResult[]): Stat => summarize(defined(xs.map((r) => r.m.decodeTps)));
  return {
    sessions,
    depth: step.depth,
    turns: step.turns,
    outputTokens: step.outputTokens,
    followupTokens: step.followupTokens,
    firstTurn: {
      ttftMs: summarize(first.map((r) => r.m.ttftMs)),
      prefillTps: summarize(defined(prefill)),
      queueWaitMs: summarize(defined(queue).map((q) => Math.max(0, q))),
      decodeTps: decode(first),
    },
    ...(later.length
      ? { laterTurns: { ttftMs: summarize(later.map((r) => r.m.ttftMs)), ...(shares.length ? { cachedShare: summarize(shares) } : {}), decodeTps: decode(later) } }
      : {}),
    ...(reading > 0 && readTotal > 0 ? { aggregatePrefillTps: (readTotal / reading) * 1000 } : {}),
    queueEstimated: !engineQueue,
    requests: o.requests,
    errors: o.errors,
  };
}

const cancelled = () => new AppError('CANCELLED', 'Run cancelled');

/** Runs the levels in ascending order (fitScenario sorted them), within the step's time budget. */
export async function runSessions(step: SessionsStep, d: SessionsDeps): Promise<SessionsRun> {
  const start = d.now();
  const points: SessionsPoint[] = [];
  let solo: number | undefined;
  let last: { sessions: number; ms: number } | undefined;
  for (const sessions of step.levels) {
    // The next level reads `sessions` contexts: it takes about that many times the last level's time per conversation.
    if (step.maxSeconds !== undefined && last && d.now() - start + (last.ms * sessions) / last.sessions > step.maxSeconds * 1000) {
      return { points, skippedFrom: sessions };
    }
    const from = d.now();
    const results = await runLevel(step, sessions, d, solo);
    if (sessions === 1) solo = soloRate(results.results.filter((r) => r.turn === 1), 1);
    points.push(results.point);
    last = { sessions, ms: d.now() - from };
    d.levelDone?.(sessions);
  }
  return { points };
}

async function runLevel(step: SessionsStep, sessions: number, d: SessionsDeps, solo: number | undefined): Promise<{ point: SessionsPoint; results: TurnResult[] }> {
  const results: TurnResult[] = [];
  let requests = 0;
  let errors = 0;
  const pin = d.slots !== undefined && d.slots >= sessions;
  const point = () => aggregateSessions(step, sessions, results, { requests, errors, ...(solo !== undefined ? { solo } : {}) });

  /** One message; undefined = it failed (counted as an error, the conversation ends). */
  const send = async (i: number, turn: number, prompt: Prompt): Promise<{ r: TurnResult; events: StreamEvent[] } | undefined> => {
    const estimated = 'ids' in prompt ? prompt.ids.length : Math.round(prompt.text.length / CHARS_PER_TOKEN);
    d.step({ kind: 'sessions', concurrency: sessions, depth: step.depth, promptTokens: estimated, outputTokens: step.outputTokens, turn, turns: step.turns, rep: requests + 1, reps: sessions * step.turns });
    const req: GenerateRequest = {
      ...('ids' in prompt ? { promptIds: prompt.ids } : { promptText: prompt.text }),
      outputTokens: step.outputTokens,
      seed: d.seed,
      ...(d.model !== undefined ? { model: d.model } : {}),
      cachePrompt: true,
      ...(pin ? { slot: i } : {}),
    };
    requests++;
    try {
      const events: StreamEvent[] = [];
      const sentAt = d.now();
      for await (const e of d.client.generate(req, d.signal)) events.push(e);
      const done = events.find((e): e is Done => e.kind === 'done');
      // Text prompts (no tokenizer): the server's own count when it reports one.
      const promptTokens = 'ids' in prompt ? estimated : (done?.usage?.promptTokens ?? estimated);
      return { r: turnResult(turn, done, fromStream(events, { sentAt, promptTokens, expectedOutput: step.outputTokens })), events };
    } catch (e) {
      if (d.signal.aborted) throw cancelled();
      errors++;
      return undefined;
    }
  };

  const conversation = async (i: number): Promise<void> => {
    let prompt = firstPrompt(step.depth, d);
    for (let turn = 1; turn <= step.turns; turn++) {
      d.alive();
      const sent = await send(i, turn, prompt);
      if (!sent) return;
      results.push(sent.r);
      d.record(sent.r.m);
      d.point(point());
      if (turn === step.turns) return;
      try {
        prompt = await nextPrompt(prompt, sent.events, step.followupTokens, d);
      } catch (e) {
        if (d.signal.aborted) throw cancelled();
        errors++;
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: sessions }, (_, i) => conversation(i)));
  d.alive();
  const p = point();
  d.point(p);
  return { point: p, results };
}

function firstPrompt(depth: number, d: SessionsDeps): Prompt {
  const rep = d.nextRep();
  if (d.tokens) return { ids: buildPrompt(d.tokens, depth, rep, { seed: d.seed, salt: 'sessions', ...(d.bos !== undefined ? { bos: d.bos } : {}) }) };
  return { text: buildTextPrompt(d.corpus, depth, rep, { seed: d.seed, salt: 'sessions' }) };
}

/** The conversation so far (prompt + answer) and `followup` tokens of new text. */
async function nextPrompt(prev: Prompt, events: readonly StreamEvent[], followup: number, d: SessionsDeps): Promise<Prompt> {
  const chunks = events.filter((e): e is Chunk => e.kind === 'chunk');
  const text = chunks.map((c) => c.text ?? '').join('');
  const rep = d.nextRep();
  if ('text' in prev) return { text: prev.text + text + buildTextPrompt(d.corpus, followup, rep, { seed: d.seed, salt: 'sessions-followup' }) };
  // llama.cpp returns the answer's token ids; otherwise the answer is tokenized, as a chat client sends it back as text.
  const answer = chunks.every((c) => c.ids !== undefined) ? chunks.flatMap((c) => c.ids as number[]) : await d.client.tokenize(text, { addSpecial: false, signal: d.signal });
  const more = buildPrompt(d.tokens as readonly number[], followup, rep, { seed: d.seed, salt: 'sessions-followup' });
  return { ids: [...prev.ids, ...answer, ...more] };
}
