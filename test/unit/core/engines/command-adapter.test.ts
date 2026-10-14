// "Programma con API OpenAI": a command template started, measured like an endpoint and stopped,
// here with the fake engine in vLLM mode standing in for the user's program.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { launchParamsSchema } from '../../../../src/contract/engines';
import type { Platform } from '../../../../src/core/deps';
import { CommandAdapter, commandValues, diagnoseCommand, findProgram, type IsFile } from '../../../../src/core/engines/command/adapter';
import type { LaunchPlan, ModelTarget } from '../../../../src/core/engines/types';
import { createInferenceClient } from '../../../../src/core/inference/client';
import { systemClock } from '../../../../src/core/node-deps';
import type { OwnedRecord } from '../../../../src/core/process/ownership';
import { pickFreePort } from '../../../../src/core/process/ports';
import { createProcessRunner } from '../../../../src/core/process/runner';
import { FAKE_ENGINE, silentLog } from '../docker/helpers';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'gb-cmd-'));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) void import('node:fs').then((fs) => fs.rmSync(d, { recursive: true, force: true }));
});
const P = (o: object = {}) => launchParamsSchema.parse(o);
const platform = process.platform as Platform;
const NODE = process.execPath;
const q = (s: string) => `"${s}"`;

function adapter(over: { platform?: Platform; env?: Record<string, string | undefined>; isFile?: IsFile } = {}) {
  const records: OwnedRecord[] = [];
  const removed: number[] = [];
  const proc = createProcessRunner({ clock: systemClock, platform, baseEnv: { ...process.env, FAKE_ENGINE_PROFILE: JSON.stringify({ loadMsWarm: 100, decodeTps: 400, prefillTps: 20000 }) } });
  const a = new CommandAdapter({
    deps: { clock: systemClock, proc, fetch, platform: over.platform ?? platform, log: silentLog, env: over.env ?? process.env },
    createClient: (flavor, baseUrl, o) => createInferenceClient(flavor, baseUrl, { fetch, clock: systemClock }, o),
    ownership: {
      add: async (r) => {
        records.push(r);
      },
      remove: async (pid) => {
        removed.push(pid);
      },
    },
    pollMs: 30,
    readyTimeoutMs: 20_000,
    ...(over.isFile ? { isFile: over.isFile } : {}),
  });
  return { a, records, removed };
}

function model(): ModelTarget {
  const dir = tmp();
  const file = path.join(dir, 'My Model.gguf');
  writeFileSync(file, Buffer.alloc(32));
  const identity = { displayName: 'My Model', format: 'gguf' as const, source: 'local' as const, files: [], weakKey: 'mm', sizeBytes: 5 };
  return { identity, local: { id: 'm', identity, paths: [file], auxiliary: [], dir, origin: 'library', modifiedAt: '' } };
}

