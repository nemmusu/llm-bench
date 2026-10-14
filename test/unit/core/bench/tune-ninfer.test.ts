import { afterAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchParamsSchema } from '../../../../src/contract/engines';
import { NINFER_EXPECT, NINFER_KV_LADDER, ninferBackends, ninferSpace, ninferTuneInput } from '../../../../src/core/bench/tune-ninfer';
import type { TunerInput } from '../../../../src/core/bench/tuner';
import { tempDir } from '../docker/helpers';
import { buildNinfer } from '../../../fakes/fake-hub/model-files.mjs';
import { ninferModel } from '../engines/ninfer/helpers';

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups) c();
});

const P = (over: object = {}) => launchParamsSchema.parse(over);

describe('NInfer search space', () => {
  it('tries the speculative backends the artifact carries, the family\'s own first', () => {
    expect(ninferBackends({ name: 'qwen3.8-27b', components: ['text', 'vision', 'mtp', 'dflash2'] })).toEqual(['mtp', 'dflash2']);
    expect(ninferBackends({ name: 'qwen3.6-35b-a3b', components: ['text', 'mtp', 'dflash'] })).toEqual(['dflash', 'mtp']);
    expect(ninferBackends(undefined)).toEqual([]);
  });

  it('a quick search: KV precision, then speculation, draft tokens and int8 vs fp8', () => {
    const space = ninferSpace({ budget: 'fast', params: P({ ninfer: { prefixReuse: false, thinking: false, draftTokens: 9, lmHeadDraft: false } }), backends: ['mtp', 'dflash2'] });
    expect(space.kvLadder).toEqual(NINFER_KV_LADDER.fast);
    expect(space.base('int8')).toEqual({ kv: 'int8', spec: 'mtp', draft: 3, lmhead: true, kv8: 'int8', vision: false });
    expect(space.base('bf16')).toEqual({ kv: 'bf16', spec: 'mtp', draft: 3, lmhead: true, vision: false });
    expect(space.dimensions.map((d) => d.key)).toEqual(['spec', 'draft', 'kv8']);
    const [spec, draft, kv8] = space.dimensions;
    expect(spec?.values({})).toEqual(['mtp', 'dflash2', 'off']);
    expect(draft?.values({ spec: 'dflash2' })).toEqual([7, 5, 9]);
    expect(draft?.values({ spec: 'off' })).toEqual([]);
    expect(kv8?.values({ kv: 'int8' })).toEqual(['int8', 'fp8']);
    expect(kv8?.values({ kv: 'nvfp4' })).toEqual([]);
    expect(space.contextFor(1, 65_536)).toBe(65_536);
    // The context is the pool; the user's benchmark settings stay; the draft settings are the search's.
    expect(space.params({ kv: 'int8', kv8: 'fp8', spec: 'mtp', draft: 4, lmhead: true, vision: false }, 131_072)).toMatchObject({
      contextSize: 131_072,
      parallel: 1,
      ninfer: { prefixReuse: false, thinking: false, kvCapacity: 131_072, kvDtype: 'fp8', spec: 'mtp', draftTokens: 4, lmHeadDraft: true, vision: false },
    });
    const off = space.params({ kv: 'nvfp4', spec: 'off', vision: false }, 8192);
    expect(off.ninfer).toEqual({ prefixReuse: false, thinking: false, kvCapacity: 8192, kvDtype: 'nvfp4', spec: 'off', vision: false });
    expect(space.tags({})).toEqual([]);
  });

  it('a thorough search for several users: the optimized head and vision too, at most 8 users sharing the pool', () => {
    const space = ninferSpace({ budget: 'thorough', params: P({ ninfer: { vision: true } }), backends: ['dflash'], users: 12 });
    expect(space.kvLadder).toEqual(['bf16', 'int8', 'k8v4', 'nvfp4']);
    expect(space.base('k8v4')).toEqual({ kv: 'k8v4', spec: 'dflash', draft: 7, lmhead: true, vision: true, np: 8 });
    expect(space.dimensions.map((d) => d.key)).toEqual(['spec', 'draft', 'lmhead', 'kv8', 'vision']);
    const lmhead = space.dimensions[2];
    expect(lmhead?.values({ spec: 'dflash' })).toEqual([true, false]);
    expect(lmhead?.values({ spec: 'off' })).toEqual([]);
    expect(space.dimensions[4]?.values({})).toEqual([true, false]);
    expect(space.contextFor(8, 32_768)).toBe(262_144);
    expect(space.params({ kv: 'k8v4', spec: 'dflash', draft: 5, lmhead: false, vision: true, np: 8 }, 262_144)).toMatchObject({ contextSize: 32_768, parallel: 8, ninfer: { kvCapacity: 262_144, kvDtype: 'k8v4', draftTokens: 5, lmHeadDraft: false, vision: true } });
    // One user, no backend: no speculation at all.
    const plain = ninferSpace({ budget: 'recheck', params: P(), backends: [], users: 1 });
    expect(plain.base('bf16')).toEqual({ kv: 'bf16', spec: 'off', vision: false });
    expect(plain.dimensions.map((d) => d.key)).toEqual(['kv8']);
  });
});

