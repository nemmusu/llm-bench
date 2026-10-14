/**
 * NInfer variants in the contract: custom engines of base 'ninfer' (NInfer-all, forks), the built-in
 * NInfer-all template and its rules, the KV types a variant adds, the model card's settings, the build
 * request of a variant, and the facts of an artifact without a manifest.
 */
import { describe, expect, it } from 'vitest';
import {
  customBaseOfKind,
  customBaseReads,
  customEngineDraftSchema,
  customEngineForModel,
  customEngineKindOf,
  customEngineTemplate,
  matchesModel,
  templateForLayout,
  templateForModel,
} from '../../../src/contract/custom-engines';
import { ERROR_CODES } from '../../../src/contract/errors';
import { ninferManifestFromName } from '../../../src/contract/formats';
import { launchParamsSchema } from '../../../src/contract/engines';
import {
  NINFER_VARIANT_BUILD,
  ninferBuildEventKind,
  ninferBuildRequestSchema,
  ninferFit,
  ninferKvBytes,
  ninferKvBytesPerToken,
  ninferPresetsFor,
  ninferServeOf,
} from '../../../src/contract/ninfer';
import { recipeTemplate } from '../../../src/contract/recipes';

const GGUF_NINFER = {
  displayName: 'Qwen3.8-27B-Coder390-EfficientThink-Q6_K-MTP',
  repo: 'nerkyor/Qwen3.8-27B-Coder390-EfficientThink-Opus5.5-GPT6Astra-Grok4.7-DSV4Pro-K3-SFT-RLOO-GGUF-NInfer',
  file: 'Qwen3.8-27B-Coder390-EfficientThink-Q6_K-MTP.ninfer',
};

describe('NInfer variants as custom engines', () => {
  it('a variant runs as NInfer: in WSL with a distro, natively without one', () => {
    const run = { mode: 'ninfer' as const, path: '/home/u/ninfer-all', distro: 'Ubuntu-24.04', source: { url: 'https://github.com/iamwavecut/ninfer-all.git', branch: 'master' } };
    expect(customEngineDraftSchema.safeParse({ name: 'NInfer-all', base: 'ninfer', run }).success).toBe(true);
    expect(customEngineKindOf({ base: 'ninfer', run })).toBe('ninfer-wsl');
    expect(customEngineKindOf({ base: 'ninfer', run: { mode: 'ninfer', path: '/opt/ninfer-all' } })).toBe('ninfer-native');
    expect(customBaseOfKind('ninfer-wsl')).toBe('ninfer');
    expect(customBaseOfKind('ninfer-native')).toBe('ninfer');
    // Base and mode go together, both ways; a source is an https git repository with a branch that is not an option.
    expect(customEngineDraftSchema.safeParse({ name: 'x', base: 'ninfer', run: { mode: 'native', path: '/x' } }).success).toBe(false);
    expect(customEngineDraftSchema.safeParse({ name: 'x', base: 'llamacpp', run }).success).toBe(false);
    expect(customEngineDraftSchema.safeParse({ name: 'x', base: 'ninfer', run: { ...run, source: { url: 'git@github.com:x/y.git' } } }).success).toBe(false);
    expect(customEngineDraftSchema.safeParse({ name: 'x', base: 'ninfer', run: { ...run, source: { url: run.source.url, branch: '--upload-pack=x' } } }).success).toBe(false);
  });

  it('NInfer-all: offered for GGUF-NInfer artifacts, and for a model a run could not read (gguf_blocks_v1)', () => {
    const tpl = templateForModel(GGUF_NINFER);
    expect(tpl).toMatchObject({ id: 'ninfer-all', base: 'ninfer', label: 'NInfer-all', source: { url: 'https://github.com/iamwavecut/ninfer-all.git', branch: 'master' }, dir: '~/ninfer-all' });
    expect(templateForModel({ displayName: 'qwen3_8_27b_nvfp4', repo: 'neroued/Qwen3.8-27B-nvfp4-NInfer' })).toBeUndefined();
    expect(templateForModel({ displayName: 'renamed.ninfer', unreadable: ['gguf_blocks_v1'] })?.id).toBe('ninfer-all');
    expect(templateForModel({ displayName: 'renamed.ninfer', unreadable: ['other_layout'] })).toBeUndefined();
    expect(templateForLayout('gguf_blocks_v1')?.id).toBe('ninfer-all');
    expect(templateForLayout('row_split_k128_v1')).toBeUndefined();
    expect(customEngineTemplate('ninfer-all')).toBe(tpl);
    expect(customEngineTemplate(undefined)).toBeUndefined();
    // A rule without layouts (saved before them) still matches by name.
    expect(matchesModel({ names: ['gguf-ninfer'], quants: [] }, GGUF_NINFER)).toBe(true);
  });

  it('only for a model whose format the engine reads: the plain GGUFs of a "…-GGUF-NInfer" repo go to llama.cpp', () => {
    expect(templateForModel({ ...GGUF_NINFER, format: 'ninfer' })?.id).toBe('ninfer-all');
    expect(templateForModel({ ...GGUF_NINFER, file: 'Qwen3.8-27B-Q6_K.gguf', format: 'gguf' })).toBeUndefined();
    expect(templateForModel({ ...GGUF_NINFER, format: 'safetensors' })).toBeUndefined();
    // The Bonsai fork reads GGUF only.
    expect(templateForModel({ displayName: 'Ternary-Bonsai-8B', file: 'Ternary-Bonsai-8B-PQ2_0.gguf', format: 'gguf' })?.id).toBe('prismml-bonsai');
    expect(templateForModel({ displayName: 'Ternary-Bonsai-8B', repo: 'prism-ml/Ternary-Bonsai-8B', format: 'safetensors' })).toBeUndefined();
    expect(customBaseReads('ninfer', 'ninfer')).toBe(true);
    expect(customBaseReads('ninfer', undefined)).toBe(true);
    expect(customBaseReads('llamacpp', 'ninfer')).toBe(false);
    expect(customBaseReads('openai-server', 'safetensors')).toBe(true);
    const variant = { base: 'ninfer' as const, match: { names: ['GGUF-NInfer'], quants: [], layouts: [] } };
    const fork = { base: 'llamacpp' as const, match: { names: ['GGUF-NInfer'], quants: [], layouts: [] } };
    expect(customEngineForModel([variant, fork], { ...GGUF_NINFER, format: 'gguf' })).toBe(fork);
    expect(customEngineForModel([variant, fork], { ...GGUF_NINFER, format: 'ninfer' })).toBe(variant);
  });

  it('a new error code for a model the build cannot read', () => {
    expect(ERROR_CODES).toContain('ENGINE_MODEL_UNSUPPORTED');
  });
});

