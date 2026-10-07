import { readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import type { FitRequest } from '../../contract/api';
import type { EngineKind } from '../../contract/engines';
import { AppError } from '../../contract/errors';
import type { FitEstimate, HubFile, HubModel, LocalModel, ModelIdentity, QuickFit } from '../../contract/models';
import type { Settings } from '../../contract/settings';
import type { CoreDeps } from '../deps';
import { curatedForVram, loadCurated, tierFor, type CuratedList, type CuratedModel } from './curated';
import { bestQuant, estimateFit, fitParamsFrom, quantChoices, type FitCalibration, type FitParams, type QuantChoice } from './fit';
import { HashCache, HashQueue, weakKey } from './hash';
import { HubClient, type HubPage, type HubRepoInfo, type RemoteGgufFacts, type SearchOptions } from './hub';
import { isInside, libraryPath, parseShard, REPO_RE, safeRepoPath } from './paths';
import { quantFromFilename } from './quant';
import { curatedFit, isLanguageModel, maxFittingParamsB, quickFit, quickFits } from './quick-fit';
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
  /** The correction from VRAM peaks measured on this GPU for a model with an engine (llama.cpp); undefined = none. */
  calibration?: (model: { sha256?: string; weakKey: string; architecture?: string }, engine: EngineKind) => Promise<FitCalibration | undefined>;
}

export interface ModelSearchOptions extends SearchOptions {
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

/** A hub GGUF before its download (see ModelsService.plannedGguf). */
export interface PlannedGguf {
  identity: ModelIdentity;
  /** Path inside the repo of the file llama.cpp opens (first shard of a split model). */
  file: string;
  /** Where the downloader will write each shard. */
  paths: string[];
  bytes: number;
}

export interface CuratedResponse {
  /** VRAM the list was chosen for (as asked, or read from the GPU). */
  vramGB?: number;
  /** The VRAM tier that VRAM counts as (31.8 GiB → 32); absent below the smallest tier. */
  tierGB?: number;
  reference: CuratedList['reference'];
  /** Each with a VRAM verdict from its exact file size, when there is a GPU. */
  models: (CuratedModel & { fit?: QuickFit })[];
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

  /**
   * One page of hub results, each with a quick VRAM verdict. "Only what fits" also bounds the
   * parameter count sent to the hub, so its pages stay full instead of being filtered to nothing.
   */
  async search(q: string, opts: ModelSearchOptions = {}): Promise<HubPage> {
    const gpu = await this.opts.gpuInfo();
    const onlyFits = opts.onlyFits === true && gpu !== undefined;
    const { onlyFits: _, ...hubOpts } = opts;
    if (onlyFits) hubOpts.maxParamsB = Math.min(opts.maxParamsB ?? Infinity, maxFittingParamsB(gpu, opts.format ?? 'any'));
    const page = await this.hub.search(q, hubOpts);
    const models: HubModel[] = [];
    for (const m of page.models) {
      if (!isLanguageModel(m)) continue;
      // HF counts parameters its own way (for GGUF, often from one file); cards show ours, so the size filter follows ours.
      if (m.paramsB !== undefined && (m.paramsB < (opts.minParamsB ?? 0) || m.paramsB > (opts.maxParamsB ?? Infinity))) continue;
      const fit = gpu && quickFit(m, gpu, opts.format);
      if (onlyFits && !quickFits(fit)) continue;
      models.push(fit ? { ...m, fit } : m);
    }
    return page.nextCursor ? { models, nextCursor: page.nextCursor } : { models };
  }

