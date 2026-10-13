import { describe, expect, it } from 'vitest';
import { closeEnough, DEFAULT_TEXT_SCALE, fitTextScale } from '../../../../src/core/bench/text-scale';
import { kvPrecisionRank } from '../../../../src/core/bench/tune-rank';

describe('text prompts calibrated on the server', () => {
  it('fits characters per token and the template overhead from two lengths', () => {
    // 4 characters a token, 27 tokens of chat template.
    const samples = [1000, 8000].map((chars) => ({ chars, tokens: chars / 4 + 27 }));
    const fit = fitTextScale(samples);
    expect(fit.charsPerToken).toBeCloseTo(4, 5);
    expect(fit.overhead).toBe(27);
  });

  it('with one length: the ratio, keeping the overhead it had', () => {
    expect(fitTextScale([{ chars: 4000, tokens: 1010 }], { charsPerToken: 3, overhead: 10 })).toEqual({ charsPerToken: 4, overhead: 10 });
    expect(fitTextScale([])).toBe(DEFAULT_TEXT_SCALE);
    // Nothing but overhead: the previous scale.
    const prev = { charsPerToken: 3, overhead: 50 };
    expect(fitTextScale([{ chars: 10, tokens: 40 }], prev)).toBe(prev);
  });

  it('keeps the previous scale when the fit is absurd', () => {
    const prev = { charsPerToken: 3.9, overhead: 5 };
    // More text, fewer tokens: a negative slope.
    expect(fitTextScale([{ chars: 1000, tokens: 400 }, { chars: 9000, tokens: 300 }], prev)).toBe(prev);
    // A negative overhead.
    expect(fitTextScale([{ chars: 1000, tokens: 100 }, { chars: 2000, tokens: 300 }], prev)).toBe(prev);
  });

  it('says when a prompt has the length asked (2 %, at least 16 tokens)', () => {
    expect(closeEnough(516, 500)).toBe(true);
    expect(closeEnough(517, 500)).toBe(false);
    expect(closeEnough(8150, 8000)).toBe(true);
    expect(closeEnough(7700, 8000)).toBe(false);
  });
});

describe('KV precision of NInfer caches', () => {
  it('ranks bf16, then int8 / fp8, then k8v4, then nvfp4', () => {
    expect(['bf16', 'int8', 'fp8', 'k8v4', 'nvfp4'].map((k) => kvPrecisionRank(k as Parameters<typeof kvPrecisionRank>[0]))).toEqual([0, 1, 1, 1.5, 2]);
  });
});
