import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../../../src/contract/errors';
import type { Clock, ExitInfo, LogLine, ManagedProcess } from '../../../../src/core/deps';
import { createProcessInstance, type ProcessInstanceOptions } from '../../../../src/core/engines/instance';
import type { InferenceClient } from '../../../../src/core/inference/types';
import { systemClock } from '../../../../src/core/node-deps';
import { AsyncQueue } from '../../../../src/core/process/runner';

function fakeProcess() {
  const lines = new AsyncQueue<LogLine>();
  let resolveExit!: (e: ExitInfo) => void;
  const exited = new Promise<ExitInfo>((r) => (resolveExit = r));
  const exit = (e: ExitInfo) => {
    lines.close();
    resolveExit(e);
  };
  const stop = vi.fn(async () => {
    exit({ code: null, signal: 'SIGTERM' });
    return exited;
  });
  const mp: ManagedProcess = { pid: 4321, startedAt: 100, lines, exited, stop };
  return { mp, stop, exit, push: (text: string, t = 0) => lines.push({ t, stream: 'stderr', text }) };
}

const client = { flavor: 'llamacpp', baseUrl: 'http://127.0.0.1:1' } as unknown as InferenceClient;

function make(over: Partial<ProcessInstanceOptions> & Pick<ProcessInstanceOptions, 'mp'>) {
  return createProcessInstance({
    baseUrl: 'http://127.0.0.1:1',
    client,
    clock: systemClock,
    probe: async () => false,
    phaseOf: (t) => (t.startsWith('phase:') ? t.slice(6) : undefined),
    diagnose: (lines, exit) => new AppError('ENGINE_EXITED', `exit ${exit.code}`, { detail: lines.join('|') }),
    pollMs: 1,
    ...over,
  });
}

async function drain(it: AsyncIterable<LogLine>) {
  const out: string[] = [];
  for await (const l of it) out.push(l.text);
  return out;
}

describe('createProcessInstance', () => {
  it('becomes ready when the probe says so, with phase marks and re-published logs', async () => {
    const f = fakeProcess();
    let calls = 0;
    const inst = make({ mp: f.mp, probe: async () => ++calls >= 3, maxLogLines: 3 });
    f.push('phase:load_tensors', 10);
    f.push('noise', 11);
    f.push('phase:load_tensors', 12);
    f.push('phase:context', 20);
    f.push('last', 21);
    const ready = inst.waitReady();
    expect(inst.waitReady()).toBe(ready);
    // The engine process is ours: its PID is exposed for per-process VRAM.
    expect(inst.pid).toBe(4321);
    const r = await ready;
    expect(r.phases).toEqual([
      { name: 'load_tensors', t: 10 },
      { name: 'context', t: 20 },
    ]);
    expect(r.tReady).toBeGreaterThan(0);
    expect(inst.t0).toBe(100);
    expect(inst.baseUrl).toBe('http://127.0.0.1:1');
    expect(inst.client).toBe(client);
    expect(inst.logTail()).toEqual(['phase:load_tensors', 'phase:context', 'last']);
    const logs = drain(inst.logs);
    const stopped = inst.stop();
    expect(inst.stop()).toBe(stopped);
    expect(await stopped).toEqual({ code: null, signal: 'SIGTERM' });
    expect(await inst.exited).toEqual({ code: null, signal: 'SIGTERM' });
    expect(await logs).toEqual(['phase:load_tensors', 'noise', 'phase:load_tensors', 'phase:context', 'last']);
    expect(f.stop).toHaveBeenCalledTimes(1);
  });

  it('an early exit is diagnosed from the log tail; onExit runs (and may fail)', async () => {
    const f = fakeProcess();
    const onExit = vi.fn(async () => {
      throw new Error('registry write failed');
    });
    const inst = make({ mp: f.mp, onExit });
    f.push('cudaMalloc failed: out of memory');
    setTimeout(() => f.exit({ code: 1, signal: null }), 20);
    await expect(inst.waitReady()).rejects.toMatchObject({ code: 'ENGINE_EXITED', message: 'exit 1', detail: 'cudaMalloc failed: out of memory' });
    expect(onExit).toHaveBeenCalledWith({ code: 1, signal: null });
    // stop() after exit still resolves with the exit info.
    expect(await inst.stop()).toEqual({ code: 1, signal: null });
  });

  it('a 200 that arrives after our process died is not trusted', async () => {
    const f = fakeProcess();
    const inst = make({
      mp: f.mp,
      // Slow cleanup: the exit is known before the exit promise chain settles.
      onExit: () => new Promise((r) => setTimeout(r, 50)),
      probe: async () => {
        f.exit({ code: 1, signal: null });
        await new Promise((r) => setTimeout(r, 5));
        return true;
      },
    });
    await expect(inst.waitReady()).rejects.toMatchObject({ code: 'ENGINE_EXITED' });
  });

  it('an exit during a hanging probe is diagnosed without waiting for the probe', async () => {
    const f = fakeProcess();
    let probeSignal: AbortSignal | undefined;
    const inst = make({
      mp: f.mp,
      probe: (s) => {
        probeSignal = s;
        return new Promise(() => {}); // a server that accepted the connection and never answers
      },
    });
    setTimeout(() => f.exit({ code: 1, signal: null }), 20);
    const t0 = Date.now();
    await expect(inst.waitReady()).rejects.toMatchObject({ code: 'ENGINE_EXITED' });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(probeSignal?.aborted).toBe(true);
  });

  it('probe errors count as "not yet"; timeout stops the engine', async () => {
    const f = fakeProcess();
    let t = 0;
    const clock: Clock = { now: () => (t += 1000), wall: () => 0, sleep: async () => {} };
    const probe = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const inst = make({ mp: f.mp, clock, probe, readyTimeoutMs: 2500 });
    f.push('still loading');
    await expect(inst.waitReady()).rejects.toMatchObject({ code: 'ENGINE_TIMEOUT', params: { timeoutMs: 2500 }, detail: 'still loading' });
    expect(probe).toHaveBeenCalled();
    expect(f.stop).toHaveBeenCalled();
  });

  it('abort while waiting (waitReady signal or start signal) stops the engine → CANCELLED', async () => {
    const a = fakeProcess();
    const ac = new AbortController();
    const instA = make({ mp: a.mp, pollMs: 10_000 });
    const pending = instA.waitReady(ac.signal);
    setTimeout(() => ac.abort(), 20);
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(a.stop).toHaveBeenCalled();

    const b = fakeProcess();
    const instB = make({ mp: b.mp, startSignal: AbortSignal.abort() });
    await expect(instB.waitReady()).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('uses defaults for poll interval, timeout and tail size', async () => {
    const f = fakeProcess();
    let n = 0;
    const inst = createProcessInstance({
      mp: f.mp,
      baseUrl: 'http://x',
      client,
      clock: systemClock,
      probe: async () => n++ > 0,
      phaseOf: () => undefined,
      diagnose: () => new AppError('INTERNAL', 'x'),
    });
    for (let i = 0; i < 2100; i++) f.push(`l${i}`);
    await new Promise((r) => setTimeout(r, 10));
    expect((await inst.waitReady()).phases).toEqual([]);
    expect(inst.logTail()).toHaveLength(2000);
    expect(inst.logTail()[0]).toBe('l100');
    f.exit({ code: 0, signal: null });
  });
});
