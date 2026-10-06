import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { launchParamsSchema } from '../../../../../src/contract/engines';
import type { ExitInfo, Platform, ProcessRunner } from '../../../../../src/core/deps';
import { HF_PLACEHOLDER } from '../../../../../src/core/engines/command-display';
import type { ModelTarget } from '../../../../../src/core/engines/types';
import { ownerExecutable, VllmNativeAdapter, type VllmNativeDeps } from '../../../../../src/core/engines/vllm-native/adapter';
import { installVllm, parseVllmVersion, UvProgress, venvPaths } from '../../../../../src/core/engines/vllm-native/install';
import { createInferenceClient } from '../../../../../src/core/inference/client';
import { systemClock } from '../../../../../src/core/node-deps';
import type { OwnedRecord } from '../../../../../src/core/process/ownership';
import { pickFreePort } from '../../../../../src/core/process/ports';
import { createProcessRunner } from '../../../../../src/core/process/runner';
import { FAKE_ENGINE, fail, manualProcess, ok, scriptedProc, silentLog, tempDir, VLLM_FIXTURES } from '../../docker/helpers';

const FAKE_VLLM = path.join(VLLM_FIXTURES, 'fake-vllm.mjs');
const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups) c();
});
const tmp = () => {
  const t = tempDir('gb-vnat-');
  cleanups.push(t.cleanup);
  return t.dir;
};

function deps(root: string, proc: ProcessRunner = scriptedProc(() => ok('0.31.0\n')), platform: Platform = 'linux'): VllmNativeDeps {
  return {
    clock: systemClock,
    proc,
    fetch,
    platform,
    log: silentLog,
    paths: { dataDir: root, cacheDir: root, enginesDir: path.join(root, 'engines'), resultsDir: root, modelsDir: root, resourcesDir: root, home: root },
  };
}
const noClient = () => ({}) as never;
const repoModel: ModelTarget = { identity: { displayName: 'Qwen3', format: 'safetensors', source: 'hf', repo: 'Qwen/Qwen3-0.6B', files: [], weakKey: 'q', sizeBytes: 7 } };

/** A fake managed venv: enginesDir/vllm-venv/bin/vllm. */
function managedVenv(root: string): string {
  const p = venvPaths(path.join(root, 'engines'));
  mkdirSync(path.dirname(p.vllm), { recursive: true });
  writeFileSync(p.vllm, '#!/usr/bin/env python3\n');
  return p.vllm;
}

describe('VllmNativeAdapter: detection', () => {
  it('is unsupported on Windows', async () => {
    const a = new VllmNativeAdapter({ deps: deps(tmp(), undefined, 'win32'), createClient: noClient });
    expect(await a.detect()).toEqual({ kind: 'vllm-native', available: false, installed: false, problems: [], supported: false });
    await expect(a.plan({ kind: 'vllm-native' }, repoModel, launchParamsSchema.parse({}), { port: 1, marker: 'gpubench-m' })).rejects.toMatchObject({
      code: 'ENGINE_NOT_INSTALLED',
      params: { reason: 'unsupported-os' },
    });
    await expect(a.installPlan()).rejects.toMatchObject({ code: 'ENGINE_INSTALL_FAILED', params: { reason: 'unsupported-os' } });
  });

  it('reports a missing install, then the managed venv with its version (cached)', async () => {
    const root = tmp();
    const proc = scriptedProc(() => ok('INFO noise\n0.31.0\n'));
    const a = new VllmNativeAdapter({ deps: deps(root, proc), createClient: noClient });
    expect(await a.detect()).toMatchObject({ installed: false, problems: ['ENGINE_NOT_INSTALLED'], supported: true });
    const exe = managedVenv(root);
    expect(await a.detect()).toEqual({ kind: 'vllm-native', available: true, installed: true, location: exe, version: '0.31.0', problems: [], supported: true });
    await a.detect();
    expect(proc.calls).toHaveLength(1);
    expect(await a.capabilities({ kind: 'vllm-native' })).toEqual({ version: '0.31.0', flags: new Set(), tokenIdsInPrompt: true, timings: false, minTokens: true, fitFlag: false });
  });

  it('accepts a vllm file or a venv folder in cfg.vllmPath', async () => {
    const root = tmp();
    const venv = path.join(root, 'myvenv');
    mkdirSync(path.join(venv, 'bin'), { recursive: true });
    writeFileSync(path.join(venv, 'bin', 'vllm'), '#!/x/python\n');
    const broken = scriptedProc(() => fail(1, 'ImportError: libcudart.so.13'));
    const a = new VllmNativeAdapter({ deps: deps(root, broken), createClient: noClient });
    expect(await a.detect({ kind: 'vllm-native', vllmPath: venv })).toMatchObject({
      available: false,
      installed: true,
      location: path.join(venv, 'bin', 'vllm'),
      problems: ['ENGINE_START_FAILED'],
    });
    expect((await a.detect({ kind: 'vllm-native', vllmPath: path.join(venv, 'bin', 'vllm') })).location).toBe(path.join(venv, 'bin', 'vllm'));
    expect(await a.capabilities({ kind: 'vllm-native', vllmPath: venv })).not.toHaveProperty('version');
    await expect(a.resolveExecutable({ kind: 'vllm-native', vllmPath: path.join(root, 'nope') })).rejects.toMatchObject({ code: 'ENGINE_NOT_INSTALLED' });
  });
});

