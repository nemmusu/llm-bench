import { AppError, type ErrorCode } from '../../../contract/errors';
import type { ExitInfo } from '../../deps';

/**
 * Load phases of a vLLM server (v0.9 … v0.31 V1 engine), detected from its log. Each mark is the
 * first line of a phase; a phase ends where the next one starts, the last one at "ready".
 *
 *   engine_init   Initializing a V1 LLM engine (v0.11.0) with config: …
 *   model_load    Starting to load model <repo>…   (architecture, weight download when not cached)
 *   load_tensors  Loading safetensors checkpoint shards: 0% …  (reading the weights: the cold-read
 *                 estimate uses this phase, so a weight download never counts as disk reading)
 *   compile       Using cache directory … for vLLM's torch.compile / Dynamo bytecode transform time
 *   kv_cache      Available KV cache memory: … / GPU KV cache size: …
 *   graph_capture Capturing CUDA graphs (…)
 *   api_start     Starting vLLM API server 0 on http://0.0.0.0:8000
 *
 * Lines carry prefixes ("(EngineCore_DP0 pid=255) INFO 10-06 05:13:06 [file.py:267] "): patterns are not anchored.
 */
export const VLLM_PHASES: readonly { name: string; re: RegExp }[] = [
  { name: 'engine_init', re: /Initializing a V1 LLM engine|Initializing an LLM engine/ },
  { name: 'model_load', re: /Starting to load model/ },
  { name: 'load_tensors', re: /Loading (?:safetensors|pt) checkpoint shards/ },
  { name: 'compile', re: /for vLLM's torch\.compile|Dynamo bytecode transform time|Directly load the compiled graph/ },
  { name: 'kv_cache', re: /Available KV cache memory|GPU KV cache size/ },
  { name: 'graph_capture', re: /Capturing CUDA graphs?|Capturing cudagraphs/ },
  { name: 'api_start', re: /Starting vLLM API server/ },
];

export function vllmPhaseOf(text: string): string | undefined {
  return VLLM_PHASES.find((p) => p.re.test(text))?.name;
}

/** Durations vLLM reports about its own start-up (seconds / GiB), for "Come è stato avviato". */
export interface VllmLoadReport {
  version?: string;
  downloadS?: number;
  loadWeightsS?: number;
  modelLoadS?: number;
  modelLoadGiB?: number;
  compileS?: number;
  graphCaptureS?: number;
  graphCaptureGiB?: number;
  initEngineS?: number;
  kvCacheGiB?: number;
  kvCacheTokens?: number;
  maxConcurrency?: number;
}

const REPORT: readonly { re: RegExp; set: (r: VllmLoadReport, m: RegExpExecArray) => void }[] = [
  { re: /vLLM API server version (\S+)/, set: (r, m) => (r.version = m[1] as string) },
  { re: /Time spent downloading weights for .*?: ([\d.]+) seconds/, set: (r, m) => (r.downloadS = Number(m[1])) },
  { re: /Loading weights took ([\d.]+) seconds/, set: (r, m) => (r.loadWeightsS = Number(m[1])) },
  {
    re: /Model loading took ([\d.]+) GiB(?: memory)? and ([\d.]+) seconds/,
    set: (r, m) => {
      r.modelLoadGiB = Number(m[1]);
      r.modelLoadS = Number(m[2]);
    },
  },
  { re: /torch\.compile takes ([\d.]+) s in total/, set: (r, m) => (r.compileS = Number(m[1])) },
  {
    re: /Graph capturing finished in ([\d.]+) secs?(?:, took ([\d.]+) GiB)?/,
    set: (r, m) => {
      r.graphCaptureS = Number(m[1]);
      if (m[2] !== undefined) r.graphCaptureGiB = Number(m[2]);
    },
  },
  { re: /init engine \(profile, create kv cache, warmup model\) took ([\d.]+) seconds/, set: (r, m) => (r.initEngineS = Number(m[1])) },
  { re: /Available KV cache memory: ([\d.]+) GiB/, set: (r, m) => (r.kvCacheGiB = Number(m[1])) },
  { re: /GPU KV cache size: ([\d,]+) tokens/, set: (r, m) => (r.kvCacheTokens = Number((m[1] as string).replace(/,/g, ''))) },
  { re: /Maximum concurrency for [\d,]+ tokens per request: ([\d.]+)x/, set: (r, m) => (r.maxConcurrency = Number(m[1])) },
];

export function parseVllmLoadReport(lines: readonly string[]): VllmLoadReport {
  const r: VllmLoadReport = {};
  for (const line of lines) {
    for (const p of REPORT) {
      const m = p.re.exec(line);
      if (m) p.set(r, m);
    }
  }
  return r;
}

export interface VllmDiagnoseContext {
  /** Running in a container: "no GPU" means Docker GPU support, not a missing GPU. */
  docker?: boolean;
  /** Tag to propose after "no kernel image" (engine-compat.json). */
  suggestTag?: string;
  /** Model repo, used when the log does not name it. */
  repo?: string;
}

const DETAIL_LINES = 40;

/**
 * Turns an early exit into the most specific error the log supports. vLLM prints the root cause
 * inside long tracebacks, then generic "Engine core initialization failed": order matters.
 */
export function diagnoseVllm(lines: readonly string[], exit: ExitInfo, ctx: VllmDiagnoseContext = {}): AppError {
  const tail = lines.slice(-DETAIL_LINES).join('\n');
  const params: Record<string, string | number> = { code: String(exit.code ?? exit.signal) };
  const find = (re: RegExp): RegExpExecArray | undefined => {
    for (const l of lines) {
      const m = re.exec(l);
      if (m) return m;
    }
    return undefined;
  };
  /** The matching line goes first in the detail: tracebacks bury it far from the tail. */
  const err = (code: ErrorCode, message: string, extra: Record<string, string | number> = {}, hit?: RegExpExecArray) =>
    new AppError(code, message, {
      params: { ...params, ...extra },
      detail: hit === undefined ? tail : `${hit.input.trim()}\n…\n${tail}`,
    });

  const spawn = find(/^Error: spawn .*\b(ENOENT|EACCES|EPERM|EINVAL|UNKNOWN)\b/);
  if (spawn) return err('ENGINE_START_FAILED', spawn[0].trim());

  const busy = find(
    /Free memory on device[^(]*\(([\d.]+)\/([\d.]+) GiB\) on startup is less than desired GPU memory utilization \(([\d.]+), ([\d.]+) GiB\)/,
  );
  if (busy) {
    return err(
      'VRAM_BUSY',
      'Not enough free VRAM for the requested GPU memory utilization',
      { freeGiB: Number(busy[1]), totalGiB: Number(busy[2]), utilization: Number(busy[3]), desiredGiB: Number(busy[4]) },
      busy,
    );
  }

  const sm = find(/with CUDA capability (sm_\d+) is not compatible with the current PyTorch installation/);
  const noKernel = find(/no kernel image is available for execution on the device/i) ?? sm;
  if (noKernel) {
    const extra: Record<string, string> = {};
    if (sm) extra.sm = sm[1] as string;
    if (ctx.suggestTag !== undefined) extra.suggestedTag = ctx.suggestTag;
    return err('ENGINE_NO_KERNEL_IMAGE', 'The engine build does not support this GPU', extra, noKernel);
  }

  const kv = find(/larger than the available KV cache memory|larger than the maximum number of tokens that can be stored in KV cache|is too large for the KV cache/);
  if (kv) {
    const extra: Record<string, string | number> = { reason: 'kv-cache' };
    const want = find(/max seq len \((\d+)\)/);
    const est = find(/estimated maximum model length is (\d+)/);
    if (want) extra.maxModelLen = Number(want[1]);
    if (est) extra.estimatedMaxModelLen = Number(est[1]);
    return err('MODEL_TOO_LARGE', 'The context does not fit in the KV cache', extra, kv);
  }
  const ctxLen = find(/max_model_len \((\d+)\).*(?:larger|greater) than/);
  if (ctxLen) {
    const extra: Record<string, string | number> = { reason: 'context', maxModelLen: Number(ctxLen[1]) };
    const derived = /max_position_embeddings=(\d+)/.exec(ctxLen.input);
    if (derived) extra.modelMaxLen = Number(derived[1]);
    return err('MODEL_TOO_LARGE', 'The requested context is longer than the model supports', extra, ctxLen);
  }

  const oom = find(/CUDA out of memory|OutOfMemoryError|No available memory for the cache blocks|CUDA error: out of memory/);
  if (oom) return err('ENGINE_OOM', 'Out of GPU memory', {}, oom);

  const repo =
    find(/Access to model (\S+?) is restricted/)?.[1] ??
    find(/huggingface\.co\/(?:api\/models\/)?([\w.-]+\/[\w.-]+)\/(?:resolve|revision)\//)?.[1] ??
    ctx.repo;
  const withRepo: Record<string, string> = repo !== undefined ? { repo } : {};
  const gated = find(/Cannot access gated repo|You are trying to access a gated repo|GatedRepoError/);
  if (gated) {
    // 401: no (valid) token; 403: token fine but the license was not accepted.
    return find(/\b403 Client Error\b|not in the authorized list|awaiting a review/)
      ? err('HF_GATED', 'The model license must be accepted on Hugging Face', withRepo, gated)
      : err('HF_AUTH_REQUIRED', 'The model needs a Hugging Face token', withRepo, gated);
  }
  // Checked before "invalid token": HF answers 401 + "Invalid username or password" for unknown repos too.
  const notFound = find(/RepositoryNotFoundError|Repository Not Found for url|is not a local folder and is not a valid model identifier/);
  if (notFound) return err('HF_NOT_FOUND', 'Model repository not found', withRepo, notFound);
  const badToken = find(/Invalid user token|Invalid credentials in Authorization header|401 Client Error/);
  if (badToken) return err('HF_AUTH_REQUIRED', 'The Hugging Face token was rejected', { ...withRepo, reason: 'invalid-token' }, badToken);
  const rate = find(/429 Client Error|Too Many Requests/);
  if (rate) return err('HF_RATE_LIMITED', 'Hugging Face rate limit reached', withRepo, rate);
  const offline = find(/We couldn't connect to 'https:\/\/huggingface\.co'|Max retries exceeded with url|NameResolutionError|Failed to resolve 'huggingface\.co'/);
  if (offline) return err('NETWORK', 'Hugging Face is not reachable', withRepo, offline);

  const unrecognized = find(/error: unrecognized arguments: (\S+)/);
  if (unrecognized) return err('ENGINE_BAD_FLAG', `Rejected argument: ${unrecognized[1] as string}`, { flag: unrecognized[1] as string }, unrecognized);
  const badValue = find(/error: argument (-{1,2}[\w-]+)(?:\/-{1,2}[\w-]+)*: invalid/);
  if (badValue) return err('ENGINE_BAD_FLAG', `Rejected argument: ${badValue[1] as string}`, { flag: badValue[1] as string }, badValue);

  const port = find(/address already in use|\[Errno 98\]/i);
  if (port) return err('ENGINE_PORT_IN_USE', 'The port is already in use', {}, port);

  const driver = find(/CUDA driver version is insufficient|NVIDIA driver on your system is too old|forward compatibility was attempted on non supported HW/);
  if (driver) return err('DRIVER_TOO_OLD', 'The NVIDIA driver is too old for this engine', {}, driver);
  const noGpu = find(/No CUDA GPUs are available|Found no NVIDIA driver on your system|Failed to infer device type/);
  if (noGpu) {
    return ctx.docker
      ? err('DOCKER_NO_GPU', 'The container cannot see the GPU', {}, noGpu)
      : err('GPU_NOT_FOUND', 'vLLM cannot see the GPU', {}, noGpu);
  }
  // "Model architectures ['Qwen3NextForCausalLM'] are not supported for now": this vLLM is older than the model.
  const arch = find(/Model architectures? \[['"]?([\w.-]+)['"]?.*\] (?:is|are) not supported/);
  if (arch) return err('ENGINE_MODEL_UNSUPPORTED', `vLLM does not support ${arch[1] as string}`, { engine: 'vLLM', reason: 'architecture', value: arch[1] as string }, arch);
  const model = find(/does not appear to have a file named config\.json|Unrecognized model in|No config format found|Invalid repository ID or local directory/);
  if (model) return err('MODEL_INVALID', `Model failed to load: ${model.input.trim()}`, {}, model);
  return err('ENGINE_EXITED', `Engine exited with ${String(params.code)}`);
}
