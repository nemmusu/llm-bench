import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProcessRunner, RunOptions, RunOutput } from '../../../../src/core/deps';
import {
  OwnershipRegistry,
  linuxInspector,
  sameExecutable,
  windowsInspector,
  type OwnedRecord,
  type ProcessInfo,
  type ProcessInspector,
} from '../../../../src/core/process/ownership';
import { createProcessRunner } from '../../../../src/core/process/runner';
import { systemClock } from '../../../../src/core/node-deps';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'gb-own-'));
const MARK = 'gpubench-0123456789abcdef';

function rec(pid: number, extra: Partial<OwnedRecord> = {}): OwnedRecord {
  return { pid, startedAtWall: 1, exe: '/opt/llama/llama-server', marker: MARK, runId: 'run1', kind: 'process', ...extra };
}

/** Runner whose run() answers from a table; spawn is never used by the registry. */
function fakeRunner(answer: (cmd: string, args: string[], opts?: RunOptions) => RunOutput): ProcessRunner & { calls: [string, string[]][] } {
  const calls: [string, string[]][] = [];
  return {
    calls,
    run: async (cmd, args, opts) => {
      calls.push([cmd, args]);
      return answer(cmd, args, opts);
    },
    spawn: () => {
      throw new Error('not used');
    },
  };
}

const inspectorFrom = (table: Map<number, ProcessInfo>): ProcessInspector => ({ inspect: async (pid) => table.get(pid) });

const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
});

describe('OwnershipRegistry persistence', () => {
  it('adds, replaces, lists and removes records in processes.json', async () => {
    const file = path.join(tmp(), 'sub', 'processes.json');
    const reg = new OwnershipRegistry({ file, platform: 'linux', proc: fakeRunner(() => ({ code: 0, stdout: '', stderr: '', timedOut: false })) });
    expect(await reg.list()).toEqual([]);
    await reg.add(rec(10));
    await reg.add(rec(11));
    await reg.add(rec(10, { runId: 'run2' }));
    expect((await reg.list()).map((r) => [r.pid, r.runId])).toEqual([
      [11, 'run1'],
      [10, 'run2'],
    ]);
    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    expect(onDisk.schema).toBe(1);
    await reg.remove(11);
    await reg.remove(12345); // unknown: no rewrite needed
    expect((await reg.list()).map((r) => r.pid)).toEqual([10]);
    await expect(reg.add({ ...rec(1), marker: 'short' })).rejects.toThrow();
  });

  it('ignores corrupt files and invalid records', async () => {
    const dir = tmp();
    const file = path.join(dir, 'processes.json');
    const reg = new OwnershipRegistry({ file, platform: 'linux', proc: fakeRunner(() => ({ code: 0, stdout: '', stderr: '', timedOut: false })) });
    writeFileSync(file, '{not json');
    expect(await reg.list()).toEqual([]);
    writeFileSync(file, JSON.stringify({ schema: 2, records: [] }));
    expect(await reg.list()).toEqual([]);
    writeFileSync(file, JSON.stringify({ schema: 1, records: [rec(5), { pid: -1 }, 'x'] }));
    expect((await reg.list()).map((r) => r.pid)).toEqual([5]);
  });

  it('keeps working after a failed write (operations are serialized, failures isolated)', async () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'blocker'), 'a file, not a folder');
    const reg = new OwnershipRegistry({
      file: path.join(dir, 'blocker', 'processes.json'),
      platform: 'linux',
      proc: fakeRunner(() => ({ code: 0, stdout: '', stderr: '', timedOut: false })),
    });
    const a = reg.add(rec(1));
    const b = reg.add(rec(2));
    await expect(a).rejects.toThrow();
    await expect(b).rejects.toThrow();
    expect(await reg.list()).toEqual([]);
  });
});

