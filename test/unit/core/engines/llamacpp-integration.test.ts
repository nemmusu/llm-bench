// The llama.cpp adapter driving the fake llama-server (test/fakes/fake-engine/cli.mjs) through the
// REAL ProcessRunner: spawn, readiness, phases, failure diagnosis, ownership and stop.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { launchParamsSchema, type EngineConfig, type LaunchParams } from '../../../../src/contract/engines';
import type { LogLine, Platform } from '../../../../src/core/deps';
import { LlamaNativeAdapter, type LlamaDeps } from '../../../../src/core/engines/llamacpp-native/adapter';
import type { ModelTarget } from '../../../../src/core/engines/types';
import type { InferenceClient } from '../../../../src/core/inference/types';
import { systemClock } from '../../../../src/core/node-deps';
import { OwnershipRegistry } from '../../../../src/core/process/ownership';
import { pickFreePort } from '../../../../src/core/process/ports';
import { createProcessRunner } from '../../../../src/core/process/runner';

const CLI = fileURLToPath(new URL('../../../fakes/fake-engine/cli.mjs', import.meta.url));
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'gb-int-'));
const platform = process.platform as Platform;
const cfg: EngineConfig = { kind: 'llamacpp-native', executable: CLI };
let n = 0;
const marker = () => `gpubench-it${process.pid}x${n++}aaaa`;

function setup() {
  const root = tmp();
  const proc = createProcessRunner({ clock: systemClock, platform, baseEnv: process.env });
  const deps: LlamaDeps = {
    clock: systemClock,
    proc,
    fetch,
    platform,
    arch: process.arch,
    paths: { dataDir: root, cacheDir: root, enginesDir: path.join(root, 'engines'), resultsDir: root, modelsDir: root, resourcesDir: root, home: root },
    endpoints: { githubApi: 'http://127.0.0.1:9', huggingface: '', dockerHub: '' },
    env: {},
    log: { debug() {}, info() {}, warn() {}, error() {} },
    appVersion: 'test',
  };
  const ownership = new OwnershipRegistry({ file: path.join(root, 'processes.json'), platform, proc });
  const createClient = vi.fn((flavor: string, baseUrl: string) => ({ flavor, baseUrl }) as unknown as InferenceClient);
  const adapter = new LlamaNativeAdapter({ deps, ownership, createClient, launcherPrefix: [process.execPath], pollMs: 20, readyTimeoutMs: 30_000 });
  const gguf = path.join(root, 'tiny.gguf');
  writeFileSync(gguf, Buffer.alloc(2048, 1));
  return { root, adapter, ownership, createClient, gguf };
}

function target(file: string): ModelTarget {
  const identity = { displayName: 'tiny', format: 'gguf' as const, source: 'local' as const, files: [], weakKey: 'tiny' };
  return { identity, local: { id: 't', identity, paths: [file], auxiliary: [], dir: path.dirname(file), origin: 'library', modifiedAt: '' } };
}

const params = (profile: object, over: Partial<LaunchParams> = {}, env: Record<string, string> = {}) =>
  launchParamsSchema.parse({ contextSize: 2048, ...over, env: { FAKE_ENGINE_PROFILE: JSON.stringify(profile), ...env } });

async function collect(logs: AsyncIterable<LogLine>): Promise<string[]> {
  const out: string[] = [];
  for await (const l of logs) out.push(l.text);
  return out;
}

