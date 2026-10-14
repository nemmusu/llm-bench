import { describe, expect, it } from 'vitest';
import { sweepOrderOf } from '../../../../src/core/bench/tuner';

describe('the order the fitting KV types are swept in', () => {
  const max: Record<string, number> = { f16: 65_536, q8_0: 131_072, q4_0: 262_144, k8v4: 196_608, rk8v4: 262_144 };
  const of = (kv: string) => max[kv] as number;

  it('the largest context first, then the most precise type, then the rest by context', () => {
    expect(sweepOrderOf(['f16', 'q8_0', 'q4_0'], of)).toEqual(['q4_0', 'f16', 'q8_0']);
    expect(sweepOrderOf([], of)).toEqual([]);
    // The most precise type is also the largest: by context only.
    expect(sweepOrderOf(['f16', 'q8_0'], () => 4096)).toEqual(['f16', 'q8_0']);
  });

  it('two types as precise as each other: the one with the larger context counts as the best quality', () => {
    expect(sweepOrderOf(['k8v4', 'rk8v4', 'q4_0'], of)).toEqual(['rk8v4', 'q4_0', 'k8v4']);
    const larger = (kv: string) => (kv === 'q4_0' ? 327_680 : of(kv));
    expect(sweepOrderOf(['q4_0', 'k8v4', 'rk8v4'], larger)).toEqual(['q4_0', 'rk8v4', 'k8v4']);
  });
});
