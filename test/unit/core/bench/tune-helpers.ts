/** Shared builders for the sweep / ranking / tuner tests. */
import type { ConcurrencyPoint, LatencyPoint, SessionsPoint, Stat, TuneCombination } from '../../../../src/contract/results';

export function stat(median: number, cv = 0): Stat {
  return { n: 2, median, mean: median, min: median, max: median, stddev: median * cv, cv, values: [median, median] };
}

export function point(promptTokens: number, decode: number, o: { prefill?: number; ttft?: number; cv?: number; engine?: boolean } = {}): LatencyPoint {
  const prefill = o.prefill ?? 5000;
  return {
    promptTokens,
    outputTokens: 128,
    ttftMs: stat(o.ttft ?? (promptTokens / prefill) * 1000, o.cv),
    prefillTps: stat(prefill, o.cv),
    ...(o.engine ? { prefillTpsEngine: stat(prefill, o.cv) } : {}),
    decodeTps: stat(decode, o.cv),
    itlP50Ms: 1000 / decode,
    itlP95Ms: 1000 / decode,
    itlPerChunk: false,
    totalMs: stat(1000),
  };
}

/** A users-at-once level: every user at `perUser` tok/s (spread `cv`), the total, the slowest TTFT. */
export function concurrencyPoint(
  level: number,
  perUser: number,
  o: { promptTokens?: number; outputTokens?: number; ttftP95?: number; errors?: number; cv?: number; aggregate?: number; noStat?: boolean } = {},
): ConcurrencyPoint {
  return {
    level,
    requests: level,
    aggregateTps: o.aggregate ?? perUser * level,
    perRequestDecodeTpsP50: perUser,
    ttftP50Ms: (o.ttftP95 ?? 1000) / 2,
    ttftP95Ms: o.ttftP95 ?? 1000,
    errors: o.errors ?? 0,
    promptTokens: o.promptTokens ?? 8000,
    outputTokens: o.outputTokens ?? 128,
    ...(o.noStat ? {} : { perRequestDecodeTps: { ...stat(perUser, o.cv), n: level } }),
  };
}

/** One level of conversations: N at once, later messages answered after `laterTtft` ms. */
export function sessionsPoint(sessions: number, depth: number, laterTtft: number): SessionsPoint {
  return {
    sessions,
    depth,
    turns: 3,
    outputTokens: 128,
    followupTokens: 256,
    firstTurn: { ttftMs: stat(1000), prefillTps: stat(5000), queueWaitMs: stat(100), decodeTps: stat(50) },
    laterTurns: { ttftMs: stat(laterTtft), cachedShare: stat(0.9), decodeTps: stat(50) },
    queueEstimated: false,
    requests: sessions * 3,
    errors: 0,
  };
}

export function combo(kvType: TuneCombination['kvType'], maxContext: number, sweep: LatencyPoint[], over: Partial<TuneCombination> = {}): TuneCombination {
  return {
    params: { contextSize: maxContext, kvCacheType: kvType, extraArgs: [], env: {} },
    kvType,
    maxContext,
    sweep,
    command: { argv: ['llama-server'], powershell: 'llama-server', bash: 'llama-server' },
    outcome: 'ok',
    tags: [],
    ...over,
  };
}
