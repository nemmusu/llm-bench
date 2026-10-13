import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import {
  argValue,
  boot,
  buildDeps,
  defaultDataDir,
  onBootError,
  processBootEnv,
  toolOverride,
  type BootEnv,
  type ParentPort,
} from '../../../src/core/bootstrap';
import { tempDir } from './server/helpers';

function fakeHost(dir: string, over: Partial<BootEnv> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const signals = new Map<string, () => void>();
  const exits: number[] = [];
  let coverageTaken = 0;
  const host: BootEnv = {
    env: { GPUBENCH_DATA_DIR: dir },
    argv: [],
    platform: 'linux',
    arch: 'x64',
    home: dir,
    dirname: path.join(dir, 'out', 'core'),
    appVersion: '1.2.3',
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    onSignal: (s, h) => signals.set(s, h),
    exit: (c) => exits.push(c),
    takeCoverage: () => {
      coverageTaken++;
    },
    ...over,
  };
  return { host, out, err, signals, exits, coverage: () => coverageTaken };
}

describe('bootstrap helpers', () => {
  it('reads --name=value arguments and tool overrides', () => {
    expect(argValue(['x', '--port=123', '--token=abc'], 'port')).toBe('123');
    expect(argValue([], 'port')).toBeUndefined();
    expect(toolOverride(undefined)).toBeUndefined();
    expect(toolOverride('["node","fake.mjs"]')).toEqual(['node', 'fake.mjs']);
    expect(toolOverride('[1,2]')).toEqual(['[1,2]']);
    expect(toolOverride('C:\\tools\\nvidia-smi.exe')).toEqual(['C:\\tools\\nvidia-smi.exe']);
  });

  it('puts data in the usual per-user folder of each OS', () => {
    expect(defaultDataDir('win32', { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'C:\\Users\\u')).toBe(path.join('C:\\Users\\u\\AppData\\Roaming', 'GPU Bench'));
    expect(defaultDataDir('win32', {}, '/h')).toBe(path.join('/h', 'AppData', 'Roaming', 'GPU Bench'));
    expect(defaultDataDir('linux', { XDG_CONFIG_HOME: '/x' }, '/h')).toBe(path.join('/x', 'gpu-bench'));
    expect(defaultDataDir('linux', {}, '/h')).toBe(path.join('/h', '.config', 'gpu-bench'));
  });

  it('builds deps from the environment, defaults included', () => {
    const d = buildDeps({ ...fakeHost('/data').host, env: {}, argv: ['--data-dir=/argdata'], platform: 'aix' });
    expect(d.platform).toBe('linux');
    expect(d.paths.dataDir).toBe('/argdata');
    expect(d.paths.modelsDir).toBe(path.join('/data', 'GPU Bench', 'models'));
    expect(d.paths.resourcesDir).toBe(path.resolve('/data/out/core', '../../resources'));
    expect(d.endpoints).toMatchObject({ githubApi: 'https://api.github.com', huggingface: 'https://huggingface.co', dockerHub: 'https://hub.docker.com' });
    const e = buildDeps({
      ...fakeHost('/data').host,
      platform: 'win32',
      env: {
        GPUBENCH_MODELS_DIR: '/m',
        GPUBENCH_RESOURCES_DIR: '/r',
        GPUBENCH_UI_DIR: '/ui',
        GPUBENCH_GITHUB_API: 'http://gh',
        GPUBENCH_HF_ENDPOINT: 'http://hf',
        GPUBENCH_DOCKERHUB: 'http://dh',
        GPUBENCH_NVIDIA_SMI: '["node","smi.mjs"]',
        GPUBENCH_GPU_MEMORY_MONITOR: '["node","gpu-memory.mjs"]',
        GPUBENCH_DOCKER: 'docker2',
        GPUBENCH_DOCKER_HOST: '//./pipe/x',
        GPUBENCH_DOCKER_INSTALLER_URL: 'http://inst',
        GPUBENCH_DEBUG: '1',
        APPDATA: '/appdata',
      },
    });
    expect(e.platform).toBe('win32');
    expect(e.paths).toMatchObject({ dataDir: path.join('/appdata', 'GPU Bench'), modelsDir: '/m', resourcesDir: '/r', uiDir: '/ui' });
    expect(e.endpoints).toEqual({
      githubApi: 'http://gh',
      huggingface: 'http://hf',
      dockerHub: 'http://dh',
      nvidiaSmi: ['node', 'smi.mjs'],
      gpuMemoryMonitor: ['node', 'gpu-memory.mjs'],
      docker: ['docker2'],
      dockerHost: '//./pipe/x',
      dockerInstaller: 'http://inst',
    });
  });

  it('reports start-up failures and exits with an error', () => {
    const err: string[] = [];
    const exits: number[] = [];
    const fail = onBootError({ stderr: (t) => err.push(t), exit: (c) => exits.push(c) });
    fail(new Error('port in use'));
    fail('weird');
    const noStack = new Error('no stack');
    noStack.stack = undefined;
    fail(noStack);
    expect(err[0]).toContain('core failed to start: Error: port in use');
    expect(err[1]).toBe('core failed to start: weird\n');
    expect(err[2]).toBe('core failed to start: no stack\n');
    expect(exits).toEqual([1, 1, 1]);
  });
});

describe('boot', () => {
  let t: ReturnType<typeof tempDir>;
  beforeEach(() => {
    t = tempDir();
  });
  afterEach(() => t.cleanup());

  it('standalone: prints the ready line with token and URL; SIGTERM closes and exits once', async () => {
    const f = fakeHost(t.dir, { argv: ['--token=tok'], env: { GPUBENCH_DATA_DIR: t.dir, GPUBENCH_LLAMA_LAUNCHER: '["node"]' } });
    const core = await boot(f.host);
    const ready = JSON.parse(f.out[0]!) as { ready: boolean; port: number; token: string; url: string };
    expect(ready).toMatchObject({ ready: true, token: 'tok', port: core.port });
    expect(ready.url).toBe(`${core.url}/?token=tok`);
    f.signals.get('SIGTERM')!();
    f.signals.get('SIGINT')!();
    await vi.waitFor(() => expect(f.exits).toEqual([0]));
    expect(f.coverage()).toBe(0);
  });

  it('inside Electron: says ready on the parent port, takes the HF token and shuts down on request', async () => {
    const posted: unknown[] = [];
    const listeners: ((e: { data: unknown }) => void)[] = [];
    const onMessage = (e: { data: unknown }) => listeners.forEach((l) => l(e));
    const parentPort: ParentPort = { postMessage: (m) => posted.push(m), on: (_ev, cb) => void listeners.push(cb) };
    const f = fakeHost(t.dir, { parentPort, env: { GPUBENCH_DATA_DIR: t.dir, GPUBENCH_TOKEN: 'x', GPUBENCH_PORT: '0', NODE_V8_COVERAGE: '/cov' } });
    const core = await boot(f.host);
    expect(posted[0]).toEqual({ type: 'ready', port: core.port });
    // Then the tray's state: no servers, no presets, the default close behaviour.
    await vi.waitFor(() => expect(posted[1]).toMatchObject({ type: 'shell-state', state: { servers: [], presets: [], closeBehavior: 'tray-if-servers' } }));
    expect(f.out).toEqual([]);
    // A new API key goes to the main process to be saved encrypted; its answer is kept.
    const key = core.services.keys.current().key;
    expect(posted).toContainEqual({ type: 'server-api-key-save', key });
    onMessage({ data: { type: 'server-api-key', key, storage: 'encrypted' } });
    expect(core.services.keys.current().storage).toBe('encrypted');
    onMessage({ data: { type: 'hf-token', token: 'hf_secret' } });
    expect(core.ctx.secrets.hfToken).toBe('hf_secret');
    onMessage({ data: { type: 'hf-token', token: null } });
    expect(core.ctx.secrets.hfToken).toBeUndefined();
    onMessage({ data: null });
    onMessage({ data: { type: 'something-else' } });
    onMessage({ data: { type: 'shutdown' } });
    await vi.waitFor(() => expect(f.exits).toEqual([0]));
    expect(f.coverage()).toBe(1);
  });

  it('random token when none is given', async () => {
    const f = fakeHost(t.dir);
    const core = await boot(f.host);
    expect((JSON.parse(f.out[0]!) as { token: string }).token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    await core.close();
  });
});

describe('processBootEnv', () => {
  it('binds the real process', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const ewrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const on = vi.spyOn(process, 'on');
    const host = processBootEnv('/dir', '1.0.0');
    expect(host).toMatchObject({ dirname: '/dir', appVersion: '1.0.0', platform: process.platform, arch: process.arch });
    expect(host.parentPort).toBeUndefined();
    host.stdout('a');
    host.stderr('b');
    const handler = () => {};
    host.onSignal('SIGTERM', handler);
    host.exit(3);
    host.takeCoverage();
    expect(write).toHaveBeenCalledWith('a');
    expect(ewrite).toHaveBeenCalledWith('b');
    expect(on).toHaveBeenCalledWith('SIGTERM', handler);
    expect(exit).toHaveBeenCalledWith(3);
    process.off('SIGTERM', handler);
    vi.restoreAllMocks();

    const port: ParentPort = { postMessage: () => {}, on: () => {} };
    (process as unknown as { parentPort?: ParentPort }).parentPort = port;
    try {
      expect(processBootEnv('/dir', '1').parentPort).toBe(port);
    } finally {
      delete (process as unknown as { parentPort?: ParentPort }).parentPort;
    }
  });
});
