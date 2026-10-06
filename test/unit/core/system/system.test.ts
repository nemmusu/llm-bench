import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { systemResponseSchema } from '../../../../src/contract/api';
import { AppError } from '../../../../src/contract/errors';
import { gpuSampleSchema, type GpuInfo, type GpuSample, type HardwareFingerprint } from '../../../../src/contract/hardware';
import type { CoreContext } from '../../../../src/core/context';
import { createApp } from '../../../../src/core/server/app';
import { EventHub } from '../../../../src/core/server/event-hub';
import type { SysInfo } from '../../../../src/core/sysinfo/fingerprint';
import { createSystemRoutes } from '../../../../src/core/system/routes';
import { createSystemService, type SystemServiceOptions } from '../../../../src/core/system/service';
import { createTelemetry } from '../../../../src/core/telemetry/factory';
import type { GpuUser, TelemetrySampler } from '../../../../src/core/telemetry/types';
import { FakeClock, FakeRunner, fixture, memoryLogger, nvidiaSmiHandler, ok } from '../telemetry/fakes';

const GPU: GpuInfo = { index: 0, uuid: 'GPU-1', name: 'NVIDIA GeForce RTX 5090', vendor: 'nvidia', memoryTotalMiB: 32607, memoryUsedMiB: 1858 };

const FP: HardwareFingerprint = {
  hostId: 'h'.repeat(64),
  hostLabel: 'DESKTOP-DHTKFJ0',
  gpus: [{ index: 0, uuid: 'GPU-1', name: 'NVIDIA GeForce RTX 5090', vendor: 'nvidia', memoryTotalMiB: 32607 }],
  cpu: { model: 'Intel(R) Core(TM) Ultra 7 265F', cores: 20, threads: 20 },
  ramBytes: 205_751_443_456,
  os: { platform: 'win32', release: '10.0.26300', arch: 'x64', name: 'Windows 11 Pro 26H2', isWsl: false, powerPlan: 'Prestazioni elevate' },
};

const SAMPLE: GpuSample = {
  t: 1,
  gpu: 0,
  utilPct: 3,
  memUsedMiB: 1800,
  memTotalMiB: 32607,
  powerW: 56.26,
  tempC: 50,
  smClockMHz: 1207,
  memClockMHz: 405,
  pcieGen: 1,
  pcieWidth: 4,
  throttle: ['reliability'],
};

const PATHS = { dataDir: 'D:\\data', resultsDir: 'D:\\data\\results', modelsDir: 'D:\\models', enginesDir: 'D:\\data\\engines' };
const sysinfo: SysInfo = { getFingerprint: () => Promise.resolve(FP), invalidate: () => {} };

class StubTelemetry implements TelemetrySampler {
  snapshots = 0;
  ownSeen: number[][] = [];
  constructor(private readonly fail: Partial<Record<'probe' | 'users' | 'snapshot', boolean>> = {}) {}
  available() {
    return Promise.resolve(true);
  }
  probe() {
    return this.fail.probe ? Promise.reject(new AppError('DRIVER_MISSING', 'gone')) : Promise.resolve([GPU]);
  }
  snapshot() {
    this.snapshots++;
    return this.fail.snapshot ? Promise.reject(new AppError('DRIVER_MISSING', 'nvidia-smi cannot reach the NVIDIA driver')) : Promise.resolve([SAMPLE]);
  }
  otherGpuUsers(own: number[]): Promise<GpuUser[]> {
    this.ownSeen.push(own);
    return this.fail.users
      ? Promise.reject(new Error('boom'))
      : Promise.resolve([
          { pid: 4321, name: 'llama-server.exe', knownLlm: true, kind: 'llm', memMiB: 9000 },
          { pid: 14064, name: 'explorer.exe', knownLlm: false, kind: 'system', memMiB: 216 },
          { pid: 29192, name: 'vmwp', knownLlm: false, kind: 'vm', memMiB: 23298 },
        ]);
  }
  start() {
    return { latest: () => [], stop: () => Promise.resolve([]) };
  }
}

