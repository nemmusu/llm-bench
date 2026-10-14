// TensorRT-LLM's release tags and NVIDIA's registry (NGC), with a recorded-shape fake of nvcr.io.
import { describe, expect, it } from 'vitest';
import { NgcRegistry } from '../../../../../src/core/engines/trtllm-docker/ngc';
import { compareTrtllmTags, isTrtllmReleaseTag, newerTrtllmTag, parseTrtllmTag } from '../../../../../src/core/engines/trtllm-docker/tags';

describe('TensorRT-LLM tags', () => {
  it('reads releases and release candidates, nothing else', () => {
    expect(parseTrtllmTag('1.2.1')).toEqual({ nums: [1, 2, 1], post: 0 });
    expect(parseTrtllmTag('1.2.0rc6.post2')).toEqual({ nums: [1, 2, 0], rc: 6, post: 2 });
    for (const t of ['1.4.0rc1.dev202610140007', 'gb300-ea', 'sha256-00e7.sig', 'latest']) expect(isTrtllmReleaseTag(t)).toBe(false);
  });

  it('orders them: rcN before the release, .postN after', () => {
    const tags = ['1.2.0', '1.2.0rc6.post2', '1.2.0rc6', '1.3.0rc10', '1.3.0rc9', 'x', '1.2.1'];
    expect([...tags].sort(compareTrtllmTags)).toEqual(['x', '1.2.0rc6', '1.2.0rc6.post2', '1.2.0', '1.2.1', '1.3.0rc9', '1.3.0rc10']);
    expect(compareTrtllmTags('x', 'y')).toBe(0);
    expect(compareTrtllmTags('1.0.0', 'x')).toBe(1);
  });

  it('offers a stable release only stable ones, a candidate any newer release', () => {
    const tags = ['1.2.1', '1.3.0rc29', '1.4.0rc0', '1.4.0rc1', '1.2.0', 'nightly'].map((name) => ({ name }));
    expect(newerTrtllmTag('1.2.0', tags)?.name).toBe('1.2.1');
    expect(newerTrtllmTag('1.2.1', tags)).toBeUndefined();
    expect(newerTrtllmTag('1.4.0rc0', tags)?.name).toBe('1.4.0rc1');
    expect(newerTrtllmTag('1.3.0rc5', [{ name: '1.3.0rc6' }, { name: '1.3.0' }, { name: '1.3.0rc7' }])?.name).toBe('1.3.0');
    expect(newerTrtllmTag('latest', tags)).toBeUndefined();
  });
});

const INDEX = 'application/vnd.oci.image.index.v1+json';

/** A small nvcr.io: an anonymous token, a tag list over two pages, an index and a manifest. */
function fakeNgc(o: { noToken?: boolean; status?: number; down?: boolean; plain?: boolean; noAmd64?: boolean; armOnly?: boolean; noLink?: boolean } = {}) {
  const calls: string[] = [];
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (o.down) throw new Error('ECONNREFUSED');
    const res = (body: unknown, headers: Record<string, string> = {}, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
    if (url.includes('/proxy_auth?')) return o.noToken ? res({}) : res({ token: 'tok', expires_in: 600 });
    if ((init?.headers as Record<string, string>).authorization !== 'Bearer tok') return res({}, {}, 401);
    if (o.status) return res({ errors: [] }, {}, o.status);
    if (url.endsWith('/v2/nvidia/tensorrt-llm/release/tags/list') && o.noLink) return res({ name: REPO });
    if (url.endsWith('/v2/nvidia/tensorrt-llm/release/tags/list')) return res({ tags: ['1.2.1', 5, '1.4.0rc0'] }, { link: '</v2/nvidia/tensorrt-llm/release/tags/list?last=1.4.0rc0&n=2>; rel="next"' });
    if (url.includes('tags/list?last=')) return res({ tags: ['1.4.0rc1.dev1'] }, { link: '<https://elsewhere.test/v2/x>; rel="next"' });
    if (url.includes('/manifests/1.4.0rc0')) {
      if (o.plain) return res({ layers: [{ size: 10 }, { size: 'x' }], config: { size: 2 } }, { 'docker-content-digest': 'sha256:plain' });
      const manifests = [{ digest: 'sha256:att' }, { digest: 'sha256:arm', platform: { architecture: 'arm64', os: 'linux' } }, ...(o.armOnly ? [] : o.noAmd64 ? [{ platform: { architecture: 'amd64', os: 'linux' } }] : [{ digest: 'sha256:amd', platform: { architecture: 'amd64' } }])];
      return res({ mediaType: INDEX, manifests }, o.armOnly ? {} : { 'docker-content-digest': 'sha256:index' });
    }
    if (url.includes('/manifests/sha256:amd')) return res({ layers: [{ size: 100 }, { size: 50 }], config: { size: 5 } });
    if (url.includes('/manifests/empty')) return res({});
    return res({}, {}, 404);
  }) as typeof globalThis.fetch;
  let now = 0;
  const reg = new NgcRegistry({ fetch, baseUrl: 'https://nvcr.test/', clock: { now: () => now } });
  return { reg, calls, tick: (ms: number) => (now += ms) };
}

