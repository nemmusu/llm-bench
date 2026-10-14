import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { launchParamsSchema, type LaunchParams } from '../../../../src/contract/engines';
import type { ExitInfo, LogLine, ManagedProcess, ProcessRunner, RunOutput, SpawnSpec } from '../../../../src/core/deps';
import { LlamaNativeAdapter, type LlamaDeps } from '../../../../src/core/engines/llamacpp-native/adapter';
import { CapsProbe } from '../../../../src/core/engines/llamacpp-native/caps';
import { LlamaReleasesClient } from '../../../../src/core/engines/llamacpp-native/releases';
import type { LaunchPlan, ModelTarget } from '../../../../src/core/engines/types';
import type { InferenceClient } from '../../../../src/core/inference/types';
import { systemClock } from '../../../../src/core/node-deps';
import { OwnershipRegistry } from '../../../../src/core/process/ownership';
import { AsyncQueue } from '../../../../src/core/process/runner';
import { startFakeEngine } from '../../../fakes/fake-engine/server.mjs';
import { startFakeGithub, type FakeGithub } from '../../../fakes/fake-github/server.mjs';

const fixture = (n: string) => readFileSync(new URL(`../../../fixtures/llamacpp/${n}`, import.meta.url), 'utf8');
const HELP = fixture('help.stdout.txt');
const VERSION = fixture('version.stderr.txt');
const OLD_HELP = '-fa,   --flash-attn                     enable Flash Attention\n-ngl,  --gpu-layers N                   layers';
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'gb-llama-'));
const MARK = 'gpubench-11112222333344445555';

interface FakeProcOpts {
  version?: RunOutput;
  help?: string;
  spawn?: (spec: SpawnSpec) => ManagedProcess;
}
function fakeProc(o: FakeProcOpts = {}): ProcessRunner & { specs: SpawnSpec[] } {
  const specs: SpawnSpec[] = [];
  return {
    specs,
    run: async (_cmd, args) => {
      if (args.includes('--version')) return o.version ?? { code: 0, stdout: '', stderr: VERSION, timedOut: false };
      if (args.includes('--help')) return { code: 0, stdout: o.help ?? HELP, stderr: '', timedOut: false };
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    },
    spawn: (spec) => {
      specs.push(spec);
      return (o.spawn ?? idleProcess)(spec);
    },
  };
}

function idleProcess(): ManagedProcess {
  const lines = new AsyncQueue<LogLine>();
  let done!: (e: ExitInfo) => void;
  const exited = new Promise<ExitInfo>((r) => (done = r));
  return {
    pid: 999_999,
    startedAt: 1,
    lines,
    exited,
    stop: async () => {
      lines.close();
      done({ code: 0, signal: null });
      return exited;
    },
  };
}

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
function deps(over: Partial<LlamaDeps> = {}): LlamaDeps {
  const root = tmp();
  return {
    clock: systemClock,
    proc: fakeProc(),
    fetch,
    platform: 'win32',
    arch: 'x64',
    paths: { dataDir: root, cacheDir: path.join(root, 'cache'), enginesDir: path.join(root, 'engines'), resultsDir: root, modelsDir: root, resourcesDir: root, home: root },
    endpoints: { githubApi: 'http://127.0.0.1:9', huggingface: 'http://127.0.0.1:9', dockerHub: 'http://127.0.0.1:9' },
    env: {},
    log,
    appVersion: '0.0.0-test',
    ...over,
  };
}

