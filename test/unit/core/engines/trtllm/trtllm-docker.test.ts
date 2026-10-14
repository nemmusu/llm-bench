// TensorRT-LLM in Docker: the REAL ProcessRunner, the fake docker CLI and the fake engine as trtllm-serve
// (the image runs `trtllm-serve serve <model> …`); NGC answered by a stub registry.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { launchParamsSchema } from '../../../../../src/contract/engines';
import type { Platform } from '../../../../../src/core/deps';
import { DockerApiProvider } from '../../../../../src/core/docker/api-provider';
import { DockerCli } from '../../../../../src/core/docker/cli';
import { DockerEnvironment } from '../../../../../src/core/docker/environment';
import { ImageService } from '../../../../../src/core/docker/images';
import { HF_PLACEHOLDER } from '../../../../../src/core/engines/command-display';
import { BUILTIN_COMPAT } from '../../../../../src/core/engines/shared/compat';
import { registryPath, TrtllmDockerAdapter, trtllmTagOf } from '../../../../../src/core/engines/trtllm-docker/adapter';
import type { NgcTag } from '../../../../../src/core/engines/trtllm-docker/ngc';
import type { ModelTarget } from '../../../../../src/core/engines/types';
import { createInferenceClient } from '../../../../../src/core/inference/client';
import { systemClock } from '../../../../../src/core/node-deps';
import { pickFreePort } from '../../../../../src/core/process/ports';
import { createProcessRunner } from '../../../../../src/core/process/runner';
import { startFakeDockerApi, type FakeDockerApi } from '../../../../fakes/fake-docker/api.mjs';
import { FAKE_DOCKER, removeAllContainers, RESOURCES, silentLog, tempDir } from '../../docker/helpers';

const platform = process.platform as Platform;
const IMAGE = 'nvcr.io/nvidia/tensorrt-llm/release:1.4.0rc0';
const DIGEST = `sha256:${'d'.repeat(64)}`;
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
const marker = () => `gpubench-td${process.pid}x${n++}`;

/** NGC's answers: tags newest-unordered, sizes for the ones asked. */
function stubNgc(o: { fail?: boolean } = {}) {
  const asked: string[] = [];
  return {
    asked,
    listTags: async () => {
      if (o.fail) throw new Error('down');
      return ['1.2.1', '1.4.0rc0', '1.3.0rc29', '1.4.0rc1.dev2026', 'gb300-ea', '1.2.0', '1.1.0', '1.0.0', '0.21.0', '0.20.0'];
    },
    tagInfo: async (_repo: string, tag: string): Promise<NgcTag> => {
      asked.push(tag);
      if (o.fail || tag === '1.3.0rc29') throw new Error('down');
      return { name: tag, sizeBytes: 17_570_000_000, digest: tag === '1.4.0rc0' ? 'sha256:index' : `sha256:${tag}` };
    },
  };
}

