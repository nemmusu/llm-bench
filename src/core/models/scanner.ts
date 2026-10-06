import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { LocalModel } from '../../contract/models';
import type { Settings } from '../../contract/settings';
import type { Logger, Platform } from '../deps';
import { readJsonFile, writeFileAtomic } from '../store/atomic';
import { readLocalGgufFacts } from './gguf';
import type { HashCache } from './hash';
import { weakKey } from './hash';
import { factsFromHfConfig, safetensorsParamCount } from './hf-config';
import { fileKey, modelIdFor, normalizePath, parseShard, REPO_RE } from './paths';
import { quantFromFilename } from './quant';
import type { ModelFactsEx } from './types';

export type Origin = LocalModel['origin'];
type AuxKind = LocalModel['auxiliary'][number]['kind'];

export interface ScanRoot {
  dir: string;
  origin: Origin;
  maxDepth: number;
}

export interface ScannerOptions {
  platform: Platform;
  home: string;
  env: Record<string, string | undefined>;
  /** deps.paths.modelsDir, used when settings.modelsDir is empty. */
  defaultModelsDir: string;
  cacheDir: string;
  log: Logger;
  settings: () => Promise<Pick<Settings, 'modelsDir' | 'extraModelDirs' | 'scanKnownLocations'>>;
  hashCache?: HashCache;
  readGgufFacts?: (paths: string[]) => Promise<ModelFactsEx>;
  /** Directory entries examined per scan, over all roots (bounds time on huge folders). */
  maxEntries?: number;
  /** Replaces knownLocations() (tests must not walk the developer's real model folders). */
  knownRoots?: ScanRoot[];
}

/** Sidecar written by the downloader next to downloaded repos. */
export const DOWNLOAD_SIDECAR = '.gpubench-download.json';
export interface DownloadSidecar {
  repo: string;
  revision?: string;
  files: Record<string, { sha256?: string; sizeBytes?: number }>;
}

/** Bump when the facts extraction changes, so cached facts are recomputed. */
const FACTS_VERSION = 3;
const FACTS_CACHE_FILE = 'model-facts.json';
const SHA_RE = /^[0-9a-f]{64}$/;
const SKIP_DIRS = new Set(['node_modules', '$recycle.bin', 'system volume information']);
const OLLAMA_MODEL = 'application/vnd.ollama.image.model';
const OLLAMA_PROJECTOR = 'application/vnd.ollama.image.projector';

/** Folders other apps use for models: C:\models, ~/models, LM Studio, HF cache, Ollama. */
export function knownLocations(platform: Platform, home: string, env: Record<string, string | undefined>): ScanRoot[] {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const roots: ScanRoot[] = [];
  if (platform === 'win32') roots.push({ dir: p.join(env.SystemDrive ?? 'C:', '\\models'), origin: 'custom', maxDepth: 4 });
  roots.push({ dir: p.join(home, 'models'), origin: 'custom', maxDepth: 4 });
  roots.push({ dir: p.join(home, '.lmstudio', 'models'), origin: 'lmstudio', maxDepth: 4 });
  roots.push({ dir: p.join(home, '.cache', 'lm-studio', 'models'), origin: 'lmstudio', maxDepth: 4 });
  const hfHome = env.HF_HOME ?? p.join(home, '.cache', 'huggingface');
  roots.push({ dir: env.HF_HUB_CACHE ?? env.HUGGINGFACE_HUB_CACHE ?? p.join(hfHome, 'hub'), origin: 'hf-cache', maxDepth: 6 });
  roots.push({ dir: env.OLLAMA_MODELS ?? p.join(home, '.ollama', 'models'), origin: 'ollama', maxDepth: 4 });
  // Linux installs run Ollama as a system service with its own home.
  if (platform === 'linux') roots.push({ dir: '/usr/share/ollama/.ollama/models', origin: 'ollama', maxDepth: 4 });
  return roots;
}

