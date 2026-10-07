// Log lines modelled on real llama-server b10997 (Windows, CUDA) and vLLM 0.x output.
// The core's phase detection and failure diagnosis are tested against these, so keep them
// faithful to the real wording (see src/core/engines/llamacpp-native/logs.ts).
import path from 'node:path';

/**
 * @typedef {object} LlamaLogCtx
 * @property {string} model
 * @property {string} host
 * @property {number} port
 * @property {number} ctx
 * @property {number} np
 * @property {number} nLayers
 * @property {number} vramMiB
 * @property {string} flashAttn
 */

/** @param {LlamaLogCtx} c */
export function llamaBanner(c) {
  const dir = path.dirname(process.argv[1] ?? '.');
  return [
    'ggml_cuda_init: found 1 CUDA devices (Total VRAM: 32606 MiB):',
    '  Device 0: NVIDIA GeForce RTX 5090, compute capability 12.0, VMM: yes, VRAM: 32606 MiB',
    `load_backend: loaded CUDA backend from ${path.join(dir, 'ggml-cuda.dll')}`,
    `load_backend: loaded CPU backend from ${path.join(dir, 'ggml-cpu-zen4.dll')}`,
    'build: 10997 (fccf7166f) with Clang 20.1.8 for Windows x86_64',
    'system info: n_threads = 16, n_threads_batch = 16, total_threads = 32',
    '',
    'system_info: n_threads = 16 (n_threads_batch = 16) / 32 | CUDA : ARCHS = 750,800,860,890,1200 | FORCE_MMQ = 1 | USE_GRAPHS = 1 | PEER_MAX_BATCH_SIZE = 128 | CPU : SSE3 = 1 | SSSE3 = 1 | AVX = 1 | AVX2 = 1 | F16C = 1 | FMA = 1 | AVX512 = 1 | OPENMP = 1 | REPACK = 1 |',
    '',
    'Running without SSL',
    'init: using 31 threads for HTTP server',
    'main: binding port with default address family',
  ];
}

/** @param {LlamaLogCtx} c */
export function llamaBindFailed(c) {
  return [
    `main: couldn't bind HTTP server socket, hostname: ${c.host}, port: ${c.port}`,
    'main: exiting due to HTTP server error',
  ];
}

/** @param {LlamaLogCtx} c */
export function llamaListening(c) {
  return [`main: HTTP server is listening, hostname: ${c.host}, port: ${c.port}, http threads: 31`, 'main: loading model'];
}

/** @param {LlamaLogCtx} c */
export function llamaModelMeta(c) {
  return [
    `srv    load_model: loading model '${c.model}'`,
    'llama_model_load_from_file_impl: using device CUDA0 (NVIDIA GeForce RTX 5090) (0000:01:00.0) - 30843 MiB free',
    `llama_model_loader: loaded meta data with 35 key-value pairs and 291 tensors from ${c.model} (version GGUF V3 (latest))`,
    'llama_model_loader: Dumping metadata keys/values. Note: KV overrides do not apply in this output.',
    'llama_model_loader: - kv   0:                       general.architecture str              = llama',
    'print_info: file format = GGUF V3 (latest)',
    'print_info: file type   = Q4_K - Medium',
    `print_info: file size   = ${(c.vramMiB / 1024).toFixed(2)} GiB (4.89 BPW)`,
    'load: special tokens cache size = 256',
    'load: token to piece cache size = 0.7999 MB',
  ];
}

/** @param {LlamaLogCtx} c */
export function llamaLoadTensorsStart(c) {
  return [
    'load_tensors: loading model tensors, this can take a while... (mmap = true, direct_io = false)',
    `load_tensors: offloading ${c.nLayers - 1} repeating layers to GPU`,
    'load_tensors: offloading output layer to GPU',
    `load_tensors: offloaded ${c.nLayers}/${c.nLayers} layers to GPU`,
    `load_tensors:        CUDA0 model buffer size = ${(c.vramMiB * 0.85).toFixed(2)} MiB`,
    'load_tensors:   CPU_Mapped model buffer size =   281.81 MiB',
  ];
}

/** Printed when a CUDA allocation fails while loading the weights. */
export function llamaOom(c) {
  const bytes = Math.round(c.vramMiB * 1024 * 1024 * 0.85);
  return [
    `ggml_backend_cuda_buffer_type_alloc_buffer: allocating ${(c.vramMiB * 0.85).toFixed(2)} MiB on device 0: cudaMalloc failed: out of memory`,
    `alloc_tensor_range: failed to allocate CUDA0 buffer of size ${bytes}`,
    'llama_model_load: error loading model: unable to allocate CUDA0 buffer',
    'llama_model_load_from_file_impl: failed to load model',
    `common_init_from_params: failed to load model '${c.model}'`,
    `srv    load_model: failed to load model, '${c.model}'`,
    'srv   operator(): operator(): cleaning up before exit...',
    'main: exiting due to model loading error',
  ];
}

