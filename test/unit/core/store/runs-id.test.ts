import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isRunId, newRunId, runIdTime } from '../../../../src/core/store/runs-id';

describe('newRunId', () => {
  it('is a 26-char Crockford ULID carrying its creation time', () => {
    const id = newRunId(Date.UTC(2026, 9, 6, 10));
    expect(id).toHaveLength(26);
    expect(isRunId(id)).toBe(true);
    expect(runIdTime(id)).toBe(Date.UTC(2026, 9, 6, 10));
  });
  it('uses the injected randomness (short buffers pad with zeros)', () => {
    expect(newRunId(0, () => new Uint8Array(16).fill(31))).toBe(`${'0'.repeat(10)}${'Z'.repeat(16)}`);
    expect(newRunId(-5, () => new Uint8Array(0))).toBe('0'.repeat(26));
  });
  it('defaults to now and real randomness', () => {
    const a = newRunId();
    const b = newRunId();
    expect(a).not.toBe(b);
    expect(Math.abs((runIdTime(a) ?? 0) - Date.now())).toBeLessThan(60_000);
  });
  it('property: string order follows time order', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 47 }), fc.integer({ min: 0, max: 2 ** 47 }), (t1, t2) => {
        const a = newRunId(t1);
        const b = newRunId(t2);
        if (t1 < t2) expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true);
        expect(runIdTime(a)).toBe(t1);
      }),
    );
  });
  it('rejects ids that are not ULIDs', () => {
    expect(isRunId('hello')).toBe(false);
    expect(isRunId('01K6Z0000000000000000000AI')).toBe(false);
    expect(runIdTime('nope')).toBeUndefined();
  });
});
