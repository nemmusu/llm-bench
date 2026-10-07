import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { RunPlan, StartRunRequest } from '../../../../src/contract/api';
import type { EngineStatus } from '../../../../src/contract/engines';
import type { LocalModel } from '../../../../src/contract/models';
import type { RunResult, RunSummary } from '../../../../src/contract/results';
import type { CuratedModel } from '../../../../src/contract/views';
import { alignPairs, concurrencyPairs, decodePairs, pairBarsOption, pairLinesOption } from '../../../../src/renderer/components/bench/compare-charts';
import { diffRows, metricRows } from '../../../../src/renderer/components/bench/compare-rows';
import { deltaView, relativeChange } from '../../../../src/renderer/components/bench/delta';
import { EMPTY_ENGINE_FORM, engineConfigOf, engineFormOf, isHttpUrl, savableEngine } from '../../../../src/renderer/components/bench/engine-form';
import {
  DEFAULT_SCENARIO_FORM,
  EMPTY_PARAMS_FORM,
  formFromParams,
  formFromScenario,
  hasCustomParams,
  parseArgs,
  parseEnv,
  parseInteger,
  parseList,
  parseUsers,
  showUsers,
  parseRatio,
  paramsFromForm,
  scenarioFromForm,
} from '../../../../src/renderer/components/bench/expert-form';
import {
  countKey,
  engineLabelOf,
  headlinePoint,
  isManagedExecutable,
  modelLabelOf,
  peakConcurrency,
  prettyEngineLabel,
  prettyVariant,
  shortGpuName,
  slug,
  summaryModelLabel,
  vramFigure,
} from '../../../../src/renderer/components/bench/format';
import { ALL, decodeHistory, distinct, filterRuns, NO_FILTERS } from '../../../../src/renderer/components/bench/history';
import { kpisOf, sentenceKey } from '../../../../src/renderer/components/bench/kpis';
import { initialLive, liveReducer, MAX_LOG_LINES } from '../../../../src/renderer/components/bench/live-state';
import { engineFamily, initialModelKey, modelOptions, requestModel, savedModelId, triedOn } from '../../../../src/renderer/components/bench/model-options';
import { guessNeeds, needsFromPlan } from '../../../../src/renderer/components/bench/needs';
import { noteText } from '../../../../src/renderer/components/bench/notes';
import { detailLine, displayPhase, phaseBands, phaseStates, relevantPhases, remainingSeconds } from '../../../../src/renderer/components/bench/phases';
import { findLocalModel, rerunOf } from '../../../../src/renderer/components/bench/rerun';
import { readRunContext, saveDraft, saveRunContext, takeDraft } from '../../../../src/renderer/components/bench/run-context';
import { launchSummaryParts, paramParts, scenarioLines } from '../../../../src/renderer/components/bench/summary';
import { sharedGpuList, validityBody } from '../../../../src/renderer/components/bench/validity';
import { readChartTokens } from '../../../../src/renderer/components/charts/echarts';
import { createFormatters } from '../../../../src/renderer/i18n';
import { HOST_ID, IDS, seeded, summaries } from './fixtures';

const it_ = createFormatters('it');
const en = createFormatters('en');

function local(id: string, over: Partial<LocalModel['identity']> = {}): LocalModel {
  return {
    id,
    identity: { displayName: `Model ${id}`, format: 'gguf', source: 'local', files: [], weakKey: `wk-${id}`, ...over },
    paths: [`C:\\models\\${id}.gguf`],
    auxiliary: [],
    dir: 'C:\\models',
    origin: 'library',
    modifiedAt: '2026-10-01T00:00:00.000Z',
  };
}

function curated(id: string, over: Partial<CuratedModel> = {}): CuratedModel {
  return {
    id,
    label: `Curated ${id} · Q4_K_M`,
    engine: 'llamacpp',
    tier: 8,
    repo: `org/${id}-GGUF`,
    file: `${id}.gguf`,
    revision: 'a'.repeat(40),
    sizeBytes: 1000,
    quant: 'Q4_K_M',
    paramsB: 4,
    license: 'mit',
    ...over,
  } as CuratedModel;
}

describe('format', () => {
  it('labels engines, models and GPUs', () => {
    expect(prettyVariant('cuda-13.4')).toBe('CUDA 13.4');
    expect(prettyVariant('cpu')).toBe('CPU');
    expect(prettyVariant('metal')).toBe('metal');
    expect(engineLabelOf({ name: 'llama.cpp', build: 'b1', variant: 'cuda_12' })).toBe('llama.cpp b1 (CUDA 12)');
    expect(engineLabelOf({ name: 'vLLM', version: 'v1' })).toBe('vLLM v1');
    expect(engineLabelOf({ name: 'External' })).toBe('External');
    expect(modelLabelOf({ displayName: 'Qwen3-0.6B-Q4_K_M', quant: 'Q4_K_M' })).toBe('Qwen3-0.6B-Q4_K_M');
    expect(modelLabelOf({ displayName: 'Qwen3 8B', quant: 'Q4_K_M' })).toBe('Qwen3 8B · Q4_K_M');
    expect(modelLabelOf({ displayName: 'x' })).toBe('x');
    expect(summaryModelLabel({ modelName: 'Gemma', quant: 'Q8_0' })).toBe('Gemma · Q8_0');
    expect(prettyEngineLabel('llama.cpp b1 (cuda-13.4)')).toBe('llama.cpp b1 (CUDA 13.4)');
    expect(prettyEngineLabel('vLLM v1')).toBe('vLLM v1');
    expect(shortGpuName('NVIDIA GeForce RTX 5090')).toBe('RTX 5090');
    expect(shortGpuName('NVIDIA RTX A6000')).toBe('RTX A6000');
  });

  it('knows managed executables and slugs', () => {
    expect(isManagedExecutable('C:\\Data\\engines\\llamacpp\\b1\\llama-server.exe', 'c:\\data\\engines\\')).toBe(true);
    expect(isManagedExecutable('C:\\llama\\llama-server.exe', 'C:\\Data\\engines')).toBe(false);
    expect(isManagedExecutable('x', undefined)).toBe(false);
    expect(slug('Qwen3 8B · Q4_K_M (è)')).toBe('Qwen3-8B-Q4_K_M-e');
    expect(slug('···')).toBe('run');
    expect(countKey(1, 'one', 'other')).toBe('one');
    expect(countKey(2, 'one', 'other')).toBe('other');
  });

  it('picks headline numbers', () => {
    const run = seeded(IDS.full);
    expect(headlinePoint(run.metrics.latency)?.promptTokens).toBe(512);
    expect(headlinePoint([run.metrics.latency[0]!])?.promptTokens).toBe(128);
    expect(headlinePoint([])).toBeUndefined();
    expect(vramFigure({ method: 'process', processPeakMiB: 10, deltaMiB: 20 })).toEqual({ mib: 10, approximate: false });
    expect(vramFigure({ method: 'process', deltaMiB: 20 })).toEqual({ mib: 20, approximate: true });
    expect(vramFigure({ peakMiB: 30 })).toEqual({ mib: 30, approximate: true });
    expect(vramFigure({})).toBeUndefined();
    expect(peakConcurrency(run)?.level).toBe(16);
    expect(peakConcurrency(seeded(IDS.quick))).toBeUndefined();
  });
});

