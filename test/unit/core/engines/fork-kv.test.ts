// A llama.cpp fork with its own KV caches: its --help read into the capabilities, the custom engine's
// check listing them, the launch arguments, and the fake engine acting as such a fork.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CustomEngine } from '../../../../src/contract/custom-engines';
import type { EngineStatus } from '../../../../src/contract/engines';
import { checkCustomEngine } from '../../../../src/core/engines/custom/routes';
import { llamaArgs } from '../../../../src/core/engines/llamacpp-native/args';
import { allowedValues, capsFromOutputs, currentLlamaCaps, parseHelp } from '../../../../src/core/engines/llamacpp-native/caps';
import { EngineRegistry } from '../../../../src/core/engines/registry';
import { isQuantizedKv, llamaFlashAttention, llamaKvArgs, llamaKvType } from '../../../../src/core/engines/shared/kv-flags';
import { FlagGate } from '../../../../src/core/engines/shared/standard-flags';
import type { EngineAdapter, EngineCaps } from '../../../../src/core/engines/types';
import { P } from '../bench/tune-lab';

const fixture = (name: string) => readFileSync(new URL(`../../../fixtures/llamacpp/${name}`, import.meta.url), 'utf8');
const VERSION = fixture('version-fork.stderr.txt');
const UPSTREAM = ['f32', 'f16', 'bf16', 'q8_0', 'q4_0', 'q4_1', 'iq4_nl', 'q5_0', 'q5_1'];
const TURBO = [...UPSTREAM, 'turbo4', 'turbo3', 'turbo2', 'turbo1.5', 'turbo3_tcq'];
const CLI = fileURLToPath(new URL('../../../fakes/fake-engine/cli.mjs', import.meta.url));
const TURBO_CLI = fileURLToPath(new URL('../../../fakes/fake-engine/turbo.mjs', import.meta.url));

describe('the KV types a build lists', () => {
  it('upstream llama.cpp (b10997 --help): its nine types, by every spelling of -ctk and -ctv', () => {
    const caps = capsFromOutputs(fixture('version.stderr.txt'), fixture('help.stdout.txt'));
    expect(caps.cacheTypes).toEqual(UPSTREAM);
    expect(caps.choices).toEqual({ '-ctk': UPSTREAM, '--cache-type-k': UPSTREAM, '-ctv': UPSTREAM, '--cache-type-v': UPSTREAM });
  });

  it('a TurboQuant-like fork: its own types after upstream’s (the draft model’s list is not read)', () => {
    const caps = capsFromOutputs(VERSION, fixture('help-turbo.stdout.txt'));
    expect(caps.cacheTypes).toEqual(TURBO);
    expect(caps.choices?.['--cache-type-k']).toEqual(TURBO);
    expect(caps.choices?.['-ctv']).toEqual(TURBO);
    expect(caps.choices?.['--cache-type-k-draft']).toBeUndefined();
  });

  it('a build without -ctv, or that prints no list: only what it says', () => {
    const onlyK = capsFromOutputs('', ['-ctk,  --cache-type-k TYPE              KV cache data type for K', '                                        allowed values: f16, q8_0, turbo3', '                                        (default: f16)'].join('\n'));
    expect(onlyK.choices).toEqual({ '-ctk': ['f16', 'q8_0', 'turbo3'], '--cache-type-k': ['f16', 'q8_0', 'turbo3'] });
    const noList = capsFromOutputs('', '-ctk,  --cache-type-k TYPE              KV cache data type for K\n');
    expect(noList.cacheTypes).toEqual([]);
    expect(noList.choices).toBeUndefined();
    expect(allowedValues(undefined)).toEqual([]);
    expect(allowedValues(parseHelp('-x N   allowed values: a b,c')[0])).toEqual(['a', 'b', 'c']);
    // The preview of a build not installed yet assumes upstream's list.
    expect(currentLlamaCaps().cacheTypes).toEqual(UPSTREAM);
  });
});

