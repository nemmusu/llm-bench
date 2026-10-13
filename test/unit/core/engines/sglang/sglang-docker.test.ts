// SGLang in Docker: the REAL ProcessRunner, the fake docker CLI and the fake engine in SGLang mode
// (the image runs `python3 -m sglang.launch_server …`); Docker Hub tags from a recorded listing.
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
import { BUILTIN_COMPAT } from '../../../../../src/core/engines/shared/compat';
import { SglangDockerAdapter, sglangCudaOfTag, sglangTagOf } from '../../../../../src/core/engines/sglang-docker/adapter';
import type { ModelTarget } from '../../../../../src/core/engines/types';
import { createInferenceClient } from '../../../../../src/core/inference/client';
import { systemClock } from '../../../../../src/core/node-deps';
import { pickFreePort } from '../../../../../src/core/process/ports';
import { createProcessRunner } from '../../../../../src/core/process/runner';
import { startFakeDockerApi, type FakeDockerApi } from '../../../../fakes/fake-docker/api.mjs';
import { DOCKER_FIXTURES, FAKE_DOCKER, FAKE_ENGINE, json, removeAllContainers, RESOURCES, routeFetch, silentLog, tempDir } from '../../docker/helpers';

const haveEngine = existsSync(FAKE_ENGINE);
const platform = process.platform as Platform;
const IMAGE = 'lmsysorg/sglang:v0.5.21';
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
const marker = () => `gpubench-sd${process.pid}x${n++}`;

async function setup(opts: { token?: string; images?: Record<string, unknown>; noApi?: boolean } = {}) {
  const t = tempDir('gb-sdock-');
  cleanups.push(t.cleanup);
  const state = path.join(t.dir, 'state');
  const baseEnv = { ...process.env, FAKE_DOCKER_STATE: state };
  const proc = createProcessRunner({ clock: systemClock, platform, baseEnv });
  const cli = new DockerCli({ proc, platform, env: baseEnv, override: [process.execPath, FAKE_DOCKER] });
  clis.push(cli);
  const environment = new DockerEnvironment({ cli, clock: systemClock, platform, env: baseEnv });
  api = await startFakeDockerApi({ images: (opts.images ?? { [IMAGE]: { Id: 'sha256:simg', RepoDigests: [`lmsysorg/sglang@sha256:${'c'.repeat(64)}`] } }) as never });
  const provider = new DockerApiProvider({ resolve: async () => [{ kind: 'socket', path: api!.socketPath, source: 'override' }] });
  const tags = JSON.parse(readFileSync(path.join(DOCKER_FIXTURES, 'hub-tags-sglang.json'), 'utf8')) as unknown;
  const hub = new DockerHubClient({ fetch: routeFetch({ 'https://hub.test/': () => json(tags) }), baseUrl: 'https://hub.test', clock: systemClock });
  const images = new ImageService({ api: provider, cli, hub });
  const adapter = new SglangDockerAdapter({
    deps: { clock: systemClock, proc, fetch, platform, log: silentLog, paths: { dataDir: t.dir, cacheDir: t.dir, enginesDir: t.dir, resultsDir: t.dir, modelsDir: t.dir, resourcesDir: RESOURCES, home: t.dir } },
    cli,
    environment,
    images,
    hub,
    ...(opts.noApi ? {} : { api: provider }),
    createClient: (flavor, baseUrl, o) => createInferenceClient(flavor, baseUrl, { fetch, clock: systemClock }, o),
    hfToken: () => opts.token,
    pollMs: 30,
    readyTimeoutMs: 30_000,
    stopTimeoutSec: 2,
  });
  return { t, state, cli, adapter };
}

const repoModel: ModelTarget = { identity: { displayName: 'Qwen3 0.6B', format: 'safetensors', source: 'hf', repo: 'Qwen/Qwen3-0.6B', files: [], weakKey: 'q' } };
const params = (profile: object, over: object = {}) => launchParamsSchema.parse({ contextSize: 4096, env: { FAKE_ENGINE_PROFILE: JSON.stringify(profile) }, ...over });

