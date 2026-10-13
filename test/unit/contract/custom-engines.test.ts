import { describe, expect, it } from 'vitest';
import {
  CUSTOM_ENGINE_TEMPLATES,
  customBaseOfKind,
  customEngineConfigOf,
  customEngineDraftSchema,
  customEngineForModel,
  customEngineIdFor,
  customEngineKindOf,
  customEngineSchema,
  customEnginesSettingSchema,
  expandCommandTemplate,
  matchesModel,
  splitCommandLine,
  templateForModel,
  templatePlaceholders,
  templateProblem,
  type CustomEngine,
  type CustomEngineDraft,
} from '../../../src/contract/custom-engines';
import { engineBaseOf, isDockerKind, launchParamsSchema } from '../../../src/contract/engines';
import { settingsSchema } from '../../../src/contract/settings';

const fork: CustomEngineDraft = { name: 'PrismML fork', base: 'llamacpp', run: { mode: 'native', path: '/home/u/prism/llama-server' } };
const saved = (over: Partial<CustomEngine> = {}): CustomEngine => customEngineSchema.parse({ id: 'prismml-fork', ...fork, ...over });
const reasons = (r: { success: boolean; error?: { issues: readonly object[] } | undefined }) =>
  r.error?.issues.map((i) => (i as { params?: { reason?: string } }).params?.reason) ?? [];

describe('custom engine schema', () => {
  it('fills defaults and keeps a format version', () => {
    const e = saved();
    expect(e).toMatchObject({ schema: 1, extraArgs: [], env: {}, notes: '' });
    expect(e.match).toBeUndefined();
  });

  it('accepts every base with its run mode', () => {
    expect(customEngineDraftSchema.safeParse({ name: 'v', base: 'vllm', run: { mode: 'docker', image: 'me/vllm-fork:1.0' } }).success).toBe(true);
    expect(customEngineDraftSchema.safeParse({ name: 's', base: 'sglang', run: { mode: 'native', path: '/venv' } }).success).toBe(true);
    expect(
      customEngineDraftSchema.safeParse({ name: 'o', base: 'openai-server', run: { mode: 'command', template: 'server --port {port} --model "{model}"' } }).success,
    ).toBe(true);
  });

  it('rejects a base and mode that do not go together', () => {
    expect(reasons(customEngineDraftSchema.safeParse({ ...fork, run: { mode: 'command', template: 'x --port {port}' } }))).toEqual(['mode_mismatch']);
    expect(reasons(customEngineDraftSchema.safeParse({ name: 'o', base: 'openai-server', run: { mode: 'native', path: '/x' } }))).toEqual(['mode_mismatch']);
  });

  it('rejects a bad image, a bad template and a rule that does not compile', () => {
    expect(reasons(customEngineDraftSchema.safeParse({ name: 'v', base: 'vllm', run: { mode: 'docker', image: '-rm everything' } }))).toEqual(['bad_image']);
    expect(reasons(customEngineDraftSchema.safeParse({ name: 'o', base: 'openai-server', run: { mode: 'command', template: 'server' } }))).toEqual(['port_missing']);
    expect(reasons(customEngineDraftSchema.safeParse({ ...fork, match: { names: ['ok', '/(/'], quants: [] } }))).toEqual(['bad_pattern']);
  });

  it('rejects bad ids and environment names', () => {
    expect(customEngineSchema.safeParse({ id: 'Bad Id', ...fork }).success).toBe(false);
    expect(customEngineSchema.safeParse({ id: 'ok', ...fork, env: { 'NOT VALID': '1' } }).success).toBe(false);
    expect(customEngineSchema.safeParse({ id: 'ok', ...fork, env: { CUDA_VISIBLE_DEVICES: '0' } }).success).toBe(true);
  });

  it('settings drop an invalid entry instead of resetting everything', () => {
    const list = customEnginesSettingSchema.parse([saved(), { id: 'broken' }, 42]);
    expect(list.map((e) => e.id)).toEqual(['prismml-fork']);
    expect(customEnginesSettingSchema.parse(undefined)).toEqual([]);
    const s = settingsSchema.parse({ theme: 'dark', customEngines: [saved(), { nope: true }] });
    expect(s.theme).toBe('dark');
    expect(s.customEngines).toHaveLength(1);
    expect(settingsSchema.parse({}).customEngines).toEqual([]);
  });
});

