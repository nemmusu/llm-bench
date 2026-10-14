/**
 * NInfer's two builds as its card sees them, with the fake wsl.exe and real processes: each build's
 * state (pronto, da ricompilare, da compilare, non funziona, non installato) from a probe of its program
 * (its commit, the commit it was built from, the times), "Cambia cartella", and NInfer-all's build
 * request filled in (its repository, its folder, its saved engine).
 */
import { Hono } from 'hono';
import { afterAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CustomEngine } from '../../../../../src/contract/custom-engines';
import type { ServerEvent } from '../../../../../src/contract/events';
import type { LocalModel } from '../../../../../src/contract/models';
import type { NinferSettings } from '../../../../../src/contract/ninfer';
import type { CoreContext } from '../../../../../src/core/context';
import type { Platform, ProcessRunner } from '../../../../../src/core/deps';
import { embeddedManifest, ninferArtifactInfo, parseProbe, probeStale } from '../../../../../src/core/engines/ninfer/adapter';
import { createNinferRoutes } from '../../../../../src/core/engines/ninfer/routes';
import { createNinferServices } from '../../../../../src/core/engines/ninfer/setup';
import type { ModelTarget } from '../../../../../src/core/engines/types';
import { systemClock } from '../../../../../src/core/node-deps';
import { errorResponse } from '../../../../../src/core/server/http-error';
import { buildNinfer } from '../../../../fakes/fake-hub/model-files.mjs';
import { recordingLog, tempDir } from '../../docker/helpers';
import { ninferModel, realClients, realProc, WSL_ARGV } from './helpers';

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups) c();
});

const COMMIT = 'e31bc99b13f517c8aae70b997b7c4a49b4dcdc5d';
const ALL = { url: 'https://github.com/iamwavecut/ninfer-all.git', branch: 'master' };
type Saved = { ninfer?: NinferSettings; customEngines?: CustomEngine[] };

function setup(config: Record<string, unknown> = {}, saved: Saved = {}, platform: Platform = 'win32', gpu = 'NVIDIA GeForce RTX 5090', wrap: (p: ProcessRunner) => ProcessRunner = (p) => p, ninferHost?: string[]) {
  const t = tempDir('gb-ninfer-builds-');
  cleanups.push(t.cleanup);
  let settings: Saved = saved;
  const services = createNinferServices({
    deps: {
      clock: systemClock,
      proc: wrap(realProc(path.join(t.dir, 'wsl'), { FAKE_WSL_CONFIG: JSON.stringify({ stepMs: 5, ...config }) })),
      fetch: globalThis.fetch,
      platform,
      log: recordingLog(),
      paths: { dataDir: t.dir } as never,
      endpoints: { wsl: WSL_ARGV, githubApi: 'https://api.github.test/', ...(ninferHost ? { ninferHost } : {}) } as never,
    },
    createClient: realClients,
    settings: {
      get: async () => settings,
      update: async (patch) => {
        settings = { ...settings, ...patch };
      },
    },
    gpus: async () => [{ name: gpu }],
  });
  const events: ServerEvent[] = [];
  const deps = services.routes({ publish: (e) => events.push(e) });
  const app = new Hono();
  app.onError((e, c) => errorResponse(c, e));
  createNinferRoutes(deps)(app, {} as CoreContext);
  return { t, deps, app, events, services, saved: () => settings };
}

const official: Saved = { ninfer: { wsl: { distro: 'Ubuntu-24.04', path: '/home/user/ninfer' } } };
const allEngine = (over: Partial<CustomEngine['run']> = {}): CustomEngine =>
  ({ schema: 1, id: 'ninfer-all', name: 'NInfer-all', base: 'ninfer', template: 'ninfer-all', run: { mode: 'ninfer', path: '/home/user/ninfer-all', distro: 'Ubuntu-24.04', source: ALL, ...over }, extraArgs: [], env: {}, notes: '' }) as CustomEngine;
