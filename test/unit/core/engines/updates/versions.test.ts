import { describe, expect, it } from 'vitest';
import { compareVersions, newerTag, packageOf, parseVersion, pypiLatest } from '../../../../../src/core/engines/updates/versions';
import { json, routeFetch } from '../../docker/helpers';

const v = (s: string) => parseVersion(s)!;

describe('versions of tags and releases', () => {
  it('reads release numbers, .post, pre-releases and the tag family', () => {
    expect(parseVersion('v0.5.20.post1-cu129')).toEqual({ nums: [0, 5, 20], post: 1, pre: false, family: '-cu129' });
    expect(parseVersion('0.11.2+cu129')).toEqual({ nums: [0, 11, 2], post: 0, pre: false, family: '+cu129' });
    expect(parseVersion('0.5.0rc1')).toMatchObject({ pre: true, family: '' });
    expect(parseVersion('1.0.0.dev20251001')).toMatchObject({ nums: [1, 0, 0], pre: true });
    expect(parseVersion('latest')).toBeUndefined();
  });

  it('orders them like PyPI and Docker tags', () => {
    expect(compareVersions(v('v0.10.1.1'), v('v0.10.1'))).toBeGreaterThan(0);
    expect(compareVersions(v('0.5.21'), v('0.5.21.post1'))).toBeLessThan(0);
    expect(compareVersions(v('0.5.0rc1'), v('0.5.0'))).toBeLessThan(0);
    expect(compareVersions(v('0.5.0'), v('0.5.0rc1'))).toBeGreaterThan(0);
    expect(compareVersions(v('0.11'), v('0.11.0'))).toBe(0);
  });

  it('the newest tag of the same family, newer than the one in use', () => {
    const tags = [{ name: 'v0.5.22-cu130' }, { name: 'v0.5.23' }, { name: 'v0.5.22' }, { name: 'v0.6.0rc1' }, { name: 'latest' }, { name: 'v0.5.20' }];
    expect(newerTag('v0.5.21', tags)?.name).toBe('v0.5.23');
    expect(newerTag('v0.5.21-cu130', tags)?.name).toBe('v0.5.22-cu130');
    expect(newerTag('v0.5.23', tags)).toBeUndefined();
    // A moving tag or a pre-release is not compared by number.
    expect(newerTag('latest', tags)).toBeUndefined();
    expect(newerTag('v0.6.0rc1', tags)).toBeUndefined();
  });

  it('package names in a uv requirement', () => {
    expect(packageOf('vllm')).toEqual({ name: 'vllm', extras: '' });
    expect(packageOf('sglang[all]>=0.5')).toEqual({ name: 'sglang', extras: '[all]' });
    expect(packageOf('  ')).toEqual({ name: '', extras: '' });
  });
});

describe('PyPI', () => {
  const release = (urls: unknown[]) => ({ info: { version: '0.11.2' }, urls });

  it('the newest version and the size of its Linux wheel', async () => {
    const fetch = routeFetch({
      'https://pypi.test/pypi/vllm/json': () =>
        json(
          release([
            { filename: 'vllm-0.11.2.tar.gz', size: 9_000_000, packagetype: 'sdist' },
            { filename: 'vllm-0.11.2-cp38-abi3-manylinux1_x86_64.whl', size: 400_000_000 },
            { filename: 'vllm-0.11.2-cp312-cp312-manylinux_2_28_x86_64.whl', size: 390_000_000 },
            { filename: 'vllm-0.11.2-cp38-abi3-manylinux2014_aarch64.whl', size: 900_000_000 },
            { filename: 42 },
          ]),
        ),
      'https://pypi.test/pypi/pure/json': () => json(release([{ filename: 'pure-1.0-py3-none-any.whl', size: 5 }, { filename: 'pure-1.0.tar.gz', size: 9 }])),
      'https://pypi.test/pypi/empty/json': () => json({ info: { version: '1.0' } }),
    });
    expect(await pypiLatest(fetch, 'https://pypi.test/', 'vllm')).toEqual({ version: '0.11.2', sizeBytes: 400_000_000 });
    expect(await pypiLatest(fetch, 'https://pypi.test', 'pure')).toEqual({ version: '0.11.2', sizeBytes: 9 });
    expect(await pypiLatest(fetch, 'https://pypi.test', 'empty')).toEqual({ version: '1.0' });
  });

  it('network errors, HTTP errors and a reply without a version', async () => {
    const fetch = routeFetch({
      'https://pypi.test/pypi/gone/json': () => json({}, 404),
      'https://pypi.test/pypi/odd/json': () => json({ info: {} }),
    });
    await expect(pypiLatest(fetch, 'https://pypi.test', 'gone')).rejects.toMatchObject({ code: 'NETWORK', params: { status: 404 } });
    await expect(pypiLatest(fetch, 'https://pypi.test', 'odd')).rejects.toMatchObject({ code: 'NETWORK', params: { reason: 'no-version' } });
    const down = (() => Promise.reject(new Error('offline'))) as unknown as typeof globalThis.fetch;
    await expect(pypiLatest(down, 'https://pypi.test', 'vllm', new AbortController().signal)).rejects.toMatchObject({ code: 'NETWORK', params: { service: 'pypi' } });
  });
});
