// SGLang native (Linux): the Python, its version and help, the command, a real start of the fake
// engine in SGLang mode standing in for `python -m sglang.launch_server`, and the uv install.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { launchParamsSchema } from '../../../../../src/contract/engines';
import type { Platform, ProcessRunner } from '../../../../../src/core/deps';
import { HF_PLACEHOLDER } from '../../../../../src/core/engines/command-display';
import { SGLANG_LONGER_CONTEXT_ENV } from '../../../../../src/core/engines/shared/sglang';
import { SglangNativeAdapter, sglangVenvPaths, type SglangNativeDeps } from '../../../../../src/core/engines/sglang-native/adapter';
import type { ModelTarget } from '../../../../../src/core/engines/types';
import { createInferenceClient } from '../../../../../src/core/inference/client';
import { systemClock } from '../../../../../src/core/node-deps';
import type { OwnedRecord } from '../../../../../src/core/process/ownership';
import { pickFreePort } from '../../../../../src/core/process/ports';
import { createProcessRunner } from '../../../../../src/core/process/runner';
import { FAKE_ENGINE, fail, manualProcess, ok, scriptedProc, silentLog, tempDir } from '../../docker/helpers';

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups) c();
});
const tmp = () => {
  const t = tempDir('gb-snat-');
  cleanups.push(t.cleanup);
  return t.dir;
};
const P = (o: object = {}) => launchParamsSchema.parse(o);
const noClient = () => ({}) as never;
const repoModel: ModelTarget = { identity: { displayName: 'Qwen3', format: 'safetensors', source: 'hf', repo: 'Qwen/Qwen3-0.6B', files: [], weakKey: 'q', sizeBytes: 7 } };

function deps(root: string, proc: ProcessRunner = scriptedProc(() => ok('0.5.21\n')), platform: Platform = 'linux'): SglangNativeDeps {
  return {
    clock: systemClock,
    proc,
    fetch,
    platform,
    log: silentLog,
    paths: { dataDir: root, cacheDir: root, enginesDir: path.join(root, 'engines'), resultsDir: root, modelsDir: root, resourcesDir: root, home: root },
  };
}

/** A managed venv: enginesDir/sglang-venv/bin/python. */
function managedVenv(root: string): string {
  const p = sglangVenvPaths(path.join(root, 'engines'));
  mkdirSync(path.dirname(p.python), { recursive: true });
  writeFileSync(p.python, 'ELF');
  return p.python;
}