describe('llama.cpp adapter × fake llama-server (real processes)', () => {
  it('detects the binary and probes its real b10997 capabilities', async () => {
    const { adapter } = setup();
    expect(await adapter.detect(cfg)).toMatchObject({ available: true, installed: true, version: 'b10997', variant: 'cpu', location: CLI });
    const caps = await adapter.capabilities(cfg);
    expect(caps).toMatchObject({ fitFlag: true, flashAttn: 'value', nglKeywords: ['auto', 'all'] });
  });

  it('starts, becomes ready with load phases, owns the process, serves, stops', async () => {
    const { adapter, ownership, createClient, gguf } = setup();
    const m = marker();
    const plan = await adapter.plan(cfg, target(gguf), params({ loadMsWarm: 500, decodeTps: 400 }), { port: await pickFreePort(), marker: m });
    expect(plan.argv.slice(0, 2)).toEqual([process.execPath, CLI]);
    expect(plan.argv).toEqual(expect.arrayContaining(['--fit', 'off', '--no-webui', '-ngl', 'all', '--alias', m]));

    const inst = await adapter.start(plan, new AbortController().signal);
    const logs = collect(inst.logs);
    const recs = await ownership.list();
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ exe: process.execPath, marker: m, kind: 'process' });
    // Real OS check (CIM on Windows, /proc on Linux): the running engine is provably ours.
    expect(await ownership.verifyOwned(recs[0]!)).toBe(true);

    const ready = await inst.waitReady();
    const loadMs = ready.tReady - inst.t0;
    expect(loadMs).toBeGreaterThanOrEqual(450);
    expect(loadMs).toBeLessThan(10_000);
    expect(ready.phases.map((p) => p.name)).toEqual(['model_load', 'load_tensors', 'context', 'warmup', 'listening']);
    const times = ready.phases.map((p) => p.t);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    // load_tensors is the longest phase in the fake's profile (60% of the load).
    expect(times[2]! - times[1]!).toBeGreaterThan(times[1]! - times[0]!);
    expect(createClient).toHaveBeenCalledWith('llamacpp', inst.baseUrl);

    const res = await fetch(`${inst.baseUrl}/completion`, {
      method: 'POST',
      body: JSON.stringify({ prompt: [1, 2, 3, 4], n_predict: 8, ignore_eos: true, stream: false }),
    });
    const body = (await res.json()) as { timings: { predicted_n: number } };
    expect(body.timings.predicted_n).toBe(8);

    const exit = await inst.stop();
    expect(exit.code === null || typeof exit.code === 'number').toBe(true);
    expect(await ownership.list()).toEqual([]);
    const lines = await logs;
    expect(lines.some((l) => l.includes(`main: server is listening on http://127.0.0.1:${plan.port}`))).toBe(true);
    expect(inst.logTail().length).toBeGreaterThan(20);
  });

  it('cold load (marker file present) is slower than warm, and the marker is consumed', async () => {
    const { adapter, gguf, root } = setup();
    const coldMarker = path.join(root, 'cold');
    writeFileSync(coldMarker, '');
    const profile = { loadMsCold: 900, loadMsWarm: 100 };
    const run = async () => {
      const plan = await adapter.plan(cfg, target(gguf), params(profile, {}, { FAKE_ENGINE_COLD_MARKER: coldMarker }), {
        port: await pickFreePort(),
        marker: marker(),
      });
      const inst = await adapter.start(plan, new AbortController().signal);
      const r = await inst.waitReady();
      await inst.stop();
      return r.tReady - inst.t0;
    };
    const cold = await run();
    expect(existsSync(coldMarker)).toBe(false);
    const warm = await run();
    expect(cold).toBeGreaterThan(warm + 500);
  });

  it.each([
    ['CUDA OOM at load', { oomAtLoad: true, loadMsWarm: 200 }, {}, 'ENGINE_OOM'],
    ['rejected flag', {}, { extraArgs: ['--bogus'] }, 'ENGINE_BAD_FLAG'],
    ['bad flag value', {}, { extraArgs: ['-fa', 'sideways'] }, 'ENGINE_BAD_FLAG'],
  ] as const)('%s is diagnosed from the log', async (_label, profile, over, code) => {
    const { adapter, ownership, gguf } = setup();
    const plan = await adapter.plan(cfg, target(gguf), params(profile, over as Partial<LaunchParams>), { port: await pickFreePort(), marker: marker() });
    const inst = await adapter.start(plan, new AbortController().signal);
    const err = await inst.waitReady().catch((e: unknown) => e);
    expect(err).toMatchObject({ code });
    if (code === 'ENGINE_BAD_FLAG') expect(err).toMatchObject({ params: { flag: (over as unknown as { extraArgs: string[] }).extraArgs[0] } });
    await inst.stop();
    expect(await ownership.list()).toEqual([]);
  });

  it('port already taken → ENGINE_PORT_IN_USE', async () => {
    const { adapter, gguf } = setup();
    const sockets = new Set<net.Socket>();
    // Accepts and never answers: the readiness probe hangs on it until its own timeout.
    const blocker = net.createServer((s) => sockets.add(s));
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const port = (blocker.address() as net.AddressInfo).port;
    try {
      const plan = await adapter.plan(cfg, target(gguf), params({}), { port, marker: marker() });
      const inst = await adapter.start(plan, new AbortController().signal);
      await expect(inst.waitReady()).rejects.toMatchObject({ code: 'ENGINE_PORT_IN_USE' });
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise((r) => blocker.close(r));
    }
  });

  it('missing model file → MODEL_INVALID; missing program → ENGINE_START_FAILED', async () => {
    const { adapter, root } = setup();
    const plan = await adapter.plan(cfg, target(path.join(root, 'nope.gguf')), params({}), { port: await pickFreePort(), marker: marker() });
    const inst = await adapter.start(plan, new AbortController().signal);
    await expect(inst.waitReady()).rejects.toMatchObject({ code: 'MODEL_INVALID' });

    const ghost = await adapter.start({ ...plan, argv: [path.join(root, 'ghost-llama-server'), '--version'] }, new AbortController().signal);
    await expect(ghost.waitReady()).rejects.toMatchObject({ code: 'ENGINE_START_FAILED' });
  });

  it('cancel during the load stops the engine', async () => {
    const { adapter, ownership, gguf } = setup();
    const plan = await adapter.plan(cfg, target(gguf), params({ loadMsWarm: 20_000 }), { port: await pickFreePort(), marker: marker() });
    const ac = new AbortController();
    const inst = await adapter.start(plan, ac.signal);
    setTimeout(() => ac.abort(), 300);
    await expect(inst.waitReady()).rejects.toMatchObject({ code: 'CANCELLED' });
    await inst.exited;
    expect(await ownership.list()).toEqual([]);
  });

  it('VRAM in the fake nvidia-smi state rises while loaded and returns to baseline after a hard stop', async () => {
    const { adapter, gguf, root } = setup();
    const state = path.join(root, 'smi.json');
    writeFileSync(state, JSON.stringify({ gpus: [{ index: 0, name: 'Fake RTX', memUsedMiB: 1600, memTotalMiB: 32607, utilPct: 2, powerW: 31 }] }));
    const read = () => JSON.parse(readFileSync(state, 'utf8')).gpus[0] as { memUsedMiB: number; utilPct: number; powerW: number; name: string };
    const plan = await adapter.plan(cfg, target(gguf), params({ loadMsWarm: 300, vramMiB: 3000 }, {}, { FAKE_NVIDIA_SMI_STATE: state }), {
      port: await pickFreePort(),
      marker: marker(),
    });
    const inst = await adapter.start(plan, new AbortController().signal);
    await inst.waitReady();
    expect(read()).toMatchObject({ memUsedMiB: 4600, utilPct: 2, powerW: 31, name: 'Fake RTX' });
    await inst.stop(); // Windows: taskkill /F — no exit handler runs, the watchdog restores the state
    const deadline = Date.now() + 5000;
    while (read().memUsedMiB !== 1600 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(read()).toMatchObject({ memUsedMiB: 1600, utilPct: 2, powerW: 31, name: 'Fake RTX', memTotalMiB: 32607 });
  });
});
