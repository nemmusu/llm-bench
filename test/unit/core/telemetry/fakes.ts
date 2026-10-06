import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Clock, ExitInfo, LogLine, Logger, ManagedProcess, ProcessRunner, RunOptions, RunOutput, SpawnSpec } from '../../../../src/core/deps';
import { AsyncQueue } from '../../../../src/core/process/runner';

export const FIXTURES = fileURLToPath(new URL('../../../fixtures/', import.meta.url));

/** Reads a fixture; `crlf` re-encodes line endings like a Windows capture before git normalization. */
export function fixture(rel: string, opts: { crlf?: boolean } = {}): string {
  const text = readFileSync(path.join(FIXTURES, rel), 'utf8');
  return opts.crlf ? text.replace(/\r?\n/g, '\r\n') : text;
}

export class FakeClock implements Clock {
  constructor(public t = 1000) {}
  now(): number {
    return this.t;
  }
  wall(): number {
    return 1_760_000_000_000 + this.t;
  }
  sleep(ms: number): Promise<void> {
    this.t += ms;
    return Promise.resolve();
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export function ok(stdout: string, code: number | null = 0, extra: Partial<RunOutput> = {}): RunOutput {
  return { code, stdout, stderr: '', timedOut: false, ...extra };
}

/** A child process driven by the test: emit() lines, exit() it. stop() records the call and exits. */
export class FakeProcess implements ManagedProcess {
  readonly startedAt: number;
  readonly queue = new AsyncQueue<LogLine>();
  readonly lines: AsyncIterable<LogLine> = this.queue;
  readonly exited: Promise<ExitInfo>;
  stopCalls = 0;
  private resolveExit!: (e: ExitInfo) => void;
  private done = false;

  constructor(
    readonly pid: number,
    readonly spec: SpawnSpec,
    private readonly clock: Clock,
  ) {
    this.startedAt = clock.now();
    this.exited = new Promise((r) => (this.resolveExit = r));
  }

  emit(text: string, stream: 'stdout' | 'stderr' = 'stdout', t = this.clock.now()): void {
    this.queue.push({ t, stream, text });
  }

  exit(code: number | null = 0, signal: string | null = null): void {
    if (this.done) return;
    this.done = true;
    this.queue.close();
    this.resolveExit({ code, signal });
  }

  stop(): Promise<ExitInfo> {
    this.stopCalls++;
    this.exit(null, 'SIGTERM');
    return this.exited;
  }
}

export type RunHandler = (cmd: string, args: string[], opts?: RunOptions) => RunOutput | Promise<RunOutput>;

export class FakeRunner implements ProcessRunner {
  readonly calls: { cmd: string; args: string[]; opts?: RunOptions }[] = [];
  readonly spawned: FakeProcess[] = [];
  private nextPid = 5000;

  constructor(
    private readonly handler: RunHandler = () => ok(''),
    private readonly clock: Clock = new FakeClock(),
    private readonly onSpawn?: (p: FakeProcess) => void,
  ) {}

  run(cmd: string, args: string[], opts?: RunOptions): Promise<RunOutput> {
    this.calls.push(opts ? { cmd, args, opts } : { cmd, args });
    return Promise.resolve(this.handler(cmd, args, opts));
  }

  spawn(spec: SpawnSpec): ManagedProcess {
    const p = new FakeProcess(this.nextPid++, spec, this.clock);
    this.spawned.push(p);
    this.onSpawn?.(p);
    return p;
  }
}

/** Lets queued promise callbacks and async iterators run. */
export async function tick(n = 5): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
}

export function memoryLogger(): Logger & { entries: { level: string; msg: string }[] } {
  const entries: { level: string; msg: string }[] = [];
  const at = (level: string) => (msg: string) => {
    entries.push({ level, msg });
  };
  return { entries, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

/** Answers nvidia-smi invocations by inspecting the args, like the real CLI on this PC. */
export function nvidiaSmiHandler(map: {
  version?: RunOutput;
  plain?: RunOutput;
  probe?: RunOutput | ((args: string[]) => RunOutput);
  sample?: RunOutput | ((args: string[]) => RunOutput);
  apps?: RunOutput;
}): RunHandler {
  return (_cmd, args) => {
    const q = args.find((a) => a.startsWith('--query-gpu='));
    const pick = (v: RunOutput | ((a: string[]) => RunOutput) | undefined) => (typeof v === 'function' ? v(args) : (v ?? ok('', 1)));
    if (args.includes('--version')) return map.version ?? ok('', 1);
    if (args.some((a) => a.startsWith('--query-compute-apps='))) return map.apps ?? ok('');
    if (q?.includes('uuid')) return pick(map.probe);
    if (q) return pick(map.sample);
    return map.plain ?? ok('', 1);
  };
}
