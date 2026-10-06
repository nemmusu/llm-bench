// llama.cpp Docker adapter through the REAL ProcessRunner and the fake docker CLI
// (test/fakes/fake-docker/fake-docker.mjs), whose "containers" run the fake llama-server.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { launchParamsSchema, type LaunchParams } from '../../../../../src/contract/engines';
import type { LogLine, Platform } from '../../../../../src/core/deps';
import { DockerApiProvider } from '../../../../../src/core/docker/api-provider';
import { DockerCli } from '../../../../../src/core/docker/cli';
import { DockerEnvironment } from '../../../../../src/core/docker/environment';
import { ImageService } from '../../../../../src/core/docker/images';
import { LlamaDockerAdapter } from '../../../../../src/core/engines/llamacpp-docker/adapter';
import type { ModelTarget } from '../../../../../src/core/engines/types';
import { createInferenceClient } from '../../../../../src/core/inference/client';
import { systemClock } from '../../../../../src/core/node-deps';
import { pickFreePort } from '../../../../../src/core/process/ports';
import { createProcessRunner } from '../../../../../src/core/process/runner';
import { randomSocketPath } from '../../../../fakes/fake-docker/api.mjs';
import { FAKE_DOCKER, FAKE_ENGINE, removeAllContainers, RESOURCES, silentLog, tempDir } from '../../docker/helpers';

const haveEngine = existsSync(FAKE_ENGINE);
const platform = process.platform as Platform;
const IMAGE = 'ghcr.io/ggml-org/llama.cpp:server-cuda';
const cleanups: (() => void)[] = [];
const clis: DockerCli[] = [];
afterAll(async () => {
  for (const cli of clis) await removeAllContainers(cli);
  for (const c of cleanups) c();
});
let n = 0;
const marker = () => `gpubench-ld${process.pid}x${n++}`;

function setup(env: Record<string, string> = {}) {
  const t = tempDir('gb-ldock-');
  cleanups.push(t.cleanup);
  const state = path.join(t.dir, 'state');
  const models = path.join(t.dir, 'models');
  mkdirSync(models, { recursive: true });
  const gguf = path.join(models, 'tiny.gguf');
  writeFileSync(gguf, Buffer.alloc(4096, 1));
  const baseEnv = { ...process.env, FAKE_DOCKER_STATE: state, ...env };
  const proc = createProcessRunner({ clock: systemClock, platform, baseEnv });
  const cli = new DockerCli({ proc, platform, env: baseEnv, override: [process.execPath, FAKE_DOCKER] });
  clis.push(cli);
  const environment = new DockerEnvironment({ cli, clock: systemClock, platform, env: baseEnv });
  // No Engine API endpoint: images go through the CLI fallback.
  const api = new DockerApiProvider({ resolve: async () => [{ kind: 'socket', path: randomSocketPath(), source: 'override' }] });
  const images = new ImageService({ api, cli });
  const adapter = new LlamaDockerAdapter({
    deps: { clock: systemClock, proc, fetch, platform, log: silentLog, paths: { dataDir: t.dir, cacheDir: t.dir, enginesDir: t.dir, resultsDir: t.dir, modelsDir: t.dir, resourcesDir: RESOURCES, home: t.dir } },
    cli,
    environment,
    images,
    createClient: (flavor, baseUrl, opts) => createInferenceClient(flavor, baseUrl, { fetch, clock: systemClock }, opts),
    pollMs: 30,
    readyTimeoutMs: 30_000,
    stopTimeoutSec: 2,
  });
  const identity = { displayName: 'tiny', format: 'gguf' as const, source: 'local' as const, files: [], weakKey: 'tiny', sizeBytes: 4096 };
  const model: ModelTarget = { identity, local: { id: 't', identity, paths: [gguf], auxiliary: [], dir: models, origin: 'library', modifiedAt: '' } };
  return { state, cli, environment, adapter, model, gguf };
}

const params = (profile: object, over: Partial<LaunchParams> = {}) =>
  launchParamsSchema.parse({ contextSize: 2048, ...over, env: { FAKE_ENGINE_PROFILE: JSON.stringify(profile) } });