describe('phases', () => {
  const standard = seeded(IDS.gemma).scenario;
  it('lists the phases a scenario goes through', () => {
    expect(relevantPhases(standard)).toEqual(['prepare', 'cold-load', 'warm-load', 'prefill', 'decode', 'concurrency', 'cleanup']);
    expect(relevantPhases(seeded(IDS.full).scenario, { install: true, download: true })).toEqual([
      'install',
      'download',
      'prepare',
      'cold-load',
      'warm-load',
      'prefill',
      'decode',
      'concurrency',
      'llama-bench',
      'cleanup',
    ]);
    expect(relevantPhases(undefined)).toHaveLength(8);
    expect(relevantPhases({ profile: 'custom', seed: 1, steps: [{ kind: 'latency', promptTokens: [4096], outputTokens: 8, warmup: 0, reps: 1 }] })).toEqual([
      'prepare',
      'prefill',
      'cleanup',
    ]);
  });

  it('computes states, details and the time left', () => {
    expect(displayPhase('decode', 'llama-bench')).toBe('llama-bench');
    expect(displayPhase('decode', '512')).toBe('decode');
    const states = phaseStates(['install', 'prepare', 'decode', 'cleanup'], 'decode');
    expect(states).toEqual({ install: 'done', prepare: 'done', decode: 'current', cleanup: 'pending' });
    expect(phaseStates(['prepare'], 'concurrency').prepare).toBe('pending');
    expect(detailLine('cold-load', '2', standard)).toEqual({ key: 'run.detail.loadRep', params: { n: 2, total: 1 } });
    expect(detailLine('warm-load', '2', standard)).toEqual({ key: 'run.detail.loadRep', params: { n: 2, total: 3 } });
    expect(detailLine('warm-load', '2', undefined)).toEqual({ key: 'run.detail.loadRep', params: { n: 2, total: 2 } });
    expect(detailLine('prefill', '4096', standard)).toEqual({ key: 'run.detail.prompt', params: { tokens: 4096 } });
    expect(detailLine('concurrency', '4', standard)).toEqual({ key: 'run.detail.users', params: { n: 4 } });
    expect(detailLine('cleanup', '1', standard)).toBeUndefined();
    expect(detailLine('decode', 'llama-bench', standard)).toBeUndefined();
    expect(detailLine('decode', undefined, standard)).toBeUndefined();
    expect(remainingSeconds(10, 1)).toBe(0);
    expect(remainingSeconds(10, 0.5, 100)).toBe(90);
    expect(remainingSeconds(5, 0.05)).toBeUndefined();
    expect(remainingSeconds(5, 0.5)).toBeUndefined();
    expect(remainingSeconds(20, 0.5, 10)).toBe(20);
  });

  it('turns phase marks into bands', () => {
    expect(
      phaseBands(
        [
          { t: 0, label: 'prepare' },
          { t: 1, label: 'warm-load' },
          { t: 1, label: 'warm-load 1' },
          { t: 2, label: 'ready' },
          { t: 3, label: 'decode' },
          { t: 3.5, label: 'decode' },
        ],
        10,
      ),
    ).toEqual([
      { phase: 'prepare', start: 0, end: 1 },
      { phase: 'warm-load', start: 1, end: 3 },
      { phase: 'decode', start: 3, end: 10 },
    ]);
    expect(phaseBands([{ t: 5, label: 'cleanup' }], 2)).toEqual([{ phase: 'cleanup', start: 5, end: 5 }]);
  });
});

describe('delta', () => {
  it('says how much better or worse', () => {
    expect(relativeChange(undefined, 1)).toBeUndefined();
    expect(relativeChange(1, undefined)).toBeUndefined();
    expect(relativeChange(0, 1)).toBeUndefined();
    expect(relativeChange(100, 123)).toBeCloseTo(0.23);
    expect(deltaView(100, 123, true, it_.percent)).toMatchObject({ text: '+23%', direction: 'up', good: true });
    expect(deltaView(100, 95, true, it_.percent)).toMatchObject({ text: '−5%', direction: 'down', good: false });
    expect(deltaView(100, 95, false, it_.percent)).toMatchObject({ good: true });
    expect(deltaView(100, 100.2, true, it_.percent)).toMatchObject({ direction: 'same' });
    expect(deltaView(undefined, 1, true, it_.percent)).toBeUndefined();
  });
});

describe('notes', () => {
  it('localizes every planning code', () => {
    expect(noteText({ code: 'prompt_too_long', params: { promptTokens: 32768, contextSize: 8192 } }, it_)).toMatchObject({
      tone: 'info',
      body: expect.stringContaining('32.768') as string,
    });
    expect(noteText({ code: 'MODEL_TOO_LARGE', params: { needMiB: 40960, availableMiB: 30720 } }, it_).body).toContain('40,0 GB');
    expect(noteText({ code: 'gpu_memory_reduced', params: { utilization: 0.84, freeMiB: 28650, totalMiB: 32607 } }, it_).body).toContain('84%');
    expect(noteText({ code: 'VRAM_BUSY', params: { names: 'llama-server.exe', pids: '4242' } }, it_).body).toContain('PID 4242');
    expect(noteText({ code: 'VRAM_BUSY', params: { names: 'x', pids: '1', freeMiB: 1024, needMiB: 2048 } }, it_).title).toBe('Non c’è abbastanza memoria video libera');
    expect(noteText({ code: 'partial_offload', params: { maxGpuLayers: null } }, it_).body).toContain('–');
    expect(noteText({ code: 'llama_bench_unsupported' }, en).title).toBe('llama-bench not available');
    expect(noteText({ code: 'something_new' }, it_)).toMatchObject({ tone: 'info', body: 'Il motore ha segnalato: something_new.' });
  });
});

