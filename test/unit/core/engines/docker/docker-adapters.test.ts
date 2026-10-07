import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { launchParamsSchema } from '../../../../../src/contract/engines';
import { AppError } from '../../../../../src/contract/errors';
import type { RunOutput } from '../../../../../src/core/deps';
import type { DockerApiProvider } from '../../../../../src/core/docker/api-provider';
import { DockerCli } from '../../../../../src/core/docker/cli';
import type { DockerApi, ImageInfo } from '../../../../../src/core/docker/client';
import type { DockerEnvironment, DockerStatusDetail } from '../../../../../src/core/docker/environment';
import { DockerHubClient } from '../../../../../src/core/docker/hub';
import type { ImageService } from '../../../../../src/core/docker/images';
import type { PullProgress } from '../../../../../src/core/docker/pull-progress';
import { defaultLlamaCaps, LlamaDockerAdapter, llamaServerArgs } from '../../../../../src/core/engines/llamacpp-docker/adapter';
import { capsFromOutputs } from '../../../../../src/core/engines/llamacpp-native/caps';
import { BUILTIN_COMPAT, type EngineCompat } from '../../../../../src/core/engines/shared/compat';
import type { ModelTarget } from '../../../../../src/core/engines/types';
import { VllmDockerAdapter } from '../../../../../src/core/engines/vllm-docker/adapter';
import { fail, json, manualProcess, ok, recordingLog, RESOURCES, routeFetch, scriptedProc, silentLog, steppingClock, tempDir } from '../../docker/helpers';

const LLAMA_FIXTURES = path.resolve(RESOURCES, '..', 'test', 'fixtures', 'llamacpp');
const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups) c();
});

function make(o: {
  handler?: (args: string[]) => RunOutput | Promise<RunOutput>;
  status?: DockerStatusDetail['state'];
  images?: Record<string, ImageInfo>;
  inspectError?: AppError;
  size?: number;
  platform?: 'win32' | 'linux';
  compat?: EngineCompat;
  log?: ReturnType<typeof recordingLog>;
} = {}) {
  const proc = scriptedProc(o.handler ?? (() => ok()));
  const cli = new DockerCli({ proc, platform: 'linux', env: {}, override: ['docker'] });
  const noted: string[] = [];
  const environment = {
    status: async () => ({ state: o.status ?? 'running' }),
    noteGpuFailure: (image: string) => noted.push(image),
  } as unknown as DockerEnvironment;
  const pulls: string[] = [];
  const expectedSizes: (number | undefined)[] = [];
  const images = {
    inspect: async (ref: string) => {
      if (o.inspectError) throw o.inspectError;
      return o.images?.[ref];
    },
    downloadSize: async () => o.size,
    pull: async (ref: string, on: (p: PullProgress) => void, _signal?: AbortSignal, expected?: number) => {
      pulls.push(ref);
      expectedSizes.push(expected);
      on({ status: 'resolving', bytesDone: 0, bytesTotal: 0, layersDone: 0, layersTotal: 0 });
      on({ status: 'downloading', bytesDone: 5, bytesTotal: 10, layersDone: 0, layersTotal: 1 });
      on({ status: 'extracting', bytesDone: 10, bytesTotal: 10, layersDone: 0, layersTotal: 1 });
      on({ status: 'done', bytesDone: 10, bytesTotal: 10, layersDone: 1, layersTotal: 1 });
      return {};
    },
  } as unknown as ImageService;
  const deps = {
    clock: steppingClock(),
    proc,
    fetch: routeFetch({}),
    platform: o.platform ?? 'linux',
    log: o.log ?? silentLog,
    paths: { dataDir: '', cacheDir: '', enginesDir: '', resultsDir: '', modelsDir: '', resourcesDir: RESOURCES, home: '' },
  } as const;
  const common = {
    deps,
    cli,
    environment,
    images,
    createClient: (flavor: string, baseUrl: string, opts?: unknown) => ({ flavor, baseUrl, opts }) as never,
    ...(o.compat ? { loadCompat: async () => o.compat as EngineCompat } : {}),
  };
  return { proc, cli, noted, pulls, expectedSizes, common };
}

