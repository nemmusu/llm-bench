/**
 * Per-process VRAM: how much dedicated GPU memory each process holds.
 *
 *  - Windows (WDDM): nvidia-smi reports used_memory "[N/A]" per process, but Windows keeps per-process
 *    GPU counters (`\GPU Process Memory(pid_<PID>_luid_…_phys_0[#n])\Dedicated Usage`, bytes; and
 *    `Shared Usage`: system RAM the GPU uses for the process — when a model does not fit, WDDM moves
 *    part of it there instead of failing and everything gets ~10× slower). typeperf
 *    cannot follow a process we just spawned: it expands the pid wildcard once at start ("no valid
 *    counters" while the engine has not opened the GPU yet) and its CSV header is fixed, so instances
 *    created later are never reported. One long-running Windows PowerShell child therefore re-reads the
 *    whole category through .NET (`PerformanceCounterCategory.ReadCategory()`, < 1 ms per read, new
 *    instances included) once per interval and prints one line per reading. It is OUR child: it exits
 *    when the core is gone (parent watch, or its next write to a closed pipe fails), when stopped, or
 *    after `idleMs` without readers.
 *  - Linux: `nvidia-smi --query-compute-apps` gives MiB per PID directly; engine PIDs are expanded with
 *    their descendants (vLLM workers) from /proc/<pid>/task/<tid>/children.
 *
 * Engines running in Docker / WSL on Windows live inside vmwp and cannot be attributed: their PID list
 * is empty and the recorder reports no engine VRAM (the runner keeps the total-delta method).
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { isAppError } from '../../contract/errors';
import type { Clock, Logger, ManagedProcess, Platform, ProcessRunner } from '../deps';
import { envGet, type NvidiaSmiCli } from './nvidia-smi';
import { parseComputeApps, type ComputeApp } from './parse';
import type { GpuProcessMemory, PidSource, ProcessVramSession, ProcessVramTick } from './types';

const MIB = 1024 * 1024;
/** Default interval of the Windows monitor and of the Linux nvidia-smi polling. */
export const PROCESS_VRAM_INTERVAL_MS = 1000;
/** nvidia-smi / PowerShell need some time per reading: faster polling only burns CPU. */
export const MIN_PROCESS_VRAM_INTERVAL_MS = 250;
/** The Windows monitor stops this long after the last reader (the UI polls /api/system meanwhile). */
export const WIN_MONITOR_IDLE_MS = 30_000;
/** PowerShell start + first counter read take ~1.2 s here; give up on a monitor silent this long. */
export const FIRST_READING_MS = 8000;
/** A failed monitor (no counters, no PowerShell) is retried after this long. */
export const WIN_MONITOR_RETRY_MS = 60_000;
/** A monitor that dies while watched is respawned only if it lived at least this long (no respawn loops). */
export const RESPAWN_MIN_LIFE_MS = 10_000;
/** Readings kept per session (the first one is always kept: it is the reference for others' drift). */
export const MAX_PROCESS_TICKS = 20_000;
/** Owner recorded for the monitor child. */
export const PROCESS_MEMORY_OWNER = { runId: 'telemetry', marker: 'gpu-process-memory' } as const;
/** Same query as otherGpuUsers: one nvidia-smi call serves both. */
export const COMPUTE_APPS_ARGS = ['--query-compute-apps=pid,process_name,used_memory', '--format=csv,noheader,nounits'];

const noop = (): undefined => undefined;

export type GpuMemoryListener = (t: number, procs: readonly GpuProcessMemory[]) => void;

export interface GpuMemoryWatch {
  stop(): Promise<void>;
}

/** Where per-process VRAM comes from (Windows GPU counters, nvidia-smi compute-apps). */
export interface GpuMemorySource {
  /** Every process holding GPU memory now; undefined when the OS cannot tell. Never rejects. */
  read(): Promise<GpuProcessMemory[] | undefined>;
  /** Periodic readings until stop(). A warm source may deliver the first reading synchronously. */
  watch(intervalMs: number, onTick: GpuMemoryListener): GpuMemoryWatch;
}

// ---- Windows ------------------------------------------------------------------------------

