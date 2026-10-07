// Phase 3 behaviour of the fake engine: llama.cpp KV layout and --cache-reuse, vLLM --help, memory
// share refused at start, block size, CUDA graph sizes, fp8 formats, --max-num-seqs and /metrics.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { memoryPlan, speeds, startFakeEngine, type FakeEngine } from '../../../fakes/fake-engine/server.mjs';
import { BORDERLINE_PROFILE, MULTI_PROFILE, VLLM_TUNE_PROFILE } from '../../../fakes/fake-engine/profiles.mjs';

const CLI = fileURLToPath(new URL('../../../fakes/fake-engine/cli.mjs', import.meta.url));
const engines: FakeEngine[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.close()));
});
async function start(o: Parameters<typeof startFakeEngine>[0]) {
  const e = await startFakeEngine(o);
  engines.push(e);
  return e;
}
const cli = (args: string[], profile: object = {}) =>
  spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, FAKE_ENGINE_FLAVOR: 'vllm', FAKE_ENGINE_PROFILE: JSON.stringify(profile) }, timeout: 20_000 });

describe('memory and speed models', () => {
  const m = VLLM_TUNE_PROFILE.memory!;
  it('vLLM: a memory share above the free VRAM is refused; fewer CUDA graphs and whole blocks change the pool', () => {
    expect(memoryPlan(m, { flavor: 'vllm', ctx: 4096, gpuMemoryUtilization: 0.95 }).outcome).toBe('busy');
    const def = memoryPlan(m, { flavor: 'vllm', ctx: 4096, gpuMemoryUtilization: 0.9 });
    const small = memoryPlan(m, { flavor: 'vllm', ctx: 4096, gpuMemoryUtilization: 0.9, graphSizes: [1, 2, 4] });
    expect(small.capacity!).toBeGreaterThan(def.capacity!);
    expect(memoryPlan(m, { flavor: 'vllm', ctx: 4096, gpuMemoryUtilization: 0.9, blockSize: 32 }).capacity! % 32).toBe(0);
    expect(memoryPlan({ ...m, freeMiB: undefined }, { flavor: 'vllm', ctx: 4096 }).outcome).toBe('ok');
  });

  it('a shared llama.cpp pool, an eager vLLM batch, block size and the fp8 format change generation', () => {
    const p = { ...MULTI_PROFILE, speed: { ...MULTI_PROFILE.speed, kvDecodeFactor: { fp8: 0.9, fp8_e5m2: 0.7 }, blockSizeDecodeFactor: { 32: 1.1 } } };
    const base = speeds(p, { depth: 1024 }).decode;
    expect(speeds(p, { depth: 1024, unified: true }).decode).toBeCloseTo(base * 0.6, 6);
    expect(speeds(p, { depth: 1024, eager: true }).decode).toBeCloseTo(base * 0.85, 6);
    expect(speeds(p, { depth: 1024, blockSize: 32 }).decode).toBeCloseTo(base * 1.1, 6);
    expect(speeds(p, { depth: 1024, blockSize: 16 }).decode).toBeCloseTo(base, 6);
    expect(speeds(p, { depth: 1024, kvType: 'fp8', kvFormat: 'fp8_e5m2' }).decode).toBeCloseTo(base * 0.7, 6);
    expect(speeds(p, { depth: 1024, kvType: 'fp8', kvFormat: 'fp8_e4m3' }).decode).toBeCloseTo(base * 0.9, 6);
  });
});

describe('llama.cpp: KV layout', () => {
  it('explicit slots split -c (a prompt longer than its share is refused), --kv-unified shares it', async () => {
    const split = await start({ ctx: 4096, np: 4, kvUnified: false, profile: { loadMsWarm: 1 } });
    await split.loaded;
    const long = Array.from({ length: 2000 }, (_, i) => 100 + i);
    const r = await fetch(`${split.url}/completion`, { method: 'POST', body: JSON.stringify({ prompt: long, n_predict: 1 }) });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { n_ctx: number } }).error.n_ctx).toBe(1024);
    const shared = await start({ ctx: 4096, np: 4, kvUnified: true, profile: { loadMsWarm: 1 } });
    await shared.loaded;
    expect((await fetch(`${shared.url}/completion`, { method: 'POST', body: JSON.stringify({ prompt: long, n_predict: 1 }) })).status).toBe(200);
    // Automatic slots: shared, as llama-server does.
    const auto = await start({ ctx: 4096, profile: { loadMsWarm: 1 } });
    await auto.loaded;
    expect((await fetch(`${auto.url}/completion`, { method: 'POST', body: JSON.stringify({ prompt: long, n_predict: 1 }) })).status).toBe(200);
  });
});