describe('SglangNativeAdapter: detection', () => {
  it('is unsupported on Windows (Docker there)', async () => {
    const a = new SglangNativeAdapter({ deps: deps(tmp(), undefined, 'win32'), createClient: noClient });
    expect(await a.detect()).toEqual({ kind: 'sglang-native', available: false, installed: false, problems: [], supported: false });
    await expect(a.plan({ kind: 'sglang-native' }, repoModel, P(), { port: 1, marker: 'gpubench-m' })).rejects.toMatchObject({ code: 'ENGINE_NOT_INSTALLED', params: { reason: 'unsupported-os' } });
    await expect(a.installPlan()).rejects.toMatchObject({ code: 'ENGINE_INSTALL_FAILED', params: { reason: 'unsupported-os' } });
  });

  it('finds the managed venv, a python or a venv folder, with the version (cached)', async () => {
    const root = tmp();
    const proc = scriptedProc(() => ok('0.5.21\n'));
    const a = new SglangNativeAdapter({ deps: deps(root, proc), createClient: noClient });
    expect(await a.detect()).toMatchObject({ installed: false, problems: ['ENGINE_NOT_INSTALLED'] });
    const py = managedVenv(root);
    expect(await a.detect()).toEqual({ kind: 'sglang-native', available: true, installed: true, location: py, version: '0.5.21', problems: [], supported: true });
    await a.detect();
    expect(proc.calls).toHaveLength(1);
    expect(proc.calls[0]?.args).toEqual(['-c', 'import sglang; print(sglang.__version__)']);
    const venv = path.join(root, 'myvenv');
    mkdirSync(path.join(venv, 'bin'), { recursive: true });
    writeFileSync(path.join(venv, 'bin', 'python'), 'ELF');
    expect((await a.detect({ kind: 'sglang-native', sglangPath: venv })).location).toBe(path.join(venv, 'bin', 'python'));
    await expect(a.resolvePython({ kind: 'sglang-native', sglangPath: path.join(root, 'nope') })).rejects.toMatchObject({ code: 'ENGINE_NOT_INSTALLED' });
  });

  it('tells a Python without SGLang from one that does not run', async () => {
    const root = tmp();
    managedVenv(root);
    const noModule = new SglangNativeAdapter({ deps: deps(root, scriptedProc(() => fail(1, "ModuleNotFoundError: No module named 'sglang'"))), createClient: noClient });
    expect(await noModule.detect()).toMatchObject({ available: false, installed: true, problems: ['ENGINE_NOT_INSTALLED'] });
    const root2 = tmp();
    managedVenv(root2);
    const broken = new SglangNativeAdapter({ deps: deps(root2, scriptedProc(() => fail(1, 'ImportError: libcudart.so.13'))), createClient: noClient });
    expect(await broken.detect({ kind: 'sglang-native', probeEnv: { LD_LIBRARY_PATH: '/x' } })).toMatchObject({ problems: ['ENGINE_START_FAILED'] });
  });

  it('reads the options from one --help (cached), with the probe environment', async () => {
    const root = tmp();
    managedVenv(root);
    const help = '  --host HOST  h\n  --port PORT  p\n  --kv-cache-dtype {auto,fp8_e5m2,fp8_e4m3}\n';
    const proc = scriptedProc((args) => (args.includes('--help') ? ok(help) : ok('0.5.21')));
    const a = new SglangNativeAdapter({ deps: deps(root, proc), createClient: noClient });
    const caps = await a.capabilities({ kind: 'sglang-native', probeEnv: { A: '1' } });
    expect(caps).toMatchObject({ version: '0.5.21', tokenIdsInPrompt: true, minTokens: true, timings: false });
    expect(caps.choices?.['--kv-cache-dtype']).toEqual(['auto', 'fp8_e5m2', 'fp8_e4m3']);
    await a.capabilities({ kind: 'sglang-native' });
    const helpCalls = proc.calls.filter((c) => c.args.includes('--help'));
    expect(helpCalls).toHaveLength(1);
    expect(helpCalls[0]?.args).toEqual(['-m', 'sglang.launch_server', '--help']);
    expect(helpCalls[0]?.opts?.env).toEqual({ A: '1' });
    const noVersion = new SglangNativeAdapter({ deps: deps(root, scriptedProc(() => ok(''))), createClient: noClient });
    expect(await noVersion.capabilities({ kind: 'sglang-native' })).not.toHaveProperty('version');
  });
});

describe('SglangNativeAdapter: plan', () => {
  it('runs `python -m sglang.launch_server` on loopback, the token as a placeholder', async () => {
    const root = tmp();
    const py = managedVenv(root);
    const a = new SglangNativeAdapter({ deps: deps(root), createClient: noClient, hfToken: () => 'hf_real' });
    const plan = await a.plan({ kind: 'sglang-native' }, { ...repoModel, identity: { ...repoModel.identity, revision: 'abc' } }, P({ parallel: 2, ropeScaling: { type: 'yarn', factor: 2, originalContext: 4096 } }), { port: 8123, marker: 'gpubench-m1' });
    expect(plan.argv.slice(0, 5)).toEqual([py, '-m', 'sglang.launch_server', '--model-path', 'Qwen/Qwen3-0.6B']);
    expect(plan.argv).toContain('--revision');
    expect(plan.env).toEqual({ [SGLANG_LONGER_CONTEXT_ENV]: '1', HF_TOKEN: HF_PLACEHOLDER });
    expect(plan.engine).toEqual({ kind: 'sglang-native', name: 'SGLang', executable: py, version: '0.5.21' });
    expect(plan).toMatchObject({ host: '127.0.0.1', port: 8123, modelFiles: [], modelBytes: 7, modelRepo: 'Qwen/Qwen3-0.6B' });
  });

  it('a server shows its API name and keeps the marker as a Python -X option', async () => {
    const root = tmp();
    managedVenv(root);
    const dir = path.join(root, 'm');
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'model.safetensors'), Buffer.alloc(10));
    const identity = { ...repoModel.identity, source: 'local' as const, sizeBytes: undefined };
    const local: ModelTarget = { identity, local: { id: 'l', identity, paths: [path.join(dir, 'model.safetensors'), path.join(dir, 'gone')], auxiliary: [], dir, origin: 'library', modifiedAt: '' } };
    const a = new SglangNativeAdapter({ deps: deps(root, scriptedProc(() => ok('nothing'))), createClient: noClient, launcherPrefix: ['node'] });
    const plan = await a.plan({ kind: 'sglang-native' }, local, P(), { port: 1, marker: 'gpubench-m', apiName: 'Qwen3', knownFlags: new Set(['--model-path', '--host', '--port', '--served-model-name']) });
    expect(plan.argv.slice(0, 6)).toEqual(['node', sglangVenvPaths(path.join(root, 'engines')).python, '-X', 'gpubench=gpubench-m', '-m', 'sglang.launch_server']);
    expect(plan.argv[plan.argv.indexOf('--served-model-name') + 1]).toBe('Qwen3');
    expect(plan.argv[plan.argv.indexOf('--model-path') + 1]).toBe(dir);
    expect(plan.engine).not.toHaveProperty('version');
    expect(plan.modelBytes).toBe(10);
    // A fork without these options: left out, and said.
    expect(plan.unsupported?.map((m) => m.flag)).toEqual(['--context-length', '--mem-fraction-static', '--random-seed', '--enable-cache-report']);
    const unknown = await a.plan({ kind: 'sglang-native' }, { identity: { ...identity, repo: 'r/x' } }, P(), { port: 1, marker: 'gpubench-m' });
    expect(unknown.modelBytes).toBe(0);
  });
});

