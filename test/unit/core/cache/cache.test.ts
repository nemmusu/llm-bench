import { describe, expect, it } from 'vitest';
import path from 'node:path';
import type { Clock, ProcessRunner, RunOutput } from '../../../../src/core/deps';
import { createLinuxEvictor, noEvictor, parseFincore, uniqueFiles } from '../../../../src/core/cache/evictor';
import {
  PURGE_SCRIPT,
  TASK_RUNNING,
  WindowsStandbyEvictor,
  elevatedArgs,
  encodePowerShell,
  installScript,
  parseTaskInfo,
  uninstallScript,
} from '../../../../src/core/cache/windows-standby';

type Handler = (cmd: string, args: string[]) => Partial<RunOutput> | undefined;

function fakeProc(handler: Handler, calls: { cmd: string; args: string[] }[] = []): ProcessRunner {
  return {
    run: (cmd, args) => {
      calls.push({ cmd, args });
      const r = handler(cmd, args) ?? {};
      return Promise.resolve({ code: 0, stdout: '', stderr: '', timedOut: false, ...r });
    },
    spawn: () => {
      throw new Error('not used');
    },
  };
}

function fakeClock(start = 1_000): Clock & { advance(ms: number): void } {
  let mono = 0;
  let wall = start;
  return {
    now: () => mono,
    wall: () => wall,
    sleep: (ms, signal) => {
      if (signal?.aborted) return Promise.reject(new Error('aborted'));
      mono += ms;
      wall += ms;
      return Promise.resolve();
    },
    advance(ms) {
      mono += ms;
      wall += ms;
    },
  };
}

describe('parseFincore / uniqueFiles / noEvictor', () => {
  it('sums resident bytes and rejects garbage', () => {
    expect(parseFincore('1024\n2048\n')).toBe(3072);
    expect(parseFincore('')).toBeUndefined();
    expect(parseFincore('abc')).toBeUndefined();
  });

  it('dedupes and normalizes paths', () => {
    expect(uniqueFiles(['a/b.gguf', 'a/./b.gguf', 'c.gguf'])).toEqual([path.resolve('a/b.gguf'), path.resolve('c.gguf')]);
  });

  it('noEvictor never guarantees anything', async () => {
    expect(await noEvictor.evict(['x'])).toEqual({ guaranteed: false, reason: 'not-supported' });
  });
});

describe('createLinuxEvictor', () => {
  it('drops each file and verifies with fincore', async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const proc = fakeProc((cmd) => {
      if (cmd === 'stat') return { stdout: '1000000\n' };
      if (cmd === 'fincore') return { stdout: '4096\n' };
      return undefined;
    }, calls);
    const r = await createLinuxEvictor({ proc }).evict(['/m/a.gguf', '/m/b.gguf']);
    expect(r).toEqual({ guaranteed: true, residentBytesAfter: 8192 });
    expect(calls.filter((c) => c.cmd === 'dd').map((c) => c.args[0])).toEqual(['if=/m/a.gguf', 'if=/m/b.gguf']);
    expect(calls[0]!.args).toContain('iflag=nocache');
  });

  it('flags files that stay resident (mapped by another process)', async () => {
    const proc = fakeProc((cmd) => {
      if (cmd === 'stat') return { stdout: '1000\n' };
      if (cmd === 'fincore') return { stdout: '900\n' };
      return undefined;
    });
    expect(await createLinuxEvictor({ proc }).evict(['/m/a.gguf'])).toEqual({
      guaranteed: false,
      residentBytesAfter: 900,
      reason: 'still-resident',
    });
  });

  it('trusts dd when fincore is unavailable, and fails when dd fails', async () => {
    const noFincore = fakeProc((cmd) => (cmd === 'fincore' ? { code: 127 } : cmd === 'stat' ? { stdout: 'x' } : undefined));
    expect(await createLinuxEvictor({ proc: noFincore }).evict(['/m/a.gguf'])).toEqual({ guaranteed: true });
    const ddFails = fakeProc((cmd) => (cmd === 'dd' ? { code: 1 } : undefined));
    expect(await createLinuxEvictor({ proc: ddFails }).evict(['/m/a.gguf'])).toEqual({ guaranteed: false, reason: 'failed' });
  });

  it('accepts an empty file size and passes the abort signal', async () => {
    const proc = fakeProc((cmd) => (cmd === 'stat' ? { stdout: '0' } : cmd === 'fincore' ? { stdout: '0' } : undefined));
    const ac = new AbortController();
    expect(await createLinuxEvictor({ proc }, { residentTolerance: 0 }).evict(['/m/a'], ac.signal)).toEqual({
      guaranteed: true,
      residentBytesAfter: 0,
    });
  });
});