const withAll = { checkouts: ['/home/user/ninfer', '/home/user/ninfer-all'], origins: { '/home/user/ninfer-all': ALL.url }, builds: ['/home/user/ninfer/build/apps/ninfer-serve', '/home/user/ninfer-all/build/apps/ninfer-serve'] };

describe("NInfer's builds on its card", () => {
  it('neither set up: both "Non installato", where their guided build would put them', async () => {
    const r = setup();
    expect(await r.deps.builds(false)).toEqual({
      kind: 'ninfer-wsl',
      builds: [
        { build: 'official', kind: 'ninfer-wsl', state: 'missing', source: { url: 'https://github.com/Neroued/ninfer.git' }, dir: '~/ninfer' },
        { build: 'all', kind: 'ninfer-wsl', state: 'missing', source: ALL, dir: '~/ninfer-all' },
      ],
    });
    // Where NInfer does not run: nothing.
    expect(await setup({}, {}, 'darwin').deps.builds(false)).toEqual({ builds: [] });
  }, 60_000);

  it('the official build ready, NInfer-all ready with its KV types; recorded, the program from the code it has', async () => {
    const r = setup({ ...withAll, built: { '/home/user/ninfer': COMMIT } }, { ...official, customEngines: [allEngine()] });
    const { builds } = await r.deps.builds(true);
    expect(builds[0]).toMatchObject({ build: 'official', state: 'ready', dir: '/home/user/ninfer', path: '/home/user/ninfer/build/apps/ninfer-serve', distro: 'Ubuntu-24.04', commit: 'e31bc99', built: 'e31bc99', status: { available: true } });
    expect(builds[1]).toMatchObject({ build: 'all', state: 'ready', dir: '/home/user/ninfer-all', customEngineId: 'ninfer-all', source: ALL, kvDtypes: expect.arrayContaining(['rk8v4']) });
    // Asked again over HTTP, fresh.
    expect((await (await r.app.request('/api/engines/ninfer/builds?fresh=1')).json()).builds).toHaveLength(2);
  }, 60_000);

  it('"Da ricompilare": built from another commit, or older than the last commit; "Da compilare": the checkout without its program', async () => {
    const other = setup({ built: { '/home/user/ninfer': 'aaaaaaa1111111111111111111111111111111aa' } }, official);
    expect((await other.deps.builds(false)).builds[0]).toMatchObject({ state: 'stale', built: 'aaaaaaa', commit: 'e31bc99' });
    const pulled = setup({ headTime: 1_760_200_000 }, official);
    expect((await pulled.deps.builds(false)).builds[0]).toMatchObject({ state: 'stale' });
    // NInfer-all cloned, its configure stopped (the user's case): no program yet, its engine saved by hand before.
    const half = setup({ ...withAll, builds: ['/home/user/ninfer/build/apps/ninfer-serve'] }, { ...official, customEngines: [allEngine()] });
    expect((await half.deps.builds(false)).builds[1]).toMatchObject({ build: 'all', state: 'not-built', commit: 'e31bc99', status: { installed: false, problemParams: { reason: 'ninfer_not_found' } } });
  }, 60_000);

  it('NInfer-all not saved: its usual folder (~/ninfer-all) is looked at; a clone there is built in place, a working build is taken as it is', async () => {
    // The user's PC: cloned, its configure stopped, never saved: "Da compilare" in that folder, nothing saved.
    const half = setup({ ...withAll, builds: ['/home/user/ninfer/build/apps/ninfer-serve'] }, official);
    expect((await half.deps.builds(false)).builds[1]).toEqual({ build: 'all', kind: 'ninfer-wsl', state: 'not-built', source: ALL, dir: '/home/user/ninfer-all', distro: 'Ubuntu-24.04', commit: 'e31bc99' });
    expect(half.saved().customEngines).toBeUndefined();
    // Nothing there, or a distro that is gone: "Non installato".
    expect((await setup({}, official).deps.builds(false)).builds[1]).toMatchObject({ state: 'missing', dir: '~/ninfer-all' });
    expect((await setup({}, { ninfer: { wsl: { distro: 'Gone', path: '/home/user/ninfer' } } }).deps.builds(false)).builds[1]).toMatchObject({ state: 'missing', distro: 'Gone' });
    // Built by hand there: saved as NInfer-all at once, ready.
    const own = setup(withAll, official);
    expect((await own.deps.builds(false)).builds[1]).toMatchObject({ state: 'ready', customEngineId: 'ninfer-all', dir: '/home/user/ninfer-all', path: '/home/user/ninfer-all/build/apps/ninfer-serve' });
    expect(own.saved().customEngines).toEqual([expect.objectContaining({ id: 'ninfer-all', template: 'ninfer-all', run: { mode: 'ninfer', path: '/home/user/ninfer-all/build/apps/ninfer-serve', distro: 'Ubuntu-24.04', source: ALL } })]);
  }, 90_000);

  it('a model that needs NInfer-all: its saved engine, else a build in ~/ninfer-all (in the default distro when none is saved) taken as it is', async () => {
    // The user's PC after building it by hand: nothing saved, not even the official build's distro.
    const own = setup(withAll);
    const found = await own.services.findAll('ninfer-wsl');
    expect(found).toMatchObject({ id: 'ninfer-all', template: 'ninfer-all', run: { path: '/home/user/ninfer-all/build/apps/ninfer-serve', distro: 'Ubuntu-24.04', source: ALL } });
    expect(own.saved().customEngines).toHaveLength(1);
    // Saved from now on: asked again, the same engine, nothing probed.
    expect(await own.services.findAll('ninfer-wsl')).toEqual(found);
    // Only a clone there, or nothing: none.
    expect(await setup({ ...withAll, builds: [] }, official).services.findAll('ninfer-wsl')).toBeUndefined();
    // No WSL distro at all, or WSL that cannot be asked: none, nothing probed.
    expect(await setup({ noWsl: true }).services.findAll('ninfer-wsl')).toBeUndefined();
    const broken = setup(withAll, {}, 'win32', 'NVIDIA GeForce RTX 5090', (p) => ({ ...p, run: (cmd, args, opts) => (args.includes('-l') ? Promise.reject(new Error('wsl.exe gone')) : p.run(cmd, args, opts)) }));
    expect(await broken.services.findAll('ninfer-wsl')).toBeUndefined();
    expect((await broken.deps.builds(false)).builds[1]).toMatchObject({ state: 'missing' });
  }, 90_000);

  it('on a Linux PC (a fake host runs every program): both builds checked there, NInfer-all found in ~/ninfer-all, then built there from scratch', async () => {
    const HOST = [...WSL_ARGV, '--host'];
    const linux: Saved = { ninfer: { native: { path: '/home/user/ninfer' } } };
    const found = setup(withAll, linux, 'linux', 'NVIDIA GeForce RTX 5090', (p) => p, HOST);
    const { kind, builds } = await found.deps.builds(true);
    expect(kind).toBe('ninfer-native');
    expect(builds[0]).toMatchObject({ build: 'official', kind: 'ninfer-native', state: 'ready', dir: '/home/user/ninfer', commit: 'e31bc99' });
    expect(builds[1]).toMatchObject({ build: 'all', state: 'ready', customEngineId: 'ninfer-all', release: '0.12.0-rtx3090+v0.6.0-rtx3090-1704-ge7b7e669', kvDtypes: expect.arrayContaining(['rk8v4']) });
    expect(builds[1]).not.toHaveProperty('distro');
    expect(found.saved().customEngines?.[0]?.run).toEqual({ mode: 'ninfer', path: '/home/user/ninfer-all/build/apps/ninfer-serve', source: ALL });
    // "Cambia cartella" on Linux: saved with no distro.
    expect(await found.deps.setBuildPath('official', { path: '/home/user/ninfer/build/apps/ninfer-serve' })).toMatchObject({ saved: true });
    expect(found.saved().ninfer).toEqual({ native: { path: '/home/user/ninfer/build/apps/ninfer-serve' } });
    // Not there yet: built in its usual folder, through the same steps.
    const fresh = setup({ checkouts: ['/home/user/ninfer'] }, linux, 'linux', 'NVIDIA GeForce RTX 5090', (p) => p, HOST);
    await fresh.app.request('/api/engines/ninfer/build', { method: 'POST', body: JSON.stringify({ kind: 'ninfer-native', build: 'all', confirm: true }), headers: { 'content-type': 'application/json' } });
    for (let i = 0; i < 400 && !fresh.events.some((e) => e.type === 'engine.install' && (e.stage === 'done' || e.stage === 'error')); i++) await new Promise((res) => setTimeout(res, 25));
    expect(fresh.events.at(-1)).toMatchObject({ type: 'engine.install', kind: 'ninfer-all', stage: 'done', result: { customEngineId: 'ninfer-all', ninferPath: '/home/user/ninfer-all/build/apps/ninfer-serve' } });
    expect(fresh.events.filter((e) => e.type === 'engine.install').map((e) => (e as { stage: string }).stage)).toEqual(expect.arrayContaining(['clone', 'configure', 'build']));
  }, 90_000);

  it('on Linux: no distro; a program outside a checkout is shown with its own folder', async () => {
    const linux = setup({}, { ninfer: { native: { path: '/opt/bin/ninfer-serve' } }, customEngines: [allEngine({ path: '/opt/all/ninfer-serve', distro: undefined })] }, 'linux');
    const { kind, builds } = await linux.deps.builds(false);
    expect(kind).toBe('ninfer-native');
    expect(builds[0]).toMatchObject({ build: 'official', dir: '/opt/bin', path: '/opt/bin/ninfer-serve' });
    expect(builds[0]).not.toHaveProperty('distro');
    expect(builds[1]).toMatchObject({ build: 'all', dir: '/opt/all', customEngineId: 'ninfer-all' });
    expect(builds[1]).not.toHaveProperty('distro');
    // NInfer-all not saved on Linux: its folder looked at with no distro.
    expect((await setup({}, {}, 'linux').deps.builds(false)).builds[1]).toMatchObject({ build: 'all', kind: 'ninfer-native', state: 'missing' });
  }, 60_000);

  it('"Non funziona": a path that is not NInfer, a distro that is gone; a GPU that is not an RTX 5090 is said', async () => {
    const broken = setup({}, { ninfer: { wsl: { distro: 'Ubuntu-24.04', path: '/opt/nothing' } }, customEngines: [allEngine({ distro: 'Gone', source: undefined })] });
    const { builds } = await broken.deps.builds(false);
    expect(builds[0]).toMatchObject({ state: 'broken', dir: '/opt/nothing', status: { problemParams: { reason: 'ninfer_not_found' } } });
    expect(builds[0]?.commit).toBeUndefined();
    // Saved without a repository of its own: NInfer-all's.
    expect(builds[1]).toMatchObject({ state: 'broken', distro: 'Gone', source: ALL, status: { problemParams: { reason: 'distro_missing' } } });
    const gpu = setup({}, official, 'win32', 'NVIDIA GeForce RTX 4090');
    expect((await gpu.deps.builds(false)).builds[0]?.status?.problems).toEqual(['ENGINE_GPU_UNSUPPORTED']);
  }, 60_000);

  it('"Cambia cartella": saved only when it answers; NInfer-all as its engine (made, then updated)', async () => {
    const r = setup(withAll);
    expect(await r.deps.setBuildPath('official', { path: '/opt/nothing' })).toMatchObject({ saved: false, status: { installed: false } });
    expect(r.saved().ninfer).toBeUndefined();
    // No distro saved yet: the one asked for.
    expect(await r.deps.setBuildPath('official', { path: '/home/user/ninfer', distro: 'Ubuntu-24.04' })).toMatchObject({ saved: true });
    expect(r.saved().ninfer).toEqual(official.ninfer);
    // NInfer-all: in the official build's distro unless said.
    expect((await r.deps.setBuildPath('all', { path: '/home/user/ninfer-all' })).saved).toBe(true);
    expect(r.saved().customEngines).toEqual([expect.objectContaining({ id: 'ninfer-all', template: 'ninfer-all', run: { mode: 'ninfer', path: '/home/user/ninfer-all', distro: 'Ubuntu-24.04', source: ALL } })]);
    expect((await r.deps.setBuildPath('all', { path: '/home/user/ninfer-all/build/apps/ninfer-serve' })).saved).toBe(true);
    expect(r.saved().customEngines).toHaveLength(1);
    expect(r.saved().customEngines?.[0]?.run).toMatchObject({ path: '/home/user/ninfer-all/build/apps/ninfer-serve' });
    // Over HTTP; a build that is not NInfer's.
    const res = await r.app.request('/api/engines/ninfer/builds/official', { method: 'PUT', body: JSON.stringify({ path: '/home/user/ninfer' }), headers: { 'content-type': 'application/json' } });
    expect(await res.json()).toMatchObject({ saved: true });
    // On Linux: no distro anywhere.
    const linux = setup({}, {}, 'linux');
    expect((await linux.deps.setBuildPath('all', { path: '/opt/x' })).saved).toBe(false);
  }, 90_000);

  it('removing a build: one LLM Bench built goes with its folder, the user\'s own is forgotten, one built by hand in ~/ninfer-all goes by hand', async () => {
    const all = allEngine();
    const r = setup({ ...withAll, checkouts: [...withAll.checkouts, '/opt/mine'], builds: [...withAll.builds, '/opt/mine/build/apps/ninfer-serve'], built: { '/home/user/ninfer': COMMIT }, sizes: { '/home/user/ninfer': 2048 } }, { ...official, customEngines: [all] });
    // Built by LLM Bench (its record is there): deleted, with its size and the command first.
    expect(await r.deps.removePlan('official')).toEqual({ build: 'official', mode: 'delete', dir: '/home/user/ninfer', distro: 'Ubuntu-24.04', sizeBytes: 2048 * 1024, command: 'wsl -d Ubuntu-24.04 -- rm -rf /home/user/ninfer' });
    // Built by hand where LLM Bench looks for NInfer-all: it would be found again, so by hand.
    expect(await r.deps.removePlan('all')).toEqual({ build: 'all', mode: 'manual', dir: '/home/user/ninfer-all', distro: 'Ubuntu-24.04', command: 'wsl -d Ubuntu-24.04 -- rm -rf /home/user/ninfer-all' });
    await expect(r.deps.remove('all')).rejects.toMatchObject({ code: 'VALIDATION', params: { reason: 'manual' } });
    expect(r.saved().customEngines).toEqual([all]);

    const res = await r.app.request('/api/engines/ninfer/builds/official/remove', { method: 'POST' });
    expect(await res.json()).toEqual({ ok: true });
    expect(r.saved().ninfer).toEqual({});
    expect((await r.deps.builds(true)).builds[0]).toMatchObject({ build: 'official', state: 'missing' });
    // Gone: nothing to remove.
    await expect(r.deps.removePlan('official')).rejects.toMatchObject({ code: 'VALIDATION', params: { reason: 'not-installed' } });

    // The user's own build, somewhere else: only forgotten, its files stay.
    expect((await r.deps.setBuildPath('all', { path: '/opt/mine', distro: 'Ubuntu-24.04' })).saved).toBe(true);
    expect(await r.deps.removePlan('all')).toEqual({ build: 'all', mode: 'forget', dir: '/opt/mine', distro: 'Ubuntu-24.04' });
    await r.deps.remove('all');
    expect(r.saved().customEngines).toEqual([]);
    expect(await r.deps.removePlan('official').catch((e: { code: string }) => e.code)).toBe('VALIDATION');
  }, 90_000);

  it("deleting a NInfer variant: the checkout LLM Bench built goes with it; the user's own, or one outside a home folder, stays", async () => {
    const variant = (id: string, p: string): CustomEngine => ({ ...allEngine({ path: p, source: { url: 'https://github.com/x/fusion.git' } }), id, name: id, template: undefined }) as CustomEngine;
    const fusion = variant('fusion', '/home/user/ninfer-fusion');
    const r = setup(
      { checkouts: ['/home/user/ninfer-fusion', '/home/user/mine', '/opt/fork'], builds: ['/home/user/ninfer-fusion/build/apps/ninfer-serve', '/home/user/mine/build/apps/ninfer-serve', '/opt/fork/build/apps/ninfer-serve'], built: { '/home/user/ninfer-fusion': COMMIT, '/opt/fork': COMMIT }, sizes: { '/home/user/ninfer-fusion': 1024 } },
      { customEngines: [fusion] },
    );
    expect(await r.services.variantFiles(fusion)).toEqual({ kind: 'folder', target: '/home/user/ninfer-fusion', distro: 'Ubuntu-24.04', sizeBytes: 1024 * 1024, command: 'wsl -d Ubuntu-24.04 -- rm -rf /home/user/ninfer-fusion' });
    // Built by hand (no record), or somewhere LLM Bench never deletes: only forgotten.
    expect(await r.services.variantFiles(variant('mine', '/home/user/mine'))).toBeUndefined();
    expect(await r.services.variantFiles(variant('fork', '/opt/fork'))).toBeUndefined();
    // Not while NInfer is being built.
    const files = (await r.services.variantFiles(fusion))!;
    r.deps.jobs.building = true;
    await expect(r.services.removeVariantFiles(fusion, files)).rejects.toMatchObject({ code: 'ENGINE_IN_USE', params: { engine: 'fusion' } });
    r.deps.jobs.building = false;
    await r.services.removeVariantFiles(fusion, files);
    expect(await r.services.variantFiles(fusion)).toBeUndefined();
  }, 90_000);

  it('removing on Linux (a fake host runs every program): the official build LLM Bench made, deleted there; a failed deletion is said', async () => {
    const host = [...WSL_ARGV, '--host'];
    const r = setup({ checkouts: ['/home/user/ninfer'], builds: ['/home/user/ninfer/build/apps/ninfer-serve'], built: { '/home/user/ninfer': COMMIT }, sizes: { '/home/user/ninfer': 0 } }, { ninfer: { native: { path: '/home/user/ninfer' } } }, 'linux', undefined, undefined, host);
    // du says nothing useful: no size, the rest as usual.
    expect(await r.deps.removePlan('official')).toEqual({ build: 'official', mode: 'delete', dir: '/home/user/ninfer', command: 'rm -rf /home/user/ninfer' });
    // A variant built there (natively): its folder, no distro, no size.
    const native = { ...allEngine({ path: '/home/user/ninfer' }), id: 'here', run: { mode: 'ninfer', path: '/home/user/ninfer' } } as CustomEngine;
    expect(await r.services.variantFiles(native)).toEqual({ kind: 'folder', target: '/home/user/ninfer', command: 'rm -rf /home/user/ninfer' });
    await r.deps.remove('official');
    expect(r.saved().ninfer).toEqual({});
  }, 90_000);

  it("NInfer-all's build request: its repository and folder, its saved engine and checkout", async () => {
    const r = setup();
    expect(await r.deps.normalize({ kind: 'ninfer-wsl', distro: 'Ubuntu-24.04', build: 'all' })).toEqual({
      kind: 'ninfer-wsl',
      distro: 'Ubuntu-24.04',
      build: 'all',
      dir: '~/ninfer-all',
      source: ALL,
      variant: { template: 'ninfer-all', name: 'NInfer-all' },
    });
    const saved = setup({}, { customEngines: [allEngine({ path: '/srv/all/build/apps/ninfer-serve' })] });
    expect(await saved.deps.normalize({ kind: 'ninfer-wsl', build: 'all' })).toMatchObject({ dir: '/srv/all', variant: { id: 'ninfer-all', name: 'NInfer-all' } });
    // A program outside a checkout: its own folder is not a checkout to build in.
    const loose = setup({}, { customEngines: [allEngine({ path: '/opt/bin/ninfer-serve' })] });
    expect(await loose.deps.normalize({ kind: 'ninfer-wsl', build: 'all' })).toMatchObject({ dir: '~/ninfer-all' });
    const plain = { kind: 'ninfer-wsl' as const, dir: '/x' };
    expect(await r.deps.normalize(plain)).toBe(plain);
  }, 60_000);

  it('built end to end over HTTP: NInfer-all saved as its engine, its events named', async () => {
    const r = setup({ checkouts: ['/home/user/ninfer'] }, official);
    await r.app.request('/api/engines/ninfer/build', { method: 'POST', body: JSON.stringify({ kind: 'ninfer-wsl', distro: 'Ubuntu-24.04', build: 'all', confirm: true }), headers: { 'content-type': 'application/json' } });
    for (let i = 0; i < 400 && !r.events.some((e) => e.type === 'engine.install' && (e.stage === 'done' || e.stage === 'error')); i++) await new Promise((res) => setTimeout(res, 25));
    expect(r.events.at(-1)).toMatchObject({ type: 'engine.install', kind: 'ninfer-all', label: 'NInfer-all', stage: 'done', result: { customEngineId: 'ninfer-all', ninferPath: '/home/user/ninfer-all/build/apps/ninfer-serve' } });
    const { builds } = await r.deps.builds(true);
    expect(builds[1]).toMatchObject({ state: 'ready', built: 'e31bc99' });
  }, 90_000);
});

