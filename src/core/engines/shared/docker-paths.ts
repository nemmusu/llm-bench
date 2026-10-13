/**
 * Files named in a Docker engine's arguments (a draft model, an image projector, a LoRA), seen from
 * inside the container: the container only sees what is mounted, so each such host path is either
 * found under a folder already mounted (the model's own) or gets its folder mounted read-only.
 */
import path from 'node:path';

/** Options whose value is a file or a folder on the host, per engine. */
export const HOST_PATH_OPTIONS = {
  // Draft / MTP model, image projector, LoRA adapter.
  llamacpp: ['-md', '--model-draft', '--spec-draft-model', '-mm', '--mmproj', '--lora'],
  // Older vLLM releases took the draft model as an option of its own.
  vllm: ['--speculative-model'],
  sglang: ['--speculative-draft-model-path'],
} as const;

/** vLLM: a JSON option whose "model" is the draft model. */
export const VLLM_JSON_MODEL_OPTIONS = ['--speculative-config'] as const;

/** A host folder and where the container sees it. */
export interface HostMount {
  hostDir: string;
  containerDir: string;
}

export interface ContainerPathOptions {
  /** Options whose value is a host path. */
  options: readonly string[];
  /** Options whose value is a JSON object with a "model" host path. */
  jsonModelOptions?: readonly string[];
  /** Path rules of the host (win32 on Windows). */
  host: path.PlatformPath;
  /** Folders the container already has (the model's). */
  mounted: readonly HostMount[];
  /** A value is a host path only when it exists there (else it may be a path inside the image, or a repo id). */
  exists: (p: string) => boolean;
}

export interface ContainerArgs {
  args: string[];
  /** The extra read-only mounts ("host:container:ro"). */
  volumes: string[];
}

/** Model files have an extension; a model folder (Hugging Face layout) does not. */
const FILE_EXT = /\.(gguf|safetensors|bin|pt|pth|onnx)$/i;
const AUX_ROOT = '/aux';

/**
 * `args` with every host path in a path option rewritten to where the container sees it: under a
 * folder already mounted (the model's own folder), else in a new read-only mount /aux/<n> of its
 * folder (a model folder is mounted itself). Values that are not existing absolute host paths are
 * left as they are, and so is everything else.
 */
export function containerPaths(args: readonly string[], o: ContainerPathOptions): ContainerArgs {
  const mounts: HostMount[] = [...o.mounted];
  const volumes: string[] = [];

  const inside = (p: string): string | undefined => {
    for (const m of mounts) {
      const rel = o.host.relative(m.hostDir, p);
      if (rel === '') return m.containerDir;
      if (!rel.startsWith('..') && !o.host.isAbsolute(rel)) return path.posix.join(m.containerDir, ...rel.split(o.host.sep));
    }
    return undefined;
  };

  const map = (value: string): string => {
    if (!o.host.isAbsolute(value) || !o.exists(value)) return value;
    const known = inside(value);
    if (known !== undefined) return known;
    const file = FILE_EXT.test(value);
    const hostDir = file ? o.host.dirname(value) : value;
    const containerDir = `${AUX_ROOT}/${volumes.length}`;
    mounts.push({ hostDir, containerDir });
    volumes.push(`${hostDir}:${containerDir}:ro`);
    return file ? path.posix.join(containerDir, o.host.basename(value)) : containerDir;
  };

  const mapJson = (value: string): string => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return value;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return value;
    const model = (parsed as Record<string, unknown>).model;
    if (typeof model !== 'string') return value;
    const mapped = map(model);
    return mapped === model ? value : JSON.stringify({ ...parsed, model: mapped });
  };

  const json = o.jsonModelOptions ?? [];
  const valueOf = (flag: string): ((v: string) => string) | undefined => (o.options.includes(flag) ? map : json.includes(flag) ? mapJson : undefined);

  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    const eq = a.indexOf('=');
    const inline = a.startsWith('-') && eq > 0 ? valueOf(a.slice(0, eq)) : undefined;
    if (inline) {
      out.push(`${a.slice(0, eq)}=${inline(a.slice(eq + 1))}`);
      continue;
    }
    const next = valueOf(a);
    out.push(a);
    if (next && i + 1 < args.length) out.push(next(args[++i] as string));
  }
  return { args: out, volumes };
}
