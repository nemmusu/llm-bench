import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../../../../src/contract/errors';
import type { LaunchParams } from '../../../../../src/contract/engines';
import type { RunOptions } from '../../../../../src/core/deps';
import {
  buildLlamaBenchArgs,
  createLlamaBench,
  defaultTimeoutMs,
  flashAttnStyle,
  llamaBenchExeName,
  locateLlamaBench,
  modelFromArgv,
  parseLlamaBenchJson,
  testName,
  type LlamaBenchStep,
} from '../../../../../src/core/engines/llama-bench/llama-bench';
import type { LaunchPlan } from '../../../../../src/core/engines/types';
import { FakeRunner, fixture, ok } from '../../telemetry/fakes';

const STEP: LlamaBenchStep = { kind: 'llama-bench', pp: 512, tg: 128, reps: 5 };
const PARAMS: LaunchParams = { extraArgs: [], env: {} };
const DIR = path.resolve('/opt/llama/b10997');
const SERVER = path.join(DIR, 'llama-server');
const BENCH = path.join(DIR, 'llama-bench');

function plan(over: Partial<LaunchPlan> = {}): LaunchPlan {
  return {
    kind: 'llamacpp-native',
    argv: [SERVER, '-m', '/models/q.gguf', '--port', '8080'],
    env: { LD_LIBRARY_PATH: DIR },
    host: '127.0.0.1',
    port: 8080,
    params: PARAMS,
    engine: { kind: 'llamacpp-native', name: 'llama.cpp', executable: SERVER },
    modelFiles: ['/models/q.gguf'],
    modelBytes: 1,
    marker: 'gpubench-x',
    ...over,
  };
}

const HELP_NEW = fixture('llama-bench/b10997-help.stdout.txt');
const HELP_OLD = fixture('llama-bench/handmade/help-old.stdout.txt');
const JSON_OUT = fixture('llama-bench/handmade/json.stdout.txt');
const OOM = fixture('llama-bench/handmade/oom.stderr.txt');

const yes = () => Promise.resolve(true);
const signal = () => new AbortController().signal;

describe('helpers', () => {
  it('names the binary per OS', () => {
    expect(llamaBenchExeName('win32')).toBe('llama-bench.exe');
    expect(llamaBenchExeName('linux')).toBe('llama-bench');
  });

  it('reads the flash-attention syntax from the real b10997 help and an older one', () => {
    expect(flashAttnStyle(HELP_NEW)).toBe('value');
    expect(flashAttnStyle(HELP_OLD)).toBe('binary');
    expect(flashAttnStyle('usage: llama-bench [options]')).toBe('none');
  });

  it('finds the model in the server argv', () => {
    expect(modelFromArgv(['x', '-m', 'a.gguf'])).toBe('a.gguf');
    expect(modelFromArgv(['x', '--model', 'b.gguf'])).toBe('b.gguf');
    expect(modelFromArgv(['x', '-m'])).toBeUndefined();
  });

  it('builds the argv with the run parameters', () => {
    expect(buildLlamaBenchArgs('m.gguf', STEP, PARAMS, 'value')).toEqual([
      '-m', 'm.gguf', '-p', '512', '-n', '128', '-r', '5', '-ngl', '999', '-fa', 'auto', '-o', 'json',
    ]);
    const full: LaunchParams = { ...PARAMS, gpuLayers: 20, flashAttention: 'on', kvCacheType: 'q8_0', batchSize: 1024, ubatchSize: 256, threads: 8 };
    expect(buildLlamaBenchArgs('m.gguf', STEP, full, 'binary')).toEqual([
      '-m', 'm.gguf', '-p', '512', '-n', '128', '-r', '5', '-ngl', '20', '-fa', '1',
      '-ctk', 'q8_0', '-ctv', 'q8_0', '-b', '1024', '-ub', '256', '-t', '8', '-o', 'json',
    ]);
    expect(buildLlamaBenchArgs('m', STEP, { ...PARAMS, flashAttention: 'off', kvCacheType: 'auto' }, 'binary')).toContain('0');
    expect(buildLlamaBenchArgs('m', STEP, PARAMS, 'binary')).not.toContain('-fa');
    expect(buildLlamaBenchArgs('m', STEP, { ...PARAMS, flashAttention: 'on' }, 'none')).not.toContain('-fa');
  });

  it('labels tests like llama-bench does', () => {
    expect(testName({ n_prompt: 512, n_gen: 0 })).toBe('pp512');
    expect(testName({ n_prompt: 0, n_gen: 128 })).toBe('tg128');
    expect(testName({ n_prompt: 512, n_gen: 128 })).toBe('pp512+tg128');
    expect(testName({ n_prompt: 0, n_gen: 128, n_depth: 4096 })).toBe('tg128 @ d4096');
  });

  it('scales the default timeout with the work', () => {
    expect(defaultTimeoutMs(STEP)).toBe(600_000 + 5 * (1024 + 25_600));
    expect(defaultTimeoutMs({ ...STEP, reps: 0 })).toBe(600_000 + 1024 + 25_600);
  });
});

describe('parseLlamaBenchJson', () => {
  it('parses -o json output, ignoring log noise around it', () => {
    const res = parseLlamaBenchJson(`load_backend: loaded CUDA backend\n${JSON_OUT}`);
    expect(res).toEqual([
      { test: 'pp512', tps: 299005.123456, stddev: 2150.5 },
      { test: 'tg128', tps: 471.91, stddev: 0.6 },
    ]);
  });

  it('rejects missing, broken or empty output', () => {
    for (const bad of ['', 'no json here', '[\n{"n_prompt": 1', '[\n]\n', '[\n{"foo": 1}\n]']) {
      expect(() => parseLlamaBenchJson(bad)).toThrow(expect.objectContaining({ code: 'ENGINE_EXITED' }) as unknown as Error);
    }
  });
});