describe('NInfer KV types and the model card', () => {
  it('bytes per KV element: the official types, a variant\'s from its bit widths, anything else as bf16', () => {
    expect(ninferKvBytes('bf16')).toBe(2);
    expect(ninferKvBytes('int8')).toBeCloseTo(1.03125);
    expect(ninferKvBytes('rk8v4')).toBeCloseTo(ninferKvBytes('k8v4'));
    expect(ninferKvBytes('rk4v4')).toBeCloseTo(0.5625);
    expect(ninferKvBytes('rk2v4-e8')).toBeCloseTo((0.25 + 1 / 16 + 0.5625) / 2);
    expect(ninferKvBytes('mystery')).toBe(2);
    expect(ninferKvBytesPerToken('dense-27b', 'rk8v4', 'mtp')).toBeLessThan(ninferKvBytesPerToken('dense-27b', 'int8', 'mtp'));
    expect(launchParamsSchema.safeParse({ ninfer: { kvDtype: 'rk8v4' } }).success).toBe(true);
    expect(launchParamsSchema.safeParse({ ninfer: { kvDtype: '--evil' } }).success).toBe(false);
  });

  it('"Consigliata dalla scheda del modello" first for GGUF-NInfer artifacts: the card\'s run example', () => {
    const presets = ninferPresetsFor({ label: GGUF_NINFER.displayName, repo: GGUF_NINFER.repo, file: GGUF_NINFER.file });
    expect(presets.map((p) => p.id)).toEqual(['model-card', 'ninfer-recommended', 'rtx5090-tested']);
    expect(presets[0]?.params).toEqual({ contextSize: 102_400, parallel: 4, ninfer: { kvCapacity: 'auto', kvDtype: 'rk8v4', spec: 'mtp', draftTokens: 3 } });
    expect(ninferPresetsFor({ name: 'qwen3.8-27b' }).map((p) => p.id)).toEqual(['ninfer-recommended', 'rtx5090-tested']);
    // The card's own 409,600 shared tokens do not fit an RTX 5090 next to a 23.4 GB Q6_K artifact (as on the user's PC)…
    const input = { artifactBytes: 23_379_962_880, manifest: ninferManifestFromName(GGUF_NINFER.file), label: GGUF_NINFER.displayName, gpu: { totalMiB: 32_607 } };
    const card = presets[0]?.params as NonNullable<(typeof presets)[number]['params']>;
    expect(ninferFit({ ...input, params: { ...card, ninfer: { ...card.ninfer, kvCapacity: 409_600 } } }).level).toBe('no');
    // …the pool sized to what fits does, with room for a full 100K request and more.
    const fit = ninferFit({ ...input, params: card });
    expect(fit.level).toBe('tight');
    expect(fit.notes).toContain('ninfer.auto-capacity');
    expect(fit.maxConcurrency).toBeGreaterThan(1);
  });
});