/**
 * The monitor script. Protocol, one line each: `N <pid> <name>` (process name, before the first
 * reading that lists the pid), `S <pid>=<dedicated>/<shared> …` (one reading, bytes: Dedicated and
 * Shared Usage summed over every instance of the pid — several LUIDs and duplicate "#n" instances
 * exist per process; listed when it holds dedicated memory), `E <message>`. Only single quotes: the
 * script travels as one -Command argument.
 */
export function windowsMonitorScript(o: { intervalMs: number; parentPid: number }): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }',
    '$out = [Console]::Out',
    "try { $cat = New-Object System.Diagnostics.PerformanceCounterCategory('GPU Process Memory'); $null = $cat.ReadCategory() } catch { $out.WriteLine('E ' + $_.Exception.Message); $out.Flush(); exit 3 }",
    `try { $parent = [System.Diagnostics.Process]::GetProcessById(${Math.trunc(o.parentPid)}) } catch { exit 0 }`,
    '$names = @{}',
    'while ($true) {',
    '  $sum = @{}',
    '  $sh = @{}',
    "  try { $data = $cat.ReadCategory(); $col = $data['Dedicated Usage']; foreach ($k in $col.Keys) { if ($k -match '^pid_(\\d+)_') { $p = [int]$Matches[1]; $sum[$p] = [int64]$sum[$p] + [int64]$col[$k].RawValue } }; $scol = $data['Shared Usage']; if ($scol) { foreach ($k in $scol.Keys) { if ($k -match '^pid_(\\d+)_') { $p = [int]$Matches[1]; $sh[$p] = [int64]$sh[$p] + [int64]$scol[$k].RawValue } } } } catch { $out.WriteLine('E ' + $_.Exception.Message) }",
    '  $new = @($sum.Keys | Where-Object { $sum[$_] -gt 0 -and -not $names.ContainsKey($_) })',
    "  if ($new.Count -gt 0) { $all = @{}; foreach ($q in [System.Diagnostics.Process]::GetProcesses()) { $all[$q.Id] = $q.ProcessName }; foreach ($p in $new) { $n = [string]$all[$p]; $names[$p] = $n; if ($n) { $out.WriteLine('N ' + $p + ' ' + $n) } } }",
    '  foreach ($p in @($names.Keys)) { if (-not $sum.ContainsKey($p) -or $sum[$p] -le 0) { $names.Remove($p) } }',
    "  $line = 'S'",
    "  foreach ($p in $sum.Keys) { if ($sum[$p] -gt 0) { $line += ' ' + $p + '=' + $sum[$p] + '/' + [int64]$sh[$p] } }",
    '  $out.WriteLine($line); $out.Flush()',
    '  if ($parent.HasExited) { break }',
    `  Start-Sleep -Milliseconds ${Math.max(1, Math.round(o.intervalMs))}`,
    '}',
  ].join('\n');
}

/** Windows PowerShell 5.1 from System32 (absolute: a planted powershell.exe on PATH is never picked). */
export function windowsMonitorCommand(
  env: Record<string, string | undefined>,
  o: { intervalMs: number; parentPid: number },
): { cmd: string; args: string[] } {
  const root = envGet(env, 'SystemRoot', 'win32') ?? 'C:\\Windows';
  return {
    cmd: path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoProfile', '-NonInteractive', '-Command', windowsMonitorScript(o)],
  };
}

export type MonitorLine =
  /** Dedicated bytes per pid, and shared bytes per pid when the monitor reports them. */
  | { kind: 'sample'; bytes: Map<number, number>; shared: Map<number, number> }
  | { kind: 'name'; pid: number; name: string }
  | { kind: 'error'; message: string };

/** One line of the monitor; undefined for anything else (PowerShell noise, partial lines). */
export function parseMonitorLine(line: string): MonitorLine | undefined {
  const text = line.trim();
  if (text === 'S' || text.startsWith('S ')) {
    const bytes = new Map<number, number>();
    const shared = new Map<number, number>();
    for (const part of text.slice(1).trim().split(/\s+/)) {
      // "pid=dedicated" (older monitors) or "pid=dedicated/shared".
      const m = /^(\d+)=(\d+)(?:\/(\d+))?$/.exec(part);
      if (!m) continue;
      const pid = Number(m[1]);
      bytes.set(pid, (bytes.get(pid) ?? 0) + Number(m[2]));
      if (m[3] !== undefined) shared.set(pid, (shared.get(pid) ?? 0) + Number(m[3]));
    }
    return { kind: 'sample', bytes, shared };
  }
  const n = /^N (\d+) (.+)$/.exec(text);
  if (n) return { kind: 'name', pid: Number(n[1]), name: (n[2] as string).trim() };
  if (text.startsWith('E ')) return { kind: 'error', message: text.slice(2).trim() };
  return undefined;
}

