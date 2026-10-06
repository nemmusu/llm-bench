import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { DownloadJob, LocalModel } from '../../../../src/contract/models';
import { destinationOf } from '../../../../src/renderer/components/library/download-dialog';
import {
  bestRunHere,
  curatedWeakKey,
  fileName,
  groupByBase,
  groupFiles,
  inBucket,
  remoteWeakKey,
  repoUrl,
  triedRepos,
} from '../../../../src/renderer/components/library/helpers';
import { modelFromJob } from '../../../../src/renderer/components/library/library-events';
import { appendSample } from '../../../../src/renderer/components/monitor/use-gpu-history';
import { stageLabel } from '../../../../src/renderer/components/setup/install-progress';
import { itemDetail } from '../../../../src/renderer/components/setup/system-check';
import { createFormatters } from '../../../../src/renderer/i18n';
import { ApiError } from '../../../../src/renderer/lib/api';
import { activeEvent, errorData, handleLibraryEvent, installKey, isDownloadActive, libKeys } from '../../../../src/renderer/lib/queries-library';
import { GPU, HUB_FILES, hubModel, item, job, libApi, localModel, REFERENCE, run, sample } from './fake';

const it_ = createFormatters('it');

describe('library helpers', () => {
  it('repo urls, weak keys and file names', () => {
    expect(repoUrl('a/b')).toBe('https://huggingface.co/a/b');
    expect(remoteWeakKey('a/b', 'Q4/x.gguf', 'Q4_K_M', 10)).toBe('a/b/x.gguf/Q4_K_M/10');
    expect(remoteWeakKey('a/b', 'x.gguf', undefined, 10)).toBe('a/b/x.gguf//10');
    expect(curatedWeakKey(REFERENCE)).toBe(`Qwen/Qwen3-4B-GGUF/Qwen3-4B-Q4_K_M.gguf/Q4_K_M/${REFERENCE.sizeBytes}`);
    expect(curatedWeakKey({ repo: 'a/b', quant: 'BF16', sizeBytes: 1 })).toBe('a/b//BF16/1');
    expect(fileName('C:\\a\\b.gguf')).toBe('b.gguf');
  });

  it('best run on this GPU: completed, measured, same card or same model of card', () => {
    const runs = [
      run('1', { decodeTps: 100 }),
      run('2', { decodeTps: 150, gpuUuid: 'other', gpuName: GPU.name }),
      run('3', { decodeTps: 900, status: 'failed' }),
      run('4', { decodeTps: undefined }),
      run('5', { decodeTps: 999, gpuUuid: 'x', gpuName: 'RTX 3070' }),
      run('6', { decodeTps: 120 }),
    ];
    expect(bestRunHere(runs, GPU)).toEqual({ tps: 150, date: runs[1]?.createdAt, runId: '2' });
    expect(bestRunHere(runs, undefined)).toBeUndefined();
    expect(bestRunHere(undefined, GPU)).toBeUndefined();
  });

  it('tried repos come from weak keys of runs on this GPU', () => {
    const runs = [run('1'), run('2', { modelWeakKey: 'local/x.gguf/Q4/1' }), run('3', { gpuUuid: 'x', gpuName: 'other', modelWeakKey: 'z/y/f/q/1' })];
    expect([...triedRepos(runs, GPU)]).toEqual(['org/Model-GGUF']);
    expect(triedRepos(runs, undefined).size).toBe(0);
    expect(triedRepos(undefined, GPU).size).toBe(0);
  });

  it('size buckets', () => {
    expect(inBucket(undefined, 'any')).toBe(true);
    expect(inBucket(undefined, 'small')).toBe(false);
    expect(inBucket(4, 'small')).toBe(true);
    expect(inBucket(8, 'medium')).toBe(true);
    expect(inBucket(8, 'large')).toBe(false);
    expect(inBucket(70, 'huge')).toBe(true);
  });

  it('groups files by quant (split parts together), extras last', () => {
    const groups = groupFiles([...HUB_FILES, { path: 'loose.gguf', sizeBytes: 1, kind: 'weights' }, { path: 'mmproj-2.gguf', sizeBytes: 5, kind: 'mmproj' }]);
    expect(groups.map((g) => [g.label, g.files.length, g.kind])).toEqual([
      ['Q8_0', 1, 'weights'],
      ['Q4_K_M', 2, 'weights'],
      ['loose.gguf', 1, 'weights'],
      ['mmproj', 2, 'mmproj'],
      ['other', 1, 'other'],
    ]);
  });

  it('groups search hits under their base model', () => {
    const groups = groupByBase([
      hubModel('a/X-GGUF', { baseModel: 'base/X' }),
      hubModel('b/Y'),
      hubModel('c/X-GGUF', { baseModel: 'base/X' }),
      hubModel('base/X', { baseModel: 'base/X' }),
    ]);
    expect(groups.map((g) => [g.base, g.models.map((m) => m.repo)])).toEqual([
      ['base/X', ['a/X-GGUF', 'c/X-GGUF']],
      [undefined, ['b/Y']],
      [undefined, ['base/X']],
    ]);
  });

  it('destination folder uses the OS separator of the models folder', () => {
    expect(destinationOf('C:\\Models\\', 'a/b')).toBe('C:\\Models\\a\\b');
    expect(destinationOf('/home/u/models', 'a/b')).toBe('/home/u/models/a/b');
  });

  it('the model a finished download produced', () => {
    const models: LocalModel[] = [localModel('y', { identity: { repo: 'org/Model-GGUF', file: undefined } }), localModel('x', { identity: { repo: 'org/Model-GGUF', file: 'Model-Q8_0.gguf' } })];
    expect(modelFromJob(models, job('1'))?.id).toBe('x');
    expect(modelFromJob(undefined, job('1'))).toBeUndefined();
    expect(modelFromJob(models, job('1', { repo: 'other/repo' }))).toBeUndefined();
  });

  it('rolling telemetry history', () => {
    let h = appendSample([], sample(1));
    h = appendSample(h, sample(1));
    h = appendSample(h, undefined);
    expect(h).toHaveLength(1);
    for (let i = 2; i < 6; i++) h = appendSample(h, sample(i), 3);
    expect(h.map((s) => s.t)).toEqual([3, 4, 5]);
  });

  it('install stages in words, unknown ones generic', () => {
    expect(stageLabel(it_.t, 'download')).toBe('Download');
    expect(stageLabel(it_.t, 'mystery')).toBe('Lavoro in corso…');
  });

  it('errors from anywhere become AppErrorData', () => {
    expect(errorData(new ApiError({ code: 'HF_GATED', message: 'm' }, 403)).code).toBe('HF_GATED');
    expect(errorData({ code: 'DISK_FULL', message: 'x' })).toEqual({ code: 'DISK_FULL', message: 'x' });
    expect(errorData(new Error('boom'))).toEqual({ code: 'INTERNAL', message: 'boom' });
    expect(errorData('text')).toEqual({ code: 'INTERNAL', message: 'text' });
    expect(errorData(undefined)).toEqual({ code: 'INTERNAL', message: 'undefined' });
  });

  it('install events: active or final, keyed by kind or image', () => {
    const e = { type: 'engine.install' as const, kind: 'docker-pull', image: 'a:b', stage: 'download', bytesDone: 1 };
    expect(activeEvent(e)).toBe(e);
    expect(activeEvent({ ...e, stage: 'done' })).toBeUndefined();
    expect(activeEvent(undefined)).toBeUndefined();
    expect(installKey(e)).toBe('pull:a:b');
    expect(installKey({ ...e, image: undefined })).toBe('docker-pull');
    expect(isDownloadActive(job('1'))).toBe(true);
    expect(isDownloadActive(job('1', { state: 'paused' }))).toBe(false);
  });
});

