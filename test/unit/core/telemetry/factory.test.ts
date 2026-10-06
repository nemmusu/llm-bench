import { describe, expect, it } from 'vitest';
import type { GpuSample } from '../../../../src/contract/hardware';
import { createTelemetry, detectTelemetry, type TelemetryDeps } from '../../../../src/core/telemetry/factory';
import { LiveTelemetry } from '../../../../src/core/telemetry/live';
import { NullTelemetry } from '../../../../src/core/telemetry/null';
import { NvidiaSmiTelemetry } from '../../../../src/core/telemetry/sampler';
import { FakeClock, FakeRunner, fixture, memoryLogger, nvidiaSmiHandler, ok, tick, type RunHandler } from './fakes';

const SYS32 = 'C:\\Windows\\System32\\nvidia-smi.exe';
const WIN_PROBE = ok(fixture('nvidia-smi/win-probe.csv', { crlf: true }));
const WIN_SNAPSHOT = ok(fixture('nvidia-smi/win-snapshot.csv', { crlf: true }));
const WORKING = nvidiaSmiHandler({
  version: ok(fixture('nvidia-smi/win-version.txt', { crlf: true })),
  probe: WIN_PROBE,
  sample: WIN_SNAPSHOT,
  apps: ok(fixture('nvidia-smi/handmade/compute-apps-edge.csv')),
});

function deps(handler: RunHandler, extra: Partial<TelemetryDeps> = {}) {
  const clock = new FakeClock();
  const proc = new FakeRunner(handler, clock);
  const d: TelemetryDeps = { clock, proc, platform: 'win32', env: {}, endpoints: {}, ...extra };
  return { d, clock, proc };
}
const onlySys32 = (p: string) => Promise.resolve(p === SYS32);

