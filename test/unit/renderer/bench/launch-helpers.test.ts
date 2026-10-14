import { describe, expect, it } from 'vitest';
import { launchParamsSchema } from '../../../../src/contract/engines';
import { ninferPresetsFor } from '../../../../src/contract/ninfer';
import { tunePicks } from '../../../../src/contract/tune-picks';
import {
  EMPTY_PARAMS_FORM,
  DEFAULT_SCENARIO_FORM,
  formFromParams,
  formFromScenario,
  hasCustomParams,
  ninferForm,
  paramsFromForm,
  parseUsers,
  scenarioFromForm,
  switchesOnly,
  usersExact,
} from '../../../../src/renderer/components/bench/expert-form';
import { kvShown } from '../../../../src/renderer/components/bench/launch-fields-panel';
import { abilitiesOf, switchOn, withServerSwitches, withSwitches, NO_SWITCHES } from '../../../../src/renderer/components/bench/model-switches';
import { clearNinferFields, formSaysNinfer, ninferPickOf, overNinfer } from '../../../../src/renderer/components/bench/ninfer-choice';
import { ninferSupportOf, ninferWithin, presetsWithin } from '../../../../src/renderer/components/bench/ninfer-support';
import { tuning } from '../tune/tune-fixtures';
import { localModel } from './world';

const P = (over: object = {}) => launchParamsSchema.parse(over);
const form = (over: Partial<typeof EMPTY_PARAMS_FORM> = {}) => ({ ...EMPTY_PARAMS_FORM, ...over });

describe('the expert form, per engine', () => {
  it('reads only the fields of the engine; NInfer: its own settings and their ranges', () => {
    const typed = form({ contextSize: '8192', maxModelLen: '4096', gpuLayers: '10', gpuMemoryUtilization: '0,8', dtype: 'half', ninferKvDtype: 'int8' });
    expect(paramsFromForm(typed, { base: 'llamacpp' }).params).toEqual(P({ contextSize: 8192, gpuLayers: 10 }));
    expect(paramsFromForm(typed, { base: 'vllm' }).params).toEqual(P({ maxModelLen: 4096, gpuMemoryUtilization: 0.8, dtype: 'half' }));
    expect(paramsFromForm(typed, { base: 'ninfer' }).params).toEqual(P({ contextSize: 8192, ninfer: { kvDtype: 'int8' } }));
    expect(paramsFromForm(typed, { base: 'external' }).params).toEqual(P({}));
    // NInfer serves at most 8 at once; MTP predicts at most 5 tokens, DFlash 15; a pool is tokens or "auto".
    expect(paramsFromForm(form({ parallel: '9' }), { base: 'ninfer' }).invalid).toEqual(['parallel']);
    expect(paramsFromForm(form({ parallel: '9' }), { base: 'vllm' }).invalid).toEqual([]);
    expect(paramsFromForm(form({ ninferSpec: 'mtp', ninferDraftTokens: '6' }), { base: 'ninfer' }).invalid).toEqual(['ninferDraftTokens']);
    expect(paramsFromForm(form({ ninferSpec: 'dflash', ninferDraftTokens: '9' }), { base: 'ninfer' }).params.ninfer).toEqual({ spec: 'dflash', draftTokens: 9 });
    expect(paramsFromForm(form({ ninferDraftTokens: '15' }), { base: 'ninfer' }).params.ninfer).toEqual({ draftTokens: 15 });
    expect(paramsFromForm(form({ ninferKvCapacity: 'AUTO' }), { base: 'ninfer' }).params.ninfer).toEqual({ kvCapacity: 'auto' });
    expect(paramsFromForm(form({ ninferKvCapacity: 'lots', ninferHostKvMib: 'x' }), { base: 'ninfer' }).invalid).toEqual(['ninferKvCapacity', 'ninferHostKvMib']);
    // The switches: image input and reasoning (NInfer: its own two).
    expect(paramsFromForm(form({ vision: 'off', reasoning: 'on' }), { base: 'llamacpp' }).params).toEqual(P({ vision: false, reasoning: true }));
    expect(paramsFromForm(form({ vision: 'off', ninferVision: 'on', ninferThinking: 'off' }), { base: 'ninfer' }).params).toEqual(P({ ninfer: { vision: true, thinking: false } }));
  });

  it('NInfer settings go back into the form as they were', () => {
    const n = { kvCapacity: 131_072, kvDtype: 'int8', spec: 'mtp' as const, draftTokens: 3, lmHeadDraft: true, vision: true, prefixReuse: true, deviceStateSlots: 2, hostStateSlots: 8, hostKvMib: 8192, thinking: false, preserveThinking: true };
    const back = formFromParams(P({ contextSize: 65_536, parallel: 2, ninfer: n, vision: false, reasoning: true }));
    expect(back).toMatchObject({ contextSize: '65536', parallel: '2', ninferKvCapacity: '131072', ninferSpec: 'mtp', ninferLmHeadDraft: 'on', ninferThinking: 'off', vision: 'off', reasoning: 'on' });
    expect(paramsFromForm(back, { base: 'ninfer' }).params.ninfer).toEqual(n);
    expect(ninferForm(undefined)).toMatchObject({ ninferKvCapacity: '', ninferSpec: 'default', ninferVision: 'default' });
    expect(hasCustomParams(P({ ninfer: {} }))).toBe(false);
    expect(hasCustomParams(P({ ninfer: { kvDtype: undefined } }))).toBe(false);
    expect(hasCustomParams(P({ ninfer: { kvDtype: 'int8' } }))).toBe(true);
    expect(switchesOnly(form({ contextSize: '1', reasoning: 'off', ninferVision: 'on' }))).toEqual(form({ reasoning: 'off', ninferVision: 'on' }));
  });

  it('the KV select shows what the engine reads the value as', () => {
    expect(kvShown('llamacpp', 'fp8')).toBe('q8_0');
    expect(kvShown('llamacpp', 'q4_0')).toBe('q4_0');
    expect(kvShown('llamacpp', 'auto')).toBe('default');
    expect(kvShown('vllm', 'q4_0')).toBe('fp8');
    expect(kvShown('sglang', 'f16')).toBe('default');
    expect(kvShown('vllm', 'default')).toBe('default');
    // A fork's own type stays as it is for llama.cpp; vLLM and SGLang read it as their automatic one.
    expect(kvShown('llamacpp', 'turbo3')).toBe('turbo3');
    expect(kvShown('vllm', 'turbo3')).toBe('default');
    // A program with an OpenAI API: exactly the settings its commands take.
    expect(paramsFromForm(form({ contextSize: '1', gpuLayers: '2', kvCacheType: 'turbo3' }), { base: 'external', fields: ['contextSize', 'kvCacheType'] }).params).toEqual(P({ contextSize: 1, kvCacheType: 'turbo3' }));
  });
});

