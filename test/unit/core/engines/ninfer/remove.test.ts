import { describe, expect, it } from 'vitest';
import { deletableDir, deleteFolder, folderBytes, REMOVE_SCRIPT, removeCommand, removeModeOf, SIZE_SCRIPT } from '../../../../../src/core/engines/ninfer/remove';
import type { DistroRun } from '../../../../../src/core/engines/ninfer/wsl';

const answering = (stdout: string, stderr = ''): DistroRun & { calls: string[][] } => {
  const calls: string[][] = [];
  const run = (async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    return { code: stdout ? 0 : 1, stdout, stderr, timedOut: false };
  }) as DistroRun & { calls: string[][] };
  run.calls = calls;
  return run;
};

describe('removing a NInfer build', () => {
  it('deletes only folders inside a home folder, one level down at least', () => {
    for (const ok of ['~/ninfer', '~/ninfer-all', '/home/user/ninfer', '/root/ninfer', '~/src/ninfer']) expect(deletableDir(ok), ok).toBe(true);
    for (const bad of ['~', '~/', '/home/user', '/home/user/', '/', '/opt/ninfer', '~/../etc', '/home/user/./x', 'ninfer', '']) expect(deletableDir(bad), bad).toBe(false);
  });

  it('what removing does: LLM Bench built it → deleted; the user\'s → forgotten; built by hand in ~/ninfer-all → by hand', () => {
    expect(removeModeOf({ build: 'official', built: 'abc1234', dir: '/home/u/ninfer' })).toBe('delete');
    expect(removeModeOf({ build: 'all', built: 'abc1234', dir: '~/ninfer-all' })).toBe('delete');
    // A record of the commit in a folder LLM Bench never deletes: forgotten instead.
    expect(removeModeOf({ build: 'official', built: 'abc1234', dir: '/opt/ninfer' })).toBe('forget');
    expect(removeModeOf({ build: 'official', dir: '/home/u/ninfer' })).toBe('forget');
    expect(removeModeOf({ build: 'all', dir: '/home/u/ninfer-all' })).toBe('manual');
    expect(removeModeOf({ build: 'all', dir: '~/ninfer-all' })).toBe('manual');
    expect(removeModeOf({ build: 'all', dir: '/root/ninfer-all' })).toBe('manual');
    expect(removeModeOf({ build: 'all', dir: '/home/u/other' })).toBe('forget');
  });

  it('the command shown, in WSL or on Linux', () => {
    expect(removeCommand('~/ninfer', 'Ubuntu-24.04')).toBe('wsl -d Ubuntu-24.04 -- rm -rf ~/ninfer');
    expect(removeCommand('/home/u/ninfer', undefined)).toBe('rm -rf /home/u/ninfer');
  });

  it('measures the folder (KiB from du), nothing when du says nothing', async () => {
    const run = answering('##gpubench-size 2048\n');
    expect(await folderBytes(run, '~/ninfer')).toBe(2048 * 1024);
    expect(run.calls[0]).toEqual(['/bin/sh', '-c', SIZE_SCRIPT, 'sh', '~/ninfer']);
    expect(await folderBytes(answering('##gpubench-size \n'), '~/x')).toBeUndefined();
    expect(await folderBytes(answering('##gpubench-size 0\n'), '~/x')).toBeUndefined();
  });

  it('deletes with the marker as proof; refuses a folder it must not touch; says what the shell said', async () => {
    const run = answering('##gpubench-removed\n');
    await deleteFolder(run, '~/ninfer');
    expect(run.calls[0]).toEqual(['/bin/sh', '-c', REMOVE_SCRIPT, 'sh', '~/ninfer']);
    const never = answering('##gpubench-removed\n');
    await expect(deleteFolder(never, '/opt')).rejects.toMatchObject({ code: 'VALIDATION', params: { reason: 'not-deletable' } });
    expect(never.calls).toEqual([]);
    await expect(deleteFolder(answering('', 'rm: cannot remove: Permission denied'), '~/ninfer')).rejects.toMatchObject({ code: 'INTERNAL', detail: 'rm: cannot remove: Permission denied' });
  });
});
