/**
 * "Stima tarata su N misure": the VRAM fit estimate corrected with the peaks measured on this GPU.
 *
 * Every saved run is a source of measurements (GPU, model, engine kind, KV type, context, ubatch,
 * slots, measured peak MiB): a normal run's engine peak (vram.processPeakMiB, else the total minus the
 * baseline), and every tune attempt that loaded (vramPeakMiB). For each one the estimator is run again
 * with the same settings; the weights and the CUDA context are taken as they are and the rest — KV
 * cache + compute buffer, the part that depends on the settings — is fitted:
 *
 *   measured − (weights + CUDA context) = offset + scale × (KV + compute) estimated
 *
 * by least squares over the measurements of this very model on this GPU (scope 'model'; the offset
 * only when their contexts differ enough to tell it from the scale), else over models of the same
 * architecture on this GPU (scope 'architecture', scale only: their weights differ). Fewer than 2
 * measurements: no calibration. llama.cpp only: vLLM reserves its whole memory share whatever the
 * context, so its peaks say nothing about the KV cache.
 */
import type { EngineKind, LaunchParams } from '../../contract/engines';
import type { ModelIdentity } from '../../contract/models';
import type { RunResult } from '../../contract/results';
import type { HereIdentity, RunsRepo } from '../store/runs-repo';
import { CUDA_CONTEXT_MIB, estimateFit, fitParamsFrom, type FitCalibration } from './fit';
import type { ModelFactsEx } from './types';

/** One measured VRAM peak and what produced it. */
export interface VramSample {
  /** GPU uuid when known, and its name. */
  gpuUuid?: string;
  gpuName?: string;
  sha256?: string;
  weakKey: string;
  architecture?: string;
  engine: EngineKind;
  facts: ModelFactsEx;
  fileBytes?: number;
  params: LaunchParams;
  measuredMiB: number;
}

/** Scale and offset are kept within these bounds (a wild fit says more about noise than about the model). */
export const SCALE_RANGE = [0.25, 4] as const;
/** The offset is fitted only when the measured contexts' KV + compute estimates differ by this much. */
export const MIN_SPREAD = 0.2;

const isLlama = (kind: EngineKind): boolean => kind === 'llamacpp-native' || kind === 'llamacpp-docker';

/** The measurements a run holds (llama.cpp runs with model facts only). */
export function samplesOf(run: RunResult): VramSample[] {
  const facts = run.model.facts;
  if (!facts || !isLlama(run.engine.kind)) return [];
  const gpu = run.hardware.gpus[0];
  const common = {
    ...(gpu?.uuid ? { gpuUuid: gpu.uuid } : {}),
    ...(gpu?.name ? { gpuName: gpu.name } : {}),
    ...(run.model.sha256 ? { sha256: run.model.sha256 } : {}),
    weakKey: run.model.weakKey,
    ...(facts.architecture ? { architecture: facts.architecture } : {}),
    engine: run.engine.kind,
    facts,
    ...(run.model.sizeBytes ? { fileBytes: run.model.sizeBytes } : {}),
  };
  const out: VramSample[] = [];
  if (run.tuning) {
    for (const a of run.tuning.attempts) {
      if (a.outcome === 'ok' && a.vramPeakMiB !== undefined && a.vramPeakMiB > 0) out.push({ ...common, params: a.params, measuredMiB: a.vramPeakMiB });
    }
    return out;
  }
  const v = run.metrics.vram;
  const peak = v.processPeakMiB ?? v.deltaMiB;
  if (run.status === 'completed' && peak !== undefined && peak > 0) out.push({ ...common, params: run.launch.params, measuredMiB: peak });
  return out;
}

/** The estimator's own split of a sample: the fixed part (weights + CUDA context) and the rest. */
function split(s: VramSample): { base: number; variable: number } {
  const big = 1 << 30;
  const est = estimateFit({ facts: s.facts, ...(s.fileBytes ? { fileBytes: s.fileBytes } : {}), gpu: { totalMiB: big, freeMiB: big }, engine: s.engine, params: fitParamsFrom(s.params) });
  const base = est.weightsMiB + CUDA_CONTEXT_MIB;
  return { base, variable: est.needMiB - base };
}

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

