/** "Stima tarata su N misure": the fit estimate corrected with VRAM peaks measured on this GPU. */
import { describe, expect, it } from 'vitest';
import { launchParamsSchema, type LaunchParams } from '../../../../src/contract/engines';
import type { RunResult, TuneAttempt } from '../../../../src/contract/results';
import { calibrationFor, FitCalibrator, fitSamples, SCALE_RANGE, samplesOf, type VramSample } from '../../../../src/core/models/calibration';
import { CUDA_CONTEXT_MIB, estimateFit, fitParamsFrom } from '../../../../src/core/models/fit';
import type { ModelFactsEx } from '../../../../src/core/models/types';
import { summaryOf } from '../../../../src/core/store/runs-repo';
import { hardware, makeRun, modelIdentity } from '../store/fixtures';

const P = (o: Partial<LaunchParams> = {}) => launchParamsSchema.parse(o);
const facts: ModelFactsEx = { architecture: 'llama', blockCount: 32, headCount: 32, headCountKv: 8, keyLength: 128, valueLength: 128, embeddingLength: 4096, vocabSize: 152064, feedForwardLength: 12288 };
const FILE = 4_920_739_232;
const BIG = 1 << 30;

/** What the estimator says the settings-dependent part (KV + compute buffer) is, and the fixed part. */
function parts(params: LaunchParams): { base: number; variable: number } {
  const est = estimateFit({ facts, fileBytes: FILE, gpu: { totalMiB: BIG, freeMiB: BIG }, engine: 'llamacpp-native', params: fitParamsFrom(params) });
  return { base: est.weightsMiB + CUDA_CONTEXT_MIB, variable: est.needMiB - est.weightsMiB - CUDA_CONTEXT_MIB };
}

/** A measurement that follows measured = base + offset + scale × variable exactly. */
function sample(ctx: number, scale: number, offset: number, over: Partial<VramSample> = {}): VramSample {
  const params = P({ contextSize: ctx, kvCacheType: 'q8_0', ubatchSize: 512 });
  const p = parts(params);
  return { gpuUuid: 'GPU-aaaa', gpuName: 'NVIDIA GeForce RTX 5090', weakKey: 'w', architecture: 'llama', engine: 'llamacpp-native', facts, fileBytes: FILE, params, measuredMiB: p.base + offset + scale * p.variable, ...over };
}

describe('fitting the measured peaks', () => {
  it('this model: scale and offset by least squares, the median error', () => {
    const cal = fitSamples([sample(4096, 1.5, 300), sample(16384, 1.5, 300), sample(65536, 1.5, 300)], 'model')!;
    expect(cal.scale).toBeCloseTo(1.5, 3);
    expect(cal.offsetMiB).toBeCloseTo(300, -1);
    expect(cal).toMatchObject({ samples: 3, scope: 'model' });
    expect(cal.errorPct).toBeLessThan(0.5);
  });

  it('contexts too alike to tell an offset from a scale, or other models: the scale only', () => {
    const same = fitSamples([sample(16384, 2, 0), sample(16384, 2, 0)], 'model')!;
    expect(same.scale).toBeCloseTo(2, 3);
    expect(same.offsetMiB).toBe(0);
    const arch = fitSamples([sample(4096, 0.8, 0), sample(65536, 0.8, 0)], 'architecture')!;
    expect(arch).toMatchObject({ offsetMiB: 0, scope: 'architecture' });
    expect(arch.scale).toBeCloseTo(0.8, 3);
    // Without the file size the estimator's own weights heuristic is the fixed part.
    const { fileBytes: _f, ...noFile } = sample(4096, 1, 0);
    expect(fitSamples([noFile, { ...noFile, params: P({ contextSize: 65536 }) }], 'architecture')?.samples).toBe(2);
  });

  it('wild fits are kept within bounds (the offset refitted), fewer than 2 measurements give none', () => {
    const wild = fitSamples([sample(4096, 9, 300), sample(65536, 9, 300)], 'model')!;
    expect(wild.scale).toBe(SCALE_RANGE[1]);
    const low = fitSamples([sample(4096, 0.01, 0), sample(8192, 0.01, 0)], 'architecture')!;
    expect(low.scale).toBe(SCALE_RANGE[0]);
    expect(fitSamples([sample(4096, 1, 0)], 'model')).toBeUndefined();
    expect(fitSamples([], 'model')).toBeUndefined();
  });
});

