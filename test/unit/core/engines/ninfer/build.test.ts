/**
 * The guided build: prerequisites and commands (read-only checks), then the confirmed steps with
 * progress, in a fake WSL distro (real processes) and on Linux (scripted processes).
 */
import { afterAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import type { AppError } from '../../../../../src/contract/errors';
import { buildProgress, buildSteps, NinferBuilder, parsePrereqs, versionAtLeast } from '../../../../../src/core/engines/ninfer/build';
import { WslProcesses } from '../../../../../src/core/engines/ninfer/wsl';
import { systemClock } from '../../../../../src/core/node-deps';
import { fail, manualProcess, ok, scriptedProc, tempDir } from '../../docker/helpers';
import { realProc, WSL_ARGV } from './helpers';

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups) c();
});

const PREREQS = [
  '##home /home/user',
  '##git git version 2.43.0',
  '##cmake cmake version 3.28.3',
  '##ninja 1.11.1',
  '##compiler g++ (Ubuntu 13.3.0-6ubuntu2~24.04) 13.3.0',
  '##pkg-config 1.8.1',
  '##nvcc /usr/local/cuda/bin/nvcc',
  '##cuda Cuda compilation tools, release 13.1, V13.1.80',
  '##ffmpeg 60.16.100 60.31.102 58.29.100 7.5.100 ',
  '##curl 8.5.0',
  '##checkout yes',
].join('\n');

describe('prerequisites and commands', () => {
  it('compares versions', () => {
    expect(versionAtLeast('3.28.3', '3.28')).toBe(true);
    expect(versionAtLeast('3.27.9', '3.28')).toBe(false);
    expect(versionAtLeast('13', '12.8')).toBe(true);
    expect(versionAtLeast('12', '12.8')).toBe(false);
  });

  it('reads the prerequisite script', () => {
    const r = parsePrereqs(PREREQS);
    expect(r).toMatchObject({ home: '/home/user', nvcc: '/usr/local/cuda/bin/nvcc', checkout: true });
    expect(r.prereqs.every((p) => p.found)).toBe(true);
    expect(r.prereqs.find((p) => p.id === 'cuda')).toEqual({ id: 'cuda', found: true, version: '13.1', need: '12.8', packages: ['cuda-toolkit-13-1'] });
    // Too old, missing, an incomplete FFmpeg; no home = the environment did not answer.
    const bad = parsePrereqs('##cmake cmake version 3.22.1\n##cuda Cuda compilation tools, release 12.0, V12.0.1\n##ffmpeg 60.16.100 60.31.102\n##git \n');
    expect(bad.home).toBeUndefined();
    expect(bad.nvcc).toBeUndefined();
    expect(bad.checkout).toBe(false);
    expect(bad.prereqs.filter((p) => !p.found).map((p) => p.id)).toEqual(['git', 'cmake', 'ninja', 'compiler', 'pkg-config', 'cuda', 'ffmpeg', 'curl']);
    expect(bad.prereqs.find((p) => p.id === 'cmake')).toMatchObject({ version: '3.22.1', need: '3.28' });
  });

  it('builds the exact steps', () => {
    expect(buildSteps('/home/u/ninfer', { existing: false, nvcc: '/usr/local/cuda/bin/nvcc' }).map((s) => [s.stage, s.argv.join(' ')])).toEqual([
      ['clone', 'git clone --progress https://github.com/Neroued/ninfer.git /home/u/ninfer'],
      ['configure', 'cmake -S /home/u/ninfer -B /home/u/ninfer/build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_CUDA_COMPILER=/usr/local/cuda/bin/nvcc'],
      ['build', 'cmake --build /home/u/ninfer/build -j'],
    ]);
    expect(buildSteps('/n', { existing: true, nvcc: '/usr/bin/nvcc' }).map((s) => s.stage)).toEqual(['configure', 'build']);
    expect(buildSteps('/n', { existing: true }).find((s) => s.stage === 'configure')?.argv).not.toContain('-DCMAKE_CUDA_COMPILER=undefined');
  });

  it('reads progress from ninja and git', () => {
    expect(buildProgress('[12/345] Building CUDA object src/a.cu.o')).toEqual({ done: 12, total: 345 });
    expect(buildProgress('Receiving objects:  45% (540/1200)')).toEqual({ done: 45, total: 100 });
    expect(buildProgress('-- Configuring done')).toBeUndefined();
  });
});

function wslBuilder(config: Record<string, unknown> = {}) {
  const t = tempDir('gb-ninfer-build-');
  cleanups.push(t.cleanup);
  const proc = realProc(path.join(t.dir, 'wsl'), { FAKE_WSL_CONFIG: JSON.stringify({ stepMs: 5, ...config }) });
  const processes = new WslProcesses({ proc, wsl: WSL_ARGV, file: path.join(t.dir, 'ninfer-wsl.json'), sleep: (ms) => systemClock.sleep(ms), graceMs: 2000 });
  let n = 0;
  return new NinferBuilder({ kind: 'ninfer-wsl', proc, wsl: { argv: WSL_ARGV, processes }, newMarker: () => `gpubench-build-${++n}` });
}

const steps = () => {
  const seen: string[] = [];
  const progress = (p: { stage: string; bytesDone: number; bytesTotal?: number }) => {
    if (seen[seen.length - 1] !== p.stage) seen.push(p.stage);
  };
  return { seen, progress };
};