describe('detectTelemetry', () => {
  it('reports "not found" with NullTelemetry when nvidia-smi is nowhere', async () => {
    const { d, proc } = deps(WORKING);
    const r = await detectTelemetry(d, { fileExists: () => Promise.resolve(false) });
    expect(r.sampler).toBeInstanceOf(NullTelemetry);
    expect(r.status).toEqual({ found: false, works: false, gpuCount: 0 });
    expect(proc.calls).toHaveLength(0);
  });

  it('detects the real 617 driver: KMD + CUDA UMD from --version, then probes', async () => {
    const log = memoryLogger();
    const { d, proc } = deps(WORKING, { log });
    const r = await detectTelemetry(d, { fileExists: onlySys32, timeoutMs: 5000, maxSamples: 10 });
    expect(r.sampler).toBeInstanceOf(NvidiaSmiTelemetry);
    expect(r.status).toEqual({ found: true, path: SYS32, source: 'known', works: true, driverVersion: '617.14', cudaVersion: '13.4', gpuCount: 1 });
    expect(proc.calls.map((c) => c.args[0])).toEqual(['--version', expect.stringContaining('--query-gpu=index,uuid')]);
    expect(proc.calls[0]!.opts).toEqual({ timeoutMs: 5000 });
    expect((await r.sampler.probe())[0]!.cudaVersion).toBe('13.4');
    expect(log.entries).toEqual([]);
  });

  it('reads the plain header when --version is unknown (old driver) or lacks CUDA', async () => {
    const legacy = deps(
      nvidiaSmiHandler({
        version: ok(fixture('nvidia-smi/handmade/legacy-version-unsupported.txt'), 2),
        plain: ok(fixture('nvidia-smi/handmade/legacy-plain.txt')),
        probe: ok(fixture('nvidia-smi/handmade/legacy-probe.csv')),
      }),
    );
    const r1 = await detectTelemetry(legacy.d, { fileExists: onlySys32 });
    expect(r1.status).toMatchObject({ works: true, driverVersion: '470.223.02', cudaVersion: '11.4', gpuCount: 2 });

    const noCuda = deps(
      nvidiaSmiHandler({
        version: ok('NVIDIA-SMI version  : 560.35.03\nDRIVER version      : 560.35.03\n'),
        plain: ok(fixture('nvidia-smi/handmade/no-cuda-header.txt')),
        probe: WIN_PROBE,
      }),
    );
    const r2 = await detectTelemetry(noCuda.d, { fileExists: onlySys32 });
    expect(r2.status).toMatchObject({ works: true, driverVersion: '560.35.03' });
    expect(r2.status.cudaVersion).toBeUndefined();
  });

  it('falls back to NullTelemetry with the reason when the driver is missing', async () => {
    const log = memoryLogger();
    const missing = ok(fixture('nvidia-smi/handmade/driver-missing.txt'), 9);
    const { d } = deps(nvidiaSmiHandler({ version: missing, plain: missing }), { log });
    const r = await detectTelemetry(d, { fileExists: onlySys32 });
    expect(r.sampler).toBeInstanceOf(NullTelemetry);
    expect(r.status).toMatchObject({ found: true, path: SYS32, works: false, gpuCount: 0, error: { code: 'DRIVER_MISSING' } });
    expect(log.entries[0]).toEqual({ level: 'warn', msg: 'GPU telemetry unavailable' });
  });

  it('treats "No devices were found" as unavailable (GPU_NOT_FOUND)', async () => {
    const { d } = deps(nvidiaSmiHandler({ version: ok(fixture('nvidia-smi/win-version.txt')), probe: ok(fixture('nvidia-smi/win-no-devices.txt'), 6) }));
    const r = await detectTelemetry(d, { fileExists: onlySys32 });
    expect(r.sampler).toBeInstanceOf(NullTelemetry);
    expect(r.status).toMatchObject({ found: true, works: false, driverVersion: '617.14', error: { code: 'GPU_NOT_FOUND' } });
  });

  it('never rejects, even when the file lookup throws', async () => {
    const { d } = deps(WORKING);
    const r = await detectTelemetry(d, { fileExists: () => Promise.reject(new Error('EACCES')) });
    expect(r.status).toEqual({ found: false, works: false, gpuCount: 0, error: { code: 'INTERNAL', message: 'EACCES' } });
  });

  it('uses the endpoint override (fake nvidia-smi) without any file check', async () => {
    const { d, proc } = deps(WORKING, { endpoints: { nvidiaSmi: ['node', 'fake.mjs'] } });
    const r = await detectTelemetry(d);
    expect(r.status).toMatchObject({ found: true, path: 'node fake.mjs', source: 'override', works: true });
    expect(proc.calls[0]!.cmd).toBe('node');
  });
});

