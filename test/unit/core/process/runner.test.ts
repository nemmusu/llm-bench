import { EventEmitter } from 'node:events';
import { mkdtempSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawn as nodeSpawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LogLine } from '../../../../src/core/deps';
import { systemClock } from '../../../../src/core/node-deps';
import { AsyncQueue, LineSplitter, createProcessRunner, defaultKillTree, mergeEnv } from '../../../../src/core/process/runner';

const NODE = process.execPath;
type SpawnFn = (cmd: string, args: readonly string[], opts: SpawnOptions) => ChildProcess;

async function collect(it: AsyncIterable<LogLine>): Promise<LogLine[]> {
  const out: LogLine[] = [];
  for await (const l of it) out.push(l);
  return out;
}

/** Kills only children this test spawned (by pid we hold). */
const spawned: ChildProcess[] = [];
const trackingSpawn: SpawnFn = (cmd, args, opts) => {
  const c = nodeSpawn(cmd, args, opts);
  spawned.push(c);
  return c;
};
afterEach(() => {
  for (const c of spawned.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  vi.restoreAllMocks();
});

describe('LineSplitter', () => {
  it('splits LF and CRLF, keeps the partial tail until flush', () => {
    const s = new LineSplitter();
    expect(s.push('a\nb\r\nc')).toEqual(['a', 'b']);
    expect(s.push('d\r')).toEqual([]);
    expect(s.push('\ne\n')).toEqual(['cd', 'e']);
    expect(s.push('tail')).toEqual([]);
    expect(s.flush()).toEqual(['tail']);
    expect(s.flush()).toEqual([]);
  });
});

describe('AsyncQueue', () => {
  it('delivers buffered and awaited items, then ends after close', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    const it = q[Symbol.asyncIterator]();
    expect(await it.next()).toEqual({ value: 1, done: false });
    const pending = it.next();
    q.push(2);
    expect(await pending).toEqual({ value: 2, done: false });
    q.push(3);
    const waiting = (async () => {
      await it.next(); // 3
      return it.next();
    })();
    q.close();
    q.push(4); // ignored after close
    expect(await waiting).toEqual({ value: undefined, done: true });
    expect(await it.next()).toEqual({ value: undefined, done: true });
  });

  it('keeps items pushed before close', async () => {
    const q = new AsyncQueue<string>();
    q.push('x');
    q.close();
    const items: string[] = [];
    for await (const i of q) items.push(i);
    expect(items).toEqual(['x']);
  });
});

describe('mergeEnv', () => {
  it('drops undefined base values and lets extra win', () => {
    expect(mergeEnv({ A: '1', B: undefined, C: '3' }, { C: 'x', D: '4' })).toEqual({ A: '1', C: 'x', D: '4' });
    expect(mergeEnv({ A: '1' }, undefined)).toEqual({ A: '1' });
  });
});

describe('defaultKillTree', () => {
  function fakeChild(event: 'exit' | 'error'): SpawnFn {
    return () => {
      const c = new EventEmitter() as ChildProcess;
      setImmediate(() => c.emit(event, event === 'error' ? new Error('nope') : 0));
      return c;
    };
  }

  it('win32: taskkill /T, plus /F when forced; resolves on exit or error', async () => {
    const calls: { cmd: string; args: readonly string[]; opts: SpawnOptions }[] = [];
    const spawnFn: SpawnFn = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return fakeChild(calls.length === 1 ? 'exit' : 'error')(cmd, args, opts);
    };
    const kill = defaultKillTree('win32', spawnFn);
    await kill(1234, false);
    await kill(1234, true);
    expect(calls[0]).toMatchObject({ cmd: 'taskkill', args: ['/PID', '1234', '/T'], opts: { windowsHide: true } });
    expect(calls[1]?.args).toEqual(['/PID', '1234', '/T', '/F']);
  });

  it('posix: signals the process group, falls back to the pid, tolerates a gone process', async () => {
    const seen: [number, string | number | undefined][] = [];
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, sig) => {
      seen.push([pid, sig]);
      if (pid < 0 || pid === 999) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      return true;
    });
    const kill = defaultKillTree('linux', fakeChild('exit'));
    await kill(42, false);
    await kill(42, true);
    await kill(999, true);
    expect(seen).toEqual([
      [-42, 'SIGTERM'],
      [42, 'SIGTERM'],
      [-42, 'SIGKILL'],
      [42, 'SIGKILL'],
      [-999, 'SIGKILL'],
      [999, 'SIGKILL'],
    ]);
    killSpy.mockRestore();
  });

  it('posix: group kill succeeds without fallback', async () => {
    const seen: number[] = [];
    vi.spyOn(process, 'kill').mockImplementation((pid) => {
      seen.push(pid);
      return true;
    });
    await defaultKillTree('linux', fakeChild('exit'))(7, false);
    expect(seen).toEqual([-7]);
  });
});

