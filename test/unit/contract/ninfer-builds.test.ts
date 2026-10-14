/** NInfer's two builds in the contract: which one a model needs, NInfer-all's saved engine, its requests and events, presets by KV type. */
import { describe, expect, it } from 'vitest';
import { customEngineSchema, isNinferAllEngine, ninferAllEngineOf, NINFER_ALL_SOURCE, sameGitRepo } from '../../../src/contract/custom-engines';
import { ninferAllRequest, ninferBuildEventKind, ninferBuildFor, ninferPresetsFor, runsOnNinferAll } from '../../../src/contract/ninfer';

const all = customEngineSchema.parse({ id: 'ninfer-all', name: 'NInfer-all', base: 'ninfer', template: 'ninfer-all', run: { mode: 'ninfer', path: '/a', distro: 'Ubuntu' } });
const byHand = customEngineSchema.parse({ id: 'mine', name: 'Mine', base: 'ninfer', run: { mode: 'ninfer', path: '/m', source: { url: 'https://github.com/IAMWAVECUT/ninfer-all/' } } });
const native = customEngineSchema.parse({ id: 'nat', name: 'Native', base: 'ninfer', template: 'ninfer-all', run: { mode: 'ninfer', path: '/n' } });
const fork = customEngineSchema.parse({ id: 'fork', name: 'Fork', base: 'ninfer', run: { mode: 'ninfer', path: '/f', source: { url: 'https://github.com/x/fusion.git' } } });
const plain = customEngineSchema.parse({ id: 'p', name: 'P', base: 'ninfer', run: { mode: 'ninfer', path: '/p' } });
const llama = customEngineSchema.parse({ id: 'l', name: 'L', base: 'llamacpp', template: 'ninfer-all', run: { mode: 'native', path: '/l' } });

describe('which build of NInfer a model needs', () => {
  it('its manifest decides; its name only when the manifest could not be read; else what a run could not read', () => {
    expect(ninferBuildFor({ format: 'gguf', facts: { layouts: ['gguf_blocks_v1'] } })).toEqual({ build: 'official' });
    expect(ninferBuildFor({ format: 'ninfer', facts: { layouts: ['contiguous_le_v1', 'gguf_blocks_v1'] } })).toEqual({ build: 'all', why: 'layout', layout: 'gguf_blocks_v1' });
    // A manifest without GGUF blocks: the official build, whatever the name says.
    expect(ninferBuildFor({ format: 'ninfer', repo: 'x/Y-GGUF-NInfer', facts: { layouts: ['contiguous_le_v1'] } })).toEqual({ build: 'official' });
    expect(ninferBuildFor({ format: 'ninfer', repo: 'nerkyor/Qwen3.8-27B-GGUF-NInfer' })).toEqual({ build: 'all', why: 'name', layout: 'gguf_blocks_v1' });
    expect(ninferBuildFor({ format: 'ninfer', displayName: 'm', unreadable: ['other', 'gguf_blocks_v1'] })).toEqual({ build: 'all', why: 'history', layout: 'gguf_blocks_v1' });
    expect(ninferBuildFor({ format: 'ninfer', displayName: 'm', unreadable: ['other'] })).toEqual({ build: 'official' });
    expect(ninferBuildFor({ format: 'ninfer', displayName: 'm' })).toEqual({ build: 'official' });
  });

  it('a launch runs on NInfer-all: a NInfer engine (or NInfer-all itself), never another variant chosen on purpose', () => {
    const model = { format: 'ninfer', facts: { layouts: ['gguf_blocks_v1'] } };
    expect(runsOnNinferAll('ninfer-wsl', undefined, model)).toBe(true);
    expect(runsOnNinferAll('ninfer-wsl', all, model)).toBe(true);
    expect(runsOnNinferAll('ninfer-wsl', fork, model)).toBe(false);
    expect(runsOnNinferAll('llamacpp-native', undefined, model)).toBe(false);
    expect(runsOnNinferAll('ninfer-wsl', undefined, undefined)).toBe(false);
    expect(runsOnNinferAll('ninfer-native', undefined, { format: 'ninfer' })).toBe(false);
  });
});