describe('verifyOwned', () => {
  const table = new Map<number, ProcessInfo>([
    [1, { commandLine: `/opt/llama/llama-server -m x --alias ${MARK}`, exe: '/opt/llama/llama-server' }],
    [2, { commandLine: '/opt/llama/llama-server -m x --alias someone-else', exe: '/opt/llama/llama-server' }],
    [3, { commandLine: `/usr/bin/other --alias ${MARK}`, exe: '/usr/bin/other' }],
  ]);
  const reg = new OwnershipRegistry({
    file: path.join(tmp(), 'p.json'),
    platform: 'linux',
    proc: fakeRunner(() => ({ code: 0, stdout: '', stderr: '', timedOut: false })),
    inspector: inspectorFrom(table),
  });

  it('needs the marker AND the same executable', async () => {
    expect(await reg.verifyOwned(rec(1))).toBe(true);
    expect(await reg.verifyOwned(rec(2))).toBe(false);
    expect(await reg.verifyOwned(rec(3))).toBe(false);
    expect(await reg.verifyOwned(rec(4))).toBe(false);
  });

  it('containers: false without Docker support, delegated otherwise', async () => {
    expect(await reg.verifyOwned(rec(1, { kind: 'container', containerId: 'c1' }))).toBe(false);
    const withDocker = new OwnershipRegistry({
      file: path.join(tmp(), 'p.json'),
      platform: 'linux',
      proc: fakeRunner(() => ({ code: 0, stdout: '', stderr: '', timedOut: false })),
      containers: { verify: async (r) => r.containerId === 'c1', stop: async () => {} },
    });
    expect(await withDocker.verifyOwned(rec(1, { kind: 'container', containerId: 'c1' }))).toBe(true);
  });

  it('compares executables case-insensitively on Windows only', () => {
    expect(sameExecutable('C:\\Llama\\llama-server.exe', 'c:/llama/LLAMA-SERVER.EXE', 'win32')).toBe(true);
    expect(sameExecutable('/opt/Llama', '/opt/llama', 'linux')).toBe(false);
    expect(sameExecutable('/opt/./llama', '/opt/llama', 'linux')).toBe(true);
  });
});

