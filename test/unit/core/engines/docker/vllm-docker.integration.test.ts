// vLLM Docker adapter through the REAL ProcessRunner, the fake docker CLI and the fake engine in
// vLLM mode; the Engine API (volume labels) is the fake API on a real named pipe / socket.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { launchParamsSchema } from '../../../../../src/contract/engines';
import type { Platform } from '../../../../../src/core/deps';
import { DockerApiProvider } from '../../../../../src/core/docker/api-provider';
import { DockerCli } from '../../../../../src/core/docker/cli';
import { DockerEnvironment } from '../../../../../src/core/docker/environment';
import { DockerHubClient } from '../../../../../src/core/docker/hub';
import { ImageService } from '../../../../../src/core/docker/images';
import { HF_PLACEHOLDER } from '../../../../../src/core/engines/command-display';
import type { ModelTarget } from '../../../../../src/core/engines/types';
import { VllmDockerAdapter } from '../../../../../src/core/engines/vllm-docker/adapter';
import { createInferenceClient } from '../../../../../src/core/inference/client';
import { systemClock } from '../../../../../src/core/node-deps';
import { pickFreePort } from '../../../../../src/core/process/ports';
import { createProcessRunner } from '../../../../../src/core/process/runner';
import { startFakeDockerApi, type FakeDockerApi } from '../../../../fakes/fake-docker/api.mjs';
import { DOCKER_FIXTURES, FAKE_DOCKER, FAKE_ENGINE, json, removeAllContainers, RESOURCES, routeFetch, silentLog, tempDir } from '../../docker/helpers';

const haveEngine = existsSync(FAKE_ENGINE);
const platform = process.platform as Platform;
const IMAGE = 'vllm/vllm-openai:v0.31.0';
const cleanups: (() => void)[] = [];
let api: FakeDockerApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});
const clis: DockerCli[] = [];
afterAll(async () => {
  for (const cli of clis) await removeAllContainers(cli);
  for (const c of cleanups) c();
});
let n = 0;
const marker = () => `gpubench-vd${process.pid}x${n++}`;

async function setup(opts: { env?: Record<string, string>; token?: string; sm?: string } = {}) {
  const t = tempDir('gb-vdock-');
  cleanups.push(t.cleanup);
  const state = path.join(t.dir, 'state');
  const baseEnv = { ...process.env, FAKE_DOCKER_STATE: state, ...opts.env };
  const proc = createProcessRunner({ clock: systemClock, platform, baseEnv });
  const cli = new DockerCli({ proc, platform, env: baseEnv, override: [process.execPath, FAKE_DOCKER] });
  clis.push(cli);
  const environment = new DockerEnvironment({ cli, clock: systemClock, platform, env: baseEnv });
  api = await startFakeDockerApi({ images: { [IMAGE]: { Id: 'sha256:img', RepoDigests: [`vllm/vllm-openai@sha256:${'d'.repeat(64)}`] } } });
  const provider = new DockerApiProvider({ resolve: async () => [{ kind: 'socket', path: api!.socketPath, source: 'override' }] });
  const tags = JSON.parse(readFileSync(path.join(DOCKER_FIXTURES, 'hub-tags-vllm.json'), 'utf8')) as unknown;
  const hub = new DockerHubClient({ fetch: routeFetch({ 'https://hub.test/': () => json(tags) }), baseUrl: 'https://hub.test', clock: systemClock });
  const images = new ImageService({ api: provider, cli, hub });
  const adapter = new VllmDockerAdapter({
    deps: { clock: systemClock, proc, fetch, platform, log: silentLog, paths: { dataDir: t.dir, cacheDir: t.dir, enginesDir: t.dir, resultsDir: t.dir, modelsDir: t.dir, resourcesDir: RESOURCES, home: t.dir } },
    cli,
    environment,
    images,
    hub,
    api: provider,
    createClient: (flavor, baseUrl, opts) => createInferenceClient(flavor, baseUrl, { fetch, clock: systemClock }, opts),
    hfToken: () => opts.token,
    gpuSm: async () => opts.sm,
    pollMs: 30,
    readyTimeoutMs: 30_000,
    stopTimeoutSec: 2,
  });
  return { t, state, cli, adapter, environment };
}

const repoModel: ModelTarget = { identity: { displayName: 'Qwen3 0.6B', format: 'safetensors', source: 'hf', repo: 'Qwen/Qwen3-0.6B', files: [], weakKey: 'q' } };
const params = (profile: object) => launchParamsSchema.parse({ contextSize: 4096, env: { FAKE_ENGINE_PROFILE: JSON.stringify(profile) } });