function writeBuild(enginesDir: string, tag: string, variant: string, server = 'llama-server.exe') {
  const dir = path.join(enginesDir, 'llamacpp', `${tag}-${variant}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, server), 'bin');
  writeFileSync(
    path.join(dir, 'install.json'),
    JSON.stringify({ schema: 1, tag, variant, backend: 'cuda', server, files: [server], installedAt: '2026-01-01T00:00:00Z', sources: [] }),
  );
  return path.join(dir, server);
}

const clientFactory = vi.fn((flavor: string, baseUrl: string) => ({ flavor, baseUrl }) as unknown as InferenceClient);
function adapter(d: LlamaDeps, extra: Partial<ConstructorParameters<typeof LlamaNativeAdapter>[0]> = {}) {
  return new LlamaNativeAdapter({
    deps: d,
    ownership: new OwnershipRegistry({ file: path.join(d.paths.dataDir, 'processes.json'), platform: d.platform, proc: d.proc }),
    createClient: clientFactory,
    ...extra,
  });
}

function model(paths: string[], aux: string[] = [], sizeBytes?: number): ModelTarget {
  const identity = { displayName: 'Tiny', format: 'gguf' as const, source: 'local' as const, files: [], weakKey: 'tiny', ...(sizeBytes ? { sizeBytes } : {}) };
  return {
    identity,
    local: {
      id: 'm1',
      identity,
      paths: [...paths, ...aux],
      auxiliary: aux.map((p) => ({ kind: 'mmproj' as const, path: p })),
      dir: '',
      origin: 'library',
      modifiedAt: '',
    },
  };
}
const params = (p: Partial<LaunchParams> = {}) => launchParamsSchema.parse(p);

describe('detect / resolveExecutable', () => {
  it('nothing installed', async () => {
    const st = await adapter(deps()).detect();
    expect(st).toEqual({ kind: 'llamacpp-native', available: false, installed: false, problems: ['ENGINE_NOT_INSTALLED'], supported: true });
  });

  it('managed build: newest by default, or the requested tag/id', async () => {
    const d = deps();
    writeBuild(d.paths.enginesDir, 'b100', 'cpu');
    const newest = writeBuild(d.paths.enginesDir, 'b200', 'cuda-13.4');
    const a = adapter(d);
    expect(await a.detect({ kind: 'llamacpp-native' })).toEqual({
      kind: 'llamacpp-native',
      available: true,
      installed: true,
      version: 'b10997',
      variant: 'cuda-13.4',
      location: newest,
      problems: [],
      supported: true,
    });
    expect((await a.detect({ kind: 'llamacpp-native', build: 'b100' })).variant).toBe('cpu');
    expect((await a.detect({ kind: 'llamacpp-native', build: 'b100-cpu' })).variant).toBe('cpu');
    expect((await a.detect({ kind: 'llamacpp-native', build: 'b5' })).problems).toEqual(['ENGINE_NOT_INSTALLED']);
  });

  it('custom executable: file or folder; variant guessed from neighbours', async () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'llama-server.exe'), '');
    writeFileSync(path.join(dir, 'cudart64_13.dll'), '');
    const a = adapter(deps());
    const byFile = await a.detect({ kind: 'llamacpp-native', executable: path.join(dir, 'llama-server.exe') });
    expect(byFile).toMatchObject({ available: true, variant: 'cuda-13', location: path.join(dir, 'llama-server.exe') });
    expect((await a.detect({ kind: 'llamacpp-native', executable: dir })).location).toBe(path.join(dir, 'llama-server.exe'));
    expect((await a.detect({ kind: 'llamacpp-native', executable: path.join(dir, 'nope.exe') })).problems).toEqual(['ENGINE_NOT_INSTALLED']);
    const empty = tmp();
    expect((await adapter(deps({ platform: 'linux' })).detect({ kind: 'llamacpp-native', executable: empty })).problems).toEqual([
      'ENGINE_NOT_INSTALLED',
    ]);
  });

  it('a binary that does not run is installed but unavailable', async () => {
    const d = deps({ proc: fakeProc({ version: { code: -1073741515, stdout: '', stderr: '', timedOut: false } }) });
    writeBuild(d.paths.enginesDir, 'b1', 'cpu');
    const st = await adapter(d).detect();
    expect(st).toMatchObject({ installed: true, available: false, problems: ['ENGINE_START_FAILED'] });
    expect(st.version).toBeUndefined();
    expect(st.problemParams).toBeUndefined();
  });

  it('a binary missing a system library says which, and the package that has it', async () => {
    const d = deps({ proc: fakeProc({ version: { code: 127, stdout: '', stderr: './llama-server: error while loading shared libraries: libgomp.so.1: cannot open shared object file: No such file or directory', timedOut: false } }) });
    writeBuild(d.paths.enginesDir, 'b1', 'cpu');
    const st = await adapter(d).detect();
    expect(st).toMatchObject({ installed: true, available: false, problems: ['ENGINE_MISSING_LIBRARY'], problemParams: { library: 'libgomp.so.1', package: 'libgomp1' } });
  });
});

describe('plan', () => {
  it('builds the exact llama-server argv from params and probed capabilities', async () => {
    const d = deps({ platform: 'linux', env: { LD_LIBRARY_PATH: '/usr/lib/wsl/lib' } });
    const exe = writeBuild(d.paths.enginesDir, 'b300', 'cuda-13.4', 'llama-server');
    const dir = tmp();
    const gguf = path.join(dir, 'm.gguf');
    writeFileSync(gguf, Buffer.alloc(1234));
    const mmproj = path.join(dir, 'mmproj.gguf');
    const plan = await adapter(d).plan(
      { kind: 'llamacpp-native' },
      model([gguf], [mmproj]),
      params({
        contextSize: 8192,
        gpuLayers: 99,
        flashAttention: 'on',
        kvCacheType: 'q8_0',
        batchSize: 2048,
        ubatchSize: 512,
        threads: 8,
        parallel: 4,
        extraArgs: ['--metrics'],
        env: { CUDA_VISIBLE_DEVICES: '0' },
      }),
      { port: 8123, marker: MARK },
    );
    expect(plan.argv).toEqual([
      exe, '-m', gguf, '--host', '127.0.0.1', '--port', '8123', '--alias', MARK, '-c', '8192', '-ngl', '99', '-fa', 'on',
      '-ctk', 'q8_0', '-ctv', 'q8_0', '-b', '2048', '-ub', '512', '-t', '8', '-np', '4', '--kv-unified', '--fit', 'off', '--no-webui',
      // Vision on (not switched off): the image projector the library grouped with the model.
      '--mmproj', mmproj, '--metrics',
    ]);
    expect(plan.env).toEqual({ LD_LIBRARY_PATH: `${path.dirname(exe)}:/usr/lib/wsl/lib`, CUDA_VISIBLE_DEVICES: '0' });
    expect(plan).toMatchObject({ kind: 'llamacpp-native', host: '127.0.0.1', port: 8123, marker: MARK, modelFiles: [gguf], modelBytes: 1234 });
    expect(plan.engine).toEqual({ kind: 'llamacpp-native', name: 'llama.cpp', variant: 'cuda-13.4', executable: exe, version: '0.4.1-dev', build: 'b10997' });
  });

  it('defaults: ctx 4096, all layers, flash attention auto, no KV type', async () => {
    const d = deps();
    const exe = writeBuild(d.paths.enginesDir, 'b300', 'cpu');
    const plan = await adapter(d, { launcherPrefix: ['node'] }).plan(
      { kind: 'llamacpp-native' },
      model([path.join(tmp(), 'missing.gguf')], [], 4096),
      params({ kvCacheType: 'auto' }),
      { port: 1, marker: MARK },
    );
    expect(plan.argv.slice(0, 2)).toEqual(['node', exe]);
    expect(plan.argv.slice(10)).toEqual(['-c', '4096', '-ngl', 'all', '-fa', 'auto', '--fit', 'off', '--no-webui']);
    expect(plan.env).toEqual({});
    expect(plan.modelBytes).toBe(4096);
  });

  it('old builds: bare -fa toggle, -ngl 999, no --fit; build from the manifest when --version is unparseable', async () => {
    const proc = fakeProc({ help: OLD_HELP, version: { code: 0, stdout: 'llama-server (old)', stderr: '', timedOut: false } });
    const d = deps({ proc });
    writeBuild(d.paths.enginesDir, 'b42', 'cpu');
    const a = adapter(d);
    const on = await a.plan({ kind: 'llamacpp-native' }, model([path.join(tmp(), 'x.gguf')]), params({ flashAttention: 'on' }), { port: 2, marker: MARK });
    expect(on.argv.slice(9)).toEqual(['-c', '4096', '-ngl', '999', '-fa']);
    expect(on.engine.build).toBe('b42');
    expect(on.engine.version).toBeUndefined();
    expect(on.modelBytes).toBe(0);
    const off = await a.plan({ kind: 'llamacpp-native' }, model([path.join(tmp(), 'x.gguf')]), params({ flashAttention: 'off' }), { port: 2, marker: MARK });
    expect(off.argv).not.toContain('-fa');
  });

  it('custom binary without parsable version and without -fa at all', async () => {
    const proc = fakeProc({ help: '--port PORT   port', version: { code: 0, stdout: '', stderr: '', timedOut: false } });
    const dir = tmp();
    writeFileSync(path.join(dir, 'llama-server.exe'), '');
    const plan = await adapter(deps({ proc })).plan(
      { kind: 'llamacpp-native', executable: dir },
      model([path.join(dir, 'm.gguf')]),
      params({ flashAttention: 'on' }),
      { port: 3, marker: MARK },
    );
    expect(plan.argv).not.toContain('-fa');
    expect(plan.engine.build).toBeUndefined();
  });

  it('needs a local weights file', async () => {
    const d = deps();
    writeBuild(d.paths.enginesDir, 'b1', 'cpu');
    const a = adapter(d);
    const noLocal: ModelTarget = { identity: { displayName: 'R', format: 'gguf', source: 'hf', files: [], weakKey: 'r' } };
    await expect(a.plan({ kind: 'llamacpp-native' }, noLocal, params(), { port: 1, marker: MARK })).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' });
    await expect(a.plan({ kind: 'llamacpp-native' }, model([], ['/x/mmproj.gguf']), params(), { port: 1, marker: MARK })).rejects.toMatchObject({
      code: 'MODEL_NOT_FOUND',
    });
  });

  it('capabilities() exposes the probe with the build variant', async () => {
    const d = deps();
    writeBuild(d.paths.enginesDir, 'b1', 'vulkan');
    const caps = await adapter(d).capabilities({ kind: 'llamacpp-native' });
    expect(caps).toMatchObject({ variant: 'vulkan', fitFlag: true, flashAttn: 'value' });
  });
});

describe('start', () => {
  const basePlan = (over: Partial<LaunchPlan> = {}): LaunchPlan => ({
    kind: 'llamacpp-native',
    argv: ['C:\\llama\\llama-server.exe', '-m', 'x'],
    env: { A: '1' },
    host: '127.0.0.1',
    port: 1,
    params: params(),
    engine: { kind: 'llamacpp-native', name: 'llama.cpp' },
    modelFiles: [],
    modelBytes: 0,
    marker: MARK,
    ...over,
  });

  it('refuses when already cancelled; wraps spawn exceptions', async () => {
    await expect(adapter(deps()).start(basePlan(), AbortSignal.abort())).rejects.toMatchObject({ code: 'CANCELLED' });
    const proc = fakeProc({
      spawn: () => {
        throw new Error('spawn EINVAL');
      },
    });
    await expect(adapter(deps({ proc })).start(basePlan(), new AbortController().signal)).rejects.toMatchObject({ code: 'ENGINE_START_FAILED' });
  });

  it('records ownership (warns when it cannot), passes env/cwd/owner, stops cleanly', async () => {
    const proc = fakeProc();
    const d = deps({ proc });
    const own = new OwnershipRegistry({ file: path.join(d.paths.dataDir, 'p.json'), platform: 'win32', proc });
    const a = new LlamaNativeAdapter({ deps: d, ownership: own, createClient: clientFactory, pollMs: 5, readyTimeoutMs: 50 });
    const inst = await a.start(basePlan({ cwd: 'C:\\work' }), new AbortController().signal);
    expect(proc.specs[0]).toEqual({ cmd: 'C:\\llama\\llama-server.exe', args: ['-m', 'x'], env: { A: '1' }, cwd: 'C:\\work', owner: { runId: MARK, marker: MARK } });
    expect((await own.list()).map((r) => [r.pid, r.exe, r.marker])).toEqual([[999_999, 'C:\\llama\\llama-server.exe', MARK]]);
    expect(clientFactory).toHaveBeenLastCalledWith('llamacpp', 'http://127.0.0.1:1');
    // Nothing listens on port 1: the probe keeps failing until the timeout.
    await expect(inst.waitReady()).rejects.toMatchObject({ code: 'ENGINE_TIMEOUT', params: { timeoutMs: 50 } });
    expect(await own.list()).toEqual([]);

    const broken = {
      add: async () => {
        throw new Error('disk full');
      },
      remove: async () => {},
    } as unknown as OwnershipRegistry;
    const warnBefore = log.warn.mock.calls.length;
    const inst2 = await new LlamaNativeAdapter({ deps: d, ownership: broken, createClient: clientFactory }).start(basePlan(), new AbortController().signal);
    expect(log.warn.mock.calls.length).toBe(warnBefore + 1);
    await inst2.stop();
  });

  it('skips ownership when the spawn produced no pid', async () => {
    const proc = fakeProc({ spawn: () => ({ ...idleProcess(), pid: -1 }) });
    const d = deps({ proc });
    const own = new OwnershipRegistry({ file: path.join(d.paths.dataDir, 'p.json'), platform: 'win32', proc });
    const inst = await new LlamaNativeAdapter({ deps: d, ownership: own, createClient: clientFactory }).start(basePlan(), new AbortController().signal);
    expect(await own.list()).toEqual([]);
    await inst.stop();
  });

  it('readiness requires /health 200 AND our alias in /v1/models', async () => {
    const ours = await startFakeEngine({ alias: MARK, profile: { loadMsWarm: 60 } });
    const foreign = await startFakeEngine({ alias: 'someone-else', profile: { loadMsWarm: 0 } });
    try {
      const a = adapter(deps(), { pollMs: 5, readyTimeoutMs: 3000 });
      const inst = await a.start(basePlan({ port: ours.port }), new AbortController().signal);
      expect((await inst.waitReady()).tReady).toBeGreaterThan(0);
      await inst.stop();

      const b = adapter(deps(), { pollMs: 5, readyTimeoutMs: 300 });
      const inst2 = await b.start(basePlan({ port: foreign.port }), new AbortController().signal);
      await foreign.loaded;
      await expect(inst2.waitReady()).rejects.toMatchObject({ code: 'ENGINE_TIMEOUT' });
    } finally {
      await ours.close();
      await foreign.close();
    }
  });

  it('a server shared on the network (--api-key) is probed with its key', async () => {
    const ours = await startFakeEngine({ alias: MARK, apiKey: 'gpub-secret-key', profile: { loadMsWarm: 30 } });
    try {
      const inst = await adapter(deps(), { pollMs: 5, readyTimeoutMs: 3000 }).start(basePlan({ port: ours.port, apiKey: 'gpub-secret-key' }), new AbortController().signal);
      expect((await inst.waitReady()).tReady).toBeGreaterThan(0);
      await inst.stop();
      // Other requests without the key are refused by the engine.
      expect((await fetch(`${ours.url}/v1/chat/completions`, { method: 'POST', body: '{}' })).status).toBe(401);
    } finally {
      await ours.close();
    }
  });

  it('a server without /v1/models is accepted on /health alone', async () => {
    const http = await import('node:http');
    const srv = http.createServer((req, res) => {
      res.writeHead(req.url === '/health' ? 200 : 404);
      res.end('{}');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as AddressInfo).port;
    try {
      const inst = await adapter(deps(), { pollMs: 5 }).start(basePlan({ port }), new AbortController().signal);
      await expect(inst.waitReady()).resolves.toMatchObject({ phases: [] });
      await inst.stop();
    } finally {
      srv.closeAllConnections();
      await new Promise((r) => srv.close(r));
    }
  });
});

describe('install flow through the adapter', () => {
  let gh: FakeGithub;
  beforeAll(async () => {
    gh = await startFakeGithub();
  });
  afterAll(() => gh.close());

  it('plans the newest usable release for this driver, installs, lists and removes it', async () => {
    const d = deps({ endpoints: { githubApi: gh.url, huggingface: '', dockerHub: '' }, env: { LD_LIBRARY_PATH: '/x' } });
    const a = adapter(d, { cudaVersion: async () => '13.4', install: { progressIntervalMs: 0 } });
    expect((await a.releases()).map((r) => r.tag)[0]).toBe('b11438');
    const plan = await a.installPlan({ kind: 'llamacpp-native' });
    expect(plan.label).toBe('llama.cpp b11438 (cuda-13.4)');
    expect(plan.items.map((i) => i.label)).toEqual(['llama-b11438-bin-win-cuda-13.4-x64.zip', 'cudart-llama-bin-win-cuda-13.4-x64.zip']);
    expect(plan.bytes).toBe(plan.items[0]!.bytes + plan.items[1]!.bytes);
    const stages: string[] = [];
    await a.install(plan, (p) => stages.push(p.stage), new AbortController().signal);
    expect(stages.at(-1)).toBe('done');
    expect((await a.listInstalled()).map((b) => b.id)).toEqual(['b11438-cuda-13.4']);
    expect((await a.detect()).location).toMatch(/b11438-cuda-13\.4[\\/]llama-server\.exe$/);
    await a.removeBuild('b11438-cuda-13.4');
    expect(await a.listInstalled()).toEqual([]);
  });

  it('specific build / variant, no driver → Vulkan, nothing suitable → no-asset', async () => {
    const d = deps({ endpoints: { githubApi: gh.url, huggingface: '', dockerHub: '' } });
    const a = adapter(d);
    expect((await a.installPlan({ kind: 'llamacpp-native', build: 'b11436' })).label).toBe('llama.cpp b11436 (vulkan)');
    expect((await a.planInstall({ variant: 'cpu' })).label).toBe('llama.cpp b11438 (cpu)');
    await expect(a.planInstall({ build: 'b1' })).rejects.toMatchObject({ code: 'ENGINE_INSTALL_FAILED', params: { reason: 'no-asset', build: 'b1' } });
    const mac = adapter(deps({ platform: 'darwin', arch: 'arm64', endpoints: { githubApi: gh.url, huggingface: '', dockerHub: '' } }));
    await expect(mac.planInstall({})).rejects.toMatchObject({ params: { reason: 'no-asset', build: '', variant: '' } });
    const cpuPlan = await a.planInstall({ variant: 'cpu' });
    expect(cpuPlan.items).toHaveLength(1);
    await expect(a.install({ ...cpuPlan, data: { nope: true } }, () => {}, new AbortController().signal)).rejects.toThrow();
    await a.install(cpuPlan, () => {}, new AbortController().signal);
    expect((await a.listInstalled()).map((b) => b.id)).toEqual(['b11438-cpu']);
  });

  it('previews the command before the install: the build the install would pick, with current flags', async () => {
    const d = deps({ endpoints: { githubApi: gh.url, huggingface: '', dockerHub: '' } });
    const a = adapter(d, { cudaVersion: async () => '13.4' });
    const gguf = path.join(tmp(), 'm.gguf');
    const plan = await a.plan({ kind: 'llamacpp-native' }, model([gguf], [], 2048), params({ parallel: 4 }), { port: 5, marker: MARK, preview: true });
    const exe = path.join(d.paths.enginesDir, 'llamacpp', 'b11438-cuda-13.4', 'llama-server.exe');
    expect(plan.argv).toEqual([
      exe, '-m', gguf, '--host', '127.0.0.1', '--port', '5', '--alias', MARK, '-c', '4096', '-ngl', 'all', '-fa', 'auto', '-np', '4', '--kv-unified', '--fit', 'off', '--no-webui',
    ]);
    expect(plan.pending).toEqual(['engine']);
    expect(plan.engine).toEqual({ kind: 'llamacpp-native', name: 'llama.cpp', variant: 'cuda-13.4', executable: exe, build: 'b11438' });
    expect(plan.env).toEqual({});
    // Nothing was probed or installed: the probe never ran a binary.
    expect(await a.listInstalled()).toEqual([]);
    // A real start is never a preview: the missing engine is reported.
    await expect(a.plan({ kind: 'llamacpp-native' }, model([gguf]), params(), { port: 5, marker: MARK })).rejects.toMatchObject({ code: 'ENGINE_NOT_INSTALLED' });
  });

  it('previews offline with a "latest" (or requested build) folder; a missing custom executable still fails', async () => {
    const d = deps({ platform: 'linux', env: { LD_LIBRARY_PATH: '/usr/lib/wsl/lib' } });
    const a = adapter(d);
    const gguf = path.join(tmp(), 'm.gguf');
    const latest = await a.plan({ kind: 'llamacpp-native' }, model([gguf]), params(), { port: 6, marker: MARK, preview: true });
    const dir = path.join(d.paths.enginesDir, 'llamacpp', 'latest');
    expect(latest.argv[0]).toBe(path.join(dir, 'llama-server'));
    expect(latest.engine).toEqual({ kind: 'llamacpp-native', name: 'llama.cpp', variant: 'cuda', executable: path.join(dir, 'llama-server') });
    // The planned managed build gets the bundled CUDA runtime on Linux, like an installed one.
    expect(latest.env).toEqual({ LD_LIBRARY_PATH: `${dir}:/usr/lib/wsl/lib` });
    const pinned = await a.plan({ kind: 'llamacpp-native', build: 'b5' }, model([gguf]), params(), { port: 6, marker: MARK, preview: true });
    expect(pinned.argv[0]).toBe(path.join(d.paths.enginesDir, 'llamacpp', 'b5', 'llama-server'));
    await expect(
      a.plan({ kind: 'llamacpp-native', executable: path.join(tmp(), 'nope') }, model([gguf]), params(), { port: 6, marker: MARK, preview: true }),
    ).rejects.toMatchObject({ code: 'ENGINE_NOT_INSTALLED' });
  });

  it('previews a GGUF still to download at its future library path', async () => {
    const d = deps();
    const exe = writeBuild(d.paths.enginesDir, 'b300', 'cpu');
    const a = adapter(d);
    const future = path.join(d.paths.modelsDir, 'Qwen', 'Qwen3-4B-GGUF', 'Qwen3-4B-Q4_K_M.gguf');
    const target: ModelTarget = {
      identity: { displayName: 'Qwen3-4B-Q4_K_M', format: 'gguf', source: 'hf', files: [], weakKey: 'w', sizeBytes: 2_500_000_000 },
      pending: { repo: 'Qwen/Qwen3-4B-GGUF', file: 'Qwen3-4B-Q4_K_M.gguf', paths: [future], bytes: 2_500_000_000 },
    };
    const plan = await a.plan({ kind: 'llamacpp-native' }, target, params(), { port: 7, marker: MARK, preview: true });
    expect(plan.argv.slice(0, 3)).toEqual([exe, '-m', future]);
    expect(plan.pending).toEqual(['model']);
    expect(plan.modelFiles).toEqual([future]);
    expect(plan.modelBytes).toBe(2_500_000_000);
    await expect(a.plan({ kind: 'llamacpp-native' }, target, params(), { port: 7, marker: MARK })).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' });
    // Neither engine nor model yet: both are pending.
    const bare = adapter(deps());
    expect((await bare.plan({ kind: 'llamacpp-native' }, target, params(), { port: 7, marker: MARK, preview: true })).pending).toEqual(['engine', 'model']);
    // An installed build and a local model: nothing pending.
    expect((await a.plan({ kind: 'llamacpp-native' }, model([future]), params(), { port: 7, marker: MARK, preview: true })).pending).toBeUndefined();
  });

  it('accepts injected collaborators', () => {
    const d = deps();
    const caps = new CapsProbe(d.proc);
    const releases = new LlamaReleasesClient({ fetch, githubApi: 'http://x', cacheDir: tmp() });
    expect(adapter(d, { caps, releases }).caps).toBe(caps);
  });
});
