/** The start flow without React: engines of a format, the models (a test's to download again), tests, presets, ports, sources. */
import { describe, expect, it } from 'vitest';
import type { ConfigEntry } from '../../../../src/contract/configs';
import {
  engineChoices,
  engineKeyOf,
  optionFor,
  parsePort,
  presetsForModel,
  serverModelOptions,
  presetSource,
  testedConfigs,
} from '../../../../src/renderer/components/servers/server-flow';
import { curatedModel, localModel, serverPreset } from '../bench/world';

const entry = (id: string, over: Partial<ConfigEntry> = {}): ConfigEntry => ({
  id,
  engineKind: 'llamacpp-native',
  engineLabel: 'llama.cpp b11438',
  engineRelease: 'b11438',
  model: { key: 'k', name: 'Qwen3 8B', weakKey: 'local/other', sha256: 'abc' },
  gpu: { key: 'g', name: 'RTX 5090', hostId: 'h', hostLabel: 'PC' },
  params: { other: [] },
  points: [{ depth: 4096, decodeTps: 100, n: 1 }],
  tags: [],
  sources: [],
  latest: '2026-10-07T10:00:00.000Z',
  ...over,
});

describe('server flow helpers', () => {
  it('engines: NInfer only where it runs; a custom engine’s key', () => {
    expect(engineChoices('ninfer', [], [], 'linux').map((c) => c.key)).toEqual(['builtin:ninfer-native']);
    expect(engineChoices('ninfer', [], [], 'darwin')).toEqual([]);
    expect(engineKeyOf({ kind: 'llamacpp-native', customEngineId: 'prism' })).toBe('custom:prism');
  });

  it('models: a .ninfer artifact without quant or size; a test’s model added once to download again', () => {
    const bare = localModel('n', { format: 'ninfer', quant: undefined, sizeBytes: undefined, facts: undefined, displayName: 'Bare' });
    const [ninfer] = serverModelOptions([bare], []);
    expect(ninfer).toMatchObject({ key: 'local:n', name: 'Bare' });
    expect(ninfer).not.toHaveProperty('quant');
    expect(ninfer).not.toHaveProperty('sizeBytes');
    const hub = { repo: 'org/x-GGUF', file: 'x.gguf', revision: 'r', name: 'X' };
    const curated = curatedModel('x');
    expect(serverModelOptions([], [curated], hub).filter((o) => o.source === 'curated')).toHaveLength(1);
    const onPc = localModel('y', { repo: 'org/y-GGUF', file: 'y.gguf' });
    expect(serverModelOptions([onPc], [], { ...hub, repo: 'org/y-GGUF', file: 'y.gguf' })).toHaveLength(1);
    const options = serverModelOptions([onPc], [], { ...hub, repo: 'org/z', file: 'z.gguf' });
    expect(options.map((o) => o.key)).toEqual(['local:y', 'curated:preset:org/z/z.gguf']);
    // A draft's model: by library id, or by Hugging Face file (suggested, or already on the PC).
    expect(optionFor(options, undefined)).toBeUndefined();
    expect(optionFor(options, { repo: 'org/z', file: 'z.gguf' })?.key).toBe('curated:preset:org/z/z.gguf');
    expect(optionFor(options, { repo: 'org/y-GGUF', file: 'y.gguf' })?.key).toBe('local:y');
    expect(optionFor(options, { repo: 'org/none', file: 'none.gguf' })).toBeUndefined();
  });

  it('tests of a model: by file hash or weak key, this engine, never the ones that spilled', () => {
    const list = [
      entry('hash'),
      entry('weak', { model: { key: 'k', name: 'Q', weakKey: 'local/q' }, points: [{ depth: 4096, decodeTps: 120, n: 1 }] }),
      entry('spill', { spill: true }),
      entry('vllm', { engineKind: 'vllm-docker' }),
    ];
    expect(testedConfigs(list, { weakKey: 'local/q', sha256: 'abc' }, 'llamacpp-native').map((c) => c.entry.id)).toEqual(['weak', 'hash']);
    expect(testedConfigs(list, { weakKey: 'local/q' }, 'llamacpp-native').map((c) => c.entry.id)).toEqual(['weak']);
  });

  it('presets of a model: the library model, or the same Hugging Face file', () => {
    const hubPreset = serverPreset('h', { model: { repo: 'org/x', file: 'x.gguf' } });
    const all = [serverPreset('l'), hubPreset, serverPreset('other', { model: { repo: 'org/x', file: 'y.gguf' } })];
    expect(presetsForModel(all, { localId: 'qwen3-8b' }).map((p) => p.id)).toEqual(['l']);
    expect(presetsForModel(all, { repo: 'org/x', file: 'x.gguf' }).map((p) => p.id)).toEqual(['h']);
  });

  it('ports and where a preset’s settings come from', () => {
    expect(parsePort(' ')).toEqual({ port: undefined, invalid: false });
    expect(parsePort('8090')).toEqual({ port: 8090, invalid: false });
    expect(parsePort('80')).toEqual({ port: undefined, invalid: true });
    expect(parsePort('8o8o')).toEqual({ port: undefined, invalid: true });
    const best = { tab: 'best' as const, tunedRunId: undefined, test: undefined };
    expect(presetSource({ ...best, best: 'auto' })).toEqual({ kind: 'auto' });
    expect(presetSource({ ...best, best: 'auto', tunedRunId: 't' })).toEqual({ kind: 'tuned', runId: 't' });
    expect(presetSource({ ...best, best: 'draft', test: { runId: 'r', combo: 2 } })).toEqual({ kind: 'config', runId: 'r', combo: 2 });
    expect(presetSource({ ...best, best: 'config:x', test: { runId: 'r' } })).toEqual({ kind: 'config', runId: 'r' });
    expect(presetSource({ ...best, best: 'config:x' })).toEqual({ kind: 'custom' });
    expect(presetSource({ ...best, tab: 'presets', best: 'auto' })).toEqual({ kind: 'custom' });
  });

  it('tests measured without a generation speed come last and have no headline', () => {
    const quiet = entry('quiet', { model: { key: 'k', name: 'Q', weakKey: 'local/q' }, points: [{ depth: 4096, prefillTps: 900, n: 1 }] });
    const fast = entry('fast', { model: { key: 'k', name: 'Q', weakKey: 'local/q' } });
    expect(testedConfigs([quiet, fast], { weakKey: 'local/q' }, 'llamacpp-native').map((c) => [c.entry.id, c.headline?.depth])).toEqual([
      ['fast', 4096],
      ['quiet', undefined],
    ]);
  });
});