describe('the guided build of a variant', () => {
  it('a request names the repository and the custom engine; its progress has its own kind', () => {
    const req = ninferBuildRequestSchema.parse({ kind: 'ninfer-wsl', distro: 'Ubuntu-24.04', source: { url: 'https://github.com/iamwavecut/ninfer-all.git', branch: 'master' }, variant: { template: 'ninfer-all', name: 'NInfer-all' } });
    expect(ninferBuildEventKind(req)).toBe(NINFER_VARIANT_BUILD);
    expect(ninferBuildEventKind({ kind: 'ninfer-wsl' })).toBe('ninfer-wsl');
    expect(ninferBuildRequestSchema.safeParse({ kind: 'ninfer-wsl', variant: { id: 'Not An Id', name: 'x' } }).success).toBe(false);
  });

  it('ninfer-serve of a path: the program, a checkout, its build folder', () => {
    expect(ninferServeOf('/home/u/ninfer-all/')).toEqual({ serve: '/home/u/ninfer-all/build/apps/ninfer-serve', repo: '/home/u/ninfer-all' });
    expect(ninferServeOf('/home/u/ninfer-all/build')).toEqual({ serve: '/home/u/ninfer-all/build/apps/ninfer-serve', repo: '/home/u/ninfer-all' });
    expect(ninferServeOf('/build')).toEqual({ serve: '/build/apps/ninfer-serve', repo: '/' });
    expect(ninferServeOf('build')).toEqual({ serve: 'build/apps/ninfer-serve', repo: '.' });
    expect(ninferServeOf('/opt/bin/ninfer-serve')).toEqual({ serve: '/opt/bin/ninfer-serve' });
  });
});

describe('an artifact without a manifest', () => {
  it('its name says which heads it carries (never vision)', () => {
    expect(ninferManifestFromName('GGUF-NInfer/Qwen3.8-27B-Coder390-EfficientThink-Q6_K-MTP.ninfer')).toEqual({ components: ['text', 'mtp'] });
    expect(ninferManifestFromName('C:\\m\\qwen3_8_27b-dflash2.ninfer')).toEqual({ components: ['text', 'dflash2'] });
    expect(ninferManifestFromName('qwen3_6_35b_a3b_DFlash.ninfer')).toEqual({ components: ['text', 'dflash'] });
    expect(ninferManifestFromName('qwen3_8_27b_nvfp4.ninfer')).toEqual({ components: ['text'] });
  });
});

describe('the NInfer-all recipe', () => {
  it('chooses NInfer-all for GGUF-NInfer artifacts only', () => {
    const t = recipeTemplate('ninfer-all')!;
    expect(t.blocked({ ...GGUF_NINFER, format: 'ninfer' })).toBeUndefined();
    expect(t.blocked({ displayName: 'qwen3_8_27b_nvfp4', format: 'ninfer' })).toBe('not_gguf_ninfer');
    expect(t.blocked({ ...GGUF_NINFER, format: 'gguf' })).toBe('format');
    expect(t.build({ ...GGUF_NINFER, format: 'ninfer' })).toEqual({ engine: { type: 'template', template: 'ninfer-all' } });
  });
});
