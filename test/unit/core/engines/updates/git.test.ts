import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildStep, findCheckout, gitState, gitUpdate, updateCommands } from '../../../../../src/core/engines/updates/git';
import { manualProcess, tempDir } from '../../docker/helpers';
import { checkoutOnDisk, fakeTools, played } from './fake-tools';

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups) c();
});
const disk = (o?: Parameters<typeof checkoutOnDisk>[0]) => {
  const c = checkoutOnDisk(o);
  cleanups.push(c.cleanup);
  return c;
};

describe('the checkout of a fork', () => {
  it('finds the build folder above the executable and the checkout of its sources', async () => {
    const c = disk();
    expect(await findCheckout(c.exe)).toEqual({ repo: c.repo, buildDir: c.build });
    // The folder that holds the executable works too.
    expect(await findCheckout(path.dirname(c.exe))).toEqual({ repo: c.repo, buildDir: c.build });
    expect(updateCommands({ repo: c.repo, buildDir: c.build })).toEqual([
      ['git', '-C', c.repo, 'pull', '--ff-only'],
      ['cmake', '--build', c.build, '-j'],
    ]);
  });

  it('Visual Studio builds: the configuration of the executable, else Release', async () => {
    const vs = disk({ multiConfig: true, exeDir: 'RelWithDebInfo' });
    expect(await findCheckout(vs.exe)).toEqual({ repo: vs.repo, buildDir: vs.build, config: 'RelWithDebInfo' });
    const flat = disk({ multiConfig: true });
    expect((await findCheckout(flat.exe))?.config).toBe('Release');
    expect(updateCommands({ repo: 'r', buildDir: 'b', config: 'Release' })[1]).toEqual(['cmake', '--build', 'b', '-j', '--config', 'Release']);
    // No Release among them: the first; an empty list: a single-configuration build.
    expect((await findCheckout(disk({ multiConfig: 'Debug;MinSizeRel' }).exe))?.config).toBe('Debug');
    expect(await findCheckout(disk({ multiConfig: ';' }).exe)).not.toHaveProperty('config');
  });

  it('a cache without its source folder: the build folder’s parent', async () => {
    const c = disk({ homeDirectory: false });
    expect(await findCheckout(c.exe)).toEqual({ repo: c.repo, buildDir: c.build });
  });

  it('no build folder, no checkout, no file: nothing to update from here', async () => {
    const t = tempDir('gb-upd-none-');
    cleanups.push(t.cleanup);
    const exe = path.join(t.dir, 'llama-server');
    writeFileSync(exe, '');
    expect(await findCheckout(exe)).toBeUndefined();
    expect(await findCheckout(path.join(t.dir, 'gone'))).toBeUndefined();
    // A CMake build whose sources are not in git.
    mkdirSync(path.join(t.dir, 'b', 'bin'), { recursive: true });
    writeFileSync(path.join(t.dir, 'b', 'CMakeCache.txt'), `CMAKE_HOME_DIRECTORY:INTERNAL=${t.dir}`);
    writeFileSync(path.join(t.dir, 'b', 'bin', 'llama-server'), '');
    expect(await findCheckout(path.join(t.dir, 'b', 'bin', 'llama-server'))).toBeUndefined();
  });
});

