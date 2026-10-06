import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gpuLiveAt, useMockGpuLive } from '../../../src/renderer/mock/gpu-live';
import { LIVE_SCHEDULE, LIVE_START_SEC, liveStateAt, useMockLiveRun } from '../../../src/renderer/mock/live';
import { findChoice, mockRecommended } from '../../../src/renderer/mock/models';
import { DEFAULT_EXPERT, parseEnv, previewCommand } from '../../../src/renderer/mock/plan';
import { jitter, round, seeded } from '../../../src/renderer/mock/random';
import { getMockRun, MOCK_RUN_ID, mockRunSummaries, sparkFor, stat } from '../../../src/renderer/mock/runs';
import { RTX5090_QWEN8B, simulate, toSeries } from '../../../src/renderer/mock/telemetry';

afterEach(() => {
  vi.useRealTimers();
});

describe('random', () => {
  it('is deterministic', () => {
    const a = seeded(1);
    const b = seeded(1);
    expect(a()).toBe(b());
    const v = jitter(seeded(2), 10, 1);
    expect(v).toBeGreaterThanOrEqual(9);
    expect(v).toBeLessThanOrEqual(11);
    expect(round(1.256, 2)).toBe(1.26);
    expect(round(1.25)).toBe(1.3);
  });
});

describe('stat', () => {
  it('computes median, spread and cv', () => {
    const s = stat([3, 1, 2, 4]);
    expect(s.median).toBe(2.5);
    expect(s.min).toBe(1);
    expect(s.max).toBe(4);
    expect(s.mean).toBe(2.5);
    expect(stat([5]).cv).toBe(0);
    expect(stat([0, 0, 0]).cv).toBe(0);
    expect(stat([1, 2, 9]).median).toBe(2);
  });
});

describe('telemetry simulation', () => {
  it('raises VRAM on load and power on decode', () => {
    const samples = simulate(LIVE_SCHEDULE, RTX5090_QWEN8B, 1, 3);
    const at = (t: number) => samples.find((s) => s.t === t)!;
    expect(at(2).memUsedMiB).toBeLessThan(4100);
    expect(at(150).memUsedMiB).toBeGreaterThan(11000);
    expect(at(150).powerW).toBeGreaterThan(380);
    expect(at(300).powerW).toBeGreaterThan(500);
    expect(at(347).memUsedMiB).toBeLessThan(4100);
    const series = toSeries(samples, LIVE_SCHEDULE, 1);
    expect(series.t.length).toBe(samples.length);
    expect(series.marks[0]).toEqual({ t: 0, label: 'prepare' });
  });
});

describe('runs', () => {
  it('builds the detailed result and variants for other ids', () => {
    const main = getMockRun(MOCK_RUN_ID);
    expect(main.metrics.latency).toHaveLength(6);
    expect(main.launch.display.powershell).toContain('--model');
    const other = mockRunSummaries.find((s) => s.modelName.startsWith('Gemma'))!;
    const g = getMockRun(other.id);
    expect(g.model.displayName).toBe('Gemma 4 31B');
    expect(g.metrics.latency[1]!.decodeTps.median).toBeLessThan(main.metrics.latency[1]!.decodeTps.median);
    const noScore = mockRunSummaries.find((s) => s.score === undefined && s.decodeTps === undefined)!;
    expect(getMockRun(noScore.id).metrics.score).toBeUndefined();
    expect(getMockRun('unknown').id).toBe('unknown');
    expect(sparkFor(mockRunSummaries[0]!)).toHaveLength(12);
    expect(sparkFor(noScore).every((v) => v === 0)).toBe(true);
  });
});

