import type { Stat, ValidityFlag } from '../../contract/results';
import { VALIDITY_FLAGS } from '../../contract/results';
import type { GpuUser } from '../telemetry/types';

/** Baseline VRAM used by others above which the GPU counts as shared (the Windows desktop alone takes ~1.6 GB). */
export const SHARED_VRAM_MIB = 4096;
/** Baseline GPU utilization (%) above which something else is computing on the GPU. */
export const SHARED_UTIL_PCT = 20;
/** A cold load within this fraction of the warm load was probably served from the OS file cache. */
export const COLD_CACHED_RATIO = 1.15;
/** Only files this large take long enough to read for the cold/warm comparison to mean anything. */
export const COLD_CACHED_MIN_BYTES = 4 * 1024 ** 3;
/** Coefficient of variation above which a measurement is unstable. */
export const UNSTABLE_CV = 0.05;

export interface ValidityInput {
  otherGpuUsers: readonly GpuUser[];
  /** Total VRAM used before launch (MiB), when telemetry is available. */
  baselineVramMiB?: number;
  /** Highest GPU utilization seen before launch (%). */
  baselineUtilPct?: number;
  throttleReasons: readonly string[];
  /** undefined when no cold load was run; false when the file cache could not be evicted. */
  coldGuaranteed?: boolean;
  coldMedianMs?: number;
  warmMedianMs?: number;
  modelBytes?: number;
  outputExact: boolean;
  tokensApproximate: boolean;
  energyAvailable: boolean;
  /** Stats whose spread decides "unstable" (decode and prefill rates of every latency point). */
  keyStats: readonly Stat[];
  vramApproximate: boolean;
  slowSharedFilesystem: boolean;
}

/** Flags that qualify a run's numbers, in the canonical VALIDITY_FLAGS order. */
export function computeValidity(x: ValidityInput): ValidityFlag[] {
  const on = new Set<ValidityFlag>();
  const shared =
    x.otherGpuUsers.some((u) => u.knownLlm) ||
    (x.baselineVramMiB ?? 0) > SHARED_VRAM_MIB ||
    (x.baselineUtilPct ?? 0) > SHARED_UTIL_PCT;
  if (shared) on.add('gpu_shared');
  if (x.throttleReasons.length > 0) on.add('throttling');
  if (x.coldGuaranteed === false) on.add('cold_not_guaranteed');
  if (
    x.coldMedianMs !== undefined &&
    x.warmMedianMs !== undefined &&
    (x.modelBytes ?? 0) > COLD_CACHED_MIN_BYTES &&
    x.coldMedianMs <= x.warmMedianMs * COLD_CACHED_RATIO
  ) {
    on.add('cold_probably_cached');
  }
  if (!x.outputExact) on.add('output_not_exact');
  if (x.tokensApproximate) on.add('tokens_approximate');
  if (x.slowSharedFilesystem) on.add('slow_shared_filesystem');
  if (!x.energyAvailable) on.add('energy_unavailable');
  if (x.keyStats.some((s) => s.n > 1 && s.cv > UNSTABLE_CV)) on.add('unstable');
  if (x.vramApproximate) on.add('vram_approximate');
  return VALIDITY_FLAGS.filter((f) => on.has(f));
}
