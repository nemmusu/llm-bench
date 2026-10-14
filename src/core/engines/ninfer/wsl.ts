/**
 * NInfer inside WSL (Windows). LLM Bench only ever reads the user's distro and runs its own
 * ninfer-serve there; it never touches anything else:
 *
 *  - distros: `wsl.exe -l -v` (does not start the VM);
 *  - commands: `wsl.exe -d <distro> --exec <program> …` (no shell, no profile);
 *  - the server: `wsl.exe -d <distro> --exec /usr/bin/env GPUBENCH_OWNER=<marker> [VAR=value…]
 *    /bin/sh -c 'echo "gpubench-pid $$" >&2; exec "$@"' sh <ninfer-serve> <args>`: the shell prints
 *    its Linux PID and becomes ninfer-serve (same PID), whose environment carries our marker;
 *  - stopping: `kill -TERM <pid>` (then -KILL), each time only after /proc/<pid>/environ shows our
 *    marker: a reused PID, or any other program of the distro, is never signalled;
 *  - leftovers of a crashed session: recorded in dataDir/ninfer-wsl.json, stopped at the next start-up
 *    after the same check.
 *
 * Networking: the server listens on 127.0.0.1 inside the distro. WSL 2 forwards ports bound to
 * localhost to Windows' localhost (NAT mode, `localhostForwarding` on by default), and mirrored mode
 * shares 127.0.0.1 outright, so http://127.0.0.1:<port> works from Windows either way. With
 * localhostForwarding=false in .wslconfig it does not: the start then times out and says so.
 * Models: a Windows file is read through /mnt/<drive> (9p: several times slower to load); a file on the
 * distro's own disk (\\wsl.localhost\<distro>\… in the library) is read at full speed.
 */
import path from 'node:path';
import { z } from 'zod';
import type { WslDistro } from '../../../contract/ninfer';
import type { ProcessRunner, RunOptions, RunOutput } from '../../deps';
import { writeFileAtomic } from '../../store/atomic';
import { promises as fs } from 'node:fs';

/** wsl.exe's own messages in UTF-8 (it writes UTF-16 otherwise). */
export const WSL_ENV = { WSL_UTF8: '1' } as const;
/** Environment variable that marks a ninfer-serve LLM Bench started (its value is the ownership marker). */
export const OWNER_ENV = 'GPUBENCH_OWNER';
/** The launcher script: prints the PID, then becomes the program (exec keeps the PID). */
export const PID_SCRIPT = 'echo "gpubench-pid $$" >&2; exec "$@"';

/** Distros of Docker Desktop: never a place for NInfer. */
const INTERNAL = /^docker-desktop(-data)?$/i;

/** `wsl.exe -l -v`: "* Ubuntu-24.04    Running    2" (UTF-16 NULs and the header removed). */
export function parseDistroList(stdout: string): WslDistro[] {
  const out: WslDistro[] = [];
  for (const raw of stdout.replace(/\0/g, '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = /^\s*(\*)?\s*(\S+)\s+(\S+)\s+(\d+)\s*$/.exec(raw);
    if (!m || m[2] === 'NAME' || INTERNAL.test(m[2] as string)) continue;
    out.push({ name: m[2] as string, default: m[1] === '*', version: Number(m[4]), running: /^running$/i.test(m[3] as string) });
  }
  return out;
}

/**
 * A path as the distro sees it: C:\models\a.ninfer → /mnt/c/models/a.ninfer (through 9p: slow);
 * \\wsl.localhost\<distro>\home\u\a.ninfer (or \\wsl$\…) → /home/u/a.ninfer (its own disk); a Linux
 * path stays. undefined: another distro's files, or a network share.
 */
export function wslPathOf(p: string, distro: string): { path: string; slow: boolean } | undefined {
  const unc = /^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/]([^\\/]+)([\\/].*)?$/i.exec(p);
  if (unc) {
    if ((unc[1] as string).toLowerCase() !== distro.toLowerCase()) return undefined;
    return { path: (unc[2] ?? '/').replace(/\\/g, '/'), slow: false };
  }
  const drive = /^([A-Za-z]):[\\/]?(.*)$/.exec(p);
  if (drive) return { path: `/mnt/${(drive[1] as string).toLowerCase()}/${(drive[2] as string).replace(/\\/g, '/')}`.replace(/\/+$/, ''), slow: true };
  if (p.startsWith('/')) return { path: p, slow: /^\/mnt\/[a-z](\/|$)/.test(p) };
  return undefined;
}

/** Runs programs inside one distro (`wsl.exe -d <distro> --exec …`), as ProcessRunner.run does on the host. */
export type DistroRun = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunOutput>;

/** A program and its arguments run under `prefix` (none: as they are; tests: a fake Linux host). */
export function hostArgv(prefix: readonly string[], argv: readonly string[]): [string, string[]] {
  const all = [...prefix, ...argv];
  return [all[0] as string, all.slice(1)];
}

export function distroRunner(proc: ProcessRunner, wsl: readonly string[], distro: string): DistroRun {
  const [exe, ...pre] = wsl as [string, ...string[]];
  return (cmd, args, opts = {}) => proc.run(exe, [...pre, '-d', distro, '--exec', cmd, ...args], { ...opts, env: { ...opts.env, ...WSL_ENV } });
}

/**
 * The distros of this PC. `wsl: false` when wsl.exe does not answer with a list: WSL missing, or
 * installed without any distro (it then exits with an error and a hint to install one).
 */