describe('vLLM fake: options', () => {
  it('--help=all (v0.11-style), an old api_server that refuses it, a help that fails', () => {
    const all = cli(['serve', '--help=all']);
    expect(all.status).toBe(0);
    expect(all.stdout).toContain('--cuda-graph-sizes');
    const old = cli(['serve', '--help=all'], { vllmHelp: 'old' });
    expect(old.status).toBe(2);
    expect(old.stderr).toContain("ignored explicit argument 'all'");
    const oldPlain = cli(['serve', '-h'], { vllmHelp: 'old' });
    expect(oldPlain.status).toBe(0);
    expect(oldPlain.stdout).not.toContain('--block-size');
    expect(cli(['serve', '--help'], { vllmHelp: 'none' }).status).toBe(2);
  });

  it('rejects a block size argparse does not list', () => {
    const r = cli(['serve', 'm', '--block-size', '24']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("argument --block-size: invalid choice: '24'");
  });

  it('a memory share above the free VRAM: the start-up error vLLM prints', async () => {
    const lines: string[] = [];
    const e = await startFakeEngine({ flavor: 'vllm', ctx: 4096, gpuMemoryUtilization: 0.95, profile: { ...VLLM_TUNE_PROFILE, loadMsWarm: 1 }, log: (l) => lines.push(l), onFatal: () => undefined });
    engines.push(e);
    await expect(e.loaded).rejects.toThrow('busy');
    expect(lines.join('\n')).toMatch(/Free memory on device \(21\.48\/23\.44 GiB\) on startup is less than desired GPU memory utilization \(0\.95, 22\.27 GiB\)/);
  });

  it('/metrics: prefix-cache counters (default), the old gauge, none', async () => {
    for (const [style, want] of [
      ['counters', 'vllm:prefix_cache_hits_total'],
      ['gauge', 'vllm:gpu_prefix_cache_hit_rate'],
    ] as const) {
      const e = await start({ flavor: 'vllm', alias: 'm', ctx: 8192, profile: { loadMsWarm: 1, vllmMetrics: style } });
      await e.loaded;
      const prompt = Array.from({ length: 300 }, (_, i) => 100 + i);
      for (let k = 0; k < 2; k++) {
        const r = await fetch(`${e.url}/v1/completions`, { method: 'POST', body: JSON.stringify({ model: 'm', prompt, max_tokens: 2, ignore_eos: true }) });
        await r.text();
      }
      const text = await (await fetch(`${e.url}/metrics`)).text();
      expect(text).toContain(want);
    }
    const none = await start({ flavor: 'vllm', alias: 'm', ctx: 8192, profile: { loadMsWarm: 1, vllmMetrics: 'none' } });
    await none.loaded;
    expect((await fetch(`${none.url}/metrics`)).status).toBe(404);
    // A gauge before any request: 0.
    const fresh = await start({ flavor: 'vllm', alias: 'm', ctx: 8192, profile: { loadMsWarm: 1, vllmMetrics: 'gauge' } });
    await fresh.loaded;
    expect(await (await fetch(`${fresh.url}/metrics`)).text()).toContain('vllm:gpu_prefix_cache_hit_rate{engine="0",model_name="m"} 0');
  });
});

describe('llama.cpp: a borderline spill (the RTX 5090 at 240K) and the per-process monitor', () => {
  const MONITOR = fileURLToPath(new URL('../../../fakes/fake-nvidia-smi/fake-gpu-memory.mjs', import.meta.url));
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** The first `S` reading of the monitor that lists `pid`: dedicated and shared MiB. */
  function monitorReading(state: string, pid: number): Promise<{ dedicatedMiB: number; sharedMiB: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [MONITOR, '--interval-ms', '50', '--parent', String(process.pid)], { env: { ...process.env, FAKE_NVIDIA_SMI_STATE: state } });
      let buf = '';
      child.stdout.on('data', (d: Buffer) => {
        buf += d.toString();
        const m = new RegExp(String.raw`^S .*\b${pid}=(\d+)/(\d+)`, 'm').exec(buf);
        if (!m) return;
        child.kill();
        resolve({ dedicatedMiB: Number(m[1]) / 2 ** 20, sharedMiB: Number(m[2]) / 2 ** 20 });
      });
      child.on('error', reject);
    });
  }

  it('clean once loaded (360 MiB shared), 1 338 MiB from the first request, which never answers until the client gives up', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'gb-borderline-'));
    dirs.push(dir);
    const state = path.join(dir, 'smi.json');
    writeFileSync(state, JSON.stringify({ gpus: [{ memUsedMiB: 1600 }] }));
    const sidecar = () => JSON.parse(readFileSync(`${state}.engine-${process.pid}.json`, 'utf8')) as { memMiB: number; sharedMiB: number };
    const e = await start({ ctx: 245_760, kvType: 'f16', stateFile: state, watchdog: false, profile: { ...BORDERLINE_PROFILE, loadMsWarm: 1 } });
    await e.loaded;
    expect(sidecar()).toMatchObject({ memMiB: 31_000, sharedMiB: 360 });
    expect(await monitorReading(state, process.pid)).toEqual({ dedicatedMiB: 31_000, sharedMiB: 360 });
    const ac = new AbortController();
    // Nothing comes back (not even the headers) until the client gives up.
    const res = fetch(`${e.url}/completion`, { method: 'POST', body: JSON.stringify({ prompt: [1, 2, 3], n_predict: 32, stream: true }), signal: ac.signal }).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 300));
    expect(sidecar().sharedMiB).toBe(1338);
    expect(JSON.parse(readFileSync(state, 'utf8')).gpus[0]).toMatchObject({ utilPct: 99, powerW: 147 });
    ac.abort();
    await expect(res).rejects.toThrow();
    // A launch that fits: what it uses without spilling (~1 MiB per 1K of context).
    const clean = await start({ ctx: 4096, kvType: 'f16', stateFile: path.join(dir, 'clean.json'), watchdog: false, profile: { ...BORDERLINE_PROFILE, loadMsWarm: 1 } });
    await clean.loaded;
    expect(memoryPlan(BORDERLINE_PROFILE.memory!, { flavor: 'llamacpp', ctx: 229_376, kvType: 'f16' }).outcome).toBe('ok');
  });
});