describe('summary', () => {
  it('describes how a run was started', () => {
    expect(launchSummaryParts(seeded(IDS.full), it_)).toEqual([
      'llama.cpp b11438 (CUDA 13.4)',
      'Qwen3 8B · Q4_K_M',
      'contesto 8192',
      'tutto in GPU',
      // -b 2048 -ub 512 are llama.cpp's defaults: not worth a word.
      'flash attention',
    ]);
    expect(launchSummaryParts(seeded(IDS.vllm), it_)[0]).toBe('vLLM v0.12.0 (CUDA) · Docker');
    const p = { extraArgs: ['--metrics'], env: { A: '1' } };
    expect(paramParts('llamacpp-native', { ...p, gpuLayers: 0, flashAttention: 'off', kvCacheType: 'q8_0', threads: 8, ubatchSize: 256, parallel: 4 }, 36, en)).toEqual([
      'KV cache q8_0',
      'CPU only',
      'no flash attention',
      'ub 256',
      '4 parallel slots',
      'context shared by the users',
      '8 threads',
      'extra arguments: --metrics',
      '1 environment variables',
    ]);
    // The layout follows the extra arguments too (GPU Bench adds --kv-unified unless they say otherwise).
    expect(paramParts('llamacpp-native', { extraArgs: ['--no-kv-unified'], env: {}, parallel: 4 }, 36, it_)).toContain('contesto diviso per utente');
    expect(paramParts('llamacpp-docker', { extraArgs: [], env: {}, gpuLayers: 20 }, 36, it_)).toEqual(['20 livelli in GPU']);
    expect(paramParts('llamacpp-docker', { extraArgs: [], env: {}, gpuLayers: 99 }, 36, it_)).toEqual(['tutto in GPU']);
    expect(paramParts('vllm-native', { extraArgs: [], env: {}, maxModelLen: 4096, gpuMemoryUtilization: 0.8, dtype: 'bfloat16', quantization: 'fp8', kvCacheType: 'auto' }, undefined, it_)).toEqual([
      'contesto 4096',
      'memoria GPU 80%',
      'bfloat16',
      'fp8',
    ]);
  });

  it('describes a test plan', () => {
    expect(scenarioLines(seeded(IDS.full).scenario, it_)).toEqual([
      '3 caricamenti a freddo',
      '3 caricamenti a caldo',
      'prompt da 128, 512, 1024, 2048, 4096 e 8192 token, 512 token generati, 10 ripetizioni',
      '1, 2, 4, 8 e 16 utenti insieme, prompt da 512 token e 256 generati ciascuno',
      'test standard llama-bench',
    ]);
    expect(scenarioLines({ profile: 'custom', seed: 1, steps: [{ kind: 'load', cache: 'cold', reps: 1 }, { kind: 'load', cache: 'warm', reps: 1 }] }, en)).toEqual(['1 cold load', '1 warm load']);
    // Every step up to the busiest reads as a range; two levels stay a list.
    const users = (levels: number[]) => scenarioLines({ profile: 'custom', seed: 1, steps: [{ kind: 'concurrency', levels, promptTokens: 512, outputTokens: 128, requestsPerWorker: 4 }] }, it_);
    expect(users([1, 2, 3, 4])).toEqual(['da 1 a 4 utenti insieme, uno in più alla volta, prompt da 512 token e 128 generati ciascuno']);
    expect(users([1, 2])).toEqual(['1 e 2 utenti insieme, prompt da 512 token e 128 generati ciascuno']);
  });
});

describe('kpis and validity', () => {
  it('reads the headline numbers', () => {
    const k = kpisOf(seeded(IDS.full));
    expect(k.promptTokens).toBe(512);
    expect(k.score).toBe(1012);
    expect(k.vram?.approximate).toBe(false);
    expect(k.concurrency?.level).toBe(16);
    expect(kpisOf(seeded(IDS.failed))).toEqual({ vram: { mib: 31800, approximate: true }, vramEstimateMiB: 30210 });
    expect(sentenceKey(100)).toBe('result.sentence');
    expect(sentenceKey(5)).toBe('result.sentenceSlow');
  });

  it('explains validity flags with the processes that shared the GPU', () => {
    const run = seeded(IDS.full);
    expect(validityBody(run, 'gpu_shared', it_)).toContain('llama-server.exe (PID 18244, 2,3 GB)');
    expect(sharedGpuList({ sharedGpu: [{ pid: 1, name: 'vmmem' }] }, en)).toBe('vmmem (PID 1)');
    expect(validityBody({ sharedGpu: [] }, 'gpu_shared', it_)).toContain('altri programmi occupavano memoria video');
    expect(validityBody(run, 'throttling', en)).toContain('lowered its clock');
  });
});

