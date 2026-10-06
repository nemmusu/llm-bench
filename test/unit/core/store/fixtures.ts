import { launchParamsSchema } from '../../../../src/contract/engines';
import type { HardwareFingerprint } from '../../../../src/contract/hardware';
import type { ModelIdentity } from '../../../../src/contract/models';
import type { LatencyPoint, RunResult, Stat } from '../../../../src/contract/results';
import { summarize } from '../../../../src/core/bench/stats';

export const stat = (...v: number[]): Stat => summarize(v);

export function hardware(over: Partial<HardwareFingerprint> = {}): HardwareFingerprint {
  return {
    hostId: 'host-a',
    hostLabel: 'PC A',
    gpus: [
      {
        index: 0,
        uuid: 'GPU-aaaa',
        name: 'NVIDIA GeForce RTX 5090',
        vendor: 'nvidia',
        memoryTotalMiB: 32607,
      },
    ],
    cpu: { model: 'Ryzen', cores: 16, threads: 32 },
    ramBytes: 64 * 1024 ** 3,
    os: { platform: 'win32', release: '10.0.26300', arch: 'x64', name: 'Windows 11 Pro', isWsl: false },
    ...over,
  };
}

export function modelIdentity(over: Partial<ModelIdentity> = {}): ModelIdentity {
  return {
    displayName: 'Qwen3 4B Q4_K_M',
    format: 'gguf',
    source: 'local',
    repo: 'Qwen/Qwen3-4B-GGUF',
    file: 'Qwen3-4B-Q4_K_M.gguf',
    files: ['Qwen3-4B-Q4_K_M.gguf'],
    quant: 'Q4_K_M',
    sizeBytes: 2_500_000_000,
    weakKey: 'qwen/qwen3-4b-gguf|Qwen3-4B-Q4_K_M.gguf|Q4_K_M|2500000000',
    ...over,
  };
}

export function latencyPoint(promptTokens: number, decode = 200, prefill = 8000): LatencyPoint {
  return {
    promptTokens,
    outputTokens: 128,
    ttftMs: stat(50, 52),
    prefillTps: stat(prefill),
    decodeTps: stat(decode),
    itlP50Ms: 5,
    itlP95Ms: 6,
    itlPerChunk: false,
    totalMs: stat(700),
  };
}

export function makeRun(over: Partial<RunResult> = {}): RunResult {
  return {
    schema: 1,
    id: '01K6Z0000000000000000000AA',
    app: { name: 'gpu-bench', version: '0.1.0' },
    createdAt: '2026-10-06T10:00:00.000Z',
    finishedAt: '2026-10-06T10:05:00.000Z',
    status: 'completed',
    notes: [],
    sharedGpu: [],
    scenario: { profile: 'quick', seed: 42, steps: [] },
    hardware: hardware(),
    model: modelIdentity(),
    engine: { kind: 'llamacpp-native', name: 'llama.cpp', build: 'b11438', variant: 'CUDA 13.4' },
    launch: {
      argv: ['llama-server', '-m', 'model.gguf'],
      env: {},
      display: { powershell: 'llama-server -m model.gguf', bash: 'llama-server -m model.gguf' },
      params: launchParamsSchema.parse({}),
      host: '127.0.0.1',
      port: 8080,
    },
    metrics: {
      formulaVersion: 1,
      load: { coldMs: stat(9000), warmMs: stat(1500), phases: [] },
      latency: [latencyPoint(512), latencyPoint(4096, 180, 12000)],
      concurrency: [],
      llamaBench: [],
      vram: { baselineMiB: 1600, peakMiB: 5600, deltaMiB: 4000 },
      energy: {},
      thermals: { throttleReasons: [] },
    },
    validity: [],
    logExcerpt: '',
    ...over,
  };
}
