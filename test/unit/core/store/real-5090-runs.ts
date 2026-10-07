/**
 * The saved runs of the bug report, with its real numbers (RTX 5090 32 GB, Windows, llama.cpp b11460,
 * Qwen3.8-27B-UD-Q4_K_XL, 17.6 GB): a Rapido with -c 262144 -ctk f16 -ctv f16 -ngl all saved by GPU Bench
 * 0.3.0 (no shared-memory reading, no flag) that spilled; a clean q4_0 Rapido at the same context; a
 * "Trova le impostazioni migliori" whose reference launch generated 53.7 tok/s.
 */
import { launchParamsSchema, type LaunchParams } from '../../../../src/contract/engines';
import type { ModelFacts } from '../../../../src/contract/models';
import type { LatencyPoint, RunResult, TuneAttempt, TuneCombination } from '../../../../src/contract/results';
import { hardware, makeRun, modelIdentity, stat } from './fixtures';

/** 31,8 GB. */
export const GPU_TOTAL_MIB = 32_607;

/** A hybrid 27B: 16 of its 64 layers keep a KV cache (4 heads × 256), 64 MiB of f16 per 1K tokens. */
export const FACTS_27B: ModelFacts = {
  architecture: 'qwen35',
  contextLength: 262_144,
  blockCount: 64,
  fullAttentionLayers: 16,
  headCount: 24,
  headCountKv: 4,
  keyLength: 256,
  valueLength: 256,
  embeddingLength: 5120,
  feedForwardLength: 17_408,
  vocabSize: 248_320,
};

export const MODEL_27B = modelIdentity({
  displayName: 'Qwen3.8-27B-UD-Q4_K_XL',
  repo: 'unsloth/Qwen3.8-27B-GGUF',
  file: 'Qwen3.8-27B-UD-Q4_K_XL.gguf',
  files: ['Qwen3.8-27B-UD-Q4_K_XL.gguf'],
  quant: 'Q4_K_XL',
  sizeBytes: 17_600_000_000,
  weakKey: 'unsloth/qwen3.8-27b-gguf|Qwen3.8-27B-UD-Q4_K_XL.gguf|Q4_K_XL|17600000000',
  facts: FACTS_27B,
});

const P = (o: Partial<LaunchParams>) => launchParamsSchema.parse(o);

/** One prompt length: generation, prompt reading (tok/s) and time to the first token (ms). */
export function point(promptTokens: number, decode: number, prefill: number, ttftMs: number): LatencyPoint {
  return {
    promptTokens,
    outputTokens: 128,
    ttftMs: stat(ttftMs),
    prefillTps: stat(prefill),
    decodeTps: stat(decode),
    itlP50Ms: 1000 / decode,
    itlP95Ms: 1100 / decode,
    itlPerChunk: false,
    totalMs: stat(ttftMs + (128 * 1000) / decode),
  };
}

/** A Rapido of the 27B with these launch settings and numbers. */
function rapido(id: string, createdAt: string, kv: 'f16' | 'q4_0', p: LatencyPoint, vram: RunResult['metrics']['vram']): RunResult {
  const base = makeRun();
  const argv = ['llama-server', '-m', 'Qwen3.8-27B-UD-Q4_K_XL.gguf', '-c', '262144', '-ctk', kv, '-ctv', kv, '-fa', kv === 'f16' ? 'auto' : 'on', '-ngl', 'all'];
  return makeRun({
    id,
    createdAt,
    finishedAt: createdAt,
    hardware: hardware({ gpus: [{ ...hardware().gpus[0]!, memoryTotalMiB: GPU_TOTAL_MIB }] }),
    model: MODEL_27B,
    engine: { kind: 'llamacpp-native', name: 'llama.cpp', build: 'b11460', variant: 'CUDA 13.4' },
    launch: { ...base.launch, argv, params: P({ contextSize: 262_144, kvCacheType: kv, flashAttention: kv === 'f16' ? 'auto' : 'on' }) },
    metrics: { ...base.metrics, load: { coldMs: stat(9_900), warmMs: stat(9_900), phases: [] }, latency: [p], vram },
  });
}