describe('inspectors', () => {
  it('windows: parses the CIM JSON and handles missing/odd output', async () => {
    const answers: RunOutput[] = [
      { code: 0, stdout: '{"CommandLine":"a.exe --alias M","ExecutablePath":"C:\\\\a.exe"}\r\n', stderr: '', timedOut: false },
      { code: 0, stdout: '{"CommandLine":null,"ExecutablePath":null}', stderr: '', timedOut: false },
      { code: 0, stdout: '', stderr: '', timedOut: false },
      { code: 1, stdout: '{}', stderr: 'denied', timedOut: false },
      { code: 0, stdout: 'garbage', stderr: '', timedOut: false },
    ];
    const proc = fakeRunner(() => answers.shift() as RunOutput);
    const insp = windowsInspector(proc);
    expect(await insp.inspect(42)).toEqual({ commandLine: 'a.exe --alias M', exe: 'C:\\a.exe' });
    expect(await insp.inspect(42)).toEqual({ commandLine: '', exe: '' });
    expect(await insp.inspect(42)).toBeUndefined();
    expect(await insp.inspect(42)).toBeUndefined();
    expect(await insp.inspect(42)).toBeUndefined();
    expect(await insp.inspect(0)).toBeUndefined();
    expect(await insp.inspect(1.5)).toBeUndefined();
    expect(proc.calls).toHaveLength(5);
    const [cmd, args] = proc.calls[0] as [string, string[]];
    expect(cmd).toBe('powershell.exe');
    expect(args.at(-1)).toContain('Get-CimInstance Win32_Process -Filter "ProcessId=42"');
  });

  it('linux: reads /proc cmdline and exe (dropping " (deleted)")', async () => {
    const files: Record<string, string> = { '/proc/9/cmdline': 'llama-server\0--alias\0M\0' };
    const insp = linuxInspector('/proc', {
      readFile: async (p) => {
        const v = files[p];
        if (v === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return Buffer.from(v);
      },
      readlink: async () => '/opt/llama-server (deleted)',
    });
    expect(await insp.inspect(9)).toEqual({ commandLine: 'llama-server --alias M', exe: '/opt/llama-server' });
    expect(await insp.inspect(10)).toBeUndefined();
    expect(await insp.inspect(-3)).toBeUndefined();
  });

  it('linux: default fs on a fake proc root (exe that is not a link → not inspectable)', async () => {
    const root = tmp();
    mkdirSync(path.join(root, '5'));
    writeFileSync(path.join(root, '5', 'cmdline'), 'x\0');
    writeFileSync(path.join(root, '5', 'exe'), 'not a link');
    expect(await linuxInspector(root).inspect(5)).toBeUndefined();
  });

  it.runIf(process.platform === 'win32')('windows: real CIM query sees our own child with its marker', async () => {
    const runner = createProcessRunner({ clock: systemClock, platform: 'win32', baseEnv: process.env });
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', '--', MARK], { windowsHide: true, stdio: 'ignore' });
    children.push(child);
    const info = await windowsInspector(runner).inspect(child.pid as number);
    expect(info?.commandLine).toContain(MARK);
    expect(sameExecutable(info?.exe ?? '', process.execPath, 'win32')).toBe(true);
    const reg = new OwnershipRegistry({ file: path.join(tmp(), 'p.json'), platform: 'win32', proc: runner });
    expect(await reg.verifyOwned(rec(child.pid as number, { exe: process.execPath }))).toBe(true);
    expect(await reg.verifyOwned(rec(child.pid as number, { exe: process.execPath, marker: 'gpubench-not-this-one' }))).toBe(false);
  });
});

describe('cleanupOrphans', () => {
  it('windows: taskkills verified leftovers only, drops stale records, keeps unverifiable containers', async () => {
    const proc = fakeRunner(() => ({ code: 0, stdout: '', stderr: '', timedOut: false }));
    const table = new Map<number, ProcessInfo>([
      [100, { commandLine: `llama-server --alias ${MARK}`, exe: 'C:\\e\\llama-server.exe' }],
      [200, { commandLine: 'llama-server --alias other', exe: 'C:\\e\\llama-server.exe' }],
    ]);
    const file = path.join(tmp(), 'p.json');
    const reg = new OwnershipRegistry({ file, platform: 'win32', proc, inspector: inspectorFrom(table) });
    await reg.add(rec(100, { exe: 'c:\\E\\llama-server.exe' }));
    await reg.add(rec(200, { exe: 'C:\\e\\llama-server.exe' }));
    await reg.add(rec(300));
    await reg.add(rec(400, { kind: 'container', containerId: 'abc' }));
    const report = await reg.cleanupOrphans();
    expect(report.stopped.map((r) => r.pid)).toEqual([100]);
    expect(report.dropped.map((r) => r.pid).sort()).toEqual([200, 300]);
    expect(report.kept.map((r) => r.pid)).toEqual([400]);
    expect(proc.calls).toEqual([['taskkill', ['/PID', '100', '/T', '/F']]]);
    expect((await reg.list()).map((r) => r.pid)).toEqual([400]);
  });

  it('containers are stopped through the Docker hook when verified', async () => {
    const stopped: string[] = [];
    const reg = new OwnershipRegistry({
      file: path.join(tmp(), 'p.json'),
      platform: 'linux',
      proc: fakeRunner(() => ({ code: 0, stdout: '', stderr: '', timedOut: false })),
      inspector: inspectorFrom(new Map()),
      containers: { verify: async (r) => r.containerId === 'ours', stop: async (r) => void stopped.push(r.containerId as string) },
    });
    await reg.add(rec(1, { kind: 'container', containerId: 'ours' }));
    await reg.add(rec(2, { kind: 'container', containerId: 'theirs' }));
    const report = await reg.cleanupOrphans();
    expect(stopped).toEqual(['ours']);
    expect(report.dropped.map((r) => r.containerId)).toEqual(['theirs']);
  });

  it('linux: SIGTERM to the group, SIGKILL after the grace period if still alive', async () => {
    const signals: [number, string | number][] = [];
    const alive = new Set([10, 20]);
    const reg = new OwnershipRegistry({
      file: path.join(tmp(), 'p.json'),
      platform: 'linux',
      proc: fakeRunner(() => ({ code: 0, stdout: '', stderr: '', timedOut: false })),
      inspector: inspectorFrom(
        new Map([
          [10, { commandLine: `x --alias ${MARK}`, exe: '/opt/llama/llama-server' }],
          [20, { commandLine: `x --alias ${MARK}`, exe: '/opt/llama/llama-server' }],
          [30, { commandLine: `x --alias ${MARK}`, exe: '/opt/llama/llama-server' }],
        ]),
      ),
      graceMs: 300,
      sleep: async () => {},
      signal: (pid, sig) => {
        signals.push([pid, sig]);
        if (pid === -20 || pid === -30 || pid === 30) throw new Error('ESRCH');
        if (sig === 0 && !alive.has(pid)) throw new Error('ESRCH');
        // pid 20 dies on SIGTERM; 10 ignores it and needs SIGKILL.
        if (pid === 20 && sig === 'SIGTERM') alive.delete(20);
      },
    });
    await reg.add(rec(10));
    await reg.add(rec(20));
    await reg.add(rec(30));
    const report = await reg.cleanupOrphans();
    expect(report.stopped.map((r) => r.pid)).toEqual([10, 20, 30]);
    expect(signals.filter(([, s]) => s !== 0)).toEqual([
      [-10, 'SIGTERM'],
      [-10, 'SIGKILL'],
      [-20, 'SIGTERM'],
      [20, 'SIGTERM'],
      [-30, 'SIGTERM'],
      [30, 'SIGTERM'],
    ]);
  });

  it('linux defaults (process.kill, real sleep) stop our own child', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
    children.push(child);
    const pid = child.pid as number;
    const reg = new OwnershipRegistry({
      file: path.join(tmp(), 'p.json'),
      platform: 'linux',
      proc: fakeRunner(() => ({ code: 0, stdout: '', stderr: '', timedOut: false })),
      inspector: inspectorFrom(new Map([[pid, { commandLine: `node --alias ${MARK}`, exe: '/opt/llama/llama-server' }]])),
    });
    await reg.add(rec(pid));
    const exited = new Promise((r) => child.once('exit', r));
    const report = await reg.cleanupOrphans();
    expect(report.stopped.map((r) => r.pid)).toEqual([pid]);
    await exited;
  });

  it('default inspectors are chosen by platform', async () => {
    const proc = fakeRunner(() => ({ code: 0, stdout: '', stderr: '', timedOut: false }));
    const win = new OwnershipRegistry({ file: path.join(tmp(), 'p.json'), platform: 'win32', proc });
    expect(await win.verifyOwned(rec(4242))).toBe(false);
    expect(proc.calls[0]?.[0]).toBe('powershell.exe');
    const lin = new OwnershipRegistry({ file: path.join(tmp(), 'p.json'), platform: 'linux', proc });
    expect(await lin.verifyOwned(rec(4242))).toBe(false);
  });

  it('property: foreign processes are never signalled, verified own ones always are', async () => {
    const procArb = fc.record({
      kind: fc.constantFrom('own', 'foreign-cmd', 'foreign-exe', 'gone'),
      cmd: fc.string({ maxLength: 40 }).filter((s) => !s.includes(MARK)),
    });
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.integer({ min: 2, max: 50_000 }), { minLength: 1, maxLength: 12 }),
        fc.array(procArb, { minLength: 12, maxLength: 12 }),
        fc.constantFrom('win32' as const, 'linux' as const),
        async (pids, kinds, platform) => {
          const table = new Map<number, ProcessInfo>();
          const own = new Set<number>();
          pids.forEach((pid, i) => {
            const k = kinds[i] as { kind: string; cmd: string };
            if (k.kind === 'own') {
              table.set(pid, { commandLine: `${k.cmd} --alias ${MARK}`, exe: '/opt/llama/llama-server' });
              own.add(pid);
            } else if (k.kind === 'foreign-cmd') table.set(pid, { commandLine: k.cmd, exe: '/opt/llama/llama-server' });
            else if (k.kind === 'foreign-exe') table.set(pid, { commandLine: `${k.cmd} --alias ${MARK}`, exe: '/usr/bin/other' });
          });
          const signalled = new Set<number>();
          const proc = fakeRunner((cmd, args) => {
            if (cmd === 'taskkill') signalled.add(Number(args[1]));
            return { code: 0, stdout: '', stderr: '', timedOut: false };
          });
          const reg = new OwnershipRegistry({
            file: path.join(tmp(), 'p.json'),
            platform,
            proc,
            inspector: inspectorFrom(table),
            sleep: async () => {},
            graceMs: 0,
            signal: (pid, sig) => {
              if (sig !== 0) signalled.add(Math.abs(pid));
            },
          });
          for (const pid of pids) await reg.add(rec(pid));
          await reg.cleanupOrphans();
          for (const pid of signalled) expect(own.has(pid)).toBe(true);
          for (const pid of own) expect(signalled.has(pid)).toBe(true);
          expect(await reg.list()).toEqual([]);
        },
      ),
      { numRuns: 60 },
    );
  });
});