describe('history and filters', () => {
  const list = summaries();
  it('builds the speed history of a model on a GPU', () => {
    const a = list.find((r) => r.id === IDS.full)!;
    expect(decodeHistory(a, list)).toHaveLength(1);
    const older = { ...a, id: 'older', createdAt: '2026-01-01T00:00:00.000Z', decodeTps: 100 };
    const failed: RunSummary = { ...a, id: 'f', status: 'failed' };
    expect(decodeHistory(a, [...list, older, failed])).toEqual([100, a.decodeTps]);
    expect(decodeHistory(older, [...list, older])).toEqual([100]);
  });

  it('filters by text, model, GPU, engine, status and this PC', () => {
    expect(filterRuns(list, NO_FILTERS, HOST_ID)).toHaveLength(9);
    expect(filterRuns(list, { ...NO_FILTERS, q: 'GEMMA' }, HOST_ID)).toHaveLength(1);
    expect(filterRuns(list, { ...NO_FILTERS, model: 'Qwen3 8B' }, HOST_ID)).toHaveLength(2);
    expect(filterRuns(list, { ...NO_FILTERS, gpu: 'NVIDIA GeForce RTX 3070' }, HOST_ID)).toHaveLength(1);
    expect(filterRuns(list, { ...NO_FILTERS, engine: 'vllm-docker' }, HOST_ID)).toHaveLength(1);
    expect(filterRuns(list, { ...NO_FILTERS, status: 'cancelled' }, HOST_ID)).toHaveLength(1);
    expect(filterRuns(list, { ...NO_FILTERS, thisPc: true }, HOST_ID)).toHaveLength(8);
    // Same name, another PC (or this PC renamed): the id decides.
    expect(filterRuns(list, { ...NO_FILTERS, thisPc: true }, 'another-id')).toHaveLength(0);
    expect(distinct(list, (r) => r.engineKind)).toEqual(['llamacpp-native', 'vllm-docker']);
    expect(ALL).toBe('all');
  });
});

describe('model options', () => {
  const gguf = local('a', { sha256: 'aa', file: 'a.gguf', quant: 'Q4_K_M', sizeBytes: 5, facts: { name: 'Model A', paramsB: 8 } });
  const st = local('s', { format: 'safetensors', repo: 'org/s' });
  it('offers local models first, then suggestions not already on the PC', () => {
    const list = [curated('a', { sha256: 'aa' }), curated('b'), curated('a2', { file: 'a.gguf' }), curated('v', { engine: 'vllm', file: undefined, repo: 'org/s' }), curated('w', { engine: 'vllm', file: undefined })];
    expect(engineFamily('external')).toBe('external');
    expect(engineFamily('llamacpp-docker')).toBe('llamacpp');
    expect(engineFamily('vllm-native')).toBe('vllm');
    expect(modelOptions('external', [gguf], list)).toEqual([]);
    const llama = modelOptions('llamacpp-native', [gguf, st], list);
    expect(llama.map((o) => o.key)).toEqual(['local:a', 'curated:b']);
    // A downloaded suggestion keeps the suggestion's name; any other model its GGUF name.
    expect(llama[0]).toMatchObject({ name: 'Curated a', quant: 'Q4_K_M', sizeBytes: 5, paramsB: 8 });
    expect(modelOptions('llamacpp-native', [gguf], [])[0]).toMatchObject({ name: 'Model A' });
    const bare = modelOptions('llamacpp-native', [local('z')], [])[0]!;
    expect(bare).toMatchObject({ name: 'Model z' });
    expect('quant' in bare).toBe(false);
    const vllm = modelOptions('vllm-docker', [gguf, st], list);
    expect(vllm.map((o) => o.key)).toEqual(['local:s', 'curated:w']);
  });

  it('restores, saves and requests a choice', () => {
    const opts = modelOptions('vllm-docker', [st], [curated('w', { engine: 'vllm', file: undefined, repo: 'org/w' })]);
    expect(initialModelKey(opts, 's')).toBe('local:s');
    expect(initialModelKey(opts, 'curated:w')).toBe('curated:w');
    expect(initialModelKey(opts, 'w')).toBe('curated:w');
    expect(initialModelKey(opts, 'org/w')).toBe('curated:w');
    expect(initialModelKey(opts, 'org/s')).toBe('local:s');
    expect(initialModelKey(opts, 'nope')).toBe('local:s');
    expect(initialModelKey(opts.slice(1), undefined)).toBe('curated:w');
    expect(initialModelKey([], 'x')).toBeUndefined();
    // Nothing on the PC and nothing saved: the reference model (small and quick to download) first.
    const fresh = modelOptions('llamacpp-native', [], [curated('big'), curated('ref', { reference: true })]);
    expect(initialModelKey(fresh, undefined)).toBe('curated:ref');
    // A suggestion chosen (and saved) before its download is found as the library copy afterwards.
    const later = modelOptions('llamacpp-native', [local('z'), local('b', { file: 'b.gguf' })], [curated('b')]);
    expect(later.map((o) => o.key)).toEqual(['local:z', 'local:b']);
    expect(initialModelKey(later, 'curated:b', [curated('b')])).toBe('local:b');
    expect(initialModelKey(later, 'curated:gone', [curated('b')])).toBe('local:z');
    expect(savedModelId(opts[0]!)).toBe('s');
    expect(savedModelId(opts[1]!)).toBe('curated:w');
    expect(requestModel(opts[0]!)).toEqual({ localId: 's' });
    expect(requestModel(opts[1]!)).toEqual({ repo: 'org/w', revision: 'a'.repeat(40) });
    // A GGUF suggestion is planned (and later run) by repo + file, before and after its download.
    expect(requestModel(modelOptions('llamacpp-native', [], [curated('b')])[0]!)).toEqual({ repo: 'org/b-GGUF', file: 'b.gguf', revision: 'a'.repeat(40) });
  });

  it('finds the newest completed run of a model on this GPU', () => {
    const [opt] = modelOptions('llamacpp-native', [gguf], []);
    const base = summaries()[0]!;
    const runs: RunSummary[] = [
      { ...base, id: '1', modelSha256: 'aa', status: 'failed' },
      { ...base, id: '2', modelSha256: 'zz', modelWeakKey: 'wk-a', gpuName: 'other' },
      { ...base, id: '3', modelSha256: 'zz', modelWeakKey: 'wk-a' },
    ];
    expect(triedOn(opt!, runs, base.gpuName)?.id).toBe('3');
    const [cur] = modelOptions('llamacpp-native', [], [curated('b', { sha256: 'bb' })]);
    expect(triedOn(cur!, [{ ...base, modelSha256: 'bb' }], base.gpuName)).toBeTruthy();
    const [vl] = modelOptions('vllm-docker', [], [curated('w', { engine: 'vllm', file: undefined, repo: 'org/w' })]);
    expect(triedOn(vl!, [{ ...base, modelSha256: undefined, modelWeakKey: `org/w@${'a'.repeat(40)}` }], base.gpuName)).toBeTruthy();
    expect(triedOn(vl!, [{ ...base, decodeTps: undefined, modelWeakKey: `org/w@${'a'.repeat(40)}` }], base.gpuName)).toBeUndefined();
  });
});

