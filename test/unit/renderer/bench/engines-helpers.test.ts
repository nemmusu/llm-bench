import { describe, expect, it } from 'vitest';
import { launchParamsSchema } from '../../../../src/contract/engines';
import { diffRows } from '../../../../src/renderer/components/compare/compare-diff';
import { itemOf } from '../../../../src/renderer/components/compare/compare-model';
import { EMPTY_ENGINE_FORM, engineConfigOf, engineFormOf } from '../../../../src/renderer/components/bench/engine-form';
import { engineKindOfLabel } from '../../../../src/renderer/components/bench/live-now';
import { engineName } from '../../../../src/renderer/components/bench/load-progress';
import { modelOptions } from '../../../../src/renderer/components/bench/model-options';
import { guessNeeds } from '../../../../src/renderer/components/bench/needs';
import { noteText } from '../../../../src/renderer/components/bench/notes';
import { presetOf } from '../../../../src/renderer/components/bench/rerun';
import { createFormatters } from '../../../../src/renderer/i18n';
import { seeded, IDS } from './fixtures';
import { localModel } from './world';

const f = createFormatters('it');

describe('engine helpers for SGLang, command engines and forks', () => {
  it('engine choice ⇄ config: SGLang images and Python, Docker kinds', () => {
    const form = { ...EMPTY_ENGINE_FORM, image: ' lmsysorg/sglang:v0.5.21 ', sglangPath: ' /venv ' };
    expect(engineConfigOf('sglang-docker', form, true).config).toEqual({ kind: 'sglang-docker', image: 'lmsysorg/sglang:v0.5.21' });
    expect(engineConfigOf('sglang-native', form, true).config).toEqual({ kind: 'sglang-native', sglangPath: '/venv' });
    expect(engineConfigOf('sglang-native', EMPTY_ENGINE_FORM, true).config).toEqual({ kind: 'sglang-native' });
    expect(engineFormOf({ kind: 'sglang-native', sglangPath: '/v' }).sglangPath).toBe('/v');
    expect(engineFormOf(undefined).sglangPath).toBe('');
  });

  it('models: SGLang like vLLM, a command engine any local model', () => {
    const gguf = localModel('g');
    const st = localModel('s', { format: 'safetensors' });
    expect(modelOptions('command', [gguf, st], []).map((o) => o.key)).toEqual(['local:g', 'local:s']);
    expect(modelOptions('sglang-docker', [gguf, st], []).map((o) => o.key)).toEqual(['local:s']);
  });

  it('a custom engine needs nothing guessed: the plan will tell', () => {
    const status = { kind: 'llamacpp-native' as const, available: false, installed: false, problems: ['ENGINE_NOT_INSTALLED'], supported: true, location: 'x' };
    expect(guessNeeds({ engine: { kind: 'llamacpp-native', customEngineId: 'p' }, status, option: undefined, modelLabel: 'm' })).toEqual([]);
    expect(guessNeeds({ engine: { kind: 'sglang-docker', customEngineId: 'p' }, status: { ...status, kind: 'sglang-docker' }, option: undefined, modelLabel: 'm' })).toEqual([]);
    expect(guessNeeds({ engine: { kind: 'sglang-docker' }, status: { ...status, kind: 'sglang-docker' }, option: undefined, modelLabel: 'm' })).toEqual([{ kind: 'image', engine: 'sglang-docker', label: 'x' }]);
  });

  it('labels and live screens know SGLang', () => {
    expect(engineName('sglang-native')).toBe('SGLang');
    expect(engineName('command')).toBeUndefined();
    expect(engineKindOfLabel('SGLang v0.5.21')).toBe('sglang-docker');
    expect(noteText({ code: 'flag_unsupported', params: { engine: 'PrismML', flags: '-ub' } }, f)).toEqual({
      code: 'flag_unsupported',
      tone: 'warning',
      title: 'Il motore non conosce alcune impostazioni',
      body: 'PrismML non conosce -ub: per queste impostazioni userà il suo valore predefinito.',
    });
  });

  it('presets keep a custom engine by id, SGLang by its image or Python', () => {
    const run = seeded(IDS.full);
    const fork = { ...run, engine: { ...run.engine, name: 'PrismML', customEngine: { id: 'prismml', name: 'PrismML', base: 'llamacpp' as const } } };
    expect(presetOf(fork, [], undefined).draft.engine).toEqual({ kind: 'llamacpp-native', customEngineId: 'prismml' });
    const sgDocker = { ...run, engine: { kind: 'sglang-docker' as const, name: 'SGLang', image: 'lmsysorg/sglang:v0.5.21' } };
    expect(presetOf(sgDocker, [], undefined).draft.engine).toEqual({ kind: 'sglang-docker', image: 'lmsysorg/sglang:v0.5.21' });
    const sgNative = { ...run, engine: { kind: 'sglang-native' as const, name: 'SGLang', executable: '/venv/bin/python' } };
    expect(presetOf(sgNative, [], undefined).draft.engine).toEqual({ kind: 'sglang-native', sglangPath: '/venv/bin/python' });
  });

  it('compare: the RoPE scaling in words', () => {
    const a = seeded(IDS.full);
    const b = { ...a, launch: { ...a.launch, params: launchParamsSchema.parse({ ropeScaling: { type: 'yarn', factor: 4, originalContext: 32768 } }) } };
    const row = diffRows([itemOf(a), itemOf(b)], f).find((r) => r.label === 'Estensione del contesto (RoPE)');
    expect(row).toMatchObject({ values: ['Automatico', 'yarn ×4 (32768)'], differs: true });
  });
});
