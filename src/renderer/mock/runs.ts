/**
 * Mock benchmark results. M1 wiring:
 *   mockRunSummaries → GET /api/runs
 *   getMockRun(id)   → GET /api/runs/:id
 */
import type { ConcurrencyPoint, LatencyPoint, RunResult, RunSummary, Stat } from '../../contract/results';
import { formatCommand } from '../lib/command';
import { mockGpu, mockSystem } from './system';
import { jitter, round, seeded } from './random';
import { RTX5090_QWEN8B, simulate, toSeries, type PhaseSpan } from './telemetry';

export const MOCK_RUN_ID = '01K6Y7Q2ZC4M8N3B5V9R1T0XWE';
export const MOCK_LIVE_RUN_ID = '01K6YB3H8F2D6S9K4P7M1Q5ZRA';
/** Fixed 'now' for relative dates so mock screens and screenshots never drift (M1: Date.now()). */
export const MOCK_NOW = Date.parse('2026-10-06T12:00:00Z');

/** Summary statistics in the same shape the core will produce. */
export function stat(values: number[]): Stat {
  const n = values.length;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(n / 2);
  const median = n % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const stddev = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  return { n, median, mean, min: sorted[0]!, max: sorted[n - 1]!, stddev, cv: mean ? stddev / mean : 0, values };
}

function reps(rand: () => number, center: number, cv: number, n: number, digits = 1): number[] {
  return Array.from({ length: n }, () => round(jitter(rand, center, center * cv * 1.7), digits));
}

/** Full-profile schedule (seconds) used for the result timeline. */
export const RESULT_SCHEDULE: PhaseSpan[] = [
  { phase: 'prepare', start: 0, end: 6 },
  { phase: 'cold-load', start: 6, end: 40, reps: 3 },
  { phase: 'warm-load', start: 40, end: 66, reps: 3 },
  { phase: 'prefill', start: 66, end: 318 },
  { phase: 'decode', start: 318, end: 612 },
  { phase: 'concurrency', start: 612, end: 896 },
  { phase: 'cleanup', start: 896, end: 908 },
];

const PROMPTS = [128, 512, 1024, 2048, 4096, 8192];
const PREFILL = [4130, 8960, 10340, 10890, 10420, 9300];
const DECODE = [193.1, 190.6, 188.7, 185.9, 179.8, 168.2];

const EXE = 'C:\\Users\\utente\\AppData\\Roaming\\GPU Bench\\engines\\llama.cpp\\b11438\\llama-server.exe';
export const MOCK_ARGV = [
  EXE,
  '--model',
  'C:\\models\\Qwen3-8B-Q4_K_M.gguf',
  '--host',
  '127.0.0.1',
  '--port',
  '41873',
  '--ctx-size',
  '8192',
  '--n-gpu-layers',
  '99',
  '--flash-attn',
  'on',
  '--batch-size',
  '2048',
  '--ubatch-size',
  '512',
  '--parallel',
  '1',
  '--fit',
  'off',
  '--no-webui',
  '--alias',
  'gpubench-3f9c2a',
];
const ENV = { CUDA_VISIBLE_DEVICES: '0' };

export const MOCK_LOG = [
  'ggml_cuda_init: found 1 CUDA devices:',
  '  Device 0: NVIDIA GeForce RTX 5090, compute capability 12.0, VMM: yes',
  'build: 11438 (7c3d1a9f) with MSVC 19.44 for x64',
  'system info: n_threads = 16, n_threads_batch = 16, total_threads = 32',
  'llama_model_loader: loaded meta data with 32 key-value pairs and 399 tensors from C:\\models\\Qwen3-8B-Q4_K_M.gguf',
  'print_info: file type   = Q4_K - Medium',
  'print_info: file size   = 4.68 GiB (4.91 BPW)',
  'load_tensors: offloading 36 repeating layers to GPU',
  'load_tensors: offloaded 37/37 layers to GPU',
  'load_tensors:        CUDA0 model buffer size =  4476.12 MiB',
  'llama_context: n_ctx         = 8192',
  'llama_context: flash_attn    = enabled',
  'llama_kv_cache:      CUDA0 KV buffer size =  1152.00 MiB',
  'llama_context:      CUDA0 compute buffer size =   304.75 MiB',
  'main: server is listening on http://127.0.0.1:41873 - starting the main loop',
  'srv  update_slots: all slots are idle',
  'slot launch_slot_: id  0 | task 112 | processing task',
  'slot update_slots: id  0 | task 112 | new prompt, n_ctx_slot = 8192, n_keep = 0, n_prompt_tokens = 512',
  'slot update_slots: id  0 | task 112 | prompt done, n_past = 512, n_tokens = 512',
  'slot print_timing: id  0 | task 112 |',
  'prompt eval time =      57.21 ms /   512 tokens (    0.11 ms per token,  8949.48 tokens per second)',
  '       eval time =    2681.02 ms /   511 tokens (    5.25 ms per token,   190.60 tokens per second)',
  '      total time =    2738.23 ms /  1023 tokens',
  'slot      release: id  0 | task 112 | stop processing: n_past = 1023, truncated = 0',
  'srv  update_slots: all slots are idle',
];

