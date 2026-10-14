/**
 * NVIDIA TensorRT-LLM's OpenAI server (`trtllm-serve serve <model> …`, PyTorch backend), shared by the
 * Docker and the native adapter: the command line, its click `--help`, the start log (phases, load
 * progress, KV capacity) and the failure diagnosis.
 *
 * The command (docs: commands/trtllm-serve; tensorrt_llm/commands/serve.py): the model is positional (an
 * HF repo id or a checkpoint folder: NVFP4 / FP8 ModelOpt checkpoints such as nvidia/Qwen3-8B-FP8 load as
 * they are), options use underscores (--max_seq_len, --kv_cache_free_gpu_memory_fraction…). `trtllm-serve`
 * with no sub-command means `serve`; LLM Bench always writes `serve`. Native runs use
 * `python -m tensorrt_llm.commands.serve` (the same program, from the chosen Python).
 *
 * Start log, lines prefixed "[10/14/2026-10:00:05] [TRT-LLM] [I] " (assumed from the 1.x sources, to be
 * checked on real hardware):
 *   [TensorRT-LLM] TensorRT-LLM version: 1.2.1
 *   Loading weights: 100%|██████████| 399/399 [00:09<00:00, 40.2it/s]
 *   Memory used after loading model weights (inside torch) in memory usage profiling: 15.27 GiB
 *   [MemUsageChange] Allocated 21.41 GiB for max tokens in paged KV cache (175360).
 *   [Autotuner] Autotuning process starts …
 *   Run generation only CUDA graph warmup for batch size=1
 *   INFO:     Started server process [1]
 *   INFO:     Application startup complete.
 *   INFO:     Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C to quit)
 */
import type { MissingFlag } from '../../../contract/custom-engines';
import { TRTLLM_DEFAULT_KV_FRACTION, type LaunchParams, type TrtllmKvDtype } from '../../../contract/engines';
import { AppError, type ErrorCode } from '../../../contract/errors';
import type { LoadProgress } from '../../../contract/events';
import type { KvCapacity } from '../../../contract/results';
import type { ExitInfo } from '../../deps';
import { FlagGate } from './standard-flags';
import type { VllmHelp } from './vllm-help';

/** trtllm-serve's own default port (the container's). */
export const TRTLLM_CONTAINER_PORT = 8000;
/** The program in the NGC image (on its PATH). */
export const TRTLLM_PROGRAM = 'trtllm-serve';
/** The same program from a Python of one's own: `python -m tensorrt_llm.commands.serve`. */
export const TRTLLM_MODULE = ['-m', 'tensorrt_llm.commands.serve'] as const;
/** The sub-command (the default one, written out). */
export const TRTLLM_SERVE = 'serve';
/** --max_seq_len when the launch names no context (trtllm-serve would take the model's whole context). */
export const TRTLLM_DEFAULT_CONTEXT = 4096;
/** Python code that prints the installed TensorRT-LLM version (importing it prints a banner first). */
export const TRTLLM_VERSION_CODE = 'import tensorrt_llm; print(tensorrt_llm.__version__)';
/** The PyPI package of the native environment. */
export const TRTLLM_PACKAGE = 'tensorrt-llm';

/**
 * --kv_cache_dtype: trtllm.kvCacheDtype first, else kvCacheType ('auto', 'fp8', 'nvfp4' as they are; the 8/4-bit
 * llama.cpp types → fp8: TensorRT-LLM has no q8_0/q4_0; anything else: its default). Extra arguments that choose it themselves win.
 */
export function trtllmKvDtype(p: Pick<LaunchParams, 'kvCacheType' | 'extraArgs' | 'trtllm'>): TrtllmKvDtype | undefined {
  if (p.extraArgs.includes('--kv_cache_dtype')) return undefined;
  if (p.trtllm?.kvCacheDtype !== undefined) return p.trtllm.kvCacheDtype;
  const kv = p.kvCacheType;
  if (kv === 'auto' || kv === 'nvfp4') return kv;
  return kv === 'fp8' || kv === 'q8_0' || kv === 'q4_0' ? 'fp8' : undefined;
}