function service(over: Partial<SystemServiceOptions> = {}) {
  const clock = new FakeClock();
  const telemetry = over.telemetry ?? new StubTelemetry();
  const svc = createSystemService({
    paths: PATHS,
    clock,
    settings: { get: () => Promise.resolve({ resultsDir: '', modelsDir: '' }) },
    telemetry,
    sysinfo,
    ...over,
  });
  return { svc, clock, telemetry };
}

function plainApp(svc: ReturnType<typeof service>['svc']): Hono {
  const app = new Hono();
  createSystemRoutes(svc)(app, {} as CoreContext);
  return app;
}

describe('SystemService', () => {
  it('assembles the SystemResponse from fingerprint, live probe, GPU users, docker and settings', async () => {
    const telemetry = Object.assign(new StubTelemetry(), { status: () => Promise.resolve({ found: true, path: 'C:\\Windows\\System32\\nvidia-smi.exe' }) });
    const { svc } = service({
      telemetry,
      dockerStatus: () => Promise.resolve({ state: 'running', version: '29.8.0' }),
      ownPids: () => [999],
      settings: { get: () => Promise.resolve({ resultsDir: '\\\\nas\\gpubench', modelsDir: 'C:\\models' }) },
    });
    const res = await svc.system();
    expect(systemResponseSchema.parse(res)).toEqual(res);
    expect(res).toEqual({
      gpus: [GPU],
      os: FP.os,
      cpu: FP.cpu,
      ramBytes: FP.ramBytes,
      hostLabel: 'DESKTOP-DHTKFJ0',
      nvidiaSmi: { found: true, path: 'C:\\Windows\\System32\\nvidia-smi.exe' },
      otherGpuUsers: [
        { pid: 4321, name: 'llama-server.exe', knownLlm: true, kind: 'llm', memMiB: 9000 },
        { pid: 14064, name: 'explorer.exe', knownLlm: false, kind: 'system', memMiB: 216 },
        { pid: 29192, name: 'vmwp', knownLlm: false, kind: 'vm', memMiB: 23298 },
      ],
      docker: { state: 'running', version: '29.8.0' },
      paths: { dataDir: 'D:\\data', resultsDir: '\\\\nas\\gpubench', modelsDir: 'C:\\models', enginesDir: 'D:\\data\\engines' },
    });
    expect(telemetry.ownSeen).toEqual([[999]]);
  });

  it('uses defaults for paths/docker/ownPids and degrades each failing part on its own', async () => {
    const log = memoryLogger();
    const telemetry = Object.assign(new StubTelemetry({ probe: true, users: true }), {
      status: () => Promise.reject(new Error('status broke')),
    });
    const { svc } = service({ telemetry, log, dockerStatus: () => Promise.reject(new Error('pipe closed')) });
    const res = await svc.system();
    expect(systemResponseSchema.parse(res)).toEqual(res);
    expect(res.gpus).toEqual(FP.gpus);
    expect(res.otherGpuUsers).toEqual([]);
    expect(res.docker).toEqual({ state: 'unknown' });
    expect(res.nvidiaSmi).toEqual({ found: false });
    expect(res.paths).toEqual(PATHS);
    expect(log.entries.map((e) => e.msg).sort()).toEqual(
      ['system: docker failed', 'system: nvidia-smi status failed', 'system: otherGpuUsers failed', 'system: probe failed'].sort(),
    );
    expect(telemetry.ownSeen).toEqual([[]]);
  });

  it('reports nvidia-smi from available() without status(), and without a path when unknown', async () => {
    const { svc } = service();
    expect((await svc.system()).nvidiaSmi).toEqual({ found: true });
    expect((await svc.system()).docker).toEqual({ state: 'unknown' });
    const quiet = service({ telemetry: new StubTelemetry({ probe: true }) });
    expect((await quiet.svc.system()).gpus).toEqual(FP.gpus);
    const noPath = service({ telemetry: Object.assign(new StubTelemetry(), { status: () => Promise.resolve({ found: false }) }) });
    expect((await noPath.svc.system()).nvidiaSmi).toEqual({ found: false });
  });

  it('GPU users: concurrent polls share one query, reused for 2.5 s unless our PIDs change; failures not cached', async () => {
    let own = [1];
    const telemetry = new StubTelemetry();
    const { svc, clock } = service({ telemetry, ownPids: () => own });
    const [a, b] = await Promise.all([svc.system(), svc.system()]);
    expect(a.otherGpuUsers).toHaveLength(3);
    expect(b.otherGpuUsers).toBe(a.otherGpuUsers);
    clock.advance(2499);
    await svc.system();
    expect(telemetry.ownSeen).toEqual([[1]]);
    own = [1, 2];
    await svc.system();
    expect(telemetry.ownSeen).toEqual([[1], [1, 2]]);
    clock.advance(2500);
    await svc.system();
    expect(telemetry.ownSeen).toHaveLength(3);

    const flaky = Object.assign(new StubTelemetry({ users: true }), {});
    const f = service({ telemetry: flaky, usersMaxAgeMs: 10_000 });
    expect((await f.svc.system()).otherGpuUsers).toEqual([]);
    expect((await f.svc.system()).otherGpuUsers).toEqual([]);
    expect(flaky.ownSeen).toHaveLength(2);
  });

  it('serves snapshots through LiveTelemetry (coalesced, 500 ms reuse)', async () => {
    const { svc, clock, telemetry } = service();
    const stub = telemetry as StubTelemetry;
    await Promise.all([svc.snapshot(), svc.snapshot()]);
    expect(stub.snapshots).toBe(1);
    clock.advance(600);
    await svc.snapshot();
    expect(stub.snapshots).toBe(2);
    const custom = service({ liveMaxAgeMs: 5000 });
    await custom.svc.snapshot();
    custom.clock.advance(4000);
    await custom.svc.snapshot();
    expect((custom.telemetry as StubTelemetry).snapshots).toBe(1);
  });
});