describe('the calibration for a model on this GPU', () => {
  const here = { gpuUuid: 'GPU-aaaa', gpuName: 'NVIDIA GeForce RTX 5090' };
  const own = [sample(4096, 1.2, 100, { sha256: 'abc' }), sample(32768, 1.2, 100, { weakKey: 'w' })];
  const others = [sample(4096, 0.9, 0, { weakKey: 'x' }), sample(32768, 0.9, 0, { weakKey: 'y' })];

  it('its own measurements first (sha256 or weak key), else the same architecture; this card only; llama.cpp only', () => {
    expect(calibrationFor([...own, ...others], { sha256: 'abc', weakKey: 'w' }, 'llamacpp-native', here)?.scope).toBe('model');
    const arch = calibrationFor(others, { weakKey: 'w', architecture: 'llama' }, 'llamacpp-docker', here)!;
    expect(arch.scope).toBe('architecture');
    expect(arch.scale).toBeCloseTo(0.9, 3);
    expect(calibrationFor(others, { weakKey: 'w' }, 'llamacpp-native', here)).toBeUndefined();
    expect(calibrationFor(own, { weakKey: 'w' }, 'vllm-docker', here)).toBeUndefined();
    expect(calibrationFor(own, { weakKey: 'w' }, 'llamacpp-native', { gpuUuid: 'GPU-bbbb' })).toBeUndefined();
    // Cards known by name only.
    const named = own.map(({ gpuUuid: _u, ...s }) => s);
    expect(calibrationFor(named, { weakKey: 'w' }, 'llamacpp-native', here)?.samples).toBe(2);
    expect(calibrationFor(named, { weakKey: 'w' }, 'llamacpp-native', {})).toBeUndefined();
  });

  it('applied to the estimate: the KV + compute part scaled, the raw need kept', () => {
    const cal = calibrationFor(own, { weakKey: 'w' }, 'llamacpp-native', here)!;
    const params = fitParamsFrom(P({ contextSize: 16384, kvCacheType: 'q8_0' }));
    const raw = estimateFit({ facts, fileBytes: FILE, gpu: { totalMiB: 32607, freeMiB: 30000 }, engine: 'llamacpp-native', params });
    const fixed = estimateFit({ facts, fileBytes: FILE, gpu: { totalMiB: 32607, freeMiB: 30000 }, engine: 'llamacpp-native', params, calibration: cal });
    expect(fixed.calibration).toEqual({ samples: 2, errorPct: cal.errorPct, scope: 'model', rawNeedMiB: raw.needMiB });
    const expected = raw.weightsMiB + CUDA_CONTEXT_MIB + 100 + 1.2 * (raw.needMiB - raw.weightsMiB - CUDA_CONTEXT_MIB);
    expect(Math.abs(fixed.needMiB - expected)).toBeLessThan(3);
    expect(fixed.kvMiB).toBe(Math.round(cal.scale * raw.kvMiB));
    // vLLM keeps its own rule.
    const v = estimateFit({ facts, fileBytes: FILE, gpu: { totalMiB: 32607, freeMiB: 30000 }, engine: 'vllm-docker', params, calibration: cal });
    expect(v).not.toHaveProperty('calibration');
    // A partial offload is judged on the calibrated numbers too.
    const tight = estimateFit({ facts, fileBytes: FILE, gpu: { totalMiB: 8000, freeMiB: 4000 }, engine: 'llamacpp-native', params, calibration: cal });
    expect(tight.level).toBe('partial');
  });
});

