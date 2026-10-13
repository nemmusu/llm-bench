import { readdir, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FitRequest } from '../../contract/api';
import { launchParamsSchema, type EngineKind } from '../../contract/engines';
import { AppError } from '../../contract/errors';
import { NINFER_MANIFEST, parseNinferManifest, precisionFromText, repoLayout, type RepoLayout, type SafetensorsVariant } from '../../contract/formats';
import { VRAM_RESERVE_MIB, type FitEstimate, type HubFile, type HubModel, type LocalModel, type ModelIdentity, type QuickFit, type VramNow } from '../../contract/models';
import type { Settings } from '../../contract/settings';
import type { CoreDeps } from '../deps';
import { curatedForVram, loadCurated, tierFor, type CuratedList, type CuratedModel } from './curated';
import type { ModelKey } from './calibration';
import { ninferFit, trainedContextOf } from '../../contract/ninfer';
import {
  DRAFT_FLAGS,
  estimateFit,
  fitFixes,
  fitParamsFrom,
  flagValue,
  MMPROJ_FLAGS,
  pickBest,
  quantChoices,
  runsSafetensors,
  type FitCalibration,
  type FitExtras,
  type FitInput,
  type FitParams,
  type QuantChoice,
} from './fit';
import { readLocalGgufFacts } from './gguf';
import { HashCache, HashQueue, weakKey } from './hash';
import { HubClient, type HubPage, type HubRepoInfo, type RemoteGgufFacts, type SearchOptions } from './hub';
import { isInside, libraryPath, parseShard, REPO_RE, safeRepoPath } from './paths';
import { paramsFromLabel, quantFromFilename } from './quant';
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
  calibration?: (model: ModelKey, engine: EngineKind) => Promise<FitCalibration | undefined>;
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

/**
 * llama.cpp: the draft / MTP model (-md) and the image projector (--mmproj) a launch's arguments load
 * (a recipe's or the user's), with their sizes and the draft's facts. A path the core cannot see (a
 * container path) is matched to the model's own extra file of that name.
 */
async function launchExtras(args: readonly string[], m: LocalModel): Promise<FitExtras | undefined> {
  const nameOf = (p: string) => path.posix.basename(p.replace(/\\/g, '/'));
  const file = async (p: string | undefined): Promise<{ at: string; bytes: number } | undefined> => {
    if (p === undefined) return undefined;
    const own = m.auxiliary.find((a) => nameOf(a.path) === nameOf(p))?.path;
    for (const at of [p, own]) {
      const st = at === undefined ? undefined : await stat(at).catch(() => undefined);
      if (st?.isFile()) return { at: at as string, bytes: st.size };
    }
    return undefined;
  };
  const draft = await file(flagValue(args, DRAFT_FLAGS));
  const mmproj = await file(flagValue(args, MMPROJ_FLAGS));
  if (!draft && !mmproj) return undefined;
  return {
    ...(draft ? { draft: { bytes: draft.bytes, facts: await readLocalGgufFacts([draft.at]).catch(() => undefined) } } : {}),
    ...(mmproj ? { mmprojBytes: mmproj.bytes } : {}),
  };
}

/** Local library, HF search, VRAM fit and the curated list behind /api/models. */
export class ModelsService {
  readonly hub: HubClient;
  readonly scanner: ModelScanner;
  readonly hashes: HashQueue;
  /** sha256 of local files by path + size + mtime (what the background hashing found). */
  readonly hashCache: HashCache;
  private models: LocalModel[] | undefined;
  private scanning: Promise<LocalModel[]> | undefined;
  private curatedList: Promise<CuratedList> | undefined;

  constructor(private readonly opts: ModelsServiceOptions) {
    const { deps } = opts;
    this.hub = opts.hub ?? new HubClient({ fetch: deps.fetch, baseUrl: deps.endpoints.huggingface, getToken: opts.getToken });
    const hashCache = new HashCache(path.join(deps.paths.cacheDir, 'hashes.json'), deps.platform);
    this.hashCache = hashCache;
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

  /**
   * The folders on the PC holding a copy of a hub repo (a download sidecar, or <owner>/<repo> in the
   * library or LM Studio), with the models in each; HF cache copies have no such folder and never count.
   */
  async repoFolders(repo: string): Promise<{ dir: string; modelIds: string[] }[]> {
    const out = new Map<string, string[]>();
    for (const m of await this.list()) {
      if (m.identity.repo !== repo || !m.repoDir) continue;
      out.set(m.repoDir, [...(out.get(m.repoDir) ?? []), m.id]);
    }
    return [...out].map(([dir, modelIds]) => ({ dir, modelIds }));
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
      if (m.identity.sha256 || m.identity.format !== 'gguf' || m.incomplete) continue;
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
      // The hub tags MLX repos "safetensors" too: vLLM / SGLang cannot read them.
      if (opts.format === 'safetensors' && !m.formats.includes('safetensors')) continue;
      // NInfer: the hub searched "ninfer"; the words typed narrow it here.
      if (opts.format === 'ninfer' && (!m.formats.includes('ninfer') || !matchesWords(m.repo, q))) continue;
      // HF counts parameters its own way (for GGUF, often from one file); cards show ours, so the size filter follows ours.
      if (m.paramsB !== undefined && (m.paramsB < (opts.minParamsB ?? 0) || m.paramsB > (opts.maxParamsB ?? Infinity))) continue;
      const fit = gpu && quickFit(m, gpu, opts.format);
      if (onlyFits && !quickFits(fit)) continue;
      models.push(fit ? { ...m, fit } : m);
    }
    return page.nextCursor ? { models, nextCursor: page.nextCursor } : { models };
  }

