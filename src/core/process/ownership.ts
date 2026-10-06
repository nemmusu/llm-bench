import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Platform, ProcessRunner } from '../deps';
import { writeFileAtomic } from '../store/atomic';

/**
 * Every engine process/container GPU Bench starts is recorded here (dataDir/processes.json),
 * so that after a crash we can stop our own leftovers at the next start-up — and only those.
 * A record is trusted only after the live process proves it is ours: same executable AND our
 * unique marker (`--alias gpubench-<uuid>`) in its command line. PIDs get reused, the marker does not.
 */
export const ownedRecordSchema = z.object({
  pid: z.number().int().positive(),
  /** Wall-clock ms of the spawn (diagnostics only: PIDs are verified through the marker). */
  startedAtWall: z.number(),
  exe: z.string().min(1),
  marker: z.string().min(8),
  runId: z.string(),
  kind: z.enum(['process', 'container']),
  containerId: z.string().optional(),
});
export type OwnedRecord = z.infer<typeof ownedRecordSchema>;

const fileSchema = z.object({ schema: z.literal(1), records: z.array(z.unknown()) });

/** What the OS tells us about a live PID. */
export interface ProcessInfo {
  commandLine: string;
  exe: string;
}

export interface ProcessInspector {
  /** Command line and executable of `pid`, or undefined when it is gone or unreadable. */
  inspect(pid: number): Promise<ProcessInfo | undefined>;
}

/** Docker side of ownership (M4): verifies the gpubench label and stops the container. */
export interface ContainerOwnership {
  verify(rec: OwnedRecord): Promise<boolean>;
  stop(rec: OwnedRecord): Promise<void>;
}

/** Windows: one CIM query per PID through PowerShell (no native modules, works on 5.1 and 7). */
export function windowsInspector(proc: ProcessRunner): ProcessInspector {
  return {
    async inspect(pid) {
      if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
      // UTF-8 output so non-ASCII user folders survive the pipe; the PID is an integer, never text.
      const script =
        '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' +
        `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | ` +
        'Select-Object CommandLine,ExecutablePath | ConvertTo-Json -Compress';
      const out = await proc.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        timeoutMs: 20_000,
      });
      const text = out.stdout.trim();
      if (out.code !== 0 || !text) return undefined;
      try {
        const raw = JSON.parse(text) as { CommandLine?: string | null; ExecutablePath?: string | null };
        return { commandLine: raw.CommandLine ?? '', exe: raw.ExecutablePath ?? '' };
      } catch {
        return undefined;
      }
    },
  };
}

export interface ProcFs {
  readFile(p: string): Promise<Buffer>;
  readlink(p: string): Promise<string>;
}

const realProcFs: ProcFs = { readFile: (p) => fs.readFile(p), readlink: (p) => fs.readlink(p) };

/** Linux: /proc/<pid>/cmdline (NUL separated) and the /proc/<pid>/exe link. */
export function linuxInspector(procRoot = '/proc', pfs: ProcFs = realProcFs): ProcessInspector {
  return {
    async inspect(pid) {
      if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
      try {
        const dir = path.posix.join(procRoot, String(pid));
        const cmdline = (await pfs.readFile(`${dir}/cmdline`)).toString('utf8').split('\0').filter(Boolean).join(' ');
        // A binary replaced on disk (e.g. a reinstall) shows up as "<path> (deleted)".
        const exe = (await pfs.readlink(`${dir}/exe`)).replace(/ \(deleted\)$/, '');
        return { commandLine: cmdline, exe };
      } catch {
        return undefined;
      }
    },
  };
}

export function sameExecutable(a: string, b: string, platform: Platform): boolean {
  if (platform === 'win32') return path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase();
  return path.posix.normalize(a) === path.posix.normalize(b);
}

export interface OwnershipOptions {
  /** Usually dataDir/processes.json. */
  file: string;
  platform: Platform;
  proc: ProcessRunner;
  /** Defaults to the platform inspector. */
  inspector?: ProcessInspector;
  /** POSIX signal sender (defaults to process.kill); signal 0 probes for existence. */
  signal?: (pid: number, sig: NodeJS.Signals | 0) => void;
  sleep?: (ms: number) => Promise<void>;
  /** POSIX: time between SIGTERM and SIGKILL. */
  graceMs?: number;
  containers?: ContainerOwnership;
}