async function setup(opts: { token?: string; noApi?: boolean; ngcFail?: boolean; missing?: string; mode?: string; bare?: boolean; imageId?: string } = {}) {
  const t = tempDir('gb-tdock-');
  cleanups.push(t.cleanup);
  const state = path.join(t.dir, 'state');
  const baseEnv = { ...process.env, FAKE_DOCKER_STATE: state, ...(opts.missing ? { FAKE_DOCKER_MISSING: opts.missing } : {}), ...(opts.mode ? { FAKE_DOCKER_MODE: opts.mode } : {}) };
  const proc = createProcessRunner({ clock: systemClock, platform, baseEnv });
  const cli = new DockerCli({ proc, platform, env: baseEnv, override: [process.execPath, FAKE_DOCKER] });
  clis.push(cli);
  const environment = new DockerEnvironment({ cli, clock: systemClock, platform, env: baseEnv });
  api = await startFakeDockerApi({ images: { [IMAGE]: { Id: opts.imageId ?? 'sha256:timg', RepoDigests: [`nvcr.io/nvidia/tensorrt-llm/release@${DIGEST}`] } } as never });
  const provider = new DockerApiProvider({ resolve: async () => [{ kind: 'socket', path: api!.socketPath, source: 'override' }] });
  const images = new ImageService({ api: provider, cli });
  const ngc = stubNgc({ fail: opts.ngcFail === true });
  const adapter = new TrtllmDockerAdapter({
    deps: { clock: systemClock, proc, fetch, platform, log: silentLog, paths: { dataDir: t.dir, cacheDir: t.dir, enginesDir: t.dir, resultsDir: t.dir, modelsDir: t.dir, resourcesDir: RESOURCES, home: t.dir } },
    cli,
    environment,
    images,
    ngc,
    ...(opts.noApi ? {} : { api: provider }),
    createClient: (flavor, baseUrl, o) => createInferenceClient(flavor, baseUrl, { fetch, clock: systemClock }, o),
    hfToken: () => opts.token,
    ...(opts.bare ? {} : { pollMs: 30, readyTimeoutMs: 30_000, stopTimeoutSec: 2 }),
  });
  return { t, state, cli, adapter, ngc, environment };
}

const repoModel: ModelTarget = { identity: { displayName: 'Qwen3 8B FP8', format: 'safetensors', source: 'hf', repo: 'nvidia/Qwen3-8B-FP8', revision: 'abc', files: [], weakKey: 'q' }, repo: 'nvidia/Qwen3-8B-FP8' };
const params = (profile: object, over: object = {}) => launchParamsSchema.parse({ contextSize: 4096, env: { FAKE_ENGINE_PROFILE: JSON.stringify(profile) }, ...over });

describe('TensorRT-LLM image references', () => {
  it('reads the tag of its NGC image only', () => {
    expect(trtllmTagOf(IMAGE, BUILTIN_COMPAT)).toBe('1.4.0rc0');
    expect(trtllmTagOf('nvcr.io/nvidia/tensorrt-llm/release', BUILTIN_COMPAT)).toBe('latest');
    expect(trtllmTagOf('me/tensorrt-llm:1', BUILTIN_COMPAT)).toBeUndefined();
    expect(trtllmTagOf('-bad', BUILTIN_COMPAT)).toBeUndefined();
    expect(registryPath(IMAGE)).toBe('nvidia/tensorrt-llm/release');
  });
});

