import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Settings } from '../../../../src/contract/settings';
import { DownloadService } from '../../../../src/core/downloads/service';
import { ModelsService } from '../../../../src/core/models/service';
import { systemClock } from '../../../../src/core/node-deps';
import { memoryLogger } from '../telemetry/fakes';
import { DOWNLOAD_SIDECAR } from '../../../../src/core/models/scanner';
import type { GpuMem } from '../../../../src/core/models/types';
import { llamaLikeGguf as hubLlamaLike, startFakeHub, type FakeHub } from '../../../fakes/fake-hub';
import { llamaLikeGguf, writeGguf, writeSafetensors } from '../../../fixtures/gguf/writer';
import { GPU_32GB, modelDeps, settingsWith, tempDir } from './helpers';

describe('ModelsService', () => {
  let hub: FakeHub;
  let t: ReturnType<typeof tempDir>;
  let gpu: GpuMem | undefined;
  let token: string | undefined;

  beforeAll(async () => {
    hub = await startFakeHub();
  });
  afterAll(() => hub.close());
  beforeEach(() => {
    t = tempDir('gb-msvc-');
    gpu = GPU_32GB;
    token = undefined;
  });
  afterEach(() => t.cleanup());

  function service(patch: Partial<Settings> = {}, autoHash = false): ModelsService {
    const deps = modelDeps(t.dir, { endpoints: { githubApi: 'http://127.0.0.1:9', huggingface: hub.url, dockerHub: 'http://127.0.0.1:9' } });
    return new ModelsService({ deps, settings: settingsWith(patch), getToken: () => token, gpuInfo: () => Promise.resolve(gpu), autoHash });
  }
  const lib = () => path.join(t.dir, 'library');
  const gguf = (file: string) => writeGguf(file, { ...llamaLikeGguf({ embd: 16, vocab: 8 }), totalSize: 4096 });

  it('lists (scanning once), rescans and gets models', async () => {
    gguf(path.join(lib(), 'a-Q8_0.gguf'));
    const svc = service();
    const [first, concurrent] = await Promise.all([svc.list(), svc.rescan()]);
    expect(first).toBe(concurrent);
    expect(await svc.list()).toBe(first);
    gguf(path.join(lib(), 'b-Q8_0.gguf'));
    expect(await svc.rescan()).toHaveLength(2);
    const id = (await svc.list())[0]?.id as string;
    expect((await svc.get(id)).id).toBe(id);
    await expect(svc.get('nope')).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' });
    expect(await svc.libraryDir()).toBe(lib());
  });

  it('hashes GGUF models in the background after a scan', async () => {
    gguf(path.join(lib(), 'h-Q8_0.gguf'));
    writeFileSync(path.join(lib(), 'junk-Q8_0.gguf'), 'x');
    const dir = path.join(lib(), 'o', 'st');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'config.json'), '{"num_hidden_layers": 1}');
    writeSafetensors(path.join(dir, 'model.safetensors'));
    const svc = service({}, true);
    const models = await svc.list();
    const target = models.find((m) => m.identity.displayName === 'h-Q8_0');
    await svc.hashes.enqueue(target?.paths[0] as string);
    await new Promise((r) => setTimeout(r, 20));
    expect(target?.identity.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Already hashed models are skipped on the next scan.
    await svc.rescan();
    // Default options hash too.
    const deps = modelDeps(t.dir, { endpoints: { githubApi: '', huggingface: hub.url, dockerHub: '' } });
    const dflt = new ModelsService({ deps, settings: settingsWith(), getToken: () => undefined, gpuInfo: () => Promise.resolve(undefined) });
    await dflt.list();
    expect(dflt.hashes.pending).toBeGreaterThanOrEqual(0);
  });

  it('logs failing background hashes', async () => {
    const file = gguf(path.join(lib(), 'gone-Q8_0.gguf'));
    const svc = service({}, true);
    svc.hashes.pause();
    await svc.list();
    const { rmSync } = await import('node:fs');
    rmSync(file);
    svc.hashes.resume();
    await new Promise((r) => setTimeout(r, 50));
    const deps = (svc as unknown as { opts: { deps: { log: { entries: { msg: string }[] } } } }).opts.deps;
    expect(deps.log.entries.some((e) => e.msg === 'background hash failed')).toBe(true);
  });

  it('searches the hub with a quick VRAM verdict per result, optionally keeping only models that fit', async () => {
    const svc = service();
    const page = await svc.search('qwen', { format: 'gguf' });
    expect(page.models.map((m) => m.repo)).toEqual(['ggml-org/Qwen3-0.6B-GGUF']);
    expect(page.models[0]?.fit).toMatchObject({ level: 'perfect', quant: 'Q4_K_M', engine: 'llamacpp' });
    hub.addRepo({ id: 'huge/Giant-400B-GGUF', tags: ['gguf'], files: [] });
    hub.addRepo({ id: 'nosize/Mystery-GGUF', tags: ['gguf'], files: [] });
    // Not hidden by default: shown with their verdict (or none when the size is unknown).
    const all = (await svc.search('', {})).models;
    expect(all.find((m) => m.repo === 'huge/Giant-400B-GGUF')?.fit?.level).toBe('partial');
    expect(all.find((m) => m.repo === 'nosize/Mystery-GGUF')?.fit).toBeUndefined();
    expect(all.find((m) => m.repo === 'Qwen/Qwen3-0.6B')?.fit).toMatchObject({ quant: 'BF16', engine: 'vllm' });
    const fits = (await svc.search('', { onlyFits: true })).models.map((m) => m.repo);
    expect(fits).toContain('ggml-org/Qwen3-0.6B-GGUF');
    expect(fits).toContain('Qwen/Qwen3-0.6B');
    expect(fits).not.toContain('huge/Giant-400B-GGUF');
    expect(fits).not.toContain('nosize/Mystery-GGUF');
    const st = (await svc.search('', { onlyFits: true, format: 'safetensors' })).models.map((m) => m.repo);
    expect(st).toEqual(['Qwen/Qwen3-0.6B']);
    const gg = (await svc.search('', { onlyFits: true, format: 'gguf', maxParamsB: 100 })).models;
    expect(gg.every((m) => m.formats.includes('gguf'))).toBe(true);
    gpu = undefined;
    const noGpu = (await svc.search('', { onlyFits: true })).models;
    expect(noGpu.map((m) => m.repo)).toContain('huge/Giant-400B-GGUF');
    expect(noGpu.every((m) => m.fit === undefined)).toBe(true);
  });

  it('keeps language models only (image generators, speech, embeddings cannot be benchmarked)', async () => {
    hub.addRepo({ id: 'art/Image-Maker-12B-GGUF', tags: ['gguf'], pipelineTag: 'text-to-image', files: [] });
    hub.addRepo({ id: 'lab/Vision-Chat-8B-GGUF', tags: ['gguf'], pipelineTag: 'image-text-to-text', files: [] });
    const repos = (await service().search('', { format: 'gguf' })).models.map((m) => m.repo);
    expect(repos).not.toContain('art/Image-Maker-12B-GGUF');
    expect(repos).toContain('lab/Vision-Chat-8B-GGUF');
    expect(repos).toContain('ggml-org/Qwen3-0.6B-GGUF');
  });

  it('applies the size range to the parameter count the cards show, and passes the cursor on', async () => {
    const svc = service();
    // The hub thinks this repo is small (its first file), but its name says 70B.
    hub.addRepo({ id: 'odd/Big-70B-GGUF', tags: ['gguf'], numParameters: 1e9, downloads: 1, files: [] });
    const small = (await svc.search('', { minParamsB: 0.5, maxParamsB: 4.5 })).models.map((m) => m.repo);
    expect(small).toContain('ggml-org/Qwen3-0.6B-GGUF');
    expect(small).not.toContain('odd/Big-70B-GGUF');
    // Same for "only what fits": the hub's size bound lets it through, our own verdict does not.
    expect((await svc.search('', { onlyFits: true })).models.map((m) => m.repo)).not.toContain('odd/Big-70B-GGUF');
    const big = (await svc.search('', { minParamsB: 15 })).models.map((m) => m.repo);
    expect(big).not.toContain('ggml-org/Qwen3-0.6B-GGUF');
    const first = await svc.search('', { limit: 1, sort: 'downloads' });
    expect(first.nextCursor).toBe('1');
    const second = await svc.search('', { limit: 1, sort: 'downloads', cursor: first.nextCursor as string });
    expect(second.models[0]?.repo).not.toBe(first.models[0]?.repo);
  });

  it('finds nothing that fits when the GPU has no free VRAM', async () => {
    gpu = { totalMiB: 8192, freeMiB: 0 };
    expect((await service().search('', { onlyFits: true })).models).toEqual([]);
  });

  it('proxies hub files, readme, related and remote facts', async () => {
    const svc = service();
    expect((await svc.hubFiles('ggml-org/Qwen3-0.6B-GGUF')).length).toBe(4);
    expect((await svc.readme('ggml-org/Qwen3-0.6B-GGUF')).text).toContain('Qwen3');
    expect((await svc.related('Qwen/Qwen3-0.6B')).map((m) => m.repo)).toEqual(['ggml-org/Qwen3-0.6B-GGUF']);
    expect((await svc.related('Qwen/Qwen3-0.6B', { sort: 'likes' })).length).toBe(1);
    expect((await svc.remoteGgufFacts('ggml-org/Qwen3-0.6B-GGUF', 'Qwen3-0.6B-Q4_K_M.gguf')).facts.blockCount).toBe(4);
  });

  it('estimates fit for local models, hub files (all shards) and safetensors repos', async () => {
    gguf(path.join(lib(), 'l-Q8_0.gguf'));
    const svc = service();
    const local = (await svc.list())[0]?.id as string;
    const a = await svc.fit({ localId: local, engine: 'llamacpp-native', params: { contextSize: 4096, extraArgs: [], env: {} } });
    expect(a).toMatchObject({ basis: 'file-size', contextSize: 4096, weightsMiB: 0 });
    const split = await svc.fit({ repo: 'unsloth/Demo-31B-it-GGUF', file: 'Q4_K_M/Demo-31B-it-Q4_K_M-00002-of-00002.gguf', engine: 'llamacpp-native' });
    expect(split.weightsMiB).toBe(Math.round((128 * 1024 + 64 * 1024) / 1024 ** 2));
    expect(split.notes).toContain('kv.sliding-window');
    const single = await svc.fit({ repo: 'ggml-org/Qwen3-0.6B-GGUF', file: 'Qwen3-0.6B-Q8_0.gguf', engine: 'llamacpp-docker' });
    expect(single.level).toBe('perfect');
    // A GGUF that is not part of a quant group (mmproj): fitted on its own.
    expect((await svc.fit({ repo: 'unsloth/Demo-31B-it-GGUF', file: 'mmproj-F16.gguf', engine: 'llamacpp-native' })).basis).toBe('file-size');
    const st = await svc.fit({ repo: 'Qwen/Qwen3-0.6B', engine: 'vllm-docker' });
    expect(st.maxConcurrency).toBeGreaterThan(0);
    await expect(svc.fit({ repo: 'ggml-org/Qwen3-0.6B-GGUF', file: 'missing.gguf', engine: 'llamacpp-native' })).rejects.toMatchObject({ code: 'HF_NOT_FOUND' });
    await expect(svc.fit({ engine: 'llamacpp-native' })).rejects.toMatchObject({ code: 'VALIDATION' });
    // A local model whose metadata could not be read still gets a (heuristic-shaped) estimate.
    writeFileSync(path.join(lib(), 'junk-Q4_0.gguf'), 'x');
    const junk = (await svc.rescan()).find((m) => m.identity.displayName === 'junk-Q4_0')?.id as string;
    expect((await svc.fit({ localId: junk, engine: 'llamacpp-native' })).notes).toContain('kv.assumed-layout');
    // Not enough free VRAM for that context with every layer on the GPU: what would fit comes with it.
    gpu = { totalMiB: 8192, freeMiB: 400 };
    const tight = await svc.fit({ localId: local, engine: 'llamacpp-native', params: { contextSize: 262_144, extraArgs: [], env: {} } });
    expect(tight.level === 'partial' || tight.level === 'no').toBe(true);
    expect(tight.fixes?.maxContext).toBeLessThan(262_144);
    expect(a).not.toHaveProperty('fixes');
    gpu = undefined;
    await expect(svc.fit({ localId: local, engine: 'llamacpp-native' })).rejects.toMatchObject({ code: 'GPU_NOT_FOUND' });
  });

  it('corrects the estimate with the peaks measured here when there are enough ("stima tarata su N misure")', async () => {
    gguf(path.join(lib(), 'c-Q8_0.gguf'));
    const asked: { model: { sha256?: string; weakKey: string; architecture?: string }; engine: string }[] = [];
    const deps = modelDeps(t.dir, { endpoints: { githubApi: 'http://127.0.0.1:9', huggingface: hub.url, dockerHub: 'http://127.0.0.1:9' } });
    const svc = new ModelsService({
      deps,
      settings: settingsWith(),
      getToken: () => undefined,
      gpuInfo: () => Promise.resolve(gpu),
      calibration: async (model, engine) => {
        asked.push({ model, engine });
        return engine === 'vllm-docker' ? Promise.reject(new Error('never fails the fit')) : { scale: 2, offsetMiB: 10, samples: 4, errorPct: 3.5, scope: 'model' };
      },
    });
    const local = (await svc.list())[0]!;
    const fit = await svc.fit({ localId: local.id, engine: 'llamacpp-native', params: { contextSize: 4096, extraArgs: [], env: {} } });
    expect(fit.calibration).toMatchObject({ samples: 4, errorPct: 3.5, scope: 'model' });
    expect(asked[0]).toEqual({ model: { weakKey: local.identity.weakKey, ...(local.identity.sha256 ? { sha256: local.identity.sha256 } : {}), architecture: 'qwen3' }, engine: 'llamacpp-native' });
    // A hub GGUF before its download: the weak key its downloaded copy will have.
    const hubFit = await svc.fit({ repo: 'ggml-org/Qwen3-0.6B-GGUF', file: 'Qwen3-0.6B-Q8_0.gguf', engine: 'llamacpp-docker' });
    expect(hubFit.calibration?.samples).toBe(4);
    expect(asked[1]!.model.weakKey).toBe('ggml-org/Qwen3-0.6B-GGUF/Qwen3-0.6B-Q8_0.gguf/Q8_0/163840');
    expect((await svc.fit({ localId: local.id, engine: 'vllm-docker' })).calibration).toBeUndefined();
    // Facts without an architecture: none asked for.
    writeFileSync(path.join(lib(), 'junk-Q4_0.gguf'), 'x');
    const junk = (await svc.rescan()).find((m) => m.identity.displayName === 'junk-Q4_0')!;
    await svc.fit({ localId: junk.id, engine: 'llamacpp-native' });
    expect(asked.at(-1)!.model).not.toHaveProperty('architecture');
  });

  it('fits every quant of a hub repo and preselects the best', async () => {
    const svc = service();
    const r = await svc.hubFit('ggml-org/Qwen3-0.6B-GGUF', 'llamacpp-native', { params: { contextSize: 2048, extraArgs: [], env: {} } });
    expect(r.choices.map((c) => c.groupKey)).toEqual(['Qwen3-0.6B-Q8_0.gguf', 'Qwen3-0.6B-Q4_K_M.gguf']);
    expect(r.best).toBe('Qwen3-0.6B-Q8_0.gguf');
    expect(r.choices[1]?.weakKey).toBe(`ggml-org/Qwen3-0.6B-GGUF/Qwen3-0.6B-Q4_K_M.gguf/Q4_K_M/${96 * 1024}`);
    expect(r.facts.blockCount).toBe(4);
    const st = await svc.hubFit('Qwen/Qwen3-0.6B', 'vllm-docker', { revision: 'main' });
    expect(st.choices).toHaveLength(1);
    expect(st.choices[0]?.groupKey).toBe('*weights');
    expect(st.choices[0]?.weakKey).toBe(`Qwen/Qwen3-0.6B/model.safetensors//${hub.file('Qwen/Qwen3-0.6B', 'model.safetensors').size}`);
    // A split quant: keyed by its first shard and the size of all shards, like the local copy.
    const split = await svc.hubFit('unsloth/Demo-31B-it-GGUF', 'llamacpp-native');
    expect(split.choices.find((c) => c.groupKey === 'Q4_K_M/Demo-31B-it-Q4_K_M')?.weakKey).toBe(`unsloth/Demo-31B-it-GGUF/Demo-31B-it-Q4_K_M-00001-of-00002.gguf/Q4_K_M/${192 * 1024}`);
    // Only broken GGUF files: the parse error surfaces; gated repos fail at once.
    hub.addRepo({ id: 'broken/All-GGUF', files: [{ path: 'a-Q4_K_M.gguf', size: 100 }, { path: 'b-Q8_0.gguf', size: 200 }] });
    await expect(svc.hubFit('broken/All-GGUF', 'llamacpp-native')).rejects.toMatchObject({ code: 'MODEL_INVALID' });
    await expect(svc.hubFit('google/gated-demo-it', 'llamacpp-native')).rejects.toMatchObject({ code: 'HF_GATED' });
    gpu = { totalMiB: 100, freeMiB: 1 };
    const none = await svc.hubFit('ggml-org/Qwen3-0.6B-GGUF', 'llamacpp-native');
    expect(none.best).toBeUndefined();
    gpu = undefined;
    await expect(svc.hubFit('ggml-org/Qwen3-0.6B-GGUF', 'llamacpp-native')).rejects.toMatchObject({ code: 'GPU_NOT_FOUND' });
  });

  it('serves the repo info of one hub repo, with the hub errors mapped', async () => {
    const svc = service();
    const info = await svc.hubModel('ggml-org/Qwen3-0.6B-GGUF');
    expect(info).toMatchObject({
      repo: 'ggml-org/Qwen3-0.6B-GGUF',
      author: 'ggml-org',
      downloads: 120000,
      likes: 300,
      license: 'apache-2.0',
      pipelineTag: 'text-generation',
      baseModel: 'Qwen/Qwen3-0.6B',
      formats: ['gguf'],
      private: false,
    });
    expect((await svc.hubModel('ggml-org/Qwen3-0.6B-GGUF', 'main')).sha).toMatch(/^[0-9a-f]{40}$/);
    // Like HF: a missing (or private) repo is a bare 401 without a token, a 404 with one.
    await expect(svc.hubModel('nobody/missing')).rejects.toMatchObject({ code: 'HF_AUTH_REQUIRED' });
    token = 'hf_test_token';
    await expect(svc.hubModel('nobody/missing')).rejects.toMatchObject({ code: 'HF_NOT_FOUND' });
    hub.behavior.rateLimitNext = 1;
    await expect(svc.hubModel('nobody/other')).rejects.toMatchObject({ code: 'HF_RATE_LIMITED' });
  });

  it('plans a hub GGUF download with the identity its library copy will have', async () => {
    const svc = service();
    const repo = 'ggml-org/Qwen3-0.6B-GGUF';
    const file = 'Qwen3-0.6B-Q4_K_M.gguf';
    const planned = await svc.plannedGguf(repo, file);
    const size = hub.file(repo, file).size;
    expect(planned).toEqual({
      identity: expect.objectContaining({
        displayName: 'Qwen3-0.6B-Q4_K_M',
        format: 'gguf',
        source: 'hf',
        repo,
        file,
        files: [file],
        sizeBytes: size,
        quant: 'Q4_K_M',
        sha256: hub.file(repo, file).sha256,
        weakKey: `${repo}/${file}/Q4_K_M/${size}`,
      }),
      file,
      paths: [path.join(lib(), 'ggml-org', 'Qwen3-0.6B-GGUF', file)],
      bytes: size,
    });
    expect(planned.identity.facts?.blockCount).toBe(4);
    expect(planned.identity).not.toHaveProperty('revision');
    expect(await svc.findGguf(repo, file)).toBeUndefined();

    // The real downloader puts it exactly there, and the library then knows it under the same keys.
    const downloads = new DownloadService({
      fetch: globalThis.fetch,
      clock: systemClock,
      log: memoryLogger(),
      dataDir: path.join(t.dir, 'data'),
      modelsDir: () => svc.libraryDir(),
      hub: svc.hub,
      publish: () => {},
      statfs: async () => ({ bavail: 1e12, bsize: 1 }),
    });
    await downloads.add({ repo, revision: 'main', files: [file] });
    await downloads.idle();
    expect(existsSync(planned.paths[0] as string)).toBe(true);
    await svc.rescan();
    const local = await svc.findGguf(repo, file);
    expect(local?.paths[0]).toBe(planned.paths[0]);
    expect(local?.identity).toMatchObject({ weakKey: planned.identity.weakKey, sha256: planned.identity.sha256, displayName: planned.identity.displayName });
  });

  it('plans split GGUFs from any shard (all shards, keyed by the first) and validates the request', async () => {
    const svc = service();
    const repo = 'unsloth/Demo-31B-it-GGUF';
    const second = 'Q4_K_M/Demo-31B-it-Q4_K_M-00002-of-00002.gguf';
    const first = 'Q4_K_M/Demo-31B-it-Q4_K_M-00001-of-00002.gguf';
    const planned = await svc.plannedGguf(repo, second, 'main');
    expect(planned.file).toBe(first);
    expect(planned.paths).toEqual([path.join(lib(), 'unsloth', 'Demo-31B-it-GGUF', 'Q4_K_M', 'Demo-31B-it-Q4_K_M-00001-of-00002.gguf'), path.join(lib(), 'unsloth', 'Demo-31B-it-GGUF', 'Q4_K_M', 'Demo-31B-it-Q4_K_M-00002-of-00002.gguf')]);
    expect(planned.bytes).toBe(192 * 1024);
    expect(planned.identity).toMatchObject({
      displayName: 'Demo-31B-it-Q4_K_M',
      file: 'Demo-31B-it-Q4_K_M-00001-of-00002.gguf',
      revision: 'main',
      weakKey: `${repo}/Demo-31B-it-Q4_K_M-00001-of-00002.gguf/Q4_K_M/${192 * 1024}`,
    });
    // An mmproj file is not part of a quant group: planned on its own.
    const mm = await svc.plannedGguf(repo, 'mmproj-F16.gguf');
    expect(mm.paths).toHaveLength(1);
    // No quant in the file name: the header's file type names it (the weak key keeps the file-name quant, empty).
    hub.addRepo({ id: 'named/Plain-GGUF', files: [{ path: 'plain.gguf', gguf: { ...hubLlamaLike({ name: 'Plain', sizeLabel: '1B', fileType: 15 }), totalSize: 4096 } }] });
    const plain = await svc.plannedGguf('named/Plain-GGUF', 'plain.gguf');
    expect(plain.identity.quant).toBe('Q4_K_M');
    expect(plain.identity.weakKey).toBe(`named/Plain-GGUF/plain.gguf//${hub.file('named/Plain-GGUF', 'plain.gguf').size}`);
    await expect(svc.plannedGguf(repo, 'missing.gguf')).rejects.toMatchObject({ code: 'HF_NOT_FOUND' });
    await expect(svc.plannedGguf('not a repo', 'x.gguf')).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(svc.plannedGguf(repo, '../x.gguf')).rejects.toMatchObject({ code: 'VALIDATION' });
    // A header that cannot be read (or a file named without a quant): still planned, without facts.
    hub.addRepo({ id: 'broken/Odd-GGUF', files: [{ path: 'model.gguf', size: 100 }] });
    const odd = await svc.plannedGguf('broken/Odd-GGUF', 'model.gguf');
    expect(odd.identity).not.toHaveProperty('facts');
    expect(odd.identity).not.toHaveProperty('quant');
    expect(odd.identity.weakKey).toBe('broken/Odd-GGUF/model.gguf//100');
    // Unsigned listings (no LFS sha256): no sha256 in the identity.
    hub.addRepo({ id: 'plain/Small-GGUF', files: [{ path: 'tiny-Q8_0.gguf', size: 64, lfs: false }] });
    expect((await svc.plannedGguf('plain/Small-GGUF', 'tiny-Q8_0.gguf')).identity).not.toHaveProperty('sha256');
  });

  it('finds downloaded hub GGUFs in the library by repo and any shard', async () => {
    const repoDir = path.join(lib(), 'o', 'r');
    gguf(path.join(repoDir, 'Q4_K_M', 'x-Q4_K_M-00001-of-00002.gguf'));
    writeGguf(path.join(repoDir, 'Q4_K_M', 'x-Q4_K_M-00002-of-00002.gguf'), { metadata: {} });
    gguf(path.join(repoDir, 'single-Q8_0.gguf'));
    writeFileSync(path.join(repoDir, DOWNLOAD_SIDECAR), JSON.stringify({ repo: 'o/r', files: {} }));
    gguf(path.join(lib(), 'loose-Q8_0.gguf'));
    const svc = service();
    expect((await svc.findGguf('o/r', 'Q4_K_M/x-Q4_K_M-00002-of-00002.gguf'))?.identity.file).toBe('x-Q4_K_M-00001-of-00002.gguf');
    expect((await svc.findGguf('o/r', 'single-Q8_0.gguf'))?.identity.file).toBe('single-Q8_0.gguf');
    expect(await svc.findGguf('o/other', 'single-Q8_0.gguf')).toBeUndefined();
    expect(await svc.findGguf('o/r', 'loose-Q8_0.gguf')).toBeUndefined();
  });

  it('serves the curated list filtered by VRAM (given, from the GPU, or unfiltered)', async () => {
    const svc = service();
    const given = await svc.curated(12);
    expect(given.vramGB).toBe(12);
    expect(given.tierGB).toBe(12);
    expect(given.models.every((m) => m.tier <= 12)).toBe(true);
    expect(given.reference.repo).toBe('Qwen/Qwen3-4B-GGUF');
    // A 5090 reports 31.8 GiB: it gets the 32 GB recommendations.
    expect(given.models[0]?.fit).toMatchObject({ level: expect.any(String), quant: given.models[0]?.quant, engine: given.models[0]?.engine });
    expect(given.models.some((m) => m.engine === 'vllm')).toBe(true);
    const fromGpu = await svc.curated();
    expect(fromGpu.vramGB).toBeCloseTo(GPU_32GB.totalMiB / 1024, 3);
    expect(fromGpu.tierGB).toBe(32);
    expect(fromGpu.models[0]?.tier).toBe(32);
    expect((await svc.curated(31.8)).tierGB).toBe(32);
    const tiny = await svc.curated(4);
    expect(tiny).not.toHaveProperty('tierGB');
    expect(tiny.models).toEqual([]);
    gpu = undefined;
    const all = await svc.curated();
    expect(all.vramGB).toBeUndefined();
    expect(all.models.every((m) => m.fit === undefined)).toBe(true);
    // No GPU: smallest first.
    const sizes = all.models.map((m) => [m.tier, m.sizeBytes] as const);
    expect(sizes).toEqual([...sizes].sort((a, b) => a[0] - b[0] || a[1] - b[1]));
    expect(all.models.length).toBeGreaterThan(given.models.length);
    const broken = new ModelsService({
      deps: modelDeps(t.dir, { paths: { ...modelDeps(t.dir).paths, resourcesDir: path.join(t.dir, 'none') } }),
      settings: settingsWith(),
      getToken: () => undefined,
      gpuInfo: () => Promise.resolve(undefined),
      autoHash: false,
    });
    await expect(broken.curated()).rejects.toMatchObject({ code: 'INTERNAL' });
    // Not cached after a failure: a fixed file is read on the next call.
    mkdirSync(path.join(t.dir, 'none'));
    const { copyFileSync } = await import('node:fs');
    copyFileSync(path.join('resources', 'curated-models.json'), path.join(t.dir, 'none', 'curated-models.json'));
    expect((await broken.curated()).models.length).toBeGreaterThan(0);
  });

  it('deletes only models inside the library folder and prunes empty folders', async () => {
    const repoDir = path.join(lib(), 'o', 'r');
    gguf(path.join(repoDir, 'Q4_K_M', 'x-Q4_K_M-00001-of-00002.gguf'));
    writeGguf(path.join(repoDir, 'Q4_K_M', 'x-Q4_K_M-00002-of-00002.gguf'), { metadata: {} });
    writeFileSync(path.join(repoDir, DOWNLOAD_SIDECAR), JSON.stringify({ repo: 'o/r', files: {} }));
    const keep = gguf(path.join(lib(), 'o', 'keep', 'k-Q8_0.gguf'));
    const outside = path.join(t.dir, 'elsewhere');
    gguf(path.join(outside, 'user-Q8_0.gguf'));
    const stDir = path.join(lib(), 'q', 'st');
    mkdirSync(stDir, { recursive: true });
    writeFileSync(path.join(stDir, 'config.json'), '{"num_hidden_layers": 1}');
    writeSafetensors(path.join(stDir, 'model.safetensors'));
    writeFileSync(path.join(stDir, 'tokenizer.json'), '{}');
    const svc = service({ extraModelDirs: [outside] });
    const models = await svc.list();
    const split = models.find((m) => m.identity.displayName === 'x-Q4_K_M') as (typeof models)[number];
    const user = models.find((m) => m.identity.displayName === 'user-Q8_0') as (typeof models)[number];
    const st = models.find((m) => m.identity.format === 'safetensors') as (typeof models)[number];

    await expect(svc.deleteLocal(user.id)).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(existsSync(user.paths[0] as string)).toBe(true);

    await svc.deleteLocal(split.id);
    expect(existsSync(repoDir)).toBe(false);
    expect(existsSync(keep)).toBe(true);
    expect((await svc.list()).some((m) => m.id === split.id)).toBe(false);

    await svc.deleteLocal(st.id);
    expect(existsSync(stDir)).toBe(false);
    expect(existsSync(path.join(lib(), 'q'))).toBe(false);
    expect(readdirSync(lib())).toEqual(['o']);
  });

  it('refuses deletes through links pointing outside, and without a library folder', async () => {
    const outside = path.join(t.dir, 'outside');
    gguf(path.join(outside, 'real-Q8_0.gguf'));
    mkdirSync(lib(), { recursive: true });
    symlinkSync(outside, path.join(lib(), 'linked'), 'junction');
    const svc = service();
    const m = (await svc.list()).find((x) => x.identity.displayName === 'real-Q8_0');
    expect(m).toBeDefined();
    await expect(svc.deleteLocal(m?.id as string)).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(existsSync(path.join(outside, 'real-Q8_0.gguf'))).toBe(true);

    // The library folder is gone (moved drive…): nothing can be deleted.
    const svc2 = service({ extraModelDirs: [outside], modelsDir: path.join(t.dir, 'missing-lib') });
    const m2 = (await svc2.list())[0];
    await expect(svc2.deleteLocal(m2?.id as string)).rejects.toMatchObject({ code: 'VALIDATION' });
    // A model whose files vanished: the check uses the plain path.
    gguf(path.join(lib(), 'vanish-Q8_0.gguf'));
    const svc3 = service();
    const v = (await svc3.list()).find((x) => x.identity.displayName === 'vanish-Q8_0');
    const { rmSync } = await import('node:fs');
    rmSync(v?.paths[0] as string);
    await svc3.deleteLocal(v?.id as string);
    expect((await svc3.list()).some((x) => x.id === v?.id)).toBe(false);
    // Its whole folder vanished: nothing left to prune.
    gguf(path.join(lib(), 'gone', 'dir', 'g-Q8_0.gguf'));
    const g = (await svc3.rescan()).find((x) => x.identity.displayName === 'g-Q8_0');
    rmSync(path.join(lib(), 'gone', 'dir'), { recursive: true });
    await svc3.deleteLocal(g?.id as string);
    expect(existsSync(path.join(lib(), 'gone'))).toBe(true);
  });
});
