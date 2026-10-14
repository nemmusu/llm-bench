/**
 * SGLang (`python3 -m sglang.launch_server`), shared by the Docker and the native adapter: the
 * command line, the start log (phases, load progress, KV capacity) and the failure diagnosis.
 *
 * Start log (v0.4 … v0.5), lines prefixed "[2025-10-01 10:00:05 TP0] ":
 *   Load weight begin. avail mem=30.83 GB
 *   Loading safetensors checkpoint shards:  40% Completed | 2/5 [...]
 *   Load weight end. type=Qwen3ForCausalLM, dtype=torch.bfloat16, avail mem=15.37 GB, mem usage=15.46 GB.
 *   KV Cache is allocated. #tokens: 89472, K size: 6.14 GB, V size: 6.14 GB
 *   Capture cuda graph begin. This can take up to several minutes. avail mem=2.02 GB
 *   Capturing batches (bs=1 avail_mem=1.51 GB): 100%|██████████| 35/35 [00:09<00:00,  3.71it/s]
 *   Capture cuda graph end. Time elapsed: 10.21 s. mem usage=0.51 GB. avail mem=1.51 GB.
 *   max_total_num_tokens=89472, chunked_prefill_size=8192, max_prefill_tokens=16384, max_running_requests=4096, context_len=40960, …
 *   INFO:     Application startup complete.
 *   The server is fired up and ready to roll!
 */
import type { LaunchParams } from '../../../contract/engines';
import { AppError, type ErrorCode } from '../../../contract/errors';
import type { KvCapacity } from '../../../contract/results';
import type { ExitInfo } from '../../deps';
import type { LoadProgress } from '../../../contract/events';
import { sglangReasoningVision } from './reasoning-vision';
import { FlagGate } from './standard-flags';
import { ropeScalingConfig } from './vllm-args';

export const SGLANG_CONTAINER_PORT = 30000;
export const SGLANG_DEFAULT_CONTEXT = 4096;
/** Share of the GPU memory SGLang takes for weights + KV cache, passed explicitly so the record says it. */
export const SGLANG_DEFAULT_MEM_FRACTION = 0.85;
export const SGLANG_SEED = 0;
/** SGLang refuses a context longer than the model's own unless this is set (needed with RoPE scaling). */
export const SGLANG_LONGER_CONTEXT_ENV = 'SGLANG_ALLOW_OVERWRITE_LONGER_CONTEXT_LEN';
/** The program: `python -m sglang.launch_server`. */
export const SGLANG_MODULE = ['-m', 'sglang.launch_server'] as const;

/**
 * --kv-cache-dtype: SGLang has no plain "fp8" (fp8_e5m2 / fp8_e4m3): any 8/4-bit request is fp8_e5m2,
 * 'auto' when asked, else nothing. Extra arguments that choose it themselves (the tuner's fp8_e4m3) win.
 */
export function sglangKvDtype(p: Pick<LaunchParams, 'kvCacheType' | 'extraArgs'>): 'auto' | 'fp8_e5m2' | undefined {
  if (p.extraArgs.includes('--kv-cache-dtype')) return undefined;
  const kv = p.kvCacheType;
  if (kv === 'auto') return 'auto';
  return kv === 'fp8' || kv === 'q8_0' || kv === 'q4_0' ? 'fp8_e5m2' : undefined;
}

export interface SglangServeOptions {
  /** HF repo id or a path (inside the container for Docker). */
  model: string;
  host: string;
  port: number;
  /** One name only (SGLang takes a single served name): the marker, or the API name of a server. */
  servedName: string;
  revision?: string;
}

/** Server arguments: everything explicit, so the record is exact. `gate` leaves out what a fork lacks. */
export function sglangServeArgs(params: LaunchParams, o: SglangServeOptions, gate = new FlagGate('sglang', undefined)): string[] {
  const args: string[] = [];
  gate.push(args, '--model-path', o.model);
  if (o.revision !== undefined) args.push('--revision', o.revision);
  gate.push(args, '--served-model-name', o.servedName);
  gate.push(args, '--host', o.host);
  gate.push(args, '--port', String(o.port));
  gate.push(args, '--context-length', String(params.maxModelLen ?? params.contextSize ?? SGLANG_DEFAULT_CONTEXT));
  gate.push(args, '--mem-fraction-static', String(params.gpuMemoryUtilization ?? SGLANG_DEFAULT_MEM_FRACTION));
  if (params.parallel !== undefined) gate.push(args, '--max-running-requests', String(params.parallel));
  const kv = sglangKvDtype(params);
  if (kv !== undefined) gate.push(args, '--kv-cache-dtype', kv);
  // Prompt tokens read per step (llama.cpp's batch, vLLM's max-num-batched-tokens).
  if (params.batchSize !== undefined) gate.push(args, '--chunked-prefill-size', String(params.batchSize));
  gate.push(args, '--random-seed', String(SGLANG_SEED));
  // usage.prompt_tokens_details.cached_tokens: how much of a prompt came from the prefix (radix) cache.
  gate.push(args, '--enable-cache-report');
  if (params.dtype !== undefined) gate.push(args, '--dtype', params.dtype);
  if (params.quantization !== undefined) gate.push(args, '--quantization', params.quantization);
  if (params.ropeScaling) gate.push(args, '--json-model-override-args', JSON.stringify({ rope_scaling: ropeScalingConfig(params.ropeScaling) }));
  sglangReasoningVision(params, gate);
  args.push(...params.extraArgs);
  return args;
}

