import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { listDistros, parseDistroList, wslLaunchArgv, WslProcesses, wslPathOf } from '../../../../../src/core/engines/ninfer/wsl';
import { fail, ok, scriptedProc, tempDir } from '../../docker/helpers';

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups) c();
});
const tmp = () => {
  const t = tempDir('gb-ninfer-wslu-');
  cleanups.push(t.cleanup);
  return t.dir;
};

describe('WSL distros and paths', () => {
  it('reads `wsl.exe -l -v` (UTF-16 NULs, header and Docker Desktop distros removed)', () => {
    const text = '\uFEFF  NAME              STATE           VERSION\r\n* Ubuntu-24.04      Running         2\r\n  Debian            Stopped         1\r\n  docker-desktop    Stopped         2\r\n  garbage\r\n';
    const utf16ish = text.split('').join('\0');
    expect(parseDistroList(utf16ish)).toEqual([
      { name: 'Ubuntu-24.04', default: true, version: 2, running: true },
      { name: 'Debian', default: false, version: 1, running: false },
    ]);
  });

  it('maps paths as the distro sees them', () => {
    expect(wslPathOf('C:\\models\\a.ninfer', 'Ubuntu')).toEqual({ path: '/mnt/c/models/a.ninfer', slow: true });
    expect(wslPathOf('D:', 'Ubuntu')).toEqual({ path: '/mnt/d', slow: true });
    expect(wslPathOf('\\\\wsl.localhost\\Ubuntu\\home\\u\\a.ninfer', 'ubuntu')).toEqual({ path: '/home/u/a.ninfer', slow: false });
    expect(wslPathOf('\\\\wsl$\\Ubuntu', 'Ubuntu')).toEqual({ path: '/', slow: false });
    expect(wslPathOf('//wsl.localhost/Debian/home/a.ninfer', 'Ubuntu')).toBeUndefined();
    expect(wslPathOf('/home/u/a.ninfer', 'Ubuntu')).toEqual({ path: '/home/u/a.ninfer', slow: false });
    expect(wslPathOf('/mnt/e/models/a.ninfer', 'Ubuntu')).toEqual({ path: '/mnt/e/models/a.ninfer', slow: true });
    expect(wslPathOf('\\\\nas\\share\\a.ninfer', 'Ubuntu')).toBeUndefined();
  });

  it('lists distros, or says WSL is not there', async () => {
    const proc = scriptedProc(() => ok('* Ubuntu-24.04 Running 2\n'));
    expect(await listDistros(proc, ['wsl.exe'])).toEqual({ wsl: true, distros: [{ name: 'Ubuntu-24.04', default: true, version: 2, running: true }] });
    expect(proc.calls[0]).toMatchObject({ cmd: 'wsl.exe', args: ['-l', '-v'], opts: { env: { WSL_UTF8: '1' } } });
    expect(await listDistros(scriptedProc(() => fail(1, 'no distributions')), ['node', 'fake.mjs'])).toEqual({ wsl: false, distros: [] });
  });

  it('starts ninfer-serve through env and the PID script', () => {
    expect(wslLaunchArgv(['wsl.exe'], { distro: 'Ubuntu', serve: '/s', args: ['m', '--port', '1'], env: { CUDA_VISIBLE_DEVICES: '0' }, marker: 'gpubench-1234' })).toEqual([
      'wsl.exe',
      '-d',
      'Ubuntu',
      '--exec',
      '/usr/bin/env',
      'GPUBENCH_OWNER=gpubench-1234',
      'CUDA_VISIBLE_DEVICES=0',
      '/bin/sh',
      '-c',
      'echo "gpubench-pid $$" >&2; exec "$@"',
      'sh',
      '/s',
      'm',
      '--port',
      '1',
    ]);
  });
});

/** A distro where pid 77 is ours until `alive` turns false; every kill is recorded. */
function distro(o: { alive?: () => boolean; marker?: string; dieOnTerm?: boolean } = {}) {
  let alive = true;
  const kills: string[][] = [];
  const proc = scriptedProc((args) => {
    const exec = args.slice(args.indexOf('--exec') + 1);
    if (exec[0] === 'cat') {
      const live = o.alive ? o.alive() : alive;
      return live && exec[1] === '/proc/77/environ' ? ok(`PATH=/bin\0GPUBENCH_OWNER=${o.marker ?? 'gpubench-own-1'}\0`) : fail(1, 'No such file');
    }
    if (exec[0] === 'kill') {
      kills.push(exec.slice(1));
      if (o.dieOnTerm) alive = false;
      return ok();
    }
    return fail(127, 'not found');
  });
  return { proc, kills };
}

const REC = { distro: 'Ubuntu', pid: 77, marker: 'gpubench-own-1' };
const noSleep = async () => undefined;

