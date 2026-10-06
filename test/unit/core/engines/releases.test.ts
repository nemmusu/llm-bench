import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LlamaRelease } from '../../../../src/contract/api';
import { AppError } from '../../../../src/contract/errors';
import {
  LlamaReleasesClient,
  buildNumber,
  compareVersions,
  parseReleases,
  selectAssets,
} from '../../../../src/core/engines/llamacpp-native/releases';
import { startFakeGithub, type FakeGithub } from '../../../fakes/fake-github/server.mjs';

const FIXTURE = JSON.parse(readFileSync(new URL('../../../fixtures/github/llamacpp-releases.json', import.meta.url), 'utf8')) as unknown[];
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'gb-rel-'));

describe('parseReleases (real GitHub payload)', () => {
  const releases = parseReleases(FIXTURE);

  it('keeps bNNNNN tags only, newest first, with sha256 digests', () => {
    expect(releases.map((r) => r.tag)).toEqual(['b11438', 'b11436', 'b11435', 'b11433']);
    const first = releases[0] as LlamaRelease;
    expect(first.publishedAt).toBe('2026-10-06T10:01:50Z');
    const asset = first.assets.find((a) => a.name === 'llama-b11438-bin-win-cuda-13.4-x64.zip');
    expect(asset?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(asset?.url).toMatch(/^https:\/\/github\.com\/ggml-org\/llama\.cpp\/releases\/download\/b11438\//);
  });

  it('tolerates odd entries', () => {
    expect(() => parseReleases({})).toThrow(AppError);
    const odd = parseReleases([
      { tag_name: 'b2', draft: true, assets: [] },
      { tag_name: 'b3', assets: 'nope' },
      { tag_name: 7 },
      { tag_name: 'b4', published_at: 5, assets: [{ name: 'a' }, { name: 'x.zip', browser_download_url: 'u', size: 'big', digest: 'md5:1' }] },
    ]);
    expect(odd).toEqual([
      { tag: 'b4', publishedAt: '', assets: [{ name: 'x.zip', url: 'u', size: 0 }] },
      { tag: 'b3', publishedAt: '', assets: [] },
    ]);
    expect(buildNumber('v1')).toBe(-1);
  });

  it('compares dotted versions numerically', () => {
    expect(compareVersions('12.10', '12.4')).toBeGreaterThan(0);
    expect(compareVersions('13.4', '13.4.0')).toBe(0);
    expect(compareVersions('12', '12.8')).toBeLessThan(0);
    expect(compareVersions('13.4.1', '13.4')).toBeGreaterThan(0);
  });
});

describe('selectAssets', () => {
  const rel = parseReleases(FIXTURE)[0] as LlamaRelease;

  it('Windows x64: highest CUDA ≤ driver, with its cudart', () => {
    const s = selectAssets(rel, { platform: 'win32', arch: 'x64', cudaVersion: '13.4' });
    expect(s?.main.name).toBe('llama-b11438-bin-win-cuda-13.4-x64.zip');
    expect(s?.cudart?.name).toBe('cudart-llama-bin-win-cuda-13.4-x64.zip');
    expect(s?.variant).toBe('cuda-13.4');
    const older = selectAssets(rel, { platform: 'win32', arch: 'x64', cudaVersion: '13.0' });
    expect(older?.main.name).toBe('llama-b11438-bin-win-cuda-12.4-x64.zip');
    expect(older?.cudart?.name).toBe('cudart-llama-bin-win-cuda-12.4-x64.zip');
  });

  it('Linux x64: ubuntu tarballs, cudart carries the tag', () => {
    const s = selectAssets(rel, { platform: 'linux', arch: 'x64', cudaVersion: '12.9' });
    expect(s?.main.name).toBe('llama-b11438-bin-ubuntu-cuda-12.8-x64.tar.gz');
    expect(s?.cudart?.name).toBe('cudart-llama-b11438-bin-ubuntu-cuda-12.8-x64.tar.gz');
  });

  it('falls back to Vulkan, then CPU; arm64 analogues', () => {
    expect(selectAssets(rel, { platform: 'win32', arch: 'x64', cudaVersion: '11.8' })?.main.name).toBe('llama-b11438-bin-win-vulkan-x64.zip');
    expect(selectAssets(rel, { platform: 'linux', arch: 'x64' })?.variant).toBe('vulkan');
    expect(selectAssets(rel, { platform: 'linux', arch: 'x64', prefer: ['cpu'] })?.main.name).toBe('llama-b11438-bin-ubuntu-x64.tar.gz');
    expect(selectAssets(rel, { platform: 'win32', arch: 'x64', prefer: ['cpu'] })?.main.name).toBe('llama-b11438-bin-win-cpu-x64.zip');
    expect(selectAssets(rel, { platform: 'win32', arch: 'arm64', cudaVersion: '13.4' })?.main.name).toBe('llama-b11438-bin-win-cuda-13.4-arm64.zip');
    expect(selectAssets(rel, { platform: 'linux', arch: 'arm64', cudaVersion: '13.4' })?.cudart?.name).toBe(
      'cudart-llama-b11438-bin-ubuntu-cuda-13.4-arm64.tar.gz',
    );
    expect(selectAssets(rel, { platform: 'linux', arch: 'arm64', prefer: ['cpu'] })?.main.name).toBe('llama-b11438-bin-ubuntu-arm64.tar.gz');
  });

  it('honours an explicit variant, and returns undefined when nothing fits', () => {
    expect(selectAssets(rel, { platform: 'win32', arch: 'x64', variant: 'cuda-12.4' })?.main.name).toBe('llama-b11438-bin-win-cuda-12.4-x64.zip');
    expect(selectAssets(rel, { platform: 'win32', arch: 'x64', variant: 'cuda-99' })).toBeUndefined();
    expect(selectAssets(rel, { platform: 'darwin', arch: 'arm64' })).toBeUndefined();
    expect(selectAssets(rel, { platform: 'linux', arch: 'riscv64' })).toBeUndefined();
    // A CUDA build without its runtime archive is not installable.
    const noCudart = { ...rel, assets: rel.assets.filter((a) => !a.name.startsWith('cudart-')) };
    expect(selectAssets(noCudart, { platform: 'win32', arch: 'x64', cudaVersion: '13.4', prefer: ['cuda'] })).toBeUndefined();
  });
});

describe('LlamaReleasesClient', () => {
  let gh: FakeGithub;
  beforeAll(async () => {
    gh = await startFakeGithub();
  });
  afterAll(() => gh.close());

  it('lists releases, then revalidates with the ETag (304 served from cache)', async () => {
    gh.set({ rateLimited: false });
    const cacheDir = tmp();
    const client = new LlamaReleasesClient({ fetch, githubApi: `${gh.url}/`, cacheDir, appVersion: '1.2.3' });
    const first = await client.list();
    expect(first.map((r) => r.tag)).toEqual(['b11438', 'b11436', 'b11435', 'b11433']);
    expect(first[0]?.assets[0]?.url.startsWith(gh.url)).toBe(true);
    const before = gh.requests.length;
    const second = await client.list();
    expect(second).toEqual(first);
    const req = gh.requests[before];
    expect(req?.url).toBe('/repos/ggml-org/llama.cpp/releases?per_page=30');
    expect(req?.headers['if-none-match']).toMatch(/^W\//);
    expect(req?.headers['user-agent']).toBe('gpu-bench/1.2.3');
  });

  it('rate limited: GITHUB_RATE_LIMITED with the reset time, or the stale cache when there is one', async () => {
    const cacheDir = tmp();
    const client = new LlamaReleasesClient({ fetch, githubApi: gh.url, cacheDir, perPage: 5 });
    gh.set({ rateLimited: true });
    const err = await client.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('GITHUB_RATE_LIMITED');
    expect((err as AppError).params?.resetAt).toMatch(/^\d{4}-/);
    gh.set({ rateLimited: false });
    const fresh = await client.list();
    gh.set({ rateLimited: true });
    expect(await client.list()).toEqual(fresh);
    gh.set({ rateLimited: false });
  });

  it('429 without a reset header', async () => {
    const fakeFetch = (async () => new Response('slow down', { status: 429 })) as typeof fetch;
    const client = new LlamaReleasesClient({ fetch: fakeFetch, githubApi: 'http://x', cacheDir: tmp() });
    await expect(client.list()).rejects.toMatchObject({ code: 'GITHUB_RATE_LIMITED', params: {} });
  });

  it('network errors and HTTP errors fall back to the cache, else NETWORK; abort → CANCELLED', async () => {
    const cacheDir = tmp();
    const good = new LlamaReleasesClient({ fetch, githubApi: gh.url, cacheDir });
    const cached = await good.list();

    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    expect(await new LlamaReleasesClient({ fetch: down, githubApi: gh.url, cacheDir }).list()).toEqual(cached);
    await expect(new LlamaReleasesClient({ fetch: down, githubApi: gh.url, cacheDir: tmp() }).list()).rejects.toMatchObject({ code: 'NETWORK' });

    const err500 = (async () => new Response('x', { status: 500 })) as typeof fetch;
    expect(await new LlamaReleasesClient({ fetch: err500, githubApi: gh.url, cacheDir }).list()).toEqual(cached);
    await expect(new LlamaReleasesClient({ fetch: err500, githubApi: gh.url, cacheDir: tmp() }).list()).rejects.toMatchObject({
      code: 'NETWORK',
      params: { status: 500 },
    });

    const ac = new AbortController();
    ac.abort();
    await expect(new LlamaReleasesClient({ fetch, githubApi: gh.url, cacheDir }).list(ac.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('ignores a cache for another URL, a corrupt cache, and cache write failures', async () => {
    const cacheDir = tmp();
    writeFileSync(path.join(cacheDir, 'github-llamacpp-releases.json'), JSON.stringify({ url: 'other', etag: 'x', body: [] }));
    const client = new LlamaReleasesClient({ fetch, githubApi: gh.url, cacheDir });
    expect((await client.list()).length).toBe(4);
    writeFileSync(path.join(cacheDir, 'github-llamacpp-releases.json'), '{corrupt');
    expect((await client.list()).length).toBe(4);

    const fileAsDir = path.join(tmp(), 'file');
    writeFileSync(fileAsDir, 'x');
    expect((await new LlamaReleasesClient({ fetch, githubApi: gh.url, cacheDir: fileAsDir }).list()).length).toBe(4);

    const noEtag = (async () => new Response(JSON.stringify(FIXTURE), { status: 200 })) as typeof fetch;
    const dir2 = tmp();
    expect((await new LlamaReleasesClient({ fetch: noEtag, githubApi: gh.url, cacheDir: dir2 }).list()).length).toBe(4);
    expect(() => readFileSync(path.join(dir2, 'github-llamacpp-releases.json'))).toThrow();
  });
});
