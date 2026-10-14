// Programs with an OpenAI API: commands before and after the server, the placeholders of LLM Bench
// settings, what the Benchmark sends them and reads back, and the format versions of a saved engine.
import { describe, expect, it } from 'vitest';
import {
  commandKvTypes,
  commandLines,
  commandParams,
  commandPlaceholders,
  commandSettings,
  commandSettingValues,
  commandStepsOf,
  commandTuneProblem,
  customEngineDraftSchema,
  customEngineSchema,
  customEnginesSettingSchema,
  customEngineVersionOf,
  templateProblem,
  unknownPlaceholders,
  type CommandRun,
} from '../../../src/contract/custom-engines';
import { configParamsOf } from '../../../src/contract/configs';
import { launchParamsSchema } from '../../../src/contract/engines';

const P = (o: object = {}) => launchParamsSchema.parse(o);
const run = (o: Partial<CommandRun> = {}): CommandRun => ({ mode: 'command', template: 'srv --port {port}', api: 'completions', ...o });
const saved = (r: Partial<CommandRun>) => customEngineSchema.parse({ id: 'srv', name: 'Srv', base: 'openai-server', run: run(r) });
const reasons = (r: { success: boolean; error?: { issues: readonly object[] } | undefined }) =>
  r.error?.issues.map((i) => [(i as { path: unknown[] }).path.join('.'), (i as { params?: { reason?: string } }).params?.reason]) ?? [];

describe('commands before and after the server', () => {
  it('each is checked like the server command, without needing {port}', () => {
    expect(templateProblem('prep --model {model}', { server: false })).toBeUndefined();
    expect(templateProblem('prep --model {model}')).toBe('port_missing');
    expect(templateProblem('{model} x', { server: false })).toBe('program_placeholder');
    const draft = (r: Partial<CommandRun>) => customEngineDraftSchema.safeParse({ name: 's', base: 'openai-server', run: run(r) });
    expect(draft({ before: ['prep {model}'], after: ['clean'] }).success).toBe(true);
    expect(reasons(draft({ before: ['ok', 'prep {what}'], after: ['"open'] }))).toEqual([
      ['run.before.1', 'unknown_placeholder'],
      ['run.after.0', 'unbalanced_quote'],
    ]);
    expect(draft({ before: Array.from({ length: 11 }, () => 'x') }).success).toBe(false);
    expect(unknownPlaceholders('srv {port} {nope} {kv} {Other}')).toEqual(['nope', 'Other']);
  });

  it('lists them in the order they run, and the placeholders and settings they use', () => {
    const r = run({ before: ['prep {modelDir} {kv}'], template: 'srv --port {port} -c {ctx} -np {parallel}', after: ['clean {ubatch}'] });
    expect(commandStepsOf(run())).toEqual({ before: [], after: [] });
    expect(commandLines(r)).toEqual(['prep {modelDir} {kv}', 'srv --port {port} -c {ctx} -np {parallel}', 'clean {ubatch}']);
    expect(commandPlaceholders(r)).toEqual(['modelDir', 'kv', 'port', 'ctx', 'parallel', 'ubatch']);
    // In LLM Bench's order of settings, whatever the order in the commands.
    expect(commandSettings(r)).toEqual(['ctx', 'kv', 'parallel', 'ubatch']);
    expect(commandSettings(run({ template: 'srv --port {port} -ngl {gpuLayers} -b {batch}' }))).toEqual(['gpuLayers', 'batch']);
    expect(commandTuneProblem(r)).toBeUndefined();
    expect(commandTuneProblem(run())).toBe('tune_no_ctx');
    // {ctx} in a command before the server counts too (it may write a config file).
    expect(commandTuneProblem(run({ before: ['cfg --ctx {ctx}'] }))).toBeUndefined();
  });
});