describe('locateLlamaBench', () => {
  it('looks next to the server executable', async () => {
    await expect(locateLlamaBench(plan(), 'linux', yes)).resolves.toBe(BENCH);
    const win = plan({ engine: { kind: 'llamacpp-native', name: 'llama.cpp' }, argv: ['C:\\llama\\b10997\\llama-server.exe'] });
    const seen: string[] = [];
    await locateLlamaBench(win, 'win32', (p) => {
      seen.push(p);
      return Promise.resolve(true);
    });
    expect(seen[0]).toMatch(/llama-bench\.exe$/);
  });

  it('reports ENGINE_NOT_INSTALLED when the binary is not there', async () => {
    await expect(locateLlamaBench(plan(), 'linux', () => Promise.resolve(false))).rejects.toMatchObject({
      code: 'ENGINE_NOT_INSTALLED',
      params: { tool: 'llama-bench', path: BENCH },
    });
  });

  it('uses the real filesystem by default', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'gb-lb-'));
    writeFileSync(path.join(dir, 'llama-bench'), 'x');
    const found = plan({ engine: { kind: 'llamacpp-native', name: 'x', executable: path.join(dir, 'llama-server') } });
    await expect(locateLlamaBench(found, 'linux')).resolves.toBe(path.join(dir, 'llama-bench'));
    await expect(locateLlamaBench(plan({ engine: { kind: 'llamacpp-native', name: 'x', executable: path.join(process.cwd(), 'nope', 'llama-server') } }), 'linux')).rejects.toMatchObject({
      code: 'ENGINE_NOT_INSTALLED',
    });
  });
});

describe('createLlamaBench', () => {
  function runner(main: (args: string[], opts?: RunOptions) => ReturnType<typeof ok>, help = ok(HELP_NEW)) {
    return new FakeRunner((_cmd, args, opts) => (args.includes('--help') ? help : main(args, opts)));
  }

  it('runs llama-bench with the plan env and returns the parsed results', async () => {
    const proc = runner(() => ok(JSON_OUT));
    const bench = createLlamaBench({ proc, platform: 'linux', isFile: yes, timeoutMs: () => 1234 });
    const res = await bench(plan(), STEP, signal());
    expect(res.map((r) => r.test)).toEqual(['pp512', 'tg128']);
    const run = proc.calls.find((c) => !c.args.includes('--help'));
    expect(run?.cmd).toBe(BENCH);
    expect(run?.args).toEqual(['-m', '/models/q.gguf', '-p', '512', '-n', '128', '-r', '5', '-ngl', '999', '-fa', 'auto', '-o', 'json']);
    expect(run?.opts).toMatchObject({ timeoutMs: 1234, env: { LD_LIBRARY_PATH: DIR }, cwd: DIR });
    // The help probe is cached per binary.
    await bench(plan(), STEP, signal());
    expect(proc.calls.filter((c) => c.args.includes('--help'))).toHaveLength(1);
  });

  it('supports a launcher prefix and falls back to the plan model files', async () => {
    const proc = runner(() => ok(JSON_OUT));
    const bench = createLlamaBench({ proc, platform: 'linux', isFile: yes, launcherPrefix: ['node', 'fake.mjs'] });
    await bench(plan({ argv: [SERVER] }), STEP, signal());
    const run = proc.calls.find((c) => !c.args.includes('--help'));
    expect(run?.cmd).toBe('node');
    expect(run?.args.slice(0, 4)).toEqual(['fake.mjs', BENCH, '-m', '/models/q.gguf']);
    expect(run?.opts?.timeoutMs).toBe(defaultTimeoutMs(STEP));
  });

  it('treats a failing help probe as "no -fa flag"', async () => {
    const proc = new FakeRunner((_c, args) => (args.includes('--help') ? Promise.reject(new Error('boom')) : ok(JSON_OUT)) as never);
    const bench = createLlamaBench({ proc, platform: 'linux', isFile: yes });
    await bench(plan(), STEP, signal());
    expect(proc.calls.at(-1)?.args).not.toContain('-fa');
  });

  it('needs a model file', async () => {
    const bench = createLlamaBench({ proc: runner(() => ok(JSON_OUT)), platform: 'linux', isFile: yes });
    await expect(bench(plan({ argv: [SERVER], modelFiles: [] }), STEP, signal())).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' });
  });

  it('maps cancellation, timeouts and failures', async () => {
    const pre = new AbortController();
    pre.abort();
    const bench = (main: Parameters<typeof runner>[0]) => createLlamaBench({ proc: runner(main), platform: 'linux', isFile: yes });
    await expect(bench(() => ok(JSON_OUT))(plan(), STEP, pre.signal)).rejects.toMatchObject({ code: 'CANCELLED' });

    const mid = new AbortController();
    await expect(
      bench(() => {
        mid.abort();
        return ok('', null);
      })(plan(), STEP, mid.signal),
    ).rejects.toMatchObject({ code: 'CANCELLED' });

    await expect(bench(() => ok('', null, { timedOut: true }))(plan(), STEP, signal())).rejects.toMatchObject({ code: 'ENGINE_TIMEOUT' });
    await expect(bench(() => ok('', 1, { stderr: OOM }))(plan(), STEP, signal())).rejects.toMatchObject({ code: 'ENGINE_OOM' });
    await expect(bench(() => ok('', null, { stderr: 'Error: spawn /opt/llama-bench ENOENT' }))(plan(), STEP, signal())).rejects.toMatchObject({
      code: 'ENGINE_NOT_INSTALLED',
    });
    const err = await bench(() => ok('', 3, { stderr: 'something odd\n' }))(plan(), STEP, signal()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: 'ENGINE_EXITED' });
  });
});
