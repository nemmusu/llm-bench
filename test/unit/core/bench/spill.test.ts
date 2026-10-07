/** Spill rules with the real numbers of an RTX 5090 (Windows, a 27B Q4 model): see real-5090.ts. */
import { describe, expect, it } from 'vitest';
import { launchParamsSchema } from '../../../../src/contract/engines';
import type { RunSummary } from '../../../../src/contract/results';
import { atCeiling, cpuOffloaded, launchSpilled, normalDecode, NORMAL_RUNS, shallowPoint, spillOf, spillPossible, spillThresholdMiB } from '../../../../src/core/bench/spill';
import { REAL } from './real-5090';
import { point } from './tune-helpers';

const here = { hostId: 'h1', gpuUuid: 'GPU-1', gpuName: 'NVIDIA GeForce RTX 5090' };

function summary(over: Partial<RunSummary> = {}): RunSummary {
  return {
    id: 'r',
    createdAt: '2026-10-06T10:00:00.000Z',
    status: 'completed',
    profile: 'quick',
    modelName: 'Qwen 27B',
    modelWeakKey: 'w',
    engineKind: 'llamacpp-native',
    engineLabel: 'llama.cpp b11460',
    gpuName: here.gpuName,
    gpuUuid: here.gpuUuid,
    hostId: here.hostId,
    hostLabel: 'PC',
    decodeTps: REAL.reference.decode,
    validity: [],
    file: 'r.json',
    ...over,
  };
}

describe('the shared-memory threshold', () => {
  it('normal runs: 1024 MiB up to 256K of context, a little more beyond (natural growth ~1 MiB per 1K)', () => {
    expect(spillThresholdMiB(undefined, 4096)).toBe(1024);
    expect(spillThresholdMiB(undefined, REAL.spill.ctx)).toBe(1024);
    expect(spillThresholdMiB(undefined, 1_048_576)).toBe(1792);
    expect(spillThresholdMiB(undefined, undefined)).toBe(1024);
  });

  it('a run that did not spill stays under it at every context (124 / 248 / 376 MiB); the real spill (4 666 MiB) is far above', () => {
    for (const [ctx, shared] of [
      [REAL.reference.ctx, REAL.reference.sharedMiB],
      [REAL.f16At128K.ctx, REAL.f16At128K.sharedMiB],
      [REAL.q8At256K.ctx, REAL.q8At256K.sharedMiB],
    ] as const) {
      expect(shared).toBeLessThan(spillThresholdMiB(undefined, ctx));
      // The tuner's reference (124 MiB at 4K) plus the growth to that context.
      expect(shared).toBeLessThan(spillThresholdMiB({ sharedMiB: REAL.reference.sharedMiB, context: REAL.reference.ctx }, ctx));
    }
    expect(REAL.spill.sharedMiB).toBeGreaterThanOrEqual(spillThresholdMiB(undefined, REAL.spill.ctx));
    // The old rule, max(512, reference + 256) = 512 MiB, was only 136 MiB above the clean 256K launch (1M would have crossed it).
    expect(Math.max(512, REAL.reference.sharedMiB + 256) - REAL.q8At256K.sharedMiB).toBe(136);
    expect(spillThresholdMiB({ sharedMiB: REAL.reference.sharedMiB, context: REAL.reference.ctx }, REAL.q8At256K.ctx) - REAL.q8At256K.sharedMiB).toBeGreaterThan(700);
    // A reference above the floor moves the threshold up.
    expect(spillThresholdMiB({ sharedMiB: 900, context: 4096 }, 4096)).toBe(1668);
  });

  it('only Windows and WSL spill (WDDM)', () => {
    expect(spillPossible({ platform: 'win32', isWsl: false })).toBe(true);
    expect(spillPossible({ platform: 'linux', isWsl: true })).toBe(true);
    expect(spillPossible({ platform: 'linux', isWsl: false })).toBe(false);
    expect(spillPossible(undefined)).toBe(false);
  });
});