describe('ProcessRunner.run', () => {
  const runner = createProcessRunner({ clock: systemClock, platform: process.platform, baseEnv: process.env });

  it('captures stdout, stderr and the exit code', async () => {
    const out = await runner.run(NODE, ['-e', "process.stdout.write('out');process.stderr.write('err');process.exit(3)"]);
    expect(out).toEqual({ code: 3, stdout: 'out', stderr: 'err', timedOut: false });
  });

  it('passes env, cwd and stdin input', async () => {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'gb-run-')));
    const out = await runner.run(
      NODE,
      ['-e', "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(process.env.GB_FOO+'|'+process.cwd()+'|'+s))"],
      { env: { GB_FOO: 'bar' }, cwd: dir, input: 'hello' },
    );
    expect(out.stdout).toBe(`bar|${dir}|hello`);
  });

  it('survives a child that exits without reading a large input (EPIPE/EOF on stdin)', async () => {
    const out = await runner.run(NODE, ['-e', 'process.exit(0)'], { input: 'x'.repeat(8 * 1024 * 1024) });
    expect(out.code).toBe(0);
  });

  it('caps captured output at 4 MiB per stream', async () => {
    const out = await runner.run(NODE, [
      '-e',
      "const b='y'.repeat(1<<20);for(let i=0;i<6;i++){process.stdout.write(b);process.stderr.write(b)}",
    ]);
    expect(out.stdout.length).toBeGreaterThanOrEqual(4 * 1024 * 1024);
    expect(out.stdout.length).toBeLessThan(6 * 1024 * 1024);
    expect(out.stderr.length).toBeLessThan(6 * 1024 * 1024);
  });

  it('kills the child on timeout', async () => {
    const t0 = Date.now();
    const out = await runner.run(NODE, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 300 });
    expect(out.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it('kills the child on abort, and does not start when already aborted', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const out = await runner.run(NODE, ['-e', 'setInterval(()=>{},1000)'], { signal: ac.signal });
    expect(out.timedOut).toBe(false);
    expect(out.code).not.toBe(0);

    const spawnFn = vi.fn(trackingSpawn);
    const r2 = createProcessRunner({ clock: systemClock, platform: process.platform, baseEnv: {}, spawnFn });
    const pre = await r2.run(NODE, ['-e', ''], { signal: AbortSignal.abort() });
    expect(pre).toEqual({ code: null, stdout: '', stderr: 'aborted before start', timedOut: false });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('reports spawn failures (missing program, synchronous throw)', async () => {
    const missing = await runner.run(path.join(os.tmpdir(), 'gb-definitely-missing-exe'), []);
    expect(missing.code).toBeNull();
    expect(missing.stderr).toMatch(/ENOENT/);

    const throwing = createProcessRunner({
      clock: systemClock,
      platform: 'linux',
      baseEnv: {},
      spawnFn: () => {
        throw new Error('EINVAL sync');
      },
    });
    expect(await throwing.run('x', [])).toEqual({ code: null, stdout: '', stderr: 'Error: EINVAL sync', timedOut: false });
  });

  it('abort before the pid is known is a no-op (spawn error path)', async () => {
    const killTree = vi.fn(async () => {});
    const r = createProcessRunner({
      clock: systemClock,
      platform: 'linux',
      baseEnv: {},
      killTree,
      spawnFn: () => {
        const c = Object.assign(new EventEmitter(), { pid: undefined, stdout: null, stderr: null, stdin: null }) as unknown as ChildProcess;
        setTimeout(() => c.emit('error', new Error('boom')), 30);
        return c;
      },
    });
    const ac = new AbortController();
    const p = r.run('x', [], { signal: ac.signal, timeoutMs: 5 });
    ac.abort();
    const out = await p;
    expect(out.stderr).toContain('boom');
    expect(killTree).not.toHaveBeenCalled();
  });
});

describe('ProcessRunner.spawn', () => {
  const owner = { runId: 'r1', marker: 'gpubench-test' };

  it('streams stdout/stderr lines (flushing the last partial line) and the exit code', async () => {
    const runner = createProcessRunner({ clock: systemClock, platform: process.platform, baseEnv: process.env, spawnFn: trackingSpawn });
    const mp = runner.spawn({
      cmd: NODE,
      args: ['-e', "console.log('one');console.error('two');process.stdout.write('three');process.exit(5)"],
      env: { GB_X: '1' },
      cwd: os.tmpdir(),
      owner,
    });
    expect(mp.pid).toBeGreaterThan(0);
    expect(mp.startedAt).toBeGreaterThan(0);
    const lines = await collect(mp.lines);
    expect(await mp.exited).toEqual({ code: 5, signal: null });
    expect(lines.map((l) => `${l.stream}:${l.text}`).sort()).toEqual(['stderr:two', 'stdout:one', 'stdout:three']);
    // Already exited: stop() just returns the exit info.
    expect(await mp.stop()).toEqual({ code: 5, signal: null });
  });

  it('reports a spawn error as a stderr line and a null exit', async () => {
    const runner = createProcessRunner({ clock: systemClock, platform: process.platform, baseEnv: {} });
    const mp = runner.spawn({ cmd: path.join(os.tmpdir(), 'gb-missing-engine'), args: [], owner });
    expect(mp.pid).toBe(-1);
    const lines = await collect(mp.lines);
    expect(lines.some((l) => l.stream === 'stderr' && /ENOENT/.test(l.text))).toBe(true);
    expect(await mp.exited).toEqual({ code: null, signal: null });
    expect(await mp.stop()).toEqual({ code: null, signal: null });
  });

  it('win32: stop() kills the tree with force at once, and is idempotent', async () => {
    const calls: [number, boolean][] = [];
    const runner = createProcessRunner({
      clock: systemClock,
      platform: 'win32',
      baseEnv: process.env,
      spawnFn: trackingSpawn,
      killTree: async (pid, force) => {
        calls.push([pid, force]);
        process.kill(pid, 'SIGKILL');
      },
    });
    const mp = runner.spawn({ cmd: NODE, args: ['-e', 'setInterval(()=>{},1000)'], owner });
    const first = mp.stop();
    expect(mp.stop()).toBe(first);
    await first;
    expect(calls).toEqual([[mp.pid, true]]);
  });

  it('posix: graceful stop when the process honours the first signal', async () => {
    const calls: boolean[] = [];
    const runner = createProcessRunner({
      clock: systemClock,
      platform: 'linux',
      baseEnv: process.env,
      spawnFn: trackingSpawn,
      killTree: async (pid, force) => {
        calls.push(force);
        process.kill(pid, 'SIGKILL');
      },
    });
    const mp = runner.spawn({ cmd: NODE, args: ['-e', 'setInterval(()=>{},1000)'], owner });
    const t0 = Date.now();
    await mp.stop({ graceMs: 5000 });
    expect(calls).toEqual([false]);
    expect(Date.now() - t0).toBeLessThan(4000);
  });

  it('posix: forces after the grace period when the first signal is ignored (default grace)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const calls: boolean[] = [];
      const runner = createProcessRunner({
        clock: systemClock,
        platform: 'linux',
        baseEnv: process.env,
        spawnFn: trackingSpawn,
        killTree: async (pid, force) => {
          calls.push(force);
          if (force) process.kill(pid, 'SIGKILL');
        },
      });
      const mp = runner.spawn({ cmd: NODE, args: ['-e', 'setInterval(()=>{},1000)'], owner });
      const stopped = mp.stop();
      await vi.advanceTimersByTimeAsync(5001);
      vi.useRealTimers();
      await stopped;
      expect(calls).toEqual([false, true]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes the line iterator when the child has no pipes', async () => {
    const runner = createProcessRunner({
      clock: systemClock,
      platform: 'linux',
      baseEnv: {},
      spawnFn: () => Object.assign(new EventEmitter(), { pid: 77, stdout: null, stderr: null }) as unknown as ChildProcess,
    });
    const mp = runner.spawn({ cmd: 'x', args: [], owner });
    expect(await collect(mp.lines)).toEqual([]);
  });

  it('pipes without data still end cleanly', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { pid: 78, stdout, stderr, exitCode: null, signalCode: null });
    const runner = createProcessRunner({ clock: systemClock, platform: 'linux', baseEnv: {}, spawnFn: () => child as unknown as ChildProcess });
    const mp = runner.spawn({ cmd: 'x', args: [], owner });
    stdout.end('last');
    stderr.end();
    child.emit('exit', null, 'SIGTERM');
    expect((await collect(mp.lines)).map((l) => l.text)).toEqual(['last']);
    expect(await mp.exited).toEqual({ code: null, signal: 'SIGTERM' });
  });
});