describe('git state', () => {
  it('behind its upstream, after a fetch', async () => {
    const tools = fakeTools({ behind: 3 });
    expect(await gitState(tools, '/r', { fetch: true })).toEqual({ kind: 'ready', branch: 'master', upstream: 'origin/master', head: 'a1b2c3d', upstreamHead: 'e4f5a6b', changed: 0, behind: 3, ahead: 0 });
    const fetch = tools.proc.calls.find((c) => c.args.includes('fetch'));
    expect(fetch?.args).toEqual(['-C', '/r', 'fetch', '--quiet']);
    // Never a password prompt in the background, English output.
    expect(fetch?.opts?.env).toEqual({ GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' });
  });

  it('missing git, a detached head, no upstream, uncommitted changes, a failed fetch', async () => {
    expect(await gitState(fakeTools({ missing: true }), '/r')).toEqual({ kind: 'missing' });
    expect(await gitState(fakeTools({ branch: 'HEAD' }), '/r')).toEqual({ kind: 'detached', head: 'a1b2c3d' });
    expect(await gitState(fakeTools({ upstream: null }), '/r')).toEqual({ kind: 'no-upstream', branch: 'master', head: 'a1b2c3d' });
    expect(await gitState(fakeTools({ changed: 2, ahead: 1 }), '/r')).toMatchObject({ changed: 2, ahead: 1 });
    expect(await gitState(fakeTools({ fetchFails: 'fatal: unable to access\nCould not resolve host' }), '/r', { fetch: true })).toMatchObject({ fetchError: 'fatal: unable to access\nCould not resolve host' });
    expect(await gitState(fakeTools({ fetchFails: ' ' }), '/r', { fetch: true })).toMatchObject({ fetchError: 'exit 128' });
  });

  it('a folder that is not a checkout any more is an error', async () => {
    const tools = fakeTools({});
    tools.proc.run = async () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository', timedOut: false });
    await expect(gitState(tools, '/r')).rejects.toMatchObject({ code: 'ENGINE_UPDATE_FAILED', params: { reason: 'git' } });
  });
});

describe('the update', () => {
  const run = async (tools: ReturnType<typeof fakeTools>, signal = new AbortController().signal) => {
    const seen: unknown[] = [];
    await gitUpdate(tools, { repo: '/r', buildDir: '/r/build', config: 'Release' }, (p) => seen.push(p), signal);
    return seen;
  };

  it('pulls, then builds with the build’s progress', async () => {
    const tools = fakeTools({ behind: 2, build: { lines: ['-- Configuring done', '[ 45%] Building CXX object a.o', '[12/345] Building CXX object b.o', '[100%] Linking'], code: 0 } });
    expect(await run(tools)).toEqual([{ stage: 'git-pull' }, { stage: 'build' }, { stage: 'build', step: 45, steps: 100 }, { stage: 'build', step: 12, steps: 345 }, { stage: 'build', step: 100, steps: 100 }]);
    expect(tools.proc.spawns.map((s) => [s.cmd, ...s.args])).toEqual([
      ['git', '-C', '/r', 'pull', '--ff-only'],
      ['cmake', '--build', '/r/build', '-j', '--config', 'Release'],
    ]);
    expect(tools.proc.spawns[0]?.owner).toEqual({ runId: 'engine-update', marker: 'engine-update' });
  });

  it('never touches a checkout with uncommitted changes', async () => {
    const tools = fakeTools({ changed: 1 });
    await expect(run(tools)).rejects.toMatchObject({ code: 'ENGINE_UPDATE_FAILED', params: { reason: 'dirty', changed: 1 } });
    expect(tools.proc.spawns).toEqual([]);
  });

  it('a pull that fails, a build that fails, a missing cmake, a cancel', async () => {
    await expect(run(fakeTools({ pull: { lines: ['fatal: Not possible to fast-forward, aborting.'], code: 128 } }))).rejects.toMatchObject({
      code: 'ENGINE_UPDATE_FAILED',
      params: { reason: 'git', code: '128' },
      detail: 'fatal: Not possible to fast-forward, aborting.',
    });
    await expect(run(fakeTools({ build: { lines: ['error: undefined reference'], code: 2 } }))).rejects.toMatchObject({ params: { reason: 'cmake' } });
    await expect(run(fakeTools({ cmakeMissing: true }))).rejects.toMatchObject({ params: { reason: 'cmake-missing' } });
    await expect(run(fakeTools({ build: { lines: Array.from({ length: 40 }, (_, i) => `line ${i}`), code: null } }))).rejects.toMatchObject({ params: { reason: 'cmake', code: 'null' } });
    const ac = new AbortController();
    const tools = fakeTools({});
    tools.proc.spawn = (spec) => {
      tools.proc.spawns.push(spec);
      ac.abort();
      return played([], 1);
    };
    await expect(run(tools, ac.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    // Cancelled while it runs: the tool is stopped.
    const live = new AbortController();
    const slow = fakeTools({});
    const mp = manualProcess();
    slow.proc.spawn = () => mp;
    const pending = run(slow, live.signal);
    await new Promise((r) => setTimeout(r, 0));
    live.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(mp.stopped()).toBe(1);
  });

  it('reads Ninja and Make progress lines', () => {
    expect(buildStep('[3/10] Building')).toEqual({ step: 3, steps: 10 });
    expect(buildStep('  [ 7%] Building')).toEqual({ step: 7, steps: 100 });
    expect(buildStep('Building')).toBeUndefined();
  });
});