describe('command templates: the program', () => {
  it('finds the program on disk or on PATH, never by running it', async () => {
    // Windows' rules (drive paths, `;`, PATHEXT) whatever this PC runs: its disk is a list of files.
    const exe = String.raw`C:\srv\srv.exe`;
    const onPath = String.raw`D:\bin\srv.EXE`;
    const onWin: IsFile = async (f) => f === exe || f === onPath;
    expect(await findProgram(exe, 'win32', {}, onWin)).toBe(exe);
    expect(await findProgram(String.raw`C:\srv\missing`, 'win32', {}, onWin)).toBeUndefined();
    expect(await findProgram('srv', 'win32', { Path: String.raw`C:\empty;D:\bin`, PATHEXT: '.COM;.EXE' }, onWin)).toBe(onPath);
    expect(await findProgram('srv', 'win32', { PATH: String.raw`D:\bin` }, onWin)).toBe(onPath);
    // The real disk, with this PC's own rules.
    const dir = tmp();
    const host: Platform = process.platform === 'win32' ? 'win32' : 'linux';
    writeFileSync(path.join(dir, 'tool'), 'x');
    expect(await findProgram(path.join(dir, 'tool'), host, {})).toBe(path.resolve(dir, 'tool'));
    expect(await findProgram(path.join(dir, 'missing'), host, {})).toBeUndefined();
    // A PATH without drive letters (they hold a colon, Linux's separator).
    const rel = path.relative(process.cwd(), dir);
    expect(await findProgram('tool', 'linux', { PATH: `/nonexistent:${rel}` })).toBe(path.posix.join(rel, 'tool'));
    expect(await findProgram('nothing-here', 'linux', {})).toBeUndefined();
  });

  it('reports what is wrong with the engine', async () => {
    const { a } = adapter();
    expect(await a.detect()).toMatchObject({ kind: 'command', available: false, problems: ['ENGINE_NOT_INSTALLED'], problemParams: { reason: 'command_missing' } });
    expect(await a.detect({ kind: 'command', command: 'srv --model {model}' })).toMatchObject({ problems: ['VALIDATION'], problemParams: { reason: 'port_missing' } });
    expect(await a.detect({ kind: 'command', command: 'no-such-program-gpubench --port {port}' })).toMatchObject({ problems: ['ENGINE_NOT_INSTALLED'], problemParams: { reason: 'program_missing' } });
    expect(await a.detect({ kind: 'command', command: `${q(NODE)} --port {port}` })).toMatchObject({ available: true, installed: true, location: NODE, variant: 'openai' });
    const bat = String.raw`C:\tools\run.bat`;
    const { a: win } = adapter({ platform: 'win32', env: {}, isFile: async (f) => f === bat });
    expect(await win.detect({ kind: 'command', command: `"${bat}" --port {port}` })).toMatchObject({ problems: ['VALIDATION'], problemParams: { reason: 'command_batch' } });
    expect(await a.capabilities()).toMatchObject({ tokenIdsInPrompt: false, timings: false, variant: 'openai' });
  });

  it('fills in the placeholders, one argument each', async () => {
    const m = model();
    expect(commandValues(m, P({ contextSize: 8192 }), { port: 8123, marker: 'gpubench-x' })).toEqual({
      model: m.local?.paths[0],
      modelDir: m.local?.dir,
      port: '8123',
      host: '127.0.0.1',
      ctx: '8192',
      alias: 'gpubench-x',
      // The settings left unset: what LLM Bench passes by default (the first KV type of the engine).
      kv: 'f16',
      parallel: '1',
      gpuLayers: '999',
      batch: '2048',
      ubatch: '512',
    });
    const st = { ...m, identity: { ...m.identity, format: 'safetensors' as const } };
    st.local = { ...(m.local as NonNullable<ModelTarget['local']>), identity: st.identity };
    expect(commandValues(st, P({ maxModelLen: 2048 }), { port: 1, marker: 'mk', apiName: 'My-Model' })).toMatchObject({ model: m.local?.dir, ctx: '2048', alias: 'My-Model' });
    const repo: ModelTarget = { identity: { displayName: 'Q', format: 'safetensors', source: 'hf', repo: 'Qwen/Q', files: [], weakKey: 'q' }, repo: 'Qwen/Q' };
    expect(commandValues(repo, P(), { port: 1, marker: 'mk' })).toMatchObject({ model: 'Qwen/Q', modelDir: '', ctx: '4096' });
    expect(commandValues({ identity: { ...repo.identity, repo: 'A/B' } }, P(), { port: 1, marker: 'mk' }).model).toBe('A/B');
    expect(commandValues({ identity: { ...repo.identity, repo: undefined } }, P(), { port: 1, marker: 'mk' }).model).toBe('Q');
    const pending: ModelTarget = { identity: repo.identity, pending: { repo: 'r', file: 'f.gguf', paths: [path.join(tmp(), 'f.gguf')], bytes: 1 } };
    expect(commandValues(pending, P(), { port: 1, marker: 'mk', preview: true }).modelDir).toBe(path.dirname(pending.pending?.paths[0] as string));

    const { a } = adapter();
    const plan = await a.plan({ kind: 'command', command: `${q(NODE)} serve "{model}" --port {port} --served-model-name {alias}`, flavor: 'openai-chat' }, m, P({ extraArgs: ['--x'], env: { A: '1' } }), { port: 9, marker: 'gpubench-1' });
    expect(plan.argv).toEqual([NODE, 'serve', m.local?.paths[0], '--port', '9', '--served-model-name', 'gpubench-1', '--x']);
    expect(plan).toMatchObject({ kind: 'command', env: { A: '1' }, host: '127.0.0.1', port: 9, modelBytes: 32, engine: { name: 'OpenAI server', variant: 'openai-chat', executable: NODE } });
    const none = await a.plan({ kind: 'command', command: `${q(NODE)} --port {port}` }, { identity: repo.identity }, P(), { port: 9, marker: 'gpubench-1' });
    expect(none).toMatchObject({ modelFiles: [], modelBytes: 0, engine: { variant: 'openai' } });
    // A file that is gone counts as unknown: the size the library knew.
    const gone = model();
    rmSync(gone.local?.paths[0] as string);
    expect((await a.plan({ kind: 'command', command: `${q(NODE)} --port {port}` }, gone, P(), { port: 9, marker: 'gpubench-1' })).modelBytes).toBe(5);
  });

  it('says why a program stopped', () => {
    const exit = { code: 3, signal: null };
    expect(diagnoseCommand(['Error: spawn /x ENOENT'], exit)).toMatchObject({ code: 'ENGINE_START_FAILED' });
    expect(diagnoseCommand(['OSError: [Errno 98] address already in use'], exit)).toMatchObject({ code: 'ENGINE_PORT_IN_USE' });
    expect(diagnoseCommand(['torch.OutOfMemoryError: CUDA out of memory'], exit)).toMatchObject({ code: 'ENGINE_OOM' });
    expect(diagnoseCommand(['bye'], { code: null, signal: 'SIGTERM' })).toMatchObject({ code: 'ENGINE_EXITED', params: { code: 'SIGTERM' } });
  });
});

