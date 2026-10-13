export interface FakeProfile {
  loadMsCold?: number;
  loadMsWarm?: number;
  prefillTps?: number;
  decodeTps?: number;
  tokensPerChunk?: number;
  timeScale?: number;
  oomAtLoad?: boolean;
  noKernelImage?: boolean;
  crashAfterTokens?: number;
  stallAfterTokens?: number;
  /** A launch that spills never answers a generation request, until the client gives up. */
  spillStall?: boolean;
  httpErrorRate?: number;
  badFlag?: string;
  eosAfter?: number;
  vramMiB?: number;
  nLayers?: number;
  seed?: number;
  busy?: { utilPct: number; powerW: number; tempC?: number };
  memory?: FakeMemory;
  speed?: FakeSpeed;
  vllmHelp?: 'all' | 'old' | 'none';
  vllmMetrics?: 'counters' | 'gauge' | 'none';
}

export interface FakeMemory {
  totalMiB: number;
  weightsMiB: number;
  kvMiBPer1k: number;
  computeMiBPer512?: number;
  spillMiB?: number;
  layers?: number;
  freeMiB?: number;
  /** Shared GPU memory of a launch that does not spill (plus sharedMiBPer1k per 1K tokens of context). */
  sharedMiB?: number;
  sharedMiBPer1k?: number;
  /** A spilled launch's shared memory on top of that, once loaded and from its first request on. */
  spillShared?: { loadMiB: number; requestMiB: number };
}

export interface FakeSpeed {
  depthSlowdown?: number;
  prefillDepthSlowdown?: number;
  faOffDepthFactor?: number;
  ubatchExponent?: number;
  kvDecodeFactor?: Record<string, number>;
  spillFactor?: number;
  offloadPenalty?: number;
  unifiedDecodeFactor?: number;
  eagerDecodeFactor?: number;
  blockSizeDecodeFactor?: Record<string, number>;
}

export interface MemoryPlan {
  cpuShare: number;
  needMiB: number;
  vramMiB: number;
  capacity?: number;
  outcome: 'ok' | 'spill' | 'oom' | 'kv-too-small' | 'busy';
}

export function memoryPlan(
  m: FakeMemory,
  o: { flavor: string; ctx: number; kvType?: string; ubatch?: number; nCpuMoe?: number; gpuLayers?: number; gpuMemoryUtilization?: number; eager?: boolean; blockSize?: number; graphSizes?: number[] },
): MemoryPlan;
export function speeds(
  p: FakeProfile,
  o: { depth: number; flashAttn?: string; kvType?: string; kvTypeV?: string; kvFormat?: string; ubatch?: number; spill?: boolean; cpuShare?: number; unified?: boolean; eager?: boolean; blockSize?: number },
): { decode: number; prefill: number };

export interface FakeEngineOptions {
  flavor?: 'llamacpp' | 'vllm' | 'sglang';
  host?: string;
  port?: number;
  model?: string;
  /** One model name (shorthand for `aliases: [alias]`). */
  alias?: string;
  /** llama.cpp `--alias a,b` / vLLM `--served-model-name a b`: all accepted, the first one reported. */
  aliases?: string[];
  ctx?: number;
  np?: number;
  flashAttn?: string;
  /** llama.cpp -ctk / -ctv, vLLM --kv-cache-dtype (memory model and speed). */
  kvType?: string;
  kvTypeV?: string;
  /** llama.cpp -ub, vLLM --max-num-batched-tokens. */
  ubatch?: number;
  batch?: number;
  nCpuMoe?: number;
  gpuLayers?: number;
  gpuMemoryUtilization?: number;
  eager?: boolean;
  profile?: FakeProfile;
  log?: (line: string) => void;
  stateFile?: string;
  coldMarker?: string;
  requireModelFile?: boolean;
  watchdog?: boolean;
  onFatal?: (code: number) => void;
  /** vLLM: reuse cached prompt prefixes (default true; --no-enable-prefix-caching). */
  prefixCaching?: boolean;
  /** vLLM: report usage.prompt_tokens_details.cached_tokens (--enable-prompt-tokens-details). */
  promptTokensDetails?: boolean;
  /** GPU KV cache size in tokens reported by vLLM (default 164816). */
  kvTokens?: number;
  /** llama.cpp --kv-unified (true) / --no-kv-unified (false); default: unified only with automatic slots. */
  kvUnified?: boolean;
  /** llama.cpp --cache-reuse N (accepted; a plain prefix is reused anyway). */
  cacheReuse?: number;
  /** vLLM --kv-cache-dtype fp8_e4m3 / fp8_e5m2 (kvType is then 'fp8'). */
  kvFormat?: string;
  /** vLLM --block-size. */
  blockSize?: number;
  /** vLLM CUDA graph capture sizes (--cuda-graph-sizes, cudagraph_capture_sizes of --compilation-config). */
  graphSizes?: number[];
  /** --api-key: other requests need `Authorization: Bearer <key>` (llama.cpp keeps /health and the model list public). */
  apiKey?: string;
}

export interface FakeEngine {
  readonly port: number;
  readonly url: string;
  readonly loaded: Promise<void>;
  readonly totalTokens: number;
  close(): Promise<void>;
}

export function readProfile(env?: Record<string, string | undefined>): FakeProfile;
export function tokenize(text: string, addSpecial?: boolean): number[];
export function piece(id: number): string;
export function detokenize(ids: number[]): string;
export function commonPrefix(a: readonly number[], b: readonly number[]): number;
export function startFakeEngine(opts?: FakeEngineOptions): Promise<FakeEngine>;
