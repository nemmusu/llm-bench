/**
 * Model formats of a repo or a folder, told apart the way people think of them:
 *  - GGUF, run by llama.cpp: every .gguf file, in the root or in a sub-folder ("GGUF/");
 *  - safetensors, run by vLLM / SGLang: each folder with a config.json and its weights is one
 *    model (a "variant": "FP8/", "INT4/W4A16/"), downloaded whole and nothing else;
 *  - NInfer (a C++/CUDA engine for Qwen3.5–3.8 on one RTX 5090): each .ninfer artifact, downloaded with
 *    its manifest and SHA256SUMS;
 *  - other formats (MLX, ONNX, EXL2, LoRA adapters…): shown, never downloaded as a model.
 * Pure: the core (hub listings, downloads, the scanner) and the renderer (catalog, model page) share it.
 */

/** A repo file as the layout needs it (HubFile, contract/models.ts, fits). */
export interface RepoFile {
  path: string;
  sizeBytes: number;
  kind: 'weights' | 'mmproj' | 'mtp' | 'draft' | 'config' | 'tokenizer' | 'other';
}

/** Precisions of safetensors weights, as the badges name them. */
export const PRECISIONS = ['NVFP4', 'MXFP4', 'FP8', 'INT8', 'AWQ', 'GPTQ', 'INT4', 'BF16', 'FP16', 'FP32'] as const;
export type Precision = (typeof PRECISIONS)[number];

const word = (w: string) => new RegExp(`(^|[^a-z0-9])${w}([^a-z0-9]|$)`, 'i');

/** Name tokens of a precision, most specific first ("W4A16" before "FP16", "NVFP4" before "FP4"). */
const PRECISION_WORDS: [RegExp, Precision][] = [
  [/nvfp4/i, 'NVFP4'],
  [/mxfp4/i, 'MXFP4'],
  [word('awq'), 'AWQ'],
  [/gptq/i, 'GPTQ'],
  [/w4a(16|8)|int4|4-?bit|bnb|nf4/i, 'INT4'],
  [/fp8|f8[-_]?e4m3|w8a8[-_]?fp8/i, 'FP8'],
  [/w8a(16|8)|int8|8-?bit/i, 'INT8'],
  [word('bf16'), 'BF16'],
  [word('(fp16|f16)'), 'FP16'],
  [word('(fp32|f32)'), 'FP32'],
];

/** The precision named in a repo name, folder or tag list ("Qwen3-8B-FP8", "INT4/W4A16", tag "awq"); undefined when none is. */
export function precisionFromText(...texts: readonly string[]): Precision | undefined {
  const text = texts.join(' ');
  return PRECISION_WORDS.find(([re]) => re.test(text))?.[1];
}

/**
 * The precision of the hub's safetensors parameter counts by dtype (search results' `safetensors.parameters`):
 * the dtype holding most parameters decides. Packed 4-bit weights travel as I32 (AWQ/GPTQ) or U8 (FP4 blocks).
 */
