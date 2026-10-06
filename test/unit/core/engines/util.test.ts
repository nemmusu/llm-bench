import { describe, expect, it } from 'vitest';
import { ignore, timeoutSignal } from '../../../../src/core/engines/util';

describe('ignore', () => {
  it('swallows rejections', async () => {
    expect(await Promise.reject(new Error('x')).catch(ignore)).toBeUndefined();
  });
});

describe('timeoutSignal', () => {
  it('aborts after the timeout with a TimeoutError', async () => {
    const t = timeoutSignal(20);
    await new Promise((r) => setTimeout(r, 60));
    expect(t.signal.aborted).toBe(true);
    expect((t.signal.reason as DOMException).name).toBe('TimeoutError');
    t.clear();
  });

  it('follows the parent (already aborted or later) and detaches on clear', async () => {
    const pre = new AbortController();
    pre.abort('early');
    expect(timeoutSignal(1000, pre.signal).signal.reason).toBe('early');

    const parent = new AbortController();
    const t = timeoutSignal(1000, parent.signal);
    parent.abort('late');
    expect(t.signal.reason).toBe('late');
    t.clear();

    const p2 = new AbortController();
    const t2 = timeoutSignal(10, p2.signal);
    t2.clear();
    p2.abort();
    await new Promise((r) => setTimeout(r, 30));
    expect(t2.signal.aborted).toBe(false);
  });
});
