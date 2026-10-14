import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { launchParamsSchema } from '../../../../../src/contract/engines';
import { ninferBenchParams, ninferServeArgs } from '../../../../../src/core/engines/ninfer/args';
import { diagnoseNinfer, ninferKvCapacity, ninferMemoryReport, ninferMessage, ninferProgress, parseNinferThroughput, PID_LINE, sizeMiB } from '../../../../../src/core/engines/ninfer/logs';
import { NINFER_FIXTURES } from './helpers';

const lines = (file: string) => readFileSync(path.join(NINFER_FIXTURES, file), 'utf8').split(/\r?\n/).filter(Boolean);
const SERVE = lines('serve-nvfp4-int8.log');
const OOM = lines('serve-oom.log');
const exit = { code: 1, signal: null };

describe('ninfer-serve arguments', () => {
  const opts = { model: '/models/q.ninfer', host: '127.0.0.1', port: 18090, modelId: 'gpubench-1' };

  it('maps the launch settings, concurrency capped at 8, extra arguments last', () => {
    const params = launchParamsSchema.parse({ contextSize: 65_536, parallel: 12, extraArgs: ['--log-stats-interval-ms', '1000'], ninfer: { kvDtype: 'int8', spec: 'mtp' } });
    expect(ninferServeArgs(params, opts)).toEqual([
      '/models/q.ninfer',
      '--host',
      '127.0.0.1',
      '--port',
      '18090',
      '--model-id',
      'gpubench-1',
      '--max-context',
      '65536',
      '--max-concurrency',
      '8',
      '--kv-dtype',
      'int8',
      '--spec',
      'mtp',
      '--draft-tokens',
      '3',
      '--log-stats-interval-ms',
      '1000',
    ]);
    expect(ninferServeArgs(launchParamsSchema.parse({}), opts)).toEqual(['/models/q.ninfer', '--host', '127.0.0.1', '--port', '18090', '--model-id', 'gpubench-1']);
  });

  it('benchmarks read every prompt in full unless they measure conversations; reasoning as the launch says', () => {
    expect(ninferBenchParams(undefined, { conversations: false })).toEqual({ prefixReuse: false });
    expect(ninferBenchParams({ kvDtype: 'fp8' }, { conversations: true })).toEqual({ kvDtype: 'fp8', prefixReuse: true });
    expect(ninferBenchParams({ prefixReuse: true, thinking: false }, { conversations: false })).toEqual({ prefixReuse: true, thinking: false });
  });

  it('reasoning and vision, shared by every engine: --no-thinking when off, --vision where the artifact packs it', () => {
    const args = (p: object, hasVision = false) => ninferServeArgs(launchParamsSchema.parse(p), { ...opts, hasVision }).slice(7);
    expect(args({})).toEqual([]);
    expect(args({}, true)).toEqual(['--vision']);
    expect(args({ vision: false, reasoning: false }, true)).toEqual(['--no-thinking']);
    expect(args({ reasoning: true, ninfer: { thinking: false } })).toEqual([]);
    // NInfer's own older settings hold when the shared ones are not set.
    expect(args({ ninfer: { thinking: false, vision: true } })).toEqual(['--vision', '--no-thinking']);
    expect(args({ vision: true })).toEqual([]);
  });
});