describe('settings in the commands', () => {
  it('KV types: the engine’s own in precision order, else llama.cpp’s', () => {
    expect(commandKvTypes(run())).toEqual(['f16', 'q8_0', 'q4_0']);
    expect(commandKvTypes(run({ kvTypes: ['fp8', 'auto', 'fp8'] }))).toEqual(['auto', 'fp8']);
  });

  it('fills unset settings with LLM Bench’s defaults', () => {
    expect(commandSettingValues(run(), P())).toEqual({ ctx: '4096', kv: 'f16', parallel: '1', gpuLayers: '999', batch: '2048', ubatch: '512' });
    expect(commandSettingValues(run({ kvTypes: ['auto', 'fp8'] }), P({ maxModelLen: 2048, kvCacheType: 'q8_0', parallel: 4, gpuLayers: 20, batchSize: 4096, ubatchSize: 1024 }))).toEqual({
      ctx: '2048',
      // q8_0 is not one of its types: its first one.
      kv: 'auto',
      parallel: '4',
      gpuLayers: '20',
      batch: '4096',
      ubatch: '1024',
    });
    expect(commandSettingValues(run(), P({ contextSize: 8192, maxModelLen: 2048, kvCacheType: 'q4_0' }))).toMatchObject({ ctx: '8192', kv: 'q4_0' });
  });

  it('keeps only the settings the commands take (what reached the program, read back in results)', () => {
    const all = P({ contextSize: 8192, kvCacheType: 'q8_0', parallel: 2, gpuLayers: 10, batchSize: 1024, ubatchSize: 256, flashAttention: 'on', threads: 8, ropeScaling: { type: 'yarn', factor: 2, originalContext: 4096 }, extraArgs: ['--x'], env: { A: '1' } });
    expect(commandParams(run(), all)).toEqual({ extraArgs: ['--x'], env: { A: '1' } });
    const r = run({ template: 'srv --port {port} -c {ctx} -ctk {kv} -np {parallel} -ngl {gpuLayers} -b {batch} -ub {ubatch}' });
    expect(commandParams(r, all)).toEqual({ contextSize: 8192, kvCacheType: 'q8_0', parallel: 2, gpuLayers: 10, batchSize: 1024, ubatchSize: 256, extraArgs: ['--x'], env: { A: '1' } });
    // The other context field counts; a KV type it does not take, and unset settings, are left out.
    expect(commandParams(run({ template: 'srv --port {port} -c {ctx} --kv {kv} -np {parallel}', kvTypes: ['auto', 'fp8'] }), P({ maxModelLen: 2048, kvCacheType: 'q8_0' }))).toEqual({ contextSize: 2048, extraArgs: [], env: {} });
    expect(commandParams(r, P())).toEqual({ extraArgs: [], env: {} });
    // Configurations read them back like llama.cpp's (defaults dropped: the same configuration).
    expect(configParamsOf({ engineKind: 'command', params: commandParams(r, all), argv: ['srv', '--whatever'] })).toMatchObject({ contextSize: 8192, cacheTypeK: 'q8_0', cacheTypeV: 'q8_0', parallel: 2, gpuLayers: 10, batchSize: 1024, ubatchSize: 256, other: [] });
    expect(configParamsOf({ engineKind: 'command', params: P({ maxModelLen: 4096, gpuLayers: 999, batchSize: 2048 }) })).toEqual({ contextSize: 4096, other: [] });
    expect(configParamsOf({ engineKind: 'command', params: P() })).toEqual({ other: [] });
    // An external endpoint still reads nothing.
    expect(configParamsOf({ engineKind: 'external', params: P({ contextSize: 4096 }) })).toEqual({ other: [] });
  });
});

describe('format versions', () => {
  it('writes the lowest version that holds the engine; reads version 1 as it is', () => {
    expect(saved({}).schema).toBe(1);
    expect(saved({ template: 'srv --port {port} -c {ctx} --name {alias}' }).schema).toBe(1);
    expect(saved({ template: 'srv --port {port} --kv {kv}' }).schema).toBe(2);
    expect(saved({ before: ['prep'] }).schema).toBe(2);
    expect(saved({ after: ['clean'] }).schema).toBe(2);
    expect(saved({ kvTypes: ['f16'] }).schema).toBe(2);
    expect(customEngineVersionOf({ run: { mode: 'native', path: '/x' } })).toBe(1);
    // A version-1 engine as an older LLM Bench saved it: no steps, no KV types.
    const old = customEngineSchema.parse({ schema: 1, id: 'old', name: 'Old', base: 'openai-server', run: { mode: 'command', template: 'srv --port {port} -c {ctx}', api: 'chat' } });
    expect(old).toMatchObject({ schema: 1, run: { template: 'srv --port {port} -c {ctx}', api: 'chat' } });
    expect(commandStepsOf(old.run as CommandRun)).toEqual({ before: [], after: [] });
    // A version 2 entry written by this app reads back; one from a newer app is dropped, the rest kept.
    const v2 = saved({ before: ['prep'] });
    expect(customEnginesSettingSchema.parse([v2, { ...v2, id: 'newer', schema: 3 }, old]).map((e) => e.id)).toEqual(['srv', 'old']);
  });
});