describe('"Solo N utenti insieme"', () => {
  it('one number means 1..N, or only N; lists are taken as written; the form keeps which', () => {
    expect(parseUsers('3')).toEqual([1, 2, 3]);
    expect(parseUsers('3', true)).toEqual([3]);
    expect(parseUsers('1, 4', true)).toEqual([1, 4]);
    expect(usersExact([2])).toBe(true);
    expect(usersExact([1])).toBe(false);
    expect(usersExact([1, 2])).toBe(false);
    const exact = scenarioFromForm({ ...DEFAULT_SCENARIO_FORM, concurrency: '2', concurrencyExact: true, sessions: '3', sessionsExact: true }).scenario;
    expect(exact.steps.find((s) => s.kind === 'concurrency')).toMatchObject({ levels: [2] });
    expect(exact.steps.find((s) => s.kind === 'sessions')).toMatchObject({ levels: [3] });
    expect(formFromScenario(exact)).toMatchObject({ concurrency: '2', concurrencyExact: true, sessions: '3', sessionsExact: true });
    // llama-bench is llama.cpp's own: left out for another engine.
    const lb = { ...DEFAULT_SCENARIO_FORM, llamaBench: true };
    expect(scenarioFromForm(lb, 42, { llamaCpp: false }).scenario.steps.some((s) => s.kind === 'llama-bench')).toBe(false);
    expect(scenarioFromForm(lb).scenario.steps.some((s) => s.kind === 'llama-bench')).toBe(true);
  });
});