describe('engine form', () => {
  it('builds the engine config', () => {
    expect(isHttpUrl('ftp://x')).toBe(false);
    expect(isHttpUrl('nope')).toBe(false);
    const form = { ...EMPTY_ENGINE_FORM, executable: ' C:\\l.exe ', image: 'img:1', vllmPath: '/v', baseUrl: 'http://h:1', apiKey: ' k ', flavor: 'vllm' as const };
    expect(engineConfigOf('llamacpp-native', form, false)).toEqual({ config: { kind: 'llamacpp-native' }, invalid: [] });
    expect(engineConfigOf('llamacpp-native', form, true).config).toEqual({ kind: 'llamacpp-native', executable: 'C:\\l.exe' });
    expect(engineConfigOf('vllm-docker', form, true).config).toEqual({ kind: 'vllm-docker', image: 'img:1' });
    expect(engineConfigOf('vllm-native', form, true).config).toEqual({ kind: 'vllm-native', vllmPath: '/v' });
    expect(engineConfigOf('llamacpp-docker', EMPTY_ENGINE_FORM, true).config).toEqual({ kind: 'llamacpp-docker' });
    expect(engineConfigOf('external', form, true).config).toEqual({ kind: 'external', baseUrl: 'http://h:1', apiKey: 'k', flavor: 'vllm' });
    expect(engineConfigOf('external', EMPTY_ENGINE_FORM, true)).toEqual({ config: { kind: 'external', flavor: 'openai' }, invalid: ['baseUrl'] });
    expect(engineFormOf(undefined)).toEqual(EMPTY_ENGINE_FORM);
    expect(engineFormOf({ kind: 'external', baseUrl: 'http://x', flavor: 'llamacpp', apiKey: 'k' })).toMatchObject({ baseUrl: 'http://x', flavor: 'llamacpp', apiKey: '' });
    expect(savableEngine({ kind: 'external', apiKey: 'secret', baseUrl: 'http://x' })).toEqual({ kind: 'external', baseUrl: 'http://x' });
  });
});

describe('expert form', () => {
  it('parses numbers, ratios, arguments and env', () => {
    expect(parseInteger('8.192')).toBe(8192);
    expect(parseInteger('0', 0)).toBe(0);
    expect(parseInteger('0')).toBeNull();
    expect(parseInteger('x')).toBeNull();
    expect(parseRatio('0,9')).toBe(0.9);
    expect(parseRatio('90%')).toBe(0.9);
    expect(parseRatio('85')).toBe(0.85);
    expect(parseRatio('')).toBeNull();
    expect(parseRatio('%')).toBeNull();
    expect(parseRatio('abc')).toBeNull();
    expect(parseRatio('0.05')).toBeNull();
    expect(parseArgs('--a 1\n--b "x y"\n  --c \'q r\'')).toEqual(['--a', '1', '--b', 'x y', '--c', 'q r']);
    expect(parseEnv('A=1\n\n bad\nB_2 = x y')).toEqual({ env: { A: '1', B_2: 'x y' }, invalid: ['bad'] });
    expect(parseList('512, 4096; 8, 512')).toEqual([8, 512, 4096]);
    expect(parseUsers('4')).toEqual([1, 2, 3, 4]);
    expect(parseUsers('8, 1, 4')).toEqual([1, 4, 8]);
    expect(parseUsers('x')).toBeNull();
    expect(showUsers([1, 2, 3, 4])).toBe('4');
    expect(showUsers([1])).toBe('1');
    expect(showUsers([1, 4])).toBe('1, 4');
    expect(parseList('1, x')).toBeNull();
  });

  it('round-trips launch parameters', () => {
    expect(paramsFromForm(EMPTY_PARAMS_FORM)).toEqual({ params: { extraArgs: [], env: {} }, invalid: [] });
    const form = {
      ...EMPTY_PARAMS_FORM,
      contextSize: '8192',
      gpuLayers: '0',
      flashAttention: 'on' as const,
      kvCacheType: 'q8_0' as const,
      batchSize: '2048',
      ubatchSize: '512',
      threads: '8',
      parallel: '4',
      gpuMemoryUtilization: '0,9',
      maxModelLen: '4096',
      dtype: ' half ',
      quantization: 'fp8',
      extraArgs: '--metrics\n--alias "my model"',
      env: 'A=1',
    };
    const { params, invalid } = paramsFromForm(form);
    expect(invalid).toEqual([]);
    expect(params).toMatchObject({ contextSize: 8192, gpuLayers: 0, gpuMemoryUtilization: 0.9, dtype: 'half', extraArgs: ['--metrics', '--alias', 'my model'] });
    expect(formFromParams(params)).toEqual({ ...form, gpuMemoryUtilization: '0.9', dtype: 'half', extraArgs: '--metrics\n--alias\n"my model"' });
    expect(formFromParams(undefined)).toEqual(EMPTY_PARAMS_FORM);
    expect(paramsFromForm({ ...EMPTY_PARAMS_FORM, contextSize: 'x', gpuLayers: '-1', gpuMemoryUtilization: '5', env: 'nope' }).invalid).toEqual([
      'contextSize',
      'gpuLayers',
      'gpuMemoryUtilization',
      'env',
    ]);
    expect(hasCustomParams(undefined)).toBe(false);
    expect(hasCustomParams({ extraArgs: [], env: {} })).toBe(false);
    expect(hasCustomParams({ extraArgs: ['x'], env: {} })).toBe(true);
    expect(hasCustomParams({ extraArgs: [], env: { A: '1' } })).toBe(true);
    expect(hasCustomParams({ extraArgs: [], env: {}, threads: 2 })).toBe(true);
  });

  it('round-trips a custom plan', () => {
    const { scenario, invalid } = scenarioFromForm(DEFAULT_SCENARIO_FORM);
    expect(invalid).toEqual([]);
    expect(scenario.steps.map((s) => s.kind)).toEqual(['load', 'load', 'latency', 'concurrency']);
    expect(formFromScenario(scenario)).toEqual(DEFAULT_SCENARIO_FORM);
    const withBench = scenarioFromForm({ ...DEFAULT_SCENARIO_FORM, llamaBench: true, coldReps: '0', concurrency: '', outputTokens: '', warmup: '', reps: '', requestsPerWorker: '' }).scenario;
    expect(withBench.steps.map((s) => s.kind)).toEqual(['load', 'latency', 'llama-bench']);
    expect(formFromScenario(withBench)).toMatchObject({ llamaBench: true, coldReps: '0', concurrency: '' });
    expect(formFromScenario(undefined)).toEqual(DEFAULT_SCENARIO_FORM);
    const bad = scenarioFromForm({ ...DEFAULT_SCENARIO_FORM, coldReps: 'x', promptTokens: '1, y', concurrency: 'z', warmReps: '' });
    expect(bad.invalid).toEqual(['coldReps', 'promptTokens', 'concurrency']);
    expect(bad.scenario.steps).toEqual([]);
    const noPrompts = scenarioFromForm({ ...DEFAULT_SCENARIO_FORM, promptTokens: '', concurrency: '2' }).scenario;
    expect(noPrompts.steps.at(-1)).toMatchObject({ kind: 'concurrency', promptTokens: 512 });
  });
});