export function precisionFromDtypes(dtypes: Record<string, number> | undefined): Precision | undefined {
  const entries = Object.entries(dtypes ?? {}).filter(([, n]) => n > 0);
  if (entries.length === 0) return undefined;
  const [top] = entries.sort((a, b) => b[1] - a[1])[0] as [string, number];
  const has = (d: string) => entries.some(([k]) => k === d);
  if (top.startsWith('F8')) return 'FP8';
  if (top === 'U8') return has('F8_E4M3') ? 'NVFP4' : 'MXFP4';
  if (top === 'I32' || top === 'I4') return 'INT4';
  if (top === 'I8') return 'INT8';
  if (top === 'BF16') return 'BF16';
  if (top === 'F16') return 'FP16';
  return top === 'F32' ? 'FP32' : undefined;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/**
 * The precision a transformers config.json declares: its quantization_config (fp8, awq, gptq,
 * compressed-tensors, modelopt, mxfp4, bitsandbytes) or, unquantized, its torch_dtype.
 */
export function precisionFromConfig(config: unknown): Precision | undefined {
  const c = obj(config) ?? {};
  const q = obj(c.quantization_config);
  if (q) {
    const method = String(q.quant_method ?? '').toLowerCase();
    const named = precisionFromText(String(q.quant_algo ?? ''), String(q.format ?? ''));
    if (method === 'awq') return 'AWQ';
    if (method === 'gptq') return 'GPTQ';
    if (method === 'fp8' || method === 'fbgemm_fp8') return 'FP8';
    if (method === 'mxfp4') return 'MXFP4';
    if (method === 'bitsandbytes') return q.load_in_8bit === true ? 'INT8' : 'INT4';
    if (named) return named;
    // compressed-tensors: the bits and type of the first weights group.
    const group = Object.values(obj(q.config_groups) ?? {}).map(obj)[0];
    const weights = obj(group?.weights);
    if (weights?.num_bits === 4) return 'INT4';
    if (weights?.num_bits === 8) return weights.type === 'float' ? 'FP8' : 'INT8';
    return undefined;
  }
  const dtype = String(c.torch_dtype ?? c.dtype ?? '');
  return ({ bfloat16: 'BF16', float16: 'FP16', float32: 'FP32' } as Record<string, Precision>)[dtype];
}

/** Formats LLM Bench cannot run, by folder name or file extension. */
const OTHER_DIRS: [RegExp, string][] = [
  [word('mlx'), 'MLX'],
  [/onnx/i, 'ONNX'],
  [/openvino/i, 'OpenVINO'],
  [/coreml/i, 'Core ML'],
  [word('exl[23]'), 'EXL2'],
  [/tensorrt|(^|[^a-z])trt([^a-z]|$)/i, 'TensorRT'],
  [/^original$/i, 'PyTorch'],
];
const OTHER_EXTS: [RegExp, string][] = [
  [/\.(onnx|onnx_data|ort)$/i, 'ONNX'],
  [/\.(mlmodel|mlpackage)$/i, 'Core ML'],
  [/\.tflite$/i, 'TFLite'],
  [/\.pte$/i, 'ExecuTorch'],
  [/\.(engine|plan)$/i, 'TensorRT'],
  [/\.npz$/i, 'MLX'],
  [/\.(pth|pt)$/i, 'PyTorch'],
  [/\.(h5|keras)$/i, 'Keras'],
  [/\.msgpack$/i, 'Flax'],
];

/**
 * The other format a repo file belongs to ("mlx/model.safetensors" → MLX, "model.onnx" → ONNX,
 * "original/consolidated.pth" → PyTorch); undefined for GGUF, safetensors, NInfer and plain files.
 * A .gguf or .ninfer file is always its own format, whatever its folder.
 */
export function otherFormatOf(path: string): string | undefined {
  if (/\.(gguf|ninfer)$/i.test(path)) return undefined;
  const segs = path.split('/');
  for (const dir of segs.slice(0, -1)) {
    const hit = OTHER_DIRS.find(([re]) => re.test(dir));
    if (hit) return hit[1];
  }
  return OTHER_EXTS.find(([re]) => re.test(segs.at(-1) as string))?.[1];
}

/** Hub tags of formats LLM Bench cannot run. */
const OTHER_TAGS: Record<string, string> = { mlx: 'MLX', onnx: 'ONNX', openvino: 'OpenVINO', coreml: 'Core ML', exl2: 'EXL2', exl3: 'EXL2', tflite: 'TFLite', executorch: 'ExecuTorch', peft: 'LoRA' };

/** NInfer artifact files: the model, its manifest and its checksums ("<Repo>.artifact-manifest.json", "<Repo>.SHA256SUMS"). */
export const NINFER_FILE = /\.ninfer$/i;
export const NINFER_MANIFEST = /\.artifact-manifest\.json$/i;
export const NINFER_SUMS = /\.sha256sums$/i;

/** The .ninfer container version NInfer reads. */
export const NINFER_CONTAINER_VERSION = 3;

/** What an NInfer artifact manifest says ("<Repo>.artifact-manifest.json", its `artifact` object). */
export interface NinferManifest {
  filename?: string;
  bytes?: number;
  sha256?: string;
  containerVersion?: number;
  architecture?: string;
  name?: string;
  /** Parts packed in the artifact: "text", "vision", "mtp", "dflash2". */
  components: string[];
}

/** The manifest's `artifact` object, leniently: unknown or malformed fields are left out. */
export function parseNinferManifest(raw: unknown): NinferManifest | undefined {
  const a = obj(obj(raw)?.artifact);
  if (!a) return undefined;
  const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const out: NinferManifest = { components: Array.isArray(a.components) ? a.components.filter((c): c is string => typeof c === 'string') : [] };
  const set = <K extends keyof NinferManifest>(k: K, v: NinferManifest[K] | undefined) => {
    if (v !== undefined) out[k] = v;
  };
  set('filename', str(a.filename));
  set('bytes', num(a.bytes));
  set('sha256', str(a.sha256)?.toLowerCase());
  set('containerVersion', num(a.container_version));
  set('architecture', str(a.architecture));
  set('name', str(a.name));
  return out;
}

/**
 * What an artifact without a manifest tells by its name alone: the text model, plus the speculative
 * heads its name announces ("…-Q6_K-MTP.ninfer": MTP; "DFlash2", "DFlash"). Vision is never assumed.
 */
export function ninferManifestFromName(fileName: string): NinferManifest {
  const name = fileName.replace(/^.*[\\/]/, '');
  const has = (re: RegExp) => re.test(name);
  const components = ['text', ...(has(/(^|[^a-z])mtp([^a-z]|$)/i) ? ['mtp'] : []), ...(has(/dflash-?2/i) ? ['dflash2'] : has(/dflash/i) ? ['dflash'] : [])];
  return { components };
}

/** "<sha256>  <file>" lines of a SHA256SUMS file, by file name (a leading "*" or "./" is dropped); none without a file. */
export function parseSha256Sums(text: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of (text ?? '').split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(?:\.\/)?(.+?)\s*$/.exec(line);
    if (m) out.set(m[2] as string, (m[1] as string).toLowerCase());
  }
  return out;
}

