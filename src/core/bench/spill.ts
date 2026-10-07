/**
 * Spills to shared system memory. Under WDDM (Windows, and WSL which goes through it) a model that does
 * not fit in VRAM is not refused: part of it goes to the system RAM the GPU can address (the engine's
 * "Shared Usage") and everything gets ~10–15× slower, with no error anywhere. Normal runs flag it
 * (validity 'shared_memory_spill', metrics.spill); the tuner counts such a launch as "does not fit".
 *
 * Measured on an RTX 5090 (Windows, driver 617.14, a 27B Q4 model): without a spill the engine's
 * Shared Usage was 124 / 248 / 376 MiB with 4K / 128K / 256K of context (~1 MiB per 1K tokens); a
 * real spill at 256K used 4 666 MiB and generation fell from 53.7 to 3.5 tok/s (0.065×).
 */
import { configParamsOf, configTagsOf } from '../../contract/configs';
import type { EngineKind, LaunchParams } from '../../contract/engines';
import type { OsInfo } from '../../contract/hardware';
import type { FitFixes } from '../../contract/models';
import { spilledRun, type LatencyPoint, type RunSummary, type Spill } from '../../contract/results';
import type { HereIdentity } from '../store/runs-repo';

/** Shared Usage of at least this much is a spill… */
export const SPILL_SHARED_MIN_MIB = 1024;
/** …when it is also this much above what the same launch uses without spilling. */
export const SPILL_SHARED_OVER_MIB = 768;
/** What a launch uses without spilling grows with its context: ~1 MiB per 1K tokens. */
export const SHARED_MIB_PER_1K = 1;
/** Generation on a short prompt below this share of the usual speed is a collapse. */
export const SPILL_RATIO = 0.4;
/** The deepest prompt that counts as "short" for the collapse check. */
export const SHALLOW_DEPTH = 4096;
/** Earlier runs (newest first) whose median generation speed is the usual one. */
export const NORMAL_RUNS = 5;

/** Shared Usage of a launch that did not spill, and its context (the tuner's reference launch). */
export interface SharedReference {
  sharedMiB?: number | undefined;
  context?: number | undefined;
}

/**
 * Shared Usage from which a launch of `context` tokens has spilled: max(1024, reference + the natural
 * growth from the reference's context to this one + 768) MiB. Without a reference launch (normal
 * runs) the reference is 0 MiB at 0 tokens: 1024 MiB up to 256K of context, a little more beyond.
 */
export function spillThresholdMiB(ref: SharedReference | undefined, context: number | undefined): number {
  const growth = context === undefined ? 0 : (Math.max(0, context - (ref?.context ?? 0)) / 1024) * SHARED_MIB_PER_1K;
  return Math.round(Math.max(SPILL_SHARED_MIN_MIB, (ref?.sharedMiB ?? 0) + growth + SPILL_SHARED_OVER_MIB));
}

/** WDDM moves what does not fit to shared memory instead of failing: Windows, and WSL which uses it. */
export function spillPossible(os: Pick<OsInfo, 'platform' | 'isWsl'> | undefined): boolean {
  return os !== undefined && (os.platform === 'win32' || os.isWsl);
}

/** The shortest prompt measured with generation numbers, when it is short enough (≤ 4K). */
export function shallowPoint(points: readonly LatencyPoint[]): LatencyPoint | undefined {
  const measured = points.filter((p) => p.decodeTps.n > 0 && p.promptTokens <= SHALLOW_DEPTH);
  return measured.sort((a, b) => a.promptTokens - b.promptTokens)[0];
}

/** The usual generation speed of this model with this engine on this GPU: earlier completed runs that did not spill. */
export interface NormalDecode {
  tps: number;
  runIds: string[];
}

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

/**
 * Median generation speed of the NORMAL_RUNS newest completed runs of this model (the list RunsRepo.tried
 * gives) with this engine kind on this PC and card that did not spill; undefined when there is none.
 */
export function normalDecode(runs: readonly RunSummary[], here: HereIdentity, kind: EngineKind): NormalDecode | undefined {
  const ok = runs
    .filter(
      (r) =>
        r.status === 'completed' &&
        !spilledRun(r) &&
        r.decodeTps !== undefined &&
        r.engineKind === kind &&
        r.hostId === here.hostId &&
        (!here.gpuUuid || !r.gpuUuid || r.gpuUuid === here.gpuUuid),
    )
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, NORMAL_RUNS);
  if (!ok.length) return undefined;
  return { tps: median(ok.map((r) => r.decodeTps as number)), runIds: ok.map((r) => r.id) };
}

/** Part of the model is meant to be on the CPU (fewer -ngl, --n-cpu-moe…): a slow generation is expected, not a spill. */
export function cpuOffloaded(kind: EngineKind, launch: { params: LaunchParams; argv: readonly string[] }, blockCount?: number): boolean {
  return configTagsOf(configParamsOf({ engineKind: kind, params: launch.params, argv: launch.argv, blockCount })).includes('cpu-offload');
}

export interface SpillCheck {
  /** The OS can spill (spillPossible). */
  possible: boolean;
  /** Peak Shared Usage of the engine, MiB (Windows counters). */
  sharedPeakMiB?: number | undefined;
  /** Context the engine was started with. */
  context?: number | undefined;
  /** The run's own points: the shortest one is compared with the usual speed. */
  points: readonly LatencyPoint[];
  normal?: NormalDecode | undefined;
  /** Every layer was meant to be on the GPU (no CPU offload): only then is a slow generation suspicious. */
  allOnGpu: boolean;
  fixes?: FitFixes | undefined;
}

/** How a run spilled, or undefined. */
export function spillOf(c: SpillCheck): Spill | undefined {
  if (!c.possible) return undefined;
  const thresholdMiB = spillThresholdMiB(undefined, c.context);
  const shared = c.sharedPeakMiB !== undefined && c.sharedPeakMiB >= thresholdMiB;
  const shallow = shallowPoint(c.points);
  const collapse = c.allOnGpu && shallow !== undefined && c.normal !== undefined && shallow.decodeTps.median < SPILL_RATIO * c.normal.tps;
  if (!shared && !collapse) return undefined;
  const fixes = c.fixes && (c.fixes.kvCacheType !== undefined || c.fixes.maxContext !== undefined) ? c.fixes : undefined;
  return {
    by: [...(shared ? (['shared-memory'] as const) : []), ...(collapse ? (['decode-collapse'] as const) : [])],
    ...(c.sharedPeakMiB !== undefined ? { sharedPeakMiB: c.sharedPeakMiB, thresholdMiB } : {}),
    ...(shallow ? { decodeTps: shallow.decodeTps.median } : {}),
    ...(c.normal ? { normalDecodeTps: c.normal.tps, normalRunIds: c.normal.runIds } : {}),
    ...(fixes ? { fixes } : {}),
  };
}
