// TensorRT-LLM in a Python environment: on Linux (the fake engine run through node as "python"), and
// inside WSL on Windows (scripted wsl.exe answers, the fake engine serving in-process).
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { launchParamsSchema } from '../../../../../src/contract/engines';
import type { Platform, ProcessRunner, RunOutput, SpawnSpec } from '../../../../../src/core/deps';
import { HF_PLACEHOLDER } from '../../../../../src/core/engines/command-display';
import type { WslProcesses } from '../../../../../src/core/engines/ninfer/wsl';
import { parseWslProbe, TrtllmNativeAdapter, trtllmVenvPaths, versionProbe, WSL_PROBE, type TrtllmNativeDeps } from '../../../../../src/core/engines/trtllm-native/adapter';
import type { ModelTarget } from '../../../../../src/core/engines/types';
import { createInferenceClient } from '../../../../../src/core/inference/client';
import { systemClock } from '../../../../../src/core/node-deps';
import type { OwnedRecord } from '../../../../../src/core/process/ownership';
import { pickFreePort } from '../../../../../src/core/process/ports';
import { createProcessRunner } from '../../../../../src/core/process/runner';
import { startFakeEngine } from '../../../../fakes/fake-engine/server.mjs';
import { fail, FAKE_ENGINE, manualProcess, ok, scriptedProc, silentLog, tempDir } from '../../docker/helpers';

const cleanups: (() => void | Promise<void>)[] = [];
afterAll(async () => {
  for (const c of cleanups) await c();
});

const createClient = (flavor: Parameters<typeof createInferenceClient>[0], baseUrl: string, o?: { model?: string }) => createInferenceClient(flavor, baseUrl, { fetch, clock: systemClock }, o);
const params = (over: object = {}) => launchParamsSchema.parse({ contextSize: 4096, ...over });
const repoModel: ModelTarget = { identity: { displayName: 'Qwen3 8B', format: 'safetensors', source: 'hf', repo: 'nvidia/Qwen3-8B-FP8', revision: 'abc', files: [], weakKey: 'q' }, repo: 'nvidia/Qwen3-8B-FP8' };
const VERSION_OUT = '[TensorRT-LLM] TensorRT-LLM version: 1.4.0rc0\n1.4.0rc0\n';

function root(): string {
  const t = tempDir('gb-trtn-');
  cleanups.push(t.cleanup);
  return t.dir;
}

function deps(dir: string, proc: ProcessRunner, platform: Platform = 'linux'): TrtllmNativeDeps {
  return { clock: systemClock, proc, fetch, platform, log: silentLog, paths: { dataDir: dir, cacheDir: dir, enginesDir: dir, resultsDir: dir, modelsDir: dir, resourcesDir: dir, home: dir } };
}

/** LLM Bench's own environment whose python is the fake engine (a script that runs it). */
function managedVenv(dir: string): string {
  const py = trtllmVenvPaths(dir).python;
  mkdirSync(path.dirname(py), { recursive: true });
  writeFileSync(py, `import ${JSON.stringify(pathToFileURL(FAKE_ENGINE).href)};\n`);
  return py;
}

function local(dir: string): ModelTarget {
  const m = path.join(dir, 'Qwen3-8B');
  mkdirSync(m, { recursive: true });
  writeFileSync(path.join(m, 'model.safetensors'), Buffer.alloc(64));
  const identity = { ...repoModel.identity, source: 'local' as const };
  return { identity, local: { id: 'l', identity, paths: [path.join(m, 'model.safetensors')], auxiliary: [], dir: m, origin: 'library', modifiedAt: '' } };
}

