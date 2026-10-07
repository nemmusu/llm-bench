/**
 * A realistic "Trova le impostazioni migliori" result, shaped by the contract: q4_0 reaches 64K
 * (twice q8_0), f16 is fastest up to 16K, q8_0 at 32K, q4_0 with ub 2048 at 64K (recommended).
 */
import type { LaunchParams } from '../../../../src/contract/engines';
import type { ConcurrencyPoint, LatencyPoint, RunResult, Stat, TuneAttempt, TuneCombination, TuneKvType, Tuning } from '../../../../src/contract/results';
import { IDS, seeded } from '../bench/fixtures';

export function stat(median: number, cv = 0.005, n = 2): Stat {
  const sd = median * cv;
  return { n, median, mean: median, min: median - sd, max: median + sd, stddev: sd, cv, values: Array.from({ length: n }, () => median) };
}

export function point(depth: number, decode: number, prefill: number, ttftMs = (depth / prefill) * 1000, over: Partial<LatencyPoint> = {}): LatencyPoint {
  return {
    promptTokens: depth,
    outputTokens: 128,
    ttftMs: stat(ttftMs),
    prefillTps: stat(prefill),
    decodeTps: stat(decode),
    itlP50Ms: 1000 / decode,
    itlP95Ms: 1200 / decode,
    itlPerChunk: false,
    totalMs: stat(ttftMs + (128 / decode) * 1000),
    ...over,
  };
}

export function params(over: Partial<LaunchParams> = {}): LaunchParams {
  return { extraArgs: [], env: {}, ...over };
}

const cmd = (args: string) => ({ argv: ['llama-server', ...args.split(' ')], powershell: `llama-server ${args}`, bash: `llama-server ${args}` });

export function combo(kvType: TuneKvType, maxContext: number, sweep: LatencyPoint[], over: Partial<TuneCombination> = {}): TuneCombination {
  const p = params({ kvCacheType: kvType, flashAttention: 'on', contextSize: maxContext, ...over.params });
  return {
    kvType,
    maxContext,
    vramPeakMiB: 28000,
    sweep,
    command: cmd(`-c ${maxContext} -ctk ${kvType} -ctv ${kvType} -fa on`),
    outcome: 'ok',
    tags: [],
    ...over,
    params: p,
  };
}

export function attempt(stage: TuneAttempt['stage'], kvType: TuneKvType, contextSize: number, outcome: TuneAttempt['outcome'], over: Partial<TuneAttempt> = {}): TuneAttempt {
  return {
    stage,
    kvType,
    contextSize,
    outcome,
    params: params({ kvCacheType: kvType, flashAttention: 'on', contextSize }),
    points: [],
    command: cmd(`-c ${contextSize} -ctk ${kvType}`),
    ...over,
  };
}

const K = 1024;

