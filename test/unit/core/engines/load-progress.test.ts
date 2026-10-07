import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LoadProgress } from '../../../../src/contract/events';
import { initialStage, LoadTracker, logMessage, parseLoadProgress } from '../../../../src/core/engines/shared/load-progress';
import { LineSplitter } from '../../../../src/core/process/runner';
import { VLLM_FIXTURES } from '../docker/helpers';

const vllmLog = (name: string) => readFileSync(path.join(VLLM_FIXTURES, name), 'utf8').split(/\r?\n/);

/** Every stage change of a whole log, in order (what the live screen would show). */
function stages(lines: readonly string[], kind: Parameters<typeof parseLoadProgress>[1]) {
  const seen: string[] = [];
  for (const l of lines) {
    const u = parseLoadProgress(l, kind);
    if (u && seen.at(-1) !== u.stage) seen.push(u.stage);
  }
  return seen;
}

describe('parseLoadProgress: vLLM', () => {
  it('follows a real-looking cold start from weights to "Application startup complete"', () => {
    expect(stages(vllmLog('ready-download.log'), 'vllm-docker')).toEqual(['weights', 'compile', 'memory-profile', 'kv-cache', 'cuda-graphs', 'warmup', 'api-server', 'ready']);
    expect(stages(vllmLog('ready-cached.log'), 'vllm-native')).toEqual(['weights', 'compile', 'memory-profile', 'kv-cache', 'cuda-graphs', 'warmup', 'api-server', 'ready']);
  });

  it('reads shard and CUDA graph counts, the last redraw when several share a line', () => {
    expect(
      parseLoadProgress(
        'Loading safetensors checkpoint shards:   0% Completed | 0/7 [00:00<?, ?it/s]Loading safetensors checkpoint shards:  43% Completed | 3/7 [00:04<00:05,  1.31s/it]',
        'vllm-docker',
      ),
    ).toEqual({ stage: 'weights', done: 3, total: 7, fraction: 3 / 7 });
    expect(parseLoadProgress('Capturing CUDA graphs (mixed prefill-decode, PIECEWISE):  45%|████▍     | 30/67 [00:01<00:01, 19.40it/s]', 'vllm-native')).toEqual({
      stage: 'cuda-graphs',
      done: 30,
      total: 67,
      fraction: 30 / 67,
    });
    expect(parseLoadProgress('Capturing CUDA graphs (decode, FULL):   0%|          | 0/0 [00:00<?, ?it/s]', 'vllm-native')).toEqual({ stage: 'cuda-graphs', done: 0, total: 0 });
    expect(parseLoadProgress('(EngineCore_DP0 pid=255) INFO 10-06 09:20:38 [gpu_model_runner.py:3480] Capturing cudagraphs for decoding', 'vllm-docker')).toEqual({ stage: 'cuda-graphs' });
  });

  it('keeps a short detail without the logger prefix', () => {
    expect(parseLoadProgress('(EngineCore_DP0 pid=255) INFO 10-06 09:20:23 [default_loader.py:267] Loading weights took 0.38 seconds', 'vllm-docker')).toEqual({
      stage: 'weights',
      fraction: 1,
      detail: 'Loading weights took 0.38 seconds',
    });
    expect(parseLoadProgress('INFO 10-06 09:20:33 [kv_cache_utils.py:1087] GPU KV cache size: 225,744 tokens', 'vllm-native')).toMatchObject({ stage: 'kv-cache', detail: 'GPU KV cache size: 225,744 tokens' });
    expect(parseLoadProgress('INFO 10-06 09:20:33 [gpu_worker.py:298] Memory profiling takes 4.12 seconds', 'vllm-native')).toMatchObject({ stage: 'memory-profile' });
    expect(parseLoadProgress('INFO 10-06 09:20:29 [backends.py:120] Compiling a graph for dynamic shape takes 12.3 s', 'vllm-native')).toMatchObject({ stage: 'compile' });
    expect(logMessage(`  ${'x'.repeat(300)}`)).toHaveLength(160);
  });

  it('unknown lines say nothing', () => {
    expect(parseLoadProgress('INFO:     127.0.0.1:50214 - "GET /health HTTP/1.1" 200 OK', 'vllm-docker')).toBeUndefined();
    expect(parseLoadProgress('anything', 'external')).toBeUndefined();
  });
});