export function llamaMissingModel(c) {
  return [
    `gguf_init_from_file: failed to open GGUF file '${c.model}' (No such file or directory)`,
    `llama_model_load: error loading model: llama_model_loader: failed to load model from ${c.model}`,
    'llama_model_load_from_file_impl: failed to load model',
    `common_init_from_params: failed to load model '${c.model}'`,
    `srv    load_model: failed to load model, '${c.model}'`,
    'srv   operator(): operator(): cleaning up before exit...',
    'main: exiting due to model loading error',
  ];
}

/** @param {LlamaLogCtx} c */
export function llamaContext(c) {
  const kv = Math.round((c.ctx / 4096) * 512);
  return [
    '.......................................................................................',
    'llama_context: constructing llama_context',
    `llama_context: n_seq_max     = ${c.np}`,
    `llama_context: n_ctx         = ${c.ctx}`,
    `llama_context: n_ctx_seq     = ${c.ctx}`,
    'llama_context: n_batch       = 2048',
    'llama_context: n_ubatch      = 512',
    'llama_context: causal_attn   = 1',
    `llama_context: flash_attn    = ${c.flashAttn}`,
    'llama_context: kv_unified    = false',
    'llama_context: freq_base     = 500000.0',
    'llama_context:  CUDA_Host  output buffer size =     0.49 MiB',
    `llama_kv_cache:      CUDA0 KV buffer size = ${kv.toFixed(2)} MiB`,
    `llama_kv_cache: size = ${kv.toFixed(2)} MiB (${c.ctx} cells,  32 layers,  ${c.np}/${c.np} seqs), K (${c.kvType ?? 'f16'}):  ${(kv / 2).toFixed(2)} MiB, V (${c.kvType ?? 'f16'}):  ${(kv / 2).toFixed(2)} MiB`,
    'llama_context:      CUDA0 compute buffer size =   296.00 MiB',
    'llama_context:  CUDA_Host compute buffer size =    16.01 MiB',
    'llama_context: graph nodes  = 1095',
    'llama_context: graph splits = 2',
  ];
}

export function llamaWarmup() {
  return ['common_init_from_params: warming up the model with an empty run - please wait ... (--no-warmup to disable)'];
}

/** @param {LlamaLogCtx} c */
export function llamaReady(c) {
  const lines = [`srv          init: initializing slots, n_slots = ${c.np}`];
  for (let i = 0; i < c.np; i++) lines.push(`slot         init: id  ${i} | task -1 | new slot, n_ctx = ${c.ctx}`);
  lines.push(
    'srv          init: prompt cache is enabled, size limit: 8192 MiB',
    'main: model loaded',
    'main: chat template, chat_template: llama3, example_format: \'<|start_header_id|>system<|end_header_id|>\n\nYou are a helpful assistant<|eot_id|>\'',
    `main: server is listening on http://${c.host}:${c.port} - starting the main loop`,
    'srv  update_slots: all slots are idle',
  );
  return lines;
}

export function llamaTaskStart(slot, task, nPrompt, ctx) {
  return [
    `slot launch_slot_: id  ${slot} | task ${task} | processing task`,
    `slot update_slots: id  ${slot} | task ${task} | new prompt, n_ctx_slot = ${ctx}, n_keep = 0, task.n_tokens = ${nPrompt}`,
  ];
}

export function llamaTaskDone(slot, task, t) {
  const pp = (t.promptMs / Math.max(1, t.promptN)).toFixed(2);
  const tg = (t.predictedMs / Math.max(1, t.predictedN)).toFixed(2);
  return [
    `slot print_timing: id  ${slot} | task ${task} | `,
    `prompt eval time = ${t.promptMs.toFixed(2)} ms / ${t.promptN} tokens (${pp} ms per token, ${((t.promptN / Math.max(t.promptMs, 0.001)) * 1000).toFixed(2)} tokens per second)`,
    `       eval time = ${t.predictedMs.toFixed(2)} ms / ${t.predictedN} tokens (${tg} ms per token, ${((t.predictedN / Math.max(t.predictedMs, 0.001)) * 1000).toFixed(2)} tokens per second)`,
    `      total time = ${(t.promptMs + t.predictedMs).toFixed(2)} ms / ${t.promptN + t.predictedN} tokens`,
    `slot      release: id  ${slot} | task ${task} | stop processing: n_tokens = ${t.promptN + t.predictedN}, truncated = 0`,
    'srv  update_slots: all slots are idle',
  ];
}