describe('rerun', () => {
  const lib = [local('m', { weakKey: seeded(IDS.full).model.weakKey }), local('p')];
  it('turns a run back into a request', () => {
    const r = rerunOf(seeded(IDS.full), lib, 'C:\\Users\\utente\\AppData\\Roaming\\GPU Bench\\engines');
    expect(r.request).toMatchObject({ engine: { kind: 'llamacpp-native' }, model: { localId: 'm' }, profile: 'full' });
    expect(r.request.params?.contextSize).toBe(8192);
    expect(r.modelMissing).toBe(false);
    expect(r.needsExpert).toBe(true);
    // A managed build of another PC (same folder layout) is not a custom executable: this PC's build is used.
    expect(rerunOf(seeded(IDS.full), lib, undefined).request.engine).toEqual({ kind: 'llamacpp-native' });
    const full = seeded(IDS.full);
    const custom = rerunOf({ ...full, engine: { ...full.engine, executable: 'D:\\llama\\llama-server.exe' }, scenario: { ...full.scenario, profile: 'custom' } }, lib, undefined);
    expect(custom.request.engine.executable).toBe('D:\\llama\\llama-server.exe');
    expect(custom.draft.scenario?.profile).toBe('custom');
    expect(rerunOf(seeded(IDS.gemma), [], undefined).modelMissing).toBe(true);
    const vllm = rerunOf(seeded(IDS.vllm), [], undefined);
    expect(vllm.request).toMatchObject({ engine: { kind: 'vllm-docker', image: 'vllm/vllm-openai:v0.12.0' }, model: { repo: 'Qwen/Qwen3-8B-FP8', revision: 'main' } });
    expect(vllm.draft.repo).toBe('Qwen/Qwen3-8B-FP8');
    const noRev = rerunOf({ ...seeded(IDS.vllm), model: { ...seeded(IDS.vllm).model, revision: undefined } }, [], undefined);
    expect(noRev.request.model).toEqual({ repo: 'Qwen/Qwen3-8B-FP8' });
    // A GGUF downloaded from Hugging Face: the library copy while it is there, else repo + file (downloaded again first).
    const hubGguf = { ...seeded(IDS.full).model, source: 'hf' as const, repo: 'Qwen/Qwen3-8B-GGUF', file: 'Qwen3-8B-Q4_K_M.gguf', revision: 'abc' };
    expect(rerunOf({ ...seeded(IDS.full), model: hubGguf }, lib, undefined).request.model).toEqual({ localId: 'm' });
    const gone = rerunOf({ ...seeded(IDS.full), model: hubGguf }, [], undefined);
    expect(gone.request.model).toEqual({ repo: 'Qwen/Qwen3-8B-GGUF', file: 'Qwen3-8B-Q4_K_M.gguf', revision: 'abc' });
    expect(gone.draft.repo).toBe('Qwen/Qwen3-8B-GGUF');
    expect(gone.modelMissing).toBe(false);
    expect(rerunOf({ ...seeded(IDS.full), model: { ...hubGguf, revision: undefined } }, [], undefined).request.model).toEqual({ repo: 'Qwen/Qwen3-8B-GGUF', file: 'Qwen3-8B-Q4_K_M.gguf' });
  });

  it('external endpoints and vLLM native', () => {
    const base = seeded(IDS.quick);
    const ext: RunResult = {
      ...base,
      engine: { kind: 'external', name: 'llama.cpp server', variant: 'llamacpp' },
      model: { ...base.model, displayName: 'demo', source: 'external', format: 'remote' },
      launch: { ...base.launch, host: '10.0.0.2', port: 8080, argv: [], params: { extraArgs: [], env: {} } },
    };
    const r = rerunOf(ext, [], undefined);
    expect(r.request.engine).toEqual({ kind: 'external', baseUrl: 'http://10.0.0.2:8080', flavor: 'llamacpp' });
    expect(r.request.model).toEqual({ name: 'demo' });
    expect(r.needsExpert).toBe(true);
    const unnamed = rerunOf({ ...ext, engine: { kind: 'external', name: 'x' }, model: { ...ext.model, displayName: 'http://10.0.0.2:8080' } }, [], undefined);
    expect(unnamed.request.model).toEqual({});
    expect(unnamed.request.engine.flavor).toBe('openai');
    const native = rerunOf({ ...base, engine: { kind: 'vllm-native', name: 'vLLM', executable: '/opt/vllm' }, model: { ...base.model, source: 'hf', repo: undefined } }, [], undefined);
    expect(native.request.engine).toEqual({ kind: 'vllm-native', vllmPath: '/opt/vllm' });
    expect(native.modelMissing).toBe(true);
    const plain = rerunOf({ ...base, engine: { kind: 'llamacpp-docker', name: 'llama.cpp' }, launch: { ...base.launch, params: { extraArgs: [], env: {} } } }, [local('q', { weakKey: base.model.weakKey })], undefined);
    expect(plain.needsExpert).toBe(false);
    expect(plain.request.params).toBeUndefined();
    expect(findLocalModel({ model: { ...base.model, weakKey: 'none', path: 'C:\\models\\p.gguf' } }, lib)?.id).toBe('p');
    expect(findLocalModel({ model: { ...base.model, weakKey: 'none', sha256: 'h', path: undefined } }, [local('h', { sha256: 'h' })])?.id).toBe('h');
  });
});

