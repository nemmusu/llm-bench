// Forks: LLM Bench's flags a build lacks are left out (and said), RoPE scaling per engine, and custom
// engines resolved from the settings onto their base adapter.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { customEngineSchema, type CustomEngine } from '../../../../src/contract/custom-engines';
import { launchParamsSchema, type EngineConfig } from '../../../../src/contract/engines';
import type { ProcessRunner, RunOutput } from '../../../../src/core/deps';
import { CustomEngineAdapter, expandCustom, resolveCustom, withCustomEngines, withCustomSettings } from '../../../../src/core/engines/custom/adapter';
import { defaultLlamaCaps, llamaServerArgs } from '../../../../src/core/engines/llamacpp-docker/adapter';
import { LlamaNativeAdapter, type LlamaDeps } from '../../../../src/core/engines/llamacpp-native/adapter';
import { capsFromOutputs } from '../../../../src/core/engines/llamacpp-native/caps';
import { FlagGate, missingStandardFlags, STANDARD_FLAGS, trustedFlags } from '../../../../src/core/engines/shared/standard-flags';
import { ropeScalingConfig, vllmServeArgs } from '../../../../src/core/engines/shared/vllm-args';
import type { EngineAdapter, LaunchPlan, ModelTarget } from '../../../../src/core/engines/types';
import { systemClock } from '../../../../src/core/node-deps';

const fixture = (n: string) => readFileSync(new URL(`../../../fixtures/llamacpp/${n}`, import.meta.url), 'utf8');
const HELP = fixture('help.stdout.txt');
const FORK_HELP = fixture('help-fork.stdout.txt');
const VERSION = fixture('version.stderr.txt');
const FORK_VERSION = fixture('version-fork.stderr.txt');
const P = (o: object = {}) => launchParamsSchema.parse(o);
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'gb-fork-'));
const rope = { type: 'yarn' as const, factor: 4, originalContext: 32768 };

describe('standard flags', () => {
  it('trusts a help that lists every required flag', () => {
    const full = capsFromOutputs(VERSION, HELP).flags;
    expect(trustedFlags('llamacpp', full)).toBe(full);
    expect(trustedFlags('llamacpp', new Set(['--fit']))).toBeUndefined();
    expect(trustedFlags('llamacpp', new Set())).toBeUndefined();
    expect(trustedFlags('llamacpp', undefined)).toBeUndefined();
    expect(missingStandardFlags('llamacpp', full)).toEqual([]);
  });

  it('lists what a fork lacks, once per flag', () => {
    const fork = capsFromOutputs(FORK_VERSION, FORK_HELP).flags;
    expect(fork.has('--ternary-kernels')).toBe(true);
    expect(missingStandardFlags('llamacpp', fork)).toEqual([{ flag: '-ub', setting: 'ubatchSize', effect: 'default' }]);
    expect(missingStandardFlags('sglang', new Set(['--host']))).toContainEqual({ flag: '--port', setting: 'port', effect: 'required' });
    // Two entries share a setting (-ctk / -ctv): both are named.
    expect(missingStandardFlags('llamacpp', new Set(['-m', '--host', '--port', '--alias'])).map((m) => m.flag)).toContain('-ctv');
    expect(STANDARD_FLAGS.vllm.every((s) => s.spellings.length > 0)).toBe(true);
  });

  it('a gate passes known flags, records unknown ones, refuses required ones', () => {
    const gate = new FlagGate('llamacpp', new Set(['-m', '--host', '--port', '--alias', '-c', '--custom']));
    const args: string[] = [];
    gate.push(args, '-c', '4096');
    gate.push(args, '-ub', '512');
    gate.push(args, '-ub', '1024');
    gate.push(args, '--custom', 'x');
    gate.push(args, '--other', 'y');
    gate.note('-fa');
    gate.note('-c');
    expect(args).toEqual(['-c', '4096', '--custom', 'x']);
    expect(gate.missing).toEqual([
      { flag: '-ub', setting: 'ubatchSize', effect: 'default' },
      { flag: '--other', setting: '--other', effect: 'default' },
      { flag: '-fa', setting: 'flashAttention', effect: 'default' },
    ]);
    expect(gate.lists('--custom')).toBe(true);
    expect(gate.lists('--ctx-size')).toBe(false);
    expect(() => gate.push([], '--model', 'm')).not.toThrow();
    expect(() => new FlagGate('llamacpp', new Set(['--host'])).push([], '-m', 'x')).toThrow(expect.objectContaining({ code: 'ENGINE_BAD_FLAG' }));
    // Unknown options: everything goes through, nothing is noted.
    const open = new FlagGate('vllm', undefined);
    open.note('--hf-overrides');
    expect(open.missing).toEqual([]);
    expect(open.has('--anything') && open.lists('--anything')).toBe(true);
  });
});