export interface WindowsGpuMemoryOptions {
  proc: ProcessRunner;
  clock: Clock;
  env: Record<string, string | undefined>;
  log?: Logger;
  intervalMs?: number;
  idleMs?: number;
  firstReadingMs?: number;
  retryMs?: number;
  /** The monitor exits when this process is gone (default: the core itself). */
  parentPid?: number;
}

interface Reading {
  t: number;
  procs: GpuProcessMemory[];
}

/**
 * Windows GPU counters through one shared monitor child, started on demand: by read() (the system
 * page, run preflight) or watch() (a run). Watchers keep it alive; without them it stops `idleMs`
 * after the last read, so polling /api/system costs one reading per interval, not one PowerShell per call.
 */
export class WindowsGpuMemory implements GpuMemorySource {
  private child: ManagedProcess | undefined;
  private childReadings = 0;
  private latest: Reading | undefined;
  private readonly names = new Map<number, string>();
  private readonly listeners = new Set<GpuMemoryListener>();
  private waiters: (() => void)[] = [];
  private lastDemand = Number.NEGATIVE_INFINITY;
  private failedAt: number | undefined;
  private warned = false;

  constructor(private readonly o: WindowsGpuMemoryOptions) {}

  /** true while the monitor child runs. */
  get running(): boolean {
    return this.child !== undefined;
  }

  private get intervalMs(): number {
    return this.o.intervalMs ?? PROCESS_VRAM_INTERVAL_MS;
  }

  async read(): Promise<GpuProcessMemory[] | undefined> {
    const now = this.o.clock.now();
    this.lastDemand = now;
    const cur = this.latest;
    if (this.child && cur && now - cur.t <= 2 * this.intervalMs) return cur.procs;
    if (!this.ensure()) return undefined;
    await this.nextReading();
    return this.latest?.procs;
  }

  /** The monitor has a fixed interval (`intervalMs` option): the argument is ignored. */
  watch(_intervalMs: number, onTick: GpuMemoryListener): GpuMemoryWatch {
    this.listeners.add(onTick);
    const cur = this.latest;
    if (this.child && cur) this.notify(onTick, cur);
    else this.ensure();
    return {
      stop: () => {
        this.listeners.delete(onTick);
        this.lastDemand = this.o.clock.now();
        return Promise.resolve();
      },
    };
  }

  /** Stops the monitor now (tests, shutdown); a later read starts it again. */
  async dispose(): Promise<void> {
    this.listeners.clear();
    await this.child?.stop({ graceMs: 0 });
  }

  /** Starts the monitor unless it runs or failed recently. false = no readings to expect. */
  private ensure(): boolean {
    if (this.child) return true;
    if (this.failedAt !== undefined && this.o.clock.now() - this.failedAt < (this.o.retryMs ?? WIN_MONITOR_RETRY_MS)) return false;
    let child: ManagedProcess;
    try {
      const command = windowsMonitorCommand(this.o.env, { intervalMs: this.intervalMs, parentPid: this.o.parentPid ?? process.pid });
      child = this.o.proc.spawn({ ...command, owner: { ...PROCESS_MEMORY_OWNER } });
    } catch (e) {
      this.fail(String(e));
      return false;
    }
    this.child = child;
    this.childReadings = 0;
    this.latest = undefined;
    void this.consume(child);
    return true;
  }