describe('run context and drafts', () => {
  it('keeps the start context and hands a draft over once', () => {
    const qc = new QueryClient();
    expect(readRunContext(qc, 'r')).toBeUndefined();
    const ctx = { request: { engine: { kind: 'llamacpp-native' as const }, model: {}, profile: 'quick' as const, allowSharedGpu: false }, modelLabel: 'm', engineLabel: 'e', pre: {}, startedAt: 1 };
    saveRunContext(qc, 'r', ctx);
    expect(readRunContext(qc, 'r')).toEqual(ctx);
    expect(takeDraft(qc)).toBeUndefined();
    saveDraft(qc, { engine: { kind: 'llamacpp-native' }, profile: 'quick' });
    expect(takeDraft(qc)?.profile).toBe('quick');
    expect(takeDraft(qc)).toBeUndefined();
  });
});

describe('live state', () => {
  it('folds the events of one run', () => {
    let s = initialLive();
    const sample = (t: number) => ({ t, gpu: 0, utilPct: 1, memUsedMiB: 1, memTotalMiB: 2, powerW: 3, tempC: 4, smClockMHz: 5, memClockMHz: 6, pcieGen: 4, pcieWidth: 16, throttle: [] });
    s = liveReducer(s, { type: 'telemetry', samples: [sample(100), { ...sample(100), gpu: 1 }] }, 'r');
    s = liveReducer(s, { type: 'telemetry', samples: [{ ...sample(200), gpu: 1 }] }, 'r');
    expect(s.samples).toHaveLength(1);
    s = liveReducer(s, { type: 'run.phase', runId: 'r', phase: 'prepare', progress: 0.1 }, 'r');
    expect(s.marks).toEqual([{ t: 100, phase: 'prepare' }]);
    s = liveReducer(s, { type: 'run.phase', runId: 'r', phase: 'prepare', progress: 0.05, detail: 'x' }, 'r');
    expect(s.progress).toBe(0.1);
    expect(s.detail).toBe('x');
    s = liveReducer(s, { type: 'run.phase', runId: 'r', phase: 'decode', progress: 0.5 }, 'r');
    expect(s.detail).toBeUndefined();
    expect(s.marks).toHaveLength(2);
    s = liveReducer(s, { type: 'run.phase', runId: 'other', phase: 'cleanup', progress: 1 }, 'r');
    expect(s.phase).toBe('decode');
    s = liveReducer(s, { type: 'run.live', runId: 'r', decodeTps: 1, prefillTps: 2, ttftMs: 3, loadMs: 4 }, 'r');
    s = liveReducer(s, { type: 'run.live', runId: 'r' }, 'r');
    expect(s).toMatchObject({ decodeTps: 1, prefillTps: 2, ttftMs: 3, loadMs: 4 });
    expect(liveReducer(s, { type: 'run.live', runId: 'x', decodeTps: 9 }, 'r')).toBe(s);
    s = liveReducer(s, { type: 'run.log', runId: 'r', lines: Array.from({ length: MAX_LOG_LINES + 5 }, (_, i) => `l${i}`) }, 'r');
    expect(s.log).toHaveLength(MAX_LOG_LINES);
    expect(liveReducer(s, { type: 'run.log', runId: 'x', lines: ['a'] }, 'r')).toBe(s);
    s = liveReducer(s, { type: 'run.error', runId: 'r', error: { code: 'ENGINE_OOM', message: 'm' } }, 'r');
    expect(s.error?.code).toBe('ENGINE_OOM');
    expect(liveReducer(s, { type: 'run.error', runId: 'x', error: { code: 'INTERNAL', message: 'm' } }, 'r')).toBe(s);
    expect(liveReducer(s, { type: 'run.done', runId: 'x', summary: summaries()[0]! }, 'r')).toBe(s);
    expect(liveReducer(s, { type: 'run.done', runId: 'r', summary: summaries()[0]! }, 'r')).toMatchObject({ done: true, progress: 1 });
    expect(liveReducer(s, { type: 'runs.changed' }, 'r')).toBe(s);
  });
});

describe('compare', () => {
  it('lines up the numbers and the settings that differ', () => {
    const a = seeded(IDS.moe);
    const b = seeded(IDS.gemma);
    const rows = metricRows(a, b, it_);
    expect(rows.map((r) => r.id)).toEqual(['decode', 'prefill', 'ttft', 'cold', 'warm', 'vram', 'concurrency', 'efficiency', 'score']);
    for (const r of rows) expect(r.format(1234.5)).toMatch(/\d/);
    expect(metricRows(seeded(IDS.failed), seeded(IDS.failed), it_).map((r) => r.id)).toEqual(['vram']);
    const diff = diffRows(a, b, it_);
    expect(diff.find((d) => d.label === 'Modello')).toMatchObject({ differs: true });
    expect(diff.find((d) => d.label === 'Driver')).toMatchObject({ differs: false });
    expect(diff.find((d) => d.label === 'Flash attention')).toMatchObject({ a: 'on', b: 'Automatico' });
    const v = diffRows(seeded(IDS.vllm), { ...seeded(IDS.full), hardware: { ...seeded(IDS.full).hardware, gpus: [] }, model: { ...seeded(IDS.full).model, quant: undefined, sizeBytes: undefined, sha256: undefined }, engine: { kind: 'llamacpp-native', name: 'llama.cpp' } }, en);
    expect(v.find((d) => d.label === 'Docker image')).toMatchObject({ a: 'sha256:6f1a8c2e', b: '–' });
    expect(v.find((d) => d.label === 'Graphics card')?.b).toBe('–');
    expect(v.find((d) => d.label === 'Environment variables')).toBeUndefined();
  });

  it('aligns and draws two runs on one chart', () => {
    const p = alignPairs([{ x: 1, y: 10 }, { x: 4, y: 40 }], [{ x: 2, y: 20 }, { x: 4, y: 44 }], (q) => q.x, (q) => q.y);
    expect(p).toEqual({ x: [1, 2, 4], a: [10, null, 40], b: [null, 20, 44] });
    expect(decodePairs(seeded(IDS.full), seeded(IDS.quick)).x).toContain(8192);
    expect(concurrencyPairs(seeded(IDS.full), seeded(IDS.gemma)).x).toEqual([1, 2, 4, 8, 16]);
    const tk = readChartTokens();
    const opts = { nameA: 'A', nameB: 'B', format: (v: number) => `${v} t`, xLabel: (v: number) => `x${v}`, xName: 'X' };
    const bars = pairBarsOption(tk, p, opts) as { tooltip: { valueFormatter: (v: unknown) => string }; series: unknown[] };
    expect(bars.series).toHaveLength(2);
    expect(bars.tooltip.valueFormatter(3)).toBe('3 t');
    expect(bars.tooltip.valueFormatter(null)).toBe('–');
    const lines = pairLinesOption(tk, p, opts) as { tooltip: { valueFormatter: (v: unknown) => string }; xAxis: { axisLabel: { formatter: (v: number) => string } }; series: { data: unknown[] }[] };
    expect(lines.tooltip.valueFormatter(undefined)).toBe('–');
    expect(lines.tooltip.valueFormatter(2)).toBe('2 t');
    expect(lines.xAxis.axisLabel.formatter(4)).toBe('x4');
    expect(lines.series[0]!.data).toEqual([[1, 10], [2, null], [4, 40]]);
  });
});