/** The context a launch asks for: maxModelLen, else contextSize, else LLM Bench's default. */
export function trtllmContext(p: Pick<LaunchParams, 'maxModelLen' | 'contextSize'>): number {
  return p.maxModelLen ?? p.contextSize ?? TRTLLM_DEFAULT_CONTEXT;
}

export interface TrtllmServeOptions {
  /** HF repo id or a path (inside the container for Docker, inside the distro for WSL). */
  model: string;
  host: string;
  port: number;
  /** The one name /v1/models lists: the marker, or the API name of a server. */
  servedName: string;
  revision?: string;
}

/**
 * Arguments after `serve`: everything explicit, so the record is exact. `gate` leaves out what an older
 * build lacks (its --help is known).
 */
export function trtllmServeArgs(params: LaunchParams, o: TrtllmServeOptions, gate = new FlagGate('trtllm', undefined)): string[] {
  const t = params.trtllm ?? {};
  const args = [o.model];
  gate.push(args, '--host', o.host);
  gate.push(args, '--port', String(o.port));
  gate.push(args, '--served_model_name', o.servedName);
  // --hf_revision is the current spelling; older builds only know --revision.
  if (o.revision !== undefined) args.push(gate.lists('--hf_revision') ? '--hf_revision' : '--revision', o.revision);
  gate.push(args, '--max_seq_len', String(trtllmContext(params)));
  if (params.parallel !== undefined) gate.push(args, '--max_batch_size', String(params.parallel));
  // Tokens one engine step reads (llama.cpp's batch, vLLM's max-num-batched-tokens).
  if (params.batchSize !== undefined) gate.push(args, '--max_num_tokens', String(params.batchSize));
  gate.push(args, '--kv_cache_free_gpu_memory_fraction', String(t.kvCacheFreeMemoryFraction ?? TRTLLM_DEFAULT_KV_FRACTION));
  const kv = trtllmKvDtype(params);
  if (kv !== undefined) gate.push(args, '--kv_cache_dtype', kv);
  if (t.tensorParallel !== undefined) gate.push(args, '--tp_size', String(t.tensorParallel));
  // A prompt longer than --max_num_tokens is refused without it (the context sweep sends long ones).
  if (t.chunkedPrefill !== false) gate.push(args, '--enable_chunked_prefill');
  if (t.trustRemoteCode === true) gate.push(args, '--trust_remote_code');
  args.push(...params.extraArgs);
  return args;
}

/**
 * Settings trtllm-serve has no option for: left out, its own behaviour applies (said in the run's notes
 * like a flag a fork lacks). The dtype and the quantization come from the checkpoint itself.
 */
export function trtllmIgnored(params: Pick<LaunchParams, 'ropeScaling' | 'dtype' | 'quantization'>): MissingFlag[] {
  const out: MissingFlag[] = [];
  if (params.ropeScaling) out.push({ flag: '--rope_scaling', setting: 'ropeScaling', effect: 'default' });
  if (params.dtype !== undefined) out.push({ flag: '--dtype', setting: 'dtype', effect: 'default' });
  if (params.quantization !== undefined) out.push({ flag: '--quantization', setting: 'quantization', effect: 'default' });
  return out;
}

// ---- help ----------------------------------------------------------------------------------------

const OPTION_LINE = /^ {1,8}(--?[A-Za-z0-9].*?)(?: {2,}|$)/;
const SPELLING = /^(--?[A-Za-z0-9][\w-]*)(?:\s+\[([^\]]*)\])?/;

/**
 * Options of a click `--help` ("  --kv_cache_dtype [auto|fp8|nvfp4]", "  --tp_size, --tensor_parallel_size INTEGER",
 * "  --trust_remote_code"): every spelling, and the choices click lists in brackets.
 */