export function llamaBadFlag(flag) {
  return [`error: invalid argument: ${flag}`];
}

export function llamaBadValue(flag) {
  return [
    `error while handling argument "${flag}": invalid value`,
    '',
    'usage:',
    "-fa,   --flash-attn [on|off|auto]       set Flash Attention use ('on', 'off', or 'auto', default: 'auto')",
    '',
    'to show complete usage, run with -h',
  ];
}

export function llamaCrash() {
  return [
    'CUDA error: an illegal memory access was encountered',
    '  current device: 0, in function ggml_backend_cuda_synchronize at ggml-cuda.cu:2690',
    '  cudaStreamSynchronize(cuda_ctx->stream())',
  ];
}

// ---------------------------------------------------------------------------------- vLLM

const ts = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

export function vllmBanner(c) {
  return [
    `INFO ${ts()} [__init__.py:241] Automatically detected platform cuda.`,
    `INFO ${ts()} [api_server.py:1805] vLLM API server version 0.12.0`,
    `INFO ${ts()} [utils.py:326] non-default args: {'model': '${c.model}', 'host': '${c.host}', 'port': ${c.port}}`,
    `INFO ${ts()} [config.py:1604] Using max model len ${c.ctx}`,
    `INFO ${ts()} [core.py:71] Initializing a V1 LLM engine (v0.12.0) with config: model='${c.model}'`,
    `INFO ${ts()} [gpu_model_runner.py:1953] Starting to load model ${c.model}...`,
  ];
}

export function vllmWeights(seconds) {
  return [`INFO ${ts()} [default_loader.py:267] Loading weights took ${seconds.toFixed(2)} seconds`];
}

export function vllmModelLoaded(c, seconds) {
  return [
    `INFO ${ts()} [gpu_model_runner.py:2007] Model loading took ${(c.vramMiB / 1024).toFixed(4)} GiB and ${seconds.toFixed(6)} seconds`,
    `INFO ${ts()} [gpu_worker.py:276] Available KV cache memory: 20.12 GiB`,
    `INFO ${ts()} [kv_cache_utils.py:849] GPU KV cache size: ${(c.kvCapacity ?? 164816).toLocaleString('en-US')} tokens`,
  ];
}

export function vllmReady(c, seconds) {
  return [
    `INFO ${ts()} [core.py:214] init engine (profile, create kv cache, warmup model) took ${seconds.toFixed(2)} seconds`,
    `INFO ${ts()} [api_server.py:1600] Starting vLLM API server 0 on http://${c.host}:${c.port}`,
    'INFO:     Started server process [' + process.pid + ']',
    'INFO:     Waiting for application startup.',
    'INFO:     Application startup complete.',
  ];
}

export function vllmNoKernelImage() {
  return [
    `ERROR ${ts()} [core.py:700] EngineCore failed to start.`,
    'Traceback (most recent call last):',
    '  File "/usr/local/lib/python3.12/dist-packages/vllm/v1/engine/core.py", line 691, in run_engine_core',
    'torch.AcceleratorError: CUDA error: no kernel image is available for execution on the device',
    'CUDA kernel errors might be asynchronously reported at some other API call, so the stacktrace below might be incorrect.',
    'RuntimeError: Engine core initialization failed. See root cause above. Failed core proc(s): {}',
  ];
}

export function vllmOom() {
  return [
    `ERROR ${ts()} [core.py:700] EngineCore failed to start.`,
    'torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB. GPU 0 has a total capacity of 31.84 GiB of which 1.10 GiB is free.',
    'RuntimeError: Engine core initialization failed. See root cause above. Failed core proc(s): {}',
  ];
}

/** max-model-len longer than the KV cache holds (the real wording of vLLM's check). */
export function vllmKvTooSmall(c) {
  return [
    `ERROR ${ts()} [core.py:700] EngineCore failed to start.`,
    `ValueError: To serve at least one request with the models's max seq len (${c.ctx}), (2.50 GiB KV cache is needed, which is larger than the available KV cache memory (1.25 GiB). Based on the available memory, the estimated maximum model length is ${c.kvCapacity}. Try increasing \`gpu_memory_utilization\` or decreasing \`max_model_len\` when initializing the engine.`,
    'RuntimeError: Engine core initialization failed. See root cause above. Failed core proc(s): {}',
  ];
}

export function vllmPortInUse(c) {
  return [`OSError: [Errno 98] error while attempting to bind on address ('${c.host}', ${c.port}): address already in use`];
}