describe('our processes in WSL', () => {
  it('checks the marker in the process environment before any signal', async () => {
    const { proc, kills } = distro({ marker: 'someone-else' });
    const ps = new WslProcesses({ proc, wsl: ['wsl.exe'], file: path.join(tmp(), 'w.json'), sleep: noSleep });
    expect(await ps.owned('Ubuntu', 77, 'gpubench-own-1')).toBe(false);
    expect(await ps.owned('Ubuntu', 0, 'gpubench-own-1')).toBe(false);
    expect(await ps.stop(REC)).toBe(false);
    expect(kills).toEqual([]);
  });

  it('TERM first; KILL only if it is still ours after the grace time', async () => {
    const quick = distro({ dieOnTerm: true });
    const ps = new WslProcesses({ proc: quick.proc, wsl: ['wsl.exe'], file: path.join(tmp(), 'w.json'), sleep: noSleep, graceMs: 1000 });
    expect(await ps.stop(REC)).toBe(true);
    expect(quick.kills).toEqual([['-TERM', '77']]);

    const stubborn = distro();
    const ps2 = new WslProcesses({ proc: stubborn.proc, wsl: ['wsl.exe'], file: path.join(tmp(), 'w.json'), sleep: noSleep, graceMs: 1000 });
    expect(await ps2.stop(REC, undefined, { group: true })).toBe(true);
    expect(stubborn.kills).toEqual([
      ['-TERM', '--', '-77'],
      ['-KILL', '--', '-77'],
    ]);

    // With the relay's exit to wait on: gone in time = no KILL; still there after the grace = KILL.
    const relayed = distro();
    const ps3 = new WslProcesses({ proc: relayed.proc, wsl: ['wsl.exe'], file: path.join(tmp(), 'w.json'), sleep: () => new Promise((r) => setTimeout(r, 50)) });
    expect(await ps3.stop(REC, Promise.resolve())).toBe(true);
    expect(relayed.kills).toEqual([['-TERM', '77']]);
    expect(await ps3.stop(REC, new Promise(() => undefined))).toBe(true);
    expect(relayed.kills.slice(1)).toEqual([
      ['-TERM', '77'],
      ['-KILL', '77'],
    ]);
    // Gone right after the grace: no KILL.
    const late = distro({ dieOnTerm: true });
    const ps4 = new WslProcesses({ proc: late.proc, wsl: ['wsl.exe'], file: path.join(tmp(), 'w.json'), sleep: noSleep });
    expect(await ps4.stop(REC, new Promise(() => undefined))).toBe(true);
    expect(late.kills).toEqual([['-TERM', '77']]);
  });

  it('records processes, and stops the leftovers of a crashed session at start-up', async () => {
    const dir = tmp();
    const file = path.join(dir, 'sub', 'ninfer-wsl.json');
    const { proc, kills } = distro({ dieOnTerm: true });
    const ps = new WslProcesses({ proc, wsl: ['wsl.exe'], file, sleep: noSleep });
    expect(await ps.cleanupOrphans()).toEqual([]);
    expect(proc.calls).toEqual([]);
    await ps.add({ ...REC, startedAtWall: 1 });
    await ps.add({ ...REC, startedAtWall: 2 });
    await ps.add({ distro: 'Ubuntu', pid: 78, marker: 'gpubench-own-2', startedAtWall: 3 });
    expect((await ps.list()).map((r) => [r.pid, r.startedAtWall])).toEqual([
      [77, 2],
      [78, 3],
    ]);
    await ps.remove('Ubuntu', 99);
    await ps.remove('Ubuntu', 78);
    expect(await ps.list()).toHaveLength(1);
    await ps.add({ distro: 'Ubuntu', pid: 78, marker: 'gpubench-own-2', startedAtWall: 3 });
    // 77 is ours and alive: stopped; 78 is gone: only dropped.
    expect(await ps.cleanupOrphans()).toEqual([{ ...REC, startedAtWall: 2 }]);
    expect(kills).toEqual([['-TERM', '77']]);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ schema: 1, records: [] });
    // A damaged file, or records that do not parse, count as none.
    writeFileSync(file, '{"schema":1,"records":[{"pid":-1},{"distro":"Ubuntu","pid":5,"marker":"gpubench-x-123","startedAtWall":1}]}');
    expect((await ps.list()).map((r) => r.pid)).toEqual([5]);
    writeFileSync(file, '{"schema":2}');
    expect(await ps.list()).toEqual([]);
    writeFileSync(file, 'not json');
    expect(await ps.list()).toEqual([]);
    // A record whose check fails is only dropped; a write that fails is reported, and the next call works.
    const failing = new WslProcesses({ proc: scriptedProc(() => Promise.reject(new Error('wsl.exe is gone'))), wsl: ['wsl.exe'], file, sleep: noSleep });
    writeFileSync(file, JSON.stringify({ schema: 1, records: [{ ...REC, startedAtWall: 1 }] }));
    expect(await failing.cleanupOrphans()).toEqual([]);
    const blocked = new WslProcesses({ proc, wsl: ['wsl.exe'], file: dir, sleep: noSleep });
    await expect(blocked.add({ ...REC, startedAtWall: 1 })).rejects.toThrow();
    expect(await blocked.list()).toEqual([]);
  });
});
