/** The watchdogs of a streamed request (real timers, short windows). */
import { describe, expect, it } from 'vitest';
import { AppError } from '../../../../src/contract/errors';
import type { StreamEvent } from '../../../../src/core/inference/types';
import { deadlineError, firstEventMs, STALL_RULES, stalledError, watchdogFired, watchStream, type StallRules } from '../../../../src/core/bench/watchdog';

const chunk = (t: number): StreamEvent => ({ kind: 'chunk', t, textLen: 4, tokens: 1 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hang = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    if (signal.aborted) reject(new AppError('CANCELLED', 'Request aborted'));
    signal.addEventListener('abort', () => reject(new AppError('CANCELLED', 'Request aborted')), { once: true });
  });

/** An engine sending `n` chunks `gapMs` apart, then hanging (unless `done`). */
function engine(o: { n: number; gapMs: number; done?: boolean; firstMs?: number }) {
  return (signal: AbortSignal): AsyncIterable<StreamEvent> =>
    (async function* () {
      if (o.firstMs) await sleep(o.firstMs);
      for (let i = 0; i < o.n; i++) {
        if (i > 0) await sleep(o.gapMs);
        yield chunk(i);
      }
      if (o.done) {
        yield { kind: 'done', t: o.n } satisfies StreamEvent;
        return;
      }
      await hang(signal);
    })();
}

const fast: StallRules = { idleMs: 40, minPrefillTps: 1e9 };

async function drain(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('watchdogs of a streamed request', () => {
  it('the first event gets as long as reading the prompt at 25 tok/s, never less than a minute', () => {
    expect(STALL_RULES).toEqual({ idleMs: 60_000, minPrefillTps: 25 });
    expect(firstEventMs(1024, STALL_RULES)).toBe(60_000);
    expect(firstEventMs(262_144, STALL_RULES)).toBe(10_485_760);
    expect(stalledError(60_000)).toMatchObject({ code: 'ENGINE_TIMEOUT', params: { reason: 'stalled', ms: 60_000 } });
    expect(deadlineError(30_000)).toMatchObject({ code: 'ENGINE_TIMEOUT', params: { reason: 'deadline', ms: 30_000 } });
  });

  it('a request that streams to its end passes through untouched (chunks closer than the window)', async () => {
    const events = await drain(watchStream(engine({ n: 5, gapMs: 10, done: true, firstMs: 10 }), { signal: new AbortController().signal, promptTokens: 1024, rules: fast, timeoutMs: 5000 }));
    expect(events.map((e) => e.kind)).toEqual(['chunk', 'chunk', 'chunk', 'chunk', 'chunk', 'done']);
  });

  it('nothing at all: stalled after the first window; nothing more after a few tokens: stalled after the idle window', async () => {
    const silent = watchStream(engine({ n: 0, gapMs: 0 }), { signal: new AbortController().signal, promptTokens: 1024, rules: { idleMs: 30, minPrefillTps: 1024 / 0.06 } });
    await expect(drain(silent)).rejects.toMatchObject({ code: 'ENGINE_TIMEOUT', params: { reason: 'stalled', ms: 60 } });
    const stops = watchStream(engine({ n: 3, gapMs: 5 }), { signal: new AbortController().signal, promptTokens: 10, rules: fast });
    const seen: StreamEvent[] = [];
    await expect(
      (async () => {
        for await (const e of stops) seen.push(e);
      })(),
    ).rejects.toMatchObject({ code: 'ENGINE_TIMEOUT', params: { reason: 'stalled', ms: 40 } });
    expect(seen).toHaveLength(3);
  });

  it('a deadline ends a request that keeps streaming too slowly', async () => {
    const slow = watchStream(engine({ n: 100, gapMs: 20 }), { signal: new AbortController().signal, promptTokens: 10, rules: fast, timeoutMs: 70 });
    await expect(drain(slow)).rejects.toMatchObject({ code: 'ENGINE_TIMEOUT', params: { reason: 'deadline', ms: 70 } });
  });

  it('a cancelled run is a cancellation, not a timeout; a consumer that stops early leaves no timer behind', async () => {
    const ac = new AbortController();
    const cancelled = watchStream(engine({ n: 1, gapMs: 0 }), { signal: ac.signal, promptTokens: 10, rules: { idleMs: 10_000, minPrefillTps: 1e9 } });
    setTimeout(() => ac.abort(), 20);
    await expect(drain(cancelled)).rejects.toMatchObject({ code: 'CANCELLED' });
    for await (const e of watchStream(engine({ n: 3, gapMs: 1 }), { signal: new AbortController().signal, promptTokens: 10, rules: fast, timeoutMs: 10 })) {
      expect(e.kind).toBe('chunk');
      break;
    }
    // Neither timer fires later (the generator's finally cleared them).
    await sleep(60);
  });

  it('watchdogFired: only the stall guard and the deadline', () => {
    expect(watchdogFired(stalledError(1).toJSON())).toBe(true);
    expect(watchdogFired(deadlineError(1).toJSON())).toBe(true);
    expect(watchdogFired({ code: 'ENGINE_TIMEOUT' })).toBe(false);
    expect(watchdogFired({ code: 'CANCELLED', params: { reason: 'stalled' } })).toBe(false);
  });
});