describe("NInfer-all's saved engine", () => {
  it('made from its template, or cloned from its repository by hand; first of its kind', () => {
    expect(isNinferAllEngine(all)).toBe(true);
    expect(isNinferAllEngine(byHand)).toBe(true);
    expect(isNinferAllEngine(fork)).toBe(false);
    expect(isNinferAllEngine(plain)).toBe(false);
    expect(isNinferAllEngine(llama)).toBe(false);
    expect(ninferAllEngineOf([fork, all, byHand])).toBe(all);
    expect(ninferAllEngineOf([native, all], 'ninfer-wsl')).toBe(all);
    expect(ninferAllEngineOf([native, all], 'ninfer-native')).toBe(native);
    expect(ninferAllEngineOf([fork])).toBeUndefined();
    expect(sameGitRepo('https://github.com/iamwavecut/ninfer-all', NINFER_ALL_SOURCE.url)).toBe(true);
  });

  it('a build request of NInfer-all: its repository, its folder, its engine; anything else as it was', () => {
    expect(ninferAllRequest({ kind: 'ninfer-wsl', distro: 'U', build: 'all' })).toEqual({
      kind: 'ninfer-wsl',
      distro: 'U',
      build: 'all',
      dir: '~/ninfer-all',
      source: NINFER_ALL_SOURCE,
      variant: { template: 'ninfer-all', name: 'NInfer-all' },
    });
    expect(ninferAllRequest({ kind: 'ninfer-wsl', build: 'all', dir: '/x', source: { url: 'https://github.com/me/all.git' } }, { id: 'mine', name: 'Mine' })).toMatchObject({
      dir: '/x',
      source: { url: 'https://github.com/me/all.git' },
      variant: { template: 'ninfer-all', name: 'Mine', id: 'mine' },
    });
    const official = { kind: 'ninfer-native' as const, dir: '/n' };
    expect(ninferAllRequest(official)).toBe(official);
    expect(ninferBuildEventKind({ kind: 'ninfer-wsl', build: 'all' })).toBe('ninfer-all');
    expect(ninferBuildEventKind({ kind: 'ninfer-wsl', variant: { name: 'F' } })).toBe('ninfer-variant');
    expect(ninferBuildEventKind({ kind: 'ninfer-wsl' })).toBe('ninfer-wsl');
  });
});

describe('presets by the KV types the build has', () => {
  it('the model card\'s rk8v4 only where the build lists it; unknown: every preset', () => {
    const model = { repo: 'nerkyor/Qwen3.8-27B-Coder390-GGUF-NInfer', name: 'qwen3.8-27b' };
    expect(ninferPresetsFor(model).map((p) => p.id)).toEqual(['model-card', 'ninfer-recommended', 'rtx5090-tested']);
    expect(ninferPresetsFor(model, ['bf16', 'int8', 'fp8', 'nvfp4', 'k8v4']).map((p) => p.id)).toEqual(['ninfer-recommended', 'rtx5090-tested']);
    expect(ninferPresetsFor(model, ['bf16', 'int8', 'fp8', 'rk8v4']).map((p) => p.id)).toEqual(['model-card', 'ninfer-recommended', 'rtx5090-tested']);
    // The model card's settings, exactly: 100K a request, rk8v4 shared by 400K, 4 users, MTP 3; never the heads the card warns about.
    const card = ninferPresetsFor(model)[0];
    expect(card?.params).toEqual({ contextSize: 102_400, parallel: 4, ninfer: { kvCapacity: 'auto', kvDtype: 'rk8v4', spec: 'mtp', draftTokens: 3 } });
    expect(card?.params.ninfer.lmHeadDraft).toBeUndefined();
  });
});