  private async consume(child: ManagedProcess): Promise<void> {
    let problem: string | undefined;
    for await (const line of child.lines) {
      const m = line.stream === 'stdout' ? parseMonitorLine(line.text) : undefined;
      if (m?.kind === 'name') this.names.set(m.pid, m.name);
      else if (m?.kind === 'sample') this.onReading(child, line.t, m.bytes, m.shared);
      else if (m?.kind === 'error') problem = m.message;
      else if (line.stream === 'stderr' && line.text.trim()) problem ??= line.text.trim();
    }
    const lived = this.o.clock.now() - child.startedAt;
    this.child = undefined;
    if (this.childReadings === 0) this.fail(problem ?? 'the monitor exited without a reading');
    else if (this.listeners.size > 0 && lived >= RESPAWN_MIN_LIFE_MS) this.ensure();
    this.wake();
  }

  private onReading(child: ManagedProcess, t: number, bytes: ReadonlyMap<number, number>, shared: ReadonlyMap<number, number>): void {
    // Names of processes that are gone are dropped: a reused PID gets its new name.
    for (const pid of [...this.names.keys()]) if (!bytes.has(pid)) this.names.delete(pid);
    const procs: GpuProcessMemory[] = [];
    for (const [pid, b] of bytes) {
      const name = this.names.get(pid);
      const sh = shared.get(pid);
      procs.push({ pid, mib: b / MIB, ...(name !== undefined ? { name } : {}), ...(sh !== undefined ? { sharedMib: sh / MIB } : {}) });
    }
    this.childReadings++;
    this.failedAt = undefined;
    const reading = { t, procs };
    this.latest = reading;
    for (const l of [...this.listeners]) this.notify(l, reading);
    this.wake();
    if (this.listeners.size === 0 && this.o.clock.now() - this.lastDemand >= (this.o.idleMs ?? WIN_MONITOR_IDLE_MS)) {
      void child.stop({ graceMs: 0 });
    }
  }

  /** Waits for the next reading (bounded); a monitor that never produced one is stopped and marked failed. */
  private async nextReading(): Promise<void> {
    const child = this.child as ManagedProcess;
    const ac = new AbortController();
    const reading = new Promise<boolean>((resolve) => this.waiters.push(() => resolve(false)));
    const timedOut = await Promise.race([
      reading,
      this.o.clock.sleep(this.o.firstReadingMs ?? FIRST_READING_MS, ac.signal).then(
        () => true,
        () => false,
      ),
    ]);
    ac.abort();
    if (timedOut && this.child === child && this.childReadings === 0) {
      this.fail('no reading in time');
      void child.stop({ graceMs: 0 });
    }
  }

  private notify(l: GpuMemoryListener, r: Reading): void {
    try {
      l(r.t, r.procs);
    } catch (e) {
      this.o.log?.warn('GPU process memory listener failed', { error: String(e) });
    }
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }

  private fail(reason: string): void {
    this.failedAt = this.o.clock.now();
    if (this.warned) return;
    this.warned = true;
    this.o.log?.warn('per-process GPU memory unavailable', { reason });
  }
}

// ---- Linux (nvidia-smi outside WDDM) ------------------------------------------------------

/** compute-apps rows → one entry per PID (a process on several GPUs is listed once per GPU); "[N/A]" rows are left out. */
export function computeAppsMemory(apps: readonly ComputeApp[]): GpuProcessMemory[] {
  const byPid = new Map<number, GpuProcessMemory>();
  for (const a of apps) {
    if (a.usedMiB === null) continue;
    const prev = byPid.get(a.pid);
    if (prev) prev.mib += a.usedMiB;
    else byPid.set(a.pid, { pid: a.pid, mib: a.usedMiB, name: a.processName });
  }
  return [...byPid.values()];
}

/** Calls read() every intervalMs until stopped; a throwing listener does not end the loop. */
export function pollWatch(
  clock: Clock,
  intervalMs: number,
  read: () => Promise<GpuProcessMemory[] | undefined>,
  onTick: GpuMemoryListener,
  log?: Logger,
): GpuMemoryWatch {
  const ac = new AbortController();
  const loop = (async () => {
    while (!ac.signal.aborted) {
      const procs = await read();
      if (procs && !ac.signal.aborted) {
        try {
          onTick(clock.now(), procs);
        } catch (e) {
          log?.warn('GPU process memory listener failed', { error: String(e) });
        }
      }
      await clock.sleep(intervalMs, ac.signal).catch(noop);
    }
  })();
  return {
    stop: async () => {
      ac.abort();
      await loop;
    },
  };
}