/** A repo or file name that says NInfer ("Qwen3.8-27B-nvfp4-NInfer", "…-GGUF-NInfer"). */
export function namesNinfer(name: string): boolean {
  return word('ninfer').test(name);
}

/** Other formats a search result announces in its tags or name ("…-MLX-4bit", "…-ONNX"), sorted, without repeats. */
export function otherFormatsOf(name: string, tags: readonly string[]): string[] {
  const out = new Set<string>();
  for (const t of tags) {
    const hit = OTHER_TAGS[t.toLowerCase()];
    if (hit) out.add(hit);
  }
  for (const [re, label] of OTHER_DIRS) if (label !== 'PyTorch' && re.test(name)) out.add(label);
  return [...out].sort();
}

/** Files of a model folder vLLM / SGLang read besides the weights: configs, tokenizer, chat template, remote code. */
const RUNTIME_FILE =
  /^(config|generation_config|preprocessor_config|processor_config|video_preprocessor_config|params|special_tokens_map|added_tokens|tokenizer_config|tokenizer|chat_template|quantize_config|quant_config|hf_quant_config|tekken)\.json$|^tokenizer[\w.-]*$|^vocab\.\w+$|^merges\.txt$|\.(model|tiktoken|py)$|^chat_template\.jinja$|\.index\.json$/i;

const isSafetensors = (p: string) => /\.safetensors$/i.test(p);
const isBinWeights = (p: string) => /(^|\/)pytorch_model[\w.-]*\.bin$/i.test(p);
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** One safetensors model of a repo: a folder with its config.json and its weights. */
export interface SafetensorsVariant<F extends RepoFile = RepoFile> {
  /** Folder inside the repo, '' for the root. */
  dir: string;
  /** The weights (every shard), sorted by path. */
  weights: F[];
  /** Everything vLLM / SGLang read from that folder (weights, index, config, tokenizer…): what a download fetches. */
  files: F[];
  /** Bytes of `files`. */
  sizeBytes: number;
  /** From the folder name, else the repo's name and tags (the core refines it from config.json). */
  precision?: Precision | undefined;
}

/** Files of a format LLM Bench cannot run, or loose weights no engine here loads. */
export interface OtherFormatGroup<F extends RepoFile = RepoFile> {
  /** "MLX", "ONNX", "NInfer", "LoRA"… or "safetensors" for weights without a config.json. */
  format: string;
  /** Folder they share, '' when spread over the root. */
  dir: string;
  files: F[];
  sizeBytes: number;
}

/** One NInfer model: a .ninfer artifact with the manifest and checksums of its folder. */
export interface NinferArtifact<F extends RepoFile = RepoFile> {
  /** Folder inside the repo, '' for the root. */
  dir: string;
  /** The .ninfer file. */
  artifact: F;
  /** What a download fetches: the artifact, its manifest and its SHA256SUMS (checked after the download). */
  files: F[];
  sizeBytes: number;
}

export interface RepoLayout<F extends RepoFile = RepoFile> {
  /** llama.cpp: GGUF weights (each quant, split parts included) and their extras (mmproj, MTP, draft). */
  gguf: { weights: F[]; extras: F[] };
  /** vLLM / SGLang: one entry per loadable folder, the root first. */
  safetensors: SafetensorsVariant<F>[];
  /** NInfer: one entry per .ninfer artifact, largest first. */
  ninfer: NinferArtifact<F>[];
  other: OtherFormatGroup<F>[];
}

/** Code-point order: the same on every PC, whatever its locale. */
const byPath = (a: RepoFile, b: RepoFile) => (a.path < b.path ? -1 : 1);
const sum = (files: readonly RepoFile[]) => files.reduce((a, f) => a + f.sizeBytes, 0);

/**
 * How a repo's files split into formats. `hint` (the repo name and tags) gives the precision of
 * root weights ("Qwen3-8B-FP8") and tells MLX repos, whose safetensors vLLM cannot read.
 * README, licences, images, videos and the rest belong to no format: never downloaded with a model.
 */