describe('command templates: start, measure, stop', () => {
  it('starts the program, waits for its name in /v1/models, measures and stops it', async () => {
    const { a, records, removed } = adapter();
    const port = await pickFreePort();
    const plan = await a.plan({ kind: 'command', command: `${q(NODE)} ${q(FAKE_ENGINE)} serve {model} --port {port} --host {host} --served-model-name {alias} --max-model-len {ctx}` }, model(), P({ contextSize: 4096 }), {
      port,
      marker: `gpubench-cmd${process.pid}`,
    });
    const inst = await a.start(plan, new AbortController().signal);
    await inst.waitReady();
    expect(records[0]).toMatchObject({ exe: NODE, marker: plan.marker, kind: 'process' });
    expect(inst.client.flavor).toBe('openai');
    const events = [];
    for await (const e of inst.client.generate({ promptText: 'hello world', outputTokens: 4, seed: 1 })) events.push(e);
    expect(events.at(-1)).toMatchObject({ kind: 'done', usage: { completionTokens: 4 } });
    await inst.stop();
    expect(removed).toContain(inst.pid);
  });

  it('without {alias}, uses the first model the program lists', async () => {
    const { a } = adapter();
    const port = await pickFreePort();
    const plan = await a.plan({ kind: 'command', command: `${q(NODE)} ${q(FAKE_ENGINE)} serve fake/model --port {port}` }, model(), P(), { port, marker: 'gpubench-noalias' });
    const inst = await a.start(plan, new AbortController().signal);
    await inst.waitReady();
    const events = [];
    for await (const e of inst.client.generate({ promptText: 'hi', outputTokens: 2, seed: 1 })) events.push(e);
    expect(events.at(-1)).toMatchObject({ kind: 'done' });
    expect(inst.client.requestBody({ promptText: 'x', outputTokens: 1, seed: 1 })).toMatchObject({ model: 'fake/model' });
    await inst.stop();
  });

  it('a program that exits is diagnosed; a cancelled start never spawns', async () => {
    const { a } = adapter();
    const port = await pickFreePort();
    const plan = await a.plan({ kind: 'command', command: `${q(NODE)} -e "process.exit(3)" --port {port}` }, model(), P(), { port, marker: 'gpubench-exit' });
    const inst = await a.start(plan, new AbortController().signal);
    await expect(inst.waitReady()).rejects.toMatchObject({ code: 'ENGINE_EXITED' });
    const ac = new AbortController();
    ac.abort();
    await expect(a.start(plan, ac.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('works without ownership options; a program whose model list cannot be read keeps the plain client; chat API', async () => {
    const proc = createProcessRunner({ clock: systemClock, platform, baseEnv: process.env });
    const bare = new CommandAdapter({
      deps: { clock: systemClock, proc, fetch, platform, log: silentLog, env: process.env },
      createClient: (flavor, baseUrl, o) => createInferenceClient(flavor, baseUrl, { fetch, clock: systemClock }, o),
    });
    const port = await pickFreePort();
    const server = "require('http').createServer((q,r)=>r.end('not json')).listen(+process.argv[1],'127.0.0.1')";
    const plan = await bare.plan({ kind: 'command', command: `${q(NODE)} -e "${server}" {port}`, flavor: 'openai-chat' }, model(), P(), { port, marker: 'gpubench-empty' });
    const inst = await bare.start(plan, new AbortController().signal);
    await inst.waitReady();
    expect(inst.client.flavor).toBe('openai-chat');
    expect(inst.client.requestBody({ promptText: 'x', outputTokens: 1, seed: 1 })).not.toHaveProperty('model');
    await inst.stop();
  });

  it('reports a spawn that throws, and keeps going when the ownership record fails', async () => {
    const throwing = new CommandAdapter({
      deps: {
        clock: systemClock,
        proc: {
          run: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
          spawn: () => {
            throw new Error('EPERM');
          },
        },
        fetch,
        platform,
        log: silentLog,
        env: {},
      },
      createClient: () => ({}) as never,
    });
    const plan: LaunchPlan = { kind: 'command', argv: ['x'], env: {}, host: '127.0.0.1', port: 1, params: P(), engine: { kind: 'command', name: 'x' }, modelFiles: [], modelBytes: 0, marker: 'gpubench-t' };
    await expect(throwing.start(plan, new AbortController().signal)).rejects.toMatchObject({ code: 'ENGINE_START_FAILED' });

    const proc = createProcessRunner({ clock: systemClock, platform, baseEnv: process.env });
    const flaky = new CommandAdapter({
      deps: { clock: systemClock, proc, fetch, platform, log: silentLog, env: process.env },
      createClient: (flavor, baseUrl, o) => createInferenceClient(flavor, baseUrl, { fetch, clock: systemClock }, o),
      ownership: { add: () => Promise.reject(new Error('disk full')), remove: async () => {} },
      pollMs: 30,
      readyTimeoutMs: 20_000,
    });
    const port = await pickFreePort();
    const p2 = await flaky.plan({ kind: 'command', command: `${q(NODE)} ${q(FAKE_ENGINE)} serve m --port {port} --served-model-name {alias}` }, model(), P(), { port, marker: 'gpubench-flaky' });
    const inst = await flaky.start(p2, new AbortController().signal);
    await inst.waitReady();
    await inst.stop();
  });
});