describe('TensorRT-LLM Docker adapter with the fake docker CLI', { timeout: 60_000 }, () => {
  it('lists release tags newest first, the recommended one marked, the newest sized', async () => {
    const s = await setup();
    const tags = await s.adapter.tags();
    expect(tags.map((t) => t.name)).toEqual(['1.4.0rc0', '1.3.0rc29', '1.2.1', '1.2.0', '1.1.0', '1.0.0', '0.21.0', '0.20.0']);
    expect(tags[0]).toEqual({ name: '1.4.0rc0', recommended: true, prerelease: true, sizeBytes: 17_570_000_000, digest: 'sha256:index' });
    // A size that could not be read is left out; past the newest few, none is asked.
    expect(tags[1]).toEqual({ name: '1.3.0rc29', recommended: false, prerelease: true });
    expect(tags[2]).toMatchObject({ prerelease: false, sizeBytes: 17_570_000_000 });
    expect(tags.at(-1)).toEqual({ name: '0.20.0', recommended: false, prerelease: false });
    expect(s.ngc.asked).not.toContain('0.20.0');
    await expect((await setup({ ngcFail: true })).adapter.tags()).rejects.toThrow('down');
  });

  it('reads an image’s digest on NGC, nothing for other registries', async () => {
    const s = await setup();
    expect(await s.adapter.remoteTag(IMAGE)).toMatchObject({ name: '1.4.0rc0', digest: 'sha256:index', recommended: true, prerelease: true });
    expect(await s.adapter.remoteTag('nvcr.io/nvidia/tensorrt-llm/release')).toMatchObject({ name: 'latest', recommended: false, prerelease: false });
    expect(await s.adapter.remoteTag('me/trt:1')).toBeUndefined();
    expect(await s.adapter.remoteTag(`nvcr.io/nvidia/tensorrt-llm/release@${DIGEST}`)).toBeUndefined();
  });

  it('sizes the install from NGC, another image as every Docker engine', async () => {
    const s = await setup();
    expect(await s.adapter.installPlan({ kind: 'trtllm-docker' })).toMatchObject({ bytes: 17_570_000_000, label: `TensorRT-LLM (${IMAGE})`, data: { image: IMAGE } });
    expect((await s.adapter.installPlan({ kind: 'trtllm-docker', image: 'nvcr.io/nvidia/tensorrt-llm/release' })).bytes).toBe(17_570_000_000);
    expect((await (await setup({ ngcFail: true })).adapter.installPlan({ kind: 'trtllm-docker' })).bytes).toBe(0);
    expect((await s.adapter.installPlan({ kind: 'trtllm-docker', image: 'me/trt:1' })).bytes).toBe(0);
  });

  it('starts trtllm-serve with the HF cache, HF_TOKEN by name, and serves the fake model', async () => {
    const s = await setup({ token: 'hf_secret_value' });
    const m = marker();
    const plan = await s.adapter.plan({ kind: 'trtllm-docker' }, repoModel, params({ loadMsWarm: 200 }, { ropeScaling: { type: 'yarn', factor: 2, originalContext: 4096 } }), { port: await pickFreePort(), marker: m });
    const afterImage = plan.argv.slice(plan.argv.indexOf(IMAGE));
    expect(afterImage.slice(0, 4)).toEqual([IMAGE, 'trtllm-serve', 'serve', 'nvidia/Qwen3-8B-FP8']);
    expect(afterImage).toEqual(expect.arrayContaining(['--served_model_name', m, '--host', '0.0.0.0', '--port', '8000', '--hf_revision', 'abc', '--enable_chunked_prefill']));
    expect(plan.argv).toEqual(expect.arrayContaining(['--ipc=host', '--ulimit', 'memlock=-1', 'stack=67108864', 'gpubench-hf-cache:/root/.cache/huggingface', 'HF_TOKEN']));
    expect(plan.argv.join(' ')).not.toContain('hf_secret_value');
    expect(plan.env.HF_TOKEN).toBe(HF_PLACEHOLDER);
    expect(plan.engine).toMatchObject({ kind: 'trtllm-docker', name: 'TensorRT-LLM', image: IMAGE, version: '1.4.0rc0', imageDigest: DIGEST });
    expect(plan).toMatchObject({ modelRepo: 'nvidia/Qwen3-8B-FP8', slowSharedFilesystem: false, unsupported: [{ flag: '--rope_scaling', setting: 'ropeScaling', effect: 'default' }] });

    const inst = await s.adapter.start(plan, new AbortController().signal);
    const ready = await inst.waitReady();
    expect(ready.phases.map((p) => p.name)).toEqual(expect.arrayContaining(['engine_init', 'load_tensors', 'kv_cache', 'graph_capture']));
    expect(await inst.client.models()).toEqual([m]);
    expect(inst.client.flavor).toBe('trtllm');
    const ids = await inst.client.tokenize('hello there', { addSpecial: false });
    expect(ids[0]).not.toBe(1);
    const events = [];
    for await (const e of inst.client.generate({ promptIds: ids, outputTokens: 4, seed: 1 })) events.push(e);
    expect(events.at(-1)).toMatchObject({ kind: 'done', usage: { completionTokens: 4, promptTokens: ids.length } });
    const containers = JSON.parse(readFileSync(path.join(s.state, 'containers.json'), 'utf8')) as { env: Record<string, string> }[];
    expect(containers[0]?.env.HF_TOKEN).toBe('hf_secret_value');
    expect(api!.state.volumes.get('gpubench-hf-cache')).toMatchObject({ Labels: { gpubench: '1' } });
    // A running container keeps its image.
    await expect(s.adapter.remove({ kind: 'trtllm-docker' })).rejects.toMatchObject({ code: 'ENGINE_UPDATE_FAILED', params: { reason: 'busy' } });
    await inst.stop();
    expect(await s.cli.ps(['gpubench=1'])).toEqual([]);
  });

  it('reads the image help once (with the GPU), and an older image is planned with its own options', async () => {
    const s = await setup({ noApi: true });
    const caps = await s.adapter.capabilities({ kind: 'trtllm-docker' });
    expect(caps).toMatchObject({ version: '1.4.0rc0', tokenIdsInPrompt: true, minTokens: true, timings: false });
    expect(caps.choices?.['--kv_cache_dtype']).toEqual(['auto', 'fp8', 'nvfp4']);
    expect(await s.adapter.capabilities({ kind: 'trtllm-docker' })).toEqual(caps);
    const known = new Set([...caps.flags].filter((f) => f !== '--enable_chunked_prefill'));
    const plan = await s.adapter.plan({ kind: 'trtllm-docker' }, repoModel, params({}), { port: 1, marker: marker(), knownFlags: known, apiName: 'Qwen3-8B' });
    expect(plan.argv).not.toContain('--enable_chunked_prefill');
    expect(plan.argv[plan.argv.indexOf('--served_model_name') + 1]).toBe('Qwen3-8B');
    expect(plan.unsupported).toEqual([{ flag: '--enable_chunked_prefill', setting: 'trtllm.chunkedPrefill', effect: 'default' }]);
    // A missing image: no options known; another image: no version.
    expect((await s.adapter.capabilities({ kind: 'trtllm-docker', image: 'nvcr.io/nvidia/tensorrt-llm/release:1.2.1' })).flags.size).toBe(0);
    const other = await s.adapter.plan({ kind: 'trtllm-docker', image: 'nvcr.io/nvidia/tensorrt-llm/release:latest' }, repoModel, params({}), { port: 1, marker: marker() });
    expect(other.engine).not.toHaveProperty('version');
    expect(other).not.toHaveProperty('unsupported');
  });

  it('mounts a local checkpoint folder and starts without the volume API', async () => {
    const s = await setup({ noApi: true });
    const dir = path.join(s.t.dir, 'Qwen3.8-27B-NVFP4');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'model.safetensors'), Buffer.alloc(100));
    const identity = { ...repoModel.identity, source: 'local' as const };
    const local: ModelTarget = { identity, local: { id: 'l', identity, paths: [path.join(dir, 'model.safetensors')], auxiliary: [], dir, origin: 'library', modifiedAt: '' } };
    const plan = await s.adapter.plan({ kind: 'trtllm-docker' }, local, params({ loadMsWarm: 100 }), { port: await pickFreePort(), marker: marker() });
    expect(plan.argv).toContain(`${dir}:/models/Qwen3.8-27B-NVFP4:ro`);
    expect(plan.argv[plan.argv.indexOf('serve') + 1]).toBe('/models/Qwen3.8-27B-NVFP4');
    expect(plan.modelFiles).toEqual([path.join(dir, 'model.safetensors')]);
    expect(plan).not.toHaveProperty('modelRepo');
    const inst = await s.adapter.start(plan, new AbortController().signal);
    await inst.waitReady();
    await inst.stop();
  });

  it('a local model that fails names no repository', async () => {
    const s = await setup({ noApi: true });
    const dir = path.join(s.t.dir, 'Qwen3-8B');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'model.safetensors'), Buffer.alloc(100));
    const identity = { ...repoModel.identity, source: 'local' as const };
    const local: ModelTarget = { identity, local: { id: 'l', identity, paths: [path.join(dir, 'model.safetensors')], auxiliary: [], dir, origin: 'library', modifiedAt: '' } };
    const bad = await s.adapter.plan({ kind: 'trtllm-docker' }, local, params({ loadMsWarm: 100, noKernelImage: true }), { port: await pickFreePort(), marker: marker() });
    const inst2 = await s.adapter.start(bad, new AbortController().signal);
    const e = await inst2.waitReady().catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'ENGINE_NO_KERNEL_IMAGE' });
    expect(e).not.toHaveProperty('params.repo');
    await inst2.stop();
  });

  it('without the GPU in Docker: said, and noted for Docker’s status; an image of another name has no version', async () => {
    const s = await setup({ mode: 'no-gpu', bare: true, imageId: '' });
    const plan = await s.adapter.plan({ kind: 'trtllm-docker' }, repoModel, params({}), { port: await pickFreePort(), marker: marker() });
    await expect(s.adapter.start(plan, new AbortController().signal)).rejects.toMatchObject({ code: 'DOCKER_NO_GPU' });
    const caps = await s.adapter.capabilities({ kind: 'trtllm-docker', image: 'me/trt:1' });
    expect(caps).not.toHaveProperty('version');
  });

  it('diagnoses an out-of-memory start and a KV pool too small, and refuses a missing image', async () => {
    const s = await setup();
    const oom = await s.adapter.plan({ kind: 'trtllm-docker' }, repoModel, params({ loadMsWarm: 100, oomAtLoad: true }), { port: await pickFreePort(), marker: marker() });
    const inst = await s.adapter.start(oom, new AbortController().signal);
    await expect(inst.waitReady()).rejects.toMatchObject({ code: 'ENGINE_OOM' });
    await inst.stop();
    const memory = { totalMiB: 32_000, freeMiB: 30_000, weightsMiB: 20_000, kvMiBPer1k: 1000 };
    const small = await s.adapter.plan({ kind: 'trtllm-docker' }, repoModel, params({ loadMsWarm: 100, memory }, { contextSize: 32_768 }), { port: await pickFreePort(), marker: marker() });
    const inst2 = await s.adapter.start(small, new AbortController().signal);
    await expect(inst2.waitReady()).rejects.toMatchObject({ code: 'ENGINE_OOM', params: { reason: 'kv-cache' } });
    await inst2.stop();
    const gone = await s.adapter.plan({ kind: 'trtllm-docker', image: 'nvcr.io/nvidia/tensorrt-llm/release:1.0.0' }, repoModel, params({}), { port: 1, marker: marker() });
    await expect(s.adapter.start(gone, new AbortController().signal)).rejects.toMatchObject({ code: 'ENGINE_NOT_INSTALLED', params: { reason: 'image-missing' } });
  });

  it('survives a volume API that fails', async () => {
    const s = await setup();
    await api?.close();
    const plan = await s.adapter.plan({ kind: 'trtllm-docker' }, repoModel, params({ loadMsWarm: 50 }), { port: await pickFreePort(), marker: marker() });
    const inst = await s.adapter.start(plan, new AbortController().signal);
    await inst.waitReady();
    await inst.stop();
  });

  it('removes its image ("Rimuovi"); an image already gone is fine; Docker down is said', async () => {
    const s = await setup();
    await s.adapter.remove({ kind: 'trtllm-docker' });
    // The image is gone for the CLI; removing it again is not an error.
    await s.adapter.remove({ kind: 'trtllm-docker' });
    const down = await setup();
    mkdirSync(down.state, { recursive: true });
    writeFileSync(path.join(down.state, 'mode.json'), JSON.stringify({ mode: 'daemon-down' }));
    await expect(down.adapter.remove({ kind: 'trtllm-docker' })).rejects.toMatchObject({ code: 'DOCKER_NOT_RUNNING' });
    await api?.close();
    // Nothing to ask: no options known.
    expect((await down.adapter.capabilities({ kind: 'trtllm-docker' })).flags.size).toBe(0);
  });
});