describe('what the probe of a build says', () => {
  it('the commit it was built from and the times; older than the code or not', () => {
    const out = (stdout: string) => ({ code: 0, stdout, stderr: '', timedOut: false });
    const p = parseProbe(out(`--host --port --model-id --max-context --kv-dtype\n##gpubench-help 0\n##gpubench-commit ${COMMIT}\n##gpubench-built ${COMMIT}\n##gpubench-headtime 10\n##gpubench-servetime 20\n`), { serve: '/s' });
    expect(p).toMatchObject({ ok: true, commit: COMMIT, built: COMMIT, headTime: 10, serveTime: 20 });
    const none = parseProbe(out('--host\n##gpubench-help 0\n##gpubench-built \n##gpubench-headtime \n##gpubench-servetime 0\n'), { serve: '/s' });
    expect(none).not.toHaveProperty('built');
    expect(none).not.toHaveProperty('headTime');
    expect(none).not.toHaveProperty('serveTime');
    expect(probeStale({ ok: false, commit: COMMIT, built: 'x' })).toBe(false);
    expect(probeStale({ ok: true })).toBe(false);
    expect(probeStale({ ok: true, commit: COMMIT, built: COMMIT })).toBe(false);
    expect(probeStale({ ok: true, commit: COMMIT, built: 'aaaaaaa' })).toBe(true);
    expect(probeStale({ ok: true, commit: COMMIT, headTime: 20, serveTime: 10 })).toBe(true);
    expect(probeStale({ ok: true, commit: COMMIT, headTime: 10, serveTime: 20 })).toBe(false);
    expect(probeStale({ ok: true, commit: COMMIT, headTime: 10 })).toBe(false);
  });

  it("an artifact's parts from the manifest at its start when none is next to it (the VRAM estimate counts its vision weights)", async () => {
    const t = tempDir('gb-ninfer-embedded-');
    cleanups.push(t.cleanup);
    const a = ninferModel(path.join(t.dir, 'a'), { manifest: false });
    writeFileSync(a.local.paths[0] as string, buildNinfer({ name: 'qwen3.8-27b', components: ['text', 'mtp', 'vision'], layouts: ['gguf_blocks_v1'] }));
    const model: ModelTarget = { identity: a.identity, local: a.local as LocalModel };
    expect(await ninferArtifactInfo(model)).toMatchObject({ manifest: { name: 'qwen3.8-27b', components: ['text', 'mtp', 'vision'], containerVersion: 3 } });
    expect(await embeddedManifest(path.join(t.dir, 'missing.ninfer'))).toBeUndefined();
    // Bare: no name.
    writeFileSync(a.local.paths[0] as string, buildNinfer({ name: '', components: ['text'], layouts: [] }));
    expect(await embeddedManifest(a.local.paths[0] as string)).toEqual({ components: ['text'], containerVersion: 3, proposalHead: true });
  });
});
