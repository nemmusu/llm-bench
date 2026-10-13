import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../../../src/contract/errors';
import type { ServerEvent } from '../../../../src/contract/events';
import type { CoreContext } from '../../../../src/core/context';
import { DockerControl } from '../../../../src/core/docker/control';
import type { DockerEnvironment, DockerStatusDetail, StartProgress } from '../../../../src/core/docker/environment';
import type { ImageService } from '../../../../src/core/docker/images';
import type { PullProgress } from '../../../../src/core/docker/pull-progress';
import { createDockerRoutes, type DockerRoutesDeps } from '../../../../src/core/docker/routes';
import { errorResponse } from '../../../../src/core/server/http-error';
import { silentLog, steppingClock } from './helpers';

type Ev = ServerEvent & Record<string, unknown>;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

function setup(over: Partial<DockerRoutesDeps> = {}, envOver: Partial<DockerEnvironment> = {}, imagesOver: Partial<ImageService> = {}) {
  const events: Ev[] = [];
  let state: DockerStatusDetail = { state: 'stopped', version: '29.8.0' };
  const restarts: { deep: boolean | undefined }[] = [];
  const env = {
    platform: 'win32',
    status: async (o?: { fresh?: boolean }) => ({ ...state, fresh: o?.fresh ?? false }),
    probe: async () => ({ ...state, probed: true }),
    peek: () => state,
    onChange: () => () => {},
    startDesktop: async (_s: AbortSignal, onProgress?: (p: StartProgress) => void) => {
      onProgress?.({ state: 'starting', elapsedMs: 1500, slow: false, method: 'cli' });
      state = { state: 'running', version: '29.8.0' };
      return state;
    },
    restartDesktop: async (_s: AbortSignal, _p: unknown, o?: { deep?: boolean }) => {
      restarts.push({ deep: o?.deep });
      state = { state: 'running', version: '29.8.0' };
      return state;
    },
    openDesktop: async () => undefined,
    gpuCheck: async (image: string) => ({ image, gpus: ['GPU 0: RTX 5090'] }),
    cleanupOrphans: async (keep: Iterable<string> = []) => ({ removed: [{ id: 'a', name: `kept:${[...keep].join(',')}` }] }),
    ...envOver,
  } as unknown as DockerEnvironment;
  const images = {
    downloadSize: async () => undefined,
    pull: async (_ref: string, on: (p: PullProgress) => void) => {
      on({ status: 'downloading', bytesDone: 5, bytesTotal: 10, layersDone: 0, layersTotal: 1 });
      on({ status: 'extracting', bytesDone: 10, bytesTotal: 10, layersDone: 0, layersTotal: 1 });
      on({ status: 'done', bytesDone: 0, bytesTotal: 0, layersDone: 1, layersTotal: 1 });
      return {};
    },
    ...imagesOver,
  } as unknown as ImageService;
  const publish = (e: ServerEvent) => events.push(e as Ev);
  const control = new DockerControl({
    env,
    publish,
    servers: { list: () => [], start: async () => Promise.reject(new Error('no servers here')), stop: async () => undefined },
    clock: steppingClock(),
    log: silentLog,
    shutdown: over.shutdown ?? new AbortController().signal,
  });
  const deps: DockerRoutesDeps = {
    env,
    control,
    images,
    vllm: { tags: async (o) => [{ name: 'v0.31.0', refresh: o?.refresh ?? false }] },
    publish,
    defaultGpuImage: async () => 'ghcr.io/ggml-org/llama.cpp:server-cuda',
    diagnose: async () => ({ cause: 'resource-saver', evidence: ['line'], resourceSaver: { enabled: true, timeoutSeconds: 300 } }),
    ...over,
  };
  const app = new Hono();
  app.onError((e, c) => errorResponse(c, e));
  createDockerRoutes(deps)(app, {} as CoreContext);
  const post = (url: string, body?: unknown) =>
    app.request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? '{}' : JSON.stringify(body) });
  return { app, events, post, control, restarts, setState: (s: DockerStatusDetail) => (state = s) };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('docker routes', () => {
  it('GET /api/docker/status (cached or fresh)', async () => {
    const { app } = setup();
    expect(await (await app.request('/api/docker/status')).json()).toEqual({ state: 'stopped', version: '29.8.0', fresh: false });
    expect(await (await app.request('/api/docker/status?fresh=1')).json()).toMatchObject({ fresh: true });
  });

  it('POST /api/docker/start runs once in the background and publishes progress', async () => {
    const gate = deferred<DockerStatusDetail>();
    let starts = 0;
    const { post, events } = setup(
      {},
      {
        startDesktop: async (_s: AbortSignal, on?: (p: StartProgress) => void) => {
          starts++;
          on?.({ state: 'starting', elapsedMs: 61_000, slow: true, method: 'exe' });
          return gate.promise;
        },
      },
    );
    expect(await (await post('/api/docker/start')).json()).toEqual({ ok: true, state: 'starting' });
    expect(await (await post('/api/docker/start')).json()).toEqual({ ok: true, state: 'starting' });
    expect(starts).toBe(1);
    gate.resolve({ state: 'running' });
    await tick();
    expect(events).toEqual([
      { type: 'engine.install', kind: 'docker-desktop', stage: 'starting', bytesDone: 61_000, state: 'starting', slow: true },
      { type: 'engine.install', kind: 'docker-desktop', stage: 'running', bytesDone: 0, state: 'running' },
    ]);
    await post('/api/docker/start');
    expect(starts).toBe(2);
  });

  it('POST /api/docker/start answers at once when Docker is usable, and reports start errors as events', async () => {
    const a = setup();
    a.setState({ state: 'running' });
    expect(await (await a.post('/api/docker/start')).json()).toEqual({ ok: true, state: 'running' });
    a.setState({ state: 'no-gpu' });
    expect(await (await a.post('/api/docker/start')).json()).toEqual({ ok: true, state: 'no-gpu' });
    a.setState({ state: 'unsupported' });
    expect(await (await a.post('/api/docker/start')).json()).toEqual({ ok: true, state: 'unsupported' });

    const shutdown = new AbortController();
    let seen: AbortSignal | undefined;
    const b = setup({ shutdown: shutdown.signal }, {
      startDesktop: async (s: AbortSignal) => {
        seen = s;
        throw new AppError('DOCKER_NOT_RUNNING', 'timeout', { params: { reason: 'start-timeout' } });
      },
    });
    await b.post('/api/docker/start');
    await tick();
    expect(b.events).toEqual([
      { type: 'engine.install', kind: 'docker-desktop', stage: 'error', bytesDone: 0, error: { code: 'DOCKER_NOT_RUNNING', message: 'timeout', params: { reason: 'start-timeout' } } },
    ]);
    expect(seen?.aborted).toBe(false);
  });

  it('aborts a running start on shutdown', async () => {
    const shutdown = new AbortController();
    const { post, events } = setup({ shutdown: shutdown.signal }, {
      startDesktop: (s: AbortSignal) =>
        new Promise((_, reject) => s.addEventListener('abort', () => reject(new AppError('CANCELLED', 'stopped')))),
    });
    await post('/api/docker/start');
    shutdown.abort();
    await tick();
    expect(events[0]).toMatchObject({ stage: 'error', error: { code: 'CANCELLED' } });
  });

  it('POST /api/docker/gpu-check with the default or a given image', async () => {
    const { post } = setup();
    expect(await (await post('/api/docker/gpu-check')).json()).toEqual({ image: 'ghcr.io/ggml-org/llama.cpp:server-cuda', gpus: ['GPU 0: RTX 5090'] });
    expect(await (await post('/api/docker/gpu-check', { image: 'vllm/vllm-openai:v0.31.0' })).json()).toMatchObject({ image: 'vllm/vllm-openai:v0.31.0' });
    const bad = await post('/api/docker/gpu-check', { image: '--privileged' });
    expect(bad.status).toBe(400);
    const failing = setup({}, { gpuCheck: async () => Promise.reject(new AppError('DOCKER_NO_GPU', 'no gpu')) });
    const res = await failing.post('/api/docker/gpu-check', {});
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: 'DOCKER_NO_GPU', message: 'no gpu' } });
  });

  it('POST /api/docker/pull streams progress events and rejects duplicates', async () => {
    const gate = deferred<{ digest?: string }>();
    const expected: (number | undefined)[] = [];
    const { post, events } = setup(
      {},
      {},
      {
        // The image's size from Docker Hub goes to the pull, so its bar never goes back.
        downloadSize: async () => 9_000_000_000,
        pull: async (_ref: string, on: (p: PullProgress) => void, _signal?: AbortSignal, bytes?: number) => {
          expected.push(bytes);
          on({ status: 'downloading', bytesDone: 5, bytesTotal: 10, layersDone: 0, layersTotal: 1 });
          on({ status: 'resolving', bytesDone: 0, bytesTotal: 0, layersDone: 0, layersTotal: 0 });
          return gate.promise;
        },
      },
    );
    expect(await (await post('/api/docker/pull', { image: 'vllm/vllm-openai:v0.31.0', kind: 'vllm-docker' })).json()).toEqual({ ok: true });
    const dup = await post('/api/docker/pull', { image: 'vllm/vllm-openai:v0.31.0' });
    expect(dup.status).toBe(400);
    expect(await dup.json()).toMatchObject({ error: { code: 'VALIDATION', params: { reason: 'busy' } } });
    gate.resolve({});
    await tick();
    expect(events).toEqual([
      { type: 'engine.install', kind: 'vllm-docker', image: 'vllm/vllm-openai:v0.31.0', stage: 'download', bytesDone: 5, bytesTotal: 10 },
      { type: 'engine.install', kind: 'vllm-docker', image: 'vllm/vllm-openai:v0.31.0', stage: 'download', bytesDone: 0 },
    ]);
    expect(expected).toEqual([9_000_000_000]);
    // Finished: the same image can be pulled again.
    expect((await post('/api/docker/pull', { image: 'vllm/vllm-openai:v0.31.0' })).status).toBe(200);
  });

  it('maps pull stages and errors', async () => {
    const ok = setup();
    await ok.post('/api/docker/pull', { image: 'a/b' });
    await tick();
    expect(ok.events.map((e) => [e.kind, e.stage])).toEqual([
      ['docker-image', 'download'],
      ['docker-image', 'extract'],
      ['docker-image', 'done'],
    ]);
    const bad = setup({}, {}, { pull: async () => Promise.reject(new AppError('DOCKER_PULL_FAILED', 'nope', { params: { reason: 'auth' } })) });
    await bad.post('/api/docker/pull', { image: 'a/b' });
    await tick();
    expect(bad.events).toEqual([
      { type: 'engine.install', kind: 'docker-image', image: 'a/b', stage: 'error', bytesDone: 0, error: { code: 'DOCKER_PULL_FAILED', message: 'nope', params: { reason: 'auth' } } },
    ]);
    expect((await bad.post('/api/docker/pull', { image: '-x' })).status).toBe(400);
    expect((await bad.post('/api/docker/pull', {})).status).toBe(400);
  });

  it('POST /api/docker/cleanup keeps containers of runs in progress', async () => {
    const a = setup({ activeMarkers: () => ['m1', 'm2'] });
    expect(await (await a.post('/api/docker/cleanup')).json()).toEqual({ removed: [{ id: 'a', name: 'kept:m1,m2' }] });
    const b = setup();
    expect(await (await b.post('/api/docker/cleanup')).json()).toEqual({ removed: [{ id: 'a', name: 'kept:' }] });
  });

  it('GET /api/engines/vllm/tags', async () => {
    const { app } = setup();
    expect(await (await app.request('/api/engines/vllm/tags')).json()).toEqual([{ name: 'v0.31.0', refresh: false }]);
    expect(await (await app.request('/api/engines/vllm/tags?refresh=1')).json()).toEqual([{ name: 'v0.31.0', refresh: true }]);
  });

  it('accepts a factory receiving the core context', async () => {
    const events: Ev[] = [];
    const app = new Hono();
    const ctx = { hub: { publish: (e: ServerEvent) => events.push(e as Ev) } } as unknown as CoreContext;
    createDockerRoutes((c) => ({
      env: { status: async () => ({ state: 'running' }) } as unknown as DockerEnvironment,
      control: {} as DockerControl,
      images: {} as ImageService,
      vllm: { tags: async () => [] },
      publish: (e) => c.hub.publish(e),
      defaultGpuImage: async () => 'x/y',
      diagnose: async () => ({ cause: 'unknown', evidence: [] }),
    }))(app, ctx);
    expect(await (await app.request('/api/docker/status')).json()).toEqual({ state: 'running' });
  });

  it('GET /api/docker/status?probe=1 asks the engine itself', async () => {
    const { app } = setup();
    expect(await (await app.request('/api/docker/status?probe=1')).json()).toEqual({ state: 'stopped', version: '29.8.0', probed: true });
  });

  it('POST /api/docker/restart: normal (no body), deep, and one at a time', async () => {
    const { post, app, restarts, events } = setup();
    expect(await (await app.request('/api/docker/restart', { method: 'POST' })).json()).toEqual({ ok: true });
    await tick();
    expect(await (await post('/api/docker/restart', { deep: true })).json()).toEqual({ ok: true });
    await tick();
    expect(restarts).toEqual([{ deep: false }, { deep: true }]);
    expect(events.filter((e) => e.kind === 'docker-restart').map((e) => e.stage)).toEqual(['running', 'running']);
    expect((await post('/api/docker/restart', { deep: 'yes' })).status).toBe(400);
  });

  it('GET /api/docker/diagnosis and POST /api/docker/open', async () => {
    let opened = 0;
    const { app, post } = setup({}, { openDesktop: async () => void opened++ });
    expect(await (await app.request('/api/docker/diagnosis')).json()).toMatchObject({ cause: 'resource-saver', resourceSaver: { enabled: true } });
    expect(await (await post('/api/docker/open')).json()).toEqual({ ok: true });
    expect(opened).toBe(1);
    const linux = setup({}, { openDesktop: async () => Promise.reject(new AppError('DOCKER_UNSUPPORTED', 'windows only')) });
    expect((await linux.post('/api/docker/open')).status).toBe(503);
  });

  it('GET, POST and DELETE /api/docker/recovery', async () => {
    const { app, post } = setup();
    expect(await (await app.request('/api/docker/recovery')).json()).toEqual({ servers: [], restoring: false });
    expect(await (await post('/api/docker/recovery')).json()).toEqual({ ok: true });
    expect(await (await app.request('/api/docker/recovery', { method: 'DELETE' })).json()).toEqual({ ok: true });
  });
});