  /** What the card holds right now, for the catalog's "other programs" note; null without an NVIDIA GPU. */
  async vramNow(): Promise<VramNow | null> {
    const gpu = await this.opts.gpuInfo();
    if (!gpu) return null;
    return { totalMiB: gpu.totalMiB, freeMiB: gpu.freeMiB, busyMiB: Math.max(0, gpu.totalMiB - gpu.freeMiB - (gpu.ownMiB ?? 0)), reserveMiB: VRAM_RESERVE_MIB };
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
    return (await this.list()).find((m) => m.identity.format === 'gguf' && !m.incomplete && m.identity.repo === repo && m.identity.file === first);
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
    const calibrated = async (model: ModelKey, facts: ModelFactsEx): Promise<{ calibration?: FitCalibration }> => {
      const c = await this.opts.calibration?.({ ...model, ...(facts.architecture ? { architecture: facts.architecture } : {}) }, req.engine).catch(() => undefined);
      return c ? { calibration: c } : {};
    };
    /** The estimate, plus (llama.cpp, when it does not fit entirely) the settings that would: same estimator, other params. */
    const withFixes = (input: Omit<FitInput, 'params'>): FitEstimate => {
      const est = estimateFit({ ...input, params });
      const fixes = fitFixes(req.engine, req.params ?? launchParamsSchema.parse({}), est, (p) => estimateFit({ ...input, params: fitParamsFrom(p) }));
      return fixes ? { ...est, fixes } : est;
    };
    if (req.localId) {
      const m = await this.get(req.localId);
      const facts = m.identity.facts ?? {};
      // A .ninfer artifact: NInfer's own estimate, with what its manifest said (the scanner keeps it in the facts).
      if (m.identity.format === 'ninfer') {
        const manifest = { ...(facts.name ? { name: facts.name } : {}), ...(facts.components ? { components: facts.components } : {}) };
        return ninferFit({ artifactBytes: m.identity.sizeBytes as number, manifest, label: m.identity.displayName, params: req.params, gpu });
      }
      const id = { weakKey: m.identity.weakKey, sha256: m.identity.sha256 };
      const extras = runsSafetensors(req.engine) ? undefined : await launchExtras(req.params?.extraArgs ?? [], m);
      return withFixes({ facts, fileBytes: m.identity.sizeBytes, gpu, engine: req.engine, ...(extras ? { extras } : {}), ...(await calibrated(id, facts)) });
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
      return withFixes({ facts, fileBytes, gpu, engine: req.engine, ...(await calibrated({ weakKey: key }, facts)) });
    }
    if (req.repo) {
      const { facts, fileBytes } = await this.hub.configFacts(req.repo);
      return estimateFit({ facts, fileBytes, gpu, engine: req.engine, params });
    }
    throw new AppError('VALIDATION', 'Fit needs localId, repo + file, or repo');
  }

  /**
   * Fit of every choice of a hub repo for one engine family, and the preselected best one. llama.cpp:
   * each GGUF quant (sub-folders included). vLLM / SGLang: each safetensors variant (a folder with its
   * config.json, judged with its own config), whose `files` are exactly what its download fetches. A
   * repo without that format gives no choices.
   */
  async hubFit(repo: string, engine: EngineKind, opts: { revision?: string; params?: FitRequest['params']; format?: 'ninfer' } = {}): Promise<HubFitResult> {
    const gpu = await this.gpu();
    const [files, info] = await Promise.all([this.hub.files(repo, opts.revision), this.hub.info(repo, opts.revision).catch(() => undefined)]);
    const layout = repoLayout(files, { name: info?.name ?? repo, tags: info?.tags ?? [] });
    if (opts.format === 'ninfer') return this.ninferFit(repo, layout, gpu, opts.params, opts.revision);
    const params = fitParamsFrom(opts.params);
    if (runsSafetensors(engine)) return this.variantsFit(repo, layout.safetensors, gpu, engine, params, opts.revision);
    const ggufWeights = [...layout.gguf.weights].sort((a, b) => a.path.localeCompare(b.path));
    if (ggufWeights.length === 0) return { choices: [], facts: {} };
    const facts = await this.readableFacts(repo, ggufWeights, opts.revision);
    const choices = quantChoices(ggufWeights, facts, gpu, engine, params).map((c) => {
      const first = [...c.files].sort((a, b) => a.path.localeCompare(b.path))[0] as HubFile;
      return { ...c, weakKey: weakKey({ repo, file: first.path, quant: quantFromFilename(path.posix.basename(first.path)), sizeBytes: c.sizeBytes }) };
    });
    const best = pickBest(choices);
    return { choices, facts, ...(best ? { best: best.groupKey } : {}) };
  }

