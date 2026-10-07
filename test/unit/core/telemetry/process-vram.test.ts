import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../../../../src/contract/errors';
import type { Clock } from '../../../../src/core/deps';
import { parseComputeApps } from '../../../../src/core/telemetry/parse';
import {
  COMPUTE_APPS_ARGS,
  computeAppsMemory,
  createProcessMemory,
  FIRST_READING_MS,
  nodeProcFs,
  NvidiaSmiGpuMemory,
  parseMonitorLine,
  pollWatch,
  PROCESS_MEMORY_OWNER,
  ProcessVramRecorder,
  RESPAWN_MIN_LIFE_MS,
  WIN_MONITOR_IDLE_MS,
  WIN_MONITOR_RETRY_MS,
  windowsMonitorCommand,
  windowsMonitorScript,
  WindowsGpuMemory,
  withDescendants,
  type GpuMemoryListener,
  type GpuMemorySource,
  type ProcFsReader,
} from '../../../../src/core/telemetry/process-vram';
import type { GpuProcessMemory } from '../../../../src/core/telemetry/types';
import { FakeClock, FakeRunner, fixture, memoryLogger, tick, type FakeProcess } from './fakes';

const MIB = 1024 * 1024;

/** Timers that fire only on advance(); an aborted sleep rejects, like the real clock. */
class ManualClock implements Clock {
  t = 1000;
  private timers: { at: number; resolve: () => void }[] = [];
  now(): number {
    return this.t;
  }
  wall(): number {
    return this.t;
  }
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      const timer = { at: this.t + ms, resolve };
      this.timers.push(timer);
      signal?.addEventListener(
        'abort',
        () => {
          this.timers = this.timers.filter((x) => x !== timer);
          reject(new DOMException('Aborted', 'AbortError'));
        },
        { once: true },
      );
    });
  }
  pending(): number {
    return this.timers.length;
  }
  async advance(ms: number): Promise<void> {
    this.t += ms;
    const due = this.timers.filter((x) => x.at <= this.t);
    this.timers = this.timers.filter((x) => x.at > this.t);
    for (const x of due) x.resolve();
    await tick();
  }
}

const MONITOR = fixture('process-vram/win-monitor.txt').split(/\r?\n/).filter((l) => l !== '');
/** The "N" lines and the first "S" line of the real capture. */
const FIRST_READING = MONITOR.slice(0, MONITOR.findIndex((l) => l.startsWith('S ')) + 1);

function emitAll(p: FakeProcess, lines: readonly string[]): void {
  for (const l of lines) p.emit(l);
}