describe('version check output', () => {
  it('says why an environment cannot run TensorRT-LLM', () => {
    expect(versionProbe(ok(VERSION_OUT), '/py')).toMatchObject({ ok: true, version: '1.4.0rc0', python: '/py' });
    expect(versionProbe(fail(1, "ModuleNotFoundError: No module named 'tensorrt_llm'"), '/py').error).toMatchObject({ code: 'ENGINE_NOT_INSTALLED', params: { reason: 'trtllm_missing' } });
    expect(versionProbe(fail(1, 'ImportError: libmpi.so.40: cannot open shared object file'), '/py', 'Ubuntu').error).toMatchObject({ code: 'ENGINE_MISSING_LIBRARY', params: { library: 'libmpi.so.40', package: 'libopenmpi-dev', distro: 'Ubuntu' } });
    expect(versionProbe(fail(1, 'ImportError: libcuda.so.1: cannot open shared object file'), '/py').error).not.toHaveProperty('params.distro');
    expect(versionProbe(fail(139, 'Segmentation fault'), '/py').error).toMatchObject({ code: 'ENGINE_START_FAILED' });
  });

  it('reads the WSL probe', () => {
    const where = { python: '~/v/bin/python', distro: 'Ubuntu', own: false };
    expect(parseWslProbe(ok('##gpubench-nopython /home/u/v/bin/python\n'), where).error).toMatchObject({ params: { reason: 'python_missing', path: '/home/u/v/bin/python' } });
    expect(parseWslProbe(ok(`##gpubench-python /home/u/v/bin/python\n${VERSION_OUT}##gpubench-rc 0\n`), where)).toMatchObject({ ok: true, python: '/home/u/v/bin/python', version: '1.4.0rc0' });
    expect(parseWslProbe({ ...fail(null, ''), timedOut: false }, where).error).toMatchObject({ params: { reason: 'wsl_missing' } });
    expect(parseWslProbe(fail(1, 'There is no distribution with the supplied name.'), where).error).toMatchObject({ params: { reason: 'distro_missing', distro: 'Ubuntu' } });
    expect(parseWslProbe(fail(1, 'WSL_E_DISTRO_NOT_FOUND'), { python: 'p', own: false }).error).toMatchObject({ params: { reason: 'distro_missing' } });
    expect(parseWslProbe(fail(1, 'garbage'), where).error).toMatchObject({ params: { reason: 'python_missing', path: '~/v/bin/python' } });
    expect(WSL_PROBE).toContain('##gpubench-rc');
  });
});