const REPO = 'nvidia/tensorrt-llm/release';

describe('NGC registry', () => {
  it('lists tags with an anonymous token, following its own next pages only, cached', async () => {
    const f = fakeNgc();
    expect(await f.reg.listTags(REPO)).toEqual(['1.2.1', '1.4.0rc0', '1.4.0rc1.dev1']);
    expect(f.calls[0]).toBe('https://nvcr.test/proxy_auth?scope=repository%3Anvidia%2Ftensorrt-llm%2Frelease%3Apull');
    const n = f.calls.length;
    await f.reg.listTags(REPO);
    expect(f.calls.length).toBe(n);
    await f.reg.listTags(REPO, { refresh: true });
    expect(f.calls.length).toBeGreaterThan(n);
    f.tick(700_000);
    const m = f.calls.length;
    await f.reg.listTags(REPO);
    expect(f.calls.length).toBeGreaterThan(m);
    expect(await fakeNgc({ noLink: true }).reg.listTags(REPO)).toEqual([]);
  });

  it('reads a tag’s digest (its index) and the linux/amd64 download size', async () => {
    expect(await fakeNgc().reg.tagInfo(REPO, '1.4.0rc0')).toEqual({ name: '1.4.0rc0', sizeBytes: 155, digest: 'sha256:index' });
    expect(await fakeNgc({ plain: true }).reg.tagInfo(REPO, '1.4.0rc0')).toEqual({ name: '1.4.0rc0', sizeBytes: 12, digest: 'sha256:plain' });
    expect(await fakeNgc({ noAmd64: true }).reg.tagInfo(REPO, '1.4.0rc0')).toEqual({ name: '1.4.0rc0', digest: 'sha256:index' });
    expect(await fakeNgc({ armOnly: true }).reg.tagInfo(REPO, '1.4.0rc0')).toEqual({ name: '1.4.0rc0' });
    expect(await fakeNgc().reg.tagInfo(REPO, 'empty')).toEqual({ name: 'empty' });
  });

  it('says why the registry cannot answer', async () => {
    await expect(fakeNgc({ down: true }).reg.listTags(REPO)).rejects.toMatchObject({ code: 'NETWORK', params: { service: 'ngc' } });
    await expect(fakeNgc({ status: 429 }).reg.listTags(REPO)).rejects.toMatchObject({ code: 'NETWORK', params: { status: 429, reason: 'rate-limited' } });
    await expect(fakeNgc({ status: 500 }).reg.tagInfo(REPO, '1.2.1')).rejects.toMatchObject({ params: { reason: 'http' } });
    await expect(fakeNgc({ noToken: true }).reg.listTags(REPO, { signal: new AbortController().signal })).rejects.toMatchObject({ params: { reason: 'no-token' } });
    // A failure is not kept: the next call asks again.
    const f = fakeNgc({ status: 500 });
    await expect(f.reg.listTags(REPO)).rejects.toBeDefined();
    const n = f.calls.length;
    await expect(f.reg.listTags(REPO)).rejects.toBeDefined();
    expect(f.calls.length).toBeGreaterThan(n);
  });
});