describe('needs before a run', () => {
  const plan = (needs: RunPlan['needs']): RunPlan => ({ scenario: { profile: 'quick', seed: 42, steps: [] }, command: { argv: [], powershell: '', bash: '' }, needs, estimatedSeconds: 1, warnings: [] });
  const req = (engine: StartRunRequest['engine'], model: StartRunRequest['model']): StartRunRequest => ({ engine, model, profile: 'quick', allowSharedGpu: false });

  it('reads them from the plan, named for people', () => {
    const gguf = req({ kind: 'llamacpp-native' }, { repo: 'org/m-GGUF', file: 'm.gguf', revision: 'r1' });
    expect(
      needsFromPlan(gguf, plan([{ kind: 'engine', label: 'llama.cpp', bytes: 5 }, { kind: 'model', label: 'org/m-GGUF/m.gguf', bytes: 9 }]), 'M · Q4_K_M'),
    ).toEqual([
      { kind: 'engine', label: 'llama.cpp', bytes: 5 },
      { kind: 'model', label: 'M · Q4_K_M', bytes: 9, repo: 'org/m-GGUF', revision: 'r1', file: 'm.gguf' },
    ]);
    // A vLLM repo without a pinned revision and without a known size; a Docker image to pull.
    const vllm = req({ kind: 'vllm-docker' }, { repo: 'org/m' });
    // Engine first, then the image, then the model, whatever order the plan lists them in.
    expect(needsFromPlan(vllm, plan([{ kind: 'model', label: 'org/m' }, { kind: 'image', label: 'vllm/vllm-openai:v1', bytes: 7 }, { kind: 'engine', label: 'x' }]), 'M')).toEqual([
      { kind: 'engine', label: 'x' },
      { kind: 'image', engine: 'vllm-docker', label: 'vllm/vllm-openai:v1', bytes: 7 },
      { kind: 'model', label: 'M', repo: 'org/m', revision: 'main' },
    ]);
    expect(needsFromPlan(gguf, plan([]), 'M')).toEqual([]);
  });

  it('guesses them before the plan from the engine status and the chosen model', () => {
    const status = (over: Partial<EngineStatus>): EngineStatus => ({ kind: 'llamacpp-native', available: false, installed: false, problems: [], supported: true, ...over });
    const suggestion = modelOptions('llamacpp-native', [], [curated('b')])[0];
    const repoOnly = modelOptions('vllm-docker', [], [curated('w', { engine: 'vllm', file: undefined, repo: 'org/w' } as Partial<CuratedModel>)])[0];
    const mine = modelOptions('llamacpp-native', [local('a')], [])[0];
    expect(guessNeeds({ engine: { kind: 'llamacpp-native' }, status: status({}), option: suggestion, modelLabel: 'B' })).toEqual([
      { kind: 'engine', label: 'llama.cpp' },
      { kind: 'model', label: 'B', bytes: 1000, repo: 'org/b-GGUF', revision: 'a'.repeat(40), file: 'b.gguf' },
    ]);
    // A custom executable, an unknown or installed status, a model on the PC: nothing to fetch.
    expect(guessNeeds({ engine: { kind: 'llamacpp-native', executable: 'x' }, status: status({}), option: mine, modelLabel: 'A' })).toEqual([]);
    expect(guessNeeds({ engine: { kind: 'llamacpp-native' }, status: undefined, option: undefined, modelLabel: 'A' })).toEqual([]);
    expect(guessNeeds({ engine: { kind: 'llamacpp-native' }, status: status({ installed: true }), option: mine, modelLabel: 'A' })).toEqual([]);
    // Docker: a missing image the status names; not when Docker itself is the problem, nor for a custom image.
    const missing = status({ kind: 'vllm-docker', location: 'vllm/vllm-openai:v1', problems: ['ENGINE_NOT_INSTALLED'] });
    expect(guessNeeds({ engine: { kind: 'vllm-docker' }, status: missing, option: repoOnly, modelLabel: 'W' })).toEqual([
      { kind: 'image', engine: 'vllm-docker', label: 'vllm/vllm-openai:v1' },
      { kind: 'model', label: 'W', bytes: 1000, repo: 'org/w', revision: 'a'.repeat(40) },
    ]);
    expect(guessNeeds({ engine: { kind: 'vllm-docker', image: 'mine:1' }, status: missing, option: undefined, modelLabel: 'W' })).toEqual([]);
    expect(guessNeeds({ engine: { kind: 'llamacpp-docker' }, status: { ...missing, problems: ['DOCKER_NOT_RUNNING'] }, option: undefined, modelLabel: 'W' })).toEqual([]);
    expect(guessNeeds({ engine: { kind: 'llamacpp-docker' }, status: { ...missing, location: undefined }, option: undefined, modelLabel: 'W' })).toEqual([]);
    expect(guessNeeds({ engine: { kind: 'llamacpp-docker' }, status: undefined, option: undefined, modelLabel: 'W' })).toEqual([]);
  });
});
