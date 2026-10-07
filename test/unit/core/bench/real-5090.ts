/**
 * Real numbers measured by GPU Bench 0.3.0 on an RTX 5090 32 GB (Windows, driver 617.14, llama.cpp
 * b11460 CUDA 13.4) with a 27B Q4_K_XL GGUF of 17.6 GB: only the numbers, no file of the user.
 * Decode / prefill in tok/s, memory in MiB, contexts in tokens.
 */
import type { FitEstimate } from '../../../../src/contract/models';
import type { LaunchParams } from '../../../../src/contract/engines';
import type { FakeProfile } from '../../../fakes/fake-engine/server.mjs';
import { optimistic } from './tune-lab';

export const REAL = {
  modelBytes: 17.6e9,
  /** "Trova le impostazioni migliori", Veloce: the reference launch (f16 at 4K). */
  reference: { ctx: 4096, vramMiB: 16_796, sharedMiB: 124, loadMs: 9_900, decode: 53.7, prefill256: 1073 },
  /** Capacity f16 at 128K: its points (depth, decode, prefill). */
  f16At128K: { ctx: 131_072, vramMiB: 24_856, sharedMiB: 248, points: [[1024, 55.9, 1810], [65_536, 46.5, 2049], [131_072, 40.2, 1450]] as const },
  /** Capacity q8_0 at 256K. */
  q8At256K: { ctx: 262_144, vramMiB: 26_478, sharedMiB: 376, points: [[1024, 54.8, 1787], [131_072, 37.3, 1387], [262_144, 27.9, 875]] as const },
  /** What the VRAM estimate predicted. */
  predicted: { f16: 247_552, q8_0: 262_144, q4_0: 262_144 },
  /** A Rapido with -c 262144 -ctk f16 -ctv f16 -fa auto -ngl all: it spilled. */
  spill: { ctx: 262_144, sharedMiB: 4_666, dedicatedMiB: 29_349, decode: 3.5, prefill: 32, ttftMs: 15_800 },
} as const;

/**
 * The fake engine's models fitted to those numbers: weights + 65 MiB of f16 KV per 1K tokens + 300 MiB
 * of compute buffer (16 796 at 4K, 24 856 at 128K), 31 000 MiB free; generation 55.9 → 27.9 tok/s and
 * prompt reading 1 810 → ~860 tok/s from 1K to 256K; a spill generates at 0.065× (3.5 / 53.7).
 */
export const REAL_PROFILE: FakeProfile = {
  loadMsCold: REAL.reference.loadMs,
  loadMsWarm: REAL.reference.loadMs,
  prefillTps: 1810,
  decodeTps: 55.9,
  memory: { totalMiB: 31_000, weightsMiB: 16_236, kvMiBPer1k: 65, computeMiBPer512: 300, spillMiB: 8000 },
  speed: { depthSlowdown: 0.125, prefillDepthSlowdown: 0.134, ubatchExponent: 0.1, spillFactor: 0.065 },
};

/** The VRAM estimate of that run: f16 up to 247 552 tokens (+10 % slack), q8_0 and q4_0 the whole 262 144. */
export function realPredict(p: LaunchParams): FitEstimate {
  const share = { f16: 1, q8_0: 34 / 64, q4_0: 18 / 64 }[p.kvCacheType as 'f16'];
  const need = 16_536 + (65 / 1024) * share * (p.contextSize as number);
  // 247 552 tokens of f16 need exactly the available VRAM × 1.1.
  return { ...optimistic(), needMiB: need, availableMiB: (16_536 + (65 / 1024) * 247_552) / 1.1 };
}