describe('Windows standby task scripts', () => {
  it('encodes PowerShell as base64 UTF-16LE', () => {
    expect(Buffer.from(encodePowerShell('exit 0'), 'base64').toString('utf16le')).toBe('exit 0');
  });

  it('embeds the purge script in the task and runs it as SYSTEM', () => {
    const s = installScript();
    expect(s).toContain(encodePowerShell(PURGE_SCRIPT));
    expect(s).toContain("-UserId 'S-1-5-18'");
    expect(s).toContain('-RunLevel Highest');
    expect(s).toContain('(A;;GRGX;;;AU)');
    expect(PURGE_SCRIPT).toContain('SeProfileSingleProcessPrivilege');
    expect(PURGE_SCRIPT).toContain('NtSetSystemInformation(80');
  });

  it('uninstalls the task and folder, and elevates through Start-Process -Verb RunAs', () => {
    expect(uninstallScript()).toContain('Unregister-ScheduledTask');
    const args = elevatedArgs('exit 0');
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    expect(args[3]).toContain('-Verb RunAs');
    expect(args[3]).toContain(encodePowerShell('exit 0'));
  });

  it('parses task info JSON', () => {
    expect(parseTaskInfo('')).toEqual({ installed: false });
    expect(parseTaskInfo('not json')).toEqual({ installed: false });
    expect(parseTaskInfo('{"LastRunTime":null,"LastTaskResult":267011}')).toEqual({ installed: true, lastResult: 267011 });
    expect(parseTaskInfo('{"LastRunTime":"2026-10-06T10:00:00.0000000Z","LastTaskResult":0}')).toEqual({
      installed: true,
      lastRun: Date.parse('2026-10-06T10:00:00Z'),
      lastResult: 0,
    });
    expect(parseTaskInfo('{"LastRunTime":"0001-01-01T00:00:00Z"}')).toEqual({ installed: true });
  });
});

describe('WindowsStandbyEvictor', () => {
  const iso = (ms: number) => new Date(ms).toISOString();

  it('reports not-enabled when the task is missing', async () => {
    const proc = fakeProc(() => ({ stdout: '' }));
    const ev = new WindowsStandbyEvictor({ proc, clock: fakeClock() });
    expect(await ev.evict(['x'])).toEqual({ guaranteed: false, reason: 'not-enabled' });
  });

  it('treats a failing query as not installed', async () => {
    const proc = fakeProc(() => ({ code: 1 }));
    expect(await new WindowsStandbyEvictor({ proc, clock: fakeClock() }).info()).toEqual({ installed: false });
  });

  it('starts the task and waits for a fresh successful run', async () => {
    const clock = fakeClock(10_000_000);
    let queries = 0;
    const proc = fakeProc((_cmd, args) => {
      const script = args[3] ?? '';
      if (script.startsWith('Start-ScheduledTask')) return {};
      queries++;
      if (queries === 1) return { stdout: JSON.stringify({ LastRunTime: iso(1_000), LastTaskResult: 0 }) };
      if (queries === 2) return { stdout: JSON.stringify({ LastRunTime: iso(clock.wall()), LastTaskResult: TASK_RUNNING }) };
      return { stdout: JSON.stringify({ LastRunTime: iso(clock.wall()), LastTaskResult: 0 }) };
    });
    const ev = new WindowsStandbyEvictor({ proc, clock }, { pollMs: 100 });
    expect(await ev.evict(['x'])).toEqual({ guaranteed: true });
  });

  it('reports a failed purge, a failed start and a timeout', async () => {
    const clock = fakeClock(10_000_000);
    const failed = fakeProc((_c, args) =>
      (args[3] ?? '').startsWith('Start-ScheduledTask') ? {} : { stdout: JSON.stringify({ LastRunTime: iso(clock.wall()), LastTaskResult: 1 }) },
    );
    expect(await new WindowsStandbyEvictor({ proc: failed, clock }).evict([])).toEqual({ guaranteed: false, reason: 'failed' });

    const startFails = fakeProc((_c, args) =>
      (args[3] ?? '').startsWith('Start-ScheduledTask') ? { code: 1 } : { stdout: '{"LastTaskResult":0}' },
    );
    expect(await new WindowsStandbyEvictor({ proc: startFails, clock }).evict([])).toEqual({ guaranteed: false, reason: 'failed' });

    const stale = fakeProc(() => ({ stdout: JSON.stringify({ LastRunTime: iso(1_000), LastTaskResult: 0 }) }));
    expect(await new WindowsStandbyEvictor({ proc: stale, clock: fakeClock(10_000_000) }, { timeoutMs: 1_000, pollMs: 400 }).evict([])).toEqual({
      guaranteed: false,
      reason: 'timeout',
    });
    // Defaults (60 s timeout, 500 ms poll) with the fake clock.
    expect(await new WindowsStandbyEvictor({ proc: stale, clock: fakeClock(10_000_000) }).evict([])).toEqual({
      guaranteed: false,
      reason: 'timeout',
    });
  });

  it('installs and uninstalls through the elevated helper', async () => {
    let installed = false;
    const proc = fakeProc((_c, args) => {
      const script = args[3] ?? '';
      if (script.includes('-Verb RunAs')) {
        installed = !installed;
        return {};
      }
      return { stdout: installed ? '{"LastTaskResult":0}' : '' };
    });
    const ev = new WindowsStandbyEvictor({ proc, clock: fakeClock() });
    expect(await ev.install()).toBe(true);
    expect(await ev.uninstall()).toBe(true);
    const declined = fakeProc((_c, args) => ((args[3] ?? '').includes('-Verb RunAs') ? { code: 1 } : { stdout: '' }));
    const ev2 = new WindowsStandbyEvictor({ proc: declined, clock: fakeClock() });
    expect(await ev2.install()).toBe(false);
    expect(await ev2.uninstall()).toBe(false);
  });
});