  /** Repo card data (downloads, likes, gated, license, formats, params…) of one hub repo. */
  hubModel(repo: string, revision?: string): Promise<HubRepoInfo> {
    return this.hub.info(repo, revision);
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

  /** The library copy of a hub GGUF (`file` = path in the repo; any shard of a split model), when downloaded. */
  async findGguf(repo: string, file: string): Promise<LocalModel | undefined> {
    const name = path.posix.basename(file);
    const shard = parseShard(name);
    const first = shard ? name.replace(/-\d{5}-of-(\d{5})\.gguf$/i, '-00001-of-$1.gguf') : name;
    return (await this.list()).find((m) => m.identity.format === 'gguf' && m.identity.repo === repo && m.identity.file === first);
  }

  /**
   * A hub GGUF as it will be once downloaded into the library, for plan previews before the
   * download: the identity its local copy will have (same weak key and sha256, so past results are
   * found), the paths the downloader will write (every shard) and the bytes to fetch.
   */
  async plannedGguf(repo: string, file: string, revision?: string): Promise<PlannedGguf> {
    if (!REPO_RE.test(repo) || !safeRepoPath(file)) throw new AppError('VALIDATION', 'Invalid repo or file', { params: { repo, file } });
    const files = await this.hub.files(repo, revision);
    const target = files.find((f) => f.path === file);
    if (!target) throw new AppError('HF_NOT_FOUND', `File not in repo: ${file}`, { params: { repo, file } });
    const group = (target.groupKey ? files.filter((f) => f.groupKey === target.groupKey) : [target]).sort((a, b) => a.path.localeCompare(b.path));
    const first = group[0] as HubFile;
    const name = path.posix.basename(first.path);
    const bytes = group.reduce((a, f) => a + f.sizeBytes, 0);
    // Facts (context length, layers) make the previewed command exact; without them it still works.
    const facts = await this.hub.ggufFacts(repo, first.path, revision).then(
      (r) => r.facts,
      () => undefined,
    );
    const fileQuant = quantFromFilename(name);
    const shard = parseShard(name);
    // Same rules as the scanner's identity of the downloaded copy (see ModelScanner.ggufModel).
    const identity: ModelIdentity = {
      displayName: shard ? shard.prefix : name.replace(/\.gguf$/i, ''),
      format: 'gguf',
      source: 'hf',
      repo,
      file: name,
      files: group.map((f) => path.posix.basename(f.path)),
      sizeBytes: bytes,
      weakKey: weakKey({ repo, file: name, quant: fileQuant, sizeBytes: bytes }),
    };
    if (revision) identity.revision = revision;
    const quant = fileQuant ?? facts?.quant;
    if (quant) identity.quant = quant;
    if (first.sha256) identity.sha256 = first.sha256;
    if (facts) identity.facts = facts;
    const dir = await this.libraryDir();
    return { identity, file: first.path, paths: group.map((f) => libraryPath(dir, repo, f.path)), bytes };
  }

  /** Fit of a local model (localId), a hub GGUF file (repo + file) or a safetensors repo (repo). */
  async fit(req: FitRequest): Promise<FitEstimate> {
    const gpu = await this.gpu();
    const params: FitParams = fitParamsFrom(req.params);
    // Corrected with the peaks measured here, when there are enough ("stima tarata su N misure").
    const calibrated = async (model: { sha256?: string; weakKey: string }, facts: ModelFactsEx): Promise<{ calibration?: FitCalibration }> => {
      const c = await this.opts.calibration?.({ ...model, ...(facts.architecture ? { architecture: facts.architecture } : {}) }, req.engine).catch(() => undefined);
      return c ? { calibration: c } : {};
    };
    if (req.localId) {
      const m = await this.get(req.localId);
      const facts = m.identity.facts ?? {};
      const id = { weakKey: m.identity.weakKey, ...(m.identity.sha256 ? { sha256: m.identity.sha256 } : {}) };
      return estimateFit({ facts, fileBytes: m.identity.sizeBytes, gpu, engine: req.engine, params, ...(await calibrated(id, facts)) });
    }
    if (req.repo && req.file) {
      const files = await this.hub.files(req.repo);
      const target = files.find((f) => f.path === req.file);
      if (!target) throw new AppError('HF_NOT_FOUND', `File not in repo: ${req.file}`, { params: { repo: req.repo, file: req.file } });
      const group = target.groupKey ? files.filter((f) => f.groupKey === target.groupKey) : [target];
      const first = [...group].sort((a, b) => a.path.localeCompare(b.path))[0] as HubFile;
      const { facts } = await this.hub.ggufFacts(req.repo, first.path);
      const fileBytes = group.reduce((a, f) => a + f.sizeBytes, 0);
      // The weak key a downloaded copy will have: its measurements count once it was benchmarked.
      const name = path.posix.basename(first.path);
      const key = weakKey({ repo: req.repo, file: name, quant: quantFromFilename(name), sizeBytes: fileBytes });
      return estimateFit({ facts, fileBytes, gpu, engine: req.engine, params, ...(await calibrated({ weakKey: key }, facts)) });
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
    const gpu = await this.opts.gpuInfo();
    const withFit = (models: CuratedModel[]) => (gpu ? models.map((m) => ({ ...m, fit: curatedFit(m, gpu) })) : models);
    const gb = vramGB ?? (gpu?.totalMiB ?? 0) / MIB_PER_GB;
    // Unknown card: every entry, smallest first (the safe pick when the VRAM is not known).
    if (gb <= 0) return { reference: list.reference, models: withFit([...list.models].sort((a, b) => a.tier - b.tier || a.sizeBytes - b.sizeBytes)) };
    const tier = tierFor(gb);
    return { vramGB: gb, ...(tier !== undefined ? { tierGB: tier } : {}), reference: list.reference, models: withFit(curatedForVram(list, gb)) };
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
