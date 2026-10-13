import { describe, expect, it } from 'vitest';
import { summarize } from '../../../../src/core/bench/stats';
import type { GpuSample } from '../../../../src/contract/hardware';
import { computeValidity, describeGpuUser, isVramApproximate, sharedGpuUsers, vramBusy, type ValidityInput, type VramQuality } from '../../../../src/core/bench/validity';
import type { GpuUser } from '../../../../src/core/telemetry/types';

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

  it('shared_memory_spill comes first: every other number of the run is off', () => {
    expect(computeValidity({ ...clean, sharedMemorySpill: true, keyStats: [{ n: 3, median: 3.5, mean: 3.5, min: 3, max: 4, stddev: 0.3, cv: 0.08, values: [] }] })).toEqual(['shared_memory_spill', 'unstable']);
    expect(computeValidity({ ...clean, sharedMemorySpill: false })).toEqual([]);
  });

  it('gpu_shared: known LLM servers, big VRAM baseline or busy GPU', () => {
    expect(computeValidity({ ...clean, otherGpuUsers: [{ pid: 1, name: 'llama-server', knownLlm: true }] })).toEqual(['gpu_shared']);
    expect(computeValidity({ ...clean, otherGpuUsers: [{ pid: 1, name: 'chrome', knownLlm: false }] })).toEqual([]);
    expect(computeValidity({ ...clean, baselineVramMiB: 6000 })).toEqual(['gpu_shared']);
    expect(computeValidity({ ...clean, baselineUtilPct: 50 })).toEqual(['gpu_shared']);
  });

  it('gpu_shared with per-process memory: non-system processes over 1 GiB; the baseline total no longer decides', () => {
    const dwm = { pid: 2, name: 'dwm', knownLlm: false, kind: 'system' as const, memMiB: 5000 };
    expect(computeValidity({ ...clean, otherGpuUsers: [dwm], baselineVramMiB: 6000 })).toEqual([]);
    expect(computeValidity({ ...clean, otherGpuUsers: [dwm, { pid: 3, name: 'firefox', knownLlm: false, kind: 'app', memMiB: 1025 }] })).toEqual(['gpu_shared']);
    expect(computeValidity({ ...clean, otherGpuUsers: [{ pid: 4, name: 'vmwp', knownLlm: false, kind: 'vm', memMiB: 18_000 }] })).toEqual(['gpu_shared']);
    expect(computeValidity({ ...clean, otherGpuUsers: [{ pid: 5, name: 'vmwp', knownLlm: false, kind: 'vm', memMiB: 1024 }] })).toEqual([]);
    expect(computeValidity({ ...clean, otherGpuUsers: [{ pid: 6, name: 'llama-server', knownLlm: true, kind: 'llm', memMiB: 1 }] })).toEqual(['gpu_shared']);
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

describe('shared GPU users', () => {
  it('sharedGpuUsers keeps LLM servers and non-system processes over 1 GiB (unknown kind counts as an app)', () => {
    const users: GpuUser[] = [
      { pid: 1, name: 'llama-server.exe', knownLlm: true },
      { pid: 2, name: 'dwm', knownLlm: false, kind: 'system', memMiB: 9000 },
      { pid: 3, name: 'game', knownLlm: false, memMiB: 2000 },
      { pid: 4, name: 'tiny', knownLlm: false, kind: 'app', memMiB: 1024 },
      { pid: 5, name: 'nomem', knownLlm: false, kind: 'app' },
    ];
    expect(sharedGpuUsers(users).map((u) => u.pid)).toEqual([1, 3]);
  });

  it('describeGpuUser names kind, PID and size for the run notes', () => {
    expect(describeGpuUser({ pid: 29192, name: 'vmwp', knownLlm: false, kind: 'vm', memMiB: 18_555 })).toBe('vmwp (WSL/VM, PID 29192) 18.1 GB');
    expect(describeGpuUser({ pid: 1234, name: 'llama-server.exe', knownLlm: true, kind: 'llm' })).toBe('llama-server.exe (LLM server, PID 1234)');
    expect(describeGpuUser({ pid: 7, name: 'firefox.exe', knownLlm: false, kind: 'app', memMiB: 2932 })).toBe('firefox.exe (PID 7) 2.9 GB');
  });
});

describe('vramBusy', () => {
  const gpu = (used: number | null, total: number | null = 32_607): GpuSample => ({
    t: 0,
    gpu: 0,
    utilPct: 0,
    memUsedMiB: used,
    memTotalMiB: total,
    powerW: null,
    tempC: null,
    smClockMHz: null,
    memClockMHz: null,
    pcieGen: null,
    pcieWidth: null,
    throttle: [],
  });
  const vm: GpuUser = { pid: 29192, name: 'vmwp', knownLlm: false, kind: 'vm', memMiB: 18_000 };
  const app: GpuUser = { pid: 33864, name: 'firefox.exe', knownLlm: false, kind: 'app', memMiB: 2900 };
  const sys: GpuUser = { pid: 2260, name: 'dwm', knownLlm: false, kind: 'system', memMiB: 3300 };

  it('other LLM servers always make the GPU busy', () => {
    const llm: GpuUser = { pid: 1, name: 'ollama', knownLlm: true };
    expect(vramBusy([sys, llm], [], undefined)).toEqual({ reason: 'llm', users: [llm] });
  });

  it('memory: only when the model does not fit and closing VMs/apps would make it fit (largest first, as many as needed)', () => {
    const base = [gpu(26_000)]; // 6607 free
    expect(vramBusy([sys, app, vm], base, 6607)).toBeUndefined();
    expect(vramBusy([sys, app, vm], base, 9000)).toEqual({ reason: 'memory', users: [vm], freeMiB: 6607, needMiB: 9000 });
    expect(vramBusy([sys, app, vm], base, 6607 + 18_000 + 1)?.users).toEqual([vm, app]);
    // Closing everything that may be closed is still not enough: not a busy GPU.
    expect(vramBusy([sys, app, vm], base, 6607 + 20_900 + 1)).toBeUndefined();
    expect(vramBusy([sys], base, 9000)).toBeUndefined();
    expect(vramBusy([{ ...vm, memMiB: undefined }, { ...app, memMiB: 0 }], base, 9000)).toBeUndefined();
    // Free VRAM is summed over GPUs; unknown readings or no estimate: never busy.
    expect(vramBusy([vm], [gpu(30_000), gpu(30_000)], 5214)).toBeUndefined();
    expect(vramBusy([vm], [gpu(30_000), gpu(30_000)], 6000)).toMatchObject({ reason: 'memory', freeMiB: 5214 });
    expect(vramBusy([vm], [gpu(null), gpu(1, null)], 9000)).toBeUndefined();
    expect(vramBusy([vm], base, undefined)).toBeUndefined();
  });

  it('small desktop apps are ordinary use, never the reason (a model a little too big is not a busy GPU)', () => {
    // The real case: 1,7 GB in use (desktop, a browser, Telegram), the model needs a bit more than is free.
    const telegram: GpuUser = { pid: 4242, name: 'Telegram.exe', knownLlm: false, kind: 'app', memMiB: 210 };
    const firefox: GpuUser = { pid: 32972, name: 'firefox.exe', knownLlm: false, kind: 'app', memMiB: 413 };
    const base = [gpu(1698)]; // 30.909 free
    expect(vramBusy([sys, telegram, firefox], base, 31_200)).toBeUndefined();
    // A program that really holds memory is still named.
    expect(vramBusy([sys, telegram, { ...app, memMiB: 1024 }], base, 31_500)).toEqual({ reason: 'memory', users: [{ ...app, memMiB: 1024 }], freeMiB: 30_909, needMiB: 31_500 });
  });
});

describe('isVramApproximate', () => {
  const q: VramQuality = { method: 'total-delta', external: false, containerized: false, deltaMiB: 4000 };

  it('per-process measurements and runs without VRAM are never approximate', () => {
    expect(isVramApproximate({ ...q, method: 'process', external: true, othersDriftMiB: 99_999 })).toBe(false);
    expect(isVramApproximate({ ...q, method: undefined, external: true })).toBe(false);
  });

  it('total-delta: external always; containers sharing a busy VM; material drift of others', () => {
    expect(isVramApproximate({ ...q, external: true, othersDriftMiB: 0 })).toBe(true);
    expect(isVramApproximate({ ...q, containerized: true, vmBaselineMiB: 18_000, othersDriftMiB: 0 })).toBe(true);
    expect(isVramApproximate({ ...q, containerized: true, vmBaselineMiB: 300, othersDriftMiB: 0 })).toBe(false);
    expect(isVramApproximate({ ...q, othersDriftMiB: 256 })).toBe(false);
    expect(isVramApproximate({ ...q, othersDriftMiB: 400 })).toBe(false); // ≤ 10% of 4000
    expect(isVramApproximate({ ...q, othersDriftMiB: 401 })).toBe(true);
    expect(isVramApproximate({ ...q, deltaMiB: undefined, othersDriftMiB: 257 })).toBe(true);
  });

  it('nothing known about others: containers are approximate, native engines are not', () => {
    expect(isVramApproximate({ ...q, containerized: true })).toBe(true);
    expect(isVramApproximate(q)).toBe(false);
  });
});
