import { describe, expect, it } from 'vitest';
import { summarize } from '../../../../src/core/bench/stats';
import { computeValidity, type ValidityInput } from '../../../../src/core/bench/validity';

const clean: ValidityInput = {
  otherGpuUsers: [],
  throttleReasons: [],
  outputExact: true,
  tokensApproximate: false,
  energyAvailable: true,
  keyStats: [summarize([100, 101, 99])],
  vramApproximate: false,
  slowSharedFilesystem: false,
};

describe('computeValidity', () => {
  it('a clean run has no flags', () => {
    expect(computeValidity(clean)).toEqual([]);
    expect(computeValidity({ ...clean, baselineVramMiB: 1600, baselineUtilPct: 5, coldGuaranteed: true })).toEqual([]);
  });

  it('gpu_shared: known LLM servers, big VRAM baseline or busy GPU', () => {
    expect(computeValidity({ ...clean, otherGpuUsers: [{ pid: 1, name: 'llama-server', knownLlm: true }] })).toEqual(['gpu_shared']);
    expect(computeValidity({ ...clean, otherGpuUsers: [{ pid: 1, name: 'chrome', knownLlm: false }] })).toEqual([]);
    expect(computeValidity({ ...clean, baselineVramMiB: 6000 })).toEqual(['gpu_shared']);
    expect(computeValidity({ ...clean, baselineUtilPct: 50 })).toEqual(['gpu_shared']);
  });

  it('cold cache heuristics only on big files', () => {
    const big = 8 * 1024 ** 3;
    expect(computeValidity({ ...clean, coldGuaranteed: false })).toEqual(['cold_not_guaranteed']);
    expect(computeValidity({ ...clean, coldMedianMs: 5500, warmMedianMs: 5000, modelBytes: big })).toEqual(['cold_probably_cached']);
    expect(computeValidity({ ...clean, coldMedianMs: 9000, warmMedianMs: 5000, modelBytes: big })).toEqual([]);
    expect(computeValidity({ ...clean, coldMedianMs: 5000, warmMedianMs: 5000, modelBytes: 1e9 })).toEqual([]);
    expect(computeValidity({ ...clean, coldMedianMs: 5000, warmMedianMs: 5000 })).toEqual([]);
    expect(computeValidity({ ...clean, coldMedianMs: 5000, modelBytes: big })).toEqual([]);
    expect(computeValidity({ ...clean, warmMedianMs: 5000, modelBytes: big })).toEqual([]);
  });

  it('every other flag, in canonical order', () => {
    expect(
      computeValidity({
        ...clean,
        throttleReasons: ['hw_slowdown'],
        outputExact: false,
        tokensApproximate: true,
        energyAvailable: false,
        keyStats: [summarize([50, 100])],
        vramApproximate: true,
        slowSharedFilesystem: true,
      }),
    ).toEqual(['throttling', 'output_not_exact', 'tokens_approximate', 'slow_shared_filesystem', 'energy_unavailable', 'unstable', 'vram_approximate']);
  });

  it('a single sample is never unstable', () => {
    expect(computeValidity({ ...clean, keyStats: [{ ...summarize([1]), cv: 1 }] })).toEqual([]);
  });
});
