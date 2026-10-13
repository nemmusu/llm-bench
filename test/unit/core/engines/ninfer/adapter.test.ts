/**
 * The NInfer adapter: where its build is, the probe (help + commit), the GPU check, plans (native and
 * WSL, previews), cold-load eviction in the distro, and a native start of the fake ninfer-serve.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AppError } from '../../../../../src/contract/errors';
import { launchParamsSchema } from '../../../../../src/contract/engines';
import { artifactOf, NinferAdapter, ninferArtifactInfo, parseProbe, phaseOf, serveOf, type NinferAdapterOptions, type NinferLaunchPlan } from '../../../../../src/core/engines/ninfer/adapter';
import { WslProcesses } from '../../../../../src/core/engines/ninfer/wsl';
import type { RunOutput } from '../../../../../src/core/deps';
import { systemClock } from '../../../../../src/core/node-deps';
import { pickFreePort } from '../../../../../src/core/process/ports';
import { fail, manualProcess, ok, recordingLog, scriptedProc, silentLog, steppingClock, tempDir } from '../../docker/helpers';
import { FAKE_NINFER, NINFER_FIXTURES, ninferModel, realClients, realProc } from './helpers';

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups) c();
});
const tmp = () => {
  const t = tempDir('gb-ninfer-adapter-');
  cleanups.push(t.cleanup);
  return t.dir;
};

const HELP = readFileSync(path.join(NINFER_FIXTURES, 'help.stdout.txt'), 'utf8');
const COMMIT = 'e31bc99b13f517c8aae70b997b7c4a49b4dcdc5d';
const probeOut = (o: { help?: string; code?: number; commit?: string } = {}): RunOutput => ok(`${o.help ?? HELP}##gpubench-help ${o.code ?? 0}\n##gpubench-commit ${o.commit ?? COMMIT}\n`);
const RTX_5090 = [{ name: 'NVIDIA GeForce RTX 5090', computeCapability: '12.0', memTotalMiB: 32_607 }];
const P = (over: object = {}) => launchParamsSchema.parse(over);

function native(o: Partial<NinferAdapterOptions> & { run?: (args: string[], cmd: string) => RunOutput | Promise<RunOutput>; path?: string } = {}) {
  const proc = scriptedProc(o.run ?? (() => probeOut()));
  const adapter = new NinferAdapter({
    kind: 'ninfer-native',
    deps: { clock: systemClock, proc, fetch: globalThis.fetch, platform: 'linux', log: silentLog },
    createClient: realClients,
    saved: async () => (o.path === undefined ? { native: { path: '/home/u/ninfer' } } : o.path ? { native: { path: o.path } } : {}),
    gpus: async () => RTX_5090,
    ...o,
  });
  return { adapter, proc };
}

describe('where NInfer is', () => {
  it('finds ninfer-serve from a checkout, its build folder, or the program itself', () => {
    expect(serveOf('/home/u/ninfer/')).toEqual({ serve: '/home/u/ninfer/build/apps/ninfer-serve', repo: '/home/u/ninfer' });
    expect(serveOf('/home/u/ninfer/build')).toEqual({ serve: '/home/u/ninfer/build/apps/ninfer-serve', repo: '/home/u/ninfer' });
    expect(serveOf('/home/u/ninfer/build/apps/ninfer-serve')).toEqual({ serve: '/home/u/ninfer/build/apps/ninfer-serve', repo: '/home/u/ninfer' });
    expect(serveOf('/opt/bin/ninfer-serve')).toEqual({ serve: '/opt/bin/ninfer-serve' });
  });

  it('reads the probe: our build, someone else\'s program, a missing distro or WSL', () => {
    const where = { serve: '/s', distro: 'Ubuntu' };
    expect(parseProbe(probeOut(), where)).toMatchObject({ ok: true, commit: COMMIT });
    expect(parseProbe(probeOut().stdout ? ok(`${HELP}##gpubench-help 0\n`) : ok(), where)).not.toHaveProperty('commit');
    expect(parseProbe(probeOut({ help: 'usage: other [--port N]\n' }), where)).toMatchObject({ ok: false, error: { params: { reason: 'ninfer_not_found', path: '/s' } } });
    expect(parseProbe(probeOut({ code: 127 }), where).ok).toBe(false);
    expect(parseProbe({ code: null, stdout: '', stderr: '', timedOut: true }, where).error?.params).toMatchObject({ reason: 'wsl_missing' });
    expect(parseProbe(fail(1, 'There is no distribution with the supplied name.'), where).error?.params).toMatchObject({ reason: 'distro_missing', distro: 'Ubuntu' });
    expect(parseProbe(fail(1, 'There is no distribution with the supplied name.'), { serve: '/s' }).error?.params).not.toHaveProperty('distro');
    expect(parseProbe(fail(127, 'sh: /s: not found'), where).error?.params).toMatchObject({ reason: 'ninfer_not_found' });
  });

  it('names the timeline phases', () => {
    expect(['weights ready | 20 GiB', 'CUDA graphs ready | 2s', 'engine ready | m', 'listening on http://x', 'starting engine'].map((m) => phaseOf(`2026-09-28 12:00:00.000  INFO  ${m}`))).toEqual([
      'weights',
      'cuda-graphs',
      'engine-ready',
      'listening',
      undefined,
    ]);
  });
});

describe('detect', () => {
  it('treats settings that cannot be read as not set up', async () => {
    expect(await native({ saved: () => Promise.reject(new Error('settings.json')) }).adapter.detect()).toMatchObject({ problemParams: { reason: 'not_configured' } });
  });

  it('is unsupported on another system, to be set up without a path, and ready with a working build', async () => {
    expect(await native({ deps: { clock: systemClock, proc: scriptedProc(() => ok()), fetch: globalThis.fetch, platform: 'win32', log: silentLog } }).adapter.detect()).toEqual({
      kind: 'ninfer-native',
      available: false,
      installed: false,
      problems: [],
      supported: false,
    });
    expect(await native({ path: '' }).adapter.detect()).toMatchObject({ problems: ['ENGINE_NOT_INSTALLED'], problemParams: { reason: 'not_configured' } });
    const { adapter, proc } = native();
    expect(await adapter.detect()).toEqual({ kind: 'ninfer-native', available: true, installed: true, location: '/home/u/ninfer/build/apps/ninfer-serve', version: COMMIT.slice(0, 12), problems: [], supported: true });
    expect(proc.calls[0]).toMatchObject({ cmd: '/bin/sh', args: ['-c', expect.stringContaining('--help'), 'sh', '/home/u/ninfer/build/apps/ninfer-serve', '/home/u/ninfer'] });
    // Cached; "Ricontrolla" asks again; a config's own path wins over the saved one.
    await adapter.detect();
    expect(proc.calls).toHaveLength(1);
    await adapter.check({ kind: 'ninfer-native' });
    expect(proc.calls).toHaveLength(2);
    expect(await adapter.check({ kind: 'ninfer-native', ninferPath: '/opt/bin/ninfer-serve' })).toMatchObject({ location: '/opt/bin/ninfer-serve' });
    expect(proc.calls[2]?.args.at(-1)).toBe('');
  });

  it('says NInfer needs an RTX 5090, set up or not', async () => {
    const other = [{ name: 'NVIDIA GeForce RTX 4090', computeCapability: '8.9', memTotalMiB: 24_564 }];
    const gpuProblem = { problems: ['ENGINE_GPU_UNSUPPORTED'], problemParams: { engine: 'NInfer', gpu: 'RTX 5090' } };
    expect(await native({ path: '', gpus: async () => other }).adapter.detect()).toMatchObject({ available: false, installed: false, ...gpuProblem });
    expect(await native({ gpus: async () => other }).adapter.detect()).toMatchObject({ available: false, installed: true, ...gpuProblem });
    // GPUs that cannot be read never block.
    expect(await native({ gpus: async () => [] }).adapter.detect()).toMatchObject({ available: true });
    expect(await native({ gpus: () => Promise.reject(new Error('nvml')) }).adapter.detect()).toMatchObject({ available: true });
  });

  it('reports a build that does not answer, and turns an unexpected failure into a status', async () => {
    expect(await native({ run: () => Promise.reject(new Error('spawn /bin/sh ENOENT')) }).adapter.detect()).toMatchObject({
      available: false,
      problems: ['ENGINE_NOT_INSTALLED'],
      problemParams: { reason: 'ninfer_not_found', path: '/home/u/ninfer/build/apps/ninfer-serve', detail: expect.stringContaining('ENOENT') },
    });
    const broken = native({
      gpus: () => {
        throw new AppError('INTERNAL', 'telemetry is gone', { params: { reason: 'x' } });
      },
    });
    expect(await broken.adapter.check({ kind: 'ninfer-native' })).toEqual({ kind: 'ninfer-native', available: false, installed: false, problems: ['INTERNAL'], problemParams: { reason: 'x' }, supported: true });
    const bare = native({
      gpus: () => {
        throw new Error('boom');
      },
    });
    expect((await bare.adapter.check({ kind: 'ninfer-native' })).problemParams).toBeUndefined();
  });

  it('trusts a probe for a while, then asks again', async () => {
    const clock = steppingClock();
    const proc = scriptedProc(() => probeOut());
    const adapter = new NinferAdapter({ kind: 'ninfer-native', deps: { clock, proc, fetch: globalThis.fetch, platform: 'linux', log: silentLog }, createClient: realClients, saved: async () => ({ native: { path: '/n' } }), gpus: async () => RTX_5090, probeTtlMs: 1000 });
    await adapter.detect();
    clock.t += 999;
    await adapter.detect();
    expect(proc.calls).toHaveLength(1);
    clock.t += 2;
    await adapter.detect();
    expect(proc.calls).toHaveLength(2);
    adapter.forget();
    await adapter.detect();
    expect(proc.calls).toHaveLength(3);
  });

  it('gives the capabilities of the build (timings, no token ids)', async () => {
    expect(await native().adapter.capabilities({ kind: 'ninfer-native' })).toMatchObject({ version: COMMIT.slice(0, 12), build: COMMIT.slice(0, 12), tokenIdsInPrompt: false, timings: true, minTokens: false, fitFlag: false });
    const none = await native({ path: '' }).adapter.capabilities({ kind: 'ninfer-native' });
    expect(none.flags.size).toBe(0);
    expect(none).not.toHaveProperty('version');
  });
});

describe('artifacts', () => {
  it('reads only .ninfer models, with the manifest next to them', async () => {
    const model = ninferModel(path.join(tmp(), 'm'), { bytes: 8192 });
    expect(artifactOf(model)).toEqual({ file: model.local.paths[0], manifest: model.local.paths[1] });
    expect(await ninferArtifactInfo(model)).toMatchObject({ bytes: 8192, label: 'qwen3_8_27b_nvfp4', manifest: { name: 'qwen3.8-27b', containerVersion: 3 } });
    const bare = ninferModel(path.join(tmp(), 'b'), { manifest: false });
    expect(artifactOf(bare)).toEqual({ file: bare.local.paths[0] });
    // Without a manifest ("senza manifest"): what its name says (no MTP, no DFlash in "qwen3_8_27b_nvfp4").
    expect(await ninferArtifactInfo(bare)).toMatchObject({ manifest: { components: ['text'] }, noManifest: true });
    // A file that is gone: the library's size.
    const gone = { ...bare, local: { ...bare.local, paths: [path.join(tmp(), 'gone.ninfer')] } };
    expect((await ninferArtifactInfo(gone)).bytes).toBe(4096);
    expect(() => artifactOf({ identity: { ...bare.identity, format: 'gguf' }, local: { ...bare.local, identity: { ...bare.identity, format: 'gguf' } } })).toThrow(/\.ninfer/);
    expect(() => artifactOf({ identity: bare.identity })).toThrow(AppError);
    // No size anywhere: 0; a manifest that does not parse is no manifest.
    const unsized = { identity: { ...gone.identity, sizeBytes: undefined }, local: { ...gone.local } };
    expect((await ninferArtifactInfo(unsized)).bytes).toBe(0);
    const broken = ninferModel(path.join(tmp(), 'c'));
    writeFileSync(broken.local.paths[1] as string, '{ not json');
    expect(await ninferArtifactInfo(broken)).toMatchObject({ manifest: { components: ['text'] }, noManifest: true });
    const { adapter } = native();
    expect(await adapter.manifestOf(broken.local.paths[1])).toBeUndefined();
    expect(await adapter.manifestOf(undefined)).toBeUndefined();
  });
});

describe('plan', () => {
  it('builds the exact native command, with the KV pool it asks for', async () => {
    const { adapter } = native({ launcherPrefix: ['node'] });
    const model = ninferModel(path.join(tmp(), 'm'));
    const params = P({ contextSize: 65_536, parallel: 2, env: { CUDA_VISIBLE_DEVICES: '0' }, ninfer: { kvCapacity: 131_072, kvDtype: 'int8', spec: 'mtp' } });
    const plan = (await adapter.plan({ kind: 'ninfer-native' }, model, params, { port: 18_090, marker: 'gpubench-n-1' })) as NinferLaunchPlan;
    expect(plan.argv.slice(0, 9)).toEqual(['node', '/home/u/ninfer/build/apps/ninfer-serve', model.local.paths[0], '--host', '127.0.0.1', '--port', '18090', '--model-id', 'gpubench-n-1']);
    expect(plan).toMatchObject({ env: { CUDA_VISIBLE_DEVICES: '0' }, modelFiles: [model.local.paths[0]], modelBytes: 4096, engine: { name: 'NInfer', version: COMMIT.slice(0, 12), executable: '/home/u/ninfer/build/apps/ninfer-serve' }, ninfer: { kvTokens: 131_072 } });
    expect(plan.ninfer.bytesPerToken).toBeGreaterThan(30_000);
    expect(plan).not.toHaveProperty('pending');
    // A server's own API name; 'auto' leaves the pool to NInfer; no capacity = the context.
    const served = await adapter.plan({ kind: 'ninfer-native' }, model, P({ ninfer: { kvCapacity: 'auto' } }), { port: 1, marker: 'gpubench-n-2', apiName: 'qwen' });
    expect(served.argv).toContain('qwen');
    expect((served as NinferLaunchPlan).ninfer).not.toHaveProperty('kvTokens');
    expect(((await adapter.plan({ kind: 'ninfer-native' }, model, P({ contextSize: 4096 }), { port: 1, marker: 'gpubench-n-3' })) as NinferLaunchPlan).ninfer.kvTokens).toBe(4096);
    // The library's size when the file cannot be read.
    const gone = { ...model, local: { ...model.local, paths: [path.join(tmp(), 'x.ninfer')] } };
    expect((await adapter.plan({ kind: 'ninfer-native' }, gone, P(), { port: 1, marker: 'gpubench-n-4' })).modelBytes).toBe(4096);
    const noSize = { identity: { ...gone.identity, sizeBytes: undefined }, local: { ...gone.local, identity: { ...gone.identity, sizeBytes: undefined } } };
    expect((await adapter.plan({ kind: 'ninfer-native' }, noSize, P(), { port: 1, marker: 'gpubench-n-5' })).modelBytes).toBe(0);
  });

  it('previews before NInfer is set up, and refuses to start without it', async () => {
    const { adapter } = native({ path: '' });
    const model = ninferModel(path.join(tmp(), 'm'));
    const preview = await adapter.plan({ kind: 'ninfer-native' }, model, P(), { port: 1, marker: 'gpubench-p-1', preview: true });
    expect(preview).toMatchObject({ pending: ['engine'], engine: { executable: '~/ninfer/build/apps/ninfer-serve' } });
    expect(preview.engine).not.toHaveProperty('version');
    await expect(adapter.plan({ kind: 'ninfer-native' }, model, P(), { port: 1, marker: 'gpubench-p-2' })).rejects.toMatchObject({ code: 'ENGINE_NOT_INSTALLED', params: { reason: 'not_configured' } });
    const win = native({ deps: { clock: systemClock, proc: scriptedProc(() => ok()), fetch: globalThis.fetch, platform: 'win32', log: silentLog } });
    await expect(win.adapter.plan({ kind: 'ninfer-native' }, model, P(), { port: 1, marker: 'gpubench-p-3' })).rejects.toMatchObject({ params: { reason: 'unsupported-os' } });
  });

  it('runs in the distro with the model as the distro sees it', async () => {
    const dir = tmp();
    const proc = scriptedProc(() => probeOut());
    const wsl = (saved: { distro: string; path: string } | undefined) =>
      new NinferAdapter({
        kind: 'ninfer-wsl',
        deps: { clock: systemClock, proc, fetch: globalThis.fetch, platform: 'win32', log: silentLog },
        createClient: realClients,
        saved: async () => (saved ? { wsl: saved } : undefined),
        gpus: async () => RTX_5090,
        wsl: { argv: ['wsl.exe'], processes: new WslProcesses({ proc, wsl: ['wsl.exe'], file: path.join(dir, 'w.json'), sleep: async () => undefined }) },
      });
    const model = ninferModel(path.join(dir, 'm'));
    const local = { ...model, local: { ...model.local, paths: ['\\\\wsl.localhost\\Ubuntu\\home\\u\\m.ninfer'] } };
    const plan = (await wsl({ distro: 'Ubuntu', path: '/home/u/ninfer' }).plan({ kind: 'ninfer-wsl' }, local, P({ env: { A: '1' } }), { port: 1, marker: 'gpubench-w-1' })) as NinferLaunchPlan;
    expect(plan).toMatchObject({ env: {}, modelFiles: ['/home/u/m.ninfer'], ninfer: { distro: 'Ubuntu' }, engine: { variant: 'Ubuntu' } });
    expect(plan.argv).toContain('A=1');
    expect(plan).not.toHaveProperty('slowSharedFilesystem');
    const elsewhere = { ...model, local: { ...model.local, paths: ['\\\\wsl.localhost\\Debian\\m.ninfer'] } };
    await expect(wsl({ distro: 'Ubuntu', path: '/n' }).plan({ kind: 'ninfer-wsl' }, elsewhere, P(), { port: 1, marker: 'gpubench-w-2' })).rejects.toMatchObject({ params: { reason: 'ninfer_wsl_path' } });
    // No distro chosen: a preview says <distro>; a start is refused.
    const unset = wsl(undefined);
    const preview = await unset.plan({ kind: 'ninfer-wsl', ninferPath: '/n' }, model, P(), { port: 1, marker: 'gpubench-w-3', preview: true });
    expect(preview).toMatchObject({ slowSharedFilesystem: process.platform === 'win32' ? true : undefined });
    expect(preview.argv.slice(1, 3)).toEqual(['-d', '<distro>']);
    await expect(unset.plan({ kind: 'ninfer-wsl', ninferPath: '/n' }, local, P(), { port: 1, marker: 'gpubench-w-4' })).rejects.toMatchObject({ params: { reason: 'distro_missing' } });
    expect(await unset.detect({ kind: 'ninfer-wsl', ninferPath: '/n' })).toMatchObject({ problemParams: { reason: 'distro_missing' } });
    await expect(unset.plan({ kind: 'ninfer-wsl', ninferPath: '/n' }, local, P(), { port: 1, marker: 'gpubench-w-5', preview: true })).rejects.toMatchObject({ params: { reason: 'ninfer_wsl_path', distro: '' } });
  });
});

describe('cold loads', () => {
  it('evicts the artifact inside the distro; natively the shared evictor does it', async () => {
    const dir = tmp();
    const proc = scriptedProc((args) => {
      const exec = args.slice(args.indexOf('--exec') + 1);
      if (exec[0] === 'stat') return ok('4096\n');
      if (exec[0] === 'fincore') return ok('0\n');
      return ok();
    });
    const adapter = new NinferAdapter({
      kind: 'ninfer-wsl',
      deps: { clock: systemClock, proc, fetch: globalThis.fetch, platform: 'win32', log: silentLog },
      createClient: realClients,
      saved: async () => undefined,
      gpus: async () => RTX_5090,
      wsl: { argv: ['wsl.exe'], processes: new WslProcesses({ proc, wsl: ['wsl.exe'], file: path.join(dir, 'w.json'), sleep: async () => undefined }) },
    });
    const base = { modelFiles: ['/home/u/m.ninfer'] } as unknown as NinferLaunchPlan;
    expect(await adapter.evict({ ...base, ninfer: {} } as NinferLaunchPlan)).toEqual({ guaranteed: false, reason: 'not-supported' });
    const done = await adapter.evict({ ...base, ninfer: { distro: 'Ubuntu' } } as NinferLaunchPlan);
    expect(done).toBeDefined();
    expect(proc.calls.some((c) => c.args.includes('-d') && c.args.includes('Ubuntu'))).toBe(true);
    expect(await native().adapter.evict(base)).toBeUndefined();
    const broken = new NinferAdapter({
      kind: 'ninfer-wsl',
      deps: { clock: systemClock, proc: scriptedProc(() => Promise.reject(new Error('wsl gone'))), fetch: globalThis.fetch, platform: 'win32', log: silentLog },
      createClient: realClients,
      saved: async () => undefined,
      gpus: async () => RTX_5090,
      wsl: { argv: ['wsl.exe'], processes: new WslProcesses({ proc, wsl: ['wsl.exe'], file: path.join(dir, 'w.json'), sleep: async () => undefined }) },
    });
    expect(await broken.evict({ ...base, ninfer: { distro: 'Ubuntu' } } as NinferLaunchPlan)).toMatchObject({ guaranteed: false });
  });
});

describe('start (native)', () => {
  it('starts the fake ninfer-serve, records it as ours, serves chat, and stops', async () => {
    const dir = tmp();
    const real = realProc(path.join(dir, 'wsl'));
    const proc = scriptedProc(() => probeOut(), (spec) => real.spawn(spec));
    const owned: number[] = [];
    const log = recordingLog();
    const adapter = new NinferAdapter({
      kind: 'ninfer-native',
      deps: { clock: systemClock, proc, fetch: globalThis.fetch, platform: 'linux', log },
      createClient: realClients,
      saved: async () => ({ native: { path: FAKE_NINFER.replace(/\\/g, '/').replace(/[^/]+$/, 'ninfer-serve') } }),
      gpus: async () => RTX_5090,
      ownership: {
        add: async (r) => {
          owned.push(r.pid);
          throw new Error('disk full');
        },
        remove: async (pid) => {
          owned.splice(owned.indexOf(pid), 1);
        },
      },
      launcherPrefix: [process.execPath],
      pollMs: 50,
      readyTimeoutMs: 30_000,
    });
    const model = ninferModel(path.join(dir, 'm'));
    const plan = await adapter.plan({ kind: 'ninfer-native' }, model, P({ contextSize: 4096, ninfer: { kvDtype: 'int8' } }), { port: await pickFreePort(), marker: 'gpubench-native-1' });
    plan.argv[1] = FAKE_NINFER;
    const inst = await adapter.start(plan, new AbortController().signal);
    expect(inst.pid).toBeGreaterThan(0);
    await inst.waitReady();
    expect(owned).toEqual([inst.pid]);
    expect(log.entries.some((e) => e.msg === 'ownership record failed')).toBe(true);
    await inst.stop();
    await expect.poll(() => owned.length).toBe(0);
  }, 60_000);

  it('does not start when cancelled or when the program cannot be spawned', async () => {
    const { adapter } = native();
    const plan = { argv: ['/x/ninfer-serve', 'm', '--model-id', 'id'], env: {}, host: '127.0.0.1', port: 1, marker: 'gpubench-s-1' } as unknown as NinferLaunchPlan;
    const aborted = new AbortController();
    aborted.abort();
    await expect(adapter.start(plan, aborted.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(adapter.start(plan, new AbortController().signal)).rejects.toMatchObject({ code: 'ENGINE_START_FAILED' });
  });
});

describe('start (native, scripted)', () => {
  it('records the real program, or nothing without a PID; a failed start says why', async () => {
    const owned: string[] = [];
    const ownership = {
      add: async (r: { exe: string }) => {
        owned.push(r.exe);
      },
      remove: async () => undefined,
    };
    const mp = manualProcess(0, 31);
    const proc = scriptedProc(
      () => probeOut(),
      () => mp,
    );
    const adapter = new NinferAdapter({ kind: 'ninfer-native', deps: { clock: systemClock, proc, fetch: globalThis.fetch, platform: 'linux', log: silentLog }, createClient: realClients, saved: async () => undefined, gpus: async () => RTX_5090, ownership, pollMs: 10 });
    const plan = { argv: ['/x/ninfer-serve', 'm', '--model-id', 'id'], env: {}, host: '127.0.0.1', port: 9, marker: 'gpubench-s-2', ninfer: {} } as unknown as NinferLaunchPlan;
    const inst = await adapter.start(plan, new AbortController().signal);
    expect(owned).toEqual(['/x/ninfer-serve']);
    mp.push('2026-09-28 11:59:54.693  FATAL server failed during startup | requested Engine runtime reservation requires 2097152 bytes, but only 1048576 bytes are available for runtime capacity');
    mp.exit({ code: 1, signal: null });
    await expect(inst.waitReady()).rejects.toMatchObject({ code: 'ENGINE_OOM', params: { needMiB: 2, availableMiB: 1 } });
    // No PID (the runner could not say): nothing to record; no ownership registry at all.
    const zero = manualProcess(0, 0);
    const bare = new NinferAdapter({ kind: 'ninfer-native', deps: { clock: systemClock, proc: scriptedProc(() => probeOut(), () => zero), fetch: globalThis.fetch, platform: 'linux', log: silentLog }, createClient: realClients, saved: async () => undefined, gpus: async () => RTX_5090, ownership, pollMs: 10 });
    const second = await bare.start(plan, new AbortController().signal);
    expect(owned).toHaveLength(1);
    zero.exit({ code: 3, signal: null });
    await expect(second.waitReady()).rejects.toMatchObject({ code: 'ENGINE_EXITED' });
  });
});

describe('start (WSL) records', () => {
  it('logs, and goes on, when the record of our process cannot be written or the stop fails', async () => {
    const dir = tmp();
    const mp = manualProcess(0, 9);
    const log = recordingLog();
    const proc = scriptedProc(
      () => Promise.reject(new Error('wsl.exe is gone')),
      () => mp,
    );
    const processes = new WslProcesses({ proc, wsl: ['wsl.exe'], file: path.join(dir, 'w.json'), sleep: async () => undefined });
    processes.add = () => Promise.reject(new Error('disk full'));
    const adapter = new NinferAdapter({
      kind: 'ninfer-wsl',
      deps: { clock: systemClock, proc, fetch: globalThis.fetch, platform: 'win32', log },
      createClient: realClients,
      saved: async () => undefined,
      gpus: async () => RTX_5090,
      wsl: { argv: ['wsl.exe'], processes },
    });
    const plan = { argv: ['wsl.exe', '-d', 'Ubuntu', '--exec', 'x', '--model-id', 'id'], env: {}, host: '127.0.0.1', port: 1, marker: 'gpubench-r-1', ninfer: { distro: 'Ubuntu' } } as unknown as NinferLaunchPlan;
    const inst = await adapter.start(plan, new AbortController().signal);
    expect(inst.pid).toBeUndefined();
    mp.push('gpubench-pid 321');
    mp.push('gpubench-pid 999');
    await expect.poll(() => log.entries.some((e) => e.msg === 'ninfer wsl record failed')).toBe(true);
    await inst.stop();
    expect(log.entries.some((e) => e.msg === 'ninfer wsl stop failed')).toBe(true);
  });

  it('a relay that never said its PID is stopped and forgotten without asking the distro', async () => {
    const mp = manualProcess(0, 10);
    const proc = scriptedProc(
      () => Promise.reject(new Error('never asked')),
      () => mp,
    );
    const processes = new WslProcesses({ proc, wsl: ['wsl.exe'], file: path.join(tmp(), 'w.json'), sleep: async () => undefined });
    const adapter = new NinferAdapter({ kind: 'ninfer-wsl', deps: { clock: systemClock, proc, fetch: globalThis.fetch, platform: 'win32', log: silentLog }, createClient: realClients, saved: async () => undefined, gpus: async () => RTX_5090, wsl: { argv: ['wsl.exe'], processes } });
    const plan = { argv: ['wsl.exe', '--model-id', 'id'], env: {}, host: '127.0.0.1', port: 1, marker: 'gpubench-r-2', ninfer: { distro: 'Ubuntu' } } as unknown as NinferLaunchPlan;
    const inst = await adapter.start(plan, new AbortController().signal);
    await inst.stop();
    expect(proc.calls).toEqual([]);
  });
});