describe('SglangNativeAdapter: start (fake engine in SGLang mode)', () => {
  it('waits for the served name, generates with token ids and cached tokens, and stops', async () => {
    const root = tmp();
    const py = managedVenv(root);
    writeFileSync(py, '');
    const proc = createProcessRunner({
      clock: systemClock,
      platform: process.platform as Platform,
      baseEnv: { ...process.env, FAKE_ENGINE_PROFILE: JSON.stringify({ loadMsWarm: 100, decodeTps: 500, prefillTps: 50_000 }) },
    });
    const records: OwnedRecord[] = [];
    const removed: number[] = [];
    // The fake engine stands in for the venv's python: node <cli.mjs> -m sglang.launch_server …
    const a = new SglangNativeAdapter({
      deps: deps(root, proc),
      createClient: (flavor, baseUrl, o) => createInferenceClient(flavor, baseUrl, { fetch, clock: systemClock }, o),
      launcherPrefix: [process.execPath],
      ownership: { add: async (r) => void records.push(r), remove: async (pid) => void removed.push(pid) },
      hfToken: () => 'hf_secret',
      pollMs: 30,
      readyTimeoutMs: 20_000,
    });
    const plan = await a.plan({ kind: 'sglang-native', sglangPath: FAKE_ENGINE }, repoModel, P({ contextSize: 4096 }), { port: await pickFreePort(), marker: `gpubench-sn${process.pid}` });
    const inst = await a.start(plan, new AbortController().signal);
    const ready = await inst.waitReady();
    expect(ready.phases.map((p) => p.name)).toEqual(expect.arrayContaining(['load_tensors', 'kv_cache', 'graph_capture']));
    expect(records[0]).toMatchObject({ exe: process.execPath, marker: plan.marker });
    expect(inst.client.flavor).toBe('sglang');
    const ids = await inst.client.tokenize('hello world, hello world, hello world', { addSpecial: true });
    const events = [];
    for await (const e of inst.client.generate({ promptIds: ids, outputTokens: 8, seed: 1 })) events.push(e);
    expect(events.at(-1)).toMatchObject({ kind: 'done', usage: { completionTokens: 8, cachedTokens: 0 } });
    const again = [];
    for await (const e of inst.client.generate({ promptIds: ids, outputTokens: 8, seed: 1 })) again.push(e);
    expect((again.at(-1) as { usage: { cachedTokens: number } }).usage.cachedTokens).toBeGreaterThan(0);
    expect(inst.logTail().some((l) => /fired up and ready to roll/.test(l))).toBe(true);
    await inst.stop();
    expect(removed).toContain(inst.pid);
  });

  it('diagnoses an early exit and refuses a cancelled start', async () => {
    const root = tmp();
    managedVenv(root);
    const proc = createProcessRunner({ clock: systemClock, platform: process.platform as Platform, baseEnv: { ...process.env, FAKE_ENGINE_PROFILE: JSON.stringify({ loadMsWarm: 50, oomAtLoad: true }) } });
    const a = new SglangNativeAdapter({ deps: deps(root, proc), createClient: (f, b, o) => createInferenceClient(f, b, { fetch, clock: systemClock }, o), launcherPrefix: [process.execPath], pollMs: 30 });
    const plan = await a.plan({ kind: 'sglang-native', sglangPath: FAKE_ENGINE }, repoModel, P(), { port: await pickFreePort(), marker: 'gpubench-oom' });
    const inst = await a.start(plan, new AbortController().signal);
    await expect(inst.waitReady()).rejects.toMatchObject({ code: 'ENGINE_OOM' });
    const ac = new AbortController();
    ac.abort();
    await expect(a.start(plan, ac.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    const throwing = new SglangNativeAdapter({
      deps: deps(root, { run: async () => ok(), spawn: () => { throw new Error('EACCES'); } }),
      createClient: noClient,
      ownership: { add: async () => {}, remove: async () => {} },
    });
    await expect(throwing.start(plan, new AbortController().signal)).rejects.toMatchObject({ code: 'ENGINE_START_FAILED' });
  });

  it('keeps going when the ownership record fails', async () => {
    const root = tmp();
    managedVenv(root);
    const mp = manualProcess(0, 77);
    const proc: ProcessRunner = { run: async () => ok('0.5.21'), spawn: () => mp };
    const a = new SglangNativeAdapter({ deps: deps(root, proc), createClient: noClient, ownership: { add: () => Promise.reject(new Error('disk')), remove: async () => {} } });
    // A local folder: no repo to name in errors.
    const dir = path.join(root, 'local');
    mkdirSync(dir);
    const identity = { ...repoModel.identity, source: 'local' as const };
    const local: ModelTarget = { identity, local: { id: 'l', identity, paths: [], auxiliary: [], dir, origin: 'library', modifiedAt: '' } };
    const plan = await a.plan({ kind: 'sglang-native' }, local, P(), { port: 1, marker: 'gpubench-x' });
    const inst = await a.start(plan, new AbortController().signal);
    mp.exit({ code: 1, signal: null });
    await expect(inst.waitReady()).rejects.toMatchObject({ code: 'ENGINE_EXITED' });
  });
});

describe('SglangNativeAdapter: install', () => {
  it('installs SGLang in its own uv venv and checks the version', async () => {
    const root = tmp();
    const steps: string[] = [];
    const proc = scriptedProc(() => ok('0.5.21\n'), (spec) => {
      steps.push(spec.args.slice(0, 2).join(' '));
      const mp = manualProcess();
      queueMicrotask(() => {
        mp.push('Resolved 120 packages in 2s');
        mp.push('Downloading torch (5.0MiB)');
        mp.exit({ code: 0, signal: null });
      });
      return mp;
    });
    const a = new SglangNativeAdapter({ deps: deps(root, proc), createClient: noClient, uv: async () => ['/uv'] });
    const plan = await a.installPlan();
    expect(plan).toMatchObject({ kind: 'sglang-native', label: 'SGLang (sglang)', bytes: 0, data: { spec: 'sglang' } });
    const events: string[] = [];
    await a.install(plan, (p) => events.push(p.stage), new AbortController().signal);
    expect(steps).toEqual(['venv ' + sglangVenvPaths(path.join(root, 'engines')).venv, 'pip install']);
    expect(events.at(-1)).toBe('done');
    // uv given as a list, default spec: the same; a Python without SGLang afterwards: failed.
    const bad = new SglangNativeAdapter({ deps: deps(root, scriptedProc(() => fail(1, 'No module named sglang'), () => {
      const mp = manualProcess();
      queueMicrotask(() => mp.exit({ code: 0, signal: null }));
      return mp;
    })), createClient: noClient, uv: ['/uv'], packageSpec: 'sglang==0.5.21' });
    const p2 = await bad.installPlan();
    expect(p2.data).toEqual({ spec: 'sglang==0.5.21' });
    await expect(bad.install(p2, () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'ENGINE_INSTALL_FAILED', params: { stage: 'verify' } });
    const noUv = new SglangNativeAdapter({ deps: deps(root, scriptedProc(() => ok('0.5.21'), () => {
      const mp = manualProcess();
      queueMicrotask(() => mp.exit({ code: 0, signal: null }));
      return mp;
    })), createClient: noClient, uv: async () => undefined });
    await noUv.install(await noUv.installPlan(), () => {}, new AbortController().signal);
  });
});