const LLAMA_IMAGE = 'ghcr.io/ggml-org/llama.cpp:server-cuda';
const present = (ref: string, id = 'sha256:img'): Record<string, ImageInfo> => ({ [ref]: { id, repoTags: [ref], repoDigests: [`${ref.split(':')[0]}@sha256:${'e'.repeat(64)}`], size: 1 } });

function ggufModel(): { model: ModelTarget; file: string; dir: string } {
  const t = tempDir('gb-dad-');
  cleanups.push(t.cleanup);
  const file = path.join(t.dir, 'model-00001-of-00002.gguf');
  writeFileSync(file, Buffer.alloc(300));
  const mmproj = path.join(t.dir, 'mmproj.gguf');
  writeFileSync(mmproj, Buffer.alloc(50));
  const identity = { displayName: 'm', format: 'gguf' as const, source: 'local' as const, files: [], weakKey: 'm', sizeBytes: 999 };
  return {
    file,
    dir: t.dir,
    model: { identity, local: { id: 'x', identity, paths: [file, mmproj], auxiliary: [{ kind: 'mmproj', path: mmproj }], dir: t.dir, origin: 'library', modifiedAt: '' } },
  };
}

describe('llamaServerArgs', () => {
  it('maps every parameter like the native adapter', () => {
    const caps = { ...defaultLlamaCaps(), fitFlag: true, nglKeywords: ['auto', 'all'], flags: new Set(['--no-webui']) };
    const p = launchParamsSchema.parse({
      contextSize: 8192,
      flashAttention: 'on',
      kvCacheType: 'q8_0',
      batchSize: 2048,
      ubatchSize: 512,
      threads: 8,
      parallel: 4,
      extraArgs: ['--mlock'],
    });
    expect(llamaServerArgs(p, caps, { modelPath: '/models/m.gguf', marker: 'mk' })).toEqual([
      '-m', '/models/m.gguf', '--host', '0.0.0.0', '--port', '8080', '--alias', 'mk',
      '-c', '8192', '-ngl', 'all', '-fa', 'on', '-ctk', 'q8_0', '-ctv', 'q8_0', '-b', '2048', '-ub', '512', '-t', '8', '-np', '4',
      '--fit', 'off', '--no-webui', '--mlock',
    ]);
    // Builds with a unified KV pool share it between the slots (as in the native adapter).
    const unified = { ...caps, flags: new Set(['--kv-unified']) };
    const args = llamaServerArgs(p, unified, { modelPath: '/models/m.gguf', marker: 'mk' });
    expect(args.slice(args.indexOf('-np'))).toEqual(['-np', '4', '--kv-unified', '--fit', 'off', '--mlock']);
    expect(llamaServerArgs({ ...p, parallel: 1 }, unified, { modelPath: 'm', marker: 'k' })).not.toContain('--kv-unified');
  });

  it('handles old toggle-style flash attention, explicit layers and auto KV', () => {
    const toggle = { ...defaultLlamaCaps(), flashAttn: 'toggle' as const };
    expect(llamaServerArgs(launchParamsSchema.parse({ flashAttention: 'on', gpuLayers: 20, kvCacheType: 'auto' }), toggle, { modelPath: 'm', marker: 'k' })).toEqual([
      '-m', 'm', '--host', '0.0.0.0', '--port', '8080', '--alias', 'k', '-c', '4096', '-ngl', '20', '-fa',
    ]);
    expect(llamaServerArgs(launchParamsSchema.parse({}), toggle, { modelPath: 'm', marker: 'k' })).not.toContain('-fa');
    expect(llamaServerArgs(launchParamsSchema.parse({}), { ...defaultLlamaCaps(), flashAttn: 'none' }, { modelPath: 'm', marker: 'k' })).toContain('999');
  });

  it('shares one KV pool across slots when the build supports it', () => {
    const caps = { ...defaultLlamaCaps(), flags: new Set(['--kv-unified']) };
    const multi = llamaServerArgs(launchParamsSchema.parse({ parallel: 4 }), caps, { modelPath: 'm', marker: 'k' });
    expect(multi.slice(multi.indexOf('-np'))).toEqual(['-np', '4', '--kv-unified']);
    expect(llamaServerArgs(launchParamsSchema.parse({ parallel: 1 }), caps, { modelPath: 'm', marker: 'k' })).not.toContain('--kv-unified');
  });
});

