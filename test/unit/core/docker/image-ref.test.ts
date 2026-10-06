import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../../../src/contract/errors';
import { digestFor, displayRepo, isDockerHub, parseImageRef, refVersion } from '../../../../src/core/docker/image-ref';

describe('parseImageRef', () => {
  it('parses Hub, ghcr, localhost and digest references', () => {
    expect(parseImageRef('vllm/vllm-openai:v0.31.0')).toEqual({ repository: 'vllm/vllm-openai', tag: 'v0.31.0' });
    expect(parseImageRef('ubuntu')).toEqual({ repository: 'library/ubuntu' });
    expect(parseImageRef('docker.io/vllm/vllm-openai')).toEqual({ repository: 'vllm/vllm-openai' });
    expect(parseImageRef('ghcr.io/ggml-org/llama.cpp:server-cuda')).toEqual({
      registry: 'ghcr.io',
      repository: 'ggml-org/llama.cpp',
      tag: 'server-cuda',
    });
    expect(parseImageRef('localhost:5000/team/img:1.0')).toEqual({ registry: 'localhost:5000', repository: 'team/img', tag: '1.0' });
    expect(parseImageRef('localhost/img')).toEqual({ registry: 'localhost', repository: 'img' });
    const d = `sha256:${'a'.repeat(64)}`;
    expect(parseImageRef(`vllm/vllm-openai@${d}`)).toEqual({ repository: 'vllm/vllm-openai', digest: d });
    expect(parseImageRef(`vllm/vllm-openai:v1@${d}`)).toEqual({ repository: 'vllm/vllm-openai', tag: 'v1', digest: d });
  });

  it('rejects anything that could be read as a flag or is malformed', () => {
    for (const bad of ['', ' x', '-rm', '--privileged', 'Upper/Case', 'a:b:c', 'img:', 'img@sha256:zz', 'my host/x', 'bad_host.:1/x', 'x/', 'a//b']) {
      expect(() => parseImageRef(bad), bad).toThrow(AppError);
    }
    try {
      parseImageRef('-x');
    } catch (e) {
      expect((e as AppError).code).toBe('VALIDATION');
      expect((e as AppError).params).toEqual({ image: '-x' });
    }
  });

  it('never accepts a reference starting with "-" (property)', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const ref = `-${s}`;
        expect(() => parseImageRef(ref)).toThrow(AppError);
      }),
    );
  });

  it('round-trips names through displayRepo/refVersion', () => {
    expect(isDockerHub(parseImageRef('ubuntu'))).toBe(true);
    expect(isDockerHub(parseImageRef('ghcr.io/a/b'))).toBe(false);
    expect(displayRepo(parseImageRef('ubuntu:24.04'))).toBe('ubuntu');
    expect(displayRepo(parseImageRef('vllm/vllm-openai'))).toBe('vllm/vllm-openai');
    expect(displayRepo(parseImageRef('ghcr.io/a/b:c'))).toBe('ghcr.io/a/b');
    expect(refVersion(parseImageRef('a/b'))).toBe('latest');
    expect(refVersion(parseImageRef('a/b:t'))).toBe('t');
    const d = `sha256:${'b'.repeat(64)}`;
    expect(refVersion(parseImageRef(`a/b:t@${d}`))).toBe(d);
  });
});

describe('digestFor', () => {
  it('picks the digest of the matching repository', () => {
    const digests = ['other/name@sha256:111', 'vllm/vllm-openai@sha256:222'];
    expect(digestFor('vllm/vllm-openai:v0.31.0', digests)).toBe('sha256:222');
    expect(digestFor('ghcr.io/x/y:z', ['ghcr.io/x/y@sha256:333'])).toBe('sha256:333');
  });
  it('falls back to the first entry, or undefined', () => {
    expect(digestFor('a/b:c', ['zzz/q@sha256:9'])).toBe('sha256:9');
    expect(digestFor('a/b:c', [])).toBeUndefined();
    expect(digestFor('NOT VALID', ['x/y@sha256:7'])).toBe('sha256:7');
    expect(digestFor('a/b', ['a/b@'])).toBeUndefined();
  });
});