describe('parseLoadProgress: llama.cpp', () => {
  // Modelled on llama-server b10997 (Windows, CUDA): see test/fakes/fake-engine/logs.mjs.
  const start = [
    'main: HTTP server is listening, hostname: 127.0.0.1, port: 8080, http threads: 31',
    'main: loading model',
    "srv    load_model: loading model 'C:/m/q.gguf'",
    'llama_model_loader: loaded meta data with 35 key-value pairs and 291 tensors from q.gguf (version GGUF V3 (latest))',
    'print_info: file type   = Q4_K - Medium',
    'load_tensors: loading model tensors, this can take a while... (mmap = true, direct_io = false)',
    'load_tensors: offloaded 33/33 layers to GPU',
    '.'.repeat(87),
    'llama_context: constructing llama_context',
    'llama_kv_cache: size = 1024.00 MiB (  8192 cells,  32 layers,  1/1 seqs), K (f16):  512.00 MiB, V (f16):  512.00 MiB',
    'common_init_from_params: warming up the model with an empty run - please wait ... (--no-warmup to disable)',
    'srv          init: initializing slots, n_slots = 1',
    'main: model loaded',
    'main: server is listening on http://127.0.0.1:8080 - starting the main loop',
  ];

  it('metadata → weights → KV cache → warm-up → slots → ready', () => {
    expect(stages(start, 'llamacpp-native')).toEqual(['metadata', 'weights', 'kv-cache', 'warmup', 'api-server', 'ready']);
    expect(stages(start, 'llamacpp-docker')).toEqual(['metadata', 'weights', 'kv-cache', 'warmup', 'api-server', 'ready']);
  });

  it('offloaded layers as detail, progress dots as a fraction (one per percent)', () => {
    expect(parseLoadProgress('load_tensors: offloaded 33/33 layers to GPU', 'llamacpp-native')).toEqual({ stage: 'weights', detail: 'offloaded 33/33 layers to GPU' });
    expect(parseLoadProgress('.'.repeat(50), 'llamacpp-native')).toEqual({ stage: 'weights', fraction: 0.5 });
    expect(parseLoadProgress('.'.repeat(120), 'llamacpp-native')).toEqual({ stage: 'weights', fraction: 1 });
    expect(parseLoadProgress('llama_new_context_with_model: n_ctx      = 8192', 'llamacpp-native')).toEqual({ stage: 'kv-cache' });
    expect(parseLoadProgress('slot launch_slot_: id  0 | task 3 | processing task', 'llamacpp-native')).toBeUndefined();
  });

  it('the stage before any engine line', () => {
    expect(initialStage('llamacpp-native')).toBe('starting');
    expect(initialStage('vllm-native')).toBe('starting');
    expect(initialStage('llamacpp-docker')).toBe('container');
    expect(initialStage('vllm-docker')).toBe('container');
  });
});

describe('LoadTracker', () => {
  it('starts at the container stage, never goes back, throttles within a stage and ends with ready', () => {
    let now = 1000;
    const sent: LoadProgress[] = [];
    const t = new LoadTracker({ kind: 'vllm-docker', t0: 1000, now: () => now, emit: (p) => sent.push(p), expectedMs: 45_000 });
    expect(sent).toEqual([{ stage: 'container', elapsedMs: 0, expectedMs: 45_000 }]);
    t.line('Loading safetensors checkpoint shards:   0% Completed | 0/4 [00:00<?, ?it/s]', 1100);
    // Same stage within 250 ms: kept, sent with the next line after the interval.
    t.line('Loading safetensors checkpoint shards:  25% Completed | 1/4 [00:01<00:03,  1.00it/s]', 1200);
    t.line('INFO:     some unrelated line', 1400);
    t.line('Loading safetensors checkpoint shards:  50% Completed | 2/4 [00:02<00:02,  1.00it/s]', 1450);
    expect(sent.map((p) => [p.stage, p.done, p.elapsedMs])).toEqual([
      ['container', undefined, 0],
      ['weights', 0, 100],
      ['weights', 1, 400],
    ]);
    expect(t.current()).toMatchObject({ stage: 'weights', done: 2, total: 4 });
    // An earlier stage never comes back.
    now = 1500;
    t.line('GPU KV cache size: 225,744 tokens', 1500);
    t.line('Loading weights took 0.38 seconds', 1600);
    expect(t.current()).toMatchObject({ stage: 'kv-cache', detail: 'GPU KV cache size: 225,744 tokens', expectedMs: 45_000 });
    t.line('Application startup complete.', 1900);
    expect(t.finished).toBe(true);
    expect(sent.at(-1)).toEqual({ stage: 'ready', elapsedMs: 900, expectedMs: 45_000 });
    const count = sent.length;
    t.line('Capturing CUDA graphs', 2000);
    t.ready(2100);
    expect(sent).toHaveLength(count);
  });

  it('ready() from the caller, with the default clock and without an expected time', () => {
    let now = 0;
    const sent: LoadProgress[] = [];
    const t = new LoadTracker({ kind: 'llamacpp-native', t0: 0, now: () => now, emit: (p) => sent.push(p), intervalMs: 0 });
    now = 10;
    t.line('llama_model_loader: loaded meta data with 35 key-value pairs');
    now = 20;
    t.line('load_tensors: offloaded 33/33 layers to GPU');
    t.line('load_tensors:        CUDA0 model buffer size =  3850.00 MiB');
    expect(sent.map((p) => p.stage)).toEqual(['starting', 'metadata', 'weights', 'weights']);
    // Details of the stage stay until something newer replaces them.
    expect(sent.at(-1)).toEqual({ stage: 'weights', elapsedMs: 20, detail: 'offloaded 33/33 layers to GPU' });
    now = 50;
    t.ready();
    expect(sent.at(-1)).toEqual({ stage: 'ready', elapsedMs: 50 });
  });

  it('a progress bar redrawn with CR reaches the tracker one redraw at a time', () => {
    const splitter = new LineSplitter();
    const lines = [
      ...splitter.push('Loading safetensors checkpoint shards:   0% Completed | 0/2 [00:00<?, ?it/s]\rLoading safetensors checkpoint shards:  50% Completed | 1/2 [00:01<00:01,  1.00it/s]\r'),
      ...splitter.push('Loading safetensors checkpoint shards: 100% Completed | 2/2 [00:02<00:00,  1.00it/s]\n'),
    ];
    expect(lines.map((l) => parseLoadProgress(l, 'vllm-native')?.done)).toEqual([0, 1, 2]);
  });
});