export function parseClickHelp(text: string): VllmHelp {
  const flags = new Set<string>();
  const choices: Record<string, string[]> = {};
  for (const line of text.split(/\r?\n/)) {
    const spec = OPTION_LINE.exec(line)?.[1];
    if (spec === undefined) continue;
    const names: string[] = [];
    let list: string[] | undefined;
    for (const part of spec.split(/,\s+/)) {
      const m = SPELLING.exec(part.trim());
      if (!m) continue;
      names.push(m[1] as string);
      if (m[2] !== undefined && m[2].includes('|')) list ??= m[2].split('|').map((c) => c.trim()).filter(Boolean);
    }
    for (const n of names) {
      flags.add(n);
      if (list) choices[n] = list;
    }
  }
  return { flags, choices };
}

/** One `serve --help`; a failure, or a help that is not trtllm-serve's (no --max_seq_len), gives no options. */
export async function probeClickHelp(run: () => Promise<{ code: number | null; stdout: string; stderr: string }>): Promise<VllmHelp> {
  const out = await run().catch(() => undefined);
  if (!out || out.code !== 0) return { flags: new Set(), choices: {} };
  const help = parseClickHelp(`${out.stdout}\n${out.stderr}`);
  return help.flags.has('--max_seq_len') ? help : { flags: new Set(), choices: {} };
}

/** "1.2.1", "1.4.0rc0" from the version code's output (the last version-looking line; the import prints a banner first). */
export function parseTrtllmVersion(stdout: string): string | undefined {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^v?(\d+\.\d+\.\d+(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?(?:\+[\w.]+)?)$/.exec(lines[i] as string);
    if (m) return m[1];
  }
  return undefined;
}

// ---- log -----------------------------------------------------------------------------------------

/** Load phases; each mark is the first line of a phase. */
export const TRTLLM_PHASES: readonly { name: string; re: RegExp }[] = [
  { name: 'engine_init', re: /TensorRT-LLM version|Using LLM with PyTorch backend/ },
  { name: 'load_tensors', re: /Loading (?:safetensors )?weights|Loading checkpoint shards/ },
  { name: 'kv_cache', re: /paged KV cache/ },
  { name: 'graph_capture', re: /CUDA graph/ },
  { name: 'api_start', re: /Started server process|Uvicorn running on/ },
  { name: 'warmup', re: /Application startup complete/ },
];

export function trtllmPhaseOf(text: string): string | undefined {
  return TRTLLM_PHASES.find((p) => p.re.test(text))?.name;
}

const WEIGHTS = /(?:Loading (?:safetensors )?weights|Loading checkpoint shards)[^:]*:\s*\d+%\|[^|]*\|\s*(\d+)\/(\d+)/g;

function lastCount(line: string, re: RegExp): { done: number; total: number } | undefined {
  let last: RegExpExecArray | undefined;
  for (const m of line.matchAll(re)) last = m as RegExpExecArray;
  return last ? { done: Number(last[1]), total: Number(last[2]) } : undefined;
}

/** "[10/14/2026-10:00:05] [TRT-LLM] [I] msg" or "INFO:     msg" → "msg" (also trims). */
export function trtllmMessage(line: string): string {
  return line
    .replace(/^\s*(?:\[[\d/:.-]+\]\s*)?(?:\[TRT-LLM\]\s*|\[TensorRT-LLM\]\s*)?(?:\[[IWEVD]\]\s*)?/, '')
    .replace(/^(?:INFO|WARNING|ERROR):\s+/, '')
    .trim()
    .slice(0, 160);
}

/** What one trtllm-serve start line says about the load. */
export function trtllmProgress(line: string): Omit<LoadProgress, 'elapsedMs' | 'expectedMs'> | undefined {
  const weights = lastCount(line, WEIGHTS);
  if (weights) return { stage: 'weights', done: weights.done, total: weights.total, ...(weights.total > 0 ? { fraction: Math.min(1, weights.done / weights.total) } : {}) };
  const detail = trtllmMessage(line);
  if (/Application startup complete/.test(line)) return { stage: 'ready' };
  if (/Started server process|Waiting for application startup|Uvicorn running on/.test(line)) return { stage: 'api-server', detail };
  if (/Autotun|Run warmup/i.test(line)) return { stage: 'warmup', detail };
  if (/CUDA graph/.test(line)) return { stage: 'cuda-graphs', detail };
  if (/paged KV cache|\[kv cache manager\]/i.test(line)) return { stage: 'kv-cache', detail };
  if (/memory usage profiling|Memory used outside torch|estimat\w* (?:the )?KV cache/i.test(line)) return { stage: 'memory-profile', detail };
  if (/Loading (?:safetensors )?weights|Loading checkpoint shards|Fetching \d+ files/.test(line)) return { stage: 'weights', detail };
  if (/TensorRT-LLM version|Using LLM with PyTorch backend/.test(line)) return { stage: 'metadata', detail };
  return undefined;
}

