/**
 * The guided build: prerequisites and commands (read-only checks), the CUDA it needs and the compiler it
 * picks, then the confirmed steps with progress, in a fake WSL distro (real processes) and on Linux
 * (scripted processes); a failed step says why in plain words and keeps its whole output in a log.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AppError } from '../../../../../src/contract/errors';
import { buildEtaSec, buildProgress, buildSteps, cudaChoice, NinferBuilder, parsePrereqs, readBuildFailure, shellLine, versionAtLeast } from '../../../../../src/core/engines/ninfer/build';
import { WslProcesses } from '../../../../../src/core/engines/ninfer/wsl';
import { systemClock } from '../../../../../src/core/node-deps';
import { fail, manualProcess, ok, scriptedProc, tempDir } from '../../docker/helpers';
import { realProc, WSL_ARGV } from './helpers';

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups) c();
});

const ALL = { url: 'https://github.com/iamwavecut/ninfer-all.git', branch: 'master' };

const PREREQS = [
  '##home /home/user',
  '##git git version 2.43.0',
  '##cmake cmake version 3.28.3',
  '##ninja 1.11.1',
  '##compiler g++ (Ubuntu 13.3.0-6ubuntu2~24.04) 13.3.0',
  '##pkg-config 1.8.1',
  '##nvcc /usr/local/cuda-13.1/bin/nvcc release 13.1',
  '##apt-cuda ',
  '##driver-cuda CUDA Version: 13.4',
  '##ffmpeg 60.16.100 60.31.102 58.29.100 7.5.100 ',
  '##curl 8.5.0',
  '##cpus 16',
  '##checkout yes',
  '##origin https://github.com/Neroued/ninfer.git',
  '##exists yes',
  '##empty ',
  '##cmake-cuda ',
  '##cache ',
  '##cache-nvcc ',
  '##configured ',
].join('\n');

describe('prerequisites and commands', () => {
  it('compares versions', () => {
    expect(versionAtLeast('3.28.3', '3.28')).toBe(true);
    expect(versionAtLeast('3.27.9', '3.28')).toBe(false);
    expect(versionAtLeast('13', '12.8')).toBe(true);
    expect(versionAtLeast('12', '12.8')).toBe(false);
  });

  it('reads the prerequisite script: every CUDA compiler, what apt offers, what an earlier configure left', () => {
    const r = parsePrereqs(
      [
        PREREQS,
        // The same compiler reached twice (/usr/local/cuda points to it): listed once.
        '##nvcc /usr/local/cuda-13.1/bin/nvcc release 13.1',
        '##nvcc /usr/local/cuda-13.0/bin/nvcc release 13.0',
        '##nvcc /opt/odd/nvcc',
        '##apt-cuda cuda-toolkit-13-1 cuda-toolkit-13-3 cuda-toolkit-config-common',
        '##cmake-cuda 13.1',
        '##cache yes',
        '##cache-nvcc /usr/local/cuda/bin/nvcc',
      ].join('\n'),
    );
    expect(r).toMatchObject({
      home: '/home/user',
      checkout: true,
      origin: 'https://github.com/Neroued/ninfer.git',
      cpus: 16,
      driverCuda: '13.4',
      cmakeCuda: '13.1',
      exists: true,
      empty: false,
      cache: true,
      cacheNvcc: '/usr/local/cuda/bin/nvcc',
      configured: false,
    });
    expect(r.nvccs).toEqual([
      { path: '/usr/local/cuda-13.1/bin/nvcc', version: '13.1' },
      { path: '/usr/local/cuda-13.0/bin/nvcc', version: '13.0' },
    ]);
    expect(r.aptCuda).toEqual(['cuda-toolkit-13-1', 'cuda-toolkit-13-3']);
    expect(r.prereqs.every((p) => p.found)).toBe(true);
    expect(r.prereqs.map((p) => p.id)).toEqual(['git', 'cmake', 'ninja', 'compiler', 'pkg-config', 'ffmpeg', 'curl']);
    // Too old, missing, an incomplete FFmpeg; no home = the environment did not answer.
    const bad = parsePrereqs('##cmake cmake version 3.22.1\n##ffmpeg 60.16.100 60.31.102\n##git \n##cpus none\n##driver-cuda \n');
    expect(bad).toMatchObject({ checkout: false, exists: false, empty: false, cache: false, configured: false, nvccs: [], aptCuda: [] });
    expect(bad.home).toBeUndefined();
    expect(bad.cpus).toBeUndefined();
    expect(bad.driverCuda).toBeUndefined();
    expect(bad.prereqs.filter((p) => !p.found).map((p) => p.id)).toEqual(['git', 'cmake', 'ninja', 'compiler', 'pkg-config', 'ffmpeg', 'curl']);
    expect(bad.prereqs.find((p) => p.id === 'cmake')).toMatchObject({ version: '3.22.1', need: '3.28' });
  });

  it('picks the newest CUDA compiler new enough; when none is, the toolkit apt offers', () => {
    const nvccs = [{ path: '/usr/local/cuda-13.0/bin/nvcc', version: '13.0' }];
    const apt = ['cuda-toolkit-13-1', 'cuda-toolkit-13-2', 'cuda-toolkit-13-3'];
    // The official NInfer builds with CUDA 13.0.
    expect(cudaChoice({ nvccs, aptCuda: apt, driverCuda: '13.4' }, false)).toEqual({ need: '12.8', found: true, have: '13.0', nvcc: '/usr/local/cuda-13.0/bin/nvcc', driver: '13.4' });
    // NInfer-all asks 13.1 for sm_120a: the user's 13.0 is not enough; apt's newest 13.x the driver runs is offered.
    expect(cudaChoice({ nvccs, aptCuda: apt, driverCuda: '13.4' }, true)).toEqual({ need: '13.1', found: false, have: '13.0', package: 'cuda-toolkit-13-3', driver: '13.4', allNeeds: true });
    // A driver for 13.2 at most; no driver said; only a newer major release; nothing offered at all.
    expect(cudaChoice({ nvccs, aptCuda: apt, driverCuda: '13.2' }, true).package).toBe('cuda-toolkit-13-2');
    expect(cudaChoice({ nvccs, aptCuda: ['cuda-toolkit-14-1', 'cuda-toolkit-14-0'] }, true)).toMatchObject({ package: 'cuda-toolkit-14-0' });
    expect(cudaChoice({ nvccs: [], aptCuda: [] }, true)).toEqual({ need: '13.1', found: false, allNeeds: true });
    // 13.3 installed next to 13.0: the newest one, by its own path (not /usr/local/cuda, which still points to 13.0).
    const both = [...nvccs, { path: '/usr/local/cuda-13.3/bin/nvcc', version: '13.3' }];
    expect(cudaChoice({ nvccs: both, aptCuda: apt }, true)).toMatchObject({ found: true, have: '13.3', nvcc: '/usr/local/cuda-13.3/bin/nvcc' });
    // A checkout's own CMakeLists.txt check wins (higher than what LLM Bench knows).
    expect(cudaChoice({ nvccs: both, aptCuda: [], cmakeCuda: '13.4' }, false)).toEqual({ need: '13.4', found: false, have: '13.3' });
  });

  it('builds the exact steps', () => {
    expect(buildSteps('/home/u/ninfer', { existing: false, nvcc: '/usr/local/cuda-13.1/bin/nvcc' }).map((s) => [s.stage, s.argv.join(' ')])).toEqual([
      ['clone', 'git clone --progress https://github.com/Neroued/ninfer.git /home/u/ninfer'],
      ['configure', 'cmake -S /home/u/ninfer -B /home/u/ninfer/build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_CUDA_ARCHITECTURES=120a -DCMAKE_CUDA_COMPILER=/usr/local/cuda-13.1/bin/nvcc'],
      ['build', 'cmake --build /home/u/ninfer/build -j'],
    ]);
    // A checkout whose earlier configure stopped: its CMake cache (only that) goes first.
    expect(buildSteps('/n', { existing: true, nvcc: '/usr/bin/nvcc', clearCache: true, source: ALL }).map((s) => [s.stage, s.argv.join(' ')])).toEqual([
      ['configure', 'rm -rf -- /n/build/CMakeCache.txt /n/build/CMakeFiles'],
      ['configure', 'cmake -S /n -B /n/build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_CUDA_ARCHITECTURES=120a -DCMAKE_CUDA_COMPILER=/usr/bin/nvcc'],
      ['build', 'cmake --build /n/build -j'],
    ]);
    expect(buildSteps('/n', { existing: false, source: ALL })[0]?.argv).toEqual(['git', 'clone', '--progress', '--branch', 'master', ALL.url, '/n']);
    expect(buildSteps('/n', { existing: true }).find((s) => s.stage === 'configure')?.argv.some((a) => a.startsWith('-DCMAKE_CUDA_COMPILER'))).toBe(false);
  });

  it('quotes words for a shell only when needed', () => {
    expect(shellLine(['cd', '/home/u/my models', "it's", 'a=b,c'])).toBe(String.raw`cd '/home/u/my models' 'it'\''s' a=b,c`);
  });

  it('reads progress from ninja and git', () => {
    expect(buildProgress('[12/345] Building CUDA object src/a.cu.o')).toEqual({ done: 12, total: 345 });
    expect(buildProgress('Receiving objects:  45% (540/1200)')).toEqual({ done: 45, total: 100 });
    expect(buildProgress('-- Configuring done')).toBeUndefined();
    // Time left from the pace so far: 100 of 811 steps in 3 minutes → about 21 minutes for the rest; not before 20 s, nor after 2 steps.
    expect(buildEtaSec({ at: 0, step: 1 }, 180_000, 101, 811)).toBe(1278);
    expect(buildEtaSec({ at: 0, step: 1 }, 10_000, 101, 811)).toBeUndefined();
    expect(buildEtaSec({ at: 0, step: 1 }, 180_000, 3, 811)).toBeUndefined();
  });

  it('reads what a failed step said, in a few known shapes', () => {
    const read = (text: string) => readBuildFailure(text.split('\n'));
    expect(read('CMake Error at CMakeLists.txt:36 (message):\n  A 120a build needs CUDA 13.1 or newer; CUDA 13.0.88 miscompiles sm_120a')).toEqual({ reading: 'cuda-too-old', params: { need: '13.1', have: '13.0.88' } });
    expect(read("nvcc fatal   : Unsupported gpu architecture 'compute_120a'")).toEqual({ reading: 'cuda-too-old', params: {} });
    expect(read('c++: fatal error: Killed signal terminated program cc1plus')?.reading).toBe('out-of-memory');
    expect(read('fatal error: error writing to /tmp/x.s: No space left on device')?.reading).toBe('disk-full');
    expect(read("fatal: unable to access 'https://github.com/a/b.git/': Could not resolve host: github.com")?.reading).toBe('no-network');
    expect(read('error: Your local changes to the following files would be overwritten by merge:')?.reading).toBe('local-changes');
    expect(read('fatal: Not possible to fast-forward, aborting.')?.reading).toBe('diverged');
    expect(read("fatal: destination path '/x' already exists and is not an empty directory.")?.reading).toBe('not-empty');
    expect(read('CMake 3.28 or higher is required.  You are running version 3.22.1')).toEqual({ reading: 'cmake-too-old', params: { need: '3.28' } });
    expect(read('  Could not find FFmpeg (missing: libavformat)')).toEqual({ reading: 'missing-package', params: { what: 'FFmpeg' } });
    expect(read('  Could NOT find CURL (missing: CURL_LIBRARY)')).toEqual({ reading: 'missing-package', params: { what: 'CURL' } });
    expect(read("Package libavformat was not found\nNo package 'libavformat' found")).toEqual({ reading: 'missing-package', params: { what: 'libavformat' } });
    expect(read('src/a.cpp:1:10: fatal error: curl/curl.h: No such file or directory')).toEqual({ reading: 'missing-package', params: { what: 'curl/curl.h' } });
    expect(read('-- No CMAKE_CUDA_COMPILER could be found.')).toEqual({ reading: 'missing-package', params: { what: 'CMAKE_CUDA_COMPILER' } });
    expect(read('something else went wrong')).toBeUndefined();
  });
});

function wslBuilder(config: Record<string, unknown> = {}, logDir?: string, extra: { logLines?: number; etaAfterMs?: number } = {}) {
  const t = tempDir('gb-ninfer-build-');
  cleanups.push(t.cleanup);
  const proc = realProc(path.join(t.dir, 'wsl'), { FAKE_WSL_CONFIG: JSON.stringify({ stepMs: 5, ...config }) });
  const processes = new WslProcesses({ proc, wsl: WSL_ARGV, file: path.join(t.dir, 'ninfer-wsl.json'), sleep: (ms) => systemClock.sleep(ms), graceMs: 2000 });
  let n = 0;
  return new NinferBuilder({ kind: 'ninfer-wsl', proc, wsl: { argv: WSL_ARGV, processes }, newMarker: () => `gpubench-build-${++n}`, ...(logDir ? { logDir } : {}), ...extra });
}

const steps = () => {
  const seen: string[] = [];
  const progress = (p: { stage: string; bytesDone: number; bytesTotal?: number }) => {
    if (seen[seen.length - 1] !== p.stage) seen.push(p.stage);
  };
  return { seen, progress };
};

const signal = () => new AbortController().signal;

describe('the guided build in a WSL distro', () => {
  it('plans in place over an existing checkout, or with a clone; lists what is missing with its apt line', async () => {
    const b = wslBuilder();
    expect(await b.plan({ kind: 'ninfer-wsl', distro: 'Ubuntu-24.04' })).toMatchObject({
      kind: 'ninfer-wsl',
      distro: 'Ubuntu-24.04',
      dir: '/home/user/ninfer',
      servePath: '/home/user/ninfer/build/apps/ninfer-serve',
      existing: true,
      commands: [
        'cmake -S /home/user/ninfer -B /home/user/ninfer/build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_CUDA_ARCHITECTURES=120a -DCMAKE_CUDA_COMPILER=/usr/local/cuda-13.1/bin/nvcc',
        'cmake --build /home/user/ninfer/build -j',
        'git -C /home/user/ninfer rev-parse HEAD > /home/user/ninfer/build/.llmbench-built-commit',
      ],
      cudaFromNvidia: false,
      cuda: { need: '12.8', have: '13.1', nvcc: '/usr/local/cuda-13.1/bin/nvcc', driver: '13.4' },
      ready: true,
    });
    const missing = wslBuilder({ prereqs: { ninja: '' }, nvccs: [] });
    const plan = await missing.plan({ kind: 'ninfer-wsl', distro: 'Ubuntu-24.04', dir: '~/src/ninfer/' });
    expect(plan).toMatchObject({ dir: '/home/user/src/ninfer', existing: false, aptCommand: 'sudo apt install ninja-build', cudaFromNvidia: true, ready: false });
    expect(plan.prereqs.find((p) => p.id === 'cuda')).toEqual({ id: 'cuda', found: false, need: '12.8', packages: ['cuda-toolkit-12-8'] });
    expect(plan.commands[0]).toBe('git clone --progress https://github.com/Neroued/ninfer.git /home/user/src/ninfer');
    await expect(missing.build({ kind: 'ninfer-wsl', distro: 'Ubuntu-24.04' }, () => undefined, signal())).rejects.toMatchObject({
      code: 'ENGINE_INSTALL_FAILED',
      params: { reason: 'ninfer_prereqs', missing: 'ninja,cuda', cudaNeed: '12.8' },
    });
    // CUDA fine, Ninja missing: only Ninja is named.
    const noNinja = (await wslBuilder({ prereqs: { ninja: '' } }).build({ kind: 'ninfer-wsl', distro: 'Ubuntu-24.04' }, () => undefined, signal()).catch((e: unknown) => e)) as AppError;
    expect(noNinja.params).toEqual({ reason: 'ninfer_prereqs', missing: 'ninja' });
  }, 60_000);

  it("NInfer-all with CUDA 13.0 (the user's distro): refused before anything runs, with the toolkit apt offers; built once 13.3 is there", async () => {
    // ~/ninfer-all cloned, its configure stopped by NInfer-all's own CUDA check: build/ holds only CMake's cache.
    const user = {
      checkouts: ['/home/user/ninfer', '/home/user/ninfer-all'],
      origins: { '/home/user/ninfer-all': ALL.url },
      nvccs: [{ path: '/usr/local/cuda-13.0/bin/nvcc', version: '13.0' }],
      aptCuda: ['cuda-toolkit-13-1', 'cuda-toolkit-13-2', 'cuda-toolkit-13-3'],
      caches: { '/home/user/ninfer-all': { nvcc: '/usr/local/cuda/bin/nvcc', configured: false } },
    };
    const req = { kind: 'ninfer-wsl' as const, distro: 'Ubuntu-24.04', build: 'all' as const, dir: '~/ninfer-all', source: ALL, variant: { template: 'ninfer-all', name: 'NInfer-all' } };
    const before = await wslBuilder(user).plan(req);
    expect(before).toMatchObject({
      existing: true,
      ready: false,
      aptCommand: 'sudo apt install cuda-toolkit-13-3',
      cudaFromNvidia: false,
      clearCache: true,
      cuda: { need: '13.1', have: '13.0', package: 'cuda-toolkit-13-3', driver: '13.4', allNeeds: true },
    });
    expect(before.prereqs.find((p) => p.id === 'cuda')).toEqual({ id: 'cuda', found: false, version: '13.0', need: '13.1', packages: ['cuda-toolkit-13-3'] });

    // Without LLM Bench's check, CMake itself refuses: the reading says CUDA is too old, the log keeps the whole output.
    const logs = tempDir('gb-ninfer-logs-');
    cleanups.push(logs.cleanup);
    const raw = wslBuilder(user, logs.dir);
    const log: string[] = [];
    const refused = (await raw
      .step('configure', ['cmake', '-S', '/home/user/ninfer-all', '-B', '/home/user/ninfer-all/build', '-G', 'Ninja', '-DCMAKE_CUDA_ARCHITECTURES=120a', '-DCMAKE_CUDA_COMPILER=/usr/local/cuda-13.0/bin/nvcc'], 'Ubuntu-24.04', () => undefined, signal(), log)
      .catch((e: unknown) => e)) as AppError;
    expect(refused).toMatchObject({ code: 'ENGINE_INSTALL_FAILED', params: { reason: 'ninfer_build', stage: 'configure', code: '1', reading: 'cuda-too-old', need: '13.1', have: '13.0.88' } });
    expect(refused.detail).toContain('A 120a build needs CUDA 13.1 or newer');
    const withLog = (await raw.withLog(refused, log, 'build')) as AppError;
    expect(withLog.params?.log).toMatch(/ninfer-build-.*\.log$/);
    expect(readFileSync(String(withLog.params?.log), 'utf8')).toBe(`${log.join('\n')}\n`);
    expect(log[0]).toBe('$ cmake -S /home/user/ninfer-all -B /home/user/ninfer-all/build -G Ninja -DCMAKE_CUDA_ARCHITECTURES=120a -DCMAKE_CUDA_COMPILER=/usr/local/cuda-13.0/bin/nvcc');
    // A log keeps its newest lines only (here 3; 50,000 in the app).
    const short: string[] = [];
    await wslBuilder(user, logs.dir, { logLines: 3 })
      .step('configure', ['cmake', '-S', '/home/user/ninfer-all', '-B', '/home/user/ninfer-all/build', '-G', 'Ninja'], 'Ubuntu-24.04', () => undefined, signal(), short)
      .catch(() => undefined);
    expect(short).toHaveLength(3);
    // An error without output of its own keeps having none.
    const bare = (await raw.withLog(new AppError('ENGINE_INSTALL_FAILED', 'x'), ['a line'], 'update')) as AppError;
    expect(bare.params?.log).toMatch(/ninfer-update-.*\.log$/);
    expect(bare.detail).toBeUndefined();

    // `sudo apt install cuda-toolkit-13-3`: the 13.3 compiler is picked by its own path, the old cache cleared, the build done in place.
    // (Its time left is said from its first steps here: at once.)
    const fixed = wslBuilder({ ...user, nvccs: [...user.nvccs, { path: '/usr/local/cuda-13.3/bin/nvcc', version: '13.3' }] }, undefined, { etaAfterMs: 0 });
    const after = await fixed.plan(req);
    expect(after).toMatchObject({ existing: true, ready: true, clearCache: true, cuda: { nvcc: '/usr/local/cuda-13.3/bin/nvcc', have: '13.3' } });
    expect(after.aptCommand).toBeUndefined();
    expect(after.commands.slice(0, 2)).toEqual([
      'rm -rf -- /home/user/ninfer-all/build/CMakeCache.txt /home/user/ninfer-all/build/CMakeFiles',
      'cmake -S /home/user/ninfer-all -B /home/user/ninfer-all/build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_CUDA_ARCHITECTURES=120a -DCMAKE_CUDA_COMPILER=/usr/local/cuda-13.3/bin/nvcc',
    ]);
    const { seen, progress } = steps();
    const etas: number[] = [];
    const sink = (p: { stage: string; bytesDone: number; bytesTotal?: number; etaSec?: number }) => {
      if (p.etaSec !== undefined) etas.push(p.etaSec);
      progress(p);
    };
    expect(await fixed.build(req, sink, signal())).toBe('/home/user/ninfer-all/build/apps/ninfer-serve');
    expect(seen).toEqual(['configure', 'build']);
    // Three steps after the first one seen: its time left ("[4/4]": none).
    expect(etas).toEqual([0]);
    // Configured with the new compiler, and the commit it was built from recorded: built again later, nothing to clear.
    const again = await fixed.plan(req);
    expect(again).toMatchObject({ ready: true });
    expect(again.clearCache).toBeUndefined();
  }, 90_000);

  it('a folder with other files is never cloned into; an empty one is', async () => {
    const b = wslBuilder({ folders: { '/home/user/stuff': 'files', '/home/user/empty': 'empty' } });
    expect(await b.plan({ kind: 'ninfer-wsl', distro: 'Ubuntu-24.04', dir: '~/stuff' })).toMatchObject({ existing: false, notEmpty: true, ready: false });
    await expect(b.build({ kind: 'ninfer-wsl', distro: 'Ubuntu-24.04', dir: '~/stuff' }, () => undefined, signal())).rejects.toMatchObject({ params: { reason: 'ninfer_dir_not_empty', dir: '/home/user/stuff' } });
    const empty = await b.plan({ kind: 'ninfer-wsl', distro: 'Ubuntu-24.04', dir: '~/empty' });
    expect(empty).toMatchObject({ existing: false, ready: true });
    expect(empty.notEmpty).toBeUndefined();
  }, 60_000);

  it('refuses a relative folder, a missing distro, and an environment that does not answer', async () => {
    const b = wslBuilder();
    await expect(b.plan({ kind: 'ninfer-wsl', distro: 'Ubuntu-24.04', dir: 'ninfer' })).rejects.toMatchObject({ code: 'VALIDATION', params: { reason: 'ninfer_dir', dir: 'ninfer' } });
    await expect(b.plan({ kind: 'ninfer-wsl' })).rejects.toMatchObject({ code: 'VALIDATION', params: { reason: 'distro_missing' } });
    await expect(b.plan({ kind: 'ninfer-wsl', distro: 'Debian' })).rejects.toMatchObject({ code: 'ENGINE_INSTALL_FAILED', params: { reason: 'ninfer_prereqs' } });
  }, 60_000);

  it('clones, configures and builds with progress, records the commit it built, then gives the program', async () => {
    const b = wslBuilder();
    const { seen, progress } = steps();
    expect(await b.build({ kind: 'ninfer-wsl', distro: 'Ubuntu-24.04', dir: '~/fresh' }, progress, signal())).toBe('/home/user/fresh/build/apps/ninfer-serve');
    expect(seen).toEqual(['clone', 'configure', 'build']);
    expect(await b.record('/home/user/fresh', 'Ubuntu-24.04')).toBe(true);
    expect(await b.record('/home/user/nowhere', 'Ubuntu-24.04')).toBe(false);
  }, 60_000);

  it('stops at the failing step with its last lines, what they say, and the whole output in a log', async () => {
    const logs = tempDir('gb-ninfer-logs-');
    cleanups.push(logs.cleanup);
    const configure = wslBuilder({ failStage: 'configure' }, logs.dir);
    const err = (await configure.build({ kind: 'ninfer-wsl', distro: 'Ubuntu-24.04' }, () => undefined, signal()).catch((e: unknown) => e)) as AppError;
    expect(err).toMatchObject({ code: 'ENGINE_INSTALL_FAILED', params: { reason: 'ninfer_build', stage: 'configure', code: '1', reading: 'missing-package', what: 'FFmpeg' } });
    expect(err.detail).toContain('Could not find FFmpeg');
    const file = String(err.params?.log);
    expect(readFileSync(file, 'utf8')).toContain('$ cmake -S /home/user/ninfer');
    // No network for the clone; the compile killed for memory.
    const clone = (await wslBuilder({ failStage: 'clone' }).build({ kind: 'ninfer-wsl', distro: 'Ubuntu-24.04', dir: '~/x' }, () => undefined, signal()).catch((e: unknown) => e)) as AppError;
    expect(clone.params).toMatchObject({ stage: 'clone', reading: 'no-network' });
    expect(clone.params?.log).toBeUndefined();
    const oom = (await wslBuilder({ failStage: 'build', failWith: 'oom' }).build({ kind: 'ninfer-wsl', distro: 'Ubuntu-24.04' }, () => undefined, signal()).catch((e: unknown) => e)) as AppError;
    expect(oom.params).toMatchObject({ stage: 'build', reading: 'out-of-memory' });
  }, 60_000);

  it('a cancel stops the compile (its own session, checked as ours)', async () => {
    const b = wslBuilder({ stepMs: 400 });
    const ac = new AbortController();
    const done = b.build({ kind: 'ninfer-wsl', distro: 'Ubuntu-24.04' }, (p) => p.stage === 'build' && p.bytesDone === 1 && ac.abort(), ac.signal);
    await expect(done).rejects.toMatchObject({ code: 'CANCELLED' });
    const before = new AbortController();
    before.abort();
    await expect(b.build({ kind: 'ninfer-wsl', distro: 'Ubuntu-24.04' }, () => undefined, before.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
  }, 60_000);
});

describe('the log of a failed build', () => {
  it('is written only for a real failure with output, and never stands in the way', async () => {
    const logs = tempDir('gb-ninfer-logs-');
    cleanups.push(logs.cleanup);
    const b = new NinferBuilder({ kind: 'ninfer-native', proc: scriptedProc(() => ok()), newMarker: () => 'x', logDir: path.join(logs.dir, 'logs') });
    const failure = new AppError('ENGINE_INSTALL_FAILED', 'NInfer build failed', { params: { stage: 'build' }, detail: 'last' });
    const plain = new Error('plain');
    expect(await b.withLog(plain, ['a'], 'build')).toBe(plain);
    const cancelled = new AppError('CANCELLED', 'Build cancelled');
    expect(await b.withLog(cancelled, ['a'], 'build')).toBe(cancelled);
    expect(await b.withLog(failure, [], 'build')).toBe(failure);
    const logged = (await b.withLog(failure, ['line 1', 'line 2'], 'update')) as AppError;
    expect(logged).toMatchObject({ code: 'ENGINE_INSTALL_FAILED', detail: 'last', params: { stage: 'build' } });
    expect(String(logged.params?.log)).toMatch(/ninfer-update-.*\.log$/);
    expect(existsSync(String(logged.params?.log))).toBe(true);
    // A folder that cannot be made (a file is in the way): the error as it was. No log folder at all: the same.
    const blocker = path.join(logs.dir, 'file');
    writeFileSync(blocker, 'x');
    const blocked = new NinferBuilder({ kind: 'ninfer-native', proc: scriptedProc(() => ok()), newMarker: () => 'x', logDir: path.join(blocker, 'logs') });
    expect(await blocked.withLog(failure, ['a'], 'build')).toBe(failure);
    const none = new NinferBuilder({ kind: 'ninfer-native', proc: scriptedProc(() => ok()), newMarker: () => 'x' });
    expect(await none.withLog(failure, ['a'], 'build')).toBe(failure);
  });
});

describe('a cancelled build in WSL whose process check fails', () => {
  it('still stops the relay', async () => {
    const mp = manualProcess();
    const proc = scriptedProc(
      () => ok(PREREQS),
      () => {
        setTimeout(() => mp.push('gpubench-pid 55'), 5);
        return mp;
      },
    );
    const processes = { stop: () => Promise.reject(new Error('wsl.exe is gone')) } as unknown as WslProcesses;
    const b = new NinferBuilder({ kind: 'ninfer-wsl', proc, wsl: { argv: ['wsl.exe'], processes }, newMarker: () => 'gpubench-c-1' });
    const ac = new AbortController();
    const run = b.build({ kind: 'ninfer-wsl', distro: 'Ubuntu' }, () => undefined, ac.signal);
    setTimeout(() => ac.abort(), 30);
    await expect(run).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(mp.stopped()).toBe(1);
    // Every step runs with git told never to ask for a password (there is no terminal).
    expect(proc.spawns[0]?.args).toEqual(expect.arrayContaining(['GPUBENCH_OWNER=gpubench-c-1', 'GIT_TERMINAL_PROMPT=0', 'setsid', '-w']));
  });
});

describe('the guided build on Linux', () => {
  it('runs the steps directly, and says when a program cannot start', async () => {
    const spawned: string[] = [];
    const proc = scriptedProc(
      () => ok(`${PREREQS.replace('##checkout yes', '##checkout ').replace('##exists yes', '##exists ')}\n`),
      (spec) => {
        spawned.push([spec.cmd, ...spec.args].join(' '));
        if (spec.cmd === 'cmake' && spec.args[0] === '--build') throw new Error('ENOENT');
        const mp = manualProcess();
        setTimeout(() => {
          mp.push('[1/2] Building CUDA object a.cu.o');
          // A chatty configure: only the last lines are kept for the error.
          if (spec.args[0] === '-S') for (let i = 0; i < 70; i++) mp.push(`-- line ${i}`);
          mp.exit({ code: 0, signal: null });
        }, 5);
        return mp;
      },
    );
    const b = new NinferBuilder({ kind: 'ninfer-native', proc, newMarker: () => 'gpubench-native-1' });
    const err = (await b.build({ kind: 'ninfer-native', dir: '/opt/ninfer' }, () => undefined, signal()).catch((e: unknown) => e)) as AppError;
    expect(err).toMatchObject({ code: 'ENGINE_INSTALL_FAILED', params: { reason: 'ninfer_build', stage: 'build' } });
    expect(spawned).toEqual([
      'git clone --progress https://github.com/Neroued/ninfer.git /opt/ninfer',
      'cmake -S /opt/ninfer -B /opt/ninfer/build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_CUDA_ARCHITECTURES=120a -DCMAKE_CUDA_COMPILER=/usr/local/cuda-13.1/bin/nvcc',
      'cmake --build /opt/ninfer/build -j',
    ]);
    expect(proc.spawns[0]?.env).toEqual({ GIT_TERMINAL_PROMPT: '0' });
    expect(proc.calls[0]).toMatchObject({ cmd: '/bin/sh', args: ['-c', expect.stringContaining('##home'), 'sh', '/opt/ninfer'] });
  });

  it('a failing step keeps its last 20 lines', async () => {
    const proc = scriptedProc(
      () => ok(PREREQS),
      () => {
        const mp = manualProcess();
        setTimeout(() => {
          for (let i = 0; i < 70; i++) mp.push(`-- line ${i}`);
          mp.exit({ code: 1, signal: null });
        }, 5);
        return mp;
      },
    );
    const err = (await new NinferBuilder({ kind: 'ninfer-native', proc, newMarker: () => 'n' }).build({ kind: 'ninfer-native' }, () => undefined, signal()).catch((e: unknown) => e)) as AppError;
    expect(err.detail?.split('\n')).toHaveLength(20);
    expect(err.detail?.split('\n')[0]).toBe('-- line 50');
    expect(err.params?.reading).toBeUndefined();
  });

  it('cancels a native step by stopping its process', async () => {
    const proc = scriptedProc(
      () => ok(PREREQS),
      () => manualProcess(),
    );
    const b = new NinferBuilder({ kind: 'ninfer-native', proc, newMarker: () => 'gpubench-native-2' });
    const ac = new AbortController();
    const run = b.build({ kind: 'ninfer-native' }, () => undefined, ac.signal);
    setTimeout(() => ac.abort(), 20);
    await expect(run).rejects.toMatchObject({ code: 'CANCELLED' });
    // Killed by a signal: the signal is the code.
    const killed = new NinferBuilder({
      kind: 'ninfer-native',
      proc: scriptedProc(
        () => ok(PREREQS),
        () => {
          const mp = manualProcess();
          setTimeout(() => mp.exit({ code: null, signal: 'SIGKILL' }), 5);
          return mp;
        },
      ),
      newMarker: () => 'gpubench-native-3',
    });
    await expect(killed.build({ kind: 'ninfer-native' }, () => undefined, signal())).rejects.toMatchObject({ params: { stage: 'configure', code: 'SIGKILL' } });
    const failing = new NinferBuilder({ kind: 'ninfer-native', proc: scriptedProc(() => fail(127, 'sh: not found')), newMarker: () => 'x' });
    await expect(failing.plan({ kind: 'ninfer-native' })).rejects.toMatchObject({ params: { reason: 'ninfer_prereqs' } });
  });
});