describe('the check of a custom engine', () => {
  const engine = (base: CustomEngine['base']): CustomEngine =>
    ({ schema: 1, id: 'turbo', name: 'TurboQuant', base, run: base === 'ninfer' ? { mode: 'ninfer', path: '/n' } : { mode: 'native', path: '/t' }, extraArgs: [], env: {}, notes: '' }) as CustomEngine;
  const adapter = (kind: EngineAdapter['kind'], choices: EngineCaps['choices']): EngineAdapter => ({
    kind,
    detect: async (): Promise<EngineStatus> => ({ kind, available: true, installed: true, version: 'b7001', problems: [], supported: true }),
    capabilities: async () => ({ flags: new Set(['-ctk', '-m']), tokenIdsInPrompt: true, timings: true, minTokens: false, fitFlag: false, ...(choices ? { choices } : {}) }),
    plan: async () => {
      throw new Error('not here');
    },
    start: async () => {
      throw new Error('not here');
    },
  });

  it('lists a llama.cpp fork’s KV types; other bases and builds that print none do not', async () => {
    const fork = await checkCustomEngine(new EngineRegistry([adapter('llamacpp-native', { '--cache-type-k': TURBO })]), engine('llamacpp'));
    expect(fork.kvCacheTypes).toEqual(TURBO);
    const silent = await checkCustomEngine(new EngineRegistry([adapter('llamacpp-native', undefined)]), engine('llamacpp'));
    expect(silent).not.toHaveProperty('kvCacheTypes');
    const ninfer = await checkCustomEngine(new EngineRegistry([adapter('ninfer-native', { '--cache-type-k': TURBO, '--kv-dtype': ['bf16'] })]), engine('ninfer'));
    expect(ninfer).toMatchObject({ kvDtypes: ['bf16'] });
    expect(ninfer).not.toHaveProperty('kvCacheTypes');
  });
});

describe('launch arguments with a fork’s type', () => {
  it('passes it as -ctk / -ctv, K = V, with flash attention on (every type but f32 / f16 / bf16 is quantized)', () => {
    expect(llamaKvType(P({ kvCacheType: 'turbo3' }))).toBe('turbo3');
    expect(llamaKvArgs(P({ kvCacheType: 'turbo1.5' }))).toEqual(['-ctk', 'turbo1.5', '-ctv', 'turbo1.5']);
    expect(['turbo3', 'q8_0', 'f32', 'bf16', 'f16'].map(isQuantizedKv)).toEqual([true, true, false, false, false]);
    expect(llamaFlashAttention(P({ kvCacheType: 'turbo3', flashAttention: 'off' }))).toBe('on');
    expect(llamaFlashAttention(P({ kvCacheType: 'bf16' }))).toBe('auto');
    const caps = capsFromOutputs(VERSION, fixture('help-turbo.stdout.txt'));
    const args = llamaArgs(P({ kvCacheType: 'turbo3' }), caps, { modelPath: '/m.gguf', host: '127.0.0.1', port: 8080, marker: 'm' }, new FlagGate('llamacpp', caps.flags));
    expect(args.join(' ')).toContain('-fa on -ctk turbo3 -ctv turbo3');
  });
});

describe('the fake engine as a fork with its own KV caches', () => {
  const run = (cli: string, kv: string) =>
    spawnSync(process.execPath, [cli, '-m', 'missing.gguf', '--port', '1', '-ctk', kv, '-ctv', kv], { encoding: 'utf8', env: { ...process.env, FAKE_ENGINE_HELP: '' }, timeout: 20_000 });

  it('lists turbo types in its --help and refuses a type its build does not have, like llama-server', () => {
    const help = spawnSync(process.execPath, [TURBO_CLI, '--help'], { encoding: 'utf8', timeout: 20_000 });
    expect(capsFromOutputs('', help.stdout).cacheTypes).toEqual(TURBO);
    const upstream = run(CLI, 'turbo3');
    expect(upstream.status).toBe(1);
    expect(upstream.stderr).toContain('error while handling argument "-ctk": Unsupported cache type: turbo3');
    const bogus = run(TURBO_CLI, 'turbo9');
    expect(bogus.status).toBe(1);
    expect(bogus.stderr).toContain('Unsupported cache type: turbo9');
    // A type it has gets past the arguments (then the missing model file stops it).
    const ok = run(TURBO_CLI, 'turbo3');
    expect(ok.stderr).not.toContain('Unsupported cache type');
  });
});
