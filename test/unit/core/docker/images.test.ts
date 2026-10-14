import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../../../../src/contract/errors';
import { DockerApiProvider } from '../../../../src/core/docker/api-provider';
import { DockerCli } from '../../../../src/core/docker/cli';
import { DockerApi } from '../../../../src/core/docker/client';
import type { DockerEndpoint } from '../../../../src/core/docker/endpoint';
import { DockerHubClient } from '../../../../src/core/docker/hub';
import { ImageService } from '../../../../src/core/docker/images';
import type { PullProgress } from '../../../../src/core/docker/pull-progress';
import { createDockerServices } from '../../../../src/core/docker/services';
import { randomSocketPath, startFakeDockerApi, type FakeDockerApi } from '../../../fakes/fake-docker/api.mjs';
import { DOCKER_FIXTURES, fail, json, manualProcess, ok, recordingLog, routeFetch, scriptedProc, silentLog, steppingClock } from './helpers';

let api: FakeDockerApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

const sock = (p: string, source: DockerEndpoint['source'] = 'default'): DockerEndpoint => ({ kind: 'socket', path: p, source });

describe('DockerApiProvider', () => {
  it('picks the first endpoint that answers and caches it', async () => {
    api = await startFakeDockerApi();
    let resolves = 0;
    const p = new DockerApiProvider({
      resolve: async () => {
        resolves++;
        return [sock(randomSocketPath()), sock(api!.socketPath)];
      },
    });
    const a = await p.get();
    expect(a.label).toBe(api.socketPath);
    expect(await p.get()).toBe(a);
    expect(resolves).toBe(1);
    p.reset();
    await p.get();
    expect(resolves).toBe(2);
  });

  it('accepts a starting daemon (500 on ping) as reachable', async () => {
    api = await startFakeDockerApi({ mode: 'starting' });
    const p = new DockerApiProvider({ resolve: async () => [sock(api!.socketPath)] });
    expect((await p.get()).label).toBe(api.socketPath);
  });

  it('prefers a permission error over "not running", and does not cache failures', async () => {
    let calls = 0;
    const p = new DockerApiProvider({
      resolve: async () => [sock('a'), sock('b'), sock('c')],
      create: (e) => {
        calls++;
        const api = new DockerApi(e);
        api.ping = async () => {
          if (e.kind === 'socket' && e.path === 'b') throw new AppError('DOCKER_PERMISSION', 'denied');
          if (e.kind === 'socket' && e.path === 'c') throw new Error('weird');
          throw new AppError('DOCKER_NOT_RUNNING', 'down');
        };
        return api;
      },
      pingTimeoutMs: 10,
    });
    await expect(p.get()).rejects.toMatchObject({ code: 'DOCKER_PERMISSION' });
    await expect(p.get()).rejects.toMatchObject({ code: 'DOCKER_PERMISSION' });
    expect(calls).toBe(6);
    const down = new DockerApiProvider({ resolve: async () => [sock(randomSocketPath())] });
    await expect(down.get()).rejects.toMatchObject({ code: 'DOCKER_NOT_RUNNING' });
    const weird = new DockerApiProvider({
      resolve: async () => [sock('x')],
      create: (e) => Object.assign(new DockerApi(e), { ping: () => Promise.reject(new Error('odd')) }),
    });
    await expect(weird.get()).rejects.toMatchObject({ code: 'DOCKER_NOT_RUNNING', message: 'Error: odd' });
  });

  it('refuses TLS-only configurations', async () => {
    const p = new DockerApiProvider({ resolve: async () => [{ kind: 'tcp', host: 'h', port: 2376, tls: true, source: 'env' }] });
    await expect(p.get()).rejects.toMatchObject({ code: 'DOCKER_UNSUPPORTED', params: { reason: 'tls-endpoint' } });
  });

  it('keeps a newer pick when an older failed pick settles late', async () => {
    let n = 0;
    const p = new DockerApiProvider({
      resolve: async () => {
        n++;
        if (n === 1) throw new AppError('DOCKER_NOT_RUNNING', 'first');
        return [sock(api!.socketPath)];
      },
    });
    api = await startFakeDockerApi();
    const first = p.get();
    p.reset();
    const second = p.get();
    await expect(first).rejects.toThrow('first');
    await second;
    expect(await p.get()).toBe(await second);
  });
});