export function tuning(): Tuning {
  const f16 = combo('f16', 24 * K, [point(K, 92, 9000), point(4 * K, 88, 8800), point(8 * K, 84, 8400), point(16 * K, 78, 7600), point(24 * K - 160, 74, 7000)], { vramPeakMiB: 30100 });
  const q8 = combo('q8_0', 32 * K, [point(K, 90, 8900), point(4 * K, 86, 8600), point(8 * K, 82, 8100), point(16 * K, 77, 7400), point(32 * K - 144, 72, 6600)], { vramPeakMiB: 29800 });
  const q4ub = combo(
    'q4_0',
    64 * K,
    [point(K, 80, 9800), point(4 * K, 78, 9600), point(8 * K, 76, 9300), point(16 * K, 72, 8800), point(32 * K, 68, 8000), point(64 * K - 144, 60, 6400)],
    { params: params({ ubatchSize: 2048, batchSize: 4096 }), vramPeakMiB: 30500 },
  );
  const q4 = combo('q4_0', 64 * K, [point(K, 81, 9000), point(4 * K, 79, 8800), point(8 * K, 75, 8500), point(16 * K, 70, 8000), point(32 * K, 66, 7200), point(64 * K - 144, 58, 5600)], {
    vramPeakMiB: undefined,
  });
  const offload = combo(
    'q8_0',
    64 * K,
    [
      point(K, 30, 2000),
      point(4 * K, 29, 1900),
      point(8 * K, 27, 1800),
      point(16 * K, 25, 1700),
      point(32 * K, 22, 1500),
      point(64 * K - 144, 18, 1200, undefined, { decodeTpsEngine: stat(18.4), prefillTpsEngine: stat(1250) }),
    ],
    {
    tags: ['cpu-offload'],
      params: params({ extraArgs: ['--n-cpu-moe', '8'] }),
    },
  );
  const skipped = combo('q8_0', 64 * K, [], { outcome: 'skipped' });
  return {
    budget: 'fast',
    maxLaunches: 24,
    dimensions: [
      { key: 'kv', values: ['f16', 'q8_0', 'q4_0'] },
      { key: 'ubatch', values: [512, 2048] },
    ],
    capacity: [
      { kvType: 'f16', predictedMax: 26 * K, measuredMax: 24 * K, inferred: false },
      { kvType: 'q8_0', predictedMax: 40 * K, measuredMax: 32 * K, inferred: false },
      { kvType: 'q4_0', predictedMax: 72 * K, measuredMax: 64 * K, inferred: false },
    ],
    depths: [K, 4 * K, 8 * K, 16 * K, 32 * K, 64 * K],
    attempts: [
      attempt('reference', 'f16', 4 * K, 'ok', { points: [point(4 * K, 88, 8800)], vramPeakMiB: 18000, loadMs: 4000 }),
      attempt('capacity', 'f16', 32 * K, 'oom'),
      attempt('capacity', 'f16', 24 * K, 'ok', { vramPeakMiB: 30100 }),
      attempt('capacity', 'q8_0', 48 * K, 'spill', { spill: 'shared-memory', sharedPeakMiB: 2048, vramPeakMiB: 31800, points: [point(4 * K, 31, 2400)] }),
      attempt('capacity', 'q8_0', 40 * K, 'spill', { spill: 'decode-collapse' }),
      attempt('capacity', 'q8_0', 36 * K, 'spill', { spill: 'shared-memory' }),
      attempt('capacity', 'q4_0', 64 * K, 'ok'),
      attempt('variant', 'q4_0', 64 * K, 'ok', { screen: 'kept', params: params({ kvCacheType: 'q4_0', flashAttention: 'on', contextSize: 64 * K, ubatchSize: 2048, batchSize: 4096 }) }),
      attempt('variant', 'q4_0', 64 * K, 'ok', { screen: 'lost', params: params({ kvCacheType: 'q4_0', flashAttention: 'off', contextSize: 64 * K }), points: [point(4 * K, 70, 6000)] }),
      attempt('variant', 'q4_0', 64 * K, 'error', { error: { code: 'ENGINE_BAD_FLAG', message: 'bad flag' } }),
      attempt('offload', 'q8_0', 64 * K, 'error'),
    ],
    combinations: [f16, q8, q4ub, q4, offload, skipped],
    recommended: 2,
    fastestByDepth: [
      { depth: K, combination: 0 },
      { depth: 4 * K, combination: 0 },
      { depth: 8 * K, combination: 0 },
      { depth: 16 * K, combination: 0 },
      { depth: 32 * K, combination: 1 },
      { depth: 64 * K, combination: 2 },
    ],
    fidelity: { referenceKv: 'f16', comparedKv: 'q4_0', promptTokens: 2048, tokens: 128, identical: 87, firstDivergence: 88 },
  };
}

export const TUNE_ID = '01K70TUNE0000000000000000A';

/** The seeded full run of Qwen3 8B turned into a tune run (same model and engine, so its presets work). */
export function tunedRun(over: Partial<Tuning> = {}): RunResult {
  const base = seeded(IDS.full);
  return {
    ...base,
    id: TUNE_ID,
    createdAt: '2026-10-07T09:00:00.000Z',
    scenario: { profile: 'tune', seed: 42, steps: [{ kind: 'context-sweep', depths: [], fractions: false, outputTokens: 128, reps: 2 }] },
    tuning: { ...tuning(), ...over },
  };
}

export function users(level: number, over: Partial<ConcurrencyPoint> = {}): ConcurrencyPoint {
  return {
    level,
    requests: level * 4,
    aggregateTps: 50 * level * (1 - 0.05 * (level - 1)),
    perRequestDecodeTpsP50: 50 * (1 - 0.05 * (level - 1)),
    ttftP50Ms: 300 + 20 * level,
    ttftP95Ms: 340 + 25 * level,
    errors: 0,
    ...over,
  };
}