function buildResult(): RunResult {
  const rand = seeded(42);
  const latency: LatencyPoint[] = PROMPTS.map((p, i) => {
    const prefill = PREFILL[i]!;
    const decode = DECODE[i]!;
    const ttft = (p / prefill) * 1000;
    return {
      promptTokens: p,
      outputTokens: 512,
      ttftMs: stat(reps(rand, ttft, 0.012, 10)),
      prefillTps: stat(reps(rand, prefill, 0.009, 10, 0)),
      prefillTpsEngine: stat(reps(rand, prefill * 1.012, 0.006, 10, 0)),
      decodeTps: stat(reps(rand, decode, 0.004, 10)),
      decodeTpsEngine: stat(reps(rand, decode * 1.004, 0.003, 10)),
      itlP50Ms: round(1000 / decode, 2),
      itlP95Ms: round((1000 / decode) * 1.07, 2),
      itlPerChunk: false,
      totalMs: stat(reps(rand, ttft + (511 / decode) * 1000, 0.006, 10, 0)),
    };
  });
  const concurrency: ConcurrencyPoint[] = [
    { level: 1, requests: 8, aggregateTps: 190.2, perRequestDecodeTpsP50: 190.2, ttftP50Ms: 57, ttftP95Ms: 61, errors: 0 },
    { level: 2, requests: 16, aggregateTps: 352.8, perRequestDecodeTpsP50: 176.6, ttftP50Ms: 64, ttftP95Ms: 75, errors: 0 },
    { level: 4, requests: 32, aggregateTps: 641.5, perRequestDecodeTpsP50: 160.4, ttftP50Ms: 88, ttftP95Ms: 109, errors: 0 },
    { level: 8, requests: 64, aggregateTps: 1092.4, perRequestDecodeTpsP50: 136.6, ttftP50Ms: 141, ttftP95Ms: 188, errors: 0 },
    { level: 16, requests: 128, aggregateTps: 1638.9, perRequestDecodeTpsP50: 102.4, ttftP50Ms: 246, ttftP95Ms: 338, errors: 0 },
  ];
  const samples = simulate(RESULT_SCHEDULE, RTX5090_QWEN8B, 2, 11);
  return {
    schema: 1,
    id: MOCK_RUN_ID,
    app: { name: 'gpu-bench', version: '0.1.0' },
    createdAt: '2026-10-06T10:42:00.000Z',
    finishedAt: '2026-10-06T10:57:08.000Z',
    status: 'completed',
    notes: [],
    sharedGpu: [{ pid: 18244, name: 'llama-server.exe', memMiB: 2355, kind: 'llm' }],
    scenario: {
      profile: 'full',
      seed: 42,
      steps: [
        { kind: 'load', cache: 'cold', reps: 3 },
        { kind: 'load', cache: 'warm', reps: 3 },
        { kind: 'latency', promptTokens: PROMPTS, outputTokens: 512, warmup: 2, reps: 10 },
        { kind: 'concurrency', levels: [1, 2, 4, 8, 16], promptTokens: 512, outputTokens: 256, requestsPerWorker: 8 },
        { kind: 'llama-bench', pp: 512, tg: 128, reps: 5 },
      ],
    },
    hardware: {
      hostId: 'a1f4c9e27b',
      hostLabel: mockSystem.hostLabel,
      gpus: [mockGpu],
      cpu: mockSystem.cpu,
      ramBytes: mockSystem.ramBytes,
      os: mockSystem.os,
    },
    model: {
      displayName: 'Qwen3 8B',
      format: 'gguf',
      source: 'local',
      file: 'Qwen3-8B-Q4_K_M.gguf',
      files: ['Qwen3-8B-Q4_K_M.gguf'],
      quant: 'Q4_K_M',
      sizeBytes: 5027783488,
      sha256: 'd98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785',
      weakKey: 'Qwen3-8B-Q4_K_M.gguf|Q4_K_M|5027783488',
      path: 'C:\\models\\Qwen3-8B-Q4_K_M.gguf',
      facts: { architecture: 'qwen3', paramsB: 8.19, quant: 'Q4_K_M', contextLength: 40960, blockCount: 36 },
    },
    engine: {
      kind: 'llamacpp-native',
      name: 'llama.cpp',
      version: 'b11438',
      build: 'b11438',
      variant: 'CUDA 13.4',
      executable: EXE,
    },
    launch: {
      argv: MOCK_ARGV,
      env: ENV,
      cwd: 'C:\\Users\\utente\\AppData\\Roaming\\GPU Bench\\engines\\llama.cpp\\b11438',
      display: { powershell: formatCommand(MOCK_ARGV, 'powershell', ENV), bash: formatCommand(MOCK_ARGV, 'bash', ENV) },
      params: {
        contextSize: 8192,
        gpuLayers: 99,
        flashAttention: 'on',
        kvCacheType: 'f16',
        batchSize: 2048,
        ubatchSize: 512,
        parallel: 1,
        extraArgs: [],
        env: {},
      },
      host: '127.0.0.1',
      port: 41873,
      requestExample: {
        prompt: [151643, 785, 3974, 13876, 38835, '…'],
        n_predict: 512,
        ignore_eos: true,
        temperature: 0,
        seed: 42,
        cache_prompt: false,
        stream: true,
        return_tokens: true,
      },
    },
    metrics: {
      formulaVersion: 1,
      load: {
        coldMs: stat([6712, 6804, 6951]),
        warmMs: stat([2068, 2104, 2139]),
        coldReadBytesPerSec: 1.19e9,
        phases: [
          { name: 'load_tensors', startMs: 140, endMs: 4370 },
          { name: 'context', startMs: 4370, endMs: 5210 },
          { name: 'warmup', startMs: 5210, endMs: 6804 },
        ],
      },
      firstTokenAfterLoadMs: 142,
      latency,
      concurrency,
      llamaBench: [
        { test: 'pp512', tps: 10120.4, stddev: 85.2 },
        { test: 'tg128', tps: 196.4, stddev: 0.6 },
      ],
      vram: { baselineMiB: 3993, peakMiB: 11263, deltaMiB: 7270, estimateMiB: 6890 },
      energy: { avgPowerW: 421, maxPowerW: 556, tokensPerJoule: 0.45 },
      thermals: { maxTempC: 68, throttleReasons: [] },
      score: { value: 1012, referenceVersion: 1 },
    },
    validity: ['gpu_shared', 'cold_not_guaranteed'],
    telemetry: toSeries(samples, RESULT_SCHEDULE, 2),
    logExcerpt: MOCK_LOG.join('\n'),
  };
}