describe('launchSpilled: a tune launch, judged live', () => {
  const ref = { sharedMiB: REAL.reference.sharedMiB, context: REAL.reference.ctx };
  const b = REAL.borderline;
  /** What the desktop and the other programs held on the card besides the engine. */
  const desktop = 1_300;

  it('240K: under the threshold once loaded (360 MiB, ~1 MiB per 1K), 1 338 MiB during the probe crosses max(1024, 124 + 236 + 768) = 1 128', () => {
    expect(spillThresholdMiB(ref, b.ctx)).toBe(1128);
    expect(launchSpilled(ref, b.ctx, { sharedMiB: 360, dedicatedMiB: b.dedicatedMiB + desktop, totalMiB: b.totalMiB })).toBe(false);
    expect(launchSpilled(ref, b.ctx, { sharedMiB: b.sharedMiB, dedicatedMiB: b.dedicatedMiB + desktop, totalMiB: b.totalMiB })).toBe(true);
    // The full spill, and no spill at all at 256K with q8_0 (376 MiB).
    expect(launchSpilled(ref, REAL.spill.ctx, { sharedMiB: REAL.spill.sharedMiB, dedicatedMiB: REAL.spill.dedicatedMiB })).toBe(true);
    expect(launchSpilled(ref, REAL.q8At256K.ctx, { sharedMiB: REAL.q8At256K.sharedMiB, dedicatedMiB: REAL.q8At256K.vramMiB + desktop, totalMiB: b.totalMiB })).toBe(false);
  });

  it('the card full (within max(3 %, 1 GiB) of 32 607 MiB) and 512 MiB more shared than the reference: a spill before the threshold', () => {
    const full = b.dedicatedMiB + desktop;
    expect(atCeiling(full, b.totalMiB)).toBe(true);
    expect(launchSpilled(ref, b.ctx, { sharedMiB: REAL.reference.sharedMiB + 512, dedicatedMiB: full, totalMiB: b.totalMiB })).toBe(true);
    expect(launchSpilled(ref, b.ctx, { sharedMiB: REAL.reference.sharedMiB + 511, dedicatedMiB: full, totalMiB: b.totalMiB })).toBe(false);
    // The engine's own 31 160 MiB alone is not the ceiling (31 583): the card's whole use counts.
    expect(launchSpilled(ref, b.ctx, { sharedMiB: 700, dedicatedMiB: b.dedicatedMiB, totalMiB: b.totalMiB })).toBe(false);
    // Without the card's size, or without a reference (0 MiB), the rule still holds as it can.
    expect(launchSpilled(ref, b.ctx, { sharedMiB: 700, dedicatedMiB: full })).toBe(false);
    expect(launchSpilled(undefined, 4096, { sharedMiB: 512, dedicatedMiB: full, totalMiB: b.totalMiB })).toBe(true);
  });

  it('without the shared memory nothing is known (no per-process counters)', () => {
    expect(launchSpilled(ref, b.ctx, { dedicatedMiB: b.totalMiB, totalMiB: b.totalMiB })).toBe(false);
  });
});

describe('the usual generation speed (earlier runs that did not spill)', () => {
  it('median of the newest runs of this model and engine on this PC and card', () => {
    const runs = [
      summary({ id: 'a', createdAt: '2026-10-01T10:00:00.000Z', decodeTps: 50 }),
      summary({ id: 'b', createdAt: '2026-10-03T10:00:00.000Z', decodeTps: 54 }),
      summary({ id: 'c', createdAt: '2026-10-02T10:00:00.000Z', decodeTps: 56 }),
      // Not counted: spilled, failed, other engine, other PC, other card, no speed.
      summary({ id: 'spill', decodeTps: REAL.spill.decode, validity: ['shared_memory_spill'] }),
      summary({ id: 'failed', status: 'failed', decodeTps: 1 }),
      summary({ id: 'docker', engineKind: 'llamacpp-docker', decodeTps: 1 }),
      summary({ id: 'other-pc', hostId: 'h2', decodeTps: 1 }),
      summary({ id: 'other-card', gpuUuid: 'GPU-2', decodeTps: 1 }),
      summary({ id: 'none', decodeTps: undefined }),
    ];
    expect(normalDecode(runs, here, 'llamacpp-native')).toEqual({ tps: 54, runIds: ['b', 'c', 'a'] });
    expect(normalDecode(runs.slice(0, 2), here, 'llamacpp-native')).toEqual({ tps: 52, runIds: ['b', 'a'] });
    expect(normalDecode([], here, 'llamacpp-native')).toBeUndefined();
    // A card without uuid counts as this one.
    expect(normalDecode([summary({ gpuUuid: undefined })], { hostId: 'h1' }, 'llamacpp-native')?.tps).toBe(REAL.reference.decode);
    const many = Array.from({ length: 8 }, (_, i) => summary({ id: `r${i}`, createdAt: `2026-10-0${i + 1}T10:00:00.000Z` }));
    expect(normalDecode(many, here, 'llamacpp-native')?.runIds).toHaveLength(NORMAL_RUNS);
  });

  it('a CPU offload chosen on purpose is not a spill', () => {
    const p = (over: object) => launchParamsSchema.parse(over);
    expect(cpuOffloaded('llamacpp-native', { params: p({}), argv: ['llama-server', '-ngl', 'all'] }, 64)).toBe(false);
    expect(cpuOffloaded('llamacpp-native', { params: p({ gpuLayers: 40 }), argv: ['llama-server', '-ngl', '40'] }, 64)).toBe(true);
    expect(cpuOffloaded('llamacpp-native', { params: p({}), argv: ['llama-server', '--n-cpu-moe', '8'] })).toBe(true);
  });
});

