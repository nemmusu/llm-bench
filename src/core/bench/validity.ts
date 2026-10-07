import type { GpuSample } from '../../contract/hardware';
import type { Stat, ValidityFlag } from '../../contract/results';
import { VALIDITY_FLAGS } from '../../contract/results';
import type { GpuUser } from '../telemetry/types';

/**
 * Baseline VRAM used by others above which the GPU counts as shared (the Windows desktop alone takes
 * ~1.6 GB). Only used when no per-process memory is known.
 */
export const SHARED_VRAM_MIB = 4096;
/** A non-system process holding more than this (MiB) shares the GPU (a VM included). */
export const SHARED_PROCESS_MIB = 1024;
/** Baseline GPU utilization (%) above which something else is computing on the GPU. */
export const SHARED_UTIL_PCT = 20;
/** A cold load within this fraction of the warm load was probably served from the OS file cache. */
export const COLD_CACHED_RATIO = 1.15;
/** Only files this large take long enough to read for the cold/warm comparison to mean anything. */
export const COLD_CACHED_MIN_BYTES = 4 * 1024 ** 3;
/** Coefficient of variation above which a measurement is unstable. */
export const UNSTABLE_CV = 0.05;
/** Others' VRAM drift that makes a total-delta figure approximate: at least this many MiB… */
export const VRAM_DRIFT_MIN_MIB = 256;
/** …and more than this fraction of the measured delta. */
export const VRAM_DRIFT_RATIO = 0.1;

/**
 * Other GPU users that make the GPU "shared": known LLM servers at any size, and any non-system
 * process (apps, VMs) holding more than SHARED_PROCESS_MIB. The desktop itself (dwm, explorer,
 * compositors) never counts.
 */
export function sharedGpuUsers(users: readonly GpuUser[]): GpuUser[] {
  return users.filter((u) => u.knownLlm || (u.kind !== 'system' && (u.memMiB ?? 0) > SHARED_PROCESS_MIB));
}

/** "vmwp (WSL/VM, PID 29192) 17.7 GB" — for run notes. */
export function describeGpuUser(u: GpuUser): string {
  const tags = [u.knownLlm ? 'LLM server' : u.kind === 'vm' ? 'WSL/VM' : undefined, `PID ${u.pid}`].filter((x) => x !== undefined);
  const size = u.memMiB !== undefined ? ` ${(u.memMiB / 1024).toFixed(1)} GB` : '';
  return `${u.name} (${tags.join(', ')})${size}`;
}

/** The processes to close: other LLM servers, or the VMs/apps whose memory the model needs. */
export type VramBusy = { reason: 'llm'; users: GpuUser[] } | { reason: 'memory'; users: GpuUser[]; freeMiB: number; needMiB: number };

/**
 * Why a run should not start on this GPU (VRAM_BUSY), or undefined:
 *  1. another known LLM server is running (it skews every number, whatever its size);
 *  2. the model would not fit in the free VRAM (estimate > free) but would if some VMs/apps were
 *     closed: their memory covers the shortfall. They are named largest first, only as many as needed.
 *     When closing them would not be enough (desktop usage, model too big) it is not a "busy GPU"
 *     problem: the run proceeds and the engine reports what happens (MODEL_TOO_LARGE is a plan warning).
 * Anything else holding memory only flags the run gpu_shared.
 */
export function vramBusy(users: readonly GpuUser[], baseline: readonly GpuSample[], needMiB: number | undefined): VramBusy | undefined {
  const llms = users.filter((u) => u.knownLlm);
  if (llms.length > 0) return { reason: 'llm', users: llms };
  const gpus = baseline.filter((x) => x.memTotalMiB !== null && x.memUsedMiB !== null);
  if (needMiB === undefined || gpus.length === 0) return undefined;
  const freeMiB = gpus.reduce((sum, x) => sum + (x.memTotalMiB as number) - (x.memUsedMiB as number), 0);
  if (needMiB <= freeMiB) return undefined;
  const blockers = users
    .filter((u) => (u.kind === 'vm' || u.kind === 'app') && (u.memMiB ?? 0) > 0)
    .sort((a, b) => (b.memMiB as number) - (a.memMiB as number));
  const named: GpuUser[] = [];
  let held = 0;
  for (const u of blockers) {
    if (freeMiB + held >= needMiB) break;
    named.push(u);
    held += u.memMiB as number;
  }
  return freeMiB + held >= needMiB ? { reason: 'memory', users: named, freeMiB, needMiB } : undefined;
}

export interface VramQuality {
  /** How the headline VRAM was measured; undefined = no VRAM measurement. */
  method?: 'process' | 'total-delta';
  /** External endpoint: loaded before the baseline, the delta never contains its weights. */
  external: boolean;
  /** Docker engine: its memory cannot be told apart from whatever else runs in the same VM. */
  containerized: boolean;
  deltaMiB?: number;
  /** othersDriftMiB() of the run; undefined when nothing is known about other processes. */
  othersDriftMiB?: number;
  /** VRAM held by VMs ('vm' users) before launch. */
  vmBaselineMiB?: number;
}

/**
 * vram_approximate: the headline VRAM may include memory that is not the engine's.
 *  - 'process' (the engine's own counter / nvidia-smi entry): never approximate.
 *  - 'total-delta' (peak total − baseline) is approximate when:
 *      · the engine is an external endpoint (already loaded before the baseline);
 *      · a Docker engine shares its VM with something holding > SHARED_PROCESS_MIB at baseline
 *        (another WSL workload: its growth is indistinguishable from the container's);
 *      · other processes changed their VRAM materially during the run: drift >
 *        max(VRAM_DRIFT_MIN_MIB, VRAM_DRIFT_RATIO × delta);
 *      · nothing is known about other processes (no per-process data) and the engine is a container.
 *    A native engine without per-process data and no evidence of drift (WSL) is not flagged.
 */
export function isVramApproximate(q: VramQuality): boolean {
  if (q.method !== 'total-delta') return false;
  if (q.external) return true;
  if (q.containerized && (q.vmBaselineMiB ?? 0) > SHARED_PROCESS_MIB) return true;
  if (q.othersDriftMiB === undefined) return q.containerized;
  return q.othersDriftMiB > Math.max(VRAM_DRIFT_MIN_MIB, VRAM_DRIFT_RATIO * (q.deltaMiB ?? 0));
}

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
  /** isVramApproximate() of the run. */
  vramApproximate: boolean;
  slowSharedFilesystem: boolean;
  /** The engine spilled to shared system memory (spill.ts: spillOf); absent = no. */
  sharedMemorySpill?: boolean;
}

/** Flags that qualify a run's numbers, in the canonical VALIDITY_FLAGS order. */
export function computeValidity(x: ValidityInput): ValidityFlag[] {
  const on = new Set<ValidityFlag>();
  if (x.sharedMemorySpill) on.add('shared_memory_spill');
  // With per-process memory the users decide; the baseline total is the fallback when it is unknown.
  const memoryKnown = x.otherGpuUsers.some((u) => u.memMiB !== undefined);
  const shared =
    sharedGpuUsers(x.otherGpuUsers).length > 0 ||
    (!memoryKnown && (x.baselineVramMiB ?? 0) > SHARED_VRAM_MIB) ||
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