export interface CleanupReport {
  /** Verified ours and stopped. */
  stopped: OwnedRecord[];
  /** Process gone or not ours anymore (PID reused): record dropped, nothing signalled. */
  dropped: OwnedRecord[];
  /** Could not be verified yet (containers without Docker support): kept for a later start-up. */
  kept: OwnedRecord[];
}

export class OwnershipRegistry {
  private readonly inspector: ProcessInspector;
  private readonly signal: (pid: number, sig: NodeJS.Signals | 0) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Serializes read-modify-write cycles on the file. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: OwnershipOptions) {
    this.inspector =
      opts.inspector ?? (opts.platform === 'win32' ? windowsInspector(opts.proc) : linuxInspector());
    this.signal = opts.signal ?? ((pid, sig) => process.kill(pid, sig));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  list(): Promise<OwnedRecord[]> {
    return this.locked(() => this.read());
  }

  async add(rec: OwnedRecord): Promise<void> {
    const valid = ownedRecordSchema.parse(rec);
    await this.locked(async () => {
      const recs = (await this.read()).filter((r) => r.pid !== valid.pid);
      recs.push(valid);
      await this.write(recs);
    });
  }

  remove(pid: number): Promise<void> {
    return this.locked(async () => {
      const recs = await this.read();
      const left = recs.filter((r) => r.pid !== pid);
      if (left.length !== recs.length) await this.write(left);
    });
  }

  /** The live process behind `rec` is ours: it exists, runs the same executable and carries our marker. */
  async verifyOwned(rec: OwnedRecord): Promise<boolean> {
    if (rec.kind === 'container') return this.opts.containers ? this.opts.containers.verify(rec) : false;
    const info = await this.inspector.inspect(rec.pid);
    if (!info) return false;
    return info.commandLine.includes(rec.marker) && sameExecutable(info.exe, rec.exe, this.opts.platform);
  }

  /**
   * Start-up sweep: stops only verified leftovers of a previous session, drops stale records.
   * Never signals a process that fails verification.
   */
  cleanupOrphans(): Promise<CleanupReport> {
    return this.locked(async () => {
      const report: CleanupReport = { stopped: [], dropped: [], kept: [] };
      const containers = this.opts.containers;
      for (const rec of await this.read()) {
        if (rec.kind === 'container' && !containers) {
          report.kept.push(rec);
          continue;
        }
        if (!(await this.verifyOwned(rec))) {
          report.dropped.push(rec);
          continue;
        }
        if (containers && rec.kind === 'container') await containers.stop(rec);
        else await this.killVerified(rec.pid);
        report.stopped.push(rec);
      }
      await this.write(report.kept);
      return report;
    });
  }

  /** Only called after verifyOwned() succeeded. */
  private async killVerified(pid: number): Promise<void> {
    if (this.opts.platform === 'win32') {
      await this.opts.proc.run('taskkill', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 15_000 });
      return;
    }
    if (!this.send(pid, 'SIGTERM')) return;
    const grace = this.opts.graceMs ?? 5000;
    for (let waited = 0; waited < grace; waited += 100) {
      await this.sleep(100);
      if (!this.alive(pid)) return;
    }
    this.send(pid, 'SIGKILL');
  }

  /** Signals our process group first (spawned detached, so the engine leads it), then the PID alone. */
  private send(pid: number, sig: NodeJS.Signals): boolean {
    try {
      this.signal(-pid, sig);
      return true;
    } catch {
      try {
        this.signal(pid, sig);
        return true;
      } catch {
        return false;
      }
    }
  }

  private alive(pid: number): boolean {
    try {
      this.signal(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async read(): Promise<OwnedRecord[]> {
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(this.opts.file, 'utf8'));
    } catch {
      // Missing or corrupt file: nothing we can trust, start empty.
      return [];
    }
    const parsed = fileSchema.safeParse(raw);
    if (!parsed.success) return [];
    const out: OwnedRecord[] = [];
    for (const r of parsed.data.records) {
      const rec = ownedRecordSchema.safeParse(r);
      if (rec.success) out.push(rec.data);
    }
    return out;
  }

  private write(records: OwnedRecord[]): Promise<void> {
    return writeFileAtomic(this.opts.file, `${JSON.stringify({ schema: 1, records }, null, 2)}\n`);
  }
}