describe('RoPE scaling', () => {
  it('llama.cpp: --rope-scaling, --rope-scale and, for YaRN, --yarn-orig-ctx', () => {
    const caps = { ...defaultLlamaCaps(), nglKeywords: ['all'] };
    const yarn = llamaServerArgs(P({ ropeScaling: rope }), caps, { modelPath: '/m.gguf', marker: 'mk' });
    expect(yarn.slice(yarn.indexOf('--rope-scaling'))).toEqual(['--rope-scaling', 'yarn', '--rope-scale', '4', '--yarn-orig-ctx', '32768']);
    const linear = llamaServerArgs(P({ ropeScaling: { type: 'linear', factor: 2.5, originalContext: 8192 } }), caps, { modelPath: '/m.gguf', marker: 'mk' });
    expect(linear.slice(linear.indexOf('--rope-scaling'))).toEqual(['--rope-scaling', 'linear', '--rope-scale', '2.5']);
  });

  it('vLLM: --hf-overrides, else the old --rope-scaling, else said to be missing', () => {
    const o = { model: 'm', positional: true, host: 'h', port: 1, servedName: 's' };
    const json = JSON.stringify({ rope_scaling: ropeScalingConfig(rope) });
    const open = vllmServeArgs(P({ ropeScaling: rope }), o);
    expect(open.slice(open.indexOf('--hf-overrides'), open.indexOf('--hf-overrides') + 2)).toEqual(['--hf-overrides', json]);
    const base = ['--host', '--port', '--served-model-name', '--max-model-len', '--gpu-memory-utilization', '--seed'];
    const old = vllmServeArgs(P({ ropeScaling: rope }), o, new FlagGate('vllm', new Set([...base, '--rope-scaling'])));
    expect(old.slice(old.indexOf('--rope-scaling'), old.indexOf('--rope-scaling') + 2)).toEqual(['--rope-scaling', JSON.stringify(ropeScalingConfig(rope))]);
    const gate = new FlagGate('vllm', new Set(base));
    const none = vllmServeArgs(P({ ropeScaling: rope, parallel: 2 }), o, gate);
    expect(none.some((a) => a.includes('rope'))).toBe(false);
    expect(gate.missing.map((m) => m.flag)).toEqual(['--max-num-seqs', '--hf-overrides']);
  });
});

function forkProc(help: string, version: string): ProcessRunner & { envs: Record<string, string>[] } {
  const envs: Record<string, string>[] = [];
  const out = (o: Partial<RunOutput>): RunOutput => ({ code: 0, stdout: '', stderr: '', timedOut: false, ...o });
  return {
    envs,
    run: async (_cmd, args, opts) => {
      envs.push(opts?.env ?? {});
      if (args.includes('--version')) return out({ stderr: version });
      return out({ stdout: help });
    },
    spawn: () => {
      throw new Error('not in this test');
    },
  };
}

function llamaDeps(proc: ProcessRunner): LlamaDeps {
  const root = tmp();
  return {
    clock: systemClock,
    proc,
    fetch,
    platform: 'win32',
    arch: 'x64',
    paths: { dataDir: root, cacheDir: root, enginesDir: path.join(root, 'engines'), resultsDir: root, modelsDir: root, resourcesDir: root, home: root },
    endpoints: { githubApi: 'http://127.0.0.1:9', huggingface: 'http://127.0.0.1:9', dockerHub: 'http://127.0.0.1:9' },
    env: {},
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    appVersion: '0',
  };
}

function gguf(): ModelTarget {
  const dir = tmp();
  const file = path.join(dir, 'Bonsai-8B-PQ2_0.gguf');
  writeFileSync(file, Buffer.alloc(64));
  const identity = { displayName: 'Bonsai 8B', format: 'gguf' as const, source: 'local' as const, files: [], weakKey: 'b' };
  return { identity, local: { id: 'b', identity, paths: [file], auxiliary: [], dir, origin: 'library', modifiedAt: '' } };
}

