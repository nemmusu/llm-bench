/**
 * Long-conversation results modelled on the team page the user pasted (vLLM, 200K-token
 * conversations, 1 and 2 sessions, before/after a configuration change).
 */
import type { KvCapacity, RunResult, SessionsPoint } from '../../../../src/contract/results';
import { summarize } from '../../../../src/core/bench/stats';
import { IDS, seeded } from './fixtures';

export function sessionsPoint(over: Partial<SessionsPoint> & { sessions: number }): SessionsPoint {
  return {
    depth: 200_000,
    turns: 3,
    outputTokens: 256,
    followupTokens: 256,
    firstTurn: { ttftMs: summarize([113_000]), prefillTps: summarize([1763]), queueWaitMs: summarize([0]), decodeTps: summarize([31.7]) },
    laterTurns: { ttftMs: summarize([1000, 1000]), cachedShare: summarize([0.997, 0.997]), decodeTps: summarize([31.7, 31.7]) },
    aggregatePrefillTps: 1763,
    queueEstimated: true,
    requests: 3,
    errors: 0,
    ...over,
  };
}

/** 1 session: 1 min 53 s, then 1 s with 99,7 % reused; 2 sessions: the second waits 1 min 48 s in the queue. */
export const NOW_POINTS: SessionsPoint[] = [
  sessionsPoint({ sessions: 1 }),
  sessionsPoint({
    sessions: 2,
    firstTurn: { ttftMs: summarize([112_000, 222_000]), prefillTps: summarize([1785, 1780]), queueWaitMs: summarize([0, 108_000]), decodeTps: summarize([18.4, 18.4]) },
    laterTurns: { ttftMs: summarize([5400, 5400, 5400, 5400]), cachedShare: summarize([0.975, 0.975, 0.975, 0.975]), decodeTps: summarize([18.4, 18.4, 18.4, 18.4]) },
    aggregatePrefillTps: 1332,
    requests: 6,
  }),
];

/** Before: no prefix cache, everything re-read from scratch. */
export const BEFORE_POINTS: SessionsPoint[] = [
  sessionsPoint({
    sessions: 1,
    firstTurn: { ttftMs: summarize([247_000]), prefillTps: summarize([795]), queueWaitMs: summarize([0]), decodeTps: summarize([27.4]) },
    laterTurns: { ttftMs: summarize([246_000, 246_500]), cachedShare: summarize([0, 0]), decodeTps: summarize([27.4, 27.4]) },
    aggregatePrefillTps: 795,
  }),
];

export const NOW_KV: KvCapacity = { tokens: 889_820, maxConcurrencyAtTokens: { tokens: 200_000, concurrency: 4.45 } };
export const BEFORE_KV: KvCapacity = { tokens: 399_806, maxConcurrencyAtTokens: { tokens: 200_000, concurrency: 1.99 } };

/** A seeded vLLM run with long conversations and its KV capacity. */
export function withSessions(base: RunResult, id: string, points: SessionsPoint[], kv: KvCapacity | undefined, createdAt: string): RunResult {
  const run = structuredClone(base);
  run.id = id;
  run.createdAt = createdAt;
  run.finishedAt = createdAt;
  run.metrics = { ...run.metrics, sessions: points, ...(kv ? { kvCapacity: kv } : {}) };
  return run;
}

export const TEAM_IDS = { before: '01K6Z0BEFORE00000000000000A', now: '01K6Z1NOW000000000000000000B' } as const;

export function teamRuns(): { before: RunResult; now: RunResult } {
  const base = seeded(IDS.vllm);
  return {
    before: withSessions(base, TEAM_IDS.before, BEFORE_POINTS, BEFORE_KV, '2026-10-06T08:00:00.000Z'),
    now: withSessions(base, TEAM_IDS.now, NOW_POINTS, NOW_KV, '2026-10-07T08:00:00.000Z'),
  };
}