describe('DockerHubClient', () => {
  const tagsFixture = JSON.parse(readFileSync(path.join(DOCKER_FIXTURES, 'hub-tags-vllm.json'), 'utf8')) as { results: unknown[] };

  it('lists tags with amd64 sizes from the real Hub format, cached', async () => {
    const fetch = routeFetch({ 'https://hub.test/v2/repositories/vllm/vllm-openai/tags?': () => json(tagsFixture) });
    const clock = steppingClock();
    const hub = new DockerHubClient({ fetch, baseUrl: 'https://hub.test/', clock });
    const tags = await hub.listTags('vllm/vllm-openai', 'v');
    expect(fetch.urls[0]).toBe('https://hub.test/v2/repositories/vllm/vllm-openai/tags?page_size=100&ordering=last_updated&name=v');
    const v031 = tags.find((t) => t.name === 'v0.31.0');
    expect(v031).toEqual({
      name: 'v0.31.0',
      lastUpdated: '2026-10-04T01:11:23.53217Z',
      sizeBytes: 9035211086,
      digest: 'sha256:c1c9f6fd5c109ba7f0546a59f5b2f15fb87f64c77782e90a27b648b42a8e67c3',
      // The index and each platform's manifest: whichever a local image is listed by.
      digests: [
        'sha256:c1c9f6fd5c109ba7f0546a59f5b2f15fb87f64c77782e90a27b648b42a8e67c3',
        'sha256:a4a4c0437bf7240089da5f08aa370c4aee17ae5290f7a3b468825ee26c4c3a6b',
        'sha256:3f7dd5b777d34d1724456ce71f87385dca288c3bb23029ab27dee358f5d2b971',
      ],
    });
    await hub.listTags('vllm/vllm-openai', 'v');
    expect(fetch.urls).toHaveLength(1);
    clock.t += 700_000;
    await hub.listTags('vllm/vllm-openai', 'v');
    await hub.listTags('vllm/vllm-openai', 'v', { refresh: true });
    expect(fetch.urls).toHaveLength(3);
  });

  it('follows pagination on the same host only, up to maxPages', async () => {
    const page = (next: string | null, name: string) => json({ next, results: [{ name, full_size: 5 }, { nope: 1 }] });
    const fetch = routeFetch({
      'https://hub.test/v2/repositories/a/b/tags?page_size': () => page('https://hub.test/v2/repositories/a/b/tags?page=2', 'one'),
      'https://hub.test/v2/repositories/a/b/tags?page=2': () => page('https://evil.example/x', 'two'),
    });
    const hub = new DockerHubClient({ fetch, baseUrl: 'https://hub.test', clock: steppingClock(), maxPages: 5 });
    expect((await hub.listTags('a/b')).map((t) => t.name)).toEqual(['one', 'two']);
    expect(fetch.urls).toHaveLength(2);
    const limited = new DockerHubClient({ fetch, baseUrl: 'https://hub.test', clock: steppingClock(), maxPages: 1 });
    expect(await limited.listTags('a/b')).toEqual([{ name: 'one', sizeBytes: 5 }]);
  });

  it('maps errors and unknown repositories', async () => {
    const fetch = routeFetch({
      'https://hub.test/v2/repositories/none/x/': () => json({ message: 'not found' }, 404),
      'https://hub.test/v2/repositories/limit/x/': () => json({}, 429),
      'https://hub.test/v2/repositories/empty/x/': () => json({}),
    });
    const hub = new DockerHubClient({ fetch, baseUrl: 'https://hub.test', clock: steppingClock() });
    expect(await hub.listTags('none/x')).toEqual([]);
    expect(await hub.listTags('empty/x')).toEqual([]);
    await expect(hub.listTags('limit/x')).rejects.toMatchObject({ code: 'NETWORK', params: { status: 429, reason: 'rate-limited' } });
    await expect(hub.listTags('offline/x')).rejects.toMatchObject({ code: 'NETWORK' });
    // A failed listing is not cached.
    await expect(hub.listTags('limit/x')).rejects.toThrow(AppError);
    expect(fetch.urls.filter((u) => u.includes('limit'))).toHaveLength(2);
    const http500 = new DockerHubClient({ fetch: routeFetch({ 'https://hub.test': () => json({}, 500) }), baseUrl: 'https://hub.test', clock: steppingClock() });
    await expect(http500.listTags('a/b')).rejects.toMatchObject({ params: { reason: 'http' } });
  });

  it('looks up the download size of Hub images only', async () => {
    const fetch = routeFetch({
      'https://hub.test/v2/repositories/vllm/vllm-openai/tags/v0.31.0': () => json(tagsFixture.results.find((r) => (r as { name: string }).name === 'v0.31.0')),
      'https://hub.test/v2/repositories/library/ubuntu/tags/latest': () => json({ name: 'latest', full_size: 30 }),
      'https://hub.test/v2/repositories/x/gone/tags/latest': () => json({}, 404),
    });
    const hub = new DockerHubClient({ fetch, baseUrl: 'https://hub.test', clock: steppingClock() });
    expect(await hub.imageSize('vllm/vllm-openai:v0.31.0')).toBe(9035211086);
    expect(await hub.imageSize('ubuntu')).toBe(30);
    expect(await hub.imageSize('x/gone')).toBeUndefined();
    expect(await hub.imageSize('ghcr.io/ggml-org/llama.cpp:server-cuda')).toBeUndefined();
    expect(await hub.imageSize(`a/b@sha256:${'c'.repeat(64)}`)).toBeUndefined();
    const noSize = new DockerHubClient({ fetch: routeFetch({ 'https://hub.test': () => json({ name: 't', images: [{ architecture: 'arm64', size: 1 }] }) }), baseUrl: 'https://hub.test', clock: steppingClock() });
    expect(await noSize.imageSize({ repository: 'a/b', tag: 't' })).toBeUndefined();
    const withOs = new DockerHubClient({
      fetch: routeFetch({ 'https://hub.test': () => json({ name: 't', images: [{ architecture: 'amd64', os: 'windows', size: 1 }, { architecture: 'amd64', size: 7 }] }) }),
      baseUrl: 'https://hub.test',
      clock: steppingClock(),
    });
    expect(await withOs.imageSize('a/b:t')).toBe(7);
  });
});