describe('createTelemetry (lazy auto-detection)', () => {
  it('spawns nothing until first use, then shares one detection between concurrent callers', async () => {
    const { d, proc } = deps(WORKING);
    const t = createTelemetry(d, { fileExists: onlySys32 });
    expect(proc.calls).toHaveLength(0);
    const [status, available] = await Promise.all([t.status(), t.available()]);
    expect(status.works).toBe(true);
    expect(available).toBe(true);
    expect(proc.calls.filter((c) => c.args[0] === '--version')).toHaveLength(1);
    expect((await t.probe())[0]!.name).toBe('NVIDIA GeForce RTX 5090');
    expect((await t.snapshot())[0]!.memUsedMiB).toBe(1800);
    expect((await t.otherGpuUsers([4242])).map((u) => u.pid)).toEqual([5151, 6161, 7171]);
    expect(proc.calls.filter((c) => c.args[0] === '--version')).toHaveLength(1);
  });

  it('retries a failed detection after retryMs (driver installed later), keeps a working one', async () => {
    let installed = false;
    const missing = ok(fixture('nvidia-smi/handmade/driver-missing.txt'), 9);
    const handler: RunHandler = (cmd, args, o) => (installed ? WORKING(cmd, args, o) : missing);
    const { d, clock, proc } = deps(handler);
    const t = createTelemetry(d, { fileExists: onlySys32, retryMs: 1000 });
    expect(await t.available()).toBe(false);
    installed = true;
    clock.advance(500);
    expect(await t.available()).toBe(false);
    clock.advance(600);
    expect(await t.available()).toBe(true);
    const calls = proc.calls.length;
    clock.advance(60_000);
    expect(await t.available()).toBe(true);
    expect(proc.calls).toHaveLength(calls);
    t.refresh();
    expect(await t.available()).toBe(true);
    expect(proc.calls.length).toBeGreaterThan(calls);
  });

  it('uses a 10 s default retry window', async () => {
    const { d, clock, proc } = deps(() => ok('', 9));
    const t = createTelemetry(d, { fileExists: onlySys32 });
    await t.status();
    const n = proc.calls.length;
    clock.advance(9_000);
    await t.status();
    expect(proc.calls).toHaveLength(n);
    clock.advance(2_000);
    await t.status();
    expect(proc.calls.length).toBeGreaterThan(n);
  });

  it('start() is synchronous: the stream begins once detection is done', async () => {
    const { d, proc } = deps(WORKING);
    const t = createTelemetry(d, { fileExists: onlySys32 });
    const got: GpuSample[][] = [];
    const session = t.start(250, (s) => got.push(s));
    expect(session.latest()).toEqual([]);
    await tick(10);
    expect(proc.spawned).toHaveLength(1);
    proc.spawned[0]!.emit(fixture('nvidia-smi/win-stream.csv').split(/\r?\n/)[0]!);
    await tick();
    expect(session.latest()).toHaveLength(1);
    expect(got).toHaveLength(1);
    expect(await session.stop()).toHaveLength(1);
  });

  it('a session stopped before detection finished never spawns; NullTelemetry sessions are empty', async () => {
    const { d, proc } = deps(WORKING);
    const t = createTelemetry(d, { fileExists: onlySys32 });
    const session = t.start(250);
    expect(await session.stop()).toEqual([]);
    await tick(10);
    expect(proc.spawned).toHaveLength(0);

    const none = createTelemetry(deps(WORKING).d, { fileExists: () => Promise.resolve(false) });
    const s2 = none.start(250);
    await tick();
    expect(s2.latest()).toEqual([]);
    expect(await s2.stop()).toEqual([]);
    expect(await none.probe()).toEqual([]);
    expect(await none.snapshot()).toEqual([]);
    expect(await none.otherGpuUsers([])).toEqual([]);
    expect(await none.available()).toBe(false);
  });
});

describe('NullTelemetry', () => {
  it('is never available and returns empty readings', async () => {
    const n = new NullTelemetry();
    expect(await n.available()).toBe(false);
    expect(await n.probe()).toEqual([]);
    expect(await n.snapshot()).toEqual([]);
    expect(await n.otherGpuUsers()).toEqual([]);
    const s = n.start();
    expect(s.latest()).toEqual([]);
    expect(await s.stop()).toEqual([]);
  });
});

describe('LiveTelemetry', () => {
  const sample = (t: number): GpuSample => ({
    t,
    gpu: 0,
    utilPct: 1,
    memUsedMiB: 1,
    memTotalMiB: 2,
    powerW: 3,
    tempC: 4,
    smClockMHz: 5,
    memClockMHz: 6,
    pcieGen: 1,
    pcieWidth: 16,
    throttle: [],
  });

  it('coalesces concurrent polls and reuses a fresh result', async () => {
    const clock = new FakeClock();
    let calls = 0;
    const live = new LiveTelemetry({ snapshot: () => Promise.resolve([sample(++calls)]) }, clock, 500);
    const [a, b] = await Promise.all([live.read(), live.read()]);
    expect(a).toBe(b);
    expect(calls).toBe(1);
    clock.advance(499);
    expect(await live.read()).toBe(a);
    clock.advance(1);
    expect((await live.read())[0]!.t).toBe(2);
  });

  it('does not cache failures', async () => {
    const clock = new FakeClock();
    let fail = true;
    const live = new LiveTelemetry(
      { snapshot: () => (fail ? Promise.reject(new Error('nvidia-smi died')) : Promise.resolve([sample(1)])) },
      clock,
    );
    await expect(live.read()).rejects.toThrow('nvidia-smi died');
    fail = false;
    expect(await live.read()).toHaveLength(1);
  });
});
