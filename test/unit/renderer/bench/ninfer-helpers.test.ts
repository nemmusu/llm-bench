import { describe, expect, it } from 'vitest';
import { launchParamsSchema } from '../../../../src/contract/engines';
import { ninferPresetsFor } from '../../../../src/contract/ninfer';
import type { RunResult } from '../../../../src/contract/results';
import { diffRows } from '../../../../src/renderer/components/bench/compare-rows';
import { modelOptions } from '../../../../src/renderer/components/bench/model-options';
import { presetOf } from '../../../../src/renderer/components/bench/rerun';
import { kTokens, presetTitle, serverNinfer, specText, withNinferPreset } from '../../../../src/renderer/components/engines/ninfer-format';
import { createFormatters } from '../../../../src/renderer/i18n';
import { seededRuns } from './fixtures';
import { localModel } from './world';

const P = (over: object = {}) => launchParamsSchema.parse(over);
const { t } = createFormatters('it');

describe('NInfer settings in words', () => {
  it('names contexts in K, the speculative backend, and the presets', () => {
    expect([65_536, 131_072, 240_000].map(kTokens)).toEqual(['64K', '128K', '240K']);
    expect(specText({ spec: 'mtp' }, t)).toBe('MTP 3');
    expect(specText({ spec: 'dflash' }, t)).toBe('DFlash 7');
    expect(specText({ spec: 'dflash2', draftTokens: 9 }, t)).toBe('DFlash2 9');
    expect(specText({}, t)).toBe('');
    const [recommended, tested] = ninferPresetsFor({ name: 'qwen3.8-27b' });
    expect(presetTitle(recommended!, t)).toBe('Consigliata da NInfer: contesto 240K, KV fp8, 2 utenti, MTP 3');
    expect(presetTitle(tested!, t)).toBe('Provata su RTX 5090: 64K per richiesta, KV int8 condivisa da 128K, 2 utenti, visione, MTP 3');
    // A preset without a pool or a KV type: the context and NInfer's bf16.
    expect(presetTitle({ id: 'ninfer-recommended', params: { contextSize: 8192, ninfer: { kvCapacity: 'auto' } } }, t)).toBe('Consigliata da NInfer: contesto 8K, KV bf16, 1 utenti, ');
  });

  it('puts a choice over the user\'s settings, and a server keeps NInfer\'s own defaults', () => {
    const overlay = { contextSize: 65_536, parallel: 2, ninfer: { kvDtype: 'int8' as const } };
    expect(withNinferPreset(undefined, undefined)).toBeUndefined();
    expect(withNinferPreset(P({ threads: 4, ninfer: { vision: true } }), overlay)).toMatchObject({ threads: 4, contextSize: 65_536, parallel: 2, ninfer: { vision: true, kvDtype: 'int8' } });
    expect(withNinferPreset(undefined, overlay)).toMatchObject({ contextSize: 65_536, extraArgs: [], ninfer: { kvDtype: 'int8' } });
    const bench = P({ ninfer: { kvDtype: 'fp8', prefixReuse: false, thinking: false } });
    expect(serverNinfer(bench).ninfer).toEqual({ kvDtype: 'fp8' });
    const plain = P({ contextSize: 4096 });
    expect(serverNinfer(plain)).toBe(plain);
  });
});

const ninferLocal = () => [
  localModel('q38', { format: 'ninfer', file: 'qwen3_8_27b_nvfp4.ninfer', files: ['qwen3_8_27b_nvfp4.ninfer'], quant: undefined, facts: { name: 'qwen3.8-27b' } }),
  { ...localModel('partial', { format: 'ninfer', file: 'x.ninfer' }), incomplete: { missing: ['x.ninfer'] } as never },
  localModel('gguf'),
];

/** A NInfer run of the 27B, from a seeded run. */
function ninferRun(): RunResult {
  const run = structuredClone(seededRuns()[0]!);
  run.engine = { kind: 'ninfer-wsl', name: 'NInfer', version: 'e31bc99b13f5', variant: 'Ubuntu-24.04' } as RunResult['engine'];
  run.model = { ...run.model, format: 'ninfer', source: 'local', displayName: 'q38-Q4_K_M', file: 'qwen3_8_27b_nvfp4.ninfer', weakKey: ninferLocal()[0]!.identity.weakKey } as RunResult['model'];
  run.launch.params = P({ contextSize: 65_536, parallel: 2, ninfer: { kvCapacity: 131_072, kvDtype: 'int8', spec: 'mtp', prefixReuse: false, thinking: false } });
  return run;
}

describe('NInfer models and results on the Benchmark page', () => {
  it('lists only complete .ninfer models for NInfer', () => {
    expect(modelOptions('ninfer-wsl', ninferLocal(), []).map((o) => o.key)).toEqual(['local:q38']);
  });

  it('a result\'s preset: its NInfer settings for a benchmark, a server without the benchmark-only ones', () => {
    const p = presetOf(ninferRun(), ninferLocal(), undefined);
    expect(p.draft.params?.ninfer).toMatchObject({ kvDtype: 'int8', prefixReuse: false });
    expect(p.serve.params?.ninfer).toEqual({ kvCapacity: 131_072, kvDtype: 'int8', spec: 'mtp' });
    expect(p.model).toBe('local');
  });

  it('compares the NInfer settings of two runs', () => {
    const a = ninferRun();
    const b = ninferRun();
    b.launch.params = P({ contextSize: 65_536, parallel: 2 });
    const row = diffRows(a, b, { t, bytes: (n: number) => `${n} B` }).find((r) => r.label === t('benchmark.expert.ninfer'));
    expect(row).toMatchObject({ a: '--kv-capacity 131072 --kv-dtype int8 --spec mtp --draft-tokens 3 --no-prefix-reuse --no-thinking' });
    expect(row?.b).toBe(t('common.auto'));
  });
});