describe('NInfer tuner input', () => {
  it('a GGUF-NInfer artifact has no proposal head: never --lm-head-draft, not even in a thorough search', async () => {
    const space = ninferSpace({ budget: 'thorough', params: P(), backends: ['mtp'], proposalHead: false });
    expect(space.base('int8')).toMatchObject({ spec: 'mtp', draft: 3, lmhead: false });
    expect(space.dimensions.map((d) => d.key)).not.toContain('lmhead');
    expect(space.params(space.base('int8'), 65_536)).toMatchObject({ ninfer: { spec: 'mtp', draftTokens: 3, lmHeadDraft: false } });
    // Read from the file itself.
    const t = tempDir('gb-tune-gguf-');
    cleanups.push(t.cleanup);
    const model = ninferModel(path.join(t.dir, 'g'), { manifest: false });
    writeFileSync(model.local.paths[0] as string, buildNinfer({ name: 'qwen3.8-27b-coder390-q6k-mtp', components: ['text', 'mtp', 'vision'], layouts: ['gguf_blocks_v1', 'contiguous_le_v1'] }));
    const common = { predict: () => undefined, budget: 'thorough' } as unknown as Omit<TunerInput, 'space'>;
    const input = await ninferTuneInput(common, { budget: 'thorough', params: P(), model });
    expect(input.space.base('bf16')).toMatchObject({ spec: 'mtp', lmhead: false });
  });

  it('uses the artifact for its space and its VRAM estimate, and NInfer\'s usual speeds until measured', async () => {
    const t = tempDir('gb-tune-ninfer-');
    cleanups.push(t.cleanup);
    const model = ninferModel(path.join(t.dir, 'm'), { bytes: 23_719_715_844 % 1_000_000 });
    const common = { predict: () => undefined, budget: 'fast' } as unknown as Omit<TunerInput, 'space'>;
    const input = await ninferTuneInput(common, { budget: 'fast', params: P(), model, gpu: { totalMiB: 32_607, freeMiB: 30_000 }, users: 2 });
    expect(input.space.base('bf16')).toMatchObject({ spec: 'mtp', np: 2 });
    expect(input.expect).toBe(NINFER_EXPECT);
    expect(input.predict?.(P({ contextSize: 8192 }))).toMatchObject({ level: 'perfect', basis: 'file-size' });
    // No GPU facts: no estimate; what the search expects here wins (buildTuneSetup); an artifact that cannot be read: no speculation.
    const seen = { anchors: [{ depth: 1024, prefillTps: 5000, decodeTps: 90 }], loadMs: 9000 };
    const bare = await ninferTuneInput({ ...common, expect: seen }, { budget: 'fast', params: P(), model: { identity: model.identity } });
    expect(bare.predict).toBeUndefined();
    expect(bare.expect).toBe(seen);
    expect(bare.space.base('bf16')).toMatchObject({ spec: 'off' });
  });
});
