import { afterEach, describe, expect, it } from 'vitest';
import type { GpuSample } from '../../../../src/contract/hardware';
import { BenchService } from '../../../../src/core/bench/service';
import { request, serviceSetup, TempDirs } from './service-helpers';

const tmp = new TempDirs();
afterEach(() => tmp.cleanup());

const sample = (usedMiB: number | null, totalMiB: number | null = 32607): GpuSample[] => [
  {
    t: 0,
    gpu: 0,
    utilPct: 1,
    memUsedMiB: usedMiB,
    memTotalMiB: totalMiB,
    powerW: 40,
    tempC: 40,
    smClockMHz: 200,
    memClockMHz: 400,
    pcieGen: 4,
    pcieWidth: 16,
    throttle: [],
  },
];

async function planWith(snapshot: () => Promise<GpuSample[]>, over: Parameters<typeof request>[0] = {}) {
  const s = serviceSetup(tmp, { adapter: { kind: 'vllm-docker' } });
  s.telemetry.snapshot = snapshot;
  const svc = new BenchService(s.deps);
  const plan = await svc.plan(request({ engine: { kind: 'vllm-docker' }, model: { repo: 'Qwen/Qwen3-0.6B' }, ...over }));
  return plan;
}

describe('vLLM memory reservation', () => {
  it('lowers gpu_memory_utilization to the free VRAM when other programs hold memory', async () => {
    const plan = await planWith(async () => sample(12064));
    expect(plan.warnings).toContainEqual({ code: 'gpu_memory_reduced', params: { utilization: 0.6, freeMiB: 20543, totalMiB: 32607 } });
  });

  it('keeps vLLM defaults when the GPU is free, unknown, or nearly full', async () => {
    const codes = async (snap: () => Promise<GpuSample[]>) => (await planWith(snap)).warnings.map((w) => w.code);
    expect(await codes(async () => sample(1600))).not.toContain('gpu_memory_reduced');
    expect(await codes(async () => [])).not.toContain('gpu_memory_reduced');
    expect(await codes(async () => sample(null))).not.toContain('gpu_memory_reduced');
    expect(await codes(async () => sample(1000, null))).not.toContain('gpu_memory_reduced');
    expect(await codes(() => Promise.reject(new Error('no driver')))).not.toContain('gpu_memory_reduced');
    expect(await codes(async () => sample(29000))).not.toContain('gpu_memory_reduced');
  });

  it('never overrides a value chosen by the user, and ignores llama.cpp', async () => {
    const chosen = await planWith(async () => sample(12064), { params: { gpuMemoryUtilization: 0.5, extraArgs: [], env: {} } });
    expect(chosen.warnings.map((w) => w.code)).not.toContain('gpu_memory_reduced');
    const llama = await planWith(async () => sample(12064), { engine: { kind: 'llamacpp-native' } });
    expect(llama.warnings.map((w) => w.code)).not.toContain('gpu_memory_reduced');
  });
});