/** Decode 3,5 tok/s, prefill 33, TTFT 15,8 s, 28,7 GB of 31,8 dedicated: it spilled, nothing in the file says so. */
export function legacySpill(): RunResult {
  return rapido('01K70LEGACY0SPILL000000000', '2026-10-05T21:10:00.000Z', 'f16', point(512, 3.5, 33, 15_800), {
    baselineMiB: 1600,
    peakMiB: 30_949,
    deltaMiB: 29_349,
    processPeakMiB: 29_349,
    method: 'process',
  });
}

/** The same test with the q4_0 cache, by a GPU Bench that reads the shared memory: 54,6 tok/s, prefill 2.244, 22,3 GB. */
export function cleanQ4(): RunResult {
  return rapido('01K70CLEAN0Q4000000000000', '2026-10-06T09:30:00.000Z', 'q4_0', point(512, 54.6, 2244, 240), {
    baselineMiB: 1600,
    peakMiB: 24_435,
    deltaMiB: 22_835,
    processPeakMiB: 22_835,
    sharedPeakMiB: 376,
    method: 'process',
  });
}

function attempt(stage: TuneAttempt['stage'], kv: 'f16' | 'q8_0', ctx: number, vramPeakMiB: number, sharedPeakMiB: number, points: LatencyPoint[]): TuneAttempt {
  return {
    stage,
    params: P({ contextSize: ctx, kvCacheType: kv, flashAttention: 'on' }),
    kvType: kv,
    contextSize: ctx,
    outcome: 'ok',
    vramPeakMiB,
    sharedPeakMiB,
    loadMs: 9_900,
    points,
    command: { argv: ['llama-server', '-c', String(ctx), '-ctk', kv, '-ctv', kv, '-ngl', 'all'], powershell: '', bash: '' },
  };
}

/** "Trova le impostazioni migliori" (Veloce): reference f16 at 4K (53,7 tok/s), f16 at 128K, q8_0 at 256K recommended. */
export function tuneRun(): RunResult {
  const sweep = [point(1024, 54.8, 1787, 600), point(131_072, 37.3, 1387, 94_000), point(262_144, 27.9, 875, 300_000)];
  const recommended: TuneCombination = {
    params: P({ contextSize: 262_144, kvCacheType: 'q8_0', flashAttention: 'on' }),
    kvType: 'q8_0',
    maxContext: 262_144,
    vramPeakMiB: 26_478,
    sweep,
    command: { argv: ['llama-server', '-c', '262144', '-ctk', 'q8_0', '-ctv', 'q8_0', '-ngl', 'all'], powershell: '', bash: '' },
    outcome: 'ok',
    tags: [],
  };
  const base = rapido('01K70TUNE0000000000000000', '2026-10-04T18:00:00.000Z', 'f16', point(512, 1, 1, 1), { sharedPeakMiB: 376 });
  return {
    ...base,
    scenario: { profile: 'tune', seed: 42, steps: [] },
    metrics: { ...base.metrics, latency: [], contextSweep: sweep, load: { phases: [] }, vram: { processPeakMiB: 26_478, sharedPeakMiB: 376, method: 'process' } },
    tuning: {
      budget: 'fast',
      maxLaunches: 24,
      dimensions: [],
      capacity: [],
      depths: [1024, 131_072, 262_144],
      attempts: [
        attempt('reference', 'f16', 4096, 16_796, 124, [point(256, 53.7, 1073, 240)]),
        attempt('capacity', 'f16', 131_072, 24_856, 248, [point(1024, 55.9, 1810, 570)]),
        attempt('capacity', 'q8_0', 262_144, 26_478, 376, [point(1024, 54.8, 1787, 580)]),
      ],
      combinations: [recommended],
      recommended: 0,
      fastestByDepth: [],
    },
  };
}