describe('the guided build in a WSL distro', () => {
  it('plans in place over an existing checkout, or with a clone; lists what is missing with its apt line', async () => {
    const b = wslBuilder();
    expect(await b.plan({ kind: 'ninfer-wsl', distro: 'Ubuntu-24.04' })).toMatchObject({
      kind: 'ninfer-wsl',
      distro: 'Ubuntu-24.04',
      dir: '/home/user/ninfer',
      servePath: '/home/user/ninfer/build/apps/ninfer-serve',
      existing: true,
      commands: ['cmake -S /home/user/ninfer -B /home/user/ninfer/build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_CUDA_COMPILER=/usr/local/cuda/bin/nvcc', 'cmake --build /home/user/ninfer/build -j'],
      cudaFromNvidia: false,
      ready: true,
    });
    const missing = wslBuilder({ prereqs: { ninja: '', cuda: '', nvcc: '' } });
    const plan = await missing.plan({ kind: 'ninfer-wsl', distro: 'Ubuntu-24.04', dir: '~/src/ninfer/' });
    expect(plan).toMatchObject({ dir: '/home/user/src/ninfer', existing: false, aptCommand: 'sudo apt install ninja-build', cudaFromNvidia: true, ready: false });
    expect(plan.commands[0]).toBe('git clone --progress https://github.com/Neroued/ninfer.git /home/user/src/ninfer');
    await expect(missing.build({ kind: 'ninfer-wsl', distro: 'Ubuntu-24.04' }, () => undefined, new AbortController().signal)).rejects.toMatchObject({
      code: 'ENGINE_INSTALL_FAILED',
      params: { reason: 'ninfer_prereqs', missing: 'ninja,cuda' },
    });
  }, 60_000);

  it('refuses a relative folder, a missing distro, and an environment that does not answer', async () => {
    const b = wslBuilder();
    await expect(b.plan({ kind: 'ninfer-wsl', distro: 'Ubuntu-24.04', dir: 'ninfer' })).rejects.toMatchObject({ code: 'VALIDATION', params: { reason: 'ninfer_dir', dir: 'ninfer' } });
    await expect(b.plan({ kind: 'ninfer-wsl' })).rejects.toMatchObject({ code: 'VALIDATION', params: { reason: 'distro_missing' } });
    await expect(b.plan({ kind: 'ninfer-wsl', distro: 'Debian' })).rejects.toMatchObject({ code: 'ENGINE_INSTALL_FAILED', params: { reason: 'ninfer_prereqs' } });
  }, 60_000);

  it('clones, configures and builds with progress, then gives the program', async () => {
    const b = wslBuilder();
    const { seen, progress } = steps();
    expect(await b.build({ kind: 'ninfer-wsl', distro: 'Ubuntu-24.04', dir: '~/fresh' }, progress, new AbortController().signal)).toBe('/home/user/fresh/build/apps/ninfer-serve');
    expect(seen).toEqual(['clone', 'configure', 'build']);
  }, 60_000);

  it('stops at the failing step with its last lines', async () => {
    const b = wslBuilder({ failStage: 'configure' });
    const err = (await b.build({ kind: 'ninfer-wsl', distro: 'Ubuntu-24.04' }, () => undefined, new AbortController().signal).catch((e: unknown) => e)) as AppError;
    expect(err).toMatchObject({ code: 'ENGINE_INSTALL_FAILED', params: { reason: 'ninfer_build', stage: 'configure', code: '1' } });
    expect(err.detail).toContain('Could not find FFmpeg');
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

describe('the guided build on Linux', () => {
  it('runs the steps directly, and says when a program cannot start', async () => {
    const spawned: string[] = [];
    const proc = scriptedProc(
      () => ok(`${PREREQS.replace('##checkout yes', '##checkout ')}\n`),
      (spec) => {
        spawned.push([spec.cmd, ...spec.args].join(' '));
        if (spec.cmd === 'cmake' && spec.args[0] === '--build') throw new Error('ENOENT');
        const mp = manualProcess();
        setTimeout(() => {
          mp.push('[1/2] Building CUDA object a.cu.o');
          mp.exit({ code: 0, signal: null });
        }, 5);
        return mp;
      },
    );
    const b = new NinferBuilder({ kind: 'ninfer-native', proc, newMarker: () => 'gpubench-native-1' });
    const err = (await b.build({ kind: 'ninfer-native', dir: '/opt/ninfer' }, () => undefined, new AbortController().signal).catch((e: unknown) => e)) as AppError;
    expect(err).toMatchObject({ code: 'ENGINE_INSTALL_FAILED', params: { reason: 'ninfer_build', stage: 'build' } });
    expect(spawned).toEqual([
      'git clone --progress https://github.com/Neroued/ninfer.git /opt/ninfer',
      'cmake -S /opt/ninfer -B /opt/ninfer/build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_CUDA_COMPILER=/usr/local/cuda/bin/nvcc',
      'cmake --build /opt/ninfer/build -j',
    ]);
    expect(proc.calls[0]).toMatchObject({ cmd: '/bin/sh', args: ['-c', expect.stringContaining('##home'), 'sh', '/opt/ninfer'] });
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
    const failing = new NinferBuilder({ kind: 'ninfer-native', proc: scriptedProc(() => fail(127, 'sh: not found')), newMarker: () => 'x' });
    await expect(failing.plan({ kind: 'ninfer-native' })).rejects.toMatchObject({ params: { reason: 'ninfer_prereqs' } });
  });
});
