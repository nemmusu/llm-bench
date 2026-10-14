// A program with an OpenAI API with commands around its server: the ones before run in order and must end
// well, the server starts after them, the ones after clean up once it stopped; every line in the log, a
// failure that names its command. Real processes: small node scripts and the fake engine in vLLM mode.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { CommandRun } from '../../../../src/contract/custom-engines';
import { launchParamsSchema } from '../../../../src/contract/engines';
import type { LogLine, Platform } from '../../../../src/core/deps';
import { CommandAdapter, type IsFile } from '../../../../src/core/engines/command/adapter';
import { STEP_LOG_LINES, stepLine } from '../../../../src/core/engines/command/steps';
import type { CoreEngineConfig, EngineInstance, ModelTarget } from '../../../../src/core/engines/types';
import { createInferenceClient } from '../../../../src/core/inference/client';
import { systemClock } from '../../../../src/core/node-deps';
import { pickFreePort } from '../../../../src/core/process/ports';
import { createProcessRunner } from '../../../../src/core/process/runner';
import { FAKE_ENGINE, silentLog } from '../docker/helpers';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'gb-steps-'));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const P = (o: object = {}) => launchParamsSchema.parse(o);
const platform = process.platform as Platform;
const NODE = process.execPath;
const q = (s: string) => `"${s}"`;

/** A step: prints its words, appends them to `file`, then exits with `code` (or sleeps first, `ms`). */
const STEP = (() => {
  const dir = tmp();
  const f = path.join(dir, 'step.mjs');
  writeFileSync(
    f,
    [
      "import { appendFileSync } from 'node:fs';",
      'const [file, words, code = "0", ms = "0"] = process.argv.slice(2);',
      'console.log(words);',
      'if (code !== "0") console.error(`${words} failed`);',
      'appendFileSync(file, `${words}\\n`);',
      'setTimeout(() => process.exit(Number(code)), Number(ms));',
    ].join('\n'),
  );
  return f;
})();
const step = (file: string, words: string, code = 0, ms = 0) => `${q(NODE)} ${q(STEP)} ${q(file)} ${words} ${code} ${ms}`;
const SERVER = `${q(NODE)} ${q(FAKE_ENGINE)} serve {model} --port {port} --served-model-name {alias} --max-model-len {ctx} --kv-cache-dtype {kv} --max-num-seqs {parallel}`;

function adapter(over: { beforeTimeoutMs?: number; afterTimeoutMs?: number; proc?: ReturnType<typeof createProcessRunner>; isFile?: IsFile; platform?: Platform } = {}) {
  const proc = over.proc ?? createProcessRunner({ clock: systemClock, platform, baseEnv: { ...process.env, FAKE_ENGINE_PROFILE: JSON.stringify({ loadMsWarm: 100, decodeTps: 400, prefillTps: 20000 }) } });
  return new CommandAdapter({
    deps: { clock: systemClock, proc, fetch, platform: over.platform ?? platform, log: silentLog, env: process.env },
    createClient: (flavor, baseUrl, o) => createInferenceClient(flavor, baseUrl, { fetch, clock: systemClock }, o),
    pollMs: 30,
    readyTimeoutMs: 20_000,
    ...(over.beforeTimeoutMs !== undefined ? { beforeTimeoutMs: over.beforeTimeoutMs } : {}),
    ...(over.afterTimeoutMs !== undefined ? { afterTimeoutMs: over.afterTimeoutMs } : {}),
    ...(over.isFile ? { isFile: over.isFile } : {}),
  });
}

function model(): ModelTarget {
  const dir = tmp();
  const file = path.join(dir, 'My Model.gguf');
  writeFileSync(file, Buffer.alloc(32));
  const identity = { displayName: 'My Model', format: 'gguf' as const, source: 'local' as const, files: [], weakKey: 'mm', sizeBytes: 5 };
  return { identity, local: { id: 'm', identity, paths: [file], auxiliary: [], dir, origin: 'library', modifiedAt: '' } };
}

const cfg = (run: Partial<CommandRun>): CoreEngineConfig => {
  const r: CommandRun = { mode: 'command', template: SERVER, api: 'completions', ...run };
  return { kind: 'command', command: r.template, commandRun: r, flavor: 'openai' };
};

/** Every log line, as the run log sees them. */
async function drain(inst: EngineInstance): Promise<string[]> {
  const out: string[] = [];
  for await (const l of inst.logs as AsyncIterable<LogLine>) out.push(l.text);
  return out;
}

const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : '');