describe('SGLang image tags', () => {
  it('reads CUDA and the tag from an image reference', () => {
    expect(sglangCudaOfTag('v0.5.21-cu130')).toBe('13.0');
    expect(sglangCudaOfTag('v0.5.20.post1-cu129')).toBe('12.9');
    expect(sglangCudaOfTag('v0.5.21')).toBeUndefined();
    expect(sglangTagOf('lmsysorg/sglang:v0.5.21', BUILTIN_COMPAT)).toBe('v0.5.21');
    expect(sglangTagOf('lmsysorg/sglang', BUILTIN_COMPAT)).toBe('latest');
    expect(sglangTagOf('me/sglang-fork:1', BUILTIN_COMPAT)).toBeUndefined();
    expect(sglangTagOf('ghcr.io/lmsysorg/sglang:v1', BUILTIN_COMPAT)).toBeUndefined();
    expect(sglangTagOf('-bad', BUILTIN_COMPAT)).toBeUndefined();
  });
});

describe.skipIf(!haveEngine)('SGLang Docker adapter with the fake docker CLI', () => {
  it('lists NVIDIA release tags, the recommended one marked', async () => {
    const s = await setup();
    const tags = await s.adapter.tags();
    expect(tags.map((t) => t.name)).toEqual(['v0.5.21-cu130', 'v0.5.21', 'v0.5.21-cu130-runtime', 'v0.5.20.post1-cu129']);
    expect(tags.find((t) => t.recommended)?.name).toBe('v0.5.21');
    expect(tags[0]).toMatchObject({ cuda: '13.0', sizeBytes: 15164770325 });
  });

  it('starts SGLang with the HF cache, HF_TOKEN by name, and waits for the served name', async () => {
    const s = await setup({ token: 'hf_secret_value' });
    const m = marker();
    const port = await pickFreePort();
    const plan = await s.adapter.plan({ kind: 'sglang-docker' }, repoModel, params({ loadMsWarm: 200 }), { port, marker: m });
    const afterImage = plan.argv.slice(plan.argv.indexOf(IMAGE));
    expect(afterImage.slice(0, 6)).toEqual([IMAGE, 'python3', '-m', 'sglang.launch_server', '--model-path', 'Qwen/Qwen3-0.6B']);
    expect(afterImage).toEqual(expect.arrayContaining(['--served-model-name', m, '--host', '0.0.0.0', '--port', '30000', '--enable-cache-report']));
    expect(plan.argv).toEqual(expect.arrayContaining(['--ipc=host', 'gpubench-hf-cache:/root/.cache/huggingface', 'HF_TOKEN']));
    expect(plan.argv.join(' ')).not.toContain('hf_secret_value');
    expect(plan.env.HF_TOKEN).toBe(HF_PLACEHOLDER);
    expect(plan.engine).toMatchObject({ kind: 'sglang-docker', name: 'SGLang', image: IMAGE, version: 'v0.5.21', imageDigest: `sha256:${'c'.repeat(64)}` });
    expect(plan).toMatchObject({ modelRepo: 'Qwen/Qwen3-0.6B', slowSharedFilesystem: false });

    const inst = await s.adapter.start(plan, new AbortController().signal);
    const ready = await inst.waitReady();
    expect(ready.phases.map((p) => p.name)).toEqual(expect.arrayContaining(['load_tensors', 'kv_cache', 'graph_capture']));
    expect(await inst.client.models()).toEqual([m]);
    const ids = await inst.client.tokenize('hello there', { addSpecial: true });
    const events = [];
    for await (const e of inst.client.generate({ promptIds: ids, outputTokens: 4, seed: 1 })) events.push(e);
    expect(events.at(-1)).toMatchObject({ kind: 'done', usage: { completionTokens: 4 } });
    const containers = JSON.parse(readFileSync(path.join(s.state, 'containers.json'), 'utf8')) as { env: Record<string, string> }[];
    expect(containers[0]?.env.HF_TOKEN).toBe('hf_secret_value');
    expect(api!.state.volumes.get('gpubench-hf-cache')).toMatchObject({ Labels: { gpubench: '1' } });
    await inst.stop();
    expect(await s.cli.ps(['gpubench=1'])).toEqual([]);
  });

  it('reads the image help once, and a fork image is planned with its own options', async () => {
    const s = await setup({ noApi: true });
    const caps = await s.adapter.capabilities({ kind: 'sglang-docker' });
    expect(caps).toMatchObject({ version: 'v0.5.21', tokenIdsInPrompt: true, minTokens: true });
    expect(caps.choices?.['--kv-cache-dtype']).toContain('fp8_e4m3');
    expect(await s.adapter.capabilities({ kind: 'sglang-docker' })).toEqual(caps);
    const known = new Set([...caps.flags].filter((f) => f !== '--chunked-prefill-size'));
    const plan = await s.adapter.plan({ kind: 'sglang-docker' }, repoModel, params({}, { batchSize: 4096 }), { port: 1, marker: marker(), knownFlags: known, apiName: 'Qwen3-0.6B' });
    expect(plan.argv).not.toContain('--chunked-prefill-size');
    expect(plan.argv[plan.argv.indexOf('--served-model-name') + 1]).toBe('Qwen3-0.6B');
    expect(plan.unsupported).toEqual([{ flag: '--chunked-prefill-size', setting: 'batchSize', effect: 'default' }]);
    // A missing image: no options known; a custom image: no version.
    const missing = await s.adapter.capabilities({ kind: 'sglang-docker', image: 'lmsysorg/sglang:v0.5.4' });
    expect(missing.flags.size).toBe(0);
    const other = await s.adapter.plan({ kind: 'sglang-docker', image: 'lmsysorg/sglang:latest' }, repoModel, params({}), { port: 1, marker: marker() });
    expect(other.engine).not.toHaveProperty('version');
  });

  it('mounts a local safetensors folder and starts without the volume API', async () => {
    const s = await setup({ noApi: true });
    const dir = path.join(s.t.dir, 'Qwen3-0.6B');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'model.safetensors'), Buffer.alloc(100));
    const identity = { ...repoModel.identity, source: 'local' as const };
    const local: ModelTarget = { identity, local: { id: 'l', identity, paths: [path.join(dir, 'model.safetensors')], auxiliary: [], dir, origin: 'library', modifiedAt: '' } };
    const plan = await s.adapter.plan({ kind: 'sglang-docker' }, local, params({ loadMsWarm: 100 }), { port: await pickFreePort(), marker: marker() });
    expect(plan.argv).toContain(`${dir}:/models/Qwen3-0.6B:ro`);
    expect(plan.argv[plan.argv.indexOf('--model-path') + 1]).toBe('/models/Qwen3-0.6B');
    expect(plan.modelFiles).toEqual([path.join(dir, 'model.safetensors')]);
    expect(plan).not.toHaveProperty('modelRepo');
    const inst = await s.adapter.start(plan, new AbortController().signal);
    await inst.waitReady();
    await inst.stop();
  });

  it('diagnoses an out-of-memory start, and refuses a missing image', async () => {
    const s = await setup();
    const plan = await s.adapter.plan({ kind: 'sglang-docker' }, repoModel, params({ loadMsWarm: 100, oomAtLoad: true }), { port: await pickFreePort(), marker: marker() });
    const inst = await s.adapter.start(plan, new AbortController().signal);
    await expect(inst.waitReady()).rejects.toMatchObject({ code: 'ENGINE_OOM' });
    await inst.stop();
    const gone = await s.adapter.plan({ kind: 'sglang-docker', image: 'lmsysorg/sglang:v0.4.0' }, repoModel, params({}), { port: 1, marker: marker() });
    await expect(s.adapter.start(gone, new AbortController().signal)).rejects.toMatchObject({ code: 'ENGINE_NOT_INSTALLED', params: { reason: 'image-missing' } });
  });

  it('survives a volume API that fails', async () => {
    const s = await setup();
    await api?.close();
    const plan = await s.adapter.plan({ kind: 'sglang-docker' }, repoModel, params({ loadMsWarm: 50 }), { port: await pickFreePort(), marker: marker() });
    // The image check goes through the CLI and labelling the volume is best effort: it still starts.
    const inst = await s.adapter.start(plan, new AbortController().signal);
    await inst.waitReady();
    await inst.stop();
  });
});
