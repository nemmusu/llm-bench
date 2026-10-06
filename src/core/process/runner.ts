import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { Clock, ExitInfo, LogLine, ManagedProcess, ProcessRunner, RunOptions, RunOutput, SpawnSpec } from '../deps';

type SpawnFn = (cmd: string, args: readonly string[], opts: SpawnOptions) => ChildProcess;

export interface RunnerOptions {
  clock: Clock;
  platform: NodeJS.Platform | 'win32' | 'linux' | 'darwin';
  baseEnv: Record<string, string | undefined>;
  /** Injected for tests; defaults to child_process.spawn. */
  spawnFn?: SpawnFn;
  /** Kills a whole process tree. Defaults to taskkill on Windows, process-group signal elsewhere. */
  killTree?: (pid: number, force: boolean) => Promise<void>;
}

const MAX_CAPTURE = 4 * 1024 * 1024;

/** Splits a byte stream into lines; keeps a trailing partial line until the next chunk. */
export class LineSplitter {
  private rest = '';
  push(chunk: string): string[] {
    const text = this.rest + chunk;
    const parts = text.split(/\r?\n/);
    this.rest = parts.pop() ?? '';
    return parts;
  }
  flush(): string[] {
    const out = this.rest ? [this.rest] : [];
    this.rest = '';
    return out;
  }
}

/** Minimal async queue: producers push, one consumer iterates until close(). */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

export function mergeEnv(
  base: Record<string, string | undefined>,
  extra: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) out[k] = v;
  if (extra) Object.assign(out, extra);
  return out;
}

export function defaultKillTree(platform: string, spawnFn: SpawnFn): (pid: number, force: boolean) => Promise<void> {
  return (pid, force) =>
    new Promise<void>((resolve) => {
      if (platform === 'win32') {
        const args = ['/PID', String(pid), '/T'];
        if (force) args.push('/F');
        const p = spawnFn('taskkill', args, { windowsHide: true, stdio: 'ignore' });
        p.on('error', () => resolve());
        p.on('exit', () => resolve());
        return;
      }
      try {
        // Negative pid = the whole process group (we spawn detached, so the child leads its group).
        process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
      } catch {
        try {
          process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
        } catch {
          /* already gone */
        }
      }
      resolve();
    });
}

export function createProcessRunner(opts: RunnerOptions): ProcessRunner {
  const spawnFn: SpawnFn = opts.spawnFn ?? (nodeSpawn as SpawnFn);
  const killTree = opts.killTree ?? defaultKillTree(opts.platform, spawnFn);
  const isWin = opts.platform === 'win32';

  function run(cmd: string, args: string[], ro: RunOptions = {}): Promise<RunOutput> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      let child: ChildProcess;
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        ro.signal?.removeEventListener('abort', onAbort);
        resolve({ code, stdout, stderr, timedOut });
      };
      try {
        child = spawnFn(cmd, args, {
          env: mergeEnv(opts.baseEnv, ro.env),
          ...(ro.cwd ? { cwd: ro.cwd } : {}),
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (e) {
        resolve({ code: null, stdout: '', stderr: String(e), timedOut: false });
        return;
      }
      const onAbort = () => {
        if (child.pid !== undefined) void killTree(child.pid, true);
      };
      const timer = ro.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            onAbort();
          }, ro.timeoutMs)
        : undefined;
      ro.signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (d: string) => {
        if (stdout.length < MAX_CAPTURE) stdout += d;
      });
      child.stderr?.on('data', (d: string) => {
        if (stderr.length < MAX_CAPTURE) stderr += d;
      });
      child.on('error', (e) => {
        stderr += String(e);
        finish(null);
      });
      child.on('close', (code) => finish(code));
      if (ro.input !== undefined) child.stdin?.end(ro.input);
      else child.stdin?.end();
    });
  }

  function spawn(spec: SpawnSpec): ManagedProcess {
    const startedAt = opts.clock.now();
    const child = spawnFn(spec.cmd, spec.args, {
      env: mergeEnv(opts.baseEnv, spec.env),
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
      windowsHide: true,
      // On POSIX the child leads a new process group so stop() can signal the whole tree.
      detached: !isWin,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lines = new AsyncQueue<LogLine>();
    const open = { stdout: true, stderr: true };
    const attach = (stream: 'stdout' | 'stderr') => {
      const s = child[stream];
      if (!s) {
        open[stream] = false;
        return;
      }
      const splitter = new LineSplitter();
      s.setEncoding('utf8');
      s.on('data', (d: string) => {
        for (const text of splitter.push(d)) lines.push({ t: opts.clock.now(), stream, text });
      });
      s.on('end', () => {
        for (const text of splitter.flush()) lines.push({ t: opts.clock.now(), stream, text });
        open[stream] = false;
        if (!open.stdout && !open.stderr) lines.close();
      });
    };
    attach('stdout');
    attach('stderr');

    const exited = new Promise<ExitInfo>((resolve) => {
      child.on('error', (e) => {
        lines.push({ t: opts.clock.now(), stream: 'stderr', text: String(e) });
        lines.close();
        resolve({ code: null, signal: null });
      });
      child.on('exit', (code, signal) => resolve({ code, signal }));
    });

    let stopping: Promise<ExitInfo> | undefined;
    const stop = (so: { graceMs?: number } = {}): Promise<ExitInfo> => {
      if (stopping) return stopping;
      stopping = (async () => {
        const pid = child.pid;
        if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return exited;
        // Windows console servers have no graceful signal (taskkill without /F only sends WM_CLOSE),
        // so the tree is terminated directly.
        if (isWin) {
          await killTree(pid, true);
          return exited;
        }
        await killTree(pid, false);
        const grace = so.graceMs ?? 5000;
        const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), grace));
        const res = await Promise.race([exited, timeout]);
        if (res === 'timeout') await killTree(pid, true);
        return exited;
      })();
      return stopping;
    };

    return {
      pid: child.pid ?? -1,
      startedAt,
      lines,
      exited,
      stop,
    };
  }

  return { run, spawn };
}
