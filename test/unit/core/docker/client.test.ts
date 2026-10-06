import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../../../../src/contract/errors';
import { connectionError, containerInfoFrom, DockerApi } from '../../../../src/core/docker/client';
import type { PullProgress } from '../../../../src/core/docker/pull-progress';
import { randomSocketPath, startFakeDockerApi, type FakeDockerApi } from '../../../fakes/fake-docker/api.mjs';

let api: FakeDockerApi | undefined;
const servers: http.Server[] = [];
afterEach(async () => {
  await api?.close();
  api = undefined;
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
});

const client = (a: FakeDockerApi, timeoutMs?: number) => new DockerApi({ kind: 'socket', path: a.socketPath, source: 'override' }, timeoutMs);

/** A raw HTTP server on a pipe/socket for responses the fake API never sends. */
async function rawServer(handler: http.RequestListener): Promise<DockerApi> {
  const p = randomSocketPath();
  const s = http.createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(p, r));
  return new DockerApi({ kind: 'socket', path: p, source: 'override' });
}

describe('DockerApi over a real named pipe / unix socket', () => {
  it('pings, reads version and info', async () => {
    api = await startFakeDockerApi({ info: { Runtimes: { runc: {}, nvidia: { path: 'nvidia-container-runtime' } } } });
    const c = client(api);
    expect(c.label).toBe(api.socketPath);
    expect(await c.ping()).toEqual({ ok: true, status: 200, apiVersion: '1.51', osType: 'linux' });
    expect(await c.version()).toEqual({
      version: '29.8.0',
      apiVersion: '1.51',
      os: 'linux',
      arch: 'amd64',
      platform: 'Docker Desktop 4.47.0 (210443)',
      components: ['Engine', 'containerd'],
      podman: false,
    });
    expect(await c.info()).toEqual({
      serverVersion: '29.8.0',
      osType: 'linux',
      operatingSystem: 'Docker Desktop',
      ncpu: 32,
      memTotal: 67_000_000_000,
      runtimes: ['runc', 'nvidia'],
      cdiDevices: [],
      gpuHint: 'nvidia-runtime',
    });
  });

  it('detects Podman, CDI devices and Docker Desktop GPU hints', async () => {
    api = await startFakeDockerApi({ mode: 'podman', info: { DiscoveredDevices: [{ Source: 'cdi', ID: 'nvidia.com/gpu=all' }, {}] } });
    const c = client(api);
    expect((await c.version()).podman).toBe(true);
    expect((await c.info()).gpuHint).toBe('cdi');
    api.set({ info: { OperatingSystem: 'Docker Desktop' } });
    expect((await c.info()).gpuHint).toBe('docker-desktop');
    api.set({ info: { OperatingSystem: 'Ubuntu 24.04', Runtimes: undefined } });
    expect(await c.info()).toMatchObject({ gpuHint: 'none', runtimes: [] });
  });

  it('reports a starting Docker Desktop as ping ok:false and fails other calls', async () => {
    api = await startFakeDockerApi({ mode: 'starting' });
    const c = client(api);
    expect(await c.ping()).toMatchObject({ ok: false, status: 500 });
    await expect(c.version()).rejects.toMatchObject({ code: 'INTERNAL', params: { status: 500 } });
    await expect(c.info()).rejects.toThrow('Docker Desktop is starting');
    await expect(c.listContainers()).rejects.toThrow(AppError);
    await expect(c.imageInspect('a/b')).rejects.toThrow(AppError);
    await expect(c.containerInspect('x')).rejects.toThrow(AppError);
    await expect(c.removeContainer('x')).rejects.toThrow(AppError);
    await expect(c.volumeInspect('v')).rejects.toThrow(AppError);
  });

  it('inspects images (404 = absent)', async () => {
    api = await startFakeDockerApi({
      images: { 'vllm/vllm-openai:v0.31.0': { Id: 'sha256:1', RepoTags: ['vllm/vllm-openai:v0.31.0'], RepoDigests: ['vllm/vllm-openai@sha256:2'], Size: 99 } },
    });
    const c = client(api);
    expect(await c.imageInspect('vllm/vllm-openai:v0.31.0')).toEqual({
      id: 'sha256:1',
      repoTags: ['vllm/vllm-openai:v0.31.0'],
      repoDigests: ['vllm/vllm-openai@sha256:2'],
      size: 99,
    });
    expect(await c.imageInspect('ghcr.io/ggml-org/llama.cpp:server-cuda')).toBeUndefined();
    api.state.images.set('x/y', {});
    expect(await c.imageInspect('x/y')).toEqual({ id: '', repoTags: [], repoDigests: [], size: 0 });
  });

  it('pulls with aggregated progress and stores the image', async () => {
    api = await startFakeDockerApi();
    const c = client(api);
    const seen: PullProgress[] = [];
    const res = await c.pull('ghcr.io/ggml-org/llama.cpp:server-cuda', (p) => seen.push(p));
    expect(res.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(seen.at(-1)).toEqual({ status: 'done', bytesDone: 8_000_000, bytesTotal: 8_000_000, layersDone: 3, layersTotal: 3 });
    expect(seen.some((p) => p.status === 'downloading' && p.bytesDone > 0 && p.bytesDone < 8_000_000)).toBe(true);
    expect(api.requests.find((r) => r.path === '/images/create')?.query).toBe('?fromImage=ghcr.io%2Fggml-org%2Fllama.cpp&tag=server-cuda');
    expect(await c.imageInspect('ghcr.io/ggml-org/llama.cpp:server-cuda')).toBeDefined();
  });

  it('maps pull failures: HTTP errors, stream errors, disk full', async () => {
    api = await startFakeDockerApi({ pull: { error: 'not-found' } });
    const c = client(api);
    await expect(c.pull('vllm/vllm-openai:v9', () => {})).rejects.toMatchObject({
      code: 'DOCKER_PULL_FAILED',
      params: { reason: 'not-found', image: 'vllm/vllm-openai:v9' },
    });
    api.set({ pull: { error: 'denied' } });
    await expect(c.pull('private/img', () => {})).rejects.toMatchObject({ params: { reason: 'not-found' } });
    api.set({ pull: { error: 'http-500' } });
    await expect(c.pull('a/b', () => {})).rejects.toMatchObject({ params: { reason: 'network' } });
    api.set({ pull: { error: 'stream-error' } });
    await expect(c.pull('a/b', () => {})).rejects.toMatchObject({ code: 'DOCKER_PULL_FAILED', params: { reason: 'auth', image: 'a/b' } });
    api.set({ pull: { error: 'no-space' } });
    await expect(c.pull('a/b', () => {})).rejects.toMatchObject({ code: 'DISK_FULL' });
    await expect(c.pull('-bad', () => {})).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('cancels a pull', async () => {
    api = await startFakeDockerApi({ pull: { stallAt: 2 } });
    const c = client(api);
    const ac = new AbortController();
    const p = c.pull('a/b:c', (pr) => {
      if (pr.bytesDone > 0) ac.abort();
    }, ac.signal);
    await expect(p).rejects.toMatchObject({ code: 'CANCELLED' });
    const pre = new AbortController();
    pre.abort();
    await expect(c.pull('a/b:c', () => {}, pre.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('lists, inspects and removes containers by label', async () => {
    api = await startFakeDockerApi({
      containers: [
        { Id: 'aaa', Names: ['/gpubench-m1'], Image: 'img', Labels: { gpubench: '1', 'gpubench.marker': 'm1' }, State: 'running', Status: 'Up' },
        { Id: 'bbb', Names: ['/someone-else'], Labels: {}, State: 'exited', ExitCode: 3, OOMKilled: true },
      ],
    });
    const c = client(api);
    expect(await c.listContainers({ label: ['gpubench=1'] })).toEqual([
      { id: 'aaa', names: ['gpubench-m1'], image: 'img', labels: { gpubench: '1', 'gpubench.marker': 'm1' }, state: 'running', status: 'Up' },
    ]);
    expect((await c.listContainers()).map((x) => x.id)).toEqual(['aaa', 'bbb']);
    expect(await c.containerInspect('aaa')).toMatchObject({ id: 'aaa', name: 'gpubench-m1', running: true, exitCode: 0, oomKilled: false });
    expect(await c.containerInspect('bbb')).toMatchObject({ running: false, exitCode: 3, oomKilled: true });
    expect(await c.containerInspect('zzz')).toBeUndefined();
    await expect(c.removeContainer('aaa')).rejects.toMatchObject({ params: { status: 409 } });
    expect(await c.removeContainer('aaa', true)).toBe(true);
    expect(await c.removeContainer('aaa', true)).toBe(false);
  });

  it('creates and inspects volumes idempotently', async () => {
    api = await startFakeDockerApi();
    const c = client(api);
    expect(await c.volumeInspect('gpubench-hf-cache')).toBeUndefined();
    const v = await c.ensureVolume('gpubench-hf-cache', { gpubench: '1' });
    expect(v).toEqual({ name: 'gpubench-hf-cache', mountpoint: '/var/lib/docker/volumes/gpubench-hf-cache/_data', labels: { gpubench: '1' } });
    expect(await c.ensureVolume('gpubench-hf-cache')).toEqual(v);
    expect(api.requests.filter((r) => r.path === '/volumes/create')).toHaveLength(1);
    api.state.volumes.set('bare', { Name: 'bare' });
    expect(await c.volumeInspect('bare')).toEqual({ name: 'bare', labels: {} });
  });

  it('turns a missing pipe into DOCKER_NOT_RUNNING and a silent daemon into a timeout', async () => {
    const missing = new DockerApi({ kind: 'socket', path: randomSocketPath(), source: 'default' });
    await expect(missing.ping()).rejects.toMatchObject({ code: 'DOCKER_NOT_RUNNING', params: { reason: 'ENOENT' } });
    api = await startFakeDockerApi({ mode: 'hang' });
    await expect(client(api, 150).ping()).rejects.toMatchObject({ code: 'DOCKER_NOT_RUNNING', params: { reason: 'timeout' } });
    const tcp = new DockerApi({ kind: 'tcp', host: '127.0.0.1', port: 9, tls: false, source: 'env' });
    expect(tcp.label).toBe('127.0.0.1:9');
    await expect(tcp.ping({ timeoutMs: 2000 })).rejects.toMatchObject({ code: 'DOCKER_NOT_RUNNING' });
  });

  it('cancels a buffered request', async () => {
    api = await startFakeDockerApi({ mode: 'hang' });
    const ac = new AbortController();
    const p = client(api).request('GET', '/_ping', { signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('handles odd responses: no headers, non-JSON, broken streams, body errors', async () => {
    const c = await rawServer((req, res) => {
      if (req.url === '/_ping') {
        res.writeHead(200);
        return res.end('OK');
      }
      if (req.url === '/version') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ Components: 'nope', Platform: { Name: 'podman engine' } }));
      }
      if (req.url === '/info') {
        res.writeHead(200);
        return res.end('{}');
      }
      if (req.url?.startsWith('/images/create')) {
        res.writeHead(200);
        res.write('not json\n\n{"status":"Pulling fs layer","id":"l1"}\n');
        return res.end('{"status":"Download complete","id":"l1"}');
      }
      if (req.url?.startsWith('/containers/json')) {
        res.writeHead(200);
        return res.end(JSON.stringify([{ Names: 'x', Labels: { a: 1, b: 'c' } }]));
      }
      if (req.url === '/containers/odd/json') {
        res.writeHead(200);
        return res.end('{}');
      }
      if (req.url === '/volumes/broken') {
        res.writeHead(200);
        return res.end('<html>');
      }
      if (req.url === '/volumes/create') {
        res.writeHead(500);
        return res.end('');
      }
      res.writeHead(404);
      res.end('plain text');
    });
    expect(await c.ping()).toEqual({ ok: true, status: 200 });
    expect(await c.version()).toEqual({ version: '', components: [], podman: true, platform: 'podman engine' });
    expect(await c.info()).toEqual({ runtimes: [], cdiDevices: [], gpuHint: 'none' });
    const progress: PullProgress[] = [];
    expect(await c.pull('a/b', (p) => progress.push(p))).toEqual({});
    expect(progress.at(-1)).toMatchObject({ status: 'done', layersTotal: 1 });
    expect(await c.listContainers()).toEqual([{ id: '', names: [], image: '', labels: { b: 'c' }, state: '', status: '' }]);
    expect(await c.containerInspect('odd')).toEqual({ id: '', name: '', labels: {}, running: false, status: '', oomKilled: false });
    await expect(c.volumeInspect('broken')).rejects.toMatchObject({ code: 'INTERNAL' });
    await expect(c.ensureVolume('new')).rejects.toThrow('HTTP 500');
    const res = await c.request('GET', '/nowhere');
    expect(res).toMatchObject({ status: 404, body: 'plain text' });
  });

  it('fails a stream whose last line carries an error', async () => {
    const c = await rawServer((_req, res) => {
      res.writeHead(200);
      res.end('{"status":"Pulling fs layer","id":"l1"}\n{"error":"unexpected EOF"}');
    });
    await expect(c.pull('a/b', () => {})).rejects.toMatchObject({ code: 'DOCKER_PULL_FAILED', params: { reason: 'network', image: 'a/b' } });
  });

  it('rejects when the response body breaks mid-way', async () => {
    const c = await rawServer((_req, res) => {
      res.writeHead(200, { 'content-length': '1000' });
      res.write('{"status":"Pulling fs layer","id":"l1"}\n');
      setTimeout(() => res.destroy(), 20);
    });
    await expect(c.pull('a/b', () => {})).rejects.toMatchObject({ code: 'DOCKER_NOT_RUNNING' });
  });
});

describe('helpers', () => {
  it('maps socket error codes', () => {
    expect(connectionError(Object.assign(new Error('x'), { code: 'EACCES' }), 'p').code).toBe('DOCKER_PERMISSION');
    expect(connectionError(Object.assign(new Error('x'), { code: 'EPERM' }), 'p').code).toBe('DOCKER_PERMISSION');
    expect(connectionError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }), 'p').params).toEqual({ endpoint: 'p', reason: 'ECONNREFUSED' });
    expect(connectionError(Object.assign(new Error('x'), { code: 'EWEIRD' }), 'p').params).toEqual({ endpoint: 'p', reason: 'EWEIRD' });
    expect(connectionError('boom', 'p')).toMatchObject({ code: 'DOCKER_NOT_RUNNING', params: { reason: 'error' }, detail: 'boom' });
  });
  it('reads container JSON from the CLI or the API', () => {
    expect(containerInfoFrom({ Id: 'a', Name: '/n', State: { Running: true, Status: 'running', StartedAt: 't' }, Config: { Labels: { gpubench: '1' } } })).toEqual({
      id: 'a',
      name: 'n',
      labels: { gpubench: '1' },
      running: true,
      status: 'running',
      oomKilled: false,
      startedAt: 't',
    });
  });
});

describe('DockerApi edge cases', () => {
  it('reads a volume without a name and a version without a platform', async () => {
    const c = await rawServer((req, res) => {
      res.writeHead(200);
      res.end(req.url === '/version' ? JSON.stringify({ Version: '1', Components: [{ Name: 'Engine' }] }) : '{}');
    });
    expect(await c.volumeInspect('x')).toEqual({ name: '', labels: {} });
    expect(await c.version()).toEqual({ version: '1', components: ['Engine'], podman: false });
  });
});