describe('what NInfer can do with a model and build', () => {
  it('heads, vision and the proposal head from the manifest; KV types from the build', () => {
    const official = ninferSupportOf({ facts: { components: ['text', 'vision', 'mtp', 'dflash2'] } }, ['bf16', 'int8']);
    expect(official).toEqual({ kvDtypes: ['bf16', 'int8'], specs: ['mtp', 'dflash2'], vision: true, lmHead: true });
    const gguf = ninferSupportOf({ repo: 'nerkyor/Qwen3.6-27B-GGUF-NInfer', facts: { components: ['text', 'mtp'], layouts: ['gguf_blocks_v1'] } }, undefined);
    expect(gguf).toMatchObject({ kvDtypes: ['bf16', 'int8', 'fp8', 'nvfp4', 'k8v4'], specs: ['mtp'], vision: false, lmHead: false });
    // Not known: nothing ruled out.
    expect(ninferSupportOf(undefined, [])).toMatchObject({ specs: ['mtp', 'dflash', 'dflash2'], vision: true, lmHead: true });
    expect(ninferSupportOf({ facts: { components: ['text', 'mtp'], noManifest: true } }, undefined).vision).toBe(true);
    // A preset as this model runs it: no head it lacks, no --lm-head-draft without the proposal head.
    expect(ninferWithin({ spec: 'dflash', draftTokens: 7, lmHeadDraft: true, kvDtype: 'fp8' }, official)).toEqual({ kvDtype: 'fp8' });
    expect(ninferWithin({ spec: 'mtp', draftTokens: 3, lmHeadDraft: true, vision: true }, gguf)).toEqual({ spec: 'mtp', draftTokens: 3 });
    const presets = presetsWithin(ninferPresetsFor({ name: 'qwen3.6-27b', repo: 'nerkyor/x-GGUF-NInfer' }), gguf);
    expect(presets.map((p) => p.params.ninfer.lmHeadDraft)).toEqual([undefined, undefined, undefined]);
  });
});

describe('the NInfer card and the expert fields as one', () => {
  const presets = ninferPresetsFor({ name: 'qwen3.8-27b' });
  const rec = presets.find((p) => p.id === 'ninfer-recommended')!;
  const abilities = { vision: true, reasoning: true } as const;

  it('the fields go over the pick; the card says the pick, another preset, the result’s own, or "custom"', () => {
    expect(overNinfer(undefined, P({ contextSize: 1 }))).toEqual(P({ contextSize: 1 }));
    expect(overNinfer(rec.params, undefined)).toEqual(P({ ...rec.params }));
    expect(overNinfer(rec.params, P({ contextSize: 4096, ninfer: { kvDtype: 'int8' } }))).toMatchObject({ contextSize: 4096, parallel: 2, ninfer: { kvDtype: 'int8', spec: 'mtp' } });
    expect(formSaysNinfer(undefined)).toBe(false);
    expect(formSaysNinfer(P({ ninfer: { kvDtype: undefined } }))).toBe(false);
    const pick = (formParams: ReturnType<typeof P> | undefined, run?: { kvDtype: string }) =>
      ninferPickOf({ chosen: 'ninfer-recommended', form: formParams, overlay: rec.params, presets, run, abilities });
    expect(pick(undefined)).toBe('ninfer-recommended');
    // Thinking on and vision on (the model has it) are what an unset value means: still the preset.
    expect(pick(P({ ninfer: { thinking: true, vision: true } }))).toBe('ninfer-recommended');
    const rtx = presets.find((p) => p.id === 'rtx5090-tested')!;
    expect(ninferPickOf({ chosen: 'auto', form: P(rtx.params), overlay: undefined, presets, run: undefined, abilities })).toBe('rtx5090-tested');
    expect(pick(P({ ninfer: { thinking: false } }))).toBe('custom');
    expect(ninferPickOf({ chosen: 'run', form: P({ contextSize: 8192, ninfer: { kvDtype: 'int8' } }), overlay: { ninfer: { kvDtype: 'int8' } }, presets, run: { kvDtype: 'int8' }, abilities: { vision: false, reasoning: true } })).toBe('run');
    expect(clearNinferFields(form({ contextSize: '1', parallel: '2', ninferKvDtype: 'int8', ninferThinking: 'off', gpuLayers: '3' }))).toEqual(form({ gpuLayers: '3' }));
  });

  it('the switches: on when the model has it, said explicitly for NInfer', () => {
    expect(abilitiesOf('ninfer', localModel('n', { format: 'ninfer', facts: { components: ['text', 'vision'] } }))).toEqual({ vision: true, reasoning: true });
    expect(abilitiesOf('ninfer', localModel('n', { format: 'ninfer', facts: { components: ['text'] } }))).toEqual({ vision: false, reasoning: true });
    expect(abilitiesOf('ninfer', localModel('n', { format: 'ninfer', facts: {} }))).toEqual({ vision: undefined, reasoning: true });
    expect(abilitiesOf('llamacpp', { ...localModel('g'), auxiliary: [{ kind: 'mmproj', path: 'mmproj.gguf' }] })).toEqual({ vision: true, reasoning: undefined });
    expect(abilitiesOf('vllm', undefined)).toEqual({ vision: undefined, reasoning: undefined });
    expect(switchOn('ninfer', 'vision', NO_SWITCHES, { vision: false })).toBe(false);
    expect(switchOn('ninfer', 'reasoning', NO_SWITCHES)).toBe(true);
    expect(switchOn('vllm', 'reasoning', { ...NO_SWITCHES, reasoning: 'off' })).toBe(false);
    expect(withSwitches(P({ contextSize: 1 }), 'llamacpp', NO_SWITCHES, abilities)).toEqual(P({ contextSize: 1 }));
    expect(withSwitches(P(), 'ninfer', NO_SWITCHES, abilities)).toEqual(P({ ninfer: { thinking: true, vision: true } }));
    expect(withSwitches(P({ ninfer: { vision: true } }), 'ninfer', { ...NO_SWITCHES, ninferThinking: 'off' }, { vision: false, reasoning: true })).toEqual(P({ ninfer: { thinking: false } }));
    // A server: NInfer thinks by default (said only when off); vision is said for a model that has it.
    expect(withServerSwitches(undefined, 'ninfer', NO_SWITCHES, { vision: undefined, reasoning: true })).toBeUndefined();
    expect(withServerSwitches(undefined, 'ninfer', NO_SWITCHES, abilities)).toEqual(P({ ninfer: { vision: true } }));
    expect(withServerSwitches(P({ ninfer: { vision: true } }), 'ninfer', { ...NO_SWITCHES, ninferThinking: 'off' }, { vision: false, reasoning: true })).toEqual(P({ ninfer: { thinking: false } }));
    expect(withServerSwitches(undefined, 'llamacpp', NO_SWITCHES, abilities)).toBeUndefined();
    expect(withServerSwitches(undefined, 'llamacpp', { ...NO_SWITCHES, vision: 'off', reasoning: 'off' }, abilities)).toEqual(P({ vision: false, reasoning: false }));
    expect(withServerSwitches(P({ contextSize: 2 }), 'vllm', { ...NO_SWITCHES, reasoning: 'on' }, abilities)).toEqual(P({ contextSize: 2, reasoning: true }));
    expect(withServerSwitches(P(), 'sglang', { ...NO_SWITCHES, vision: 'on' }, abilities)).toEqual(P({ vision: true }));
    expect(withServerSwitches(P({ contextSize: 2 }), 'external', { ...NO_SWITCHES, reasoning: 'off' }, abilities)).toEqual(P({ contextSize: 2 }));
  });
});

