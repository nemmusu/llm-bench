/**
 * NInfer's "Aggiorna" (the engines' update contract) of a build in WSL, with real processes: the fake
 * wsl.exe plays the distro's git (fetch, pull --ff-only, reset) and cmake. Only the checkout is touched;
 * a failed build puts the previous program and commit back.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AppError } from '../../../../../src/contract/errors';
import { NinferAdapter } from '../../../../../src/core/engines/ninfer/adapter';
import { NinferBuilder } from '../../../../../src/core/engines/ninfer/build';
import { NinferUpdater } from '../../../../../src/core/engines/ninfer/update';
import { WslProcesses } from '../../../../../src/core/engines/ninfer/wsl';
import { systemClock } from '../../../../../src/core/node-deps';
import { silentLog, tempDir } from '../../docker/helpers';
import { MANIFEST, ninferModel, realClients, realProc, WSL_ARGV } from './helpers';

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups) c();
});

const OLD = 'e31bc99b13f517c8aae70b997b7c4a49b4dcdc5d';
const INCOMING = [
  { sha: '4f2a9c1d0e8b7a6f5e4d3c2b1a0f9e8d7c6b5a49', title: 'serve: faster MTP verification' },
  { sha: '9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c', title: 'docs: KV capacity examples' },
];
const SERVE = '/home/user/ninfer/build/apps/ninfer-serve';

function setup(config: Record<string, unknown> = {}, saved: { distro: string; path: string } | null = { distro: 'Ubuntu-24.04', path: '/home/user/ninfer' }, o: { building?: boolean } = {}) {
  const t = tempDir('gb-ninfer-update-');
  cleanups.push(t.cleanup);
  const state = path.join(t.dir, 'wsl');
  const proc = realProc(state, { FAKE_WSL_CONFIG: JSON.stringify({ stepMs: 5, ...config }) });
  const processes = new WslProcesses({ proc, wsl: WSL_ARGV, file: path.join(t.dir, 'ninfer-wsl.json'), sleep: (ms) => systemClock.sleep(ms) });
  const adapter = new NinferAdapter({
    kind: 'ninfer-wsl',
    deps: { clock: systemClock, proc, fetch: globalThis.fetch, platform: 'win32', log: silentLog },
    createClient: realClients,
    saved: async () => (saved ? { wsl: saved } : {}),
    gpus: async () => [{ name: 'NVIDIA GeForce RTX 5090', computeCapability: '12.0', memTotalMiB: 32607 }],
    wsl: { argv: WSL_ARGV, processes },
  });
  const builder = new NinferBuilder({ kind: 'ninfer-wsl', proc, wsl: { argv: WSL_ARGV, processes }, newMarker: () => `gpubench-up-${Math.random().toString(36).slice(2)}` });
  // A v2 artifact in the library (the build reads v3), and a v3 one.
  const old = ninferModel(path.join(t.dir, 'models', 'old'));
  writeFileSync(old.local.paths[1] as string, JSON.stringify({ ...MANIFEST, artifact: { ...MANIFEST.artifact, container_version: 2 } }));
  const current = ninferModel(path.join(t.dir, 'models', 'new'));
  const models = [old.local, { ...current.local, id: 'n2' }];
  const updater = new NinferUpdater({
    kind: 'ninfer-wsl',
    builder,
    where: () => adapter.where(),
    models: async () => models,
    verify: async () => {
      adapter.forget();
      return (await adapter.detect()).installed;
    },
    building: () => o.building === true,
    clock: { wall: () => Date.parse('2026-10-13T12:00:00.000Z') },
  });
  const stages: string[] = [];
  const progress = (p: { stage: string }) => {
    if (stages[stages.length - 1] !== p.stage) stages.push(p.stage);
  };
  const fakeState = () => JSON.parse(readFileSync(path.join(state, 'config.json'), 'utf8')) as Record<string, unknown>;
  return { adapter, builder, updater, stages, progress, old, fakeState };
}

const linux = (p: string) => (process.platform === 'win32' ? `/mnt/${p[0]?.toLowerCase()}/${p.slice(3).replace(/\\/g, '/')}` : p);
const run = (u: NinferUpdater, progress: (p: { stage: string }) => void) => u.update(progress, new AbortController().signal);

describe('NInfer update (fake WSL, real processes)', () => {
  it('an up-to-date checkout: the exact commands, the way back, and the models the build cannot read', async () => {
    const { updater, old } = setup();
    const file = old.local.paths[0] as string;
    const { check, run: nothing } = await updater.plan({ fetch: true });
    expect(nothing).toBeUndefined();
    expect(check).toEqual({
      target: 'ninfer-wsl',
      method: 'git',
      state: 'current',
      distro: 'Ubuntu-24.04',
      checkedAt: '2026-10-13T12:00:00.000Z',
      repo: '/home/user/ninfer',
      buildDir: '/home/user/ninfer/build',
      branch: 'master',
      current: 'e31bc99',
      latest: 'e31bc99',
      commands: [
        ['cp', '-p', SERVE, `${SERVE}.gpubench-previous`],
        ['git', '-C', '/home/user/ninfer', 'pull', '--ff-only'],
        ['cmake', '--build', '/home/user/ninfer/build', '-j'],
        ['git', '-C', '/home/user/ninfer', 'rev-parse', 'HEAD', '>', '/home/user/ninfer/build/.llmbench-built-commit'],
      ],
      restore: [
        ['mv', '-f', `${SERVE}.gpubench-previous`, SERVE],
        ['git', '-C', '/home/user/ninfer', 'reset', '--hard', OLD],
      ],
      ninfer: {
        containerVersion: 3,
        artifacts: [
          {
            id: 'n1',
            name: 'qwen3_8_27b_nvfp4',
            file,
            version: 2,
            needs: 3,
            command: `cd /home/user/ninfer && python3 tools/upgrade_ninfer_v2_to_v3.py ${linux(file)} ${linux(file).replace(/\.ninfer$/, '.v3.ninfer')}`,
          },
        ],
      },
    });
  }, 60_000);

  it('pulls and rebuilds with progress, checks the new build, and gives its commit', async () => {
    const { adapter, updater, stages, progress, fakeState } = setup({ incoming: INCOMING });
    expect((await updater.plan()).check).toMatchObject({ state: 'available', commits: 2, latest: '4f2a9c1', log: INCOMING.map((c) => ({ sha: c.sha.slice(0, 7), title: c.title })) });
    expect((await adapter.detect()).version).toBe(OLD.slice(0, 12));
    expect(await run(updater, progress)).toEqual({ version: '4f2a9c1' });
    expect(stages).toEqual(['git-pull', 'build', 'verify']);
    // The commit the new program was built from is written next to it ("Da ricompilare" compares it).
    expect(fakeState()).toMatchObject({ kept: [], commit: INCOMING[0]?.sha, incoming: [], built: { '/home/user/ninfer': INCOMING[0]?.sha } });
    // The check of the new build already ran (verify): the card shows the new commit at once.
    expect((await adapter.detect()).version).toBe(INCOMING[0]?.sha.slice(0, 12));
    expect((await updater.plan()).check).toMatchObject({ state: 'current', current: '4f2a9c1' });
    await expect(run(updater, progress)).rejects.toMatchObject({ code: 'ENGINE_UPDATE_FAILED', params: { reason: 'current' } });
  }, 60_000);

  it('puts the previous program and commit back when the build fails', async () => {
    const { updater, progress, fakeState } = setup({ incoming: INCOMING, failStage: 'build' });
    const err = (await run(updater, progress).catch((e: unknown) => e)) as AppError;
    expect(err.code).toBe('ENGINE_UPDATE_FAILED');
    expect(err.params).toMatchObject({ reason: 'cmake', stage: 'build', restored: true, commit: OLD.slice(0, 7) });
    expect(err.detail).toContain('Unsupported gpu architecture');
    expect(fakeState()).toMatchObject({ kept: [], commit: OLD, incoming: INCOMING });
  }, 60_000);

  it('drops the kept copy when the pull fails', async () => {
    const { updater, progress, fakeState } = setup({ incoming: INCOMING, failStage: 'pull' });
    await expect(run(updater, progress)).rejects.toMatchObject({ code: 'ENGINE_UPDATE_FAILED', params: { reason: 'git', stage: 'git-pull' } });
    expect(fakeState()).toMatchObject({ kept: [] });
  }, 60_000);

  it('blocked as the other engines are: changes, own commits, detached, no upstream, a fetch that fails, no cmake, no git, a build running', async () => {
    const reason = async (config: Record<string, unknown>, o: { building?: boolean; fetch?: boolean } = {}) => (await setup(config, undefined, o).updater.plan({ fetch: o.fetch === true })).check;
    expect(await reason({ incoming: INCOMING, dirty: ['src/serve/main.cpp'] })).toMatchObject({ state: 'blocked', reason: 'dirty', changed: 1, commits: 2 });
    expect(await reason({ incoming: INCOMING, ahead: 1 })).toMatchObject({ state: 'blocked', reason: 'diverged', commits: 2 });
    expect(await reason({ branch: 'HEAD' })).toMatchObject({ state: 'blocked', reason: 'detached' });
    expect(await reason({ upstream: null })).toMatchObject({ state: 'blocked', reason: 'no-upstream' });
    expect(await reason({ offline: true }, { fetch: true })).toMatchObject({ state: 'blocked', reason: 'fetch-failed', detail: expect.stringContaining('unable to access') });
    expect(await reason({ offline: true })).toMatchObject({ state: 'current' });
    expect(await reason({ incoming: INCOMING, prereqs: { cmake: '' } })).toMatchObject({ state: 'blocked', reason: 'cmake-missing', commits: 2 });
    expect(await reason({ prereqs: { git: '' } })).toMatchObject({ state: 'blocked', reason: 'git-missing', commands: [] });
    expect(await reason({ incoming: INCOMING }, { building: true })).toMatchObject({ state: 'blocked', reason: 'busy' });
    // Built outside its checkout's build folder: updated with its own tools.
    const elsewhere = setup({ checkouts: [], builds: ['/opt/ninfer-serve'] }, { distro: 'Ubuntu-24.04', path: '/opt/ninfer-serve' });
    expect((await elsewhere.updater.plan()).check).toMatchObject({ method: 'none', state: 'none', reason: 'tools', commands: [] });
    await expect(run(elsewhere.updater, elsewhere.progress)).rejects.toMatchObject({ code: 'ENGINE_UPDATE_FAILED', params: { reason: 'tools' } });
    const dirty = setup({ incoming: INCOMING, dirty: ['a.cpp', 'b.cpp'] });
    await expect(run(dirty.updater, dirty.progress)).rejects.toMatchObject({ params: { reason: 'dirty', changed: 2 } });
    // Not set up: nothing to update.
    expect((await setup({}, null).updater.plan()).check).toMatchObject({ state: 'blocked', reason: 'not-installed' });
  }, 120_000);

  it('a checkout pulled by hand and never rebuilt is not "up to date": a rebuild, then it is', async () => {
    // HEAD's commit is newer than the program (no record of what it was built from: built by hand).
    const byHand = setup({ headTime: 1_760_200_000 });
    const { check } = await byHand.updater.plan();
    expect(check).toMatchObject({ state: 'available', stale: true, commits: 0, current: 'e31bc99' });
    expect(await run(byHand.updater, byHand.progress)).toEqual({ version: 'e31bc99' });
    expect(byHand.stages).toEqual(['build', 'verify']);
    // No pull: the commit stays where it was (never written), the program's record is the commit checked out.
    expect(byHand.fakeState()).toMatchObject({ kept: [], built: { '/home/user/ninfer': OLD } });
    expect(byHand.fakeState()).not.toHaveProperty('commit');
    expect((await byHand.updater.plan()).check).toMatchObject({ state: 'current' });
    // Built by LLM Bench from another commit than the one checked out now.
    const other = setup({ built: { '/home/user/ninfer': INCOMING[1]?.sha } });
    expect((await other.updater.plan()).check).toMatchObject({ state: 'available', stale: true, built: INCOMING[1]?.sha.slice(0, 7) });
    // Its rebuild fails: the program is put back, the checkout is not touched.
    const failing = setup({ headTime: 1_760_200_000, failStage: 'build' });
    await expect(run(failing.updater, failing.progress)).rejects.toMatchObject({ params: { reason: 'cmake', restored: true, reading: 'cuda-too-old' } });
    expect(failing.fakeState()).toMatchObject({ kept: [] });
    expect(failing.fakeState()).not.toHaveProperty('commit');
  }, 90_000);

  it('a pull that meets local changes stops with what git said, and changes nothing', async () => {
    // The check says so first (no pull is offered); a pull that meets them anyway is refused by git itself.
    const { builder, progress, fakeState } = setup({ incoming: INCOMING, dirty: ['src/serve/main.cpp'] });
    const err = (await builder.step('git-pull', ['git', '-C', '/home/user/ninfer', 'pull', '--ff-only'], 'Ubuntu-24.04', progress, new AbortController().signal, []).catch((e: unknown) => e)) as AppError;
    expect(err).toMatchObject({ code: 'ENGINE_INSTALL_FAILED', params: { stage: 'git-pull', reading: 'local-changes' } });
    expect(err.detail).toContain('src/serve/main.cpp');
    // Nothing was written: no commit moved, nothing reset.
    expect(() => fakeState()).toThrow();
  }, 60_000);

  it('says when the program cannot be kept aside, or the rebuilt one does not answer', async () => {
    // The checkout is there but its build is not (removed by hand): nothing to keep, nothing changes.
    const gone = setup({ incoming: INCOMING, builds: [] });
    await expect(run(gone.updater, gone.progress)).rejects.toMatchObject({ params: { reason: 'ninfer_keep' } });
  }, 60_000);
});