describe('ImageService', () => {
  const brokenApi = (code: 'DOCKER_NOT_RUNNING' | 'DOCKER_UNSUPPORTED' | 'INTERNAL') =>
    ({ get: () => Promise.reject(new AppError(code, 'x')) }) as unknown as DockerApiProvider;

  it('uses the API when reachable', async () => {
    api = await startFakeDockerApi({ images: { 'a/b:c': { Id: 'sha256:1', RepoDigests: ['a/b@sha256:2'] } } });
    const provider = new DockerApiProvider({ resolve: async () => [sock(api!.socketPath)] });
    const svc = new ImageService({ api: provider, cli: new DockerCli({ proc: scriptedProc(() => fail(1, 'unused')), platform: 'linux', env: {}, override: ['docker'] }) });
    expect(await svc.inspect('a/b:c')).toMatchObject({ id: 'sha256:1' });
    const seen: PullProgress[] = [];
    expect(await svc.pull('d/e:f', (p) => seen.push(p))).toHaveProperty('digest');
    expect(seen.at(-1)?.status).toBe('done');
    expect(await svc.downloadSize('a/b')).toBeUndefined();
  });

  it('falls back to the CLI when the API cannot be used', async () => {
    const proc = scriptedProc((args) => (args[1] === 'inspect' ? ok(JSON.stringify([{ Id: 'sha256:9' }])) : ok()));
    const cli = new DockerCli({ proc, platform: 'linux', env: {}, override: ['docker'] });
    expect(await new ImageService({ api: brokenApi('DOCKER_NOT_RUNNING'), cli }).inspect('a/b')).toMatchObject({ id: 'sha256:9' });
    expect(await new ImageService({ api: brokenApi('DOCKER_UNSUPPORTED'), cli }).inspect('a/b')).toMatchObject({ id: 'sha256:9' });
    await expect(new ImageService({ api: brokenApi('INTERNAL'), cli }).inspect('a/b')).rejects.toMatchObject({ code: 'INTERNAL' });
    await expect(new ImageService({ api: brokenApi('INTERNAL'), cli }).pull('a/b', () => {})).rejects.toMatchObject({ code: 'INTERNAL' });
    await expect(new ImageService({ api: brokenApi('INTERNAL'), cli }).inspect('-x')).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('pulls through the CLI with layer progress', async () => {
    const mp = manualProcess();
    const proc = scriptedProc(() => ok(), () => mp);
    const log = recordingLog();
    const svc = new ImageService({ api: brokenApi('DOCKER_NOT_RUNNING'), cli: new DockerCli({ proc, platform: 'linux', env: {}, override: ['docker'] }), log });
    const seen: PullProgress[] = [];
    const p = svc.pull('a/b:c', (x) => seen.push(x));
    await new Promise((r) => setTimeout(r, 5));
    for (const l of ['c: Pulling from a/b', 'a1b2c3d4: Pulling fs layer', 'a1b2c3d4: Download complete', 'a1b2c3d4: Pull complete', 'Digest: sha256:abc', 'Status: Downloaded newer image for a/b:c', 'a/b:c']) mp.push(l);
    mp.exit({ code: 0, signal: null });
    expect(await p).toEqual({ digest: 'sha256:abc' });
    expect(seen.at(-1)).toMatchObject({ status: 'done', layersDone: 1, layersTotal: 1 });
    expect(proc.spawns[0]?.args).toEqual(['pull', 'a/b:c']);
    expect(log.entries[0]?.msg).toContain('pulling through the CLI');
  });

  it('reports CLI pull failures and cancellation', async () => {
    const failing = manualProcess();
    const svc = new ImageService({ api: brokenApi('DOCKER_NOT_RUNNING'), cli: new DockerCli({ proc: scriptedProc(() => ok(), () => failing), platform: 'linux', env: {}, override: ['docker'] }) });
    const p = svc.pull('a/b:c', () => {});
    await new Promise((r) => setTimeout(r, 5));
    for (let i = 0; i < 60; i++) failing.push(`line ${i}`);
    failing.push('Error response from daemon: manifest for a/b:c not found: manifest unknown');
    failing.exit({ code: 1, signal: null });
    await expect(p).rejects.toMatchObject({ code: 'DOCKER_PULL_FAILED', params: { image: 'a/b:c' } });

    const odd = manualProcess();
    const svc3 = new ImageService({ api: brokenApi('DOCKER_NOT_RUNNING'), cli: new DockerCli({ proc: scriptedProc(() => ok(), () => odd), platform: 'linux', env: {}, override: ['docker'] }) });
    const p3 = svc3.pull('a/b:c', () => {});
    await new Promise((r) => setTimeout(r, 5));
    odd.exit({ code: 2, signal: null });
    await expect(p3).rejects.toMatchObject({ code: 'DOCKER_PULL_FAILED', params: { image: 'a/b:c' } });

    const slow = manualProcess();
    const svc2 = new ImageService({ api: brokenApi('DOCKER_NOT_RUNNING'), cli: new DockerCli({ proc: scriptedProc(() => ok(), () => slow), platform: 'linux', env: {}, override: ['docker'] }) });
    const ac = new AbortController();
    const p2 = svc2.pull('a/b:c', () => {}, ac.signal);
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    await expect(p2).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(slow.stopped()).toBe(1);
  });

  // The containerd image store (Docker 29, API 1.56): the id is the multi-platform index digest, the
  // same one Docker Hub lists for the tag; an image pulled by digest has no tag at all.
  const INDEX = 'sha256:c1c9f6fd5c109ba7f0546a59f5b2f15fb87f64c77782e90a27b648b42a8e67c3';
  const AMD64 = 'sha256:a4a4c0437bf7240089da5f08aa370c4aee17ae5290f7a3b468825ee26c4c3a6b';
  const containerd = {
    'vllm/vllm-openai:v0.31.0': { Id: INDEX, RepoTags: ['vllm/vllm-openai:v0.31.0'], RepoDigests: [`vllm/vllm-openai@${INDEX}`], Size: 32_300_000_000 },
    'docker.io/vllm/vllm-openai@sha256:a4a4': { Id: 'sha256:d1', RepoTags: [], RepoDigests: [`docker.io/vllm/vllm-openai@${AMD64}`], Size: 9_000_000_000 },
    'lmsysorg/sglang:v0.5.21': { Id: 'sha256:e1', RepoTags: ['lmsysorg/sglang:v0.5.21'], RepoDigests: [], Size: 14_000_000_000 },
    '<none>': { Id: 'sha256:f1' },
  };

  it('lists the images of one repository, by tag and by digest, and which a running container uses', async () => {
    api = await startFakeDockerApi({
      images: containerd,
      containers: [
        { Id: 'c1', Image: 'vllm/vllm-openai:v0.31.0', State: 'running' },
        { Id: 'c2', Image: 'sha256:e1', State: 'exited' },
      ],
    });
    const svc = new ImageService({ api: new DockerApiProvider({ resolve: async () => [sock(api!.socketPath)] }), cli: {} as DockerCli });
    expect(await svc.local('vllm/vllm-openai')).toEqual([
      { id: INDEX, tags: ['v0.31.0'], digests: [INDEX], sizeBytes: 32_300_000_000, running: true },
      { id: 'sha256:d1', tags: [], digests: [AMD64], sizeBytes: 9_000_000_000, running: false },
    ]);
    expect(await svc.local('docker.io/lmsysorg/sglang')).toEqual([{ id: 'sha256:e1', tags: ['v0.5.21'], digests: [], sizeBytes: 14_000_000_000, running: false }]);
    expect(await svc.local('ghcr.io/ggml-org/llama.cpp')).toEqual([]);
    await expect(svc.local('-x')).rejects.toMatchObject({ code: 'VALIDATION' });

    // In use by a running server: refused before Docker is asked; by a stopped container: Docker refuses.
    await expect(svc.remove('vllm/vllm-openai:v0.31.0')).rejects.toMatchObject({ code: 'DOCKER_IMAGE_IN_USE', params: { reason: 'running' } });
    await expect(svc.remove('lmsysorg/sglang:v0.5.21')).rejects.toMatchObject({ code: 'DOCKER_IMAGE_IN_USE', params: { reason: 'container' } });
    await svc.remove('sha256:d1');
    expect(await svc.local('vllm/vllm-openai')).toHaveLength(1);
    // Gone already: nothing to do.
    await svc.remove('vllm/vllm-openai:v0.29.0');
    api.state.containers = [];
    await svc.remove('lmsysorg/sglang:v0.5.21');
    expect(await svc.local('lmsysorg/sglang')).toEqual([]);
    expect(api.requests.filter((r) => r.method === 'DELETE').map((r) => r.query)).toContain('?force=false');
  });

  it('knows a container uses an image whatever name it was started with: an id, a bare repository, a digest, a name Docker made up', async () => {
    api = await startFakeDockerApi({
      images: {
        ...containerd,
        'lmsysorg/sglang:latest': { Id: 'sha256:e2', RepoTags: ['lmsysorg/sglang:latest'], RepoDigests: [], Size: 1 },
      },
      containers: [
        { Id: 'c1', Image: 'sha256:e1', State: 'running' },
        { Id: 'c2', Image: 'lmsysorg/sglang', State: 'running' },
        { Id: 'c3', Image: `docker.io/vllm/vllm-openai@${AMD64}`, State: 'running' },
        { Id: 'c4', Image: 'Not A Valid Name', State: 'running' },
      ],
    });
    const svc = new ImageService({ api: new DockerApiProvider({ resolve: async () => [sock(api!.socketPath)] }), cli: {} as DockerCli });
    expect((await svc.local('lmsysorg/sglang')).map((i) => [i.id, i.running])).toEqual([
      ['sha256:e1', true],
      ['sha256:e2', true],
    ]);
    expect((await svc.local('vllm/vllm-openai')).map((i) => [i.id, i.running])).toEqual([
      [INDEX, false],
      ['sha256:d1', true],
    ]);
    // By digest: the running one is refused.
    await expect(svc.remove(`vllm/vllm-openai@${AMD64}`)).rejects.toMatchObject({ code: 'DOCKER_IMAGE_IN_USE', params: { reason: 'running' } });
    // An API that fails for another reason is not hidden behind the CLI.
    const broken = new ImageService({ api: brokenApi('INTERNAL'), cli: {} as DockerCli });
    await expect(broken.local('a/b')).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('the API client reports a failed list or removal', async () => {
    api = await startFakeDockerApi({ mode: 'starting' });
    const c = new DockerApi({ kind: 'socket', path: api.socketPath, source: 'default' });
    await expect(c.listImages()).rejects.toThrow(AppError);
    await expect(c.removeImage('a/b:c')).rejects.toThrow(AppError);
  });

  it('lists and removes through the CLI when the API cannot be used', async () => {
    const calls: string[][] = [];
    const proc = scriptedProc((args) => {
      calls.push([...args]);
      if (args[0] === 'image' && args[1] === 'ls') return ok([INDEX, INDEX, 'sha256:d1', ''].join('\n'));
      if (args[0] === 'image' && args[1] === 'inspect') {
        return ok(JSON.stringify([{ Id: INDEX, RepoTags: ['vllm/vllm-openai:v0.31.0'], RepoDigests: [`vllm/vllm-openai@${INDEX}`], Size: 5 }, { Id: 'sha256:d1' }, null]));
      }
      if (args[0] === 'ps') return ok(JSON.stringify({ ID: 'c1', Names: 'x', Image: 'vllm/vllm-openai:v0.31.0', State: 'exited', Labels: '' }));
      if (args[0] === 'image' && args[1] === 'rm') {
        if (args[2] === 'busy/one:1') return fail(1, 'Error response from daemon: conflict: unable to remove repository reference "busy/one:1" (must force) - container 1 is using its referenced image 2');
        if (args[2] === 'gone/one:1') return fail(1, 'Error response from daemon: No such image: gone/one:1');
        if (args[2] === 'down/one:1') return fail(1, 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?');
        return ok('Untagged: x');
      }
      return ok();
    });
    const cli = new DockerCli({ proc, platform: 'linux', env: {}, override: ['docker'] });
    const svc = new ImageService({ api: brokenApi('DOCKER_NOT_RUNNING'), cli });
    expect(await svc.local('vllm/vllm-openai')).toEqual([{ id: INDEX, tags: ['v0.31.0'], digests: [INDEX], sizeBytes: 5, running: false }]);
    expect(calls.find((a) => a[1] === 'inspect')).toEqual(['image', 'inspect', INDEX, 'sha256:d1']);
    await svc.remove('vllm/vllm-openai:v0.31.0');
    await svc.remove('gone/one:1');
    await expect(svc.remove('busy/one:1')).rejects.toMatchObject({ code: 'DOCKER_IMAGE_IN_USE', params: { reason: 'container' } });
    await expect(svc.remove('down/one:1')).rejects.toMatchObject({ code: 'DOCKER_NOT_RUNNING' });
    // Nothing on this Docker, a failed list or inspect, unreadable JSON.
    expect(await new DockerCli({ proc: scriptedProc(() => ok('')), platform: 'linux', env: {}, override: ['docker'] }).listImages()).toEqual([]);
    const denied = scriptedProc((a) => (a[1] === 'ls' ? fail(1, 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock') : ok()));
    await expect(new DockerCli({ proc: denied, platform: 'linux', env: {}, override: ['docker'] }).listImages()).rejects.toMatchObject({ code: 'DOCKER_PERMISSION' });
    const garbled = scriptedProc((a) => (a[1] === 'ls' ? ok('sha256:abc123abc123') : ok('not json')));
    expect(await new DockerCli({ proc: garbled, platform: 'linux', env: {}, override: ['docker'] }).listImages()).toEqual([]);
    const notArray = scriptedProc((a) => (a[1] === 'ls' ? ok('sha256:abc123abc123') : ok('{}')));
    expect(await new DockerCli({ proc: notArray, platform: 'linux', env: {}, override: ['docker'] }).listImages()).toEqual([]);
    const down = scriptedProc((a) => (a[1] === 'ls' ? ok('sha256:abc123abc123') : fail(1, 'Cannot connect to the Docker daemon at unix:///x. Is the docker daemon running?')));
    await expect(new DockerCli({ proc: down, platform: 'linux', env: {}, override: ['docker'] }).listImages()).rejects.toMatchObject({ code: 'DOCKER_NOT_RUNNING' });
  });

  it('asks Docker Hub for sizes, tolerating failures', async () => {
    const log = recordingLog();
    const hub = new DockerHubClient({ fetch: routeFetch({}), baseUrl: 'https://hub.test', clock: steppingClock() });
    const svc = new ImageService({ api: brokenApi('INTERNAL'), cli: {} as DockerCli, hub, log });
    expect(await svc.downloadSize('a/b')).toBeUndefined();
    expect(log.entries[0]?.msg).toContain('size lookup failed');
    const quiet = new ImageService({ api: brokenApi('INTERNAL'), cli: {} as DockerCli, hub });
    expect(await quiet.downloadSize('a/b')).toBeUndefined();
    const good = new DockerHubClient({ fetch: routeFetch({ 'https://hub.test': () => json({ name: 'x', full_size: 3 }) }), baseUrl: 'https://hub.test', clock: steppingClock() });
    expect(await new ImageService({ api: brokenApi('INTERNAL'), cli: {} as DockerCli, hub: good }).downloadSize('a/b')).toBe(3);
  });
});

describe('createDockerServices', () => {
  it('wires the services from the core deps', async () => {
    api = await startFakeDockerApi();
    const s = createDockerServices({
      proc: scriptedProc(() => ok()),
      platform: 'linux',
      env: {},
      endpoints: { githubApi: '', huggingface: '', dockerHub: 'https://hub.test', docker: ['node', 'x.mjs'], dockerHost: api.socketPath },
      paths: { dataDir: '', cacheDir: '', enginesDir: '', resultsDir: '', modelsDir: '', resourcesDir: '', home: '/nonexistent' },
      clock: steppingClock(),
      fetch: routeFetch({}),
      log: silentLog,
    });
    expect(await s.cli.command()).toEqual(['node', 'x.mjs']);
    expect((await s.api.get()).label).toBe(api.socketPath);
    const plain = createDockerServices(
      {
        proc: scriptedProc(() => ok()),
        platform: 'linux',
        env: {},
        endpoints: { githubApi: '', huggingface: '', dockerHub: '' },
        paths: { dataDir: '', cacheDir: '', enginesDir: '', resultsDir: '', modelsDir: '', resourcesDir: '', home: '/nonexistent' },
        clock: steppingClock(),
        fetch: routeFetch({}),
        log: silentLog,
      },
      { statusMaxAgeMs: 1 },
    );
    expect(plain.env).toBeDefined();
    expect(await plain.cli.command()).toEqual(['docker']);
  });
});

describe('Docker images edge cases', () => {
  it('passes abort signals to Docker Hub', async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const fetch = (async (_u: string, init?: RequestInit) => {
      seen.push(init?.signal ?? undefined);
      return json({ results: [], name: 't', full_size: 1 });
    }) as unknown as typeof globalThis.fetch;
    const hub = new DockerHubClient({ fetch, baseUrl: 'https://hub.test', clock: steppingClock() });
    const ac = new AbortController();
    await hub.listTags('a/b', '', { signal: ac.signal });
    await hub.imageSize('a/b:t', ac.signal);
    expect(seen).toEqual([ac.signal, ac.signal]);
  });

  it('pulls through the CLI without a digest line', async () => {
    const mp = manualProcess();
    const svc = new ImageService({
      api: { get: () => Promise.reject(new AppError('DOCKER_NOT_RUNNING', 'x')) } as unknown as DockerApiProvider,
      cli: new DockerCli({ proc: scriptedProc(() => ok(), () => mp), platform: 'linux', env: {}, override: ['docker'] }),
    });
    const p = svc.pull('a/b', () => {});
    await new Promise((r) => setTimeout(r, 5));
    mp.push('abcdef12: Pull complete');
    mp.exit();
    expect(await p).toEqual({});
  });

  it('resolves the default endpoints when no dockerHost override is set', async () => {
    const s = createDockerServices({
      proc: scriptedProc(() => ok()),
      platform: 'linux',
      env: {},
      endpoints: { githubApi: '', huggingface: '', dockerHub: '' },
      paths: { dataDir: '', cacheDir: '', enginesDir: '', resultsDir: '', modelsDir: '', resourcesDir: '', home: '/nonexistent' },
      clock: steppingClock(),
      fetch: routeFetch({}),
      log: silentLog,
    });
    await expect(s.api.get()).rejects.toBeInstanceOf(AppError);
  });
});