describe('kinds', () => {
  it('maps base and mode to the kind it runs as', () => {
    expect(customEngineKindOf(saved())).toBe('llamacpp-native');
    expect(customEngineKindOf({ base: 'llamacpp', run: { mode: 'docker', image: 'x' } })).toBe('llamacpp-docker');
    expect(customEngineKindOf({ base: 'vllm', run: { mode: 'native', path: 'x' } })).toBe('vllm-native');
    expect(customEngineKindOf({ base: 'vllm', run: { mode: 'docker', image: 'x' } })).toBe('vllm-docker');
    expect(customEngineKindOf({ base: 'sglang', run: { mode: 'native', path: 'x' } })).toBe('sglang-native');
    expect(customEngineKindOf({ base: 'sglang', run: { mode: 'docker', image: 'x' } })).toBe('sglang-docker');
    expect(customEngineKindOf({ base: 'openai-server', run: { mode: 'command', template: 'x {port}', api: 'chat' } })).toBe('command');
    expect(customEngineConfigOf(saved())).toEqual({ kind: 'llamacpp-native', customEngineId: 'prismml-fork' });
  });

  it('knows the base of every kind', () => {
    expect(customBaseOfKind('llamacpp-docker')).toBe('llamacpp');
    expect(customBaseOfKind('vllm-native')).toBe('vllm');
    expect(customBaseOfKind('sglang-docker')).toBe('sglang');
    expect(customBaseOfKind('command')).toBe('openai-server');
    expect(customBaseOfKind('external')).toBeUndefined();
    expect(['llamacpp-native', 'llamacpp-docker', 'vllm-native', 'sglang-docker'].map((k) => engineBaseOf(k as never))).toEqual(['llamacpp', 'llamacpp', 'vllm', 'sglang']);
    expect(engineBaseOf('vllm-docker')).toBe('vllm');
    expect(engineBaseOf('sglang-native')).toBe('sglang');
    expect(engineBaseOf('command')).toBe('external');
    expect(engineBaseOf('external')).toBe('external');
    expect(['llamacpp-docker', 'vllm-docker', 'sglang-docker', 'sglang-native'].map((k) => isDockerKind(k as never))).toEqual([true, true, true, false]);
  });

  it('gives a free id from the name', () => {
    expect(customEngineIdFor('Fork PrismML di llama.cpp', [])).toBe('fork-prismml-di-llama-cpp');
    expect(customEngineIdFor('Più veloce!', ['piu-veloce'])).toBe('piu-veloce-2');
    expect(customEngineIdFor('x', ['x', 'x-2'])).toBe('x-3');
    expect(customEngineIdFor('!!!', [])).toBe('engine');
    expect(customEngineIdFor('a'.repeat(39) + '-b', [])).toBe('a'.repeat(39));
  });
});

describe('command templates', () => {
  it('splits like a shell without running one', () => {
    expect(splitCommandLine(`C:\\tools\\srv.exe --model "C:\\My Models\\m.gguf" --name 'a "b"'  -x ""`)).toEqual([
      'C:\\tools\\srv.exe',
      '--model',
      'C:\\My Models\\m.gguf',
      '--name',
      'a "b"',
      '-x',
      '',
    ]);
    expect(splitCommandLine('  ')).toEqual([]);
    expect(splitCommandLine('a "b')).toBeUndefined();
  });

  it('says what is wrong with a template', () => {
    expect(templateProblem('srv --port {port} --model {model}')).toBeUndefined();
    expect(templateProblem('srv "--port {port}')).toBe('unbalanced_quote');
    expect(templateProblem('"" --port {port}')).toBe('empty');
    expect(templateProblem('   ')).toBe('empty');
    expect(templateProblem('srv --port {port} --x {what}')).toBe('unknown_placeholder');
    expect(templateProblem('srv --model {model}')).toBe('port_missing');
    expect(templateProblem('{model} --port {port}')).toBe('program_placeholder');
    expect(templatePlaceholders('a {port} {model} {port}')).toEqual(['port', 'model']);
  });

  it('fills placeholders inside each argument', () => {
    const argv = expandCommandTemplate('python -m srv --model "{model}" --dir={modelDir} --port {port} --host {host} --ctx {ctx} --name {alias} --json \'{"a":1}\'', {
      model: 'C:\\My Models\\m.gguf',
      modelDir: 'C:\\My Models',
      port: '8123',
      host: '127.0.0.1',
      ctx: '4096',
      alias: 'gpubench-1',
    });
    expect(argv).toEqual([
      'python',
      '-m',
      'srv',
      '--model',
      'C:\\My Models\\m.gguf',
      '--dir=C:\\My Models',
      '--port',
      '8123',
      '--host',
      '127.0.0.1',
      '--ctx',
      '4096',
      '--name',
      'gpubench-1',
      '--json',
      '{"a":1}',
    ]);
    expect(expandCommandTemplate('srv {nope} {port}', { model: '', modelDir: '', port: '1', host: '', ctx: '', alias: '' })).toEqual(['srv', '{nope}', '1']);
    expect(expandCommandTemplate('srv "x', { model: '', modelDir: '', port: '1', host: '', ctx: '', alias: '' })).toEqual([]);
  });
});