describe('llama.cpp forks', () => {
  it('a fork without -ub runs without it, and the plan says so', async () => {
    const exe = path.join(tmp(), 'llama-server.exe');
    writeFileSync(exe, 'x');
    const proc = forkProc(FORK_HELP, FORK_VERSION);
    const a = new LlamaNativeAdapter({ deps: llamaDeps(proc), ownership: {} as never, createClient: () => ({}) as never });
    const plan = await a.plan({ kind: 'llamacpp-native', executable: exe, probeEnv: { LD_LIBRARY_PATH: '/prism/lib' } } as EngineConfig, gguf(), P({ ubatchSize: 1024, batchSize: 4096, ropeScaling: rope }), {
      port: 9000,
      marker: 'gpubench-fork',
    });
    expect(plan.argv).not.toContain('-ub');
    expect(plan.argv).toContain('-b');
    expect(plan.argv.slice(plan.argv.indexOf('--rope-scaling'), plan.argv.indexOf('--rope-scaling') + 6)).toEqual(['--rope-scaling', 'yarn', '--rope-scale', '4', '--yarn-orig-ctx', '32768']);
    expect(plan.unsupported).toEqual([{ flag: '-ub', setting: 'ubatchSize', effect: 'default' }]);
    expect(plan.engine.build).toBe('b7001');
    // The fork's own environment is used to read its --version / --help.
    expect(proc.envs.every((e) => e.LD_LIBRARY_PATH === '/prism/lib')).toBe(true);
    // The same build without ubatch asked: nothing to say.
    const quiet = await a.plan({ kind: 'llamacpp-native', executable: exe }, gguf(), P(), { port: 9000, marker: 'gpubench-fork' });
    expect(quiet.unsupported).toBeUndefined();
  });

  it('a fork without --alias cannot be used (readiness needs the marker)', async () => {
    const exe = path.join(tmp(), 'llama-server.exe');
    writeFileSync(exe, 'x');
    const noAlias = HELP.split(/\r?\n/).filter((l) => !/^-a,\s+--alias/.test(l)).join('\n');
    const a = new LlamaNativeAdapter({ deps: llamaDeps(forkProc(noAlias, VERSION)), ownership: {} as never, createClient: () => ({}) as never });
    // Without a required flag the help is not trusted: the command is the usual one, nothing left out.
    const plan = await a.plan({ kind: 'llamacpp-native', executable: exe }, gguf(), P({ ubatchSize: 512 }), { port: 1, marker: 'gpubench-x' });
    expect(plan.argv).toContain('--alias');
    expect(plan.unsupported).toBeUndefined();
  });

  it('a fork image on Docker is planned with its own flags', () => {
    const caps = capsFromOutputs(FORK_VERSION, FORK_HELP);
    const gate = new FlagGate('llamacpp', trustedFlags('llamacpp', caps.flags));
    const args = llamaServerArgs(P({ ubatchSize: 256 }), caps, { modelPath: '/models/m.gguf', marker: 'mk' }, gate);
    expect(args).not.toContain('-ub');
    expect(gate.missing).toHaveLength(1);
    // A build without flash attention at all: noted, never passed.
    const flags = new Set([...caps.flags].filter((f) => f !== '-fa' && f !== '--flash-attn'));
    const noFa = { ...caps, flashAttn: 'none' as const, flags };
    const g2 = new FlagGate('llamacpp', trustedFlags('llamacpp', flags));
    llamaServerArgs(P(), noFa, { modelPath: '/m', marker: 'mk' }, g2);
    expect(g2.missing.map((m) => m.flag)).toContain('-fa');
  });
});

// ---- custom engines --------------------------------------------------------------------------------

const engine = (over: Partial<CustomEngine> & Pick<CustomEngine, 'base' | 'run'>): CustomEngine => customEngineSchema.parse({ id: 'fork', name: 'PrismML fork', ...over });

function fakeAdapter(kind: EngineAdapter['kind'], o: { flags?: string[]; capsFail?: boolean; install?: boolean } = {}) {
  const calls: { op: string; cfg: EngineConfig; params?: unknown; opts?: unknown }[] = [];
  const a: EngineAdapter = {
    kind,
    detect: async (cfg) => {
      calls.push({ op: 'detect', cfg: cfg as EngineConfig });
      return { kind, available: true, installed: true, problems: [], supported: true, location: 'x' };
    },
    capabilities: async (cfg) => {
      calls.push({ op: 'caps', cfg });
      if (o.capsFail) throw new Error('no help');
      return { flags: new Set(o.flags ?? []), tokenIdsInPrompt: true, timings: false, minTokens: true, fitFlag: false };
    },
    plan: async (cfg, _m, params, opts) => {
      calls.push({ op: 'plan', cfg, params, opts });
      return { kind, argv: ['x', ...params.extraArgs], env: params.env, host: 'h', port: opts.port, params, engine: { kind, name: 'base', build: 'b1' }, modelFiles: [], modelBytes: 0, marker: opts.marker } as LaunchPlan;
    },
    start: async () => ({ started: true }) as never,
    ...(o.install
      ? {
          installPlan: async (cfg: EngineConfig) => {
            calls.push({ op: 'installPlan', cfg });
            return { kind, label: 'l', bytes: 1, items: [], data: {} };
          },
          install: async () => {
            calls.push({ op: 'install', cfg: { kind } });
          },
        }
      : {}),
  };
  return { a, calls };
}

