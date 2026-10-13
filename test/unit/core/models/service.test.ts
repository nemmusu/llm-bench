import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { EngineKind } from '../../../../src/contract/engines';
import type { LocalModel } from '../../../../src/contract/models';
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
    // A repo with a GGUF next to its safetensors is mixed: with every engine shown it is judged for llama.cpp,
    // with the safetensors filter at its own precision for vLLM / SGLang.
    expect(all.find((m) => m.repo === 'Qwen/Qwen3-0.6B')).toMatchObject({ formats: ['gguf', 'safetensors'], fit: { quant: 'Q4_K_M', engine: 'llamacpp' } });
    expect((await svc.search('qwen3-0.6b', { format: 'safetensors' })).models[0]?.fit).toMatchObject({ quant: 'BF16', engine: 'vllm' });
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

  it('judges the card, not what is free right now: a busy card still finds models, a tiny one none', async () => {
    gpu = { totalMiB: 8192, freeMiB: 0 };
    expect((await service().search('', { onlyFits: true })).models.length).toBeGreaterThan(0);
    gpu = { totalMiB: 1024, freeMiB: 1024 };
    expect((await service().search('', { onlyFits: true })).models).toEqual([]);
  });

  it('keeps only repos vLLM / SGLang can read when the filter asks for safetensors', async () => {
    hub.addRepo({ id: 'mlx-community/Qwen3-0.6B-4bit', tags: ['mlx', 'safetensors'], files: [{ path: 'model.safetensors', size: 10 }] });
    const st = await service().search('qwen3-0.6b', { format: 'safetensors' });
    expect(st.models.map((m) => m.repo)).toEqual(['Qwen/Qwen3-0.6B']);
    const any = await service().search('qwen3-0.6b');
    expect(any.models.find((m) => m.repo === 'mlx-community/Qwen3-0.6B-4bit')).toMatchObject({ formats: ['other'], otherFormats: ['MLX'] });
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
    expect(tight.levelNow === 'partial' || tight.levelNow === 'no').toBe(true);
    expect(tight.busyMiB).toBe(8192 - 400);
    expect(tight.fixes?.maxContext).toBeLessThan(262_144);
    expect(a).not.toHaveProperty('fixes');
    gpu = undefined;
    await expect(svc.fit({ localId: local, engine: 'llamacpp-native' })).rejects.toMatchObject({ code: 'GPU_NOT_FOUND' });
  });

  it('a launch that loads a draft / MTP model or the image projector: both in the estimate (llama.cpp only)', async () => {
    const dir = path.join(lib(), 'o', 'eye');
    gguf(path.join(dir, 'eye-Q4_K_M.gguf'));
    writeGguf(path.join(dir, 'mmproj-eye-F16.gguf'), { metadata: { 'general.architecture': 'clip' }, totalSize: 2 * 1024 ** 2 });
    // A small draft model next to it, and a draft file whose header cannot be read.
    const draft = path.join(t.dir, 'drafts', 'tiny-Q8_0.gguf');
    writeGguf(draft, { ...llamaLikeGguf({ embd: 16, vocab: 8 }), totalSize: 3 * 1024 ** 2 });
    writeFileSync(path.join(t.dir, 'drafts', 'broken.gguf'), Buffer.alloc(1024 ** 2));
    const svc = service();
    const m = (await svc.list()).find((x) => x.identity.displayName === 'eye-Q4_K_M') as LocalModel;
    const fit = (extraArgs: string[], engine: EngineKind = 'llamacpp-native') => svc.fit({ localId: m.id, engine, params: { contextSize: 4096, extraArgs, env: {} } });
    const plain = await fit([]);
    expect(plain).not.toHaveProperty('draftMiB');
    // The projector named by its path in a container (/models/…): the model's own file of that name.
    const both = await fit(['-md', draft, '--mmproj', '/models/o/eye/mmproj-eye-F16.gguf']);
    expect(both.mmprojMiB).toBe(2);
    expect(both.draftMiB).toBeGreaterThanOrEqual(3);
    expect(both.needMiB).toBe(plain.needMiB + (both.draftMiB as number) + 2);
    expect((await fit(['-md', path.join(t.dir, 'drafts', 'broken.gguf')])).draftMiB).toBeGreaterThanOrEqual(1);
    const vision = await fit(['--mmproj=/models/o/eye/mmproj-eye-F16.gguf']);
    expect(vision).toMatchObject({ mmprojMiB: 2, needMiB: plain.needMiB + 2 });
    expect(vision).not.toHaveProperty('draftMiB');
    // A file that is nowhere, or an engine that loads no such files: nothing added.
    expect(await fit(['-md', '/nowhere/x.gguf'])).not.toHaveProperty('draftMiB');
    expect(await fit(['--mmproj', '/models/o/eye/mmproj-eye-F16.gguf'], 'vllm-docker')).not.toHaveProperty('mmprojMiB');
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
    // A format the repo does not ship: no choices.
    gpu = GPU_32GB;
    expect(await svc.hubFit('ggml-org/Qwen3-0.6B-GGUF', 'vllm-docker')).toEqual({ choices: [], facts: {} });
    hub.addRepo({ id: 'only/Safetensors', files: [{ path: 'config.json', content: '{}' }, { path: 'model.safetensors', size: 10 }] });
    expect(await svc.hubFit('only/Safetensors', 'llamacpp-native')).toEqual({ choices: [], facts: {} });
    gpu = undefined;
    await expect(svc.hubFit('ggml-org/Qwen3-0.6B-GGUF', 'llamacpp-native')).rejects.toMatchObject({ code: 'GPU_NOT_FOUND' });
  });

  it('a mixed repo: GGUF quants for llama.cpp, one choice per safetensors folder for vLLM, each with exactly its files', async () => {
    const config = (q?: object) => JSON.stringify({ architectures: ['Qwen3ForCausalLM'], num_hidden_layers: 4, num_attention_heads: 8, num_key_value_heads: 2, head_dim: 64, torch_dtype: 'bfloat16', ...(q ? { quantization_config: q } : {}) });
    hub.addRepo({
      id: 'mixed/Kitchen-27B-GGUF-NInfer',
      tags: ['gguf', 'safetensors'],
      files: [
        { path: 'README.md', content: '# Kitchen' },
        { path: 'assets/demo.mp4', size: 4096 },
        { path: 'GGUF/Kitchen-27B-Q4LynnStyle-MTP.gguf', gguf: { ...hubLlamaLike({ name: 'Kitchen', sizeLabel: '27B' }), totalSize: 96 * 1024 } },
        { path: 'GGUF/Kitchen-27B-Q4LynnStyle-Q8MTP.gguf', gguf: { ...hubLlamaLike({ name: 'Kitchen', sizeLabel: '27B' }), totalSize: 98 * 1024 } },
        { path: 'GGUF/mmproj-Kitchen-Q8_0.gguf', size: 8 * 1024 },
        { path: 'GGUF/mtp-Kitchen-27B-Q8_0.gguf', size: 8 * 1024 },
        { path: 'BF16/config.json', content: config() },
        { path: 'BF16/tokenizer.json', content: '{}' },
        { path: 'BF16/model.safetensors', size: 200 * 1024 },
        { path: 'BF16/README.md', content: 'no' },
        { path: 'FP8/config.json', content: config({ quant_method: 'fp8' }) },
        { path: 'FP8/model.safetensors', size: 100 * 1024 },
        { path: 'broken/config.json', content: '{nope' },
        { path: 'broken/model.safetensors', size: 10 },
        { path: 'GGUF-NInfer/model.ninfer', size: 50 * 1024 },
      ],
    });
    const svc = service();
    const g = await svc.hubFit('mixed/Kitchen-27B-GGUF-NInfer', 'llamacpp-native');
    expect(g.choices.map((c) => c.quant)).toEqual(['Q4LynnStyle · Q8MTP', 'Q4LynnStyle · MTP']);
    expect(g.choices.every((c) => c.files.every((f) => f.path.endsWith('.gguf') && f.kind === 'weights'))).toBe(true);
    expect(g.facts.blockCount).toBe(4);
    const v = await svc.hubFit('mixed/Kitchen-27B-GGUF-NInfer', 'vllm-docker');
    // The folder whose config cannot be read is left out; the others are judged with their own config.
    expect(v.choices.map((c) => [c.groupKey, c.dir, c.quant])).toEqual([
      ['BF16/*', 'BF16', 'BF16'],
      ['FP8/*', 'FP8', 'FP8'],
    ]);
    expect(v.choices[0]?.files.map((f) => f.path)).toEqual(['BF16/config.json', 'BF16/model.safetensors', 'BF16/tokenizer.json']);
    expect(v.choices[0]?.sizeBytes).toBe(v.choices[0]!.files.reduce((a, f) => a + f.sizeBytes, 0));
    // The weak key the scanner gives the downloaded folder: first weights file, weights bytes, no quant.
    expect(v.choices[1]?.weakKey).toBe(`mixed/Kitchen-27B-GGUF-NInfer/model.safetensors//${100 * 1024}`);
    expect(v.best).toBe('BF16/*');
    expect(v.facts.blockCount).toBe(4);
    // A gated repo stops at once, whatever folder.
    hub.addRepo({ id: 'gated/Variants', gated: 'manual', files: [{ path: 'FP8/config.json', content: config() }, { path: 'FP8/model.safetensors', size: 10 }] });
    await expect(svc.hubFit('gated/Variants', 'vllm-docker')).rejects.toMatchObject({ code: 'HF_GATED' });
    // Nothing readable at all: no choices, no facts.
    hub.addRepo({ id: 'broken/Variants', files: [{ path: 'X/config.json', content: '{' }, { path: 'X/model.safetensors', size: 10 }] });
    expect(await svc.hubFit('broken/Variants', 'vllm-docker')).toEqual({ choices: [], facts: {} });
  });

  it('NInfer: one choice per .ninfer artifact (manifest read, the NInfer estimate), searched by name; a local artifact too', async () => {
    const manifest = { artifact: { filename: 'qwen3_8_27b_nvfp4.ninfer', bytes: 64 * 1024, container_version: 3, architecture: 'qwen3_8', name: 'Qwen3.8 27B', components: ['text', 'vision', 'mtp'] } };
    hub.addRepo({
      id: 'neroued/Qwen3.8-27B-nvfp4-NInfer',
      tags: ['text-generation'],
      files: [
        { path: 'qwen3_8_27b_nvfp4.ninfer', size: 64 * 1024 },
        { path: 'Qwen3.8-27B-nvfp4-NInfer.artifact-manifest.json', content: JSON.stringify(manifest) },
        { path: 'Qwen3.8-27B-nvfp4-NInfer.SHA256SUMS', content: 'x' },
        { path: 'README.md', content: '# NInfer' },
      ],
    });
    hub.addRepo({ id: 'neroued/Qwen3.8-4B-nvfp4-NInfer', files: [{ path: 'q4b.ninfer', size: 1024 }] });
    const svc = service();
    const r = await svc.hubFit('neroued/Qwen3.8-27B-nvfp4-NInfer', 'llamacpp-native', { format: 'ninfer' });
    expect(r.choices).toHaveLength(1);
    const c = r.choices[0]!;
    expect(c).toMatchObject({ groupKey: 'qwen3_8_27b_nvfp4.ninfer', quant: 'NVFP4', dir: '', manifest: { containerVersion: 3, components: ['text', 'vision', 'mtp'] } });
    expect(c.files.map((f) => f.path).sort()).toEqual(['Qwen3.8-27B-nvfp4-NInfer.SHA256SUMS', 'Qwen3.8-27B-nvfp4-NInfer.artifact-manifest.json', 'qwen3_8_27b_nvfp4.ninfer']);
    // NInfer's own estimate (contract/ninfer.ts), on the card's total; what is free now alongside.
    expect(c.fit.notes).toContain('ninfer.estimate');
    expect(c.fit).toMatchObject({ totalMiB: GPU_32GB.totalMiB, availableMiB: GPU_32GB.totalMiB - 1024 });
    expect(c.fit.levelNow).toBeDefined();
    expect(c.weakKey).toBe(`neroued/Qwen3.8-27B-nvfp4-NInfer/qwen3_8_27b_nvfp4.ninfer//${64 * 1024}`);
    expect(r.facts).toMatchObject({ architecture: 'qwen3_8', name: 'Qwen3.8 27B', paramsB: 27, contextLength: 262_144 });
    expect(r.best).toBe('qwen3_8_27b_nvfp4.ninfer');
    // Without a manifest: still a choice; a repo without .ninfer: none.
    expect((await svc.hubFit('neroued/Qwen3.8-4B-nvfp4-NInfer', 'llamacpp-native', { format: 'ninfer' })).choices[0]?.manifest).toBeUndefined();
    expect(await svc.hubFit('ggml-org/Qwen3-0.6B-GGUF', 'llamacpp-native', { format: 'ninfer' })).toEqual({ choices: [], facts: {} });
    // A mixed repo with GGUF next to the artifact: its KV layout comes from the GGUF header.
    hub.addRepo({
      id: 'mixed/Coder-GGUF-NInfer',
      files: [
        { path: 'GGUF/Coder-Q4_K_M.gguf', gguf: { ...hubLlamaLike({ name: 'Coder', sizeLabel: '27B', layers: 6 }), totalSize: 96 * 1024 } },
        { path: 'NInfer/coder_nvfp4.ninfer', size: 32 * 1024 },
      ],
    });
    const mixed = await svc.hubFit('mixed/Coder-GGUF-NInfer', 'llamacpp-native', { format: 'ninfer' });
    expect(mixed.facts.blockCount).toBe(6);
    // The trained context its GGUF says, over NInfer's default.
    expect(mixed.facts.contextLength).toBe(40_960);
    expect(mixed.choices[0]?.dir).toBe('NInfer');
    // The NInfer filter searches by name and narrows by the words typed.
    const found = await svc.search('27b nvfp4', { format: 'ninfer' });
    expect(found.models.map((m) => m.repo)).toEqual(['neroued/Qwen3.8-27B-nvfp4-NInfer']);
    expect(found.models[0]?.fit?.engine).toBe('ninfer');
    expect((await svc.search('', { format: 'ninfer' })).models.map((m) => m.repo)).toEqual(expect.arrayContaining(['mixed/Coder-GGUF-NInfer', 'neroued/Qwen3.8-27B-nvfp4-NInfer', 'neroued/Qwen3.8-4B-nvfp4-NInfer']));
    // A .ninfer artifact on the PC: the same estimate, with what the scanner kept from its manifest.
    const dir = path.join(lib(), 'neroued', 'Qwen3.8-27B-nvfp4-NInfer');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'qwen3_8_27b_nvfp4.ninfer'), Buffer.alloc(4096));
    writeFileSync(path.join(dir, 'Q.artifact-manifest.json'), JSON.stringify({ artifact: { name: 'qwen3.8-27b', components: ['text', 'mtp'] } }));
    const local = (await svc.rescan()).find((m) => m.identity.format === 'ninfer')!;
    expect(local.identity.facts).toMatchObject({ name: 'qwen3.8-27b', components: ['text', 'mtp'] });
    const lf = await svc.fit({ localId: local.id, engine: 'llamacpp-native' });
    expect(lf.notes).toContain('ninfer.estimate');
    // Without manifest facts or a known size it still answers.
    writeFileSync(path.join(lib(), 'bare.ninfer'), 'x');
    const bare = (await svc.rescan()).find((m) => m.identity.displayName === 'bare')!;
    expect((await svc.fit({ localId: bare.id, engine: 'llamacpp-native' })).notes).toContain('ninfer.estimate');
  });

  it('what the card holds right now, without the engines LLM Bench started', async () => {
    gpu = { totalMiB: 32607, freeMiB: 10_000, ownMiB: 8000 };
    expect(await service().vramNow()).toEqual({ totalMiB: 32607, freeMiB: 10_000, busyMiB: 32607 - 10_000 - 8000, reserveMiB: 1024 });
    gpu = { totalMiB: 32607, freeMiB: 30_000 };
    expect((await service().vramNow())?.busyMiB).toBe(2607);
    gpu = undefined;
    expect(await service().vramNow()).toBeNull();
  });

  it('hub fits that survive missing parts: no repo info, unreadable GGUF or manifest, configs without a precision', async () => {
    const svc = service();
    hub.addRepo({ id: 'org/Thing-AWQ', files: [{ path: 'config.json', content: '{}' }, { path: 'model.safetensors', size: 64 }] });
    hub.addRepo({ id: 'org/Plain', files: [{ path: 'config.json', content: '{}' }, { path: 'model.safetensors', size: 64 }] });
    hub.addRepo({
      id: 'org/Broken-NInfer',
      files: [
        { path: 'GGUF/x-Q4_K_M.gguf', size: 100 },
        { path: 'GGUF/x-Q8_0.gguf', size: 100 },
        { path: 'a.ninfer', size: 64 },
        { path: 'A.artifact-manifest.json', content: '{' },
      ],
    });
    // The repo's info does not answer: the files are enough (the name hint comes from the repo id).
    hub.behavior.failNext = { status: 500, times: 1, match: 'revision/main' };
    const awq = await svc.hubFit('org/Thing-AWQ', 'vllm-docker', { revision: 'main' });
    expect(awq.choices[0]?.quant).toBe('AWQ');
    const plain = await svc.hubFit('org/Plain', 'sglang-docker');
    expect(plain.choices[0]).not.toHaveProperty('quant');
    const broken = await svc.hubFit('org/Broken-NInfer', 'llamacpp-native', { format: 'ninfer' });
    expect(broken.choices[0]).not.toHaveProperty('manifest');
    expect(broken.facts).toEqual({ quant: 'NVFP4', contextLength: 262_144 });
    // Nothing fits a tiny card: no best.
    gpu = { totalMiB: 512, freeMiB: 512 };
    expect((await svc.hubFit('org/Broken-NInfer', 'llamacpp-native', { format: 'ninfer' })).best).toBeUndefined();
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
