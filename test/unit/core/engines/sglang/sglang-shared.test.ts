import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { launchParamsSchema } from '../../../../../src/contract/engines';
import { parseKvCapacity } from '../../../../../src/core/engines/shared/kv-capacity';
import { LoadTracker, parseLoadProgress } from '../../../../../src/core/engines/shared/load-progress';
import {
  diagnoseSglang,
  parseSglangVersion,
  SGLANG_LONGER_CONTEXT_ENV,
  sglangEnv,
  sglangKvCapacity,
  sglangKvDtype,
  sglangPhaseOf,
  sglangProgress,
  sglangServeArgs,
} from '../../../../../src/core/engines/shared/sglang';
import { FlagGate, trustedFlags } from '../../../../../src/core/engines/shared/standard-flags';
import { parseVllmHelp, probeArgparseHelp } from '../../../../../src/core/engines/shared/vllm-help';

const FIX = (name: string) => readFileSync(fileURLToPath(new URL(`../../../../fixtures/sglang/${name}`, import.meta.url)), 'utf8');
const lines = (name: string) => FIX(name).split(/\r?\n/).filter(Boolean);
const P = (o: object = {}) => launchParamsSchema.parse(o);
const exit = { code: 1, signal: null };

describe('SGLang command line', () => {
  it('passes everything explicitly, with the KV dtype SGLang knows', () => {
    const args = sglangServeArgs(
      P({ contextSize: 8192, gpuMemoryUtilization: 0.8, parallel: 4, kvCacheType: 'q8_0', batchSize: 4096, dtype: 'bfloat16', quantization: 'fp8', extraArgs: ['--page-size', '16'] }),
      { model: 'Qwen/Qwen3-8B', host: '0.0.0.0', port: 30000, servedName: 'gpubench-1', revision: 'abc' },
    );
    expect(args).toEqual([
      '--model-path', 'Qwen/Qwen3-8B', '--revision', 'abc', '--served-model-name', 'gpubench-1', '--host', '0.0.0.0', '--port', '30000',
      '--context-length', '8192', '--mem-fraction-static', '0.8', '--max-running-requests', '4', '--kv-cache-dtype', 'fp8_e5m2',
      '--chunked-prefill-size', '4096', '--random-seed', '0', '--enable-cache-report', '--dtype', 'bfloat16', '--quantization', 'fp8', '--page-size', '16',
    ]);
    // maxModelLen wins over contextSize; defaults are explicit too.
    const d = sglangServeArgs(P({ maxModelLen: 2048, contextSize: 9999 }), { model: '/m', host: 'h', port: 1, servedName: 's' });
    expect(d).toEqual(['--model-path', '/m', '--served-model-name', 's', '--host', 'h', '--port', '1', '--context-length', '2048', '--mem-fraction-static', '0.85', '--random-seed', '0', '--enable-cache-report']);
    expect(sglangServeArgs(P(), { model: '/m', host: 'h', port: 1, servedName: 's' })).toContain('4096');
  });

  it('maps the KV cache request', () => {
    expect(sglangKvDtype(P({ kvCacheType: 'auto' }))).toBe('auto');
    expect(sglangKvDtype(P({ kvCacheType: 'fp8' }))).toBe('fp8_e5m2');
    expect(sglangKvDtype(P({ kvCacheType: 'q4_0' }))).toBe('fp8_e5m2');
    expect(sglangKvDtype(P({ kvCacheType: 'f16' }))).toBeUndefined();
    expect(sglangKvDtype(P({ kvCacheType: 'fp8', extraArgs: ['--kv-cache-dtype', 'fp8_e4m3'] }))).toBeUndefined();
  });

  it('extends the context with --json-model-override-args and allows the longer context', () => {
    const p = P({ contextSize: 131072, ropeScaling: { type: 'yarn', factor: 4, originalContext: 32768 }, env: { A: '1' } });
    const args = sglangServeArgs(p, { model: '/m', host: 'h', port: 1, servedName: 's' });
    expect(args.slice(args.indexOf('--json-model-override-args'), args.indexOf('--json-model-override-args') + 2)).toEqual([
      '--json-model-override-args',
      '{"rope_scaling":{"rope_type":"yarn","factor":4,"original_max_position_embeddings":32768}}',
    ]);
    expect(sglangEnv(p)).toEqual({ [SGLANG_LONGER_CONTEXT_ENV]: '1', A: '1' });
    expect(sglangEnv(P({ env: { B: '2' } }))).toEqual({ B: '2' });
  });

  it('leaves out what a fork lacks and refuses one without a required flag', () => {
    const help = parseVllmHelp(FIX('help.stdout.txt'));
    const known = new Set([...help.flags].filter((f) => f !== '--chunked-prefill-size' && f !== '--enable-cache-report'));
    const gate = new FlagGate('sglang', trustedFlags('sglang', known));
    const args = sglangServeArgs(P({ batchSize: 4096 }), { model: '/m', host: 'h', port: 1, servedName: 's' }, gate);
    expect(args).not.toContain('--chunked-prefill-size');
    expect(gate.missing).toEqual([
      { flag: '--chunked-prefill-size', setting: 'batchSize', effect: 'default' },
      { flag: '--enable-cache-report', setting: 'cacheReport', effect: 'default' },
    ]);
    const noServedName = new Set([...help.flags].filter((f) => f !== '--served-model-name'));
    // Without a required flag the help is not trusted (nothing is left out)…
    expect(trustedFlags('sglang', noServedName)).toBeUndefined();
    // …and a gate that knows the options refuses the launch.
    expect(() => sglangServeArgs(P(), { model: '/m', host: 'h', port: 1, servedName: 's' }, new FlagGate('sglang', new Set(['--model-path'])))).toThrow(
      expect.objectContaining({ code: 'ENGINE_BAD_FLAG', params: { flag: '--served-model-name', reason: 'required_flag_missing' } }),
    );
  });
});