  /**
   * One choice per NInfer artifact, judged by NInfer's own estimate (contract/ninfer.ts ninferFit: the
   * artifact minus the parts a launch leaves on disk, its runtime, its KV pool), with the manifest's
   * facts and, for the facts card, a GGUF of the same repo when there is one.
   */
  private async ninferFit(repo: string, layout: RepoLayout<HubFile>, gpu: GpuMem, params: FitRequest['params'], revision?: string): Promise<HubFitResult> {
    if (layout.ninfer.length === 0) return { choices: [], facts: {} };
    const ggufWeights = [...layout.gguf.weights].sort((a, b) => a.path.localeCompare(b.path));
    const fromGguf = ggufWeights.length > 0 ? await this.readableFacts(repo, ggufWeights, revision).catch(() => undefined) : undefined;
    const choices: HubFitResult['choices'] = [];
    let facts: ModelFactsEx = {};
    for (const a of layout.ninfer) {
      const manifestFile = a.files.find((f) => NINFER_MANIFEST.test(f.path));
      const manifest = manifestFile ? parseNinferManifest(await this.hub.json(repo, manifestFile.path, revision).catch(() => undefined)) : undefined;
      const name = path.posix.basename(a.artifact.path);
      const quant = precisionFromText(name) ?? 'NVFP4';
      const paramsB = paramsFromLabel(repo.split('/')[1]) ?? fromGguf?.paramsB;
      facts = {
        ...(fromGguf ?? {}),
        ...(manifest?.architecture ? { architecture: manifest.architecture } : {}),
        ...(manifest?.name ? { name: manifest.name } : {}),
        ...(manifest?.components.length ? { components: manifest.components } : {}),
        ...(paramsB ? { paramsB } : {}),
        // A GGUF of the same repo says it; else NInfer's models' own (the manifest does not).
        contextLength: trainedContextOf({ format: 'ninfer', facts: fromGguf }),
        quant,
      };
      const fit = ninferFit({ artifactBytes: a.artifact.sizeBytes, manifest, label: `${repo} ${name}`, params, gpu });
      choices.push({
        groupKey: a.artifact.path,
        quant,
        files: a.files,
        sizeBytes: a.sizeBytes,
        fit,
        dir: a.dir,
        ...(manifest ? { manifest } : {}),
        // What the scanner will call the downloaded artifact.
        weakKey: weakKey({ repo, file: name, sizeBytes: a.artifact.sizeBytes }),
      });
    }
    const best = pickBest(choices);
    return { choices, facts, ...(best ? { best: best.groupKey } : {}) };
  }

  /** One choice per safetensors variant, each judged with its own config.json; largest first. */
  private async variantsFit(repo: string, variants: SafetensorsVariant<HubFile>[], gpu: GpuMem, engine: EngineKind, params: FitParams, revision?: string): Promise<HubFitResult> {
    const choices: HubFitResult['choices'] = [];
    let facts: ModelFactsEx | undefined;
    for (const v of variants) {
      // A folder whose config cannot be read is left out; the root model, a gated repo or a rate limit stop here.
      const read = await this.hub.configFacts(repo, revision, v.dir).catch((e: unknown) => {
        if (v.dir === '' || ['HF_GATED', 'HF_AUTH_REQUIRED', 'HF_RATE_LIMITED'].includes((e as AppError).code)) throw e;
        return undefined;
      });
      if (!read) continue;
      facts ??= read.facts;
      const weightsBytes = v.weights.reduce((a, f) => a + f.sizeBytes, 0);
      const precision = read.precision ?? v.precision;
      const fit = estimateFit({ facts: { ...read.facts, ...(precision ? { quant: precision } : {}) }, fileBytes: weightsBytes, gpu, engine, params });
      choices.push({
        groupKey: v.dir === '' ? '*weights' : `${v.dir}/*`,
        ...(precision ? { quant: precision } : {}),
        files: v.files,
        sizeBytes: v.sizeBytes,
        fit,
        dir: v.dir,
        // What the scanner will call the downloaded folder: first weights file, weights bytes, no quant.
        weakKey: weakKey({ repo, file: path.posix.basename((v.weights[0] as HubFile).path), sizeBytes: weightsBytes }),
      });
    }
    choices.sort((a, b) => b.sizeBytes - a.sizeBytes);
    const best = pickBest(choices);
    return { choices, facts: facts ?? {}, ...(best ? { best: best.groupKey } : {}) };
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

/** Every word of `q` is in `text` (case-insensitive); an empty `q` matches everything. */
export function matchesWords(text: string, q: string): boolean {
  const t = text.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => t.includes(w));
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