describe('ninfer-serve logs', () => {
  it('strips the timestamp and level', () => {
    expect(ninferMessage('2026-09-28 12:32:52.531  INFO  starting engine')).toBe('starting engine');
    expect(ninferMessage('2026-09-28 12:32:52  WARN  slow')).toBe('slow');
    expect(ninferMessage('  plain line ')).toBe('plain line');
  });

  it('reads sizes in MiB', () => {
    expect(sizeMiB('5.95 GiB')).toBe(6092.8);
    expect(sizeMiB('512 MiB')).toBe(512);
    expect(sizeMiB('2048 KiB')).toBe(2);
    expect(sizeMiB('1048576 B')).toBe(1);
    expect(sizeMiB('many')).toBeUndefined();
  });

  it('follows the start, stage by stage', () => {
    const stages = SERVE.map(ninferProgress).filter((u) => u !== undefined);
    expect(stages.map((u) => u.stage)).toEqual(['starting', 'weights', 'weights', 'kv-cache', 'kv-cache', 'kv-cache', 'kv-cache', 'cuda-graphs', 'warmup', 'warmup', 'warmup', 'warmup', 'api-server']);
    expect(stages[2]).toMatchObject({ fraction: 1 });
    expect(stages.find((u) => u.detail?.startsWith('engine ready'))).toMatchObject({ stage: 'warmup', fraction: 1 });
    expect(ninferProgress('2026-09-28 12:33:00.000  INFO  loading weights | 9.0/20.0 GiB')).toMatchObject({ stage: 'weights', fraction: 0.45 });
    expect(ninferProgress('2026-09-28 12:33:00.000  INFO  loading weights | 45%')).toMatchObject({ stage: 'weights', fraction: 0.45 });
    expect(ninferProgress('2026-09-28 12:32:52.531  INFO  loading weights | 0/0 GiB')?.fraction).toBeUndefined();
    expect(ninferProgress('2026-09-28 12:32:52.531  INFO  capturing CUDA graphs | 12/40')).toMatchObject({ stage: 'cuda-graphs' });
    expect(ninferProgress('2026-09-28 12:32:52.531  INFO  req#1 started')).toBeUndefined();
  });

  it('reads the KV pool and NInfer\'s own memory account', () => {
    expect(ninferKvCapacity(SERVE)).toEqual({ tokens: 131_072 });
    expect(ninferKvCapacity(['capacity | KV 0 tokens, int8, auto'])).toBeUndefined();
    expect(ninferKvCapacity([])).toBeUndefined();
    expect(ninferMemoryReport(SERVE)).toEqual({ weightsMiB: 20_480, kvTokens: 131_072, kvDtype: 'int8', kvMode: 'explicit', runtimeMiB: 6092.8, freeMiB: 3409.92 });
    expect(ninferMemoryReport(['2026-09-28 12:33:02.716  INFO  capacity | KV 65,536 tokens, fp8, auto'])).toEqual({ kvTokens: 65_536, kvDtype: 'fp8', kvMode: 'auto' });
  });

  it("NInfer-all's start on the user's RTX 5090 (GGUF-NInfer Q6_K from /mnt/c, rk8v4): its stages, its load's progress, its memory", () => {
    const all = lines('serve-all-gguf-q6k.log');
    const stages = all.map(ninferProgress).filter((u) => u !== undefined);
    expect(stages.map((u) => u.stage)).toEqual(['starting', 'weights', 'weights', 'weights', 'kv-cache', 'kv-cache', 'cuda-graphs', 'warmup', 'warmup', 'api-server']);
    // "loading weights 13.4% | 2.87 GiB/21.5 GiB | 302.1 MiB/s | ETA 1m 3.1s"
    expect(stages[2]?.fraction).toBeCloseTo(0.134, 3);
    expect(stages[3]).toMatchObject({ fraction: 1 });
    expect(ninferKvCapacity(all)).toEqual({ tokens: 65_536 });
    expect(ninferMemoryReport(all)).toEqual({ weightsMiB: 22_016, kvTokens: 65_536, kvDtype: 'rk8v4', kvMode: 'explicit', runtimeMiB: 3061.76, freeMiB: 5457.92 });
  });

  it('reads the periodic throughput lines', () => {
    const t = SERVE.map(parseNinferThroughput).filter((x) => x !== undefined);
    expect(t[0]).toEqual({ intervalSec: 5, prefillTps: 16.8, decodeTps: 129.4, running: 1 });
    expect(parseNinferThroughput('2026-09-28 12:33:00.000  INFO  throughput | 5.0s | prefill 1.34k tok/s (6,698 tok)')).toEqual({ intervalSec: 5, prefillTps: 1340 });
    expect(parseNinferThroughput('2026-09-28 12:33:00.000  INFO  throughput | 5.0s')).toEqual({ intervalSec: 5 });
    expect(parseNinferThroughput('req#1 done')).toBeUndefined();
    expect(PID_LINE.exec('gpubench-pid 4242')?.[1]).toBe('4242');
  });
});

describe('why ninfer-serve stopped', () => {
  it('says how much context would have fit when the runtime reservation fails', () => {
    const e = diagnoseNinfer(OOM, exit, { kvTokens: 262_144, bytesPerToken: 35_904 });
    expect(e.code).toBe('ENGINE_OOM');
    expect(e.params).toEqual({ needMiB: 10_585, availableMiB: 10_441, reason: 'ninfer-reservation', estimatedMaxModelLen: 257_024 });
    // Without the pool's size, or when nothing would fit, no estimate.
    expect(diagnoseNinfer(OOM, exit).params).not.toHaveProperty('estimatedMaxModelLen');
    expect(diagnoseNinfer(OOM, exit, { kvTokens: 1024, bytesPerToken: 35_904 }).params).not.toHaveProperty('estimatedMaxModelLen');
    expect(diagnoseNinfer(OOM, exit, { kvTokens: 1024, bytesPerToken: 0 }).params).not.toHaveProperty('estimatedMaxModelLen');
  });

  it('names the other failures', () => {
    const d = (text: string, o?: { distro?: string }) => diagnoseNinfer([text], { code: null, signal: 'SIGKILL' }, o);
    expect(d('CUDA error: out of memory')).toMatchObject({ code: 'ENGINE_OOM', params: { code: 'SIGKILL' } });
    expect(d('bind: address already in use')).toMatchObject({ code: 'ENGINE_PORT_IN_USE' });
    expect(d('ninfer-serve: error while loading shared libraries: libavformat.so.60: cannot open shared object file')).toMatchObject({ code: 'ENGINE_MISSING_LIBRARY', params: { library: 'libavformat.so.60', package: 'libavformat60' } });
    expect(d('no kernel image is available for execution on the device')).toMatchObject({ code: 'ENGINE_GPU_UNSUPPORTED', params: { engine: 'NInfer', gpu: 'RTX 5090' } });
    expect(d('unsupported container version 2 (expected 3)')).toMatchObject({ code: 'MODEL_INVALID', params: { reason: 'ninfer-artifact' } });
    expect(d("unknown option: '--kv-precision'")).toMatchObject({ code: 'ENGINE_BAD_FLAG', params: { flag: '--kv-precision' } });
    expect(d('There is no distribution with the supplied name.', { distro: 'Debian' })).toMatchObject({ code: 'ENGINE_NOT_INSTALLED', params: { reason: 'distro_missing', distro: 'Debian' } });
    expect(d('Error code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND')).toMatchObject({ params: { reason: 'distro_missing' } });
    expect(d('sh: 1: exec: /opt/ninfer-serve: not found')).toMatchObject({ code: 'ENGINE_NOT_INSTALLED', params: { reason: 'ninfer_not_found' } });
    expect(diagnoseNinfer(['bye'], { code: 3, signal: null })).toMatchObject({ code: 'ENGINE_EXITED', params: { code: '3' } });
  });
});