describe('spillOf: a normal run', () => {
  const base = { possible: true, context: REAL.spill.ctx, points: [point(512, REAL.reference.decode)], allOnGpu: true };
  const normal = { tps: REAL.reference.decode, runIds: ['before'] };

  it('the real spill: 4 666 MiB of shared memory and 3.5 tok/s against 53.7', () => {
    const spill = spillOf({ ...base, sharedPeakMiB: REAL.spill.sharedMiB, points: [point(512, REAL.spill.decode)], normal, fixes: { kvCacheType: 'q4_0', maxContext: 200_704 } });
    expect(spill).toEqual({
      by: ['shared-memory', 'decode-collapse'],
      sharedPeakMiB: 4666,
      thresholdMiB: 1024,
      decodeTps: 3.5,
      normalDecodeTps: 53.7,
      normalRunIds: ['before'],
      fixes: { kvCacheType: 'q4_0', maxContext: 200_704 },
    });
  });

  it('either sign is enough; no fix kept when the estimate offers none', () => {
    expect(spillOf({ ...base, sharedPeakMiB: REAL.spill.sharedMiB, fixes: {} })).toEqual({ by: ['shared-memory'], sharedPeakMiB: 4666, thresholdMiB: 1024, decodeTps: 53.7 });
    expect(spillOf({ ...base, points: [point(1024, REAL.spill.decode)], normal })).toEqual({ by: ['decode-collapse'], decodeTps: 3.5, normalDecodeTps: 53.7, normalRunIds: ['before'] });
  });

  it('no spill: clean shared memory, natural slowdown, Linux, CPU offload on purpose, nothing to compare with', () => {
    expect(spillOf({ ...base, sharedPeakMiB: REAL.q8At256K.sharedMiB, normal })).toBeUndefined();
    // 27.9 tok/s at 256K is the context filling up: only short prompts (≤ 4K) are compared.
    expect(spillOf({ ...base, points: [point(262_000, 27.9)], normal })).toBeUndefined();
    expect(spillOf({ ...base, possible: false, sharedPeakMiB: REAL.spill.sharedMiB, points: [point(512, REAL.spill.decode)], normal })).toBeUndefined();
    expect(spillOf({ ...base, allOnGpu: false, points: [point(512, REAL.spill.decode)], normal })).toBeUndefined();
    expect(spillOf({ ...base, points: [point(512, REAL.spill.decode)] })).toBeUndefined();
    // Just above 0.4× is not a collapse.
    expect(spillOf({ ...base, points: [point(512, 0.41 * REAL.reference.decode)], normal })).toBeUndefined();
  });

  it('the shortest prompt with generation numbers counts', () => {
    const empty = { ...point(256, 1), decodeTps: { ...point(256, 1).decodeTps, n: 0 } };
    expect(shallowPoint([point(4096, 50), empty, point(1024, 40), point(8192, 1)])?.promptTokens).toBe(1024);
    expect(shallowPoint([point(8192, 1)])).toBeUndefined();
  });
});