describe('SGLang help', () => {
  it('lists every option and the KV choices', () => {
    const help = parseVllmHelp(FIX('help.stdout.txt'));
    expect(help.flags.has('--model-path') && help.flags.has('--model') && help.flags.has('--tp-size') && help.flags.has('--tensor-parallel-size')).toBe(true);
    expect(help.choices['--kv-cache-dtype']).toEqual(['auto', 'fp8_e5m2', 'fp8_e4m3', 'bf16', 'bfloat16', 'nvfp4']);
    expect(trustedFlags('sglang', help.flags)).toBe(help.flags);
  });

  it('runs one plain --help, never the server', async () => {
    const calls: number[] = [];
    const ok = await probeArgparseHelp(async () => {
      calls.push(1);
      return { code: 0, stdout: FIX('help.stdout.txt'), stderr: '' };
    });
    expect(ok.flags.size).toBeGreaterThan(20);
    expect(calls).toHaveLength(1);
    expect((await probeArgparseHelp(async () => ({ code: 2, stdout: '', stderr: 'error' }))).flags.size).toBe(0);
    expect((await probeArgparseHelp(async () => ({ code: 0, stdout: 'nothing', stderr: '' }))).flags.size).toBe(0);
    expect((await probeArgparseHelp(() => Promise.reject(new Error('spawn')))).flags.size).toBe(0);
  });
});

describe('SGLang start log', () => {
  it('marks the phases', () => {
    const marks = lines('ready.log')
      .map(sglangPhaseOf)
      .filter((p) => p !== undefined);
    expect([...new Set(marks)]).toEqual(['engine_init', 'load_tensors', 'kv_cache', 'graph_capture', 'api_start', 'warmup']);
  });

  it('follows the load stage by stage', () => {
    const seen: string[] = [];
    let t = 0;
    const tracker = new LoadTracker({ kind: 'sglang-docker', t0: 0, now: () => t, emit: (p) => seen.push(`${p.stage}${p.done !== undefined ? ` ${p.done}/${p.total}` : ''}`), intervalMs: 0 });
    for (const l of lines('ready.log')) {
      t += 10;
      tracker.line(l);
    }
    expect(seen[0]).toBe('container');
    expect(seen).toContain('weights 3/5');
    expect(seen).toContain('cuda-graphs 11/11');
    expect(seen).toContain('kv-cache');
    expect(seen).toContain('api-server');
    expect(seen.at(-1)).toBe('ready');
    expect(parseLoadProgress('[x] Load weight end. type=Q', 'sglang-native')).toMatchObject({ stage: 'weights', fraction: 1 });
    expect(sglangProgress('[2025-10-01 10:00:12 TP0] Capture cuda graph end. Time elapsed: 1 s.')).toMatchObject({ stage: 'cuda-graphs', fraction: 1, detail: 'Capture cuda graph end. Time elapsed: 1 s.' });
    expect(sglangProgress('Capturing batches (bs=1): 0%|          | 0/0 [00:00<?, ?it/s]')).toEqual({ stage: 'cuda-graphs', done: 0, total: 0 });
    expect(sglangProgress('Loading safetensors checkpoint shards:   0% Completed | 0/0 [00:00<?, ?it/s]')).toEqual({ stage: 'weights', done: 0, total: 0 });
    expect(sglangProgress('nothing to see')).toBeUndefined();
    // External endpoints and command programs say nothing LLM Bench knows.
    expect(parseLoadProgress('Load weight begin', 'command')).toBeUndefined();
  });

  it('reads the KV capacity', () => {
    expect(sglangKvCapacity(lines('ready.log'))).toEqual({ tokens: 89472 });
    expect(parseKvCapacity(lines('ready.log'), 'sglang-docker')).toEqual({ tokens: 89472 });
    expect(sglangKvCapacity(['[x] KV Cache is allocated. #tokens: 5000, K size: 1 GB'])).toEqual({ tokens: 5000 });
    expect(sglangKvCapacity(['max_total_num_tokens=7000, chunked', '[x] KV Cache is allocated. #tokens: 5000, K'])).toEqual({ tokens: 7000 });
    expect(sglangKvCapacity(['max_total_num_tokens=0, x'])).toBeUndefined();
    expect(parseKvCapacity(['anything'], 'command')).toBeUndefined();
  });

  it('reads the version', () => {
    expect(parseSglangVersion('warning: something\n0.5.21\n')).toBe('0.5.21');
    expect(parseSglangVersion('0.5.4.post1')).toBe('0.5.4.post1');
    expect(parseSglangVersion('Traceback\nModuleNotFoundError')).toBeUndefined();
  });
});