describe('commands around the server: plan', () => {
  it('fills every command, finds every program, keeps only the settings they take', async () => {
    const a = adapter();
    const m = model();
    const marks = path.join(tmp(), 'marks.txt');
    const c = cfg({ before: [`${q(NODE)} -e "1" --dir {modelDir} --kv {kv}`], after: [step(marks, 'bye')], kvTypes: ['auto', 'fp8'] });
    const plan = await a.plan(c, m, P({ contextSize: 8192, kvCacheType: 'fp8', flashAttention: 'on', gpuLayers: 3, extraArgs: ['--x'], env: { A: '1' } }), { port: 9, marker: 'gpubench-s1' });
    expect(plan.argv).toEqual([NODE, FAKE_ENGINE, 'serve', m.local?.paths[0], '--port', '9', '--served-model-name', 'gpubench-s1', '--max-model-len', '8192', '--kv-cache-dtype', 'fp8', '--max-num-seqs', '1', '--x']);
    expect(plan.steps).toEqual({ before: [[NODE, '-e', '1', '--dir', m.local?.dir, '--kv', 'fp8']], after: [[NODE, STEP, marks, 'bye', '0', '0']] });
    // What reached the program: the context, the KV type, the users; nothing else LLM Bench knows.
    expect(plan.params).toEqual({ contextSize: 8192, kvCacheType: 'fp8', extraArgs: ['--x'], env: { A: '1' } });
    expect(await a.capabilities(c)).toMatchObject({ command: { settings: ['ctx', 'kv', 'parallel'], kvTypes: ['auto', 'fp8'] } });
    expect((await a.capabilities({ kind: 'command' })).command).toBeUndefined();
    // Without commands around it: no steps at all.
    expect((await a.plan(cfg({}), m, P(), { port: 9, marker: 'gpubench-s2' })).steps).toBeUndefined();
  });

  it('names the command whose program is missing or cannot be used', async () => {
    const a = adapter();
    // A path, not a name: one look at the disk (a whole PATH is slow on a busy PC).
    const missing = path.join(tmp(), 'no-such-program');
    expect(await a.detect(cfg({ before: [`${q(NODE)} -e 1`, `${q(missing)} x`] }))).toMatchObject({
      available: false,
      problems: ['ENGINE_NOT_INSTALLED'],
      problemParams: { reason: 'program_missing', path: missing, which: 'before', n: 2 },
    });
    expect(await a.detect(cfg({ after: [q(missing)] }))).toMatchObject({ problemParams: { reason: 'program_missing', which: 'after', n: 1 } });
    // Saved by hand with a wrong command: said, not run.
    expect(await a.detect(cfg({ after: ['{model} x'] }))).toMatchObject({ problems: ['VALIDATION'], problemParams: { reason: 'program_placeholder', which: 'after', n: 1 } });
    expect(await a.detect(cfg({ before: [`${q(NODE)} -e 1`] }))).toMatchObject({ available: true, location: NODE });
    const bat = String.raw`C:\tools\prep.bat`;
    const win = adapter({ platform: 'win32', isFile: async (f) => f === bat || f === NODE });
    expect(await win.detect(cfg({ template: `${q(NODE)} --port {port}`, before: [`"${bat}"`] }))).toMatchObject({ problems: ['VALIDATION'], problemParams: { reason: 'command_batch', path: bat, which: 'before', n: 1 } });
  });

  it('shows a command as one readable line', () => {
    expect(stepLine(['node', 'a b', '', 'say "hi"', '--x'])).toBe('node "a b" "" "say \\"hi\\"" --x');
  });
});