describe('system routes', () => {
  it('GET /api/system returns a contract-valid SystemResponse', async () => {
    const res = await plainApp(service().svc).request('/api/system');
    expect(res.status).toBe(200);
    expect(systemResponseSchema.parse(await res.json()).hostLabel).toBe('DESKTOP-DHTKFJ0');
  });

  it('GET /api/telemetry/snapshot returns GpuSample[]', async () => {
    const res = await plainApp(service().svc).request('/api/telemetry/snapshot');
    expect(res.status).toBe(200);
    expect(gpuSampleSchema.array().parse(await res.json())).toEqual([SAMPLE]);
  });

  it('works inside the real app (token, host check, AppError mapping) with a factory from the context', async () => {
    const ctx = {
      deps: { appVersion: '0.0.0-test', paths: {} },
      hub: new EventHub(),
      settings: { get: () => Promise.resolve({ resultsDir: '', modelsDir: '' }) },
      shutdown: new AbortController().signal,
      secrets: {},
    } as unknown as CoreContext;
    let seen: CoreContext | undefined;
    const module = createSystemRoutes((c) => {
      seen = c;
      return service({ telemetry: new StubTelemetry({ snapshot: true }) }).svc;
    });
    const app = createApp(ctx, { token: 'tok', port: () => 7000, modules: [module] });
    const headers = { host: '127.0.0.1:7000', authorization: 'Bearer tok' };
    expect(seen).toBe(ctx);
    expect((await app.request('/api/system', { headers })).status).toBe(200);
    expect((await app.request('/api/system', { headers: { host: '127.0.0.1:7000' } })).status).toBe(401);
    const err = await app.request('/api/telemetry/snapshot', { headers });
    expect(err.status).toBe(500);
    expect(await err.json()).toEqual({ error: { code: 'DRIVER_MISSING', message: 'nvidia-smi cannot reach the NVIDIA driver' } });
  });

  it('end to end with createTelemetry over the real nvidia-smi captures', async () => {
    const clock = new FakeClock();
    const proc = new FakeRunner(
      nvidiaSmiHandler({
        version: ok(fixture('nvidia-smi/win-version.txt')),
        probe: ok(fixture('nvidia-smi/win-probe.csv')),
        sample: ok(fixture('nvidia-smi/win-snapshot.csv')),
        apps: ok(fixture('nvidia-smi/win-compute-apps.csv')),
      }),
      clock,
    );
    const telemetry = createTelemetry(
      { clock, proc, platform: 'win32', env: {}, endpoints: {} },
      { fileExists: (p) => Promise.resolve(p === 'C:\\Windows\\System32\\nvidia-smi.exe') },
    );
    const app = plainApp(service({ telemetry }).svc);
    const sys = systemResponseSchema.parse(await (await app.request('/api/system')).json());
    expect(sys.nvidiaSmi).toEqual({ found: true, path: 'C:\\Windows\\System32\\nvidia-smi.exe' });
    expect(sys.gpus[0]).toMatchObject({ name: 'NVIDIA GeForce RTX 5090', cudaVersion: '13.4', driverVersion: '617.14' });
    // The GPU-counter monitor gave no reading in time (fake clock): users without memory.
    expect(sys.otherGpuUsers).toHaveLength(23);
    expect(sys.otherGpuUsers.filter((u) => u.knownLlm)).toEqual([]);
    expect(sys.otherGpuUsers.every((u) => u.memMiB === undefined && u.kind !== undefined)).toBe(true);
    const samples = gpuSampleSchema.array().parse(await (await app.request('/api/telemetry/snapshot')).json());
    expect(samples[0]).toMatchObject({ memUsedMiB: 1800, throttle: ['reliability'] });
  });

  it('end to end on Windows with the real GPU-counter monitor capture: memory and kind per user', async () => {
    // Timers only fire when aborted: the monitor's reading always beats its timeout.
    const clock = Object.assign(new FakeClock(), {
      sleep: (_ms: number, signal?: AbortSignal) => new Promise<void>((_r, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')))),
    });
    const monitorLines = fixture('process-vram/win-monitor.txt').split(/\r?\n/).filter((l) => l !== '');
    const proc = new FakeRunner(
      nvidiaSmiHandler({
        version: ok(fixture('nvidia-smi/win-version.txt')),
        probe: ok(fixture('nvidia-smi/win-probe.csv')),
        apps: ok(fixture('process-vram/win-compute-apps.csv')),
      }),
      clock,
      (p) => {
        if (p.spec.cmd.endsWith('powershell.exe')) for (const l of monitorLines) p.emit(l);
      },
    );
    const telemetry = createTelemetry({ clock, proc, platform: 'win32', env: {}, endpoints: {} }, { fileExists: (p) => Promise.resolve(p === 'C:\\Windows\\System32\\nvidia-smi.exe') });
    const sys = systemResponseSchema.parse(await (await plainApp(service({ telemetry, ownPids: () => [53916] }).svc).request('/api/system')).json());
    const by = new Map(sys.otherGpuUsers.map((u) => [u.pid, u]));
    expect(by.get(29192)).toEqual({ pid: 29192, name: 'vmwp', knownLlm: false, kind: 'vm', memMiB: 23298 });
    expect(by.get(2260)).toMatchObject({ name: 'dwm', kind: 'system', memMiB: 3329 });
    expect(by.get(33864)).toMatchObject({ name: 'firefox.exe', kind: 'app', memMiB: 2932 });
    expect(by.has(53916)).toBe(false);
    expect(sys.otherGpuUsers).toHaveLength(24);
  });
});
