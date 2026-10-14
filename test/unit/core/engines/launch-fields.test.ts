/**
 * What the launch settings panel shows is what runs: every field an engine offers (launch-fields.ts)
 * becomes its flag in the real adapter's command line, and a value typed for another engine changes
 * nothing in it (expert-form.ts paramsFromForm reads only the engine's own fields).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { engineBaseOf, ENGINE_KINDS, type LaunchParams } from '../../../../src/contract/engines';
import { capsFromOutputs, type LlamaCaps } from '../../../../src/core/engines/llamacpp-native/caps';
import { llamaArgs } from '../../../../src/core/engines/llamacpp-native/args';
import { ninferServeArgs } from '../../../../src/core/engines/ninfer/args';
import { sglangServeArgs } from '../../../../src/core/engines/shared/sglang';
import { trtllmServeArgs } from '../../../../src/core/engines/shared/trtllm';
import { FlagGate, STANDARD_FLAGS } from '../../../../src/core/engines/shared/standard-flags';
import { vllmServeArgs } from '../../../../src/core/engines/shared/vllm-args';
import { EMPTY_PARAMS_FORM, paramsFromForm, type ParamsField, type ParamsForm } from '../../../../src/renderer/components/bench/expert-form';
import { fieldOf, fieldsOf, LAUNCH_FIELDS, type LaunchBase } from '../../../../src/renderer/components/bench/launch-fields';

const HELP = readFileSync(new URL('../../../fixtures/llamacpp/help.stdout.txt', import.meta.url), 'utf8');
const CAPS = capsFromOutputs('', HELP) as LlamaCaps;

/** The real command line of each engine for these params (the program and model left out). */
function argv(base: LaunchBase, params: LaunchParams): string[] {
  switch (base) {
    case 'llamacpp':
      return llamaArgs(params, CAPS, { modelPath: 'm.gguf', host: '127.0.0.1', port: 8080, marker: 'mk' }, new FlagGate('llamacpp', undefined));
    case 'vllm':
      return vllmServeArgs(params, { model: 'org/m', positional: true, host: '127.0.0.1', port: 8000, servedName: 'mk' });
    case 'sglang':
      return sglangServeArgs(params, { model: 'org/m', host: '127.0.0.1', port: 30000, servedName: 'mk' });
    case 'ninfer':
      return ninferServeArgs(params, { model: 'm.ninfer', host: '127.0.0.1', port: 8080, modelId: 'mk' });
    case 'trtllm':
      return trtllmServeArgs(params, { model: 'org/m', host: '127.0.0.1', port: 8000, servedName: 'mk' });
  }
}

/** A value for each field that differs from every engine's default. */
const VALUE: Partial<Record<ParamsField, string>> = {
  contextSize: '12288',
  maxModelLen: '12288',
  gpuLayers: '20',
  flashAttention: 'on',
  kvCacheType: 'q8_0',
  batchSize: '1024',
  ubatchSize: '256',
  threads: '6',
  parallel: '3',
  gpuMemoryUtilization: '0,8',
  dtype: 'half',
  quantization: 'awq',
  yarnTarget: '131072',
  yarnOriginal: '32768',
  ninferKvCapacity: '65536',
  ninferKvDtype: 'int8',
  ninferSpec: 'mtp',
  ninferDraftTokens: '2',
  ninferLmHeadDraft: 'on',
  ninferVision: 'on',
  ninferPrefixReuse: 'off',
  ninferDeviceStateSlots: '3',
  ninferHostStateSlots: '9',
  ninferHostKvMib: '4096',
  ninferThinking: 'off',
  ninferPreserveThinking: 'on',
  trtllmKvMemory: '0,8',
  trtllmTp: '2',
  trtllmTrustRemoteCode: 'on',
};

/** Fields whose flag comes with another field (draft tokens need a prediction; the cache slots need reuse on). */
const WITH: Partial<Record<ParamsField, Partial<ParamsForm>>> = {
  ninferDraftTokens: { ninferSpec: 'mtp' },
  ninferLmHeadDraft: { ninferSpec: 'mtp' },
  ninferDeviceStateSlots: { ninferPrefixReuse: 'on' },
  ninferHostStateSlots: { ninferPrefixReuse: 'on' },
  ninferHostKvMib: { ninferPrefixReuse: 'on' },
  yarnTarget: { yarnOriginal: '32768' },
};

const form = (patch: Partial<ParamsForm>): ParamsForm => ({ ...EMPTY_PARAMS_FORM, ...patch });
const BASES = Object.keys(LAUNCH_FIELDS) as LaunchBase[];
/** Image input and reasoning are switches the adapters map themselves (no flag named here). */
const SWITCHES = new Set<ParamsField>(['vision', 'reasoning']);

describe('the launch fields of each engine are its real flags', () => {
  for (const base of BASES) {
    it(`${base}: every field it shows reaches its command line, with its flag`, () => {
      const empty = argv(base, paramsFromForm(form({}), { base }).params);
      for (const f of LAUNCH_FIELDS[base]) {
        if (SWITCHES.has(f.field)) continue;
        const parsed = paramsFromForm(form({ ...WITH[f.field], [f.field]: VALUE[f.field] }), { base, trainedContext: 32_768 });
        expect(parsed.invalid, `${base} ${f.field}`).toEqual([]);
        const args = argv(base, parsed.params);
        expect(args, `${base} ${f.field}`).not.toEqual(empty);
        // The flag the panel names is in the command ("-ctk / -ctv" is two flags, "--rope-scaling yarn" a flag and its value).
        for (const flag of f.flag.split(' / ').map((x) => x.split(' ')[0] as string)) expect(args, `${base} ${f.field} ${flag}`).toContain(flag);
      }
    });

    it(`${base}: a value typed for another engine changes nothing in its command`, () => {
      const own = new Set(fieldsOf(base).map((f) => f.field));
      const others = Object.keys(VALUE).filter((k) => !own.has(k as ParamsField)) as ParamsField[];
      const empty = argv(base, paramsFromForm(form({}), { base }).params);
      for (const field of others) {
        const parsed = paramsFromForm(form({ [field]: VALUE[field] }), { base });
        expect(parsed.invalid).toEqual([]);
        expect(argv(base, parsed.params), `${base} ignores ${field}`).toEqual(empty);
      }
    });
  }

  it('every setting a field names is the one a fork’s missing flag would say (standard-flags.ts)', () => {
    for (const base of BASES) {
      const settings = new Set(STANDARD_FLAGS[base].map((s) => s.setting));
      for (const f of LAUNCH_FIELDS[base]) {
        if (SWITCHES.has(f.field) || f.field.startsWith('ninferDevice') || f.field.startsWith('ninferHost') || f.field === 'ninferPreserveThinking') continue;
        expect(settings.has(f.setting), `${base} ${f.field} → ${f.setting}`).toBe(true);
      }
    }
  });

  it('every engine kind but an external server or a command template has fields; NInfer has no YaRN', () => {
    for (const kind of ENGINE_KINDS) {
      const base = engineBaseOf(kind);
      expect(fieldsOf(base).length > 0, kind).toBe(kind !== 'external' && kind !== 'command');
    }
    expect(fieldOf('ninfer', 'yarnTarget')).toBeUndefined();
    expect(fieldOf('vllm', 'yarnTarget')?.flag).toBe('--hf-overrides');
    expect(fieldOf('llamacpp', 'gpuMemoryUtilization')).toBeUndefined();
    expect(fieldOf('sglang', 'gpuMemoryUtilization')?.flag).toBe('--mem-fraction-static');
  });
});