const KV_LINE = /Allocated [\d.]+ GiB for max tokens in paged KV cache \((\d+)\)/;

/** Tokens the KV cache holds: "Allocated … GiB for max tokens in paged KV cache (N)" (the last one: several pools add up per layer group). */
export function trtllmKvCapacity(lines: readonly string[]): KvCapacity | undefined {
  let tokens: number | undefined;
  for (const l of lines) {
    const m = KV_LINE.exec(l);
    if (m) tokens = Number(m[1]);
  }
  return tokens !== undefined && tokens > 0 ? { tokens } : undefined;
}

export interface TrtllmDiagnoseContext {
  docker?: boolean;
  repo?: string;
  /** Native in WSL: the distro (said in a missing-library message). */
  distro?: string;
}

/** The package that ships a library TensorRT-LLM loads (Open MPI's are the usual ones missing). */
export function packageOfLibrary(library: string): string {
  if (/^lib(?:mpi|open-pal|open-rte)\b/.test(library)) return 'libopenmpi-dev';
  return library.replace(/\.so(?:\.(\d+))?(?:\.\d+)*$/, '$1');
}

/** Turns an early exit into the most specific error the log supports (the root cause hides in tracebacks). */
export function diagnoseTrtllm(lines: readonly string[], exit: ExitInfo, ctx: TrtllmDiagnoseContext = {}): AppError {
  const tail = lines.slice(-40).join('\n');
  const params: Record<string, string | number> = { code: String(exit.code ?? exit.signal) };
  const find = (re: RegExp): RegExpExecArray | undefined => {
    for (const l of lines) {
      const m = re.exec(l);
      if (m) return m;
    }
    return undefined;
  };
  const err = (code: ErrorCode, msg: string, extra: Record<string, string | number> = {}, hit?: RegExpExecArray) =>
    new AppError(code, msg, { params: { ...params, ...extra }, detail: hit === undefined ? tail : `${hit.input.trim()}\n…\n${tail}` });

  const spawn = find(/^Error: spawn .*\b(ENOENT|EACCES|EPERM|EINVAL|UNKNOWN)\b/);
  if (spawn) return err('ENGINE_START_FAILED', spawn[0].trim());
  const noModule = find(/No module named '?tensorrt_llm/);
  if (noModule) return err('ENGINE_NOT_INSTALLED', 'TensorRT-LLM is not installed in this Python', { reason: 'trtllm_missing' }, noModule);
  const lib = find(/([\w.+-]+\.so(?:\.[\d.]+)?): cannot open shared object file/);
  if (lib) {
    const library = lib[1] as string;
    return err('ENGINE_MISSING_LIBRARY', `TensorRT-LLM: the system library ${library} is missing`, { library, package: packageOfLibrary(library), ...(ctx.distro ? { distro: ctx.distro } : {}) }, lib);
  }
  const noKernel = find(/no kernel image is available for execution on the device|does not support SM\s?\d+|Unsupported SM(?: version)?\b|not supported on SM\s?\d+/i);
  if (noKernel) return err('ENGINE_NO_KERNEL_IMAGE', 'The engine build does not support this GPU', {}, noKernel);
  const ctxLen = find(/max_seq_len \(?(\d+)\)? (?:is )?(?:larger|greater) than (?:the )?(?:model'?s? )?max_position_embeddings \(?(\d+)\)?/i);
  if (ctxLen) {
    return err('MODEL_TOO_LARGE', 'The requested context is longer than the model supports', { reason: 'context', maxModelLen: Number(ctxLen[1]), modelMaxLen: Number(ctxLen[2]) }, ctxLen);
  }
  const kv = find(/(?:not enough|insufficient) (?:GPU )?memory (?:for|to allocate) (?:the )?KV cache|KV cache (?:size|memory) is (?:too small|not enough)|max_seq_len .* exceeds the KV cache capacity/i);
  if (kv) return err('ENGINE_OOM', 'Not enough memory for the KV cache', { reason: 'kv-cache' }, kv);
  const oom = find(/CUDA out of memory|OutOfMemoryError|CUDA error: out of memory|cudaErrorMemoryAllocation|out of memory/i);
  if (oom) return err('ENGINE_OOM', 'Out of GPU memory', {}, oom);
  const repo = find(/huggingface\.co\/(?:api\/models\/)?([\w.-]+\/[\w.-]+)\/(?:resolve|revision)\//)?.[1] ?? ctx.repo;
  const withRepo: Record<string, string> = repo !== undefined ? { repo } : {};
  const gated = find(/Cannot access gated repo|You are trying to access a gated repo|GatedRepoError/);
  if (gated) return err('HF_AUTH_REQUIRED', 'The model needs a Hugging Face token', withRepo, gated);
  const notFound = find(/RepositoryNotFoundError|Repository Not Found for url|is not a local folder and is not a valid model identifier/);
  if (notFound) return err('HF_NOT_FOUND', 'Model repository not found', withRepo, notFound);
  const arch = find(/Unknown architecture for AutoModelForCausalLM: ['"]?([\w.-]+)|Model architectures? \[['"]?([\w.-]+)['"]?.*\] (?:is|are) not supported|Unsupported (?:model )?architectures?:? ['"]?([\w.-]+)/);
  if (arch) {
    const value = (arch[1] ?? arch[2] ?? arch[3]) as string;
    return err('ENGINE_MODEL_UNSUPPORTED', `Model not supported by TensorRT-LLM: ${arch.input.trim()}`, { engine: 'TensorRT-LLM', reason: 'architecture', value }, arch);
  }
  const quant = find(/Unsupported quant(?:ization)?(?: algo(?:rithm)?| method| mode)?:? ['"]?([\w.-]+)/i);
  if (quant) return err('ENGINE_MODEL_UNSUPPORTED', `Quantization not supported by TensorRT-LLM: ${quant.input.trim()}`, { engine: 'TensorRT-LLM', reason: 'quantization', value: quant[1] as string }, quant);
  // click: "Error: No such option: --foo", "Error: Invalid value for '--kv_cache_dtype': 'x' is not one of …".
  const noOption = find(/Error: No such option: (--?[\w-]+)/);
  if (noOption) return err('ENGINE_BAD_FLAG', `Rejected argument: ${noOption[1] as string}`, { flag: noOption[1] as string }, noOption);
  const badValue = find(/Error: Invalid value for '(--?[\w-]+)/);
  if (badValue) return err('ENGINE_BAD_FLAG', `Rejected argument: ${badValue[1] as string}`, { flag: badValue[1] as string }, badValue);
  const extra = find(/Error: Got unexpected extra arguments? \(([^)]*)\)/);
  if (extra) return err('ENGINE_BAD_FLAG', `Rejected argument: ${extra[1] as string}`, { flag: extra[1] as string }, extra);
  const port = find(/address already in use|\[Errno 98\]/i);
  if (port) return err('ENGINE_PORT_IN_USE', 'The port is already in use', {}, port);
  const driver = find(/CUDA driver version is insufficient|NVIDIA driver on your system is too old/);
  if (driver) return err('DRIVER_TOO_OLD', 'The NVIDIA driver is too old for this engine', {}, driver);
  const noGpu = find(/No CUDA GPUs are available|Found no NVIDIA driver on your system/);
  if (noGpu) return ctx.docker ? err('DOCKER_NO_GPU', 'The container cannot see the GPU', {}, noGpu) : err('GPU_NOT_FOUND', 'TensorRT-LLM cannot see the GPU', {}, noGpu);
  return err('ENGINE_EXITED', `Engine exited with ${String(params.code)}`);
}