let cached: RunResult | undefined;

/** The detailed mock result; other ids reuse it with the summary's model and speeds. */
export function getMockRun(id: string): RunResult {
  cached ??= buildResult();
  const summary = mockRunSummaries.find((s) => s.id === id);
  if (!summary || summary.id === MOCK_RUN_ID) return { ...cached, id };
  const k = (summary.decodeTps ?? 190.6) / 190.6;
  return {
    ...cached,
    id,
    createdAt: summary.createdAt,
    status: summary.status,
    model: { ...cached.model, displayName: summary.modelName, quant: summary.quant },
    metrics: {
      ...cached.metrics,
      latency: cached.metrics.latency.map((p) => ({
        ...p,
        decodeTps: { ...p.decodeTps, median: p.decodeTps.median * k },
        prefillTps: { ...p.prefillTps, median: p.prefillTps.median * k },
      })),
      ...(summary.score === undefined ? { score: undefined } : { score: { value: summary.score, referenceVersion: 1 } }),
    },
    validity: summary.validity,
  };
}

const base = { hostId: 'a1f4c9e27b', hostLabel: 'WORKSTATION', gpuName: 'NVIDIA GeForce RTX 5090', gpuUuid: mockGpu.uuid };

export const mockRunSummaries: RunSummary[] = [
  {
    ...base,
    id: MOCK_RUN_ID,
    createdAt: '2026-10-06T10:42:00.000Z',
    status: 'completed',
    profile: 'full',
    modelName: 'Qwen3 8B',
    modelWeakKey: 'Qwen3-8B-Q4_K_M.gguf|Q4_K_M|5027783488',
    quant: 'Q4_K_M',
    engineKind: 'llamacpp-native',
    engineLabel: 'llama.cpp b11438',
    decodeTps: 190.6,
    prefillTps: 8960,
    ttftMs: 57,
    coldLoadMs: 6804,
    warmLoadMs: 2104,
    vramPeakMiB: 7270,
    score: 1012,
    validity: ['gpu_shared', 'cold_not_guaranteed'],
    file: 'runs/01K6Y7Q2ZC4M8N3B5V9R1T0XWE.json',
  },
  {
    ...base,
    id: '01K6WQ8D3N7B2X5C9V4M6K1JHT',
    createdAt: '2026-10-05T18:10:00.000Z',
    status: 'completed',
    profile: 'standard',
    modelName: 'Gemma 4 31B',
    modelWeakKey: 'gemma-4-31B-it-Q4_K_M.gguf|Q4_K_M',
    quant: 'Q4_K_M',
    engineKind: 'llamacpp-native',
    engineLabel: 'llama.cpp b11438',
    decodeTps: 58.3,
    prefillTps: 2410,
    ttftMs: 212,
    coldLoadMs: 21400,
    warmLoadMs: 6900,
    vramPeakMiB: 21800,
    score: 486,
    validity: [],
    file: 'runs/01K6WQ8D3N7B2X5C9V4M6K1JHT.json',
  },
  {
    ...base,
    id: '01K6WJ2F6R9T3Y8U1I4O7P5ASD',
    createdAt: '2026-10-05T16:02:00.000Z',
    status: 'completed',
    profile: 'standard',
    modelName: 'Qwen3 30B A3B',
    modelWeakKey: 'Qwen3-30B-A3B-Q4_K_M.gguf|Q4_K_M',
    quant: 'Q4_K_M',
    engineKind: 'llamacpp-native',
    engineLabel: 'llama.cpp b11438',
    decodeTps: 214.2,
    prefillTps: 6120,
    ttftMs: 84,
    coldLoadMs: 19800,
    warmLoadMs: 5200,
    vramPeakMiB: 19600,
    score: 1104,
    validity: [],
    file: 'runs/01K6WJ2F6R9T3Y8U1I4O7P5ASD.json',
  },
  {
    ...base,
    id: '01K6TZ5G1H4J7K2L8Z3X6C9VBN',
    createdAt: '2026-10-04T21:30:00.000Z',
    status: 'completed',
    profile: 'standard',
    modelName: 'Qwen3 8B',
    modelWeakKey: 'Qwen/Qwen3-8B-FP8@main',
    quant: 'FP8',
    engineKind: 'vllm-docker',
    engineLabel: 'vLLM v0.12.0',
    decodeTps: 168.4,
    prefillTps: 12850,
    ttftMs: 40,
    coldLoadMs: 48200,
    warmLoadMs: 31800,
    vramPeakMiB: 29100,
    validity: ['vram_approximate'],
    file: 'runs/01K6TZ5G1H4J7K2L8Z3X6C9VBN.json',
  },
  {
    ...base,
    id: '01K6TX9Q2W5E8R1T4Y7U3I6OPA',
    createdAt: '2026-10-04T20:55:00.000Z',
    status: 'completed',
    profile: 'quick',
    modelName: 'Mistral Small 3.2 24B',
    modelWeakKey: 'Mistral-Small-3.2-24B-Instruct-Q4_K_M.gguf|Q4_K_M',
    quant: 'Q4_K_M',
    engineKind: 'llamacpp-native',
    engineLabel: 'llama.cpp b11438',
    decodeTps: 74.9,
    prefillTps: 3300,
    ttftMs: 155,
    warmLoadMs: 4800,
    vramPeakMiB: 15700,
    validity: [],
    file: 'runs/01K6TX9Q2W5E8R1T4Y7U3I6OPA.json',
  },
  {
    ...base,
    id: '01K6QH3B6N9M2Q5W8E1R4T7YUI',
    createdAt: '2026-10-03T09:12:00.000Z',
    status: 'completed',
    profile: 'standard',
    modelName: 'gpt-oss 20B',
    modelWeakKey: 'gpt-oss-20b-mxfp4.gguf|MXFP4',
    quant: 'MXFP4',
    engineKind: 'llamacpp-native',
    engineLabel: 'llama.cpp b11402',
    decodeTps: 261.7,
    prefillTps: 7900,
    ttftMs: 65,
    coldLoadMs: 12600,
    warmLoadMs: 3400,
    vramPeakMiB: 13400,
    score: 1188,
    validity: [],
    file: 'runs/01K6QH3B6N9M2Q5W8E1R4T7YUI.json',
  },
  {
    id: '01K6NE7R4T1Y8U5I2O9P6A3SDF',
    createdAt: '2026-10-02T22:40:00.000Z',
    status: 'completed',
    profile: 'standard',
    modelName: 'Qwen3 8B',
    modelWeakKey: 'Qwen3-8B-Q4_K_M.gguf|Q4_K_M|5027783488',
    quant: 'Q4_K_M',
    engineKind: 'llamacpp-native',
    engineLabel: 'llama.cpp b11402',
    gpuName: 'NVIDIA GeForce RTX 3070',
    gpuUuid: 'GPU-2b7e0c41-9f3a-4d18-b6e5-8a1c3f0d9e72',
    hostId: '7c2e9b0f14',
    hostLabel: 'SERVER-3070',
    decodeTps: 88.2,
    prefillTps: 3150,
    ttftMs: 163,
    coldLoadMs: 9100,
    warmLoadMs: 2900,
    vramPeakMiB: 6900,
    score: 412,
    validity: ['throttling'],
    file: 'runs/01K6NE7R4T1Y8U5I2O9P6A3SDF.json',
  },
  {
    ...base,
    id: '01K6NA2S5D8F1G4H7J3K6L9ZXC',
    createdAt: '2026-10-02T19:05:00.000Z',
    status: 'failed',
    profile: 'quick',
    modelName: 'Llama 3.3 70B Instruct',
    modelWeakKey: 'Llama-3.3-70B-Instruct-Q4_K_M.gguf|Q4_K_M',
    quant: 'Q4_K_M',
    engineKind: 'llamacpp-native',
    engineLabel: 'llama.cpp b11402',
    validity: [],
    file: 'runs/01K6NA2S5D8F1G4H7J3K6L9ZXC.json',
  },
  {
    ...base,
    id: '01K6KZ8V1B4N7M2Q5W9E3R6TYU',
    createdAt: '2026-10-01T15:20:00.000Z',
    status: 'cancelled',
    profile: 'standard',
    modelName: 'Qwen3 14B',
    modelWeakKey: 'Qwen3-14B-Q4_K_M.gguf|Q4_K_M',
    quant: 'Q4_K_M',
    engineKind: 'llamacpp-native',
    engineLabel: 'llama.cpp b11402',
    decodeTps: 112.5,
    validity: [],
    file: 'runs/01K6KZ8V1B4N7M2Q5W9E3R6TYU.json',
  },
];

/** Recent decode speeds per run, for list sparklines (repetition values). */
export function sparkFor(summary: RunSummary): number[] {
  const rand = seeded(summary.id.charCodeAt(4) * 31 + summary.id.charCodeAt(9));
  const center = summary.decodeTps ?? 0;
  return Array.from({ length: 12 }, () => round(jitter(rand, center, center * 0.01), 1));
}