describe('VllmNativeAdapter: plan', () => {
  it('builds `vllm serve <repo>` on loopback with the token as a placeholder', async () => {
    const root = tmp();
    const exe = managedVenv(root);
    const a = new VllmNativeAdapter({ deps: deps(root), createClient: noClient, hfToken: () => 'hf_real' });
    const plan = await a.plan(
      { kind: 'vllm-native' },
      { ...repoModel, identity: { ...repoModel.identity, revision: 'abc' } },
      launchParamsSchema.parse({ parallel: 2, env: { X: '1' } }),
      { port: 8123, marker: 'gpubench-m1' },
    );
    expect(plan.argv).toEqual([
      exe,
      'serve',
      'Qwen/Qwen3-0.6B',
      '--served-model-name',
      'gpubench-m1',
      '--host',
      '127.0.0.1',
      '--port',
      '8123',
      '--revision',
      'abc',
      '--max-model-len',
      '4096',
      '--gpu-memory-utilization',
      '0.9',
      '--max-num-seqs',
      '2',
      '--seed',
      '0',
    ]);
    expect(plan.env).toEqual({ X: '1', HF_TOKEN: HF_PLACEHOLDER });
    expect(plan.engine).toEqual({ kind: 'vllm-native', name: 'vLLM', executable: exe, version: '0.31.0' });
    expect(plan).toMatchObject({ host: '127.0.0.1', port: 8123, modelFiles: [], modelBytes: 7, modelRepo: 'Qwen/Qwen3-0.6B' });
  });

  it('serves a local safetensors folder directly', async () => {
    const root = tmp();
    managedVenv(root);
    const dir = path.join(root, 'm');
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'model.safetensors'), Buffer.alloc(10));
    const identity = { ...repoModel.identity, source: 'local' as const, sizeBytes: undefined };
    const local: ModelTarget = { identity, local: { id: 'l', identity, paths: [path.join(dir, 'model.safetensors'), path.join(dir, 'gone')], auxiliary: [], dir, origin: 'library', modifiedAt: '' } };
    const a = new VllmNativeAdapter({ deps: deps(root, scriptedProc(() => ok('no version'))), createClient: noClient, launcherPrefix: ['python3'] });
    const plan = await a.plan({ kind: 'vllm-native' }, local, launchParamsSchema.parse({}), { port: 1, marker: 'gpubench-m' });
    expect(plan.argv.slice(0, 4)).toEqual(['python3', venvPaths(path.join(root, 'engines')).vllm, 'serve', dir]);
    expect(plan.modelBytes).toBe(10);
    expect(plan.engine.version).toBeUndefined();
    expect(plan.modelRepo).toBeUndefined();
    expect(plan.env).toEqual({});
    const empty: ModelTarget = { identity: { ...identity }, local: { ...local.local!, paths: [] } };
    expect((await a.plan({ kind: 'vllm-native' }, empty, launchParamsSchema.parse({}), { port: 1, marker: 'gpubench-m' })).modelBytes).toBe(0);
  });
});

