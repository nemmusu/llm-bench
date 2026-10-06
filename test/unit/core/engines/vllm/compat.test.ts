import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BUILTIN_COMPAT,
  compareVersions,
  engineCompatSchema,
  loadEngineCompat,
  parseVllmTag,
  smFromComputeCap,
  suggestVllmTag,
  vllmCudaForTag,
  vllmPositionalModel,
  vllmTagOf,
  vllmTagSupportsSm,
  type EngineCompat,
} from '../../../../../src/core/engines/shared/compat';
import { RESOURCES, tempDir } from '../../docker/helpers';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

describe('engine-compat.json', () => {
  it('the shipped file is valid and has sources for its facts', async () => {
    const c = await loadEngineCompat(RESOURCES);
    expect(c).not.toBe(BUILTIN_COMPAT);
    expect(c.vllm.minTagBySm.sm_120).toBe('v0.9.2');
    expect(c.vllm.positionalModelFromTag).toBe('v0.12.0');
    expect(c.llamacpp.dockerImage).toBe('ghcr.io/ggml-org/llama.cpp:server-cuda');
    expect(c.sources.length).toBeGreaterThanOrEqual(5);
    expect(c.sources.every((s) => s.url.startsWith('https://'))).toBe(true);
    expect(parseVllmTag(c.vllm.recommendedTag)).toBeDefined();
  });

  it('falls back to built-in defaults when missing or invalid', async () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    expect(await loadEngineCompat(t.dir)).toBe(BUILTIN_COMPAT);
    mkdirSync(t.dir, { recursive: true });
    writeFileSync(path.join(t.dir, 'engine-compat.json'), JSON.stringify({ schema: 2 }));
    expect(await loadEngineCompat(t.dir)).toBe(BUILTIN_COMPAT);
    expect(engineCompatSchema.safeParse(BUILTIN_COMPAT).success).toBe(true);
  });
});

const compat: EngineCompat = {
  ...BUILTIN_COMPAT,
  vllm: {
    ...BUILTIN_COMPAT.vllm,
    recommendedTag: 'v0.31.0',
    minTagBySm: { sm_120: 'v0.9.2', sm_200: 'v0.40.0' },
    maxTagBySm: { sm_70: 'v0.19.1' },
    cudaByTag: [
      { fromTag: 'v0.9.2', cuda: '12.8' },
      { fromTag: 'v0.12.0', cuda: '12.9' },
      { fromTag: 'v0.20.0', cuda: '13.0' },
      { fromTag: 'garbage', cuda: '0' },
    ],
  },
};

describe('tag helpers', () => {
  it('parses and compares vLLM versions', () => {
    expect(parseVllmTag('v0.9.2')).toEqual([0, 9, 2, 0]);
    expect(parseVllmTag('v0.9.0.1')).toEqual([0, 9, 0, 1]);
    expect(parseVllmTag('0.31.0-cu129')).toEqual([0, 31, 0, 0]);
    expect(parseVllmTag('latest')).toBeUndefined();
    expect(compareVersions([0, 9, 2], [0, 9, 2, 0])).toBe(0);
    expect(compareVersions([0, 10], [0, 9, 9])).toBe(1);
    expect(compareVersions([0, 9], [0, 10])).toBe(-1);
    expect(smFromComputeCap('12.0')).toBe('sm_120');
    expect(smFromComputeCap(' 8.9 ')).toBe('sm_89');
    expect(smFromComputeCap('n/a')).toBeUndefined();
  });

  it('extracts the tag of vllm/vllm-openai references only', () => {
    expect(vllmTagOf('vllm/vllm-openai:v0.31.0', compat)).toBe('v0.31.0');
    expect(vllmTagOf('docker.io/vllm/vllm-openai:v0.9.2', compat)).toBe('v0.9.2');
    expect(vllmTagOf('vllm/vllm-openai', compat)).toBe('latest');
    expect(vllmTagOf(`vllm/vllm-openai@sha256:${'a'.repeat(64)}`, compat)).toBeUndefined();
    expect(vllmTagOf(`vllm/vllm-openai:v1.0.0@sha256:${'a'.repeat(64)}`, compat)).toBe('v1.0.0');
    expect(vllmTagOf('ghcr.io/me/vllm:v0.31.0', compat)).toBeUndefined();
    expect(vllmTagOf('ubuntu', compat)).toBeUndefined();
  });

  it('decides GPU support from the min/max tables', () => {
    expect(vllmTagSupportsSm(compat, 'v0.9.0', 'sm_120')).toBe(false);
    expect(vllmTagSupportsSm(compat, 'v0.9.2', 'sm_120')).toBe(true);
    expect(vllmTagSupportsSm(compat, 'v0.20.0', 'sm_70')).toBe(false);
    expect(vllmTagSupportsSm(compat, 'v0.19.1', 'sm_70')).toBe(true);
    expect(vllmTagSupportsSm(compat, 'v0.31.0', 'sm_89')).toBeUndefined();
    expect(vllmTagSupportsSm(compat, 'nightly', 'sm_120')).toBeUndefined();
    expect(vllmTagSupportsSm({ ...compat, vllm: { ...compat.vllm, minTagBySm: { sm_9: 'bad' } } }, 'v1.0.0', 'sm_9')).toBeUndefined();
  });

  it('suggests a compatible tag after "no kernel image"', () => {
    expect(suggestVllmTag(compat)).toBe('v0.31.0');
    expect(suggestVllmTag(compat, 'sm_120')).toBe('v0.31.0');
    expect(suggestVllmTag(compat, 'sm_70')).toBe('v0.19.1');
    expect(suggestVllmTag(compat, 'sm_200')).toBe('v0.40.0');
    expect(suggestVllmTag({ ...compat, vllm: { ...compat.vllm, recommendedTag: 'v0.1.0', minTagBySm: { sm_120: 'v0.9.2' }, maxTagBySm: {} } }, 'sm_120')).toBe('v0.9.2');
    const weird: EngineCompat = { ...compat, vllm: { ...compat.vllm, recommendedTag: 'v0.1.0', minTagBySm: {}, maxTagBySm: { sm_x: 'v0.0.1' } } };
    expect(suggestVllmTag(weird, 'sm_x')).toBe('v0.0.1');
  });

  it('chooses positional model vs --model by tag', () => {
    expect(vllmPositionalModel(compat, 'v0.11.0')).toBe(false);
    expect(vllmPositionalModel(compat, 'v0.12.0')).toBe(true);
    expect(vllmPositionalModel(compat, 'nightly')).toBe(true);
    expect(vllmPositionalModel(compat, undefined)).toBe(true);
    expect(vllmPositionalModel({ ...compat, vllm: { ...compat.vllm, positionalModelFromTag: '?' } }, 'v0.1.0')).toBe(true);
  });

  it('maps tags to the image CUDA version', () => {
    expect(vllmCudaForTag(compat, 'v0.9.0')).toBeUndefined();
    expect(vllmCudaForTag(compat, 'v0.11.0')).toBe('12.8');
    expect(vllmCudaForTag(compat, 'v0.15.1')).toBe('12.9');
    expect(vllmCudaForTag(compat, 'v0.31.0')).toBe('13.0');
    expect(vllmCudaForTag(compat, 'v0.31.0-cu129')).toBe('12.9');
    expect(vllmCudaForTag(compat, 'latest')).toBeUndefined();
  });
});

describe('compareVersions edge', () => {
  it('treats missing trailing parts as zero on either side', () => {
    expect(compareVersions([0, 10, 0], [0, 10])).toBe(0);
    expect(compareVersions([0, 10, 1], [0, 10])).toBe(1);
  });
});