describe('SGLang failures', () => {
  it('names the cause', () => {
    expect(diagnoseSglang(lines('oom.log'), exit)).toMatchObject({ code: 'ENGINE_OOM' });
    expect(diagnoseSglang(lines('mem-fraction.log'), exit)).toMatchObject({ code: 'ENGINE_OOM', params: { reason: 'mem-fraction' } });
    expect(diagnoseSglang(lines('context.log'), exit)).toMatchObject({ code: 'MODEL_TOO_LARGE', params: { reason: 'context', maxModelLen: 131072, modelMaxLen: 40960 } });
    expect(diagnoseSglang(lines('arch.log'), exit)).toMatchObject({ code: 'ENGINE_MODEL_UNSUPPORTED', params: { engine: 'SGLang', reason: 'architecture', value: 'BonsaiTernaryForCausalLM' } });
    expect(diagnoseSglang(['ValueError: Unsupported architectures: Qwen9ForCausalLM'], exit)).toMatchObject({ code: 'ENGINE_MODEL_UNSUPPORTED', params: { value: 'Qwen9ForCausalLM' } });
    expect(diagnoseSglang(['RuntimeError: CUDA error: no kernel image is available for execution on the device'], exit)).toMatchObject({ code: 'ENGINE_NO_KERNEL_IMAGE' });
    expect(diagnoseSglang(['Error: spawn /x/python ENOENT'], exit)).toMatchObject({ code: 'ENGINE_START_FAILED' });
    expect(diagnoseSglang(["ModuleNotFoundError: No module named 'sglang'"], exit)).toMatchObject({ code: 'ENGINE_NOT_INSTALLED', params: { reason: 'sglang_missing' } });
    expect(diagnoseSglang(['huggingface_hub.errors.GatedRepoError: 401 https://huggingface.co/meta/llama/resolve/main/config.json'], exit)).toMatchObject({
      code: 'HF_AUTH_REQUIRED',
      params: { repo: 'meta/llama' },
    });
    expect(diagnoseSglang(['RepositoryNotFoundError: 404'], exit, { repo: 'a/b' })).toMatchObject({ code: 'HF_NOT_FOUND', params: { repo: 'a/b' } });
    expect(diagnoseSglang(['RepositoryNotFoundError: 404'], exit)).toMatchObject({ code: 'HF_NOT_FOUND' });
    expect(diagnoseSglang(['launch_server.py: error: unrecognized arguments: --nope'], exit)).toMatchObject({ code: 'ENGINE_BAD_FLAG', params: { flag: '--nope' } });
    expect(diagnoseSglang(["launch_server.py: error: argument --kv-cache-dtype: invalid choice: 'x'"], exit)).toMatchObject({ code: 'ENGINE_BAD_FLAG', params: { flag: '--kv-cache-dtype' } });
    expect(diagnoseSglang(['OSError: [Errno 98] address already in use'], exit)).toMatchObject({ code: 'ENGINE_PORT_IN_USE' });
    expect(diagnoseSglang(['RuntimeError: The NVIDIA driver on your system is too old'], exit)).toMatchObject({ code: 'DRIVER_TOO_OLD' });
    expect(diagnoseSglang(['RuntimeError: No CUDA GPUs are available'], exit, { docker: true })).toMatchObject({ code: 'DOCKER_NO_GPU' });
    expect(diagnoseSglang(['RuntimeError: No CUDA GPUs are available'], exit)).toMatchObject({ code: 'GPU_NOT_FOUND' });
    expect(diagnoseSglang(['bye'], { code: null, signal: 'SIGKILL' })).toMatchObject({ code: 'ENGINE_EXITED', params: { code: 'SIGKILL' } });
  });
});