describe('live run', () => {
  it('walks through phases deterministically', () => {
    const start = liveStateAt('x', 0);
    expect(start.phase).toBe('prepare');
    expect(start.phaseStates.download).toBe('skipped');
    expect(start.live.decodeTps).toBe(0);
    expect(start.live.prefillTps).toBe(0);
    const prefill = liveStateAt('x', 70);
    expect(prefill.phase).toBe('prefill');
    expect(prefill.repetition.tokens).toBe(512);
    expect(liveStateAt('x', 100).repetition.tokens).toBe(4096);
    const mid = liveStateAt('x', LIVE_START_SEC);
    expect(mid.phase).toBe('decode');
    expect(mid.phaseStates.prefill).toBe('done');
    expect(mid.phaseStates.decode).toBe('current');
    expect(mid.phaseStates.cleanup).toBe('pending');
    expect(mid.live.decodeTps).toBeGreaterThan(180);
    expect(mid.log.some((l) => l.includes('tokens per second'))).toBe(true);
    const conc = liveStateAt('x', 300);
    expect(conc.phase).toBe('concurrency');
    expect(conc.repetition.n).toBe(1);
    const end = liveStateAt('x', 9999);
    expect(end.done).toBe(true);
    expect(end.phaseStates.cleanup).toBe('done');
    expect(end.etaSec).toBe(0);
    expect(liveStateAt('x', -5).elapsedSec).toBe(0);
  });

  it('ticks once per second', () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useMockLiveRun('r', 345));
    expect(result.current.elapsedSec).toBe(345);
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current.elapsedSec).toBe(348);
    unmount();
  });
});

describe('gpu live', () => {
  it('keeps a rolling window', () => {
    const w = gpuLiveAt(1000);
    expect(w.history).toHaveLength(180);
    expect(w.current.t).toBe(1000);
    expect(gpuLiveAt(1001).history[0]!.t).toBe(822);
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useMockGpuLive());
    act(() => vi.advanceTimersByTime(2000));
    expect(result.current.current.t).toBe(1002);
    unmount();
  });
});

describe('models', () => {
  it('finds choices with a fallback', () => {
    expect(findChoice('gemma4-31b-q4km').name).toBe('Gemma 4 31B');
    expect(findChoice(undefined)).toBe(mockRecommended[0]);
  });
});

describe('plan', () => {
  const model = mockRecommended[0]!;
  const remote = mockRecommended.find((m) => !m.local)!;

  it('parses env lines', () => {
    expect(parseEnv('A=1\n bad line\nB_2 = x y\n=no')).toEqual({ A: '1', B_2: 'x y' });
  });

  it('previews every engine', () => {
    const native = previewCommand('llamacpp-native', model, DEFAULT_EXPERT);
    expect(native.argv[0]).toContain('llama-server.exe');
    expect(native.argv).toContain('--flash-attn');
    const tuned = previewCommand('llamacpp-native', model, {
      ...DEFAULT_EXPERT,
      flashAttention: 'auto',
      kvCache: 'q8_0',
      threads: '16',
      executable: 'C:\\llama\\llama-server.exe',
      extraArgs: '--mlock\n--no-mmap',
      env: 'CUDA_VISIBLE_DEVICES=0',
    });
    expect(tuned.argv[0]).toBe('C:\\llama\\llama-server.exe');
    expect(tuned.argv).not.toContain('--flash-attn');
    expect(tuned.argv).toContain('--cache-type-k');
    expect(tuned.argv).toContain('--threads');
    expect(tuned.argv.slice(-2)).toEqual(['--mlock', '--no-mmap']);
    expect(tuned.powershell).toContain('$env:CUDA_VISIBLE_DEVICES');
    expect(previewCommand('llamacpp-docker', model, DEFAULT_EXPERT).argv).toContain('ghcr.io/ggml-org/llama.cpp:server-cuda');
    expect(previewCommand('llamacpp-docker', remote, { ...DEFAULT_EXPERT, image: 'my/img:1' }).argv).toContain('my/img:1');
    expect(previewCommand('vllm-docker', model, DEFAULT_EXPERT).argv).toContain('Qwen/Qwen3-8B');
    expect(previewCommand('vllm-docker', remote, { ...DEFAULT_EXPERT, image: 'v:1', ctx: '4096', parallel: '4' }).argv).toContain(remote.repo);
    expect(previewCommand('vllm-native', model, DEFAULT_EXPERT).argv[0]).toBe('vllm');
    expect(previewCommand('vllm-native', remote, DEFAULT_EXPERT).argv).toContain(remote.repo);
    expect(previewCommand('external', model, DEFAULT_EXPERT).argv[0]).toBe('curl');
    const unnamed = { ...model, file: undefined };
    expect(previewCommand('llamacpp-native', unnamed, DEFAULT_EXPERT).argv).toContain('C:\\models\\Qwen3-8B-Q4_K_M.gguf');
  });
});