describe('measurements from saved runs', () => {
  const attempt = (o: Partial<TuneAttempt>): TuneAttempt => ({
    stage: 'capacity',
    params: P({ contextSize: 8192 }),
    kvType: 'f16',
    contextSize: 8192,
    outcome: 'ok',
    points: [],
    command: { argv: [], powershell: '', bash: '' },
    ...o,
  });
  const normal = makeRun({ id: 'N', model: modelIdentity({ facts, sha256: 'abc' }), metrics: { ...makeRun().metrics, vram: { processPeakMiB: 9000, deltaMiB: 9100 } } });
  const tuneRun = makeRun({
    id: 'T',
    model: modelIdentity({ facts }),
    scenario: { profile: 'tune', seed: 1, steps: [] },
    tuning: {
      budget: 'fast',
      maxLaunches: 24,
      dimensions: [],
      capacity: [],
      depths: [],
      combinations: [],
      fastestByDepth: [],
      attempts: [attempt({ vramPeakMiB: 7000 }), attempt({ outcome: 'oom', vramPeakMiB: 18000 }), attempt({}), attempt({ vramPeakMiB: 0 })],
    },
  });

  it('a normal run’s engine peak (else total minus baseline), every tune attempt that loaded; llama.cpp with facts only', () => {
    expect(samplesOf(normal)).toEqual([expect.objectContaining({ measuredMiB: 9000, sha256: 'abc', gpuUuid: 'GPU-aaaa', architecture: 'llama', fileBytes: 2_500_000_000 })]);
    expect(samplesOf({ ...normal, metrics: { ...normal.metrics, vram: { deltaMiB: 9100 } } })[0]!.measuredMiB).toBe(9100);
    expect(samplesOf({ ...normal, metrics: { ...normal.metrics, vram: {} } })).toEqual([]);
    expect(samplesOf({ ...normal, status: 'failed' })).toEqual([]);
    // A run that spilled did not fit: its dedicated peak is capped at the VRAM (29 349 MiB of a 32 GB card), not what it needed.
    expect(samplesOf({ ...normal, validity: ['shared_memory_spill'], metrics: { ...normal.metrics, vram: { processPeakMiB: 29_349, sharedPeakMiB: 4666 } } })).toEqual([]);
    expect(samplesOf(tuneRun).map((s) => s.measuredMiB)).toEqual([7000]);
    expect(samplesOf({ ...normal, engine: { kind: 'vllm-docker', name: 'vLLM' } })).toEqual([]);
    expect(samplesOf(makeRun())).toEqual([]);
    const bare = makeRun({ model: { ...modelIdentity({ facts: { ...facts, architecture: undefined } }), sizeBytes: undefined }, hardware: hardware({ gpus: [] }) });
    expect(samplesOf(bare)[0]).not.toHaveProperty('gpuUuid');
  });

  it('the calibrator reads the runs of this card once, again only when the list changes; never fails', async () => {
    const runs: RunResult[] = [
      makeRun({ id: 'A', model: modelIdentity({ facts }), launch: { ...makeRun().launch, params: P({ contextSize: 4096 }) }, metrics: { ...makeRun().metrics, vram: { processPeakMiB: 6000 } } }),
      makeRun({ id: 'B', model: modelIdentity({ facts }), launch: { ...makeRun().launch, params: P({ contextSize: 65536 }) }, metrics: { ...makeRun().metrics, vram: { processPeakMiB: 14000 } } }),
      makeRun({ id: 'V', engine: { kind: 'vllm-docker', name: 'vLLM' }, model: modelIdentity({ facts }) }),
    ];
    let gets = 0;
    const repo = {
      list: async () => runs.map((r) => summaryOf(r, `${r.id}.json`)),
      get: async (id: string) => {
        gets++;
        if (id === 'B' && gets > 10) throw new Error('gone');
        return runs.find((r) => r.id === id);
      },
    };
    const cal = new FitCalibrator(repo, async () => ({ hostId: 'host-a', gpuUuid: 'GPU-aaaa' }));
    const c = await cal.for({ weakKey: modelIdentity().weakKey }, 'llamacpp-native');
    expect(c).toMatchObject({ samples: 2, scope: 'model' });
    expect(gets).toBe(2);
    await cal.for({ weakKey: modelIdentity().weakKey }, 'llamacpp-native');
    expect(gets).toBe(2);
    runs.push(makeRun({ id: 'C', model: modelIdentity({ facts }) }));
    await cal.for({ weakKey: modelIdentity().weakKey }, 'llamacpp-native');
    expect(gets).toBe(5);
    const byName = new FitCalibrator(repo, async () => ({ hostId: 'host-a', gpuName: 'NVIDIA GeForce RTX 5090' }));
    expect(await byName.for({ weakKey: modelIdentity().weakKey }, 'llamacpp-native')).toBeDefined();
    const broken = new FitCalibrator({ list: () => Promise.reject(new Error('x')), get: async () => undefined }, async () => ({ hostId: 'h' }));
    expect(await broken.for({ weakKey: 'w' }, 'llamacpp-native')).toBeUndefined();
    const missing = new FitCalibrator({ ...repo, get: () => Promise.reject(new Error('x')) }, async () => ({ hostId: 'h', gpuUuid: 'GPU-aaaa' }));
    expect(await missing.for({ weakKey: 'w' }, 'llamacpp-native')).toBeUndefined();
  });
});