async function collect(logs: AsyncIterable<LogLine>): Promise<string[]> {
  const out: string[] = [];
  for await (const l of logs) out.push(l.text);
  return out;
}

describe.skipIf(!haveEngine)('llama.cpp Docker adapter with the fake docker CLI', () => {
  it('detects, plans the exact command, starts, serves, measures and stops a container', async () => {
    const s = setup();
    const status = await s.adapter.detect();
    expect(status).toMatchObject({ kind: 'llamacpp-docker', available: true, installed: true, location: IMAGE, version: 'server-cuda', variant: 'cuda', problems: [] });

    const port = await pickFreePort();
    const m = marker();
    const plan = await s.adapter.plan({ kind: 'llamacpp-docker' }, s.model, params({ loadMsWarm: 200 }), { port, marker: m });
    expect(plan.argv.slice(0, 15)).toEqual([
      process.execPath,
      FAKE_DOCKER,
      'run',
      '-d',
      '--name',
      m,
      '--label',
      'gpubench=1',
      '--label',
      `gpubench.marker=${m}`,
      '--gpus',
      'all',
      '-p',
      `127.0.0.1:${port}:8080`,
      '-v',
    ]);
    expect(plan.argv).toContain(`${path.dirname(s.gguf)}:/models:ro`);
    expect(plan.argv.slice(plan.argv.indexOf(IMAGE))).toEqual(
      expect.arrayContaining([IMAGE, '-m', '/models/tiny.gguf', '--host', '0.0.0.0', '--port', '8080', '--alias', m, '-c', '2048', '-fa', 'auto']),
    );
    // The profile travels by name only (value in the docker CLI's environment).
    expect(plan.argv).toContain('FAKE_ENGINE_PROFILE');
    expect(plan.env.FAKE_ENGINE_PROFILE).toContain('loadMsWarm');
    expect(plan.engine).toMatchObject({ kind: 'llamacpp-docker', name: 'llama.cpp', image: IMAGE, build: 'b10997' });
    expect(plan.engine.imageDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(plan.modelFiles).toEqual([s.gguf]);
    expect(plan.modelBytes).toBe(4096);
    expect(plan.slowSharedFilesystem).toBe(platform !== 'linux');

    const inst = await s.adapter.start(plan, new AbortController().signal);
    const logs = collect(inst.logs);
    const ready = await inst.waitReady();
    expect(ready.tReady).toBeGreaterThan(inst.t0);
    expect(ready.phases[0]).toEqual({ name: 'container', t: inst.t0 });
    // The fake answers /health 200 just before printing 'server is listening': that mark may fall after ready.
    expect(ready.phases.map((p) => p.name)).toEqual(expect.arrayContaining(['container', 'model_load', 'load_tensors', 'context', 'warmup']));
    for (const p of ready.phases) {
      expect(p.t).toBeGreaterThanOrEqual(inst.t0);
      expect(p.t).toBeLessThanOrEqual(ready.tReady);
    }
    expect(inst.containerOverheadMs()).toBeGreaterThanOrEqual(0);
    expect(inst.containerId).toMatch(/^[0-9a-f]{64}$/);
    expect(await inst.client.models()).toContain(m);

    // Only our container is running, with our labels.
    const ps = await s.cli.ps(['gpubench=1']);
    expect(ps.map((r) => r.labels['gpubench.marker'])).toEqual([m]);

    await inst.stop();
    expect(await s.cli.ps(['gpubench=1'])).toEqual([]);
    const lines = await logs;
    expect(lines.some((l) => l.includes('server is listening'))).toBe(true);
    // Timestamps are stripped from what the engine wrote.
    expect(lines.every((l) => !/^\d{4}-\d{2}-\d{2}T/.test(l))).toBe(true);
    expect(inst.logTail().length).toBeGreaterThan(5);
  });

  it('diagnoses an engine that rejects a flag from the container log', async () => {
    const s = setup();
    const plan = await s.adapter.plan({ kind: 'llamacpp-docker' }, s.model, params({ badFlag: '-ctk' }, { kvCacheType: 'q8_0' }), {
      port: await pickFreePort(),
      marker: marker(),
    });
    const inst = await s.adapter.start(plan, new AbortController().signal);
    await expect(inst.waitReady()).rejects.toMatchObject({ code: 'ENGINE_BAD_FLAG', params: { flag: '-ctk' } });
    await inst.stop();
    expect(await s.cli.ps(['gpubench=1'])).toEqual([]);
  });

  it('reports a busy host port and removes the half-created container', async () => {
    const s = setup();
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as net.AddressInfo).port;
    try {
      const plan = await s.adapter.plan({ kind: 'llamacpp-docker' }, s.model, params({}), { port, marker: marker() });
      await expect(s.adapter.start(plan, new AbortController().signal)).rejects.toMatchObject({ code: 'ENGINE_PORT_IN_USE' });
      expect(await s.cli.ps(['gpubench=1'])).toEqual([]);
    } finally {
      srv.close();
    }
  });

  it('reports missing GPU support and remembers it in the Docker state', async () => {
    const s = setup({ FAKE_DOCKER_MODE: 'no-gpu' });
    const plan = await s.adapter.plan({ kind: 'llamacpp-docker' }, s.model, params({}), { port: await pickFreePort(), marker: marker() });
    await expect(s.adapter.start(plan, new AbortController().signal)).rejects.toMatchObject({ code: 'DOCKER_NO_GPU' });
    expect((await s.environment.status({ fresh: true })).state).toBe('no-gpu');
    expect(await s.cli.ps(['gpubench=1'])).toEqual([]);
    await expect(s.environment.gpuCheck(IMAGE)).rejects.toMatchObject({ code: 'DOCKER_NO_GPU' });
  });

  it('installs a missing image (CLI pull fallback) before it can start', async () => {
    const s = setup({ FAKE_DOCKER_MISSING: IMAGE });
    expect(await s.adapter.detect()).toMatchObject({ installed: false, available: false, problems: ['ENGINE_NOT_INSTALLED'] });
    const plan = await s.adapter.plan({ kind: 'llamacpp-docker' }, s.model, params({}), { port: await pickFreePort(), marker: marker() });
    expect(plan.engine.imageDigest).toBeUndefined();
    await expect(s.adapter.start(plan, new AbortController().signal)).rejects.toMatchObject({ code: 'ENGINE_NOT_INSTALLED', params: { image: IMAGE } });
    const ip = await s.adapter.installPlan({ kind: 'llamacpp-docker' });
    expect(ip).toMatchObject({ kind: 'llamacpp-docker', bytes: 0, items: [{ label: IMAGE, bytes: 0 }], data: { image: IMAGE } });
    const stages: string[] = [];
    await s.adapter.install(ip, (p) => stages.push(p.stage), new AbortController().signal);
    expect(stages.at(-1)).toBe('done');
    expect((await s.adapter.detect()).installed).toBe(true);
    expect(JSON.parse(readFileSync(path.join(s.state, 'images.json'), 'utf8')).pulled).toEqual([IMAGE]);
  });

  it('checks the GPU inside the image and cleans up only our orphans', async () => {
    const s = setup();
    expect(await s.environment.gpuCheck(IMAGE)).toEqual({ image: IMAGE, gpus: ['GPU 0: NVIDIA GeForce RTX 5090 (UUID: GPU-6d2e1c3a-0f4b-4c8e-9a51-2b7d3e9f1a04)'] });
    // A foreign container and two of ours (one belonging to a run in progress).
    const foreign = await s.cli.exec(['run', '-d', '--name', 'someone-else', '-p', `127.0.0.1:${await pickFreePort()}:8080`, IMAGE, '--version']);
    const keep = marker();
    const drop = marker();
    for (const m of [keep, drop]) {
      await s.cli.exec(['run', '-d', '--name', `gpubench-${m}`, '--label', 'gpubench=1', '--label', `gpubench.marker=${m}`, IMAGE, '--version']);
    }
    const res = await s.environment.cleanupOrphans([keep]);
    expect(res.removed.map((r) => r.name)).toEqual([`gpubench-${drop}`]);
    const left = await s.cli.ps([]);
    expect(left.map((r) => r.name).sort()).toEqual([`gpubench-${keep}`, 'someone-else'].sort());
    expect(foreign.code).toBe(0);
    for (const r of left) await s.cli.rm(r.id);
  });
});