describe('VllmNativeAdapter: start (real processes, fake vLLM)', () => {
  const have = existsSync(FAKE_ENGINE);

  it.skipIf(!have)('starts, becomes ready on its served name, records ownership and stops', async () => {
    const root = tmp();
    const proc = createProcessRunner({ clock: systemClock, platform: process.platform, baseEnv: process.env });
    const records: OwnedRecord[] = [];
    const removed: number[] = [];
    const a = new VllmNativeAdapter({
      deps: { ...deps(root, proc), platform: 'linux' },
      createClient: (flavor, baseUrl, opts) => createInferenceClient(flavor, baseUrl, { fetch, clock: systemClock }, opts),
      launcherPrefix: [process.execPath],
      ownership: { add: async (r) => void records.push(r), remove: async (pid) => void removed.push(pid) },
      hfToken: () => 'hf_x',
      pollMs: 30,
      readyTimeoutMs: 30_000,
    });
    const port = await pickFreePort();
    const plan = await a.plan({ kind: 'vllm-native', vllmPath: FAKE_VLLM }, repoModel, launchParamsSchema.parse({ env: { FAKE_ENGINE_PROFILE: '{"loadMsWarm":100}' } }), {
      port,
      marker: 'gpubench-native-1',
    });
    expect(plan.engine.version).toBe('0.31.0');
    const inst = await a.start(plan, new AbortController().signal);
    const ready = await inst.waitReady();
    expect(ready.phases.map((p) => p.name)).toEqual(expect.arrayContaining(['engine_init', 'model_load']));
    expect(await inst.client.models()).toEqual(['gpubench-native-1']);
    expect(records[0]).toMatchObject({ exe: process.execPath, marker: 'gpubench-native-1', kind: 'process' });
    await inst.stop();
    expect(removed).toEqual([records[0]?.pid]);
  });

  it.skipIf(!have)('diagnoses a failed start from the vLLM log', async () => {
    const root = tmp();
    const proc = createProcessRunner({ clock: systemClock, platform: process.platform, baseEnv: process.env });
    const a = new VllmNativeAdapter({ deps: { ...deps(root, proc), platform: 'linux' }, createClient: noClient, launcherPrefix: [process.execPath], pollMs: 30 });
    const plan = await a.plan({ kind: 'vllm-native', vllmPath: FAKE_VLLM }, repoModel, launchParamsSchema.parse({ env: { FAKE_ENGINE_PROFILE: '{"oomAtLoad":true}' } }), {
      port: await pickFreePort(),
      marker: 'gpubench-native-2',
    });
    const inst = await a.start(plan, new AbortController().signal);
    await expect(inst.waitReady()).rejects.toMatchObject({ code: 'ENGINE_OOM' });
  });

  it('refuses a cancelled start and reports spawn failures', async () => {
    const root = tmp();
    managedVenv(root);
    const a = new VllmNativeAdapter({ deps: deps(root), createClient: noClient });
    const plan = await a.plan({ kind: 'vllm-native' }, repoModel, launchParamsSchema.parse({}), { port: 1, marker: 'gpubench-m' });
    const ac = new AbortController();
    ac.abort();
    await expect(a.start(plan, ac.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    const throwing = new VllmNativeAdapter({
      deps: deps(root, scriptedProc(() => ok(), () => {
        throw new Error('EACCES');
      })),
      createClient: noClient,
    });
    await expect(throwing.start(plan, new AbortController().signal)).rejects.toMatchObject({ code: 'ENGINE_START_FAILED' });
  });

  it('passes the real token only at spawn time and tolerates ownership failures', async () => {
    const root = tmp();
    managedVenv(root);
    const mp = manualProcess(0, 77);
    const proc = scriptedProc(() => ok('0.31.0'), () => mp);
    const warned: string[] = [];
    const a = new VllmNativeAdapter({
      deps: { ...deps(root, proc), log: { ...silentLog, warn: (m: string) => void warned.push(m) } },
      createClient: noClient,
      hfToken: () => 'hf_secret',
      ownership: { add: () => Promise.reject(new Error('disk full')), remove: async () => {} },
      pollMs: 5,
    });
    const plan = await a.plan({ kind: 'vllm-native' }, repoModel, launchParamsSchema.parse({}), { port: 1, marker: 'gpubench-m' });
    const inst = await a.start(plan, new AbortController().signal);
    expect(proc.spawns[0]?.env?.HF_TOKEN).toBe('hf_secret');
    expect(warned).toEqual(['ownership record failed']);
    mp.push('huggingface_hub.errors.GatedRepoError: 401 Client Error. Cannot access gated repo');
    mp.exit({ code: 1, signal: null } as ExitInfo);
    await expect(inst.waitReady()).rejects.toMatchObject({ code: 'HF_AUTH_REQUIRED', params: { repo: 'Qwen/Qwen3-0.6B' } });

    // Without a token (or without HF_TOKEN in the plan) nothing is added.
    const mp2 = manualProcess(0, -1);
    const proc2 = scriptedProc(() => ok('0.31.0'), () => mp2);
    const b = new VllmNativeAdapter({ deps: deps(root, proc2), createClient: noClient, hfToken: () => undefined, ownership: { add: async () => {}, remove: async () => {} } });
    await b.start({ ...plan, env: {} }, new AbortController().signal);
    expect(proc2.spawns[0]?.env).toEqual({});
    mp2.exit();
  });
});

describe('VllmNativeAdapter: install', () => {
  it('plans a uv install of unknown size and runs it into the managed venv', async () => {
    const root = tmp();
    const proc = scriptedProc(
      () => ok('0.31.0\n'),
      () => {
        const mp = manualProcess();
        setTimeout(() => mp.exit(), 1);
        return mp;
      },
    );
    const a = new VllmNativeAdapter({ deps: deps(root, proc), createClient: noClient, uv: ['/opt/gpubench/uv'], packageSpec: 'vllm==0.31.0' });
    const plan = await a.installPlan();
    expect(plan).toEqual({ kind: 'vllm-native', label: 'vLLM (vllm==0.31.0)', bytes: 0, items: [{ label: 'vllm==0.31.0 + PyTorch (CUDA)', bytes: 0 }], data: { spec: 'vllm==0.31.0' } });
    const stages: string[] = [];
    await a.install(plan, (p) => stages.push(p.stage), new AbortController().signal);
    expect(stages).toEqual(['venv', 'resolve', 'verify', 'done']);
    const v = venvPaths(path.join(root, 'engines'));
    expect(proc.spawns.map((s) => [s.cmd, ...s.args])).toEqual([
      ['/opt/gpubench/uv', 'venv', v.venv, '--python', '3.12', '--allow-existing'],
      ['/opt/gpubench/uv', 'pip', 'install', '--python', v.python, 'vllm==0.31.0', '--torch-backend', 'auto'],
    ]);
    // Default uv from PATH and default spec.
    const b = new VllmNativeAdapter({ deps: deps(root, proc), createClient: noClient });
    await b.install(await b.installPlan(), () => {}, new AbortController().signal);
    expect(proc.spawns[2]?.cmd).toBe('uv');
    expect(proc.spawns[3]?.args).toContain('vllm');
  });
});

describe('uv installer', () => {
  it('parses uv progress lines', () => {
    const p = new UvProgress();
    expect(p.push('Using CPython 3.12.11')).toBe(false);
    expect(p.push('Resolved 152 packages in 2.31s')).toBe(true);
    expect(p.push('Downloading torch (846.6MiB)')).toBe(true);
    expect(p.push('Downloading nvidia-cudnn-cu12 (1.1GiB)')).toBe(true);
    expect(p.push(' Downloading tiny (12B)')).toBe(true);
    expect(p.push(' Downloaded torch')).toBe(true);
    expect(p.push(' Downloaded unknown-pkg')).toBe(true);
    expect(p.stage).toBe('download');
    expect(p.bytesTotal).toBe(Math.round(846.6 * 1024 ** 2) + Math.round(1.1 * 1024 ** 3) + 12);
    expect(p.bytesDone).toBe(Math.round(846.6 * 1024 ** 2));
    expect(p.push('Downloading x (3KiB)')).toBe(true);
    expect(p.push('Prepared 152 packages in 1m 02s')).toBe(true);
    expect(p.stage).toBe('install');
    expect(p.push('Installed 152 packages in 1.20s')).toBe(true);
    expect(p.stage).toBe('verify');
  });

  it('parses vllm --version output', () => {
    expect(parseVllmVersion('INFO noise\n0.31.0\n')).toBe('0.31.0');
    expect(parseVllmVersion('v0.11.0+cu129')).toBe('0.11.0+cu129');
    expect(parseVllmVersion('nothing here')).toBeUndefined();
  });

  const runInstall = async (script: { venv: string[]; venvExit?: number; pip: string[]; pipExit?: number; verify?: ReturnType<typeof ok> }) => {
    const root = tmp();
    const mps: ReturnType<typeof manualProcess>[] = [];
    const proc = scriptedProc(
      () => script.verify ?? ok('0.31.0\n'),
      () => {
        const mp = manualProcess();
        mps.push(mp);
        const lines = mps.length === 1 ? script.venv : script.pip;
        const exit = mps.length === 1 ? (script.venvExit ?? 0) : (script.pipExit ?? 0);
        setTimeout(() => {
          for (const l of lines) mp.push(l);
          mp.exit({ code: exit, signal: null });
        }, 1);
        return mp;
      },
    );
    const progress: { stage: string; bytesDone: number; bytesTotal?: number }[] = [];
    const res = installVllm({ proc, enginesDir: root, uv: ['uv'] }, (p) => progress.push(p), new AbortController().signal);
    return { res, progress, proc, root };
  };

  it('creates the venv, installs with --torch-backend auto and verifies', async () => {
    const r = await runInstall({ venv: ['Using CPython 3.12.11', 'Creating virtual environment at: x'], pip: ['Resolved 2 packages in 1s', 'Downloading torch (1MiB)', ' Downloaded torch', 'Prepared 2 packages', 'Installed 2 packages in 1s'] });
    expect(await r.res).toEqual({ venv: venvPaths(r.root).venv, vllm: venvPaths(r.root).vllm, version: '0.31.0' });
    expect(r.proc.spawns[1]?.args).toEqual(['pip', 'install', '--python', venvPaths(r.root).python, 'vllm', '--torch-backend', 'auto']);
    expect(r.proc.calls[0]).toMatchObject({ cmd: venvPaths(r.root).vllm, args: ['--version'] });
    expect(r.progress.map((p) => p.stage)).toEqual(['venv', 'resolve', 'download', 'download', 'download', 'install', 'verify', 'verify', 'done']);
    expect(r.progress.at(-1)).toEqual({ stage: 'done', bytesDone: 1024 ** 2, bytesTotal: 1024 ** 2 });
  });

  it('maps failures: disk, network, missing uv, generic, verify', async () => {
    await expect((await runInstall({ venv: [], pip: ['error: No space left on device (os error 28)'], pipExit: 2 })).res).rejects.toMatchObject({ code: 'DISK_FULL', params: { stage: 'install' } });
    await expect((await runInstall({ venv: [], pip: ['error: Failed to fetch: https://pypi.org/simple/vllm/'], pipExit: 2 })).res).rejects.toMatchObject({ code: 'NETWORK' });
    await expect((await runInstall({ venv: ['Error: spawn uv ENOENT'], venvExit: -1, pip: [] })).res).rejects.toMatchObject({
      code: 'ENGINE_INSTALL_FAILED',
      params: { reason: 'uv-missing', stage: 'venv' },
    });
    const many = Array.from({ length: 60 }, (_, i) => `l${i}`);
    const generic = (await runInstall({ venv: [], pip: many, pipExit: 1 })).res;
    await expect(generic).rejects.toMatchObject({ code: 'ENGINE_INSTALL_FAILED' });
    expect(((await generic.catch((e: unknown) => e)) as { detail: string }).detail.split('\n')).toHaveLength(40);
    await expect((await runInstall({ venv: [], pip: [], verify: fail(1, 'ImportError') })).res).rejects.toMatchObject({ code: 'ENGINE_INSTALL_FAILED', params: { stage: 'verify' } });
    const noVersion = await (await runInstall({ venv: [], pip: [], verify: ok('weird') })).res;
    expect(noVersion).not.toHaveProperty('version');
  });

  it('can be cancelled before and during a step', async () => {
    const pre = new AbortController();
    pre.abort();
    await expect(installVllm({ proc: scriptedProc(() => ok()), enginesDir: tmp(), uv: ['uv'] }, () => {}, pre.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    const mp = manualProcess();
    const ac = new AbortController();
    const p = installVllm({ proc: scriptedProc(() => ok(), () => mp), enginesDir: tmp(), uv: ['uv'] }, () => {}, ac.signal);
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(mp.stopped()).toBe(1);
  });
});

describe('ownerExecutable', () => {
  it('resolves the interpreter named by the shebang, or keeps the script', async () => {
    const root = tmp();
    const py = path.join(root, 'python3.12');
    writeFileSync(py, '');
    const script = path.join(root, 'vllm');
    writeFileSync(script, `#!${py}\nimport sys\n`);
    expect(await ownerExecutable(script, false)).toBe(await (await import('node:fs/promises')).realpath(py));
    const envScript = path.join(root, 'vllm-env');
    writeFileSync(envScript, '#!/usr/bin/env python3\n');
    expect(await ownerExecutable(envScript, false)).toBe(await (await import('node:fs/promises')).realpath(envScript));
    const missingInterp = path.join(root, 'vllm-missing');
    writeFileSync(missingInterp, '#!/nonexistent/python\n');
    expect(await ownerExecutable(missingInterp, false)).toBe('/nonexistent/python');
    expect(await ownerExecutable(path.join(root, 'nope'), false)).toBe(path.join(root, 'nope'));
    expect(await ownerExecutable('node', true)).toBe('node');
    if (process.platform !== 'win32') {
      const link = path.join(root, 'link');
      symlinkSync(py, link);
      writeFileSync(script, `#!${link}\n`);
      expect(await ownerExecutable(script, false)).toBe(await (await import('node:fs/promises')).realpath(py));
    }
  });
});

describe('VllmNativeAdapter: local model diagnosis', () => {
  it('diagnoses without a repo when the model is a local folder', async () => {
    const root = tmp();
    managedVenv(root);
    const dir = path.join(root, 'local');
    mkdirSync(dir);
    const identity = { ...repoModel.identity, source: 'local' as const };
    const local: ModelTarget = { identity, local: { id: 'l', identity, paths: [], auxiliary: [], dir, origin: 'library', modifiedAt: '' } };
    const mp = manualProcess(0, 9);
    const a = new VllmNativeAdapter({ deps: deps(root, scriptedProc(() => ok('0.31.0'), () => mp)), createClient: noClient, pollMs: 5 });
    const plan = await a.plan({ kind: 'vllm-native' }, local, launchParamsSchema.parse({}), { port: 1, marker: 'gpubench-l' });
    const inst = await a.start(plan, new AbortController().signal);
    mp.push('huggingface_hub.errors.GatedRepoError: 401 Client Error. Cannot access gated repo');
    mp.exit({ code: 1, signal: null });
    const err = (await inst.waitReady().catch((e: unknown) => e)) as { code: string; params: Record<string, unknown> };
    expect(err.code).toBe('HF_AUTH_REQUIRED');
    expect(err.params).not.toHaveProperty('repo');
  });
});