describe('commands around the server: start and stop', () => {
  it('runs the ones before, starts the server, measures it, stops it and runs the ones after', async () => {
    const a = adapter();
    const marks = path.join(tmp(), 'marks.txt');
    const port = await pickFreePort();
    const plan = await a.plan(cfg({ before: [step(marks, 'one'), step(marks, 'two')], after: [step(marks, 'three')] }), model(), P({ contextSize: 4096 }), { port, marker: `gpubench-steps${process.pid}` });
    const inst = await a.start(plan, new AbortController().signal);
    const lines = drain(inst);
    // Nothing of the server yet: its client is a placeholder that sends nothing, its pid unknown.
    expect(inst.baseUrl).toBe(`http://127.0.0.1:${port}`);
    expect(inst.client.flavor).toBe('openai');
    const createdAt = inst.t0;
    const ready = await inst.waitReady();
    expect(read(marks)).toBe('one\ntwo\n');
    expect(inst.pid).toBeGreaterThan(0);
    // Its load time does not count the commands before.
    expect(inst.t0).toBeGreaterThan(createdAt);
    expect(ready.tReady).toBeGreaterThanOrEqual(inst.t0);
    const events = [];
    for await (const e of inst.client.generate({ promptText: 'hello', outputTokens: 2, seed: 1 })) events.push(e);
    expect(events.at(-1)).toMatchObject({ kind: 'done' });
    const exit = await inst.stop();
    expect(await inst.exited).toEqual(exit);
    // The one after ran once the server had stopped (stopping again does nothing more).
    expect(read(marks)).toBe('one\ntwo\nthree\n');
    await inst.stop();
    expect(read(marks)).toBe('one\ntwo\nthree\n');
    const all = await lines;
    expect(all).toContain('[before 1/2] one');
    expect(all).toContain('[before 2/2] two');
    expect(all).toContain('[after 1/1] three');
    expect(all.some((l) => l.startsWith(`[before 1/2] ${NODE.includes(' ') ? `"${NODE}"` : NODE}`))).toBe(true);
    const tail = inst.logTail();
    expect(tail[0]).toMatch(/^\[before 1\/2\] /);
    expect(tail).toContain('[after 1/1] three');
    expect(tail.length).toBeGreaterThan(6);
  });

  it('a command before that fails stops the start, names it, and the ones after still clean up', async () => {
    const a = adapter();
    const marks = path.join(tmp(), 'marks.txt');
    const plan = await a.plan(cfg({ before: [step(marks, 'one'), step(marks, 'broken', 3)], after: [step(marks, 'cleanup')] }), model(), P(), { port: await pickFreePort(), marker: 'gpubench-fail' });
    const inst = await a.start(plan, new AbortController().signal);
    const err = await inst.waitReady().catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'ENGINE_START_FAILED', params: { reason: 'step_failed', which: 'before', n: 2, code: '3', program: path.basename(NODE) } });
    expect((err as { detail?: string }).detail).toContain('broken failed');
    expect(await inst.exited).toEqual({ code: null, signal: null });
    await inst.stop();
    expect(read(marks)).toBe('one\nbroken\ncleanup\n');
    expect(inst.pid).toBeUndefined();
  });

  it('a command before that does not end in time is stopped and said', async () => {
    const a = adapter({ beforeTimeoutMs: 400 });
    const marks = path.join(tmp(), 'marks.txt');
    const plan = await a.plan(cfg({ before: [step(marks, 'slow', 0, 30_000)] }), model(), P(), { port: await pickFreePort(), marker: 'gpubench-slow' });
    const inst = await a.start(plan, new AbortController().signal);
    await expect(inst.waitReady()).rejects.toMatchObject({ code: 'ENGINE_TIMEOUT', params: { reason: 'step_timeout', which: 'before', n: 1, timeoutMs: 400 } });
    await inst.stop();
  });

  it('stopping or cancelling while the ones before run: the server never starts', async () => {
    const a = adapter();
    const marks = path.join(tmp(), 'marks.txt');
    const port = await pickFreePort();
    const plan = await a.plan(cfg({ before: [step(marks, 'waiting', 0, 30_000), step(marks, 'never')], after: [step(marks, 'after')] }), model(), P(), { port, marker: 'gpubench-stop' });
    // stop() during the first command.
    const inst = await a.start(plan, new AbortController().signal);
    const waiting = inst.waitReady().catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 500));
    await inst.stop();
    expect(await waiting).toMatchObject({ code: 'CANCELLED' });
    expect(read(marks)).toBe('waiting\nafter\n');
    // The start's own signal.
    const ac = new AbortController();
    const second = await a.start(plan, ac.signal);
    const p2 = second.waitReady().catch((e: unknown) => e);
    setTimeout(() => ac.abort(), 300);
    expect(await p2).toMatchObject({ code: 'CANCELLED' });
    await second.stop();
    // The wait's signal, already aborted.
    const third = await a.start(plan, new AbortController().signal);
    const gone = new AbortController();
    gone.abort();
    await expect(third.waitReady(gone.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    await third.stop();
    // stop() at once: the first command is stopped, the second never runs; the one after does.
    const fourth = await a.start(plan, new AbortController().signal);
    await fourth.stop();
    await expect(fourth.waitReady()).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(read(marks)).not.toContain('never');
    expect(read(marks).endsWith('after\n')).toBe(true);
  });

  it('commands after that fail or hang are only written in the log', async () => {
    // Long enough for node to start under load, short enough for the test.
    const a = adapter({ afterTimeoutMs: 4000 });
    const marks = path.join(tmp(), 'marks.txt');
    const plan = await a.plan(cfg({ before: [step(marks, 'prep')], after: [step(marks, 'bad', 2), step(marks, 'hang', 0, 30_000)] }), model(), P(), { port: await pickFreePort(), marker: `gpubench-after${process.pid}` });
    const inst = await a.start(plan, new AbortController().signal);
    await inst.waitReady();
    await inst.stop();
    const tail = inst.logTail();
    expect(tail).toContain('[after 1/2] ended with 2');
    expect(tail).toContain('[after 2/2] did not end in time: stopped');
  });

  it('a server that ends on its own: the ones after run anyway', async () => {
    const a = adapter();
    const marks = path.join(tmp(), 'marks.txt');
    const plan = await a.plan(cfg({ template: `${step(marks, 'server', 4)} {port}`, before: [step(marks, 'prep')], after: [step(marks, 'after')] }), model(), P(), { port: await pickFreePort(), marker: 'gpubench-dies' });
    const inst = await a.start(plan, new AbortController().signal);
    await expect(inst.waitReady()).rejects.toMatchObject({ code: 'ENGINE_EXITED' });
    expect(await inst.exited).toMatchObject({ code: 4 });
    await inst.stop();
    expect(read(marks)).toBe('prep\nserver\nafter\n');
  });

  it('a start cancelled as the first command spawns; the chat API waits with a chat client', async () => {
    const real = createProcessRunner({ clock: systemClock, platform, baseEnv: process.env });
    const ac = new AbortController();
    const proc = {
      run: real.run.bind(real),
      spawn: (spec: Parameters<typeof real.spawn>[0]) => {
        ac.abort();
        return real.spawn(spec);
      },
    };
    const a = adapter({ proc });
    const chat: CoreEngineConfig = { ...cfg({ before: [`${q(NODE)} -e "setTimeout(() => {}, 30000)"`] }), flavor: 'openai-chat' };
    const plan = await a.plan(chat, model(), P(), { port: 1, marker: 'gpubench-chat' });
    const inst = await a.start(plan, ac.signal);
    expect(inst.client.flavor).toBe('openai-chat');
    await expect(inst.waitReady()).rejects.toMatchObject({ code: 'CANCELLED' });
    await inst.stop();
  });

  it('the wait’s own signal cancels the commands before too', async () => {
    const a = adapter();
    const plan = await a.plan(cfg({ before: [`${q(NODE)} -e "setTimeout(() => {}, 30000)"`] }), model(), P(), { port: 1, marker: 'gpubench-wait' });
    const inst = await a.start(plan, new AbortController().signal);
    const wait = new AbortController();
    const waiting = inst.waitReady(wait.signal).catch((e: unknown) => e);
    setTimeout(() => wait.abort(), 300);
    expect(await waiting).toMatchObject({ code: 'CANCELLED' });
    await inst.stop();
  });

  it('keeps the last lines of a talkative command (all of them still go to the log)', async () => {
    const a = adapter();
    const plan = await a.plan(cfg({ before: [`${q(NODE)} -e "for (let i = 0; i < 400; i++) console.log('line ' + i)"`] }), model(), P(), { port: await pickFreePort(), marker: `gpubench-talk${process.pid}` });
    const inst = await a.start(plan, new AbortController().signal);
    const lines = drain(inst);
    await inst.waitReady();
    await inst.stop();
    const kept = inst.logTail().filter((l) => l.startsWith('[before 1/1]'));
    expect(kept).toHaveLength(STEP_LOG_LINES);
    expect(kept.at(-1)).toBe('[before 1/1] line 399');
    expect((await lines).filter((l) => l.startsWith('[before 1/1] line'))).toHaveLength(400);
  });

  it('a command that cannot even be spawned fails like one that ends badly', async () => {
    const real = createProcessRunner({ clock: systemClock, platform, baseEnv: process.env });
    const proc = {
      run: real.run.bind(real),
      spawn: () => {
        throw new Error('EPERM');
      },
    };
    const a = adapter({ proc });
    const plan = await a.plan(cfg({ before: [`${q(NODE)} -e 1`], after: [`${q(NODE)} -e 1`] }), model(), P(), { port: 1, marker: 'gpubench-eperm' });
    const inst = await a.start(plan, new AbortController().signal);
    const err = await inst.waitReady().catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'ENGINE_START_FAILED', params: { reason: 'step_failed', code: 'null' } });
    expect((err as { detail: string }).detail).toContain('EPERM');
    await inst.stop();
    expect(inst.logTail()).toContain('[after 1/1] ended with null');
  });
});