/** Auxiliary role of a GGUF file from its name (never listed as a standalone model). */
export function auxKindOf(name: string): AuxKind | undefined {
  const n = name.toLowerCase();
  if (n.includes('mmproj')) return 'mmproj';
  if (/(^|[-_.])mtp([-_.]|$)/.test(n)) return 'mtp';
  if (/(^|[-_.])(draft|eagle\d*)([-_.]|$)/.test(n)) return 'draft';
  return undefined;
}

/** Words of a name that identify the model, without role markers and quant label. */
function stemOf(name: string): string {
  let n = name.toLowerCase().replace(/\.gguf$/, '');
  const quant = quantFromFilename(name)?.toLowerCase();
  if (quant) n = n.replace(quant, ' ');
  n = n.replace(/mmproj|mtp|draft|eagle\d*/g, ' ');
  return n.replace(/[-_. ]+/g, ' ').trim();
}

interface FileInfo {
  name: string;
  path: string;
  size: number;
  mtimeMs: number;
  symlink: boolean;
}

interface DirListing {
  dir: string;
  files: FileInfo[];
}

interface FactsCacheFile {
  version: number;
  entries: Record<string, ModelFactsEx>;
}

interface ScanState {
  budget: number;
  seenDirs: Set<string>;
  facts: Record<string, ModelFactsEx>;
  usedFacts: Record<string, ModelFactsEx>;
  factsChanged: boolean;
}

interface GgufMain {
  files: FileInfo[];
  aux: { kind: AuxKind; path: string }[];
  facts?: ModelFactsEx;
}

/** Finds local models: GGUF files (grouped shards + auxiliaries), safetensors folders, Ollama blobs. */
export class ModelScanner {
  private readonly readFacts: (paths: string[]) => Promise<ModelFactsEx>;
  private readonly maxEntries: number;

  constructor(private readonly opts: ScannerOptions) {
    this.readFacts = opts.readGgufFacts ?? readLocalGgufFacts;
    this.maxEntries = opts.maxEntries ?? 50_000;
  }

  /** The library folder downloads go to (settings.modelsDir or the default). */
  async libraryDir(): Promise<string> {
    const s = await this.opts.settings();
    return s.modelsDir || this.opts.defaultModelsDir;
  }