describe('system check details', () => {
  const d = (i: Parameters<typeof itemDetail>[0]) => itemDetail(i, it_);
  it('describes every item and state in plain words', () => {
    expect(d(item('driver', { error: { code: 'INTERNAL', message: 'x' } }))).toBe('Non sono riuscito a controllarlo: premi «Ricontrolla».');
    expect(d(item('driver', { params: { driverVersion: '617.14', cudaVersion: '13.4' } }))).toBe('Versione 617.14 · CUDA 13.4');
    expect(d(item('driver', { state: 'unsupported' }))).toContain('non c’è un driver');
    expect(d(item('driver', { state: 'missing', code: 'DRIVER_TOO_OLD', params: { driverVersion: '500.1', minRequired: '570' } }))).toBe('Hai la versione 500.1: serve almeno la 570.');
    expect(d(item('driver', { state: 'missing', code: 'DRIVER_MISSING' }))).toContain('Non ho trovato il driver');
    expect(d(item('driver', { state: 'missing', code: 'DRIVER_MISSING', params: { guidance: 'ubuntu-drivers' } }))).toContain('Driver aggiuntivi');
    expect(d(item('gpu', { params: { name: 'RTX', vramGb: 31.8 } }))).toBe('RTX · 32 GB');
    expect(d(item('gpu', { state: 'unsupported', params: { name: 'Radeon' } }))).toContain('Radeon');
    expect(d(item('gpu', { state: 'missing', code: 'DRIVER_MISSING' }))).toContain('installato il driver');
    expect(d(item('gpu', { state: 'missing', code: 'GPU_NOT_FOUND' }))).toBe('Non ho trovato una scheda video NVIDIA.');
    expect(d(item('llamacpp', { params: { version: 'b1', variant: 'cuda' } }))).toBe('Versione b1 · cuda');
    expect(d(item('llamacpp', { state: 'warning' }))).toContain('non parte');
    expect(d(item('llamacpp', { state: 'missing' }))).toContain('Lo scarico');
    expect(d(item('models', { params: { count: 3 } }))).toBe('3 modelli sul tuo PC');
    expect(d(item('models', { params: { count: 1 } }))).toBe('1 modello sul tuo PC');
    expect(d(item('models', { state: 'missing' }))).toContain('Nessun modello');
    expect(d(item('disk', { params: { freeGb: 120, path: 'C:\\', minFreeGb: 20 } }))).toBe('120 GB liberi in C:\\');
    expect(d(item('disk', { state: 'warning', params: { freeGb: 5, path: 'C:\\', minFreeGb: 20 } }))).toContain('Solo 5 GB');
    expect(d(item('docker', { params: { dockerState: 'running', version: '29' } }))).toBe('Docker 29 è pronto. Serve solo per vLLM.');
    expect(d(item('docker', { state: 'unsupported' }))).toContain('non è supportata');
    expect(d(item('docker', { params: { distroSupport: 'unsupported-distro' } }))).toContain('Ubuntu e Debian');
    expect(d(item('vllm-native', { params: { version: '0.11' } }))).toBe('vLLM 0.11 installato.');
    expect(d(item('vllm-native', { state: 'unsupported' }))).toBe('Disponibile solo su Linux.');
    expect(d(item('vllm-native', { state: 'optional', params: { uv: true } }))).toContain('installo vLLM');
    expect(d(item('vllm-native', { state: 'optional', params: { uv: false } }))).toContain('prima scarico uv');
    expect(d(item('driver', {}))).toBe('Versione – · CUDA –');
  });
});