export function repoLayout<F extends RepoFile>(files: readonly F[], hint: { name?: string; tags?: readonly string[] } = {}): RepoLayout<F> {
  const tags = hint.tags ?? [];
  const mlxRepo = tags.some((t) => t.toLowerCase() === 'mlx');
  const gguf = { weights: [] as F[], extras: [] as F[] };
  const others = new Map<string, OtherFormatGroup<F>>();
  const addOther = (format: string, dir: string, f: F) => {
    const key = `${format}|${dir}`;
    const g = others.get(key) ?? { format, dir, files: [], sizeBytes: 0 };
    g.files.push(f);
    g.sizeBytes += f.sizeBytes;
    others.set(key, g);
  };
  const byDir = new Map<string, F[]>();
  const ninfer: NinferArtifact<F>[] = [];
  const companions = files.filter((f) => NINFER_MANIFEST.test(f.path) || NINFER_SUMS.test(f.path));
  for (const f of files) {
    if (NINFER_FILE.test(f.path)) {
      const extra = companions.filter((c) => dirOf(c.path) === dirOf(f.path));
      const all = [f, ...extra].sort(byPath);
      ninfer.push({ dir: dirOf(f.path), artifact: f, files: all, sizeBytes: sum(all) });
      continue;
    }
    if (companions.includes(f)) continue;
    if (/\.gguf$/i.test(f.path)) {
      // Weights are models; mmproj, MTP heads and drafts go with them.
      if (f.kind === 'weights') gguf.weights.push(f);
      else gguf.extras.push(f);
      continue;
    }
    const fmt = otherFormatOf(f.path);
    if (fmt) {
      addOther(fmt, dirOf(f.path), f);
      continue;
    }
    byDir.set(dirOf(f.path), [...(byDir.get(dirOf(f.path)) ?? []), f]);
  }
  const variants: SafetensorsVariant<F>[] = [];
  // Code-point order puts the root ('') first.
  for (const [dir, inDir] of [...byDir].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const st = inDir.filter((f) => isSafetensors(f.path));
    const weights = (st.length > 0 ? st : inDir.filter((f) => isBinWeights(f.path))).sort(byPath);
    if (weights.length === 0) continue;
    const names = new Set(inDir.map((f) => baseOf(f.path)));
    // Speculative-decoding modules ("MTP-BF16/", "DFlash2-FP8/") ride along a model; they are not one.
    const module = weights.every((w) => w.kind === 'mtp' || w.kind === 'draft');
    let format: string | undefined;
    if (names.has('adapter_config.json')) format = 'LoRA';
    else if (mlxRepo) format = 'MLX';
    else if (module) format = weights[0]?.kind === 'mtp' ? 'MTP' : 'draft';
    else if (!names.has('config.json') && !names.has('params.json')) format = 'safetensors';
    if (format) {
      for (const w of weights) addOther(format, dir, w);
      continue;
    }
    const all = inDir.filter((f) => weights.includes(f) || isSafetensors(f.path) || RUNTIME_FILE.test(baseOf(f.path))).sort(byPath);
    const precision = precisionFromText(dir) ?? (dir === '' ? precisionFromText(hint.name ?? '', ...tags) : undefined);
    variants.push({ dir, weights, files: all, sizeBytes: sum(all), ...(precision ? { precision } : {}) });
  }
  const other = [...others.values()].sort((a, b) => b.sizeBytes - a.sizeBytes);
  return { gguf, safetensors: variants, ninfer: ninfer.sort((a, b) => b.sizeBytes - a.sizeBytes), other };
}

/** Paths a vLLM / SGLang download of the variant in `dir` fetches ('' = the root): exactly its folder's runtime files. */
export function variantDownload(files: readonly RepoFile[], dir = '', hint: { name?: string; tags?: readonly string[] } = {}): string[] {
  return (repoLayout(files, hint).safetensors.find((v) => v.dir === dir)?.files ?? []).map((f) => f.path);
}

/**
 * A GGUF named with an MTP word ("…-MTP-Q8_0.gguf") is usually a whole model with its MTP head
 * fused in; only when it is much smaller than the repo's biggest GGUF is it the head alone.
 */
export const MTP_HEAD_MAX_SHARE = 0.3;

/** Repo-wide pass: a "weights" GGUF with an MTP word that is a fraction of the biggest one is an MTP head. */
export function refineGgufKinds<F extends RepoFile>(files: readonly F[]): F[] {
  const biggest = Math.max(0, ...files.filter((f) => f.kind === 'weights' && /\.gguf$/i.test(f.path)).map((f) => f.sizeBytes));
  return files.map((f) =>
    f.kind === 'weights' && /\.gguf$/i.test(f.path) && /(^|[-_.])mtp([-_.(]|$)/i.test(baseOf(f.path)) && f.sizeBytes < biggest * MTP_HEAD_MAX_SHARE
      ? { ...f, kind: 'mtp' as const }
      : f,
  );
}
