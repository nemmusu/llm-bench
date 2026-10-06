import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { StartRunRequest } from '../../../src/contract/api';
import type { LocalModel } from '../../../src/contract/models';
import type { ProcessRunner } from '../../../src/core/deps';
import { clientFactory, createServices, modelsLookup, parseArgvEnv, resolveModelTarget, serviceModules } from '../../../src/core/services';
import type { OwnershipRegistry } from '../../../src/core/process/ownership';
import { systemClock } from '../../../src/core/node-deps';
import { createApp } from '../../../src/core/server/app';
import { tempDir, testContext, testDeps } from './server/helpers';

const base: Omit<StartRunRequest, 'engine' | 'model'> = { profile: 'quick', allowSharedGpu: false };

const local: LocalModel = {
  id: 'abc',
  identity: { displayName: 'Qwen3 4B', format: 'gguf', source: 'local', files: ['q.gguf'], weakKey: 'local/q.gguf//1' },
  paths: ['/m/q.gguf'],
  auxiliary: [],
  dir: '/m',
  origin: 'library',
  modifiedAt: '2026-01-01T00:00:00Z',
};

describe('parseArgvEnv', () => {
  it('accepts only a non-empty JSON array of strings', () => {
    expect(parseArgvEnv('["node","x.mjs"]')).toEqual(['node', 'x.mjs']);
    expect(parseArgvEnv(undefined)).toBeUndefined();
    expect(parseArgvEnv('[]')).toBeUndefined();
    expect(parseArgvEnv('[1]')).toBeUndefined();
    expect(parseArgvEnv('node')).toBeUndefined();
  });
});

describe('resolveModelTarget', () => {
  it('names external endpoints by URL and served model', async () => {
    const t = await resolveModelTarget(
      { ...base, engine: { kind: 'external', baseUrl: 'http://h:1' }, model: { name: 'm' } },
      undefined,
    );
    expect(t).toMatchObject({ servedName: 'm', identity: { displayName: 'm', weakKey: 'external/http://h:1/m', source: 'external' } });
    const unnamed = await resolveModelTarget({ ...base, engine: { kind: 'external', baseUrl: 'http://h:1' }, model: {} }, undefined);
    expect(unnamed).toMatchObject({ servedName: 'default', identity: { displayName: 'http://h:1' } });
    const bare = await resolveModelTarget({ ...base, engine: { kind: 'external' }, model: {} }, undefined);
    expect(bare.identity.displayName).toBe('endpoint');
  });

  it('looks up local models and fails clearly when missing', async () => {
    const models = { getLocal: async (id: string) => (id === 'abc' ? local : undefined) };
    const req = { ...base, engine: { kind: 'llamacpp-native' as const }, model: { localId: 'abc' } };
    expect(await resolveModelTarget(req, models)).toEqual({ identity: local.identity, local });
    await expect(resolveModelTarget({ ...req, model: { localId: 'nope' } }, models)).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' });
    await expect(resolveModelTarget(req, undefined)).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' });
  });

  it('serves HF repos (vLLM) and rejects requests without a model', async () => {
    const t = await resolveModelTarget({ ...base, engine: { kind: 'vllm-docker' }, model: { repo: 'Qwen/Qwen3-0.6B' } }, undefined);
    expect(t).toMatchObject({ repo: 'Qwen/Qwen3-0.6B', identity: { displayName: 'Qwen3-0.6B', revision: 'main', weakKey: 'Qwen/Qwen3-0.6B@main' } });
    const pinned = await resolveModelTarget({ ...base, engine: { kind: 'vllm-docker' }, model: { repo: 'r', revision: 'abc' } }, undefined);
    expect(pinned.identity).toMatchObject({ displayName: 'r', revision: 'abc' });
    await expect(resolveModelTarget({ ...base, engine: { kind: 'vllm-docker' }, model: {} }, undefined)).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });
});