describe('handleLibraryEvent', () => {
  it('folds downloads and installs into the cache and refreshes what changed', async () => {
    const qc = new QueryClient();
    const api = libApi();
    const onBenchmark = vi.fn();
    const ctx = { qc, api, lang: 'it' as const, onBenchmark };
    const inv = vi.spyOn(qc, 'invalidateQueries');
    handleLibraryEvent({ type: 'download.update', job: job('a') }, ctx);
    expect(qc.getQueryData<DownloadJob[]>(libKeys.downloads)).toHaveLength(1);
    handleLibraryEvent({ type: 'download.update', job: job('a', { state: 'done' }) }, ctx);
    handleLibraryEvent({ type: 'download.update', job: job('a', { state: 'done' }) }, ctx);
    await vi.waitFor(() => expect(qc.getQueryData(libKeys.local)).toEqual(api.w.local));
    expect(api.calls.filter((c) => c.path === '/api/models/rescan')).toHaveLength(1);
    handleLibraryEvent({ type: 'runs.changed' }, ctx);
    expect(inv).toHaveBeenCalledWith({ queryKey: libKeys.runs });
    handleLibraryEvent({ type: 'hello', version: '1' }, ctx);
    const before = inv.mock.calls.length;
    handleLibraryEvent({ type: 'engine.install', kind: 'llamacpp-native', stage: 'download', bytesDone: 1 }, ctx);
    expect(inv.mock.calls.length).toBe(before);
    handleLibraryEvent({ type: 'engine.install', kind: 'llamacpp-native', stage: 'done', bytesDone: 1 }, ctx);
    expect(inv.mock.calls.length).toBeGreaterThan(before);
    expect(qc.getQueryData([...libKeys.install, 'llamacpp-native'])).toMatchObject({ stage: 'done' });
  });

  it('a failing rescan is ignored', async () => {
    const qc = new QueryClient();
    const api = libApi();
    api.on('POST /api/models/rescan', () => Promise.reject(new Error('down')));
    handleLibraryEvent({ type: 'download.update', job: job('a', { state: 'done' }) }, { qc, api, lang: 'en', onBenchmark: vi.fn() });
    await vi.waitFor(() => expect(api.calls.some((c) => c.path === '/api/models/rescan')).toBe(true));
    expect(qc.getQueryData(libKeys.local)).toBeUndefined();
  });
});