export async function listDistros(proc: ProcessRunner, wsl: readonly string[]): Promise<{ wsl: boolean; distros: WslDistro[] }> {
  const [exe, ...pre] = wsl as [string, ...string[]];
  const out = await proc.run(exe, [...pre, '-l', '-v'], { timeoutMs: 20_000, env: { ...WSL_ENV } });
  return out.code === 0 ? { wsl: true, distros: parseDistroList(out.stdout) } : { wsl: false, distros: [] };
}

/** argv of ninfer-serve started in a distro, with its environment and our marker (see the file comment). */
export function wslLaunchArgv(wsl: readonly string[], o: { distro: string; serve: string; args: readonly string[]; env: Record<string, string>; marker: string }): string[] {
  const env = Object.entries(o.env).map(([k, v]) => `${k}=${v}`);
  return [...wsl, '-d', o.distro, '--exec', '/usr/bin/env', `${OWNER_ENV}=${o.marker}`, ...env, '/bin/sh', '-c', PID_SCRIPT, 'sh', o.serve, ...o.args];
}

const recordSchema = z.object({ distro: z.string().min(1), pid: z.number().int().positive(), marker: z.string().min(8), startedAtWall: z.number() });
export type WslRecord = z.infer<typeof recordSchema>;
const fileSchema = z.object({ schema: z.literal(1), records: z.array(z.unknown()) });

export interface WslProcessesOptions {
  proc: ProcessRunner;
  wsl: readonly string[];
  /** dataDir/ninfer-wsl.json */
  file: string;
  sleep: (ms: number) => Promise<void>;
  /** Wait for a TERM before KILL. */
  graceMs?: number;
}

/**
 * The ninfer-serve processes LLM Bench started in WSL: recorded while they run, stopped only after
 * their environment proves they are ours.
 */
export class WslProcesses {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: WslProcessesOptions) {}

  /** /proc/<pid>/environ of the distro holds GPUBENCH_OWNER=<marker>: the process is ours (and alive). */
  async owned(distro: string, pid: number, marker: string): Promise<boolean> {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    const out = await distroRunner(this.o.proc, this.o.wsl, distro)('cat', [`/proc/${pid}/environ`], { timeoutMs: 20_000 });
    return out.code === 0 && out.stdout.split('\0').includes(`${OWNER_ENV}=${marker}`);
  }

  /**
   * Stops our process: TERM, then KILL after the grace time; each signal only after the ownership check.
   * `gone` resolves when it has exited (the wsl.exe relay ends with it). False = not ours or already gone.
   */
  async stop(rec: Pick<WslRecord, 'distro' | 'pid' | 'marker'>, gone?: Promise<unknown>, opts: { group?: boolean } = {}): Promise<boolean> {
    const run = distroRunner(this.o.proc, this.o.wsl, rec.distro);
    // `group`: the process leads its own session (setsid): the signal goes to everything it started.
    const target = opts.group ? ['--', `-${rec.pid}`] : [String(rec.pid)];
    if (!(await this.owned(rec.distro, rec.pid, rec.marker))) return false;
    await run('kill', ['-TERM', ...target], { timeoutMs: 20_000 });
    const grace = this.o.graceMs ?? 10_000;
    if (gone) {
      const exited = await Promise.race([gone.then(() => true), this.o.sleep(grace).then(() => false)]);
      if (exited) return true;
    } else {
      for (let waited = 0; waited < grace; waited += 500) {
        await this.o.sleep(500);
        if (!(await this.owned(rec.distro, rec.pid, rec.marker))) return true;
      }
    }
    if (await this.owned(rec.distro, rec.pid, rec.marker)) await run('kill', ['-KILL', ...target], { timeoutMs: 20_000 });
    return true;
  }

  add(rec: WslRecord): Promise<void> {
    const valid = recordSchema.parse(rec);
    return this.locked(async () => this.write([...(await this.read()).filter((r) => !(r.pid === valid.pid && r.distro === valid.distro)), valid]));
  }

  remove(distro: string, pid: number): Promise<void> {
    return this.locked(async () => {
      const recs = await this.read();
      const left = recs.filter((r) => !(r.pid === pid && r.distro === distro));
      if (left.length !== recs.length) await this.write(left);
    });
  }

  list(): Promise<WslRecord[]> {
    return this.locked(() => this.read());
  }

  /** Start-up: our leftovers of a crashed session are stopped, every record dropped. No record = WSL is not even asked. */
  cleanupOrphans(): Promise<WslRecord[]> {
    return this.locked(async () => {
      const stopped: WslRecord[] = [];
      for (const rec of await this.read()) if (await this.stop(rec).catch(() => false)) stopped.push(rec);
      await this.write([]);
      return stopped;
    });
  }

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async read(): Promise<WslRecord[]> {
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(this.o.file, 'utf8'));
    } catch {
      return [];
    }
    const parsed = fileSchema.safeParse(raw);
    if (!parsed.success) return [];
    return parsed.data.records.flatMap((r) => {
      const p = recordSchema.safeParse(r);
      return p.success ? [p.data] : [];
    });
  }

  private async write(records: WslRecord[]): Promise<void> {
    if (records.length === 0 && !(await fs.stat(this.o.file).catch(() => undefined))) return;
    await fs.mkdir(path.dirname(this.o.file), { recursive: true });
    await writeFileAtomic(this.o.file, `${JSON.stringify({ schema: 1, records }, null, 2)}\n`);
  }
}
