import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { StartRunRequest } from '../../../src/contract/api';
import type { LocalModel } from '../../../src/contract/models';
import type { ProcessRunner } from '../../../src/core/deps';
import { clientFactory, createServices, modelsLookup, parseArgvEnv, resolveModelTarget, serviceModules } from '../../../src/core/services';
import type { ServeServiceDeps } from '../../../src/core/servers/service';
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

describe('resolveModelTarget: hub GGUF (repo + file)', () => {
  const lib: LocalModel = {
    ...local,
    id: 'lib1',
    identity: { ...local.identity, source: 'hf', repo: 'Qwen/Qwen3-4B-GGUF', file: 'Qwen3-4B-Q4_K_M.gguf', weakKey: 'Qwen/Qwen3-4B-GGUF/Qwen3-4B-Q4_K_M.gguf/Q4_K_M/2500' },
  };
  const planned = {
    identity: { ...lib.identity, source: 'hf' as const },
    file: 'Qwen3-4B-Q4_K_M.gguf',
    paths: ['/lib/Qwen/Qwen3-4B-GGUF/Qwen3-4B-Q4_K_M.gguf'],
    bytes: 2500,
  };
  const req = (kind: 'llamacpp-native' | 'llamacpp-docker' | 'vllm-docker' = 'llamacpp-native') => ({
    ...base,
    engine: { kind },
    model: { repo: 'Qwen/Qwen3-4B-GGUF', file: 'Qwen3-4B-Q4_K_M.gguf', revision: 'abc' },
  });

  it('uses the library copy when it is downloaded', async () => {
    const seen: string[][] = [];
    const models = {
      getLocal: async () => undefined,
      findGguf: async (repo: string, file: string) => {
        seen.push([repo, file]);
        return lib;
      },
    };
    expect(await resolveModelTarget(req('llamacpp-docker'), models)).toEqual({ identity: lib.identity, local: lib });
    expect(seen).toEqual([['Qwen/Qwen3-4B-GGUF', 'Qwen3-4B-Q4_K_M.gguf']]);
  });

  it('before the download: only a preview resolves it (to the pending download)', async () => {
    const calls: unknown[][] = [];
    const models = {
      getLocal: async () => undefined,
      findGguf: async () => undefined,
      plannedGguf: async (...a: unknown[]) => {
        calls.push(a);
        return planned;
      },
    };
    const notYet = { code: 'MODEL_NOT_FOUND', params: { repo: 'Qwen/Qwen3-4B-GGUF', file: 'Qwen3-4B-Q4_K_M.gguf', reason: 'not_downloaded' } };
    await expect(resolveModelTarget(req(), models)).rejects.toMatchObject(notYet);
    expect(await resolveModelTarget(req(), models, { preview: true })).toEqual({
      identity: planned.identity,
      pending: { repo: 'Qwen/Qwen3-4B-GGUF', file: 'Qwen3-4B-Q4_K_M.gguf', paths: planned.paths, bytes: 2500 },
    });
    expect(calls).toEqual([['Qwen/Qwen3-4B-GGUF', 'Qwen3-4B-Q4_K_M.gguf', 'abc']]);
    // Without the models module (or its hub side) nothing can be planned.
    await expect(resolveModelTarget(req(), undefined, { preview: true })).rejects.toMatchObject(notYet);
    await expect(resolveModelTarget(req(), { getLocal: async () => undefined }, { preview: true })).rejects.toMatchObject(notYet);
  });

  it('vLLM ignores the file and serves the repo', async () => {
    const t = await resolveModelTarget(req('vllm-docker'), undefined);
    expect(t).toMatchObject({ repo: 'Qwen/Qwen3-4B-GGUF', identity: { format: 'safetensors', revision: 'abc' } });
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
      const configs = await app.request('/api/configs', { headers: { authorization: 'Bearer t', host: '127.0.0.1:1' } });
      expect(await configs.json()).toMatchObject({ configs: [], gpus: [], gpu: null });
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
    // A custom engine (a fork) names its own executable: nothing to install.
    const needsFork = await (s.bench as unknown as { deps: { needs: (r: StartRunRequest) => Promise<unknown> } }).deps.needs({
      ...base,
      engine: { kind: 'llamacpp-native', customEngineId: 'prismml' },
      model: { localId: 'x' },
    });
    expect(needsFork).toEqual([]);
  });

  it('plans the image pull of a Docker engine whose image is missing', async () => {
    const ctx = testContext(testDeps(t.dir, { proc: quietProc }));
    const s = await createServices(ctx, { modelServices: false });
    const needs = (s.bench as unknown as { deps: { needs: (r: StartRunRequest) => Promise<unknown> } }).deps.needs;
    const llamaDocker = s.registry.require('llamacpp-docker');
    const image = 'ghcr.io/ggml-org/llama.cpp:server-cuda';
    const missing = { kind: 'llamacpp-docker' as const, available: false, installed: false, problems: ['ENGINE_NOT_INSTALLED'], supported: true, location: image };
    llamaDocker.detect = () => Promise.resolve(missing);
    llamaDocker.installPlan = () => Promise.resolve({ kind: 'llamacpp-docker', label: image, bytes: 2_900_000_000, items: [], data: { image } });
    const req = { ...base, engine: { kind: 'llamacpp-docker' as const }, model: { localId: 'x' } };
    expect(await needs(req)).toEqual([{ kind: 'image', label: image, bytes: 2_900_000_000 }]);
    // Size unknown (Docker Hub unreachable): listed without bytes.
    llamaDocker.installPlan = () => Promise.reject(new Error('offline'));
    expect(await needs(req)).toEqual([{ kind: 'image', label: image }]);
    // Docker off: nothing to pull from here (the engine shows the Docker problem instead); image present: nothing.
    llamaDocker.detect = () => Promise.resolve({ ...missing, problems: ['DOCKER_NOT_RUNNING'] });
    expect(await needs(req)).toEqual([]);
    // Without the image name there is nothing to name in the preview.
    const { location: _none, ...unnamed } = missing;
    llamaDocker.detect = () => Promise.resolve(unnamed);
    expect(await needs(req)).toEqual([]);
    const vllm = s.registry.require('vllm-docker');
    vllm.detect = () => Promise.resolve({ kind: 'vllm-docker', available: true, installed: true, problems: [], supported: true, location: 'vllm/vllm-openai:v0.12.0' });
    expect(await needs({ ...req, engine: { kind: 'vllm-docker' } })).toEqual([]);
    // SGLang's image is pulled the same way.
    const sglang = s.registry.require('sglang-docker');
    sglang.detect = () => Promise.resolve({ kind: 'sglang-docker', available: false, installed: false, problems: ['ENGINE_NOT_INSTALLED'], supported: true, location: 'lmsysorg/sglang:v0.5.21' });
    sglang.installPlan = () => Promise.resolve({ kind: 'sglang-docker', label: 'x', bytes: 15_164_770_325, items: [], data: {} });
    expect(await needs({ ...req, engine: { kind: 'sglang-docker' } })).toEqual([{ kind: 'image', label: 'lmsysorg/sglang:v0.5.21', bytes: 15_164_770_325 }]);
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

  it('wires the servers: addresses on the network cards, the API key for network plans and logs, VRAM from telemetry', async () => {
    const ctx = testContext(testDeps(t.dir, { proc: quietProc }));
    const card = { address: '192.168.1.20', netmask: '255.255.255.0', family: 'IPv4' as const, mac: '00:00:00:00:00:01', internal: false, cidr: '192.168.1.20/24' };
    const s = await createServices(ctx, { networkInterfaces: () => ({ Ethernet: [card] }) });
    const d = (s.serve as unknown as { deps: ServeServiceDeps }).deps;
    expect(d.lanUrls(8080)).toEqual(['http://192.168.1.20:8080/v1']);
    expect(d.secrets()).toEqual([]);
    const key = (s.bench as unknown as { deps: { serverApiKey: () => string } }).deps.serverApiKey();
    expect(key).toMatch(/^gpub-/);
    expect(d.secrets()).toEqual([key]);
    ctx.telemetry.snapshot = () => Promise.resolve([{ memUsedMiB: 4096 } as never]);
    expect(await d.vramUsedMiB!()).toBe(4096);
    ctx.telemetry.snapshot = () => Promise.resolve([]);
    expect(await d.vramUsedMiB!()).toBeUndefined();
    // A start that failed while nobody looked is dated with the core's clock.
    const at = Date.now();
    const notice = s.notices.add('autostart-failed', { id: 'p1', name: 'Chat' }, new Error('no model'));
    expect(Date.parse(notice.at)).toBeGreaterThanOrEqual(at - 1000);
    expect(s.notices.list()).toEqual([notice]);
    // This PC's own cards when none are given.
    const real =(((await createServices(testContext(testDeps(t.dir, { proc: quietProc })))).serve as unknown as { deps: ServeServiceDeps }).deps).lanUrls(8080);
    expect(Array.isArray(real)).toBe(true);
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

  it('never runs a model whose download stopped halfway, and never picks it for a repo', async () => {
    const partial: LocalModel = { ...local, identity: { ...local.identity, format: 'safetensors', repo: 'o/r' }, incomplete: { have: 1, total: 4 } };
    const whole: LocalModel = { ...partial, id: 'whole' };
    delete whole.incomplete;
    const lookup = modelsLookup({ models: { get: async () => partial, hashes: { enqueue: async () => 'x' }, list: async () => [partial, whole] } as never });
    await expect(lookup.getLocal('abc')).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND', params: { reason: 'incomplete', have: 1, total: 4 } });
    expect((await lookup.findByRepo!('o/r'))?.id).toBe('whole');
  });

  it('finds hub GGUFs in the library (hashed like local picks) and plans their downloads', async () => {
    const m = gguf();
    const asked: unknown[][] = [];
    const models = {
      get: async () => m,
      hashes: { enqueue: async () => 'beef' },
      findGguf: async (...a: unknown[]) => {
        asked.push(a);
        return a[0] === 'o/r' ? m : undefined;
      },
      plannedGguf: async (...a: unknown[]) => ({ planned: a }),
    };
    const lookup = modelsLookup({ models } as never);
    expect((await lookup.findGguf!('o/r', 'f.gguf'))?.identity.sha256).toBe('beef');
    expect(await lookup.findGguf!('o/other', 'f.gguf')).toBeUndefined();
    expect(asked).toEqual([
      ['o/r', 'f.gguf'],
      ['o/other', 'f.gguf'],
    ]);
    expect(await lookup.plannedGguf!('o/r', 'f.gguf', 'main')).toEqual({ planned: ['o/r', 'f.gguf', 'main'] });
    const broken = modelsLookup({ models: { findGguf: () => Promise.reject(new Error('scan failed')) } } as never);
    expect(await broken.findGguf!('o/r', 'f.gguf')).toBeUndefined();
  });
});

describe('createServices with the models module', () => {
  let t: ReturnType<typeof tempDir>;
  beforeEach(() => {
    t = tempDir();
  });
  afterEach(() => t.cleanup());

  it('feeds GPU memory to the fit estimator and estimates local models for the plan', async () => {
    let now = 0;
    const deps = testDeps(t.dir, {
      clock: { ...systemClock, now: () => now },
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
    // A server LLM Bench started holds memory too: in use, but not "other programs".
    s.ownership.list = () => Promise.resolve([{ kind: 'process', pid: 42 } as never, { kind: 'container', pid: 0 } as never]);
    let reads = 0;
    ctx.telemetry.otherGpuUsers = (own) => {
      reads++;
      expect(own).toEqual([]);
      return Promise.resolve([
        { pid: 42, name: 'llama-server', knownLlm: true, memMiB: 9000 },
        { pid: 7, name: 'game', knownLlm: false, memMiB: 3000 },
        { pid: 42, name: 'llama-server', knownLlm: true },
      ]);
    };
    ctx.telemetry.snapshot = () => Promise.resolve([{ memTotalMiB: 32607, memUsedMiB: 12600 } as never]);
    now = 10_000;
    expect(await gpuInfo()).toEqual({ totalMiB: 32607, freeMiB: 20007, ownMiB: 9000 });
    // Read at most every 2 s.
    await gpuInfo();
    expect(reads).toBe(1);
    now = 13_000;
    ctx.telemetry.otherGpuUsers = () => Promise.reject(new Error('no counters'));
    expect(await gpuInfo()).toEqual({ totalMiB: 32607, freeMiB: 20007 });
    now = 16_000;
    s.ownership.list = () => Promise.reject(new Error('no registry'));
    expect(await gpuInfo()).toEqual({ totalMiB: 32607, freeMiB: 20007 });

    const fit = (s.bench as unknown as { deps: { fit: (r: StartRunRequest, m: unknown, p: unknown) => Promise<unknown> } }).deps.fit;
    const req = { ...base, engine: { kind: 'llamacpp-native' as const }, model: { localId: 'abc' } };
    expect(await fit(req, { identity: local.identity }, { params: {} })).toBeUndefined();
    ms.models.fit = () => Promise.resolve({ level: 'good' } as never);
    expect(await fit(req, { identity: local.identity, local }, { params: { contextSize: 4096 } })).toEqual({ level: 'good' });
    expect(await fit(req, { identity: local.identity, local }, {})).toEqual({ level: 'good' });
    ms.models.fit = () => Promise.reject(new Error('no gpu'));
    expect(await fit(req, { identity: local.identity, local }, { params: {} })).toBeUndefined();

    // A hub GGUF still to download is estimated from its remote header.
    const asked: unknown[] = [];
    ms.models.fit = (r) => {
      asked.push(r);
      return Promise.resolve({ level: 'tight' } as never);
    };
    const pending = { repo: 'o/r', file: 'Q4/x-00001-of-00002.gguf', paths: [], bytes: 1 };
    expect(await fit(req, { identity: local.identity, pending }, { params: {} })).toEqual({ level: 'tight' });
    expect(asked).toEqual([{ repo: 'o/r', file: 'Q4/x-00001-of-00002.gguf', engine: 'llamacpp-native', params: {} }]);

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

describe('composition details', () => {
  let t: ReturnType<typeof tempDir>;
  beforeEach(() => {
    t = tempDir();
  });
  afterEach(() => t.cleanup());

  const quiet: ProcessRunner = {
    run: () => Promise.resolve({ code: 1, stdout: '', stderr: '', timedOut: false }),
    spawn: () => {
      throw new Error('no spawn');
    },
  };
  type Any = Record<string, (...a: unknown[]) => unknown>;

  it('passes the served model name to clients', () => {
    const make = clientFactory({ fetch: globalThis.fetch, clock: systemClock });
    expect(make('vllm', 'http://h:1', { model: 'gpubench-x' }).flavor).toBe('vllm');
  });

  it('feeds tokens, GPU arch and uv to the vLLM engines', async () => {
    const ctx = testContext(testDeps(t.dir, { proc: quiet, platform: 'linux' }));
    ctx.secrets.hfToken = 'hf_x';
    const s = await createServices(ctx, { modelServices: false });
    const vd = (s.vllmDocker as unknown as { v: Any }).v;
    expect(vd.hfToken!()).toBe('hf_x');
    expect(await vd.gpuSm!()).toBeUndefined();
    ctx.telemetry.probe = () => Promise.reject(new Error('no driver'));
    expect(await vd.gpuSm!()).toBeUndefined();
    ctx.telemetry.probe = () => Promise.resolve([{ computeCapability: '12.0' } as never]);
    expect(await vd.gpuSm!()).toBe('sm_120');
    // Registry adapters are wrapped for custom engines: the base adapter is `inner`.
    const vn = (s.registry.get('vllm-native') as unknown as { inner: { o: Any } }).inner.o;
    const sn = (s.registry.get('sglang-native') as unknown as { inner: { o: Any } }).inner.o;
    const sd = (s.sglangDocker as unknown as { s: Any }).s;
    expect(vn.hfToken!()).toBe('hf_x');
    expect(sn.hfToken!()).toBe('hf_x');
    expect(sd.hfToken!()).toBe('hf_x');
    expect(await vn.uv!()).toBeUndefined();
    s.uv.uvPath = () => Promise.resolve('/data/engines/uv/uv');
    expect(await vn.uv!()).toEqual(['/data/engines/uv/uv']);
    expect(await sn.uv!()).toEqual(['/data/engines/uv/uv']);
    // Docker installer size and the post-install refresh are wired to the real objects.
    s.dockerInstaller.installerSize = () => Promise.resolve(600_000_000);
    expect(await (s.systemCheck as unknown as { s: Any }).s.dockerInstallBytes!()).toBe(600_000_000);
    expect(s.refreshDocker()).toBeUndefined();
    // A failing status read after an install is ignored (the next poll will retry).
    s.docker.env.dockerStatus = () => Promise.reject(new Error('cli hung'));
    expect(s.refreshDocker()).toBeUndefined();
    await new Promise((r) => setTimeout(r, 5));
  });

  it('prepares servers like runs, and runs and servers block each other', async () => {
    const ctx = testContext(testDeps(t.dir, { proc: quiet }));
    const s = await createServices(ctx, { modelServices: false });
    const sd = (s.serve as unknown as { deps: Any }).deps;
    // Through the benchmark service (an external endpoint is already running: nothing to start).
    const external = { engine: { kind: 'external', baseUrl: 'http://h:1' }, model: { name: 'm' } };
    await expect(sd.prepare!(external, 'gpubench-m')).rejects.toMatchObject({ code: 'VALIDATION', params: { reason: 'external' } });
    await expect(sd.plan!(external)).rejects.toMatchObject({ code: 'VALIDATION', params: { reason: 'external' } });
    const seen: unknown[] = [];
    s.bench.prepareServer = (async (_req: unknown, o: unknown) => {
      seen.push(o);
      return {} as never;
    }) as typeof s.bench.prepareServer;
    await sd.prepare!(external, 'gpubench-m');
    expect(seen).toEqual([{ preview: false, marker: 'gpubench-m' }]);
    expect(sd.redact!(['x', '--api-key', 'k'], { HF_TOKEN: 'v' })).toEqual({ argv: ['x', '--api-key', '<API_KEY>'], env: { HF_TOKEN: '<HF_TOKEN>' } });
    expect(sd.onChange!()).toBeUndefined();
    // No server while a benchmark runs…
    expect(sd.blockedBy!()).toBeUndefined();
    s.bench.active = () => ({ runId: 'r1', phase: 'decode', progress: 0.5 }) as never;
    expect(sd.blockedBy!()).toMatchObject({ code: 'RUN_IN_PROGRESS', params: { reason: 'run_in_progress', runId: 'r1' } });
    // …and no benchmark while a server is up.
    const blockedBy = (s.bench as unknown as { deps: Any }).deps.blockedBy!;
    expect(blockedBy()).toBeUndefined();
    s.serve.busy = () => true;
    expect(blockedBy()).toMatchObject({ code: 'VRAM_BUSY', params: { reason: 'own_server' } });
  });

  it('protects the running container from cleanup and picks the GPU-check image', async () => {
    const ctx = testContext(testDeps(t.dir, { proc: quiet }));
    const s = await createServices(ctx, { modelServices: false });
    expect(s.activeMarker()).toBeUndefined();
    const newMarker = (s.bench as unknown as { deps: Any }).deps.newMarker!;
    const marker = newMarker() as string;
    s.bench.active = () => ({ runId: 'r', phase: 'decode', progress: 0.5 }) as never;
    expect(s.activeMarker()).toBe(marker);

    const app = createApp(ctx, { token: 't', port: () => 1, modules: serviceModules(s) });
    const H = { authorization: 'Bearer t', host: '127.0.0.1:1', 'content-type': 'application/json' };
    const images: string[] = [];
    s.docker.env.gpuCheck = (image: string) => {
      images.push(image);
      return Promise.resolve({ ok: true, output: 'GPU 0' } as never);
    };
    await app.request('/api/docker/gpu-check', { method: 'POST', headers: H, body: '{}' });
    await ctx.settings.update({ lastEngine: { kind: 'vllm-docker', image: 'vllm/vllm-openai:v0.31.0' } });
    await app.request('/api/docker/gpu-check', { method: 'POST', headers: H, body: '{}' });
    expect(images).toEqual(['ghcr.io/ggml-org/llama.cpp:server-cuda', 'vllm/vllm-openai:v0.31.0']);

    const kept: unknown[] = [];
    s.docker.env.cleanupOrphans = (keep?: Iterable<string>) => {
      kept.push([...(keep ?? [])]);
      return Promise.resolve({ removed: [] });
    };
    await app.request('/api/docker/cleanup', { method: 'POST', headers: H, body: '{}' });
    s.bench.active = () => undefined as never;
    await app.request('/api/docker/cleanup', { method: 'POST', headers: H, body: '{}' });
    // Servers started from here keep their containers too.
    s.serve.list = () => [{ id: 'gpubench-srv' }] as never;
    await app.request('/api/docker/cleanup', { method: 'POST', headers: H, body: '{}' });
    expect(kept).toEqual([[marker], [], ['gpubench-srv']]);

    // Pull progress goes to the event hub.
    const events: string[] = [];
    ctx.hub.subscribe((e) => events.push(e.type));
    s.docker.images.pull = (_ref, onProgress) => {
      onProgress({ bytesDone: 1, bytesTotal: 2, layersDone: 0, layersTotal: 1, status: 'Downloading' } as never);
      return Promise.resolve({});
    };
    await app.request('/api/docker/pull', { method: 'POST', headers: H, body: JSON.stringify({ image: 'ghcr.io/ggml-org/llama.cpp:server-cuda' }) });
    for (let i = 0; i < 50 && !events.includes('engine.install'); i++) await new Promise((r) => setTimeout(r, 10));
    expect(events).toContain('engine.install');
  });
});

describe('vLLM models from the library', () => {
  let t: ReturnType<typeof tempDir>;
  beforeEach(() => {
    t = tempDir();
  });
  afterEach(() => t.cleanup());

  const st: LocalModel = {
    ...local,
    id: 'st1',
    identity: { displayName: 'Qwen/Qwen3-0.6B', format: 'safetensors', source: 'hf', repo: 'Qwen/Qwen3-0.6B', files: [], weakKey: 'w' },
  };

  it('serves a downloaded repo from disk', async () => {
    const t1 = await resolveModelTarget(
      { ...base, engine: { kind: 'vllm-docker' }, model: { repo: 'Qwen/Qwen3-0.6B' } },
      { getLocal: async () => undefined, findByRepo: async () => st },
    );
    expect(t1).toEqual({ identity: st.identity, local: st, repo: 'Qwen/Qwen3-0.6B' });
    const lookup = modelsLookup({ models: { list: async () => [local, st] } as never });
    expect(await lookup.findByRepo!('Qwen/Qwen3-0.6B')).toBe(st);
    expect(await lookup.findByRepo!('other/repo')).toBeUndefined();
    const broken = modelsLookup({ models: { list: () => Promise.reject(new Error('scan failed')) } as never });
    expect(await broken.findByRepo!('Qwen/Qwen3-0.6B')).toBeUndefined();
  });

  it('plans the repo download before a vLLM run, sized from the hub listing', async () => {
    const quiet: ProcessRunner = {
      run: () => Promise.resolve({ code: 1, stdout: '', stderr: '', timedOut: false }),
      spawn: () => {
        throw new Error('no spawn');
      },
    };
    const ctx = testContext(testDeps(t.dir, { proc: quiet }));
    await ctx.settings.update({ scanKnownLocations: false });
    const s = await createServices(ctx);
    const needs = (s.bench as unknown as { deps: { needs: (r: StartRunRequest) => Promise<unknown> } }).deps.needs;
    const vreq = { ...base, engine: { kind: 'vllm-docker' as const }, model: { repo: 'Qwen/Qwen3-0.6B' } };
    s.modelServices!.models.hubFiles = async () =>
      [
        { path: 'model.safetensors', sizeBytes: 1000, kind: 'weights' },
        { path: 'config.json', sizeBytes: 10, kind: 'config' },
        { path: 'model.gguf', sizeBytes: 5000, kind: 'weights' },
        { path: 'original/consolidated.pth', sizeBytes: 9000, kind: 'other' },
      ] as never;
    expect(await needs(vreq)).toEqual([{ kind: 'model', label: 'Qwen/Qwen3-0.6B', bytes: 1010 }]);
    s.modelServices!.models.hubFiles = () => Promise.reject(new Error('offline'));
    expect(await needs(vreq)).toEqual([{ kind: 'model', label: 'Qwen/Qwen3-0.6B' }]);
    s.modelServices!.models.list = async () => [st];
    expect(await needs(vreq)).toEqual([]);
    // No repo (e.g. a local folder picked directly): nothing to download.
    expect(await needs({ ...vreq, model: { localId: 'st1' } })).toEqual([]);
  });

  it('plans the GGUF download of a llama.cpp run, sized from the resolved pending download', async () => {
    const quiet: ProcessRunner = {
      run: () => Promise.resolve({ code: 1, stdout: '', stderr: '', timedOut: false }),
      spawn: () => {
        throw new Error('no spawn');
      },
    };
    const ctx = testContext(testDeps(t.dir, { proc: quiet }));
    const s = await createServices(ctx, { modelServices: false });
    const needs = (s.bench as unknown as { deps: { needs: (r: StartRunRequest, m?: unknown) => Promise<unknown> } }).deps.needs;
    s.llama.detect = () => Promise.resolve({ kind: 'llamacpp-native', available: true, installed: true, problems: [], supported: true });
    const lreq = { ...base, engine: { kind: 'llamacpp-docker' as const }, model: { repo: 'Qwen/Qwen3-4B-GGUF', file: 'Qwen3-4B-Q4_K_M.gguf' } };
    const pending = { repo: 'Qwen/Qwen3-4B-GGUF', file: 'Qwen3-4B-Q4_K_M.gguf', paths: ['/x'], bytes: 2_500_000_000 };
    expect(await needs(lreq, { identity: local.identity, pending })).toEqual([
      { kind: 'model', label: 'Qwen/Qwen3-4B-GGUF/Qwen3-4B-Q4_K_M.gguf', bytes: 2_500_000_000 },
    ]);
    expect(await needs(lreq, { identity: local.identity, local })).toEqual([]);
  });

  it('previews a llama.cpp run of a hub GGUF that is not downloaded yet, end to end', async () => {
    const quiet: ProcessRunner = {
      run: () => Promise.resolve({ code: 1, stdout: '', stderr: '', timedOut: false }),
      spawn: () => {
        throw new Error('no spawn');
      },
    };
    const ctx = testContext(testDeps(t.dir, { proc: quiet }));
    await ctx.settings.update({ scanKnownLocations: false });
    const s = await createServices(ctx);
    const ms = s.modelServices!.models;
    const lib = await ms.libraryDir();
    const identity = { ...local.identity, source: 'hf' as const, repo: 'Qwen/Qwen3-4B-GGUF', file: 'Qwen3-4B-Q4_K_M.gguf' };
    const future = path.join(lib, 'Qwen', 'Qwen3-4B-GGUF', 'Qwen3-4B-Q4_K_M.gguf');
    ms.plannedGguf = async () => ({ identity, file: 'Qwen3-4B-Q4_K_M.gguf', paths: [future], bytes: 2_500_000_000 });
    // No llama.cpp build and no network: the preview uses the "latest" placeholder.
    s.llama.planInstall = () => Promise.reject(new Error('offline'));
    const req = { ...base, engine: { kind: 'llamacpp-native' as const }, model: { repo: 'Qwen/Qwen3-4B-GGUF', file: 'Qwen3-4B-Q4_K_M.gguf' } };
    const plan = await s.bench.plan(req);
    expect(plan.pending).toEqual(['engine', 'model']);
    expect(plan.command.argv.slice(1, 3)).toEqual(['-m', future]);
    expect(plan.needs).toEqual([
      { kind: 'model', label: 'Qwen/Qwen3-4B-GGUF/Qwen3-4B-Q4_K_M.gguf', bytes: 2_500_000_000 },
      { kind: 'engine', label: 'llama.cpp' },
    ]);
    // Starting is refused until the download is done.
    await expect(s.bench.start(req)).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND', params: { reason: 'not_downloaded' } });
  });
});

describe('Docker model volumes in the composition', () => {
  let t: ReturnType<typeof tempDir>;
  beforeEach(() => {
    t = tempDir();
  });
  afterEach(() => t.cleanup());

  const quiet: ProcessRunner = {
    run: () => Promise.resolve({ code: 1, stdout: '', stderr: '', timedOut: false }),
    spawn: () => {
      throw new Error('no spawn');
    },
  };

  it('uses the volume copy for llama.cpp Docker runs on Windows only', async () => {
    const ctx = testContext(testDeps(t.dir, { proc: quiet, platform: 'win32' }));
    const s = await createServices(ctx, { modelServices: false });
    const adjust = (s.bench as unknown as { deps: { adjustEngine: (r: StartRunRequest, m: unknown) => Promise<unknown> } }).deps.adjustEngine;
    const dreq = { ...base, engine: { kind: 'llamacpp-docker' as const }, model: { localId: 'abc' } };
    const target = { identity: local.identity, local };
    s.modelVolumes.exists = async () => true;
    expect(await adjust(dreq, target)).toEqual({ kind: 'llamacpp-docker', modelVolume: 'gpubench-model-abc' });
    expect(await adjust({ ...dreq, engine: { kind: 'llamacpp-docker', modelVolume: 'mine' } }, target)).toBeUndefined();
    expect(await adjust({ ...dreq, engine: { kind: 'vllm-docker' } }, target)).toBeUndefined();
    expect(await adjust(dreq, { identity: local.identity })).toBeUndefined();
    s.modelVolumes.exists = async () => false;
    expect(await adjust(dreq, target)).toBeUndefined();
    s.modelVolumes.exists = () => Promise.reject(new Error('docker down'));
    expect(await adjust(dreq, target)).toBeUndefined();

    const linux = await createServices(testContext(testDeps(t.dir, { proc: quiet, platform: 'linux' })), { modelServices: false });
    linux.modelVolumes.exists = async () => true;
    const adjustLinux = (linux.bench as unknown as { deps: { adjustEngine: (r: StartRunRequest, m: unknown) => Promise<unknown> } }).deps.adjustEngine;
    expect(await adjustLinux(dreq, target)).toBeUndefined();
  });

  it('serves the volume routes with the library lookup', async () => {
    const ctx = testContext(testDeps(t.dir, { proc: quiet }));
    const s = await createServices(ctx, { modelServices: false, models: { getLocal: async (id) => (id === 'abc' ? local : undefined) } });
    s.modelVolumes.copy = async () => 'v';
    s.modelVolumes.list = async () => ['abc'];
    const app = createApp(ctx, { token: 't', port: () => 1, modules: serviceModules(s) });
    const H = { authorization: 'Bearer t', host: '127.0.0.1:1', 'content-type': 'application/json' };
    expect(await (await app.request('/api/docker/model-volumes', { headers: H })).json()).toEqual({ localIds: ['abc'] });
    expect((await app.request('/api/docker/model-volumes', { method: 'POST', headers: H, body: JSON.stringify({ localId: 'abc' }) })).status).toBe(200);
    expect((await app.request('/api/docker/model-volumes', { method: 'POST', headers: H, body: JSON.stringify({ localId: 'zzz' }) })).status).toBe(404);
    const bare = await createServices(testContext(testDeps(t.dir, { proc: quiet })), { modelServices: false });
    const app2 = createApp(ctx, { token: 't', port: () => 1, modules: serviceModules(bare) });
    expect((await app2.request('/api/docker/model-volumes', { method: 'POST', headers: H, body: JSON.stringify({ localId: 'abc' }) })).status).toBe(404);
  });
});