describe('LlamaDockerAdapter', () => {
  const version = readFileSync(path.join(LLAMA_FIXTURES, 'version.stderr.txt'), 'utf8');
  const help = readFileSync(path.join(LLAMA_FIXTURES, 'help.stdout.txt'), 'utf8');
  const probing = (args: string[]) => {
    if (args.includes('--version')) return ok('', version);
    if (args.includes('--help')) return ok(help);
    return ok();
  };

  it('probes the image once per image id and falls back to defaults', async () => {
    const h = make({ handler: probing, images: present(LLAMA_IMAGE) });
    const a = new LlamaDockerAdapter(h.common);
    const caps = await a.capabilities({ kind: 'llamacpp-docker' });
    expect(caps).toMatchObject(capsFromOutputs(version, help));
    await a.capabilities({ kind: 'llamacpp-docker' });
    expect(h.proc.calls.map((c) => c.args)).toEqual([
      ['run', '--rm', '--pull', 'never', LLAMA_IMAGE, '--version'],
      ['run', '--rm', '--pull', 'never', LLAMA_IMAGE, '--help'],
    ]);
    // Missing image: defaults, nothing run.
    const missing = make({ handler: probing });
    expect(await new LlamaDockerAdapter(missing.common).capabilities({ kind: 'llamacpp-docker' })).toEqual(defaultLlamaCaps());
    expect(missing.proc.calls).toHaveLength(0);
    // Inspect failure: defaults too.
    const broken = make({ inspectError: new AppError('DOCKER_NOT_RUNNING', 'down') });
    expect(await new LlamaDockerAdapter(broken.common).capabilities({ kind: 'llamacpp-docker' })).toEqual(defaultLlamaCaps());
  });

  it('logs a failed probe and uses defaults (keyed by ref when the id is empty)', async () => {
    const log = recordingLog();
    const h = make({ handler: (args) => (args.includes('--help') ? fail(127, 'exec failed') : ok()), images: present(LLAMA_IMAGE, ''), log });
    const a = new LlamaDockerAdapter(h.common);
    expect(await a.capabilities({ kind: 'llamacpp-docker' })).toEqual(defaultLlamaCaps());
    expect(log.entries[0]?.msg).toContain('probe failed');
    const empty = make({ handler: (args) => (args.includes('--help') ? ok('no options here') : ok()), images: present(LLAMA_IMAGE) });
    expect(await new LlamaDockerAdapter(empty.common).capabilities({ kind: 'llamacpp-docker' })).toEqual(defaultLlamaCaps());
  });

  it('plans a named-volume model, a cuda13 image and Windows bind mounts', async () => {
    const { model, file, dir } = ggufModel();
    const h = make({ handler: probing, platform: 'win32' });
    const a = new LlamaDockerAdapter(h.common);
    const vol = await a.plan({ kind: 'llamacpp-docker', image: 'ghcr.io/ggml-org/llama.cpp:server-cuda13', modelVolume: 'gpubench-models' }, model, launchParamsSchema.parse({}), {
      port: 5000,
      marker: 'gpubench-v1',
    });
    expect(vol.argv).toContain('gpubench-models:/models:ro');
    expect(vol.argv).toContain('/models/model-00001-of-00002.gguf');
    expect(vol.modelFiles).toEqual([]);
    expect(vol.modelBytes).toBe(300);
    expect(vol.slowSharedFilesystem).toBe(false);
    expect(vol.engine).toEqual({ kind: 'llamacpp-docker', name: 'llama.cpp', image: 'ghcr.io/ggml-org/llama.cpp:server-cuda13', variant: 'cuda13' });
    expect(vol.containerName).toBe('gpubench-v1');
    const bind = await a.plan({ kind: 'llamacpp-docker' }, model, launchParamsSchema.parse({}), { port: 5000, marker: 'gpubench-v2' });
    expect(bind.argv).toContain(`${dir}:/models:ro`);
    expect(bind.slowSharedFilesystem).toBe(true);
    expect(bind.modelFiles).toEqual([file]);
    expect(bind.env).toEqual({});
  });

  it('previews a GGUF still to download, mounted from where the download will put it', async () => {
    const h = make({ platform: 'win32' });
    const a = new LlamaDockerAdapter(h.common);
    const future = 'C:\\models\\Qwen\\Qwen3-4B-GGUF\\Qwen3-4B-Q4_K_M.gguf';
    const target: ModelTarget = {
      identity: { displayName: 'Qwen3-4B-Q4_K_M', format: 'gguf', source: 'hf', files: [], weakKey: 'w', sizeBytes: 2500 },
      pending: { repo: 'Qwen/Qwen3-4B-GGUF', file: 'Qwen3-4B-Q4_K_M.gguf', paths: [future], bytes: 2500 },
    };
    const plan = await a.plan({ kind: 'llamacpp-docker' }, target, launchParamsSchema.parse({}), { port: 1, marker: 'gpubench-p', preview: true });
    expect(plan.argv).toContain('C:\\models\\Qwen\\Qwen3-4B-GGUF:/models:ro');
    expect(plan.argv).toContain('/models/Qwen3-4B-Q4_K_M.gguf');
    expect(plan.pending).toEqual(['model']);
    expect(plan.modelBytes).toBe(2500);
    // Starting needs the file: without the preview flag the model is missing.
    await expect(a.plan({ kind: 'llamacpp-docker' }, target, launchParamsSchema.parse({}), { port: 1, marker: 'gpubench-p' })).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' });
    const { model } = ggufModel();
    expect((await a.plan({ kind: 'llamacpp-docker' }, model, launchParamsSchema.parse({}), { port: 1, marker: 'gpubench-p', preview: true })).pending).toBeUndefined();
  });

  it('fails without a local GGUF and validates custom images', async () => {
    const h = make();
    const a = new LlamaDockerAdapter(h.common);
    const identity = { displayName: 'none', format: 'gguf' as const, source: 'hf' as const, files: [], weakKey: 'n' };
    await expect(a.plan({ kind: 'llamacpp-docker' }, { identity }, launchParamsSchema.parse({}), { port: 1, marker: 'gpubench-x' })).rejects.toMatchObject({
      code: 'MODEL_NOT_FOUND',
    });
    await expect(a.plan({ kind: 'llamacpp-docker', image: '--privileged' }, { identity }, launchParamsSchema.parse({}), { port: 1, marker: 'gpubench-x' })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('uses the shipped compat table, or the built-in one when the resources are missing', async () => {
    const h = make();
    expect(await new LlamaDockerAdapter(h.common).imageFor()).toBe(LLAMA_IMAGE);
    const t = tempDir('gb-nores-');
    cleanups.push(t.cleanup);
    const a = new LlamaDockerAdapter({ ...h.common, deps: { ...h.common.deps, paths: { ...h.common.deps.paths, resourcesDir: t.dir } } });
    expect(await a.compat()).toBe(BUILTIN_COMPAT);
  });
});

describe('DockerEngineAdapter (shared detect/install)', () => {
  it('reports each Docker state as a problem code', async () => {
    for (const [state, code] of [
      ['not-installed', 'DOCKER_NOT_INSTALLED'],
      ['stopped', 'DOCKER_NOT_RUNNING'],
      ['no-permission', 'DOCKER_PERMISSION'],
      ['unsupported', 'DOCKER_UNSUPPORTED'],
    ] as const) {
      const s = await new LlamaDockerAdapter(make({ status: state }).common).detect();
      expect(s).toMatchObject({ kind: 'llamacpp-docker', available: false, installed: false, problems: [code], location: LLAMA_IMAGE, version: 'server-cuda' });
    }
  });

  it('still inspects images when only the GPU is missing', async () => {
    const s = await new LlamaDockerAdapter(make({ status: 'no-gpu', images: present(LLAMA_IMAGE) }).common).detect();
    expect(s).toMatchObject({ installed: true, available: false, problems: ['DOCKER_NO_GPU'], variant: 'cuda' });
    const m = await new LlamaDockerAdapter(make({ status: 'no-gpu' }).common).detect();
    expect(m.problems).toEqual(['ENGINE_NOT_INSTALLED', 'DOCKER_NO_GPU']);
  });

  it('reports inspect failures and invalid images', async () => {
    const s = await new LlamaDockerAdapter(make({ inspectError: new AppError('DOCKER_PERMISSION', 'x') }).common).detect();
    expect(s.problems).toEqual(['DOCKER_PERMISSION']);
    const bad = await new LlamaDockerAdapter(make().common).detect({ kind: 'llamacpp-docker', image: 'Bad Image' });
    expect(bad).toEqual({ kind: 'llamacpp-docker', available: false, installed: false, problems: ['VALIDATION'], supported: true });
    const digestOnly = await new LlamaDockerAdapter(make().common).detect({ kind: 'llamacpp-docker', image: `a/b@sha256:${'f'.repeat(64)}` });
    expect(digestOnly.version).toBeUndefined();
  });

  it('plans and performs the image pull with mapped stages', async () => {
    const h = make({ size: 3_000_000_000 });
    const a = new LlamaDockerAdapter(h.common);
    const plan = await a.installPlan({ kind: 'llamacpp-docker' });
    expect(plan).toEqual({ kind: 'llamacpp-docker', label: `llama.cpp (${LLAMA_IMAGE})`, bytes: 3_000_000_000, items: [{ label: LLAMA_IMAGE, bytes: 3_000_000_000 }], data: { image: LLAMA_IMAGE } });
    const seen: { stage: string; bytesDone: number; bytesTotal?: number }[] = [];
    await a.install(plan, (p) => seen.push(p), new AbortController().signal);
    expect(seen).toEqual([
      { stage: 'download', bytesDone: 0 },
      { stage: 'download', bytesDone: 5, bytesTotal: 10 },
      { stage: 'extract', bytesDone: 10, bytesTotal: 10 },
      { stage: 'done', bytesDone: 10, bytesTotal: 10 },
    ]);
    expect(h.pulls).toEqual([LLAMA_IMAGE]);
    // The planned size is the bar's total from the start; an unknown size (0) is not passed.
    expect(h.expectedSizes).toEqual([3_000_000_000]);
    await a.install({ ...plan, bytes: 0 }, () => {}, new AbortController().signal);
    expect(h.expectedSizes).toEqual([3_000_000_000, undefined]);
    await expect(a.install({ ...plan, data: {} }, () => {}, new AbortController().signal)).rejects.toThrow();
  });
});

describe('VllmDockerAdapter', () => {
  const tagsFixture = JSON.parse(readFileSync(path.join(RESOURCES, '..', 'test', 'fixtures', 'docker', 'hub-tags-vllm.json'), 'utf8')) as unknown;
  const hub = new DockerHubClient({ fetch: routeFetch({ 'https://hub.test': () => json(tagsFixture) }), baseUrl: 'https://hub.test', clock: steppingClock() });
  const repoModel: ModelTarget = { identity: { displayName: 'q', format: 'safetensors', source: 'hf', repo: 'Qwen/Qwen3-0.6B', files: [], weakKey: 'q' } };

  it('defaults to the recommended tag and reports capabilities', async () => {
    const h = make();
    const a = new VllmDockerAdapter({ ...h.common, hub });
    expect(await a.imageFor()).toBe('vllm/vllm-openai:v0.31.0');
    // Image not pulled yet: no options known.
    expect(await a.capabilities({ kind: 'vllm-docker' })).toEqual({ version: 'v0.31.0', flags: new Set(), choices: {}, tokenIdsInPrompt: true, timings: false, minTokens: true, fitFlag: false });
    expect(await a.capabilities({ kind: 'vllm-docker', image: 'ghcr.io/me/vllm:dev' })).not.toHaveProperty('version');
  });

  it('reads the image’s own options from --help=all (once per image id), --help on older images', async () => {
    const VLLM = path.resolve(RESOURCES, '..', 'test', 'fixtures', 'vllm');
    const all = readFileSync(path.join(VLLM, 'help-all.stdout.txt'), 'utf8');
    const old = readFileSync(path.join(VLLM, 'help-old.stdout.txt'), 'utf8');
    const image = (id: string): ImageInfo => ({ id, repoTags: [], repoDigests: [], size: 1 });
    const h = make({
      images: { 'vllm/vllm-openai:v0.31.0': image('sha256:new'), 'vllm/vllm-openai:v0.6.0': image('sha256:old') },
      handler: (args) => {
        const img = args[args.indexOf('never') + 1];
        if (img === 'vllm/vllm-openai:v0.31.0') return ok(all);
        return args.includes('--help=all') ? fail(2, "error: argument -h/--help: ignored explicit argument 'all'") : ok(old);
      },
    });
    const a = new VllmDockerAdapter({ ...h.common, hub });
    const caps = await a.capabilities({ kind: 'vllm-docker' });
    expect([...caps.flags].filter((f) => ['--block-size', '--cuda-graph-sizes', '--compilation-config', '-O', '--no-enable-prefix-caching'].includes(f))).toHaveLength(5);
    expect(caps.choices?.['--kv-cache-dtype']).toEqual(['auto', 'bfloat16', 'fp8', 'fp8_ds_mla', 'fp8_e4m3', 'fp8_e5m2', 'fp8_inc']);
    await a.capabilities({ kind: 'vllm-docker' });
    expect(h.proc.calls.filter((c) => c.args.includes('--help=all'))).toHaveLength(1);
    expect(h.proc.calls[0]!.args).toEqual(['run', '--rm', '--pull', 'never', 'vllm/vllm-openai:v0.31.0', '--help=all']);
    const older = await a.capabilities({ kind: 'vllm-docker', image: 'vllm/vllm-openai:v0.6.0' });
    expect(older.flags.has('--block-size')).toBe(false);
    expect(older.choices?.['--kv-cache-dtype']).toEqual(['auto', 'fp8']);
  });

  it('uses --model for pre-v0.12 images, pins revisions, and keeps the token out when there is none', async () => {
    const h = make();
    const a = new VllmDockerAdapter({ ...h.common, hub, hfToken: () => undefined });
    const plan = await a.plan(
      { kind: 'vllm-docker', image: 'vllm/vllm-openai:v0.11.0' },
      { ...repoModel, identity: { ...repoModel.identity, revision: 'r1' } },
      launchParamsSchema.parse({}),
      { port: 1, marker: 'gpubench-a' },
    );
    const after = plan.argv.slice(plan.argv.indexOf('vllm/vllm-openai:v0.11.0') + 1);
    expect(after.slice(0, 2)).toEqual(['--model', 'Qwen/Qwen3-0.6B']);
    expect(after).toEqual(expect.arrayContaining(['--revision', 'r1']));
    expect(plan.env).toEqual({});
    expect(plan.argv).not.toContain('HF_TOKEN');
    expect(plan.engine).toEqual({ kind: 'vllm-docker', name: 'vLLM', image: 'vllm/vllm-openai:v0.11.0', version: 'v0.11.0' });
    const latest = await a.plan({ kind: 'vllm-docker', image: 'vllm/vllm-openai:latest' }, repoModel, launchParamsSchema.parse({}), { port: 1, marker: 'gpubench-b' });
    expect(latest.engine.version).toBeUndefined();
    const custom = await a.plan({ kind: 'vllm-docker', image: 'ghcr.io/me/vllm:dev' }, repoModel, launchParamsSchema.parse({}), { port: 1, marker: 'gpubench-c' });
    expect(custom.argv[custom.argv.indexOf('ghcr.io/me/vllm:dev') + 1]).toBe('Qwen/Qwen3-0.6B');
  });

  it('refuses to start without the image and labels volumes best-effort', async () => {
    const h = make();
    const a = new VllmDockerAdapter({ ...h.common, hub });
    const plan = await a.plan({ kind: 'vllm-docker' }, repoModel, launchParamsSchema.parse({}), { port: 1, marker: 'gpubench-d' });
    await expect(a.start(plan, new AbortController().signal)).rejects.toMatchObject({ code: 'ENGINE_NOT_INSTALLED', params: { image: 'vllm/vllm-openai:v0.31.0', reason: 'image-missing' } });

    // Present image; API failing; docker run failing for lack of GPU (noted in the environment).
    const log = recordingLog();
    const g = make({
      images: present('vllm/vllm-openai:v0.31.0'),
      handler: (args) => (args[0] === 'run' ? fail(125, 'could not select device driver "" with capabilities: [[gpu]]') : fail(1, 'No such container')),
      log,
    });
    const api = { get: () => Promise.reject(new AppError('DOCKER_NOT_RUNNING', 'x')) } as unknown as DockerApiProvider;
    const b = new VllmDockerAdapter({ ...g.common, hub, api, hfToken: () => 'tok', gpuSm: () => Promise.reject(new Error('no telemetry')) });
    const p2 = await b.plan({ kind: 'vllm-docker' }, repoModel, launchParamsSchema.parse({}), { port: 1, marker: 'gpubench-e' });
    await expect(b.start(p2, new AbortController().signal)).rejects.toMatchObject({ code: 'DOCKER_NO_GPU' });
    expect(g.noted).toEqual(['vllm/vllm-openai:v0.31.0']);
    expect(g.proc.calls[0]?.opts?.env).toMatchObject({ HF_TOKEN: 'tok' });
    expect(log.entries.some((e) => e.msg.includes('volume labelling skipped'))).toBe(true);

    // HF_TOKEN not in the plan: the token is not added even if available.
    const c = make({ images: present('vllm/vllm-openai:v0.31.0'), handler: (args) => (args[0] === 'run' ? fail(125, 'boom') : fail(1, 'No such container')) });
    const okApi = { get: async () => ({ ensureVolume: async () => ({ name: 'v', labels: {} }) }) as unknown as DockerApi } as unknown as DockerApiProvider;
    const cAd = new VllmDockerAdapter({ ...c.common, hub, api: okApi, hfToken: () => 'tok' });
    const p3 = { ...(await cAd.plan({ kind: 'vllm-docker' }, repoModel, launchParamsSchema.parse({}), { port: 1, marker: 'gpubench-f' })), env: {} };
    await expect(cAd.start(p3, new AbortController().signal)).rejects.toMatchObject({ code: 'ENGINE_START_FAILED' });
    expect(c.proc.calls[0]?.opts?.env).toEqual({});
  });

  it('lists release tags without GPU advice when the GPU is unknown', async () => {
    const h = make();
    const tags = await new VllmDockerAdapter({ ...h.common, hub }).tags({ refresh: true });
    expect(tags.every((t) => t.supportsGpu === undefined)).toBe(true);
    expect(tags.find((t) => t.name === 'v0.9.0')).not.toHaveProperty('cuda');
  });

  it('plans a local folder on Linux without the slow-share flag', async () => {
    const t = tempDir('gb-vloc-');
    cleanups.push(t.cleanup);
    const identity = { displayName: 'q', format: 'safetensors' as const, source: 'local' as const, files: [], weakKey: 'q', sizeBytes: 5 };
    const model: ModelTarget = { identity, local: { id: 'l', identity, paths: [], auxiliary: [], dir: t.dir, origin: 'library', modifiedAt: '' } };
    const plan = await new VllmDockerAdapter({ ...make().common, hub }).plan({ kind: 'vllm-docker' }, model, launchParamsSchema.parse({}), { port: 1, marker: 'gpubench-g' });
    expect(plan.slowSharedFilesystem).toBe(false);
    expect(plan.modelBytes).toBe(5);
    expect(plan.modelFiles).toEqual([]);
  });
});

describe('Docker adapters: remaining paths', () => {
  const tagsFixture = JSON.parse(readFileSync(path.join(RESOURCES, '..', 'test', 'fixtures', 'docker', 'hub-tags-vllm.json'), 'utf8')) as unknown;
  const hub = new DockerHubClient({ fetch: routeFetch({ 'https://hub.test': () => json(tagsFixture) }), baseUrl: 'https://hub.test', clock: steppingClock() });
  const ID = 'b'.repeat(64);
  /** Scripted docker where `run` succeeds and the container exits at once with `line` in its log. */
  const exiting = (line: string) => {
    const logs = manualProcess(0, 7);
    const proc = scriptedProc(
      (args) => {
        if (args[0] === 'run') return ok(ID);
        if (args[0] === 'container') {
          return ok(JSON.stringify([{ Id: ID, State: { Running: false, ExitCode: 1 }, Config: { Labels: {} } }]));
        }
        return ok();
      },
      () => {
        logs.push(`2026-10-06T10:00:00Z ${line}`);
        logs.exit();
        return logs;
      },
    );
    return { proc, cli: new DockerCli({ proc, platform: 'linux', env: {}, override: ['docker'] }) };
  };

  it('detects cuda13 images and plans on Linux with unreadable files', async () => {
    const IMG13 = 'ghcr.io/ggml-org/llama.cpp:server-cuda13';
    const d = await new LlamaDockerAdapter(make({ images: present(IMG13) }).common).detect({ kind: 'llamacpp-docker', image: IMG13 });
    expect(d).toMatchObject({ variant: 'cuda13', available: true });
    const { model } = ggufModel();
    const broken = make({ inspectError: new AppError('DOCKER_NOT_RUNNING', 'down') });
    const gone = { ...model, local: { ...model.local!, paths: ['/srv/models/missing.gguf'] } };
    const plan = await new LlamaDockerAdapter(broken.common).plan({ kind: 'llamacpp-docker' }, gone, launchParamsSchema.parse({}), { port: 1, marker: 'gpubench-l' });
    expect(plan.argv).toContain('/srv/models:/models:ro');
    expect(plan.argv).toContain('/models/missing.gguf');
    expect(plan.engine.imageDigest).toBeUndefined();
    expect(plan.modelBytes).toBe(999);
    expect(plan.slowSharedFilesystem).toBe(false);
    const noSize = { ...gone, identity: { ...gone.identity, sizeBytes: undefined } };
    expect((await new LlamaDockerAdapter(broken.common).plan({ kind: 'llamacpp-docker' }, noSize, launchParamsSchema.parse({}), { port: 1, marker: 'gpubench-l' })).modelBytes).toBe(0);
  });

  it('llama.cpp: starts with default options and diagnoses the container log', async () => {
    const { model } = ggufModel();
    const x = exiting('error: invalid argument: --bogus');
    const h = make({ images: present(LLAMA_IMAGE) });
    const a = new LlamaDockerAdapter({ ...h.common, cli: x.cli, deps: { ...h.common.deps, proc: x.proc }, readyTimeoutMs: 1e15 });
    const plan = await a.plan({ kind: 'llamacpp-docker' }, model, launchParamsSchema.parse({}), { port: 1, marker: 'gpubench-s' });
    const inst = await a.start(plan, new AbortController().signal);
    await expect(inst.waitReady()).rejects.toMatchObject({ code: 'ENGINE_BAD_FLAG', params: { flag: '--bogus' } });
  });

  it('vLLM: local model without repo, no API, GPU lookup failing for tags', async () => {
    const t = tempDir('gb-vx-');
    cleanups.push(t.cleanup);
    const identity = { displayName: 'q', format: 'safetensors' as const, source: 'local' as const, files: [], weakKey: 'q' };
    const model: ModelTarget = { identity, local: { id: 'l', identity, paths: [], auxiliary: [], dir: t.dir, origin: 'library', modifiedAt: '' } };
    const x = exiting('RuntimeError: No CUDA GPUs are available');
    const h = make({ images: present('vllm/vllm-openai:v0.31.0') });
    const a = new VllmDockerAdapter({ ...h.common, cli: x.cli, deps: { ...h.common.deps, proc: x.proc }, hub, gpuSm: () => Promise.reject(new Error('x')), readyTimeoutMs: 1e15 });
    const plan = await a.plan({ kind: 'vllm-docker' }, model, launchParamsSchema.parse({}), { port: 1, marker: 'gpubench-v' });
    const inst = await a.start(plan, new AbortController().signal);
    expect((inst.client as unknown as { opts: unknown }).opts).toEqual({ model: 'gpubench-v' });
    const err = (await inst.waitReady().catch((e: unknown) => e)) as AppError;
    expect(err.code).toBe('DOCKER_NO_GPU');
    expect(err.params).not.toHaveProperty('repo');
    expect((await a.tags()).every((tg) => tg.supportsGpu === undefined)).toBe(true);
  });
});

describe('LlamaDockerAdapter.start defaults', () => {
  it('reports a failed docker run', async () => {
    const { model } = ggufModel();
    const h = make({ images: present(LLAMA_IMAGE), handler: (args) => (args[0] === 'run' ? fail(125, 'docker: Error response from daemon: boom') : fail(1, 'No such container')) });
    const a = new LlamaDockerAdapter(h.common);
    const plan = await a.plan({ kind: 'llamacpp-docker' }, model, launchParamsSchema.parse({}), { port: 1, marker: 'gpubench-z' });
    await expect(a.start(plan, new AbortController().signal)).rejects.toMatchObject({ code: 'ENGINE_START_FAILED' });
  });
});
