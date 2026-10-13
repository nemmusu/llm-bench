/**
 * "Controlla aggiornamenti" / "Aggiorna" of a NInfer build in WSL, with real processes: the fake wsl.exe
 * plays the distro's git (fetch, pull --ff-only, reset) and cmake. Only the checkout is touched; a
 * failed build puts the previous program and commit back.
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

function setup(config: Record<string, unknown> = {}, saved: { distro: string; path: string } | null = { distro: 'Ubuntu-24.04', path: '/home/user/ninfer' }) {
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
  const updater = new NinferUpdater({ kind: 'ninfer-wsl', builder, where: () => adapter.where(), models: async () => models });
  const stages: string[] = [];
  const progress = (p: { stage: string }) => {
    if (stages[stages.length - 1] !== p.stage) stages.push(p.stage);
  };
  const fakeState = () => JSON.parse(readFileSync(path.join(state, 'config.json'), 'utf8')) as Record<string, unknown>;
  return { adapter, updater, stages, progress, old, fakeState };
}

const linux = (p: string) => (process.platform === 'win32' ? `/mnt/${p[0]?.toLowerCase()}/${p.slice(3).replace(/\\/g, '/')}` : p);
const run = (u: NinferUpdater, progress: (p: { stage: string }) => void) => u.update(progress, new AbortController().signal);

describe('NInfer update (fake WSL, real processes)', () => {
  it('reports an up-to-date checkout, the exact commands, and the artifacts the build cannot read', async () => {
    const { updater, old } = setup();
    const file = old.local.paths[0] as string;
    expect(await updater.status()).toEqual({
      kind: 'ninfer-wsl',
      distro: 'Ubuntu-24.04',
      dir: '/home/user/ninfer',
      updatable: true,
      fetched: true,
      current: OLD,
      upstream: 'origin/master',
      latest: OLD,
      behind: 0,
      ahead: 0,
      commits: [],
      dirty: [],
      commands: [`cp -p ${SERVE} ${SERVE}.gpubench-previous`, 'git -C /home/user/ninfer pull --ff-only', 'cmake --build /home/user/ninfer/build -j'],
      restore: [`mv -f ${SERVE}.gpubench-previous ${SERVE}`, `git -C /home/user/ninfer reset --hard ${OLD}`],
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
    });
  }, 60_000);

  it('pulls and rebuilds, then the build reports the new commit', async () => {
    const { adapter, updater, stages, progress, fakeState } = setup({ incoming: INCOMING });
    expect(await updater.status()).toMatchObject({ behind: 2, latest: INCOMING[0]?.sha, commits: INCOMING });
    expect((await adapter.detect()).version).toBe(OLD.slice(0, 12));
    expect(await run(updater, progress)).toEqual({ serve: SERVE, commit: INCOMING[0]?.sha });
    expect(stages).toEqual(['resolve', 'pull', 'build']);
    // The copy kept aside is gone; the probe is cached until forgotten.
    expect(fakeState()).toMatchObject({ kept: [], commit: INCOMING[0]?.sha, incoming: [] });
    expect((await adapter.detect()).version).toBe(OLD.slice(0, 12));
    adapter.forget();
    expect((await adapter.detect()).version).toBe(INCOMING[0]?.sha.slice(0, 12));
    expect(await updater.status()).toMatchObject({ behind: 0, current: INCOMING[0]?.sha });
    // Up to date: nothing runs.
    stages.length = 0;
    expect(await run(updater, progress)).toEqual({ serve: SERVE, commit: INCOMING[0]?.sha });
    expect(stages).toEqual(['resolve']);
  }, 60_000);

  it('puts the previous program and commit back when the build fails', async () => {
    const { updater, progress, fakeState } = setup({ incoming: INCOMING, failStage: 'build' });
    const err = (await run(updater, progress).catch((e: unknown) => e)) as AppError;
    expect(err.code).toBe('ENGINE_INSTALL_FAILED');
    expect(err.params).toMatchObject({ reason: 'ninfer_update', stage: 'build', restored: true, commit: OLD.slice(0, 12) });
    expect(err.detail).toContain('Unsupported gpu architecture');
    expect(fakeState()).toMatchObject({ kept: [], commit: OLD, incoming: INCOMING });
  }, 60_000);

  it('drops the kept copy when the pull fails', async () => {
    const { updater, progress, fakeState } = setup({ incoming: INCOMING, failStage: 'pull' });
    const err = (await run(updater, progress).catch((e: unknown) => e)) as AppError;
    expect(err.params).toMatchObject({ reason: 'ninfer_build', stage: 'pull' });
    expect(fakeState()).toMatchObject({ kept: [] });
  }, 60_000);

  it('refuses local changes, local commits, a build outside a checkout, and a build that is not set up', async () => {
    const dirty = setup({ incoming: INCOMING, dirty: ['src/serve/main.cpp'] });
    expect((await dirty.updater.status()).dirty).toEqual(['src/serve/main.cpp']);
    await expect(run(dirty.updater, dirty.progress)).rejects.toMatchObject({ params: { reason: 'ninfer_dirty', files: 'src/serve/main.cpp', dir: '/home/user/ninfer' } });
    const ahead = setup({ incoming: INCOMING, ahead: 1 });
    await expect(run(ahead.updater, ahead.progress)).rejects.toMatchObject({ params: { reason: 'ninfer_ahead', n: 1 } });
    const elsewhere = setup({ checkouts: [], builds: ['/opt/ninfer-serve'] }, { distro: 'Ubuntu-24.04', path: '/opt/ninfer-serve' });
    expect(await elsewhere.updater.status()).toMatchObject({ updatable: false, fetched: false, commands: [], restore: [], behind: 0 });
    await expect(run(elsewhere.updater, elsewhere.progress)).rejects.toMatchObject({ params: { reason: 'ninfer_not_checkout', path: '/opt/ninfer-serve' } });
    const none = setup({}, null);
    await expect(none.updater.status()).rejects.toMatchObject({ code: 'ENGINE_NOT_INSTALLED', params: { reason: 'not_configured' } });
  }, 60_000);

  it('says when GitHub could not be reached, and when the program cannot be kept aside', async () => {
    const offline = setup({ offline: true });
    expect(await offline.updater.status()).toMatchObject({ fetched: false, current: OLD });
    // The checkout is there but its build is not (removed by hand): nothing to keep, nothing changes.
    const gone = setup({ incoming: INCOMING, builds: [] });
    await expect(run(gone.updater, gone.progress)).rejects.toMatchObject({ params: { reason: 'ninfer_keep' } });
  }, 60_000);
});