function monitor(o: { idleMs?: number; spawnThrows?: boolean; log?: boolean; parentPid?: number } = {}) {
  const clock = new ManualClock();
  const runner = new FakeRunner(undefined, clock);
  const log = memoryLogger();
  const proc = o.spawnThrows
    ? {
        run: runner.run.bind(runner),
        spawn: () => {
          throw new Error('spawn EACCES');
        },
      }
    : runner;
  const mem = new WindowsGpuMemory({
    proc,
    clock,
    env: { SYSTEMROOT: 'D:\\Win' },
    ...(o.log === false ? {} : { log }),
    ...(o.idleMs !== undefined ? { idleMs: o.idleMs } : {}),
    parentPid: o.parentPid ?? 777,
  });
  return { clock, runner, log, mem };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('Windows monitor protocol', () => {
  it('builds a single-quoted PowerShell script with the parent watch and the interval', () => {
    const s = windowsMonitorScript({ intervalMs: 999.6, parentPid: 4321.9 });
    expect(s).not.toContain('"');
    expect(s).toContain("PerformanceCounterCategory('GPU Process Memory')");
    expect(s).toContain("$data['Dedicated Usage']");
    expect(s).toContain("$data['Shared Usage']");
    expect(s).toContain("'=' + $sum[$p] + '/' + [int64]$sh[$p]");
    expect(s).toContain('GetProcessById(4321)');
    expect(s).toContain('Start-Sleep -Milliseconds 1000');
    expect(windowsMonitorScript({ intervalMs: 0, parentPid: 1 })).toContain('Start-Sleep -Milliseconds 1');
  });

  it('runs Windows PowerShell from System32 (env var case-insensitive), never from PATH', () => {
    const c = windowsMonitorCommand({ SystemRoot: 'E:\\Windows' }, { intervalMs: 1000, parentPid: 1 });
    expect(c.cmd).toBe('E:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(c.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    expect(windowsMonitorCommand({}, { intervalMs: 1000, parentPid: 1 }).cmd).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  });

  it('parses the real capture: names, then readings summed per pid', () => {
    const parsed = MONITOR.map(parseMonitorLine);
    expect(parsed.every((p) => p !== undefined)).toBe(true);
    expect(parsed[0]).toEqual({ kind: 'name', pid: 12992, name: 'svchost' });
    expect(parsed.find((p) => p?.kind === 'name' && p.pid === 19060)).toEqual({ kind: 'name', pid: 19060, name: 'NVIDIA Overlay' });
    const readings = parsed.filter((p) => p?.kind === 'sample');
    expect(readings).toHaveLength(3);
    const first = readings[0]!.kind === 'sample' ? readings[0]!.bytes : new Map();
    expect(first.size).toBe(30);
    expect(first.get(2260)).toBe(3490496512); // dwm
    expect(first.get(29192)).toBe(24429514752); // vmwp: 23452286976 + 976924672 + 303104 + 0 + 0 (five instances)
  });

  it('per pid it matches Get-Counter summed over every instance (same name repeated, several LUIDs)', () => {
    const sums = new Map<number, number>();
    for (const line of fixture('process-vram/win-get-counter.tsv').split(/\r?\n/)) {
      const m = /^pid_(\d+)_\S*\t(\d+)$/.exec(line);
      if (m) sums.set(Number(m[1]), (sums.get(Number(m[1])) ?? 0) + Number(m[2]));
    }
    const reading = parseMonitorLine(MONITOR.find((l) => l.startsWith('S '))!);
    if (reading?.kind !== 'sample') throw new Error('no reading');
    // Same processes with memory, same totals for the ones that did not move between the two captures.
    expect([...reading.bytes.keys()].sort()).toEqual([...sums].filter(([, b]) => b > 0).map(([p]) => p).sort());
    for (const pid of [2260, 29192, 14064, 1756, 4]) expect(reading.bytes.get(pid), String(pid)).toBe(sums.get(pid));
  });

  it('handles empty readings, duplicates, errors and noise', () => {
    expect(parseMonitorLine('S')).toEqual({ kind: 'sample', bytes: new Map(), shared: new Map() });
    expect(parseMonitorLine(' S 1=10 1=5 x=3 2=-1 3=7 \r')).toEqual({ kind: 'sample', bytes: new Map([[1, 15], [3, 7]]), shared: new Map() });
    // Current monitors add the shared bytes after a slash; old and new entries can mix.
    expect(parseMonitorLine('S 1=10/4 1=5/1 2=7 3=8/x')).toEqual({ kind: 'sample', bytes: new Map([[1, 15], [2, 7]]), shared: new Map([[1, 5]]) });
    expect(parseMonitorLine('E Categoria non trovata.')).toEqual({ kind: 'error', message: 'Categoria non trovata.' });
    for (const l of ['', 'Sx', 'N x name', 'N 12', 'hello', 'E']) expect(parseMonitorLine(l), l).toBeUndefined();
  });
});

describe('WindowsGpuMemory', () => {
  it('read() spawns one monitor (ours, from System32), waits for the first reading and converts bytes to MiB', async () => {
    const { mem, runner, clock } = monitor();
    const [a, b] = [mem.read(), mem.read()];
    await tick();
    expect(runner.spawned).toHaveLength(1);
    const child = runner.spawned[0]!;
    expect(child.spec.cmd).toBe('D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(child.spec.args.at(-1)).toContain('GetProcessById(777)');
    expect(child.spec.owner).toEqual(PROCESS_MEMORY_OWNER);
    expect(mem.running).toBe(true);
    emitAll(child, FIRST_READING);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toBe(rb);
    expect(ra).toHaveLength(30);
    expect(ra!.find((p) => p.pid === 29192)).toEqual({ pid: 29192, mib: 24429514752 / MIB, name: "vmwp" });
    // Within 2 intervals the latest reading is served without waiting.
    await clock.advance(1500);
    expect(await mem.read()).toBe(ra);
    expect(runner.spawned).toHaveLength(1);
    // Older than that (monitor stuck): waits for the next one.
    await clock.advance(1000);
    const stale = mem.read();
    child.emit('S 1=1048576');
    expect(await stale).toEqual([{ pid: 1, mib: 1 }]);
    await mem.dispose();
    expect(child.stopCalls).toBe(1);
    expect(mem.running).toBe(false);
  });

  it('reports the shared GPU memory of each process when the monitor sends it (a model spilling to system RAM)', async () => {
    const { mem, runner } = monitor();
    const reading = mem.read();
    await tick();
    const child = runner.spawned[0]!;
    child.emit('N 42 llama-server');
    child.emit(`S 42=${30_000 * MIB}/${6_000 * MIB} 9=${MIB}`);
    expect(await reading).toEqual([
      { pid: 42, mib: 30_000, name: 'llama-server', sharedMib: 6_000 },
      { pid: 9, mib: 1 },
    ]);
    await mem.dispose();
  });

  it('defaults the parent to the core itself', async () => {
    const clock = new ManualClock();
    const runner = new FakeRunner(undefined, clock);
    const mem = new WindowsGpuMemory({ proc: runner, clock, env: {} });
    void mem.read();
    expect(runner.spawned[0]!.spec.args.at(-1)).toContain(`GetProcessById(${process.pid})`);
    await mem.dispose();
  });

  it('watch(): every reading to every listener; a warm monitor delivers the latest one at once; idle stop', async () => {
    const { mem, runner, clock, log } = monitor({ idleMs: 5000 });
    const seen: number[] = [];
    const w1 = mem.watch(1000, (t, procs) => seen.push(procs.length));
    expect(runner.spawned).toHaveLength(1);
    const child = runner.spawned[0]!;
    emitAll(child, FIRST_READING);
    await tick();
    expect(seen).toEqual([30]);
    const bad: GpuMemoryListener = () => {
      throw new Error('listener bug');
    };
    const w2 = mem.watch(1000, bad);
    expect(log.entries).toEqual([{ level: 'warn', msg: 'GPU process memory listener failed' }]);
    child.emit('S 4=1048576 5=2097152');
    await tick();
    expect(seen).toEqual([30, 2]);
    await w1.stop();
    await w2.stop();
    // No listener, but demand is recent: keeps running.
    child.emit('S 4=1048576');
    await tick();
    expect(child.stopCalls).toBe(0);
    await clock.advance(5000);
    child.emit('S 4=1048576');
    await tick();
    expect(child.stopCalls).toBe(1);
    expect(mem.running).toBe(false);
    // The next reader starts a fresh monitor (no stale reading served).
    const again = mem.read();
    await tick();
    expect(runner.spawned).toHaveLength(2);
    runner.spawned[1]!.emit('S 9=1048576');
    expect(await again).toEqual([{ pid: 9, mib: 1 }]);
    await mem.dispose();
  });

  it('forgets names of processes that are gone (a reused PID gets its new name)', async () => {
    const { mem, runner } = monitor();
    const r1 = mem.read();
    const child = runner.spawned[0]!;
    emitAll(child, ['N 10 old', 'S 10=1048576']);
    expect(await r1).toEqual([{ pid: 10, mib: 1, name: 'old' }]);
    const got: (readonly GpuProcessMemory[])[] = [];
    mem.watch(1000, (_t, p) => got.push(p));
    emitAll(child, ['S 11=1048576', 'N 10 new', 'S 10=2097152']);
    await tick();
    expect(got.slice(1)).toEqual([[{ pid: 11, mib: 1 }], [{ pid: 10, mib: 2, name: 'new' }]]);
    await mem.dispose();
  });

  it('a monitor that exits without a reading marks the source failed (reason logged once), retried later', async () => {
    const { mem, runner, clock, log } = monitor();
    const r = mem.read();
    const child = runner.spawned[0]!;
    child.emit('E Impossibile trovare la categoria specificata.');
    child.exit(3);
    expect(await r).toBeUndefined();
    expect(log.entries).toEqual([{ level: 'warn', msg: 'per-process GPU memory unavailable' }]);
    // Within the retry window nothing is spawned.
    expect(await mem.read()).toBeUndefined();
    expect(mem.watch(1000, () => undefined)).toBeDefined();
    expect(runner.spawned).toHaveLength(1);
    await clock.advance(WIN_MONITOR_RETRY_MS);
    const r2 = mem.read();
    const second = runner.spawned[1]!;
    second.emit('PowerShell blew up', 'stderr');
    second.emit('   ', 'stderr');
    second.exit(1);
    expect(await r2).toBeUndefined();
    expect(log.entries).toHaveLength(1);
    await clock.advance(WIN_MONITOR_RETRY_MS);
    const r3 = mem.read();
    runner.spawned[2]!.exit(0);
    expect(await r3).toBeUndefined();
  });

  it('a silent monitor is stopped after the first-reading timeout; spawn errors fail too (without a logger)', async () => {
    const { mem, runner, clock } = monitor({ log: false });
    const r = mem.read();
    await tick();
    expect(clock.pending()).toBe(1);
    await clock.advance(FIRST_READING_MS);
    expect(await r).toBeUndefined();
    expect(runner.spawned[0]!.stopCalls).toBe(1);
    expect(mem.running).toBe(false);

    const broken = monitor({ spawnThrows: true });
    expect(await broken.mem.read()).toBeUndefined();
    expect(broken.log.entries).toEqual([{ level: 'warn', msg: 'per-process GPU memory unavailable' }]);
  });

  it('a watched monitor that dies is respawned only if it lived long enough', async () => {
    const { mem, runner, clock } = monitor();
    mem.watch(1000, () => undefined);
    const first = runner.spawned[0]!;
    first.emit('S 1=1');
    await clock.advance(RESPAWN_MIN_LIFE_MS);
    first.exit(1);
    await tick();
    expect(runner.spawned).toHaveLength(2);
    const second = runner.spawned[1]!;
    second.emit('S 1=1');
    second.exit(1);
    await tick();
    expect(runner.spawned).toHaveLength(2);
    expect(mem.running).toBe(false);
    await mem.dispose();
  });

  it('a reading that is late but arrives after the timeout started still counts', async () => {
    const { mem, runner, clock } = monitor();
    const r = mem.read();
    await tick();
    runner.spawned[0]!.emit('S 2=1048576');
    expect(await r).toEqual([{ pid: 2, mib: 1 }]);
    expect(clock.pending()).toBe(0);
    await clock.advance(FIRST_READING_MS);
    expect(runner.spawned[0]!.stopCalls).toBe(0);
    await mem.dispose();
  });

  it('a timeout after the monitor already produced readings does not fail it', async () => {
    const { mem, runner, clock } = monitor();
    const r1 = mem.read();
    const child = runner.spawned[0]!;
    child.emit('S 2=1048576');
    await r1;
    await clock.advance(5000);
    const r2 = mem.read();
    await tick();
    await clock.advance(FIRST_READING_MS);
    expect(await r2).toEqual([{ pid: 2, mib: 1 }]);
    expect(child.stopCalls).toBe(0);
    await mem.dispose();
  });

  it('idle timeout default is 30 s', () => {
    expect(WIN_MONITOR_IDLE_MS).toBe(30_000);
  });
});

describe('Linux: nvidia-smi compute-apps', () => {
  it('sums a process listed on several GPUs, drops [N/A] rows, keeps names', () => {
    const procs = computeAppsMemory(parseComputeApps(fixture('process-vram/linux-compute-apps.csv')));
    expect(procs).toEqual([
      { pid: 41000, mib: 1024, name: 'VLLM::EngineCore' },
      { pid: 41077, mib: 30180, name: 'VLLM::Worker_TP0' },
      { pid: 41078, mib: 30180, name: 'VLLM::Worker_TP1' },
      { pid: 5150, mib: 4800, name: '/usr/local/bin/ollama' },
      { pid: 7171, mib: 768, name: '/usr/bin/python3' },
    ]);
    expect(computeAppsMemory(parseComputeApps(fixture('process-vram/win-compute-apps.csv')))).toEqual([]);
  });

  it('read(): [] without GPUs, undefined when nvidia-smi fails', async () => {
    const calls: string[][] = [];
    const ok = new NvidiaSmiGpuMemory({ text: async (a) => (calls.push(a), fixture('process-vram/linux-compute-apps.csv')) }, new FakeClock());
    expect(await ok.read()).toHaveLength(5);
    expect(calls).toEqual([COMPUTE_APPS_ARGS]);
    const none = new NvidiaSmiGpuMemory({ text: () => Promise.reject(new AppError('GPU_NOT_FOUND', 'none')) }, new FakeClock());
    expect(await none.read()).toEqual([]);
    const broken = new NvidiaSmiGpuMemory({ text: () => Promise.reject(new AppError('DRIVER_MISSING', 'gone')) }, new FakeClock());
    expect(await broken.read()).toBeUndefined();
    const weird = new NvidiaSmiGpuMemory({ text: () => Promise.reject(new Error('boom')) }, new FakeClock());
    expect(await weird.read()).toBeUndefined();
  });

  it('watch() polls every interval until stopped; a failed reading or a throwing listener does not end it', async () => {
    const clock = new ManualClock();
    const log = memoryLogger();
    let n = 0;
    const mem = new NvidiaSmiGpuMemory(
      { text: async () => (++n === 2 ? Promise.reject(new AppError('DRIVER_MISSING', 'blip')) : `${n}, /usr/bin/llama-server, ${n * 100}`) },
      clock,
      log,
    );
    const got: number[] = [];
    const w = mem.watch(500, (_t, procs) => {
      got.push(procs[0]!.mib);
      if (procs[0]!.mib === 300) throw new Error('listener bug');
    });
    await tick();
    expect(got).toEqual([100]);
    await clock.advance(500);
    expect(got).toEqual([100]);
    await clock.advance(500);
    await clock.advance(500);
    expect(got).toEqual([100, 300, 400]);
    expect(log.entries).toEqual([{ level: 'warn', msg: 'GPU process memory listener failed' }]);
    await w.stop();
    await clock.advance(5000);
    expect(got).toHaveLength(3);
  });

  it('pollWatch: a reading that lands after stop() is dropped; a throwing listener without a logger is ignored', async () => {
    const clock = new ManualClock();
    let release!: (v: GpuProcessMemory[]) => void;
    const got: number[] = [];
    const w = pollWatch(clock, 100, () => new Promise((r) => (release = r)), () => got.push(1));
    await tick();
    const stopped = w.stop();
    release([{ pid: 1, mib: 1 }]);
    await stopped;
    expect(got).toEqual([]);

    const w2 = pollWatch(clock, 100, async () => [{ pid: 1, mib: 1 }], () => {
      throw new Error('x');
    });
    await tick();
    await w2.stop();
  });
});

describe('withDescendants', () => {
  function fakeFs(tree: Record<number, Record<string, string | null>>): ProcFsReader {
    return {
      readdir: async (p) => {
        const pid = Number(/\/(\d+)\/task$/.exec(p)?.[1]);
        const t = tree[pid];
        if (!t) throw new Error('ENOENT');
        return Object.keys(t);
      },
      readFile: async (p) => {
        const m = /\/(\d+)\/task\/(\w+)\/children$/.exec(p);
        const v = tree[Number(m?.[1])]?.[m?.[2] ?? ''];
        if (v === undefined || v === null) throw new Error('ENOENT');
        return v;
      },
    };
  }

  it('walks every thread of every process, depth first, without loops or garbage', async () => {
    const fsr = fakeFs({
      100: { '100': '101 102 ', '105': '103\n' },
      101: { '101': '' },
      102: { '102': '104 100 x -3 0' },
      103: { '103': '', '107': 'missing', '108': null },
      104: { '104': '' },
    });
    expect((await withDescendants([100], fsr, '/proc')).sort()).toEqual([100, 101, 102, 103, 104]);
    expect(await withDescendants([555], fsr)).toEqual([555]);
    expect(await withDescendants([], fsr)).toEqual([]);
    expect((await withDescendants([100], fsr, '/proc', 2)).length).toBe(2);
  });

  it('reads a real directory laid out like /proc', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'gb-proc-'));
    dirs.push(root);
    const thread = (pid: number, tid: number, children: string) => {
      mkdirSync(path.join(root, String(pid), 'task', String(tid)), { recursive: true });
      writeFileSync(path.join(root, String(pid), 'task', String(tid), 'children'), children);
    };
    thread(41000, 41000, '41077 ');
    thread(41000, 41003, '41078 ');
    thread(41077, 41077, '');
    thread(41078, 41078, '');
    expect((await withDescendants([41000], nodeProcFs, root.replace(/\\/g, '/'))).sort()).toEqual([41000, 41077, 41078]);
  });
});

/** A source driven by the test: tick() delivers a reading to the current watcher. */
class ManualSource implements GpuMemorySource {
  listener: GpuMemoryListener | undefined;
  stops = 0;
  constructor(private readonly warm?: readonly GpuProcessMemory[]) {}
  read(): Promise<GpuProcessMemory[] | undefined> {
    return Promise.resolve(undefined);
  }
  watch(_ms: number, onTick: GpuMemoryListener) {
    this.listener = onTick;
    if (this.warm) onTick(1, this.warm);
    return {
      stop: () => {
        this.stops++;
        return Promise.resolve();
      },
    };
  }
  tick(t: number, procs: GpuProcessMemory[]): void {
    this.listener?.(t, procs);
  }
}

describe('ProcessVramRecorder', () => {
  it('attributes the PIDs the function returns at each reading; latest/peak in whole MiB', async () => {
    const source = new ManualSource();
    const clock = new ManualClock();
    let pids: number[] = [];
    const rec = new ProcessVramRecorder({ source, clock, pids: () => pids, intervalMs: 1000 });
    let ready = false;
    void rec.ready.then(() => (ready = true));
    expect(rec.latestMiB()).toBeUndefined();
    source.tick(1000, [{ pid: 9, mib: 3000, name: 'dwm' }]);
    await tick();
    expect(ready).toBe(true);
    expect(clock.pending()).toBe(0);
    pids = [50];
    source.tick(2000, [{ pid: 9, mib: 3000 }]);
    expect(rec.latestMiB()).toBeUndefined();
    source.tick(3000, [{ pid: 9, mib: 3000 }, { pid: 50, mib: 4100.4 }]);
    expect(rec.latestMiB()).toBe(4100);
    source.tick(4000, [{ pid: 50, mib: 0 }]);
    expect(rec.latestMiB()).toBe(0);
    pids = [];
    source.tick(5000, [{ pid: 50, mib: 300 }]);
    expect(rec.latestMiB()).toBeUndefined();
    expect(rec.peakMiB()).toBe(4100);
    expect(rec.samples.map((s) => [s.engine, Math.round(s.engineMiB)])).toEqual([
      [[], 0],
      [[50], 0],
      [[50], 4100],
      [[50], 0],
      [[], 0],
    ]);
    const all = await rec.stop();
    expect(await rec.stop()).toEqual(all);
    expect(source.stops).toBe(1);
    source.tick(6000, [{ pid: 50, mib: 1 }]);
    expect(rec.samples).toHaveLength(5);
  });

  it('keeps the engine’s shared GPU memory per reading and its peak; none reported = undefined', async () => {
    const source = new ManualSource();
    const rec = new ProcessVramRecorder({ source, clock: new ManualClock(), pids: [50, 51], intervalMs: 1000 });
    source.tick(1000, [{ pid: 50, mib: 100 }]);
    expect(rec.sharedPeakMiB()).toBeUndefined();
    source.tick(2000, [
      { pid: 50, mib: 30_000, sharedMib: 2_000.4 },
      { pid: 51, mib: 10, sharedMib: 1_000 },
      { pid: 9, mib: 5, sharedMib: 9_999 },
    ]);
    source.tick(3000, [{ pid: 50, mib: 30_000, sharedMib: 10 }]);
    expect(rec.sharedPeakMiB()).toBe(3000);
    expect(rec.samples.map((s) => s.engineSharedMiB)).toEqual([undefined, 3000.4, 10]);
    await rec.stop();
  });

  it('a fixed PID list; a warm source makes it ready at once; the first reading survives the cap', async () => {
    const source = new ManualSource([{ pid: 7, mib: 10 }]);
    const rec = new ProcessVramRecorder({ source, clock: new ManualClock(), pids: [7], intervalMs: 1000, maxTicks: 3 });
    await rec.ready;
    expect(rec.peakMiB()).toBe(10);
    for (let i = 2; i <= 6; i++) source.tick(i, [{ pid: 7, mib: i }]);
    expect(rec.samples.map((s) => s.t)).toEqual([1, 5, 6]);
  });

  it('ready resolves after the timeout when no reading comes; nothing attributed', async () => {
    const clock = new ManualClock();
    const rec = new ProcessVramRecorder({ source: new ManualSource(), clock, pids: [1], intervalMs: 1000, firstReadingMs: 3000 });
    let ready = false;
    void rec.ready.then(() => (ready = true));
    await clock.advance(2999);
    expect(ready).toBe(false);
    await clock.advance(1);
    expect(ready).toBe(true);
    expect(rec.peakMiB()).toBeUndefined();
    expect(await rec.stop()).toEqual([]);
  });

  it('adds descendants (vLLM workers) from the next reading on; a failed expansion is ignored', async () => {
    const source = new ManualSource();
    let roots = [100];
    const calls: number[][] = [];
    let fail = false;
    const rec = new ProcessVramRecorder({
      source,
      clock: new ManualClock(),
      pids: () => roots,
      intervalMs: 1000,
      expand: async (p) => {
        calls.push(p);
        if (fail) throw new Error('ENOENT');
        return [...p, p[0]! + 1];
      },
    });
    const procs = [
      { pid: 100, mib: 500 },
      { pid: 101, mib: 20000 },
      { pid: 201, mib: 7 },
    ];
    source.tick(1, procs);
    expect(rec.latestMiB()).toBe(500);
    await tick();
    source.tick(2, procs);
    expect(rec.latestMiB()).toBe(20500);
    expect(rec.samples[1]!.engine).toEqual([100, 101]);
    // A new instance: its own family, the old one is not reused (one expansion at a time).
    roots = [200];
    fail = true;
    source.tick(3, procs);
    expect(rec.samples[2]!.engine).toEqual([200]);
    await tick();
    source.tick(4, procs);
    await tick();
    source.tick(5, procs);
    expect(rec.samples[4]!.engine).toEqual([200]);
    roots = [];
    await tick();
    source.tick(6, procs);
    expect(calls).toEqual([[100], [100], [200], [200]]);
    await rec.stop();
  });

  it('stop() waits for an expansion in flight', async () => {
    const source = new ManualSource();
    let release!: (v: number[]) => void;
    const rec = new ProcessVramRecorder({ source, clock: new ManualClock(), pids: [1], intervalMs: 1000, expand: () => new Promise((r) => (release = r)) });
    source.tick(1, [{ pid: 1, mib: 1 }]);
    let done = false;
    const stopped = rec.stop().then(() => (done = true));
    await tick();
    expect(done).toBe(false);
    release([1]);
    await stopped;
    expect(done).toBe(true);
  });
});

describe('createProcessMemory', () => {
  const cli = { text: async () => fixture('process-vram/linux-compute-apps.csv') };
  const base = { proc: new FakeRunner(), clock: new FakeClock(), env: {}, cli };

  it('Windows: one monitor for runs and user lists; none with a stand-in nvidia-smi', async () => {
    const win = createProcessMemory({ ...base, platform: 'win32', overridden: false, log: memoryLogger(), windows: { idleMs: 1 } });
    expect(win.processMemory).toBeInstanceOf(WindowsGpuMemory);
    expect(win.userMemory).toBe(win.processMemory);
    expect(win.expandPids).toBeUndefined();
    expect(createProcessMemory({ ...base, platform: 'win32', overridden: false }).processMemory).toBeInstanceOf(WindowsGpuMemory);
    expect(createProcessMemory({ ...base, platform: 'win32', overridden: true })).toEqual({});
  });

  it('a stand-in monitor (tests, fakes), on any OS: its own command with the interval and the parent; only the engine’s memory', async () => {
    expect(windowsMonitorCommand({}, { intervalMs: 500.4, parentPid: 42, command: ['node', 'fake-gpu-memory.mjs'] })).toEqual({
      cmd: 'node',
      args: ['fake-gpu-memory.mjs', '--interval-ms', '500', '--parent', '42'],
    });
    const proc = new FakeRunner();
    const linux = createProcessMemory({ ...base, proc, platform: 'linux', overridden: true, monitor: ['node', 'fake-gpu-memory.mjs'], windows: { parentPid: 7 } });
    expect(linux.processMemory).toBeInstanceOf(WindowsGpuMemory);
    expect(linux.userMemory).toBeUndefined();
    expect(linux.expandPids).toBeUndefined();
    const seen: GpuProcessMemory[][] = [];
    const watch = linux.processMemory!.watch(1000, (_t, procs) => seen.push([...procs]));
    expect(proc.spawned[0]!.spec).toMatchObject({ cmd: 'node', args: ['fake-gpu-memory.mjs', '--interval-ms', '1000', '--parent', '7'] });
    proc.spawned[0]!.emit('S 9=1048576/2097152');
    await tick();
    expect(seen).toEqual([[{ pid: 9, mib: 1, sharedMib: 2 }]]);
    await watch.stop();
    const win = createProcessMemory({ ...base, platform: 'win32', overridden: true, log: memoryLogger(), monitor: ['fake'] });
    expect(win.processMemory).toBeInstanceOf(WindowsGpuMemory);
  });

  it('Linux: nvidia-smi per process plus /proc descendants; nothing elsewhere', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'gb-proc-'));
    dirs.push(root);
    mkdirSync(path.join(root, '5', 'task', '5'), { recursive: true });
    writeFileSync(path.join(root, '5', 'task', '5', 'children'), '6');
    const linux = createProcessMemory({ ...base, platform: 'linux', overridden: true, procRoot: root.replace(/\\/g, '/') });
    expect(linux.processMemory).toBeInstanceOf(NvidiaSmiGpuMemory);
    expect(linux.userMemory).toBeUndefined();
    expect(await linux.processMemory!.read()).toHaveLength(5);
    expect((await linux.expandPids!([5])).sort()).toEqual([5, 6]);
    expect(createProcessMemory({ ...base, platform: 'darwin', overridden: false })).toEqual({});
  });
});