describe.skipIf(!haveEngine)('vLLM Docker adapter with the fake docker CLI', () => {
  it('starts vLLM with persistent caches, passes HF_TOKEN by name and waits for the served model', async () => {
    const s = await setup({ token: 'hf_secret_value' });
    const m = marker();
    const port = await pickFreePort();
    const plan = await s.adapter.plan({ kind: 'vllm-docker' }, repoModel, params({ loadMsWarm: 200 }), { port, marker: m });
    const afterImage = plan.argv.slice(plan.argv.indexOf(IMAGE));
    expect(afterImage).toEqual([
      IMAGE,
      'Qwen/Qwen3-0.6B',
      '--served-model-name',
      m,
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
    expect(plan.argv).toEqual(expect.arrayContaining(['--ipc=host', 'gpubench-hf-cache:/root/.cache/huggingface', 'gpubench-vllm-cache:/root/.cache/vllm', 'HF_TOKEN']));
    expect(plan.argv.join(' ')).not.toContain('hf_secret_value');
    expect(plan.env.HF_TOKEN).toBe(HF_PLACEHOLDER);
    expect(plan.engine).toMatchObject({ kind: 'vllm-docker', name: 'vLLM', image: IMAGE, version: 'v0.31.0', imageDigest: `sha256:${'d'.repeat(64)}` });
    expect(plan.modelRepo).toBe('Qwen/Qwen3-0.6B');
    expect(plan.slowSharedFilesystem).toBe(false);

    const inst = await s.adapter.start(plan, new AbortController().signal);
    const ready = await inst.waitReady();
    // The fake binds right before logging 'Starting vLLM API server': that mark may fall after ready.
    expect(ready.phases.map((p) => p.name)).toEqual(expect.arrayContaining(['container', 'engine_start', 'engine_init', 'model_load', 'kv_cache']));
    expect(ready.phases.every((p) => p.t <= ready.tReady)).toBe(true);
    expect(await inst.client.models()).toEqual([m]);
    // The container received the real token through the CLI environment, never through argv.
    const containers = JSON.parse(readFileSync(path.join(s.state, 'containers.json'), 'utf8')) as { env: Record<string, string>; args: string[] }[];
    expect(containers[0]?.env.HF_TOKEN).toBe('hf_secret_value');
    expect(containers[0]?.args.join(' ')).not.toContain('hf_secret_value');
    // Our cache volumes carry the gpubench label.
    expect(api!.state.volumes.get('gpubench-hf-cache')).toMatchObject({ Labels: { gpubench: '1' } });
    await inst.stop();
    expect(await s.cli.ps(['gpubench=1'])).toEqual([]);
  });

  it('diagnoses "no kernel image" and proposes a compatible tag', async () => {
    const s = await setup({ sm: 'sm_120' });
    const plan = await s.adapter.plan({ kind: 'vllm-docker', image: IMAGE }, repoModel, params({ noKernelImage: true }), {
      port: await pickFreePort(),
      marker: marker(),
    });
    const inst = await s.adapter.start(plan, new AbortController().signal);
    await expect(inst.waitReady()).rejects.toMatchObject({ code: 'ENGINE_NO_KERNEL_IMAGE', params: { suggestedTag: 'v0.31.0' } });
    await inst.stop();
  });

  it('mounts a local safetensors folder read-only and lists tags for this GPU', async () => {
    const s = await setup({ sm: 'sm_120' });
    const dir = path.join(s.t.dir, 'Qwen3-0.6B');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'model.safetensors'), Buffer.alloc(100));
    const identity = { ...repoModel.identity, source: 'local' as const };
    const local: ModelTarget = {
      identity,
      local: { id: 'l', identity, paths: [path.join(dir, 'model.safetensors')], auxiliary: [], dir, origin: 'library', modifiedAt: '' },
    };
    const port = await pickFreePort();
    const m = marker();
    const plan = await s.adapter.plan({ kind: 'vllm-docker' }, local, params({ loadMsWarm: 100 }), { port, marker: m });
    expect(plan.argv).toContain(`${dir}:/models/Qwen3-0.6B:ro`);
    expect(plan.argv[plan.argv.indexOf(IMAGE) + 1]).toBe('/models/Qwen3-0.6B');
    expect(plan.modelBytes).toBe(100);
    expect(plan.modelRepo).toBeUndefined();
    expect(plan.slowSharedFilesystem).toBe(platform !== 'linux');
    const inst = await s.adapter.start(plan, new AbortController().signal);
    await inst.waitReady();
    await inst.stop();

    const tags = await s.adapter.tags();
    expect(tags.map((t) => t.name)).toEqual(['v0.31.0-cu129', 'v0.31.0', 'v0.30.0', 'v0.29.0', 'v0.9.2', 'v0.9.0']);
    expect(tags.find((t) => t.name === 'v0.31.0')).toMatchObject({ recommended: true, supportsGpu: true, cuda: '13.0', sizeBytes: 9035211086 });
    expect(tags.find((t) => t.name === 'v0.31.0-cu129')).toMatchObject({ recommended: false, cuda: '12.9' });
    expect(tags.find((t) => t.name === 'v0.9.0')).toMatchObject({ supportsGpu: false });
    expect(tags.find((t) => t.name === 'v0.9.2')).toMatchObject({ supportsGpu: true, cuda: '12.8' });
  });
});
