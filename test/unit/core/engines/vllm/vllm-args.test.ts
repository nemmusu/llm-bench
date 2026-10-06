import { describe, expect, it } from 'vitest';
import { launchParamsSchema } from '../../../../../src/contract/engines';
import type { ModelTarget } from '../../../../../src/core/engines/types';
import { vllmModelSource, vllmServeArgs } from '../../../../../src/core/engines/shared/vllm-args';
import { listsModel, modelReadyProbe } from '../../../../../src/core/engines/shared/probes';
import { json, routeFetch } from '../../docker/helpers';

const identity = (o: Partial<ModelTarget['identity']> = {}): ModelTarget['identity'] => ({
  displayName: 'Qwen3 0.6B',
  format: 'safetensors',
  source: 'hf',
  files: [],
  weakKey: 'k',
  ...o,
});
const local = (dir: string) => ({
  id: 'l',
  identity: identity(),
  paths: [`${dir}/model.safetensors`],
  auxiliary: [],
  dir,
  origin: 'library' as const,
  modifiedAt: '2026-01-01',
});

describe('vllmModelSource', () => {
  it('serves HF repos by id, with a pinned revision when not main', () => {
    expect(vllmModelSource({ identity: identity({ repo: 'Qwen/Qwen3-0.6B' }) })).toEqual({ kind: 'repo', repo: 'Qwen/Qwen3-0.6B' });
    expect(vllmModelSource({ identity: identity({ repo: 'a/b', revision: 'main' }) })).toEqual({ kind: 'repo', repo: 'a/b' });
    expect(vllmModelSource({ identity: identity({ revision: 'abc123' }), repo: 'x/y' })).toEqual({ kind: 'repo', repo: 'x/y', revision: 'abc123' });
  });

  it('mounts local safetensors folders, HF-cache snapshots from their repo root', () => {
    expect(vllmModelSource({ identity: identity(), local: local('C:\\models\\Qwen3 0.6B (bf16)') })).toEqual({
      kind: 'local',
      hostDir: 'C:\\models\\Qwen3 0.6B (bf16)',
      name: 'Qwen3_0.6B__bf16_',
      inner: '',
      files: ['C:\\models\\Qwen3 0.6B (bf16)/model.safetensors'],
    });
    expect(vllmModelSource({ identity: identity(), local: local('/home/u/.cache/huggingface/hub/models--Qwen--Qwen3-0.6B/snapshots/abc123') })).toEqual({
      kind: 'local',
      hostDir: '/home/u/.cache/huggingface/hub/models--Qwen--Qwen3-0.6B',
      name: 'models--Qwen--Qwen3-0.6B',
      inner: 'snapshots/abc123',
      files: ['/home/u/.cache/huggingface/hub/models--Qwen--Qwen3-0.6B/snapshots/abc123/model.safetensors'],
    });
    expect(vllmModelSource({ identity: identity(), local: local('/') })).toMatchObject({ name: 'model' });
  });

  it('ignores local GGUF files and fails without a repo', () => {
    expect(() => vllmModelSource({ identity: identity({ format: 'gguf' }), local: local('/m') })).toThrow(expect.objectContaining({ code: 'MODEL_NOT_FOUND' }));
    expect(vllmModelSource({ identity: identity({ format: 'gguf', repo: 'r/q' }), local: local('/m') })).toEqual({ kind: 'repo', repo: 'r/q' });
  });
});

describe('vllmServeArgs', () => {
  it('writes every default explicitly', () => {
    const p = launchParamsSchema.parse({});
    expect(vllmServeArgs(p, { model: 'Qwen/Qwen3-0.6B', positional: true, host: '0.0.0.0', port: 8000, servedName: 'gpubench-x' })).toEqual([
      'Qwen/Qwen3-0.6B',
      '--served-model-name',
      'gpubench-x',
      '--host',
      '0.0.0.0',
      '--port',
      '8000',
      '--max-model-len',
      '4096',
      '--gpu-memory-utilization',
      '0.9',
      '--seed',
      '0',
    ]);
  });

  it('maps every launch parameter, legacy --model and revision', () => {
    const p = launchParamsSchema.parse({
      contextSize: 8192,
      maxModelLen: 16384,
      gpuMemoryUtilization: 0.8,
      parallel: 4,
      dtype: 'bfloat16',
      quantization: 'fp8',
      extraArgs: ['--enforce-eager'],
    });
    expect(vllmServeArgs(p, { model: 'a/b', positional: false, host: 'h', port: 1, servedName: 's', revision: 'r1' })).toEqual([
      '--model',
      'a/b',
      '--served-model-name',
      's',
      '--host',
      'h',
      '--port',
      '1',
      '--revision',
      'r1',
      '--max-model-len',
      '16384',
      '--gpu-memory-utilization',
      '0.8',
      '--max-num-seqs',
      '4',
      '--seed',
      '0',
      '--dtype',
      'bfloat16',
      '--quantization',
      'fp8',
      '--enforce-eager',
    ]);
    expect(vllmServeArgs(launchParamsSchema.parse({ contextSize: 2048 }), { model: 'm', positional: true, host: 'h', port: 1, servedName: 's' })).toContain('2048');
  });
});

describe('modelReadyProbe', () => {
  it('needs /health 200 and our name in /v1/models', async () => {
    let health = 503;
    let models: unknown = { data: [{ id: 'other' }] };
    const fetch = routeFetch({
      'http://e/health': () => new Response('', { status: health }),
      'http://e/v1/models': () => json(models),
    });
    const probe = modelReadyProbe(fetch, 'http://e', 'gpubench-x');
    const s = new AbortController().signal;
    expect(await probe(s)).toBe(false);
    health = 200;
    expect(await probe(s)).toBe(false);
    models = { data: [{ id: 'gpubench-x' }] };
    expect(await probe(s)).toBe(true);
    models = { models: [{ name: 'gpubench-x' }] };
    expect(await probe(s)).toBe(true);
    const broken = modelReadyProbe(routeFetch({ 'http://e/health': () => new Response('ok'), 'http://e/v1/models': () => json({}, 500) }), 'http://e', 'x');
    expect(await broken(s)).toBe(false);
  });

  it('parses model lists defensively', () => {
    expect(listsModel('not json', 'x')).toBe(false);
    expect(listsModel('{}', 'x')).toBe(false);
    expect(listsModel(JSON.stringify({ models: [{ model: 'x' }] }), 'x')).toBe(true);
  });
});