  async roots(): Promise<ScanRoot[]> {
    const s = await this.opts.settings();
    const all: ScanRoot[] = [
      { dir: s.modelsDir || this.opts.defaultModelsDir, origin: 'library', maxDepth: 5 },
      ...s.extraModelDirs.map((dir) => ({ dir, origin: 'custom' as const, maxDepth: 6 })),
      ...(s.scanKnownLocations ? (this.opts.knownRoots ?? knownLocations(this.opts.platform, this.opts.home, this.opts.env)) : []),
    ];
    const seen = new Set<string>();
    return all.filter((r) => {
      const key = normalizePath(r.dir, this.opts.platform);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async scan(): Promise<LocalModel[]> {
    const state: ScanState = { budget: this.maxEntries, seenDirs: new Set(), facts: await this.loadFactsCache(), usedFacts: {}, factsChanged: false };
    const out: LocalModel[] = [];
    // Folders are visited once (by real path) over all roots, so a model is never listed twice.
    for (const root of await this.roots()) {
      out.push(...(root.origin === 'ollama' ? await this.scanOllama(root, state) : await this.scanRoot(root, state)));
    }
    if (state.budget <= 0) this.opts.log.warn('model scan stopped early: too many files', { maxEntries: this.maxEntries });
    const unused = Object.keys(state.facts).some((k) => !(k in state.usedFacts));
    if (state.factsChanged || unused) await this.saveFactsCache(state.usedFacts);
    return out;
  }

  // ---- directory walking ----------------------------------------------------------------------

  /** Depth-limited walk. Symlinked dirs are followed once (realpath set), so loops terminate. */
  private async walk(root: ScanRoot, state: ScanState, keep: (name: string) => boolean): Promise<DirListing[]> {
    const listings: DirListing[] = [];
    const stack: { dir: string; depth: number }[] = [{ dir: root.dir, depth: 0 }];
    while (stack.length > 0 && state.budget > 0) {
      const { dir, depth } = stack.pop() as { dir: string; depth: number };
      // Missing roots fail realpath; a root that is a file fails readdir. Both are skipped.
      const real = await maybe(realpath(dir));
      const entries = real === undefined ? undefined : await maybe(readdir(dir, { withFileTypes: true }));
      if (!entries) continue;
      const key = normalizePath(real as string, this.opts.platform);
      if (state.seenDirs.has(key)) continue;
      state.seenDirs.add(key);
      const files: FileInfo[] = [];
      for (const e of entries) {
        if (--state.budget < 0) break;
        const full = path.join(dir, e.name);
        const st = await maybe(stat(full));
        if (!st) continue;
        if (st.isDirectory()) {
          if (depth < root.maxDepth && !this.skipDir(e.name, root.origin)) stack.push({ dir: full, depth: depth + 1 });
        } else if (keep(e.name)) {
          files.push({ name: e.name, path: full, size: st.size, mtimeMs: st.mtimeMs, symlink: e.isSymbolicLink() });
        }
      }
      listings.push({ dir, files });
    }
    return listings;
  }

  private skipDir(name: string, origin: Origin): boolean {
    if (name.startsWith('.') || SKIP_DIRS.has(name.toLowerCase())) return true;
    // HF cache: blobs are reached through snapshots; datasets and spaces hold no models.
    return origin === 'hf-cache' && (name === 'blobs' || name.startsWith('datasets--') || name.startsWith('spaces--'));
  }

  // ---- GGUF + safetensors roots ---------------------------------------------------------------

  private async scanRoot(root: ScanRoot, state: ScanState): Promise<LocalModel[]> {
    const listings = await this.walk(root, state, (n) => /\.(gguf|safetensors)$/i.test(n) || n === 'config.json' || n.endsWith('.safetensors.index.json'));
    const out: LocalModel[] = [];
    const mainsByDir = new Map<string, GgufMain[]>();
    const orphans: { dir: string; aux: { kind: AuxKind; path: string }[] }[] = [];
    for (const l of listings) {
      const { mains, orphanAux } = await this.ggufInDir(l, state);
      mainsByDir.set(normalizePath(l.dir, this.opts.platform), mains);
      if (orphanAux.length > 0) orphans.push({ dir: l.dir, aux: orphanAux });
    }
    // Auxiliaries alone in a sub-folder (e.g. "MTP/") belong to the models one level up.
    for (const o of orphans) {
      for (const m of mainsByDir.get(normalizePath(path.dirname(o.dir), this.opts.platform)) ?? []) m.aux.push(...o.aux);
    }
    for (const l of listings) {
      for (const m of mainsByDir.get(normalizePath(l.dir, this.opts.platform)) as GgufMain[]) out.push(await this.ggufModel(root, l.dir, m));
      const st = await this.safetensorsModel(root, l, state);
      if (st) out.push(st);
    }
    return out;
  }

  /** Groups one folder's GGUF files into models (complete split sets) and attaches auxiliaries. */
  private async ggufInDir(l: DirListing, state: ScanState): Promise<{ mains: GgufMain[]; orphanAux: { kind: AuxKind; path: string }[] }> {
    const auxFiles: { kind: AuxKind; file: FileInfo }[] = [];
    const singles: FileInfo[] = [];
    const shardSets = new Map<string, FileInfo[]>();
    for (const f of l.files) {
      if (!f.name.toLowerCase().endsWith('.gguf')) continue;
      const kind = auxKindOf(f.name);
      if (kind) {
        auxFiles.push({ kind, file: f });
        continue;
      }
      const shard = parseShard(f.name);
      if (!shard) singles.push(f);
      else shardSets.set(`${shard.prefix}|${shard.total}`, [...(shardSets.get(`${shard.prefix}|${shard.total}`) ?? []), f]);
    }
    const groups: FileInfo[][] = singles.map((f) => [f]);
    for (const set of shardSets.values()) {
      const total = (parseShard(set[0]!.name) as { total: number }).total;
      const sorted = [...set].sort((a, b) => a.name.localeCompare(b.name));
      // A partial split set cannot be loaded: skip it until every shard is there.
      if (sorted.length === total && sorted.every((f, i) => (parseShard(f.name) as { index: number }).index === i + 1)) groups.push(sorted);
      else this.opts.log.debug('incomplete split GGUF skipped', { dir: l.dir, have: sorted.length, total });
    }
    let mains: GgufMain[] = [];
    for (const files of groups) mains.push({ files, aux: [], facts: await this.cachedFacts(files, state) });
    // mmproj files without "mmproj" in the name still declare architecture "clip".
    for (const m of mains.filter((x) => x.facts?.architecture === 'clip')) auxFiles.push({ kind: 'mmproj', file: m.files[0] as FileInfo });
    mains = mains.filter((x) => x.facts?.architecture !== 'clip');
    const orphanAux: { kind: AuxKind; path: string }[] = [];
    for (const a of auxFiles) {
      const stem = stemOf(a.file.name);
      const matching = stem.length >= 3 ? mains.filter((m) => stemOf((m.files[0] as FileInfo).name).includes(stem)) : [];
      const targets = matching.length > 0 ? matching : mains;
      if (targets.length === 0) orphanAux.push({ kind: a.kind, path: a.file.path });
      for (const t of targets) t.aux.push({ kind: a.kind, path: a.file.path });
    }
    return { mains, orphanAux };
  }

  private async cachedFacts(files: FileInfo[], state: ScanState): Promise<ModelFactsEx | undefined> {
    const main = files[0] as FileInfo;
    const size = files.reduce((a, f) => a + f.size, 0);
    const key = `${fileKey(main.path, size, Math.max(...files.map((f) => f.mtimeMs)), this.opts.platform)}`;
    let facts: ModelFactsEx | undefined = state.facts[key];
    if (!facts) {
      try {
        facts = await this.readFacts(files.map((f) => f.path));
      } catch (e) {
        this.opts.log.warn('cannot read model metadata', { path: main.path, error: (e as Error).message });
        return undefined;
      }
      state.factsChanged = true;
    }
    state.usedFacts[key] = facts;
    return facts;
  }

  private async ggufModel(root: ScanRoot, dir: string, m: GgufMain): Promise<LocalModel> {
    const main = m.files[0] as FileInfo;
    const sizeBytes = m.files.reduce((a, f) => a + f.size, 0);
    const mtime = Math.max(...m.files.map((f) => f.mtimeMs));
    const src = await this.sourceOf(root, dir);
    const sha256 = await this.sha256Of(root, src, main);
    const quant = quantFromFilename(main.name) ?? m.facts?.quant;
    const shard = parseShard(main.name);
    const displayName = shard ? shard.prefix : main.name.replace(/\.gguf$/i, '');
    const identity: LocalModel['identity'] = {
      displayName,
      format: 'gguf',
      source: src.repo ? 'hf' : 'local',
      file: main.name,
      files: m.files.map((f) => f.name),
      sizeBytes,
      // The weak key uses the file-name quant only, exactly like the hub side (see weakKey()).
      weakKey: weakKey({ repo: src.repo, file: main.name, quant: quantFromFilename(main.name), sizeBytes }),
      path: main.path,
    };
    const revision = src.revision ?? sha256.revision;
    if (src.repo) identity.repo = src.repo;
    if (revision) identity.revision = revision;
    if (quant) identity.quant = quant;
    if (sha256.sha) identity.sha256 = sha256.sha;
    if (m.facts) identity.facts = m.facts;
    return {
      id: modelIdFor(main.path, this.opts.platform),
      identity,
      paths: [...m.files.map((f) => f.path), ...m.aux.map((a) => a.path)],
      auxiliary: m.aux,
      dir,
      origin: root.origin,
      modifiedAt: new Date(mtime).toISOString(),
    };
  }

  /** A folder with config.json + *.safetensors is a transformers checkpoint vLLM can load. */
  private async safetensorsModel(root: ScanRoot, l: DirListing, state: ScanState): Promise<LocalModel | undefined> {
    const config = l.files.find((f) => f.name === 'config.json');
    const weights = l.files.filter((f) => f.name.toLowerCase().endsWith('.safetensors')).sort((a, b) => a.name.localeCompare(b.name));
    if (!config || weights.length === 0) return undefined;
    // Sharded checkpoints list their shards in the index: a partial download is not a model yet.
    const index = l.files.find((f) => f.name.endsWith('.safetensors.index.json'));
    if (index) {
      const raw = (await maybe(readJsonFile(index.path))) as { weight_map?: Record<string, string> } | undefined;
      const needed = new Set(Object.values(raw?.weight_map ?? {}));
      const have = new Set(weights.map((w) => w.name));
      if (needed.size === 0 || [...needed].some((n) => !have.has(n))) {
        this.opts.log.debug('incomplete safetensors model skipped', { dir: l.dir });
        return undefined;
      }
    }
    const src = await this.sourceOf(root, l.dir);
    const sizeBytes = weights.reduce((a, f) => a + f.size, 0);
    const mtime = Math.max(config.mtimeMs, ...weights.map((f) => f.mtimeMs));
    const key = `${fileKey(config.path, sizeBytes, mtime, this.opts.platform)}`;
    let facts: ModelFactsEx | undefined = state.facts[key];
    if (!facts) {
      try {
        const raw = JSON.parse(await readFile(config.path, 'utf8')) as Record<string, unknown>;
        // Quantized checkpoints pack several weights per element: header shapes would undercount.
        const params = raw.quantization_config ? undefined : await safetensorsParamCount(weights.map((w) => w.path));
        facts = factsFromHfConfig(raw, { name: src.repo ?? path.basename(l.dir), parameterCount: params, fileBytes: sizeBytes });
        state.factsChanged = true;
      } catch (e) {
        this.opts.log.warn('cannot read safetensors model', { dir: l.dir, error: (e as Error).message });
        return undefined;
      }
    }
    state.usedFacts[key] = facts;
    const identity: LocalModel['identity'] = {
      displayName: src.repo ?? path.basename(l.dir),
      format: 'safetensors',
      source: src.repo ? 'hf' : 'local',
      file: (weights[0] as FileInfo).name,
      files: weights.map((w) => w.name),
      sizeBytes,
      weakKey: weakKey({ repo: src.repo, file: (weights[0] as FileInfo).name, sizeBytes }),
      path: l.dir,
      facts,
    };
    if (src.repo) identity.repo = src.repo;
    if (src.revision) identity.revision = src.revision;
    if (facts.quant) identity.quant = facts.quant;
    return {
      id: modelIdFor(l.dir, this.opts.platform),
      identity,
      paths: [...weights.map((w) => w.path), config.path],
      auxiliary: [],
      dir: l.dir,
      origin: root.origin,
      modifiedAt: new Date(mtime).toISOString(),
    };
  }

  /** Repo / revision implied by where a folder lives (library & LM Studio: owner/name; HF cache). */
  private async sourceOf(root: ScanRoot, dir: string): Promise<{ repo?: string; revision?: string; sidecar?: DownloadSidecar; repoDir?: string }> {
    const segs = path.relative(root.dir, dir).split(/[\\/]/).filter(Boolean);
    if (root.origin === 'hf-cache') {
      const i = segs.findIndex((s) => s.startsWith('models--'));
      const parts = (segs[i] ?? '').slice('models--'.length).split('--');
      const repo = `${parts[0]}/${parts.slice(1).join('--')}`;
      const out: { repo?: string; revision?: string } = {};
      if (i >= 0 && REPO_RE.test(repo)) out.repo = repo;
      if (segs[i + 1] === 'snapshots' && segs[i + 2]) out.revision = segs[i + 2];
      return out;
    }
    if ((root.origin === 'library' || root.origin === 'lmstudio') && segs.length >= 2) {
      const repo = `${segs[0]}/${segs[1]}`;
      if (!REPO_RE.test(repo)) return {};
      const repoDir = path.join(root.dir, segs[0] as string, segs[1] as string);
      const sidecar = await readSidecar(repoDir);
      return { repo, repoDir, ...(sidecar ? { sidecar } : {}), ...(sidecar?.revision ? { revision: sidecar.revision } : {}) };
    }
    return {};
  }

  /** sha256 without hashing: HF cache blob names, our sidecar, HF --local-dir metadata, hash cache. */
  private async sha256Of(root: ScanRoot, src: { sidecar?: DownloadSidecar; repoDir?: string }, f: FileInfo): Promise<{ sha?: string; revision?: string }> {
    if (f.symlink) {
      const blob = path.basename(await realpath(f.path));
      if (SHA_RE.test(blob)) return { sha: blob };
    }
    if (src.sidecar && src.repoDir) {
      const rel = path.relative(src.repoDir, f.path).split(path.sep).join('/');
      const entry = src.sidecar.files[rel];
      if (entry?.sha256 && SHA_RE.test(entry.sha256) && (entry.sizeBytes === undefined || entry.sizeBytes === f.size)) return { sha: entry.sha256 };
    }
    const meta = await this.localDirMetadata(root, f);
    if (meta) return meta;
    const cached = await this.opts.hashCache?.get(f.path, f.size, f.mtimeMs);
    return cached ? { sha: cached } : {};
  }

  /**
   * `huggingface-cli download --local-dir` stores `<local_dir>/.cache/huggingface/download/<rel>.metadata`:
   * commit sha, etag (= sha256 for LFS files) and timestamp. Valid only if the file is not newer.
   */
  private async localDirMetadata(root: ScanRoot, f: FileInfo): Promise<{ sha?: string; revision?: string } | undefined> {
    let dir = path.dirname(f.path);
    for (let up = 0; up < 3; up++) {
      const rel = path.relative(dir, f.path).split(path.sep).join('/');
      const metaFile = path.join(dir, '.cache', 'huggingface', 'download', `${rel}.metadata`);
      const text = await maybe(readFile(metaFile, 'utf8'));
      if (text !== undefined) {
        const [commit, etag, ts] = text.split(/\r?\n/);
        if (!etag || !SHA_RE.test(etag) || Number(ts) < f.mtimeMs / 1000 - 1) return undefined;
        return { sha: etag, ...(commit && /^[0-9a-f]{40}$/.test(commit) ? { revision: commit } : {}) };
      }
      if (normalizePath(dir, this.opts.platform) === normalizePath(root.dir, this.opts.platform)) break;
      dir = path.dirname(dir);
    }
    return undefined;
  }

  // ---- Ollama -----------------------------------------------------------------------------------

  /** Ollama: manifests/<host>/<namespace>/<model>/<tag> list content-addressed GGUF blobs. */
  private async scanOllama(root: ScanRoot, state: ScanState): Promise<LocalModel[]> {
    const manifestsDir = path.join(root.dir, 'manifests');
    const listings = await this.walk({ ...root, dir: manifestsDir }, state, () => true);
    const out: LocalModel[] = [];
    for (const f of listings.flatMap((l) => l.files)) {
      const segs = path.relative(manifestsDir, f.path).split(/[\\/]/);
      if (segs.length !== 4) continue;
      const [host, ns, name, tag] = segs as [string, string, string, string];
      const layers = await readJsonFile(f.path)
        .then((j) => (Array.isArray((j as { layers?: unknown }).layers) ? ((j as { layers: { mediaType?: string; digest?: string }[] }).layers) : []))
        .catch(() => []);
      const blobOf = async (mediaType: string) => {
        const digest = layers.find((x) => x.mediaType === mediaType)?.digest ?? '';
        const hex = /^sha256:([0-9a-f]{64})$/.exec(digest)?.[1];
        if (!hex) return undefined;
        const p = path.join(root.dir, 'blobs', `sha256-${hex}`);
        const st = await maybe(stat(p));
        return st ? { hex, path: p, size: st.size, mtimeMs: st.mtimeMs } : undefined;
      };
      const model = await blobOf(OLLAMA_MODEL);
      if (!model) continue;
      const projector = await blobOf(OLLAMA_PROJECTOR);
      const blobInfo: FileInfo = { name: path.basename(model.path), path: model.path, size: model.size, mtimeMs: model.mtimeMs, symlink: false };
      const facts = await this.cachedFacts([blobInfo], state);
      const hf = host === 'hf.co' || host === 'huggingface.co';
      const repo = hf && REPO_RE.test(`${ns}/${name}`) ? `${ns}/${name}` : undefined;
      let displayName = `${name}:${tag}`;
      if (host !== 'registry.ollama.ai') displayName = `${host}/${ns}/${name}:${tag}`;
      else if (ns !== 'library') displayName = `${ns}/${name}:${tag}`;
      const quant = quantFromFilename(tag) ?? facts?.quant;
      const identity: LocalModel['identity'] = {
        displayName,
        format: 'gguf',
        source: repo ? 'hf' : 'local',
        file: blobInfo.name,
        files: [blobInfo.name],
        sizeBytes: model.size,
        sha256: model.hex,
        weakKey: weakKey({ repo, file: blobInfo.name, quant: quantFromFilename(tag), sizeBytes: model.size }),
        path: model.path,
      };
      if (repo) identity.repo = repo;
      if (quant) identity.quant = quant;
      if (facts) identity.facts = facts;
      const aux = projector ? [{ kind: 'mmproj' as const, path: projector.path }] : [];
      out.push({
        // One blob can back several tags: the manifest is what identifies a model here.
        id: modelIdFor(f.path, this.opts.platform),
        identity,
        paths: [model.path, ...aux.map((a) => a.path)],
        auxiliary: aux,
        dir: path.dirname(model.path),
        origin: 'ollama',
        modifiedAt: new Date(Math.max(model.mtimeMs, f.mtimeMs)).toISOString(),
      });
    }
    return out;
  }

  // ---- facts cache ------------------------------------------------------------------------------

  private get factsCacheFile(): string {
    return path.join(this.opts.cacheDir, FACTS_CACHE_FILE);
  }

  private async loadFactsCache(): Promise<Record<string, ModelFactsEx>> {
    const raw = (await maybe(readJsonFile(this.factsCacheFile))) as Partial<FactsCacheFile> | undefined;
    if (raw?.version !== FACTS_VERSION || typeof raw.entries !== 'object' || raw.entries === null) return {};
    return raw.entries;
  }

  private async saveFactsCache(entries: Record<string, ModelFactsEx>): Promise<void> {
    const data: FactsCacheFile = { version: FACTS_VERSION, entries };
    await writeFileAtomic(this.factsCacheFile, JSON.stringify(data)).catch((e: unknown) => {
      this.opts.log.warn('cannot write model facts cache', { error: (e as Error).message });
    });
  }
}

/** Resolves to undefined instead of rejecting (missing files, races with deletes). */
function maybe<T>(p: Promise<T>): Promise<T | undefined> {
  return p.catch(() => undefined);
}

export async function readSidecar(repoDir: string): Promise<DownloadSidecar | undefined> {
  const raw = (await maybe(readJsonFile(path.join(repoDir, DOWNLOAD_SIDECAR)))) as Partial<DownloadSidecar> | undefined;
  if (!raw || typeof raw.repo !== 'string' || typeof raw.files !== 'object' || raw.files === null) return undefined;
  return raw as DownloadSidecar;
}