describe('the settings LLM Bench prepares from a tune', () => {
  it('largest context, fastest writing and reading, best quality: one entry per combination', () => {
    const picks = tunePicks(tuning());
    expect(picks.map((p) => [p.ids, p.combination])).toEqual([
      [['max-context', 'fastest-read'], 2],
      [['fastest-write', 'best-quality'], 0],
    ]);
    expect(picks[0]).toMatchObject({ kvType: 'q4_0', maxContext: 65_536, decodeTps: 60 });
    expect(picks[1]).toMatchObject({ kvType: 'f16', depth: 1024, decodeTps: 92 });
  });

  it('without a recommended one, or with nothing measured', () => {
    const t = tuning();
    expect(tunePicks({ ...t, combinations: t.combinations.map((c) => ({ ...c, outcome: 'oom' as const })) })).toEqual([]);
    const { recommended: _r, ...rest } = t;
    expect(tunePicks(rest).map((p) => p.ids)).toEqual([['fastest-write', 'best-quality'], ['fastest-read']]);
    // Same precision: the larger context wins, then the faster one with the context full.
    const q8 = t.combinations[1]!;
    const twins = { ...t, recommended: undefined, combinations: [{ ...q8, maxContext: 16_384 }, { ...q8, sweep: [] }, q8] };
    expect(tunePicks(twins).find((p) => p.ids.includes('best-quality'))?.combination).toBe(2);
    // A fork's own (turbo) type counts as the least precise.
    const turbo = { ...t, recommended: undefined, combinations: [{ ...t.combinations[3]!, kvType: 'turbo3', sweep: [] }, { ...t.combinations[1]!, sweep: [] }] };
    expect(tunePicks(turbo).find((p) => p.ids.includes('best-quality'))?.combination).toBe(1);
    // "Più utenti": no sweep, so no peaks.
    expect(tunePicks({ ...t, combinations: t.combinations.map((c) => ({ ...c, sweep: [] })) }).map((p) => p.ids)).toEqual([['max-context'], ['best-quality']]);
  });
});
