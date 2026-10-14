import { describe, expect, it } from 'vitest';
import { launchParamsSchema } from '../../../../src/contract/engines';
import { ninferTestDefaults } from '../../../../src/core/engines/ninfer/defaults';

const P = (over: object = {}) => launchParamsSchema.parse(over);
const sized = P({ contextSize: 8192, ninfer: { prefixReuse: false, thinking: true } });

describe('"Scelte da LLM Bench" for a NInfer test', () => {
  it('the artifact’s own prediction and the most precise KV type that fits', async () => {
    const tried: string[] = [];
    const r = await ninferTestDefaults({
      params: sized,
      user: { thinking: true },
      heads: ['mtp', 'dflash2'],
      kvDtypes: ['bf16', 'int8', 'fp8', 'nvfp4'],
      fits: async (kv) => {
        tried.push(kv);
        return kv !== 'bf16';
      },
    });
    expect(tried).toEqual(['bf16', 'int8']);
    expect(r.params.ninfer).toEqual({ prefixReuse: false, thinking: true, spec: 'mtp', draftTokens: 3, kvDtype: 'int8' });
    expect(r.auto).toEqual({ source: 'fit', spec: 'mtp', draftTokens: 3, kvDtype: 'int8', fits: true });
  });

  it('nothing fits: the most compact type the build has; no head: no prediction; a failed estimate counts as no', async () => {
    const r = await ninferTestDefaults({ params: sized, user: undefined, heads: [], kvDtypes: ['bf16', 'int8'], fits: () => Promise.reject(new Error('no gpu')) });
    expect(r.params.ninfer).toMatchObject({ spec: 'off', kvDtype: 'int8' });
    expect(r.params.ninfer?.draftTokens).toBeUndefined();
    expect(r.auto).toEqual({ source: 'fit', spec: 'off', kvDtype: 'int8', fits: false });
    // The official list when the build's is not known; DFlash's own draft count.
    const d = await ninferTestDefaults({ params: P(), user: undefined, heads: ['dflash'], fits: async () => true });
    expect(d.params.ninfer).toEqual({ spec: 'dflash', draftTokens: 7, kvDtype: 'bf16' });
    const none = await ninferTestDefaults({ params: P(), user: undefined, heads: [], kvDtypes: ['k8v4'], fits: async () => false });
    expect(none.params.ninfer?.kvDtype).toBe('bf16');
  });

  it('what the user set stays; with everything set, nothing is chosen', async () => {
    const r = await ninferTestDefaults({ params: P({ ninfer: { spec: 'off', kvDtype: 'fp8' } }), user: { spec: 'off', kvDtype: 'fp8' }, heads: ['mtp'], fits: async () => true });
    expect(r.auto).toBeUndefined();
    expect(r.params).toEqual(P({ ninfer: { spec: 'off', kvDtype: 'fp8' } }));
    const draft = await ninferTestDefaults({ params: P({ ninfer: { draftTokens: 2 } }), user: { draftTokens: 2, kvDtype: 'int8' }, heads: ['mtp'], fits: async () => true });
    expect(draft.params.ninfer).toEqual({ draftTokens: 2, spec: 'mtp' });
    expect(draft.auto).toEqual({ source: 'fit', spec: 'mtp' });
  });

  it('the latest tune here decides when there is one', async () => {
    const r = await ninferTestDefaults({
      params: sized,
      user: { thinking: true },
      heads: ['mtp'],
      fits: async () => true,
      tuned: { ninfer: { spec: 'mtp', draftTokens: 4, lmHeadDraft: true, kvDtype: 'nvfp4' }, createdAt: '2026-10-01T10:00:00.000Z' },
    });
    expect(r.params.ninfer).toMatchObject({ spec: 'mtp', draftTokens: 4, lmHeadDraft: true, kvDtype: 'nvfp4' });
    expect(r.auto).toEqual({ source: 'tuned', createdAt: '2026-10-01T10:00:00.000Z', spec: 'mtp', draftTokens: 4, kvDtype: 'nvfp4' });
    const off = await ninferTestDefaults({ params: P(), user: undefined, heads: ['mtp'], fits: async () => true, tuned: { ninfer: undefined, createdAt: 'x' } });
    expect(off.params.ninfer).toMatchObject({ spec: 'off', kvDtype: 'bf16' });
  });
});