describe('TensorRT-LLM native on Linux', () => {
  const real = (_dir: string) => createProcessRunner({ clock: systemClock, platform: process.platform as Platform, baseEnv: process.env });

  it('is not offered on macOS', async () => {
    const a = new TrtllmNativeAdapter({ deps: deps(root(), scriptedProc(() => ok()), 'darwin'), createClient });
    expect(await a.detect()).toMatchObject({ supported: false });
    await expect(a.plan({ kind: 'trtllm-native' }, repoModel, params(), { port: 1, marker: 'gpubench-m' })).rejects.toMatchObject({ params: { reason: 'unsupported-os' } });
    await expect(a.installPlan({ kind: 'trtllm-native' })).rejects.toMatchObject({ code: 'ENGINE_INSTALL_FAILED' });
    // Windows without WSL support wired in: not offered either.
    expect(await new TrtllmNativeAdapter({ deps: deps(root(), scriptedProc(() => ok()), 'win32'), createClient }).detect()).toMatchObject({ supported: false });
  });

  it('detects the managed environment, a venv folder or a Python of the user’s own', async () => {
    const dir = root();
    const a = new TrtllmNativeAdapter({ deps: deps(dir, real(dir)), createClient, launcherPrefix: [process.execPath] });
    expect(await a.detect()).toMatchObject({ installed: false, available: false, problems: ['ENGINE_NOT_INSTALLED'], problemParams: { reason: 'python_missing' } });
    const py = managedVenv(dir);
    expect(await a.detect()).toMatchObject({ installed: false });
    expect(await a.probe(await a.where(), true)).toMatchObject({ ok: true, python: py, version: '1.4.0rc0' });
    expect(await a.detect()).toMatchObject({ installed: true, available: true, version: '1.4.0rc0', location: py });
    expect(await a.detect({ kind: 'trtllm-native', trtllmPath: trtllmVenvPaths(dir).venv })).toMatchObject({ available: true, location: py });
    expect(await a.detect({ kind: 'trtllm-native', trtllmPath: FAKE_ENGINE })).toMatchObject({ available: true, location: FAKE_ENGINE });
  });

  it('reads its help once; an environment without TensorRT-LLM has no capabilities', async () => {
    const dir = root();
    const a = new TrtllmNativeAdapter({ deps: deps(dir, real(dir)), createClient, launcherPrefix: [process.execPath] });
    const cfg = { kind: 'trtllm-native' as const, trtllmPath: FAKE_ENGINE };
    const caps = await a.capabilities(cfg);
    expect(caps).toMatchObject({ version: '1.4.0rc0', tokenIdsInPrompt: true, minTokens: true });
    expect(caps.choices?.['--kv_cache_dtype']).toEqual(['auto', 'fp8', 'nvfp4']);
    expect(await a.capabilities(cfg)).toEqual(caps);
    await expect(a.capabilities({ kind: 'trtllm-native' })).rejects.toMatchObject({ code: 'ENGINE_NOT_INSTALLED' });
  });

  it('plans the exact command, previews before the install, refuses a missing environment', async () => {
    const dir = root();
    const a = new TrtllmNativeAdapter({ deps: deps(dir, real(dir)), createClient, launcherPrefix: [process.execPath], hfToken: () => 'hf_x' });
    const preview = await a.plan({ kind: 'trtllm-native' }, repoModel, params(), { port: 9, marker: 'gpubench-m', preview: true });
    expect(preview).toMatchObject({ pending: ['engine'], engine: { name: 'TensorRT-LLM' } });
    expect(preview.engine).not.toHaveProperty('version');
    await expect(a.plan({ kind: 'trtllm-native' }, repoModel, params(), { port: 9, marker: 'gpubench-m' })).rejects.toMatchObject({ code: 'ENGINE_NOT_INSTALLED' });
    const plan = await a.plan({ kind: 'trtllm-native', trtllmPath: FAKE_ENGINE }, repoModel, params({ dtype: 'bfloat16' }), { port: 9, marker: 'gpubench-m', apiName: 'Qwen3-8B' });
    expect(plan.argv.slice(0, 8)).toEqual([process.execPath, FAKE_ENGINE, '-X', 'gpubench=gpubench-m', '-m', 'tensorrt_llm.commands.serve', 'serve', 'nvidia/Qwen3-8B-FP8']);
    expect(plan.argv).toEqual(expect.arrayContaining(['--host', '127.0.0.1', '--port', '9', '--served_model_name', 'Qwen3-8B', '--hf_revision', 'abc']));
    expect(plan).toMatchObject({ env: { HF_TOKEN: HF_PLACEHOLDER }, modelRepo: 'nvidia/Qwen3-8B-FP8', engine: { version: '1.4.0rc0', executable: FAKE_ENGINE }, unsupported: [{ setting: 'dtype' }] });
    const l = local(dir);
    const lp = await a.plan({ kind: 'trtllm-native', trtllmPath: FAKE_ENGINE }, l, params(), { port: 9, marker: 'gpubench-m' });
    expect(lp.argv).not.toContain('-X');
    expect(lp.argv[lp.argv.indexOf('serve') + 1]).toBe(l.local?.dir);
    expect(lp).toMatchObject({ modelFiles: l.local?.paths, modelBytes: 64 });
    expect(lp).not.toHaveProperty('modelRepo');
    expect(await a.evict(lp)).toBeUndefined();
    const sized = await a.plan({ kind: 'trtllm-native', trtllmPath: FAKE_ENGINE }, { ...repoModel, identity: { ...repoModel.identity, sizeBytes: 5 } }, params(), { port: 9, marker: 'gpubench-m' });
    expect(sized.modelBytes).toBe(5);
    expect((await a.plan({ kind: 'trtllm-native', trtllmPath: FAKE_ENGINE }, repoModel, params(), { port: 9, marker: 'gpubench-m' })).modelBytes).toBe(0);
  });

  it('starts, serves and stops the fake trtllm-serve, recorded as our process', async () => {
    const dir = root();
    const records: OwnedRecord[] = [];
    const removed: number[] = [];
    const ownership = { add: async (r: OwnedRecord) => void records.push(r), remove: async (pid: number) => void removed.push(pid) };
    const a = new TrtllmNativeAdapter({ deps: deps(dir, real(dir)), createClient, ownership, launcherPrefix: [process.execPath], hfToken: () => 'hf_x', pollMs: 30, readyTimeoutMs: 30_000 });
    const plan = await a.plan({ kind: 'trtllm-native', trtllmPath: FAKE_ENGINE }, repoModel, params({ env: { FAKE_ENGINE_PROFILE: '{"loadMsWarm":100}' } }), { port: await pickFreePort(), marker: 'gpubench-tn1' });
    const inst = await a.start(plan, new AbortController().signal);
    expect(inst.pid).toBeGreaterThan(0);
    const ready = await inst.waitReady();
    expect(ready.phases.map((p) => p.name)).toContain('kv_cache');
    expect(await inst.client.models()).toEqual(['gpubench-tn1']);
    await inst.stop();
    await inst.exited;
    expect(records[0]).toMatchObject({ marker: 'gpubench-tn1', exe: process.execPath, kind: 'process' });
    await expect.poll(() => removed.length).toBe(1);
  });

  it('diagnoses a failed start; refuses a cancelled one and a program that cannot start', async () => {
    const dir = root();
    const ownership = { add: () => Promise.reject(new Error('disk')), remove: async () => undefined };
    const a = new TrtllmNativeAdapter({ deps: deps(dir, real(dir)), createClient, ownership, launcherPrefix: [process.execPath], pollMs: 30 });
    const plan = await a.plan({ kind: 'trtllm-native', trtllmPath: FAKE_ENGINE }, repoModel, params({ env: { FAKE_ENGINE_PROFILE: '{"loadMsWarm":50,"oomAtLoad":true}' } }), { port: await pickFreePort(), marker: 'gpubench-tn2' });
    const inst = await a.start(plan, new AbortController().signal);
    await expect(inst.waitReady()).rejects.toMatchObject({ code: 'ENGINE_OOM' });
    const lp = await a.plan({ kind: 'trtllm-native', trtllmPath: FAKE_ENGINE }, local(dir), params({ extraArgs: ['--nope'] }), { port: await pickFreePort(), marker: 'gpubench-tn3' });
    const inst2 = await a.start(lp, new AbortController().signal);
    await expect(inst2.waitReady()).rejects.toMatchObject({ code: 'ENGINE_BAD_FLAG', params: { flag: '--nope' } });
    const ac = new AbortController();
    ac.abort();
    await expect(a.start(plan, ac.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    const broken = new TrtllmNativeAdapter({ deps: deps(dir, scriptedProc(() => ok(), () => { throw new Error('EACCES'); })), createClient });
    await expect(broken.start(plan, new AbortController().signal)).rejects.toMatchObject({ code: 'ENGINE_START_FAILED' });
    // Without ownership records: nothing recorded, the instance still works.
    const plain = new TrtllmNativeAdapter({ deps: deps(dir, scriptedProc(() => ok(), () => manualProcess(0, 0))), createClient });
    const i3 = await plain.start(plan, new AbortController().signal);
    expect(i3.baseUrl).toContain('127.0.0.1');
    await i3.stop();
  });

  it('keeps a probe for a while, asks again when told to, and survives a runner that throws', async () => {
    let now = 0;
    let calls = 0;
    const proc = scriptedProc(() => {
      calls++;
      return ok(VERSION_OUT);
    });
    const dir = root();
    managedVenv(dir);
    const a = new TrtllmNativeAdapter({ deps: { ...deps(dir, proc), clock: { ...systemClock, now: () => now } }, createClient });
    await a.detect();
    await a.detect();
    expect(calls).toBe(1);
    now += 10 * 60_000;
    await a.detect();
    expect(calls).toBe(2);
    // Its own environment, no launcher: the command starts with its Python.
    expect((await a.plan({ kind: 'trtllm-native' }, repoModel, params(), { port: 1, marker: 'gpubench-m' })).argv[0]).toBe(trtllmVenvPaths(dir).python);
    const bad = new TrtllmNativeAdapter({ deps: deps(dir, scriptedProc(() => Promise.reject(new Error('boom')))), createClient });
    expect(await bad.detect()).toMatchObject({ installed: true, available: false, problems: ['ENGINE_START_FAILED'] });
  });

  it('installs with uv into its own environment, and checks the result', async () => {
    const dir = root();
    const py = trtllmVenvPaths(dir).python;
    const uvDone = (spec: SpawnSpec) => {
      const mp = manualProcess();
      setTimeout(() => {
        if (spec.args.includes('install')) {
          mp.push('Resolved 120 packages in 2s');
          mp.push('Downloading torch (1.0 MiB)');
        }
        mp.exit();
      }, 5);
      return mp;
    };
    const progress: string[] = [];
    const install = async (out: RunOutput, uv?: TrtllmNativeAdapter extends never ? never : string[] | (() => Promise<string[] | undefined>)) => {
      const proc = scriptedProc(() => out, uvDone);
      const a = new TrtllmNativeAdapter({ deps: deps(dir, proc), createClient, ...(uv ? { uv } : {}) });
      const plan = await a.installPlan({ kind: 'trtllm-native' });
      expect(plan).toMatchObject({ kind: 'trtllm-native', bytes: 0, data: { spec: 'tensorrt-llm' } });
      await a.install(plan, (p) => progress.push(p.stage), new AbortController().signal);
      return proc;
    };
    const proc = await install(ok(VERSION_OUT));
    expect(proc.spawns.map((s) => [s.cmd, ...s.args])).toEqual([
      ['uv', 'venv', trtllmVenvPaths(dir).venv, '--python', '3.12', '--allow-existing'],
      ['uv', 'pip', 'install', '--python', py, 'tensorrt-llm', '--torch-backend', 'auto'],
    ]);
    expect(proc.calls.at(-1)).toMatchObject({ cmd: py, args: ['-c', 'import tensorrt_llm; print(tensorrt_llm.__version__)'] });
    expect(progress.at(-1)).toBe('done');
    expect((await install(ok(VERSION_OUT), async () => ['/x/uv'])).spawns[0]?.cmd).toBe('/x/uv');
    expect((await install(ok(VERSION_OUT), async () => undefined)).spawns[0]?.cmd).toBe('uv');
    expect((await install(ok(VERSION_OUT), ['/y/uv'])).spawns[0]?.cmd).toBe('/y/uv');
    await expect(install(fail(1, 'ImportError: libmpi.so.40: cannot open shared object file'))).rejects.toMatchObject({ code: 'ENGINE_MISSING_LIBRARY', params: { package: 'libopenmpi-dev' } });
    await expect(install(fail(1, 'Segmentation fault'))).rejects.toMatchObject({ code: 'ENGINE_INSTALL_FAILED', params: { stage: 'verify' } });
  });

  it('removes its own environment only', async () => {
    const dir = root();
    managedVenv(dir);
    const a = new TrtllmNativeAdapter({ deps: deps(dir, scriptedProc(() => ok(VERSION_OUT))), createClient });
    await a.remove({ kind: 'trtllm-native' });
    expect(existsSync(trtllmVenvPaths(dir).venv)).toBe(false);
    await expect(a.remove({ kind: 'trtllm-native', trtllmPath: '/opt/py' })).rejects.toMatchObject({ code: 'VALIDATION', params: { reason: 'own-environment' } });
  });
});

/** wsl.exe answers: the distro list, the probe, $HOME, rm, the help, and anything else ok. */
function wslProc(o: { distros?: string; probe?: RunOutput; home?: string; rm?: RunOutput; spawn?: (spec: SpawnSpec) => ReturnType<typeof manualProcess> } = {}) {
  return scriptedProc(
    (args) => {
      if (args.includes('-l')) return ok(o.distros ?? '  NAME      STATE    VERSION\n* Ubuntu    Running  2\n  Debian    Stopped  2\n');
      const script = args[args.indexOf('-c') + 1] ?? '';
      if (script.includes('##gpubench-python')) return o.probe ?? ok(`##gpubench-python /home/u/.llm-bench/trtllm-venv/bin/python\n${VERSION_OUT}##gpubench-rc 0\n`);
      if (script.includes('echo "$HOME"')) return ok(o.home ?? '/home/u\n');
      if (script.includes('rm -rf')) return o.rm ?? ok();
      if (args.includes('--help')) return ok(HELP_TEXT);
      if (args.some((a) => a.includes('import tensorrt_llm'))) return ok(VERSION_OUT);
      return ok();
    },
    o.spawn ?? (() => manualProcess()),
  );
}
const HELP_TEXT = '  --host TEXT  h\n  --port INTEGER  p\n  --served_model_name TEXT  s\n  --max_seq_len INTEGER  m\n  --kv_cache_dtype [auto|fp8]  k\n';

function wslProcesses() {
  const added: unknown[] = [];
  const stopped: unknown[] = [];
  const removed: unknown[] = [];
  const processes = {
    add: async (r: unknown) => void added.push(r),
    stop: async (r: unknown) => {
      stopped.push(r);
      return true;
    },
    remove: async (d: string, pid: number) => void removed.push([d, pid]),
  } as unknown as WslProcesses;
  return { processes, added, stopped, removed };
}

describe('TensorRT-LLM native inside WSL', () => {
  const wslAdapter = (proc: ReturnType<typeof wslProc>, extra: Partial<ConstructorParameters<typeof TrtllmNativeAdapter>[0]> = {}) => {
    const p = wslProcesses();
    const linuxUv = async () => 'C:\\data\\engines\\wsl\\uv\\0.12.23\\uv';
    const a = new TrtllmNativeAdapter({ deps: deps(root(), proc, 'win32'), createClient, wsl: { argv: ['wsl.exe'], processes: p.processes, linuxUv }, pollMs: 30, readyTimeoutMs: 20_000, ...extra });
    return { a, ...p };
  };

  it('finds the default distro and its environment', async () => {
    const { a } = wslAdapter(wslProc());
    expect(await a.where()).toEqual({ python: '~/.llm-bench/trtllm-venv/bin/python', distro: 'Ubuntu', own: false });
    expect(await a.detect()).toMatchObject({ available: true, variant: 'Ubuntu', location: '/home/u/.llm-bench/trtllm-venv/bin/python', version: '1.4.0rc0' });
    expect(await a.where({ kind: 'trtllm-native', wslDistro: 'Debian', trtllmPath: '/opt/trt/bin/python' })).toEqual({ python: '/opt/trt/bin/python', distro: 'Debian', own: true });
    // No default marked: the first distro; none at all, or no WSL: said.
    expect((await wslAdapter(wslProc({ distros: '  NAME  STATE  VERSION\n  Arch  Stopped  2\n' })).a.where()).distro).toBe('Arch');
    expect(await wslAdapter(wslProc({ distros: '' })).a.detect()).toMatchObject({ problems: ['ENGINE_NOT_INSTALLED'], problemParams: { reason: 'distro_missing' } });
    const noWsl = wslAdapter(scriptedProc(() => Promise.reject(new Error('ENOENT'))));
    expect(await noWsl.a.detect()).toMatchObject({ problemParams: { reason: 'distro_missing' } });
    expect(await wslAdapter(wslProc({ probe: ok('##gpubench-nopython /x\n') })).a.detect()).toMatchObject({ installed: false, problemParams: { reason: 'python_missing' } });
    expect(await wslAdapter(wslProc({ probe: ok(`##gpubench-python /p\nImportError: libmpi.so.40: cannot open shared object file\n##gpubench-rc 1\n`) })).a.detect()).toMatchObject({ installed: true, problems: ['ENGINE_MISSING_LIBRARY'], problemParams: { distro: 'Ubuntu' } });
  });

  it('reads the help in the distro', async () => {
    const proc = wslProc();
    const { a } = wslAdapter(proc);
    const caps = await a.capabilities({ kind: 'trtllm-native' });
    expect(caps.choices?.['--kv_cache_dtype']).toEqual(['auto', 'fp8']);
    const help = proc.calls.find((c) => c.args.includes('--help'));
    expect(help?.args.slice(0, 6)).toEqual(['-d', 'Ubuntu', '--exec', '/bin/sh', '-c', expect.stringContaining('exec "$py"')]);
  });

  it('plans through wsl.exe: Windows files through /mnt, the token through WSLENV', async () => {
    const { a } = wslAdapter(wslProc(), { hfToken: () => 'hf_secret' });
    const dir = root();
    const l = local(dir);
    const plan = await a.plan({ kind: 'trtllm-native' }, l, params(), { port: 8123, marker: 'gpubench-w1' });
    expect(plan.argv.slice(0, 7)).toEqual(['wsl.exe', '-d', 'Ubuntu', '--exec', '/usr/bin/env', 'GPUBENCH_OWNER=gpubench-w1', '/bin/sh']);
    expect(plan.argv).toEqual(expect.arrayContaining(['/home/u/.llm-bench/trtllm-venv/bin/python', '-m', 'tensorrt_llm.commands.serve', 'serve']));
    const mapped = plan.argv[plan.argv.indexOf('serve') + 1] as string;
    expect(mapped).toMatch(/^\/mnt\/[a-z]\//);
    expect(plan.argv.join(' ')).not.toContain('hf_secret');
    expect(plan).toMatchObject({ env: { HF_TOKEN: HF_PLACEHOLDER, WSLENV: 'HF_TOKEN/u' }, slowSharedFilesystem: true, trtllm: { distro: 'Ubuntu' }, engine: { variant: 'Ubuntu' } });
    expect(plan.modelFiles[0]).toMatch(/^\/mnt\/[a-z]\/.*model\.safetensors$/);
    const noEnv = await wslAdapter(wslProc()).a.plan({ kind: 'trtllm-native' }, repoModel, params(), { port: 1, marker: 'gpubench-w2' });
    expect(noEnv.env).toEqual({});
    const other = { ...l, local: { ...(l.local as NonNullable<ModelTarget['local']>), dir: '\\\\wsl.localhost\\Debian\\m', paths: ['\\\\wsl.localhost\\Debian\\m\\model.safetensors'] } };
    await expect(a.plan({ kind: 'trtllm-native' }, other, params(), { port: 1, marker: 'gpubench-w3' })).rejects.toMatchObject({ code: 'VALIDATION', params: { reason: 'trtllm_wsl_path' } });
    const own = { ...l, local: { ...(l.local as NonNullable<ModelTarget['local']>), dir: '\\\\wsl.localhost\\Ubuntu\\home\\u\\m', paths: ['\\\\wsl.localhost\\Ubuntu\\home\\u\\m\\model.safetensors', 'Z:\\\\', '\\\\\\\\nas\\\\share\\\\x'] } };
    const fast = await a.plan({ kind: 'trtllm-native' }, own, params(), { port: 1, marker: 'gpubench-w4' });
    expect(fast).not.toHaveProperty('slowSharedFilesystem');
    expect(fast.modelFiles).toEqual(['/home/u/m/model.safetensors', '/mnt/z']);
  });

  it('starts in the distro: its Linux PID recorded, stopped by marker, the record dropped at exit', async () => {
    const port = await pickFreePort();
    const engine = await startFakeEngine({ flavor: 'trtllm', host: '127.0.0.1', port, aliases: ['gpubench-w5'], profile: { loadMsWarm: 50 } });
    cleanups.push(() => engine.close());
    const mp = manualProcess(0, 999);
    const proc = wslProc({ spawn: () => mp });
    const w = wslAdapter(proc);
    const plan = await w.a.plan({ kind: 'trtllm-native' }, repoModel, params(), { port, marker: 'gpubench-w5' });
    const inst = await w.a.start(plan, new AbortController().signal);
    expect(inst).not.toHaveProperty('pid');
    mp.push('gpubench-pid 4321');
    mp.push('gpubench-pid 1');
    mp.push('[TensorRT-LLM] TensorRT-LLM version: 1.4.0rc0');
    await engine.loaded;
    await inst.waitReady();
    expect(inst.logTail()).toEqual(['gpubench-pid 1', '[TensorRT-LLM] TensorRT-LLM version: 1.4.0rc0']);
    expect(w.added).toEqual([expect.objectContaining({ distro: 'Ubuntu', pid: 4321, marker: 'gpubench-w5' })]);
    await inst.stop();
    expect(w.stopped).toEqual([{ distro: 'Ubuntu', pid: 4321, marker: 'gpubench-w5' }]);
    await expect.poll(() => w.removed).toEqual([['Ubuntu', 4321]]);
  });

  it('copes with a relay that never names its PID, and with record failures', async () => {
    const mp = manualProcess(0, 7);
    const p = wslProcesses();
    const failing = { ...p.processes, add: () => Promise.reject(new Error('disk')), stop: () => Promise.reject(new Error('gone')) } as unknown as WslProcesses;
    const a = new TrtllmNativeAdapter({ deps: deps(root(), wslProc({ spawn: () => mp }), 'win32'), createClient, wsl: { argv: ['wsl.exe'], processes: failing, linuxUv: async () => 'C:\\uv' }, pollMs: 30 });
    const plan = await a.plan({ kind: 'trtllm-native' }, repoModel, params(), { port: 1, marker: 'gpubench-w6' });
    const inst = await a.start(plan, new AbortController().signal);
    // It ends before answering: diagnosed with the distro and the repository.
    mp.push('ImportError: libmpi.so.40: cannot open shared object file');
    mp.exit({ code: 1, signal: null });
    await expect(inst.waitReady()).rejects.toMatchObject({ code: 'ENGINE_MISSING_LIBRARY', params: { distro: 'Ubuntu' } });
    await inst.stop();
    const mp2 = manualProcess(0, 8);
    const b = new TrtllmNativeAdapter({ deps: deps(root(), wslProc({ spawn: () => mp2 }), 'win32'), createClient, wsl: { argv: ['wsl.exe'], processes: failing, linuxUv: async () => 'C:\\uv' }, pollMs: 30 });
    const inst2 = await b.start(plan, new AbortController().signal);
    mp2.push('gpubench-pid 55');
    await new Promise((r) => setTimeout(r, 20));
    await inst2.stop();
  });

  it('evicts the model from the distro’s page cache', async () => {
    const proc = wslProc();
    const { a } = wslAdapter(proc);
    const plan = await a.plan({ kind: 'trtllm-native' }, local(root()), params(), { port: 1, marker: 'gpubench-w7' });
    expect(await a.evict(plan)).toHaveProperty('guaranteed');
    expect(await a.evict({ ...plan, trtllm: {} } as typeof plan)).toBeUndefined();
    const broken = wslAdapter(scriptedProc((args) => (args.includes('-l') ? ok('* Ubuntu Running 2\n') : Promise.reject(new Error('x'))), () => manualProcess()));
    expect(await broken.a.evict(plan)).toMatchObject({ guaranteed: false });
  });

  it('installs with a Linux uv into ~/.llm-bench in the distro', async () => {
    const spawned: SpawnSpec[] = [];
    const proc = wslProc({
      spawn: (spec) => {
        spawned.push(spec);
        const mp = manualProcess();
        setTimeout(() => mp.exit(), 5);
        return mp;
      },
    });
    const { a } = wslAdapter(proc);
    const plan = await a.installPlan({ kind: 'trtllm-native' });
    expect(plan.data).toEqual({ spec: 'tensorrt-llm', distro: 'Ubuntu' });
    await a.install(plan, () => undefined, new AbortController().signal);
    expect(spawned.map((s) => [s.cmd, ...s.args.slice(0, 5)])).toEqual([
      ['wsl.exe', '-d', 'Ubuntu', '--exec', '/mnt/c/data/engines/wsl/uv/0.12.23/uv', 'venv'],
      ['wsl.exe', '-d', 'Ubuntu', '--exec', '/mnt/c/data/engines/wsl/uv/0.12.23/uv', 'pip'],
    ]);
    expect(spawned[0]?.args).toContain('/home/u/.llm-bench/trtllm-venv');
    const noHome = wslAdapter(wslProc({ home: '\n' }));
    await expect(noHome.a.install(plan, () => undefined, new AbortController().signal)).rejects.toMatchObject({ params: { reason: 'distro_missing', distro: 'Ubuntu' } });
  });

  it('removes its own environment in the distro', async () => {
    await wslAdapter(wslProc()).a.remove({ kind: 'trtllm-native' });
    await expect(wslAdapter(wslProc({ rm: fail(1, 'Permission denied') })).a.remove({ kind: 'trtllm-native' })).rejects.toMatchObject({ code: 'INTERNAL' });
  });
});