/** Environment SGLang needs for these params (a context longer than the model's own with RoPE scaling). */
export function sglangEnv(params: LaunchParams): Record<string, string> {
  return params.ropeScaling ? { [SGLANG_LONGER_CONTEXT_ENV]: '1', ...params.env } : { ...params.env };
}

// ---- log -----------------------------------------------------------------------------------------

/** Load phases; each mark is the first line of a phase. */
export const SGLANG_PHASES: readonly { name: string; re: RegExp }[] = [
  { name: 'engine_init', re: /Init torch distributed begin/ },
  { name: 'load_tensors', re: /Load weight begin/ },
  { name: 'kv_cache', re: /KV Cache is allocated/ },
  { name: 'graph_capture', re: /Capture cuda graph begin/ },
  { name: 'api_start', re: /Started server process|Uvicorn running on/ },
  { name: 'warmup', re: /Application startup complete/ },
];

export function sglangPhaseOf(text: string): string | undefined {
  return SGLANG_PHASES.find((p) => p.re.test(text))?.name;
}

const SHARDS = /checkpoint shards:\s*\d+%\s*Completed\s*\|\s*(\d+)\/(\d+)/g;
const BATCHES = /Capturing batches[^:]*:\s*\d+%\|[^|]*\|\s*(\d+)\/(\d+)/g;

function lastCount(line: string, re: RegExp): { done: number; total: number } | undefined {
  let last: RegExpExecArray | undefined;
  for (const m of line.matchAll(re)) last = m as RegExpExecArray;
  return last ? { done: Number(last[1]), total: Number(last[2]) } : undefined;
}

/** "[2025-10-01 10:00:05 TP0] msg" → "msg" (also trims). */
function message(line: string): string {
  return line.replace(/^\s*\[[\d-]+ [\d:.]+(?: [A-Z]+\d+)*\]\s*/, '').trim().slice(0, 160);
}

/** What one SGLang start line says about the load. */
export function sglangProgress(line: string): Omit<LoadProgress, 'elapsedMs' | 'expectedMs'> | undefined {
  const shards = lastCount(line, SHARDS);
  if (shards) return { stage: 'weights', done: shards.done, total: shards.total, ...(shards.total > 0 ? { fraction: Math.min(1, shards.done / shards.total) } : {}) };
  const batches = lastCount(line, BATCHES);
  if (batches) return { stage: 'cuda-graphs', done: batches.done, total: batches.total, ...(batches.total > 0 ? { fraction: Math.min(1, batches.done / batches.total) } : {}) };
  const detail = message(line);
  if (/The server is fired up and ready to roll/.test(line)) return { stage: 'ready' };

  // The HTTP server comes up, then SGLang sends itself a warm-up request ("fired up" = ready).
  if (/Started server process|Waiting for application startup|Application startup complete|Uvicorn running on/.test(line)) return { stage: 'api-server', detail };
  if (/Capture cuda graph end/.test(line)) return { stage: 'cuda-graphs', fraction: 1, detail };
  if (/Capture cuda graph begin/.test(line)) return { stage: 'cuda-graphs', detail };
  if (/KV Cache is allocated|Memory pool end/.test(line)) return { stage: 'kv-cache', detail };
  if (/Load weight end/.test(line)) return { stage: 'weights', fraction: 1, detail };
  if (/Load weight begin|Loading (?:safetensors|pt) checkpoint shards/.test(line)) return { stage: 'weights', detail };
  if (/Init torch distributed/.test(line)) return { stage: 'metadata', detail };
  return undefined;
}

/** Tokens the KV cache holds: "max_total_num_tokens=N", else "KV Cache is allocated. #tokens: N". */
export function sglangKvCapacity(lines: readonly string[]): KvCapacity | undefined {
  let tokens: number | undefined;
  for (const l of lines) {
    const total = /max_total_num_tokens=(\d+)/.exec(l);
    const pool = /KV Cache is allocated\. #tokens: (\d+)/.exec(l);
    if (total) tokens = Number(total[1]);
    else if (pool && tokens === undefined) tokens = Number(pool[1]);
  }
  return tokens !== undefined && tokens > 0 ? { tokens } : undefined;
}