/** Per-process MiB from `nvidia-smi --query-compute-apps` (empty under WSL, "[N/A]" under WDDM). */
export class NvidiaSmiGpuMemory implements GpuMemorySource {
  constructor(
    private readonly cli: Pick<NvidiaSmiCli, 'text'>,
    private readonly clock: Clock,
    private readonly log?: Logger,
  ) {}

  async read(): Promise<GpuProcessMemory[] | undefined> {
    try {
      return computeAppsMemory(parseComputeApps(await this.cli.text(COMPUTE_APPS_ARGS)));
    } catch (e) {
      return isAppError(e) && e.code === 'GPU_NOT_FOUND' ? [] : undefined;
    }
  }

  watch(intervalMs: number, onTick: GpuMemoryListener): GpuMemoryWatch {
    return pollWatch(this.clock, intervalMs, () => this.read(), onTick, this.log);
  }
}

export interface ProcFsReader {
  readdir(p: string): Promise<string[]>;
  readFile(p: string): Promise<string>;
}

export const nodeProcFs: ProcFsReader = {
  readdir: (p) => readdir(p),
  readFile: (p) => readFile(p, 'utf8'),
};

/**
 * The PIDs plus every descendant, from /proc/<pid>/task/<tid>/children (Linux ≥ 3.5). Processes that
 * vanish meanwhile are skipped; at most `max` PIDs are returned.
 */
export async function withDescendants(pids: readonly number[], fsr: ProcFsReader = nodeProcFs, procRoot = '/proc', max = 512): Promise<number[]> {
  const seen = new Set<number>();
  const queue = [...pids];
  while (queue.length > 0 && seen.size < max) {
    const pid = queue.shift() as number;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const taskDir = `${procRoot}/${pid}/task`;
    const tids = await fsr.readdir(taskDir).catch((): string[] => []);
    for (const tid of tids) {
      const text = await fsr.readFile(`${taskDir}/${tid}/children`).catch(() => '');
      for (const c of text.split(/\s+/)) {
        const n = Number(c);
        if (c !== '' && Number.isSafeInteger(n) && n > 0) queue.push(n);
      }
    }
  }
  return [...seen];
}

// ---- recorder -----------------------------------------------------------------------------

export interface ProcessVramRecorderOptions {
  source: GpuMemorySource;
  clock: Clock;
  pids: PidSource;
  intervalMs: number;
  /** Adds descendants of the engine PIDs (Linux); absent = the PIDs themselves. */
  expand?: (pids: number[]) => Promise<number[]>;
  firstReadingMs?: number;
  maxTicks?: number;
}

/**
 * ProcessVramSession over a GpuMemorySource: at every reading the PID source is read (the runner
 * returns the current engine instance), descendants are added (refreshed in the background, so a new
 * worker counts from the next reading) and the engine's MiB are summed. `ready` resolves at the
 * first reading, or after `firstReadingMs` when none comes.
 */
export class ProcessVramRecorder implements ProcessVramSession {
  readonly ready: Promise<void>;
  private readonly ticks: ProcessVramTick[] = [];
  private latest: number | undefined;
  private peak: number | undefined;
  private sharedPeak: number | undefined;
  private family: { key: string; pids: number[] } | undefined;
  private expanding: Promise<void> | undefined;
  private stopping: Promise<ProcessVramTick[]> | undefined;
  private gotFirst: () => void = noop;
  private readonly handle: GpuMemoryWatch;

  constructor(private readonly o: ProcessVramRecorderOptions) {
    const first = new Promise<void>((resolve) => (this.gotFirst = resolve));
    this.handle = o.source.watch(o.intervalMs, (t, procs) => this.onTick(t, procs));
    this.ready = this.ticks.length > 0 ? Promise.resolve() : this.waitFirst(first);
  }

  get samples(): readonly ProcessVramTick[] {
    return this.ticks;
  }

  latestMiB(): number | undefined {
    return this.latest === undefined ? undefined : Math.round(this.latest);
  }

  peakMiB(): number | undefined {
    return this.peak === undefined ? undefined : Math.round(this.peak);
  }

  sharedPeakMiB(): number | undefined {
    return this.sharedPeak === undefined ? undefined : Math.round(this.sharedPeak);
  }

