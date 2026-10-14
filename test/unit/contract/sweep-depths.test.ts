import { describe, expect, it } from 'vitest';
import { sweepDepths } from '../../../src/contract/configs';

const K = 1024;

describe('grid depths of a context sweep, the context full at the context', () => {
  it('the deepest prompt filling the context stands for it, sent again shorter or not; the others keep their grid depth', () => {
    expect(sweepDepths([K, 64 * K, 261_200], 256 * K)).toEqual([K, 64 * K, 256 * K]);
    expect(sweepDepths([K, 64 * K, 255_000], 256 * K)).toEqual([K, 64 * K, 256 * K]);
    // Not full: a 200K grid point of a 256K context, or a search cut at 64K.
    expect(sweepDepths([K, 200 * K], 256 * K)).toEqual([K, 200 * K]);
    expect(sweepDepths([K, 64 * K], 256 * K)).toEqual([K, 64 * K]);
    // Deeper than the context it says (an inconsistent record) or no context: as measured.
    expect(sweepDepths([K, 16 * K], 8 * K)).toEqual([K, 16 * K]);
    expect(sweepDepths([K, 32_624], undefined)).toEqual([K, 32 * K]);
    expect(sweepDepths([], 8 * K)).toEqual([]);
  });
});