describe('createServices', () => {
  let t: ReturnType<typeof tempDir>;
  beforeEach(() => {
    t = tempDir();
  });
  afterEach(() => t.cleanup());

  const quietProc: ProcessRunner = {
    run: () => Promise.resolve({ code: 1, stdout: '', stderr: '', timedOut: false }),
    spawn: () => {
      throw new Error('no spawn');
    },
  };

  it('builds the services for each platform and exposes routes', async () => {
    for (const platform of ['linux', 'win32', 'darwin'] as const) {
      const ctx = testContext(testDeps(t.dir, { platform, proc: quietProc }));
      const s = await createServices(ctx, { llamaLauncherPrefix: ['node'], modelServices: false });
      expect(s.evictor.kind).toBe(platform === 'linux' ? 'linux-fadvise' : platform === 'win32' ? 'windows-standby' : 'none');
      expect(Boolean(s.windowsStandby)).toBe(platform === 'win32');
      expect(s.ownPids()).toEqual([]);
      const app = createApp(ctx, { token: 't', port: () => 1, modules: serviceModules(s) });
      const res = await app.request('/api/engines', { headers: { authorization: 'Bearer t', host: '127.0.0.1:1' } });
      expect(res.status).toBe(200);
      const runs = await app.request('/api/runs', { headers: { authorization: 'Bearer t', host: '127.0.0.1:1' } });
      expect(await runs.json()).toEqual([]);
      const sys = await app.request('/api/system', { headers: { authorization: 'Bearer t', host: '127.0.0.1:1' } });
      expect(sys.status).toBe(200);
    }
  });

  it('cleans up leftover engines, tolerates a broken registry, refreshes own pids on run events', async () => {
    writeFileSync(path.join(t.dir, 'processes.json'), 'not json');
    const ctx = testContext(testDeps(t.dir, { proc: quietProc }));
    const s = await createServices(ctx);
    ctx.hub.publish({ type: 'run.phase', runId: 'r', phase: 'prepare', progress: 0 });
    ctx.hub.publish({ type: 'runs.changed' });
    await new Promise((r) => setTimeout(r, 20));
    expect(s.ownPids()).toEqual([]);
  });

  it('plans engine installs when llama.cpp is missing', async () => {
    const ctx = testContext(testDeps(t.dir, { proc: quietProc }));
    const s = await createServices(ctx);
    const plan = await s.bench.plan({
      ...base,
      engine: { kind: 'external', baseUrl: 'http://127.0.0.1:9' },
      model: { name: 'x' },
    });
    expect(plan.needs).toEqual([]);
    // llama.cpp without a custom executable and without a managed build → an engine install is needed.
    s.llama.planInstall = () => Promise.resolve({ kind: 'llamacpp-native', label: 'llama.cpp', bytes: 123, items: [], data: {} });
    const needsWithSize = await (s.bench as unknown as { deps: { needs: (r: StartRunRequest) => Promise<unknown> } }).deps.needs({
      ...base,
      engine: { kind: 'llamacpp-native' },
      model: { localId: 'x' },
    });
    expect(needsWithSize).toEqual([{ kind: 'engine', label: 'llama.cpp', bytes: 123 }]);
    s.llama.planInstall = () => Promise.reject(new Error('offline'));
    const needsNoSize = await (s.bench as unknown as { deps: { needs: (r: StartRunRequest) => Promise<unknown> } }).deps.needs({
      ...base,
      engine: { kind: 'llamacpp-native' },
      model: { localId: 'x' },
    });
    expect(needsNoSize).toEqual([{ kind: 'engine', label: 'llama.cpp' }]);
  });

  type BenchDeps = {
    publish: (e: unknown) => void;
    evictCache: (f: string[]) => Promise<unknown>;
    ownPids: () => number[];
    telemetryIntervalMs: () => Promise<number>;
  };

  it('logs stopped orphans, survives a failing cleanup, and keeps own pids from the registry', async () => {
    const pids = [{ pid: 7, kind: 'process' }, { pid: 8, kind: 'container' }];
    let listFails = false;
    const ownership = {
      cleanupOrphans: () => Promise.resolve({ stopped: [{ pid: 3 }], dropped: [], kept: [] }),
      list: () => (listFails ? Promise.reject(new Error('io')) : Promise.resolve(pids)),
    } as unknown as OwnershipRegistry;
    const logs: string[] = [];
    const deps = testDeps(t.dir, { proc: quietProc });
    deps.log = { debug: () => {}, info: (m) => logs.push(m), warn: (m) => logs.push(m), error: () => {} };
    const ctx = testContext(deps);
    const s = await createServices(ctx, { ownership });
    expect(logs).toContain('stopped leftover engines from a previous session');
    expect(s.ownPids()).toEqual([7]);
    listFails = true;
    ctx.hub.publish({ type: 'run.done', runId: 'r', summary: {} as never });
    ctx.hub.publish({ type: 'run.error', runId: 'r', error: { code: 'INTERNAL', message: 'x' } });
    await new Promise((r) => setTimeout(r, 20));
    expect(s.ownPids()).toEqual([7]);

    const failing = {
      cleanupOrphans: () => Promise.reject(new Error('broken')),
      list: () => Promise.resolve([]),
    } as unknown as OwnershipRegistry;
    await createServices(testContext(deps), { ownership: failing });
    expect(logs).toContain('orphan cleanup failed');
  });

  it('wires the bench service to the hub, evictor, settings and telemetry', async () => {
    const ctx = testContext(testDeps(t.dir, { proc: quietProc, platform: 'darwin' }));
    const s = await createServices(ctx);
    const d = (s.bench as unknown as { deps: BenchDeps }).deps;
    const seen: string[] = [];
    ctx.hub.subscribe((e) => seen.push(e.type));
    d.publish({ type: 'runs.changed' });
    expect(seen).toEqual(['runs.changed']);
    expect(await d.evictCache(['x'])).toEqual({ guaranteed: false, reason: 'not-supported' });
    expect(d.ownPids()).toEqual([]);
    expect(await d.telemetryIntervalMs()).toBe(250);
    // CUDA version for picking the llama.cpp release comes from the telemetry probe (none here).
    const llamaOpts = (s.llama as unknown as { o: { cudaVersion: () => Promise<string | undefined> } }).o;
    expect(await llamaOpts.cudaVersion()).toBeUndefined();
    ctx.telemetry.probe = () => Promise.reject(new Error('no driver'));
    expect(await llamaOpts.cudaVersion()).toBeUndefined();
    ctx.telemetry.probe = () => Promise.resolve([{ cudaVersion: '13.4' } as never]);
    expect(await llamaOpts.cudaVersion()).toBe('13.4');
  });

  it('skips the engine install when llama.cpp is already there, and detects with the saved engine', async () => {
    const ctx = testContext(testDeps(t.dir, { proc: quietProc }));
    const s = await createServices(ctx);
    s.llama.detect = () => Promise.resolve({ kind: 'llamacpp-native', available: true, installed: true, problems: [], supported: true });
    const needs = await (s.bench as unknown as { deps: { needs: (r: StartRunRequest) => Promise<unknown> } }).deps.needs({
      ...base,
      engine: { kind: 'llamacpp-native' },
      model: { localId: 'x' },
    });
    expect(needs).toEqual([]);
    await ctx.settings.update({ lastEngine: { kind: 'external', baseUrl: 'http://127.0.0.1:9' } });
    const app = createApp(ctx, { token: 't', port: () => 1, modules: serviceModules(s) });
    const res = await app.request('/api/engines', { headers: { authorization: 'Bearer t', host: '127.0.0.1:1' } });
    expect(res.status).toBe(200);
    // Engine install progress goes through the hub.
    const seen: string[] = [];
    ctx.hub.subscribe((e) => seen.push(e.type));
    s.llama.planInstall = () => Promise.resolve({ kind: 'llamacpp-native', label: 'llama.cpp', bytes: 1, items: [], data: {} });
    s.llama.installBuild = (_p, progress) => {
      progress({ stage: 'download', bytesDone: 1, bytesTotal: 1 });
      return Promise.resolve({} as never);
    };
    const inst = await app.request('/api/engines/llamacpp-native/install', {
      method: 'POST',
      headers: { authorization: 'Bearer t', host: '127.0.0.1:1', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(inst.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).toContain('engine.install');
  });
});

describe('clientFactory', () => {
  it('creates clients with and without an API key', () => {
    const make = clientFactory({ fetch: globalThis.fetch, clock: systemClock });
    expect(make('llamacpp', 'http://h:1').flavor).toBe('llamacpp');
    expect(make('openai', 'http://h:1', { apiKey: 'k' }).flavor).toBe('openai');
  });
});

describe('modelsLookup', () => {
  const gguf = (sha?: string): LocalModel => ({ ...local, identity: { ...local.identity, ...(sha ? { sha256: sha } : {}) } });

  it('hashes a GGUF the first time it is benchmarked', async () => {
    const m = gguf();
    const lookup = modelsLookup({
      models: { get: async () => m, hashes: { enqueue: async () => 'deadbeef' } } as never,
    });
    expect((await lookup.getLocal('abc'))?.identity.sha256).toBe('deadbeef');
  });

  it('returns known hashes, non-GGUF models and hashing failures unchanged', async () => {
    let enqueued = 0;
    const hashes = {
      enqueue: async () => {
        enqueued++;
        throw new Error('io');
      },
    };
    const known = gguf('cafe');
    expect(await modelsLookup({ models: { get: async () => known, hashes } as never }).getLocal('x')).toBe(known);
    const st: LocalModel = { ...local, identity: { ...local.identity, format: 'safetensors' } };
    expect(await modelsLookup({ models: { get: async () => st, hashes } as never }).getLocal('x')).toBe(st);
    const noPath: LocalModel = { ...gguf(), paths: [] };
    expect(await modelsLookup({ models: { get: async () => noPath, hashes } as never }).getLocal('x')).toBe(noPath);
    expect(enqueued).toBe(0);
    const failing = gguf();
    expect((await modelsLookup({ models: { get: async () => failing, hashes } as never }).getLocal('x'))?.identity.sha256).toBeUndefined();
    expect(enqueued).toBe(1);
    const missing = modelsLookup({ models: { get: () => Promise.reject(new Error('nope')), hashes } as never });
    expect(await missing.getLocal('x')).toBeUndefined();
  });
});

describe('createServices with the models module', () => {
  let t: ReturnType<typeof tempDir>;
  beforeEach(() => {
    t = tempDir();
  });
  afterEach(() => t.cleanup());

  it('feeds GPU memory to the fit estimator and estimates local models for the plan', async () => {
    const deps = testDeps(t.dir, {
      proc: {
        run: () => Promise.resolve({ code: 1, stdout: '', stderr: '', timedOut: false }),
        spawn: () => {
          throw new Error('no spawn');
        },
      },
    });
    const ctx = testContext(deps);
    await ctx.settings.update({ scanKnownLocations: false });
    const s = await createServices(ctx);
    const ms = s.modelServices!;
    const gpuInfo = (ms.models as unknown as { opts: { gpuInfo: () => Promise<unknown> } }).opts.gpuInfo;
    expect(await gpuInfo()).toBeUndefined();
    ctx.telemetry.snapshot = () => Promise.reject(new Error('no driver'));
    expect(await gpuInfo()).toBeUndefined();
    ctx.telemetry.snapshot = () => Promise.resolve([{ memTotalMiB: 32607, memUsedMiB: 1600 } as never]);
    expect(await gpuInfo()).toEqual({ totalMiB: 32607, freeMiB: 31007 });
    ctx.telemetry.snapshot = () => Promise.resolve([{ memTotalMiB: 8192, memUsedMiB: null } as never]);
    expect(await gpuInfo()).toEqual({ totalMiB: 8192, freeMiB: 8192 });

    const fit = (s.bench as unknown as { deps: { fit: (r: StartRunRequest, m: unknown, p: unknown) => Promise<unknown> } }).deps.fit;
    const req = { ...base, engine: { kind: 'llamacpp-native' as const }, model: { localId: 'abc' } };
    expect(await fit(req, { identity: local.identity }, { params: {} })).toBeUndefined();
    ms.models.fit = () => Promise.resolve({ level: 'good' } as never);
    expect(await fit(req, { identity: local.identity, local }, { params: { contextSize: 4096 } })).toEqual({ level: 'good' });
    expect(await fit(req, { identity: local.identity, local }, {})).toEqual({ level: 'good' });
    ms.models.fit = () => Promise.reject(new Error('no gpu'));
    expect(await fit(req, { identity: local.identity, local }, { params: {} })).toBeUndefined();

    // The model and download routes are mounted.
    const app = createApp(ctx, { token: 't', port: () => 1, modules: serviceModules(s) });
    const res = await app.request('/api/downloads', { headers: { authorization: 'Bearer t', host: '127.0.0.1:1' } });
    expect(await res.json()).toEqual([]);
    const loc = await app.request('/api/models/local', { headers: { authorization: 'Bearer t', host: '127.0.0.1:1' } });
    expect(loc.status).toBe(200);
  });
});

describe('setup wiring', () => {
  let t: ReturnType<typeof tempDir>;
  beforeEach(() => {
    t = tempDir();
  });
  afterEach(() => t.cleanup());

  it('serves the system check from every source, with and without the models module', async () => {
    const proc: ProcessRunner = {
      run: () => Promise.resolve({ code: 1, stdout: '', stderr: '', timedOut: false }),
      spawn: () => {
        throw new Error('no spawn');
      },
    };
    for (const [modelServices, platform] of [
      [undefined, 'linux'],
      [false, 'win32'],
    ] as const) {
      const deps = testDeps(t.dir, { proc, platform });
      deps.endpoints.dockerInstaller = 'http://127.0.0.1:9/DockerInstaller.exe';
      const ctx = testContext(deps);
      await ctx.settings.update({ scanKnownLocations: false });
      const s = await createServices(ctx, modelServices === false ? { modelServices } : {});
      const app = createApp(ctx, { token: 't', port: () => 1, modules: serviceModules(s) });
      const res = await app.request('/api/setup/check?fresh=1', { headers: { authorization: 'Bearer t', host: '127.0.0.1:1' } });
      expect(res.status).toBe(200);
      const report = (await res.json()) as { items: { id: string; state: string }[]; canBenchmark: boolean };
      expect(report.canBenchmark).toBe(false);
      expect(report.items.map((i) => i.id)).toEqual(expect.arrayContaining(['driver', 'gpu', 'llamacpp', 'models', 'disk']));
      // A guided install runs as a background job and reports through the event hub.
      const events: string[] = [];
      ctx.hub.subscribe((e) => events.push(e.type));
      const inst = await app.request('/api/setup/uv/install', { method: 'POST', headers: { authorization: 'Bearer t', host: '127.0.0.1:1' } });
      expect(inst.status).toBeLessThan(500);
      for (let i = 0; i < 50 && !events.includes('engine.install'); i++) await new Promise((r) => setTimeout(r, 20));
      expect(events).toContain('engine.install');
    }
  });
});