describe('model rules', () => {
  const bonsai = { displayName: 'Ternary-Bonsai-8B', repo: 'prism-ml/Ternary-Bonsai-8B-gguf', file: 'Ternary-Bonsai-8B-PQ2_0.gguf' };

  it('matches words, regular expressions and quants', () => {
    expect(matchesModel(undefined, bonsai)).toBe(false);
    expect(matchesModel({ names: ['BONSAI'], quants: [] }, bonsai)).toBe(true);
    expect(matchesModel({ names: ['/ternary-.*-8b/'], quants: [] }, bonsai)).toBe(true);
    expect(matchesModel({ names: ['/^qwen/g'], quants: [] }, bonsai)).toBe(false);
    expect(matchesModel({ names: ['/(/'], quants: [] }, bonsai)).toBe(false);
    expect(matchesModel({ names: [], quants: ['pq2_0'] }, { displayName: 'x', quant: 'PQ2_0' })).toBe(true);
    expect(matchesModel({ names: [], quants: ['PQ2_0'] }, { displayName: 'x', file: 'model-PQ2_0.gguf' })).toBe(true);
    expect(matchesModel({ names: [], quants: ['PQ2_0'] }, { displayName: 'x' })).toBe(false);
    expect(matchesModel({ names: ['qwen'], quants: ['Q4_K_M'] }, bonsai)).toBe(false);
  });

  it('suggests the first matching engine, else the built-in template', () => {
    const a = saved({ id: 'a', match: { names: ['qwen'], quants: [] } });
    const b = saved({ id: 'b', match: { names: ['bonsai'], quants: [] } });
    expect(customEngineForModel([a, b, saved({ id: 'c' })], bonsai)?.id).toBe('b');
    expect(customEngineForModel([a], bonsai)).toBeUndefined();
    expect(templateForModel(bonsai)?.id).toBe('prismml-bonsai');
    expect(templateForModel({ displayName: 'x', file: 'x-PTQ1_0.gguf' })?.id).toBe('prismml-bonsai');
    expect(templateForModel({ displayName: 'Qwen3-8B', file: 'Qwen3-8B-Q4_K_M.gguf' })).toBeUndefined();
    expect(CUSTOM_ENGINE_TEMPLATES.every((t) => customEngineDraftSchema.safeParse({ name: t.id, base: t.base, run: { mode: 'native', path: 'x' }, match: t.match }).success)).toBe(true);
  });
});

describe('RoPE scaling', () => {
  it('is an optional launch setting with bounds', () => {
    expect(launchParamsSchema.parse({ ropeScaling: { type: 'yarn', factor: 4, originalContext: 32768 } }).ropeScaling).toEqual({
      type: 'yarn',
      factor: 4,
      originalContext: 32768,
    });
    expect(launchParamsSchema.safeParse({ ropeScaling: { type: 'yarn', factor: 0.5, originalContext: 32768 } }).success).toBe(false);
    expect(launchParamsSchema.safeParse({ ropeScaling: { type: 'ntk', factor: 2, originalContext: 32768 } }).success).toBe(false);
    expect(launchParamsSchema.parse({}).ropeScaling).toBeUndefined();
  });
});