  stop(): Promise<ProcessVramTick[]> {
    this.stopping ??= (async () => {
      await this.handle.stop();
      await this.expanding;
      return [...this.ticks];
    })();
    return this.stopping;
  }

  private async waitFirst(first: Promise<void>): Promise<void> {
    const ac = new AbortController();
    await Promise.race([first, this.o.clock.sleep(this.o.firstReadingMs ?? FIRST_READING_MS, ac.signal).catch(noop)]);
    ac.abort();
  }

  private onTick(t: number, procs: readonly GpuProcessMemory[]): void {
    if (this.stopping) return;
    const src = this.o.pids;
    const roots = [...(typeof src === 'function' ? src() : src)];
    const key = roots.join(',');
    const family = this.family?.key === key ? this.family.pids : [];
    const engine = [...new Set([...roots, ...family])];
    const mine = new Set(engine);
    let engineMiB = 0;
    let sharedMiB: number | undefined;
    let present = false;
    for (const p of procs) {
      if (!mine.has(p.pid)) continue;
      engineMiB += p.mib;
      if (p.sharedMib !== undefined) sharedMiB = (sharedMiB ?? 0) + p.sharedMib;
      present = true;
    }
    this.latest = present ? engineMiB : undefined;
    if (present && engineMiB > 0) this.peak = Math.max(this.peak ?? 0, engineMiB);
    if (sharedMiB !== undefined) this.sharedPeak = Math.max(this.sharedPeak ?? 0, sharedMiB);
    this.ticks.push({ t, engine, engineMiB, ...(sharedMiB !== undefined ? { engineSharedMiB: sharedMiB } : {}), procs: [...procs] });
    if (this.ticks.length > (this.o.maxTicks ?? MAX_PROCESS_TICKS)) this.ticks.splice(1, 1);
    this.gotFirst();
    if (this.o.expand && roots.length > 0 && !this.expanding) this.refresh(this.o.expand, roots, key);
  }

  private refresh(expand: (pids: number[]) => Promise<number[]>, roots: number[], key: string): void {
    this.expanding = expand(roots)
      .then((pids) => {
        this.family = { key, pids };
      }, noop)
      .finally(() => {
        this.expanding = undefined;
      });
  }
}

// ---- wiring -------------------------------------------------------------------------------

export interface ProcessMemorySetup {
  /** Source for engine sampling during runs. */
  processMemory?: GpuMemorySource;
  /** Merged into otherGpuUsers (Windows: nvidia-smi reports no per-process memory under WDDM). */
  userMemory?: GpuMemorySource;
  /** Adds descendants of engine PIDs (Linux). */
  expandPids?: (pids: number[]) => Promise<number[]>;
}

export interface ProcessMemoryDeps {
  platform: Platform;
  proc: ProcessRunner;
  clock: Clock;
  env: Record<string, string | undefined>;
  log?: Logger;
  cli: Pick<NvidiaSmiCli, 'text'>;
  /**
   * nvidia-smi is a stand-in (CoreEndpoints.nvidiaSmi: tests, fakes). The Windows counters would describe
   * the real GPU, not the fake one, so they are not used.
   */
  overridden: boolean;
  windows?: Pick<WindowsGpuMemoryOptions, 'intervalMs' | 'idleMs' | 'firstReadingMs' | 'retryMs' | 'parentPid'>;
  procFs?: ProcFsReader;
  procRoot?: string;
}

/** Per-OS sources: Windows counters (not with a stand-in nvidia-smi), nvidia-smi + /proc on Linux, none elsewhere. */
export function createProcessMemory(d: ProcessMemoryDeps): ProcessMemorySetup {
  if (d.platform === 'win32') {
    if (d.overridden) return {};
    const monitor = new WindowsGpuMemory({ proc: d.proc, clock: d.clock, env: d.env, ...(d.log ? { log: d.log } : {}), ...d.windows });
    return { processMemory: monitor, userMemory: monitor };
  }
  if (d.platform === 'linux') {
    return {
      processMemory: new NvidiaSmiGpuMemory(d.cli, d.clock, d.log),
      expandPids: (pids) => withDescendants(pids, d.procFs, d.procRoot),
    };
  }
  return {};
}
