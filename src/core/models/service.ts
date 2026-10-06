import { readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import type { FitRequest } from '../../contract/api';
import type { EngineKind } from '../../contract/engines';
import { AppError } from '../../contract/errors';
import type { FitEstimate, HubFile, HubModel, LocalModel } from '../../contract/models';
import type { Settings } from '../../contract/settings';
import type { CoreDeps } from '../deps';
import { curatedForVram, loadCurated, type CuratedList, type CuratedModel } from './curated';
import { bestQuant, estimateFit, fitParamsFrom, quantChoices, type FitParams, type QuantChoice } from './fit';
import { HashCache, HashQueue, weakKey } from './hash';
import { HubClient, type HubFormat, type HubSort, type RemoteGgufFacts } from './hub';
import { isInside, parseShard } from './paths';
import { quantFromFilename } from './quant';
import { DOWNLOAD_SIDECAR, ModelScanner } from './scanner';
import type { GpuInfoFn, GpuMem, ModelFactsEx, TokenFn } from './types';

export interface ModelsServiceOptions {
  deps: Pick<CoreDeps, 'fetch' | 'paths' | 'endpoints' | 'platform' | 'env' | 'log'>;
  settings: () => Promise<Settings>;
  getToken: TokenFn;
  /** Total/free VRAM of the GPU used for benchmarks; undefined when there is no NVIDIA GPU. */
  gpuInfo: GpuInfoFn;
  /** Hash local models in the background after each scan (default true). */
  autoHash?: boolean;
  hub?: HubClient;
}

export interface ModelSearchOptions {
  format?: HubFormat;
  sort?: HubSort;
  limit?: number;
  /** Keep only repos whose parameter count fits the free VRAM at a typical quant. */
  onlyFits?: boolean;
}

export interface HubFitResult {
  /** Every weights option, largest first, with the weak key a local copy of it would have. */
  choices: (QuantChoice & { weakKey: string })[];
  /** groupKey of the preselected option (best quality that fits). */
  best?: string;
  facts: ModelFactsEx;
}

export interface CuratedResponse {
  vramGB?: number;
  reference: CuratedList['reference'];
  models: CuratedModel[];
}

const MIB_PER_GB = 1024;

/** Local library, HF search, VRAM fit and the curated list behind /api/models. */
export class ModelsService {
  readonly hub: HubClient;
  readonly scanner: ModelScanner;
  readonly hashes: HashQueue;
  private models: LocalModel[] | undefined;
  private scanning: Promise<LocalModel[]> | undefined;
  private curatedList: Promise<CuratedList> | undefined;

  constructor(private readonly opts: ModelsServiceOptions) {
    const { deps } = opts;
    this.hub = opts.hub ?? new HubClient({ fetch: deps.fetch, baseUrl: deps.endpoints.huggingface, getToken: opts.getToken });
    const hashCache = new HashCache(path.join(deps.paths.cacheDir, 'hashes.json'), deps.platform);
    this.hashes = new HashQueue({ cache: hashCache });
    this.scanner = new ModelScanner({
      platform: deps.platform,
      home: deps.paths.home,
      env: deps.env,
      defaultModelsDir: deps.paths.modelsDir,
      cacheDir: deps.paths.cacheDir,
      log: deps.log,
      settings: opts.settings,
      hashCache,
    });
  }

  /** Where downloads go and the only folder whose models may be deleted from the app. */
  libraryDir(): Promise<string> {
    return this.scanner.libraryDir();
  }

  /** Last scan result (scans once on first use). */
  async list(): Promise<LocalModel[]> {
    return this.models ?? this.rescan();
  }

  rescan(): Promise<LocalModel[]> {
    this.scanning ??= this.scanner
      .scan()
      .then((models) => {
        this.models = models;
        if (this.opts.autoHash ?? true) this.hashInBackground(models);
        return models;
      })
      .finally(() => {
        this.scanning = undefined;
      });
    return this.scanning;
  }

  private hashInBackground(models: LocalModel[]): void {
    for (const m of models) {
      if (m.identity.sha256 || m.identity.format !== 'gguf') continue;
      this.hashes
        .enqueue(m.paths[0] as string)
        .then((sha) => {
          m.identity.sha256 = sha;
        })
        .catch((e: unknown) => this.opts.deps.log.debug('background hash failed', { id: m.id, error: (e as Error).message }));
    }
  }

  async get(id: string): Promise<LocalModel> {
    const m = (await this.list()).find((x) => x.id === id);
    if (!m) throw new AppError('MODEL_NOT_FOUND', `No local model with id ${id}`, { params: { id } });
    return m;
  }

  private async gpu(): Promise<GpuMem> {
    const gpu = await this.opts.gpuInfo();
    if (!gpu) throw new AppError('GPU_NOT_FOUND', 'No NVIDIA GPU detected');
    return gpu;
  }

  async search(q: string, opts: ModelSearchOptions = {}): Promise<HubModel[]> {
    const found = await this.hub.search(q, opts);
    if (!opts.onlyFits) return found;
    const gpu = await this.opts.gpuInfo();
    if (!gpu) return found;
    // Without the files we judge from the parameter count: Q4_K_M for GGUF, BF16 for safetensors.
    return found.filter((m) => {
      if (m.paramsB === undefined) return false;
      const gguf = opts.format === 'gguf' || (opts.format !== 'safetensors' && m.formats.includes('gguf'));
      const fit = estimateFit({ facts: { paramsB: m.paramsB, quant: gguf ? 'Q4_K_M' : 'BF16' }, gpu, engine: gguf ? 'llamacpp-native' : 'vllm-docker' });
      return fit.level !== 'no' && fit.level !== 'partial';
    });
  }

  hubFiles(repo: string, revision?: string): Promise<HubFile[]> {
    return this.hub.files(repo, revision);
  }

  readme(repo: string): Promise<{ text: string; truncated: boolean }> {
    return this.hub.readme(repo);
  }

  related(repo: string, opts: ModelSearchOptions = {}): Promise<HubModel[]> {
    return this.hub.related(repo, opts);
  }

  remoteGgufFacts(repo: string, file: string, revision?: string): Promise<RemoteGgufFacts> {
    return this.hub.ggufFacts(repo, file, revision);
  }

  /** Fit of a local model (localId), a hub GGUF file (repo + file) or a safetensors repo (repo). */
  async fit(req: FitRequest): Promise<FitEstimate> {
    const gpu = await this.gpu();
    const params: FitParams = fitParamsFrom(req.params);
    if (req.localId) {
      const m = await this.get(req.localId);
      return estimateFit({ facts: m.identity.facts ?? {}, fileBytes: m.identity.sizeBytes, gpu, engine: req.engine, params });
    }
    if (req.repo && req.file) {
      const files = await this.hub.files(req.repo);
      const target = files.find((f) => f.path === req.file);
      if (!target) throw new AppError('HF_NOT_FOUND', `File not in repo: ${req.file}`, { params: { repo: req.repo, file: req.file } });
      const group = target.groupKey ? files.filter((f) => f.groupKey === target.groupKey) : [target];
      const first = [...group].sort((a, b) => a.path.localeCompare(b.path))[0] as HubFile;
      const { facts } = await this.hub.ggufFacts(req.repo, first.path);
      const fileBytes = group.reduce((a, f) => a + f.sizeBytes, 0);
      return estimateFit({ facts, fileBytes, gpu, engine: req.engine, params });
    }
    if (req.repo) {
      const { facts, fileBytes } = await this.hub.configFacts(req.repo);
      return estimateFit({ facts, fileBytes, gpu, engine: req.engine, params });
    }
    throw new AppError('VALIDATION', 'Fit needs localId, repo + file, or repo');
  }

  /** Fit of every quant of a hub repo and the preselected best one. */
  async hubFit(repo: string, engine: EngineKind, opts: { revision?: string; params?: FitRequest['params'] } = {}): Promise<HubFitResult> {
    const gpu = await this.gpu();
    const files = await this.hub.files(repo, opts.revision);
    const ggufWeights = files.filter((f) => f.kind === 'weights' && f.path.toLowerCase().endsWith('.gguf')).sort((a, b) => a.path.localeCompare(b.path));
    const vllm = engine === 'vllm-docker' || engine === 'vllm-native';
    const hasSafetensors = files.some((f) => f.kind === 'weights' && f.path.endsWith('.safetensors'));
    let facts: ModelFactsEx;
    let usable: HubFile[];
    // Repos can ship both formats: vLLM loads the safetensors, llama.cpp the GGUF files.
    if (ggufWeights.length > 0 && !(vllm && hasSafetensors)) {
      facts = await this.readableFacts(repo, ggufWeights, opts.revision);
      usable = files.filter((f) => !f.path.endsWith('.safetensors'));
    } else {
      facts = (await this.hub.configFacts(repo, opts.revision)).facts;
      usable = files.filter((f) => !f.path.toLowerCase().endsWith('.gguf'));
    }
    const params = fitParamsFrom(opts.params);
    const choices = quantChoices(usable, facts, gpu, engine, params).map((c) => {
      const first = [...c.files].sort((a, b) => a.path.localeCompare(b.path))[0] as HubFile;
      return { ...c, weakKey: weakKey({ repo, file: first.path, quant: quantFromFilename(path.posix.basename(first.path)), sizeBytes: c.sizeBytes }) };
    });
    const best = bestQuant(usable, facts, gpu, engine, params);
    return { choices, facts, ...(best ? { best: best.groupKey } : {}) };
  }

  /**
   * Facts from the first quant whose header parses (a repo may hold a broken or non-standard
   * file); other errors (gated, network) are not worth retrying on the next file.
   */
  private async readableFacts(repo: string, weights: HubFile[], revision?: string): Promise<ModelFactsEx> {
    const heads = weights.filter((f) => (parseShard(path.posix.basename(f.path))?.index ?? 1) === 1).slice(0, 3);
    let firstError: unknown;
    for (const f of heads) {
      try {
        return (await this.hub.ggufFacts(repo, f.path, revision)).facts;
      } catch (e) {
        if ((e as AppError).code !== 'MODEL_INVALID') throw e;
        firstError ??= e;
      }
    }
    throw firstError;
  }

  async curated(vramGB?: number): Promise<CuratedResponse> {
    this.curatedList ??= loadCurated(this.opts.deps.paths.resourcesDir);
    const list = await this.curatedList.catch((e: unknown) => {
      this.curatedList = undefined;
      throw e;
    });
    const gb = vramGB ?? ((await this.opts.gpuInfo())?.totalMiB ?? 0) / MIB_PER_GB;
    if (gb <= 0) return { reference: list.reference, models: list.models };
    return { vramGB: gb, reference: list.reference, models: curatedForVram(list, gb) };
  }

  /**
   * Deletes a model's files. Only models entirely inside the GPU Bench models folder qualify (real
   * paths, so a symlink cannot point the delete elsewhere): user files in other folders, LM Studio,
   * Ollama or the HF cache are never touched.
   */
  async deleteLocal(id: string): Promise<void> {
    const m = await this.get(id);
    const lib = await realpath(await this.libraryDir()).catch(() => undefined);
    const targets = m.identity.format === 'safetensors' ? [m.dir] : m.paths;
    for (const t of targets) {
      const real = await realpath(t).catch(() => path.resolve(t));
      if (!lib || !isInside(real, lib)) {
        throw new AppError('VALIDATION', 'Only models inside the GPU Bench models folder can be deleted', { params: { path: t } });
      }
    }
    for (const t of targets) await rm(t, { recursive: true, force: true });
    await pruneEmptyDirs(m.identity.format === 'safetensors' ? path.dirname(m.dir) : m.dir, lib as string);
    this.models = this.models?.filter((x) => x.id !== id);
  }
}

/** Removes now-empty folders (or folders holding only our download sidecar) up to the library root. */
async function pruneEmptyDirs(start: string, root: string): Promise<void> {
  let dir = start;
  while (isInside(dir, root)) {
    const entries = await readdir(dir).catch(() => undefined);
    if (!entries || entries.some((e) => e !== DOWNLOAD_SIDECAR)) return;
    // Only our sidecar (or nothing) is left: removing the folder recursively is safe.
    await rm(dir, { recursive: true, force: true });
    dir = path.dirname(dir);
  }
}