/** Least squares of measured − base = offset + scale × variable (offset 0 when not allowed or not identifiable). */
export function fitSamples(samples: readonly VramSample[], scope: FitCalibration['scope']): FitCalibration | undefined {
  if (samples.length < 2) return undefined;
  const pts = samples.map((s) => ({ ...split(s), measured: s.measuredMiB })).filter((p) => p.variable > 0);
  if (pts.length < 2) return undefined;
  const xs = pts.map((p) => p.variable);
  const ys = pts.map((p) => p.measured - p.base);
  const spread = (Math.max(...xs) - Math.min(...xs)) / Math.max(...xs);
  let scale: number;
  let offset = 0;
  if (scope === 'model' && spread >= MIN_SPREAD) {
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
    const sxy = xs.reduce((a, x, i) => a + (x - mx) * ((ys[i] as number) - my), 0);
    scale = sxy / sxx;
    offset = my - scale * mx;
  } else {
    scale = xs.reduce((a, x, i) => a + x * (ys[i] as number), 0) / xs.reduce((a, x) => a + x * x, 0);
  }
  const clamped = Math.min(SCALE_RANGE[1], Math.max(SCALE_RANGE[0], scale));
  // A clamped scale needs its offset refitted to the same points.
  if (clamped !== scale && offset !== 0) offset = ys.reduce((a, y, i) => a + y - clamped * (xs[i] as number), 0) / ys.length;
  const errors = pts.map((p) => Math.abs(p.base + offset + clamped * p.variable - p.measured) / p.measured);
  return { scale: clamped, offsetMiB: Math.round(offset), samples: pts.length, errorPct: Math.round(median(errors) * 1000) / 10, scope };
}

/** Same card: by uuid when both know it, else by name. */
function sameGpu(s: VramSample, here: Pick<HereIdentity, 'gpuUuid' | 'gpuName'>): boolean {
  if (here.gpuUuid && s.gpuUuid) return s.gpuUuid === here.gpuUuid;
  return here.gpuName !== undefined && s.gpuName === here.gpuName;
}

/**
 * The calibration for this model with this engine on this GPU: from its own measurements (2 or more),
 * else from models of the same architecture; undefined when there are not enough, or for vLLM.
 */
export function calibrationFor(
  samples: readonly VramSample[],
  model: Pick<ModelIdentity, 'sha256' | 'weakKey'> & { architecture?: string | undefined },
  kind: EngineKind,
  here: Pick<HereIdentity, 'gpuUuid' | 'gpuName'>,
): FitCalibration | undefined {
  if (!isLlama(kind)) return undefined;
  const mine = samples.filter((s) => sameGpu(s, here));
  const same = mine.filter((s) => (model.sha256 !== undefined && s.sha256 === model.sha256) || s.weakKey === model.weakKey);
  const own = fitSamples(same, 'model');
  if (own) return own;
  if (!model.architecture) return undefined;
  return fitSamples(
    mine.filter((s) => s.architecture === model.architecture),
    'architecture',
  );
}

/**
 * Calibrations from the saved runs, read once and again only when the list of runs changes (a run
 * file is never rewritten: new ids are the only change that matters).
 */
export class FitCalibrator {
  private cache: { ids: string; samples: VramSample[] } | undefined;

  constructor(
    private readonly runs: Pick<RunsRepo, 'list' | 'get'>,
    private readonly here: () => Promise<HereIdentity>,
  ) {}

  async samples(): Promise<VramSample[]> {
    const here = await this.here();
    const list = (await this.runs.list()).filter(
      (r) => (r.engineKind === 'llamacpp-native' || r.engineKind === 'llamacpp-docker') && (here.gpuUuid && r.gpuUuid ? r.gpuUuid === here.gpuUuid : r.gpuName === here.gpuName),
    );
    const ids = list.map((r) => r.id).join('|');
    if (this.cache?.ids === ids) return this.cache.samples;
    const samples: VramSample[] = [];
    for (const r of list) {
      const run = await this.runs.get(r.id).catch(() => undefined);
      if (run) samples.push(...samplesOf(run));
    }
    this.cache = { ids, samples };
    return samples;
  }

  /** Never fails: no calibration when the runs cannot be read. */
  async for(model: Pick<ModelIdentity, 'sha256' | 'weakKey'> & { architecture?: string | undefined }, kind: EngineKind): Promise<FitCalibration | undefined> {
    try {
      return calibrationFor(await this.samples(), model, kind, await this.here());
    } catch {
      return undefined;
    }
  }
}