describe('custom engines on their base adapter', () => {
  const model = { identity: { displayName: 'm', format: 'gguf' as const, source: 'local' as const, files: [], weakKey: 'm' } };

  it('fills in what each kind of engine names', () => {
    expect(expandCustom(engine({ base: 'llamacpp', run: { mode: 'native', path: '/p/llama-server' }, env: { A: '1' } }), { kind: 'llamacpp-native', modelVolume: 'v' })).toEqual({
      kind: 'llamacpp-native',
      modelVolume: 'v',
      executable: '/p/llama-server',
      probeEnv: { A: '1' },
    });
    expect(expandCustom(engine({ base: 'vllm', run: { mode: 'native', path: '/venv' } }), { kind: 'vllm-native' })).toEqual({ kind: 'vllm-native', vllmPath: '/venv' });
    expect(expandCustom(engine({ base: 'sglang', run: { mode: 'native', path: '/py' } }), { kind: 'sglang-native' })).toEqual({ kind: 'sglang-native', sglangPath: '/py' });
    expect(expandCustom(engine({ base: 'sglang', run: { mode: 'docker', image: 'me/sglang:1' } }), { kind: 'sglang-docker' })).toEqual({ kind: 'sglang-docker', image: 'me/sglang:1' });
    expect(expandCustom(engine({ base: 'openai-server', run: { mode: 'command', template: 'srv --port {port}', api: 'chat' } }), { kind: 'command' })).toEqual({
      kind: 'command',
      command: 'srv --port {port}',
      flavor: 'openai-chat',
    });
    expect(expandCustom(engine({ base: 'openai-server', run: { mode: 'command', template: 'srv --port {port}', api: 'completions' } }), { kind: 'command' }).flavor).toBe('openai');
    expect(withCustomSettings({ extraArgs: ['--a'], env: { X: '1', Y: '1' } }, P({ extraArgs: ['--b'], env: { Y: '2' } }))).toMatchObject({ extraArgs: ['--a', '--b'], env: { X: '1', Y: '2' } });
  });

  it('resolves from the settings, or says why not', async () => {
    const list = [engine({ base: 'llamacpp', run: { mode: 'native', path: '/p' } })];
    const source = { list: async () => list };
    expect(await resolveCustom(source, undefined)).toBeUndefined();
    expect(await resolveCustom(source, { kind: 'llamacpp-native' })).toBeUndefined();
    expect((await resolveCustom(source, { kind: 'llamacpp-native', customEngineId: 'fork' }))?.cfg.executable).toBe('/p');
    await expect(resolveCustom(source, { kind: 'llamacpp-native', customEngineId: 'gone' })).rejects.toMatchObject({ code: 'ENGINE_NOT_INSTALLED', params: { reason: 'custom_engine_missing' } });
    await expect(resolveCustom(source, { kind: 'vllm-native', customEngineId: 'fork' })).rejects.toMatchObject({ code: 'VALIDATION', params: { reason: 'custom_engine_kind', kind: 'llamacpp-native' } });
  });

  it('plans a llama.cpp fork with its arguments and name, keeping the run params', async () => {
    const { a, calls } = fakeAdapter('llamacpp-native');
    const e = engine({ base: 'llamacpp', run: { mode: 'native', path: '/p' }, extraArgs: ['--ternary-kernels', 'on'], env: { A: '1' } });
    const wrapped = new CustomEngineAdapter(a, { list: async () => [e] });
    const params = P({ extraArgs: ['--mlock'] });
    const plan = await wrapped.plan({ kind: 'llamacpp-native', customEngineId: 'fork' }, model, params, { port: 1, marker: 'm' });
    expect(plan.argv).toEqual(['x', '--ternary-kernels', 'on', '--mlock']);
    expect(plan.env).toEqual({ A: '1' });
    expect(plan.params).toBe(params);
    expect(plan.engine).toEqual({ kind: 'llamacpp-native', name: 'PrismML fork', build: 'b1', customEngine: { id: 'fork', name: 'PrismML fork', base: 'llamacpp' } });
    // llama.cpp reads its own build's options: no extra probe.
    expect(calls.filter((c) => c.op === 'caps')).toHaveLength(0);
    // A plain config goes straight through.
    await wrapped.plan({ kind: 'llamacpp-native' }, model, params, { port: 1, marker: 'm' });
    expect(calls.at(-1)?.cfg).toEqual({ kind: 'llamacpp-native' });
    expect(await wrapped.start(plan, new AbortController().signal)).toEqual({ started: true });
  });

  it('plans vLLM / SGLang forks with the options of their own --help', async () => {
    const { a, calls } = fakeAdapter('sglang-docker', { flags: ['--host'] });
    const wrapped = new CustomEngineAdapter(a, { list: async () => [engine({ base: 'sglang', run: { mode: 'docker', image: 'me/sglang:fork' } })] });
    await wrapped.plan({ kind: 'sglang-docker', customEngineId: 'fork' }, model, P(), { port: 1, marker: 'm' });
    expect((calls.find((c) => c.op === 'plan')?.opts as { knownFlags: Set<string> }).knownFlags).toEqual(new Set(['--host']));
    // Options given by the caller win; a help that fails gives none.
    await wrapped.plan({ kind: 'sglang-docker', customEngineId: 'fork' }, model, P(), { port: 1, marker: 'm', knownFlags: new Set(['--x']) });
    expect((calls.at(-1)?.opts as { knownFlags: Set<string> }).knownFlags).toEqual(new Set(['--x']));
    const failing = fakeAdapter('vllm-native', { capsFail: true });
    const w2 = new CustomEngineAdapter(failing.a, { list: async () => [engine({ base: 'vllm', run: { mode: 'native', path: '/v' } })] });
    await w2.plan({ kind: 'vllm-native', customEngineId: 'fork' }, model, P(), { port: 1, marker: 'm' });
    expect(failing.calls.at(-1)?.opts).not.toHaveProperty('knownFlags');
  });

  it('detects, probes and pulls through the expanded config', async () => {
    const { a, calls } = fakeAdapter('vllm-docker', { install: true });
    const e = engine({ base: 'vllm', run: { mode: 'docker', image: 'me/vllm:fork' } });
    const [wrapped] = withCustomEngines([a], { list: async () => [e] }) as [CustomEngineAdapter];
    expect(await wrapped.detect({ kind: 'vllm-docker', customEngineId: 'fork' })).toMatchObject({ available: true, customEngineId: 'fork' });
    expect(calls.at(-1)?.cfg).toMatchObject({ image: 'me/vllm:fork' });
    expect(await wrapped.detect({ kind: 'vllm-docker' })).not.toHaveProperty('customEngineId');
    expect(await wrapped.detect({ kind: 'vllm-docker', customEngineId: 'gone' })).toMatchObject({
      available: false,
      problems: ['ENGINE_NOT_INSTALLED'],
      problemParams: { reason: 'custom_engine_missing', id: 'gone' },
      customEngineId: 'gone',
    });
    await wrapped.capabilities({ kind: 'vllm-docker', customEngineId: 'fork' });
    expect(calls.at(-1)).toMatchObject({ op: 'caps', cfg: { image: 'me/vllm:fork' } });
    await wrapped.capabilities({ kind: 'vllm-docker' });
    expect(calls.at(-1)?.cfg).toEqual({ kind: 'vllm-docker' });
    await wrapped.installPlan?.({ kind: 'vllm-docker', customEngineId: 'fork' });
    expect(calls.at(-1)).toMatchObject({ op: 'installPlan', cfg: { image: 'me/vllm:fork' } });
    await wrapped.installPlan?.({ kind: 'vllm-docker' });
    expect(calls.at(-1)?.cfg).toEqual({ kind: 'vllm-docker' });
    await wrapped.install?.({ kind: 'vllm-docker', label: '', bytes: 0, items: [], data: {} }, () => {}, new AbortController().signal);
    expect(calls.at(-1)?.op).toBe('install');
    // An adapter that cannot install: neither can its wrapper.
    expect(new CustomEngineAdapter(fakeAdapter('external').a, { list: async () => [] }).installPlan).toBeUndefined();
  });
});