export interface SglangDiagnoseContext {
  docker?: boolean;
  repo?: string;
}

/** Turns an early exit into the most specific error the log supports (the root cause hides in tracebacks). */
export function diagnoseSglang(lines: readonly string[], exit: ExitInfo, ctx: SglangDiagnoseContext = {}): AppError {
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
  const noModule = find(/No module named '?sglang'?/);
  if (noModule) return err('ENGINE_NOT_INSTALLED', 'SGLang is not installed in this Python', { reason: 'sglang_missing' }, noModule);
  const noKernel = find(/no kernel image is available for execution on the device/i);
  if (noKernel) return err('ENGINE_NO_KERNEL_IMAGE', 'The engine build does not support this GPU', {}, noKernel);
  const ctxLen = find(/User-specified context_length \((\d+)\) is greater than the derived context_length \((\d+)\)/);
  if (ctxLen) {
    return err('MODEL_TOO_LARGE', 'The requested context is longer than the model supports', { reason: 'context', maxModelLen: Number(ctxLen[1]), modelMaxLen: Number(ctxLen[2]) }, ctxLen);
  }
  const memFraction = find(/Not enough memory\. Please try to increase --mem-fraction-static/);
  if (memFraction) return err('ENGINE_OOM', 'Not enough memory for the KV cache', { reason: 'mem-fraction' }, memFraction);
  const oom = find(/CUDA out of memory|OutOfMemoryError|CUDA error: out of memory/);
  if (oom) return err('ENGINE_OOM', 'Out of GPU memory', {}, oom);
  const repo = find(/huggingface\.co\/(?:api\/models\/)?([\w.-]+\/[\w.-]+)\/(?:resolve|revision)\//)?.[1] ?? ctx.repo;
  const withRepo: Record<string, string> = repo !== undefined ? { repo } : {};
  const gated = find(/Cannot access gated repo|You are trying to access a gated repo|GatedRepoError/);
  if (gated) return err('HF_AUTH_REQUIRED', 'The model needs a Hugging Face token', withRepo, gated);
  const notFound = find(/RepositoryNotFoundError|Repository Not Found for url|is not a local folder and is not a valid model identifier/);
  if (notFound) return err('HF_NOT_FOUND', 'Model repository not found', withRepo, notFound);
  const arch = find(/Model architectures? \[['"]?([\w.-]+)['"]?.*\] (?:is|are) not supported|Unsupported architectures?: ['"]?([\w.-]+)/);
  if (arch) {
    const value = (arch[1] ?? arch[2]) as string;
    return err('ENGINE_MODEL_UNSUPPORTED', `Model not supported by SGLang: ${arch.input.trim()}`, { engine: 'SGLang', reason: 'architecture', value }, arch);
  }
  const unrecognized = find(/error: unrecognized arguments: (\S+)/);
  if (unrecognized) return err('ENGINE_BAD_FLAG', `Rejected argument: ${unrecognized[1] as string}`, { flag: unrecognized[1] as string }, unrecognized);
  const badValue = find(/error: argument (-{1,2}[\w-]+)(?:\/-{1,2}[\w-]+)*: invalid/);
  if (badValue) return err('ENGINE_BAD_FLAG', `Rejected argument: ${badValue[1] as string}`, { flag: badValue[1] as string }, badValue);
  const port = find(/address already in use|\[Errno 98\]/i);
  if (port) return err('ENGINE_PORT_IN_USE', 'The port is already in use', {}, port);
  const driver = find(/CUDA driver version is insufficient|NVIDIA driver on your system is too old/);
  if (driver) return err('DRIVER_TOO_OLD', 'The NVIDIA driver is too old for this engine', {}, driver);
  const noGpu = find(/No CUDA GPUs are available|Found no NVIDIA driver on your system/);
  if (noGpu) return ctx.docker ? err('DOCKER_NO_GPU', 'The container cannot see the GPU', {}, noGpu) : err('GPU_NOT_FOUND', 'SGLang cannot see the GPU', {}, noGpu);
  return err('ENGINE_EXITED', `Engine exited with ${String(params.code)}`);
}

/** "0.5.4.post1" from `python -c "import sglang; print(sglang.__version__)"` (the last version-looking line). */
export function parseSglangVersion(stdout: string): string | undefined {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^v?(\d+\.\d+\.\d+(?:\.post\d+|[.+-][\w.+-]+)?)$/.exec(lines[i] as string);
    if (m) return m[1];
  }
  return undefined;
}

/** Python code that prints the installed SGLang version. */
export const SGLANG_VERSION_CODE = 'import sglang; print(sglang.__version__)';
