/**
 * What "Trova le impostazioni migliori" searches with NInfer (tune-space.ts has the other engines):
 *
 *  - KV precision (capacity ladder): bf16 → int8 → nvfp4 ("Accurata" also k8v4, between them); at the
 *    int8 rung int8 vs fp8 (the same memory, other kernels: a descent dimension 'kv8'). A variant whose
 *    --help lists rk8v4 (NInfer-all: K 8-bit, V 4-bit, rotated) gets it after int8; types its build
 *    does not list are left out;
 *  - speculative decoding: the backends the artifact carries (manifest: MTP for the 27B models, DFlash
 *    for 35B-A3B, DFlash2 for Qwen3.8-27B) and off; draft tokens around NInfer's own recommendation
 *    (MTP 3: 2, 3, 4; DFlash / DFlash2 7: 5, 7, 9); "Accurata" also the optimized proposal head on/off;
 *  - "Accurata": vision on/off (its weights and workspace take memory);
 *  - goal 'multi': --max-concurrency N (at most 8) with each user's --max-context, the shared pool
 *    (--kv-capacity) N × that.
 *
 * The context is --max-context = --kv-capacity (one user) — the pool is sized explicitly, so a launch
 * that does not fit fails at once ("runtime reservation requires … bytes"), and that message says how
 * many tokens would have fit (the next candidate). The user's other NInfer settings (no prefix reuse
 * and no thinking for benchmarks, context-cache sizes) are kept.
 */
import type { LaunchParams, NinferKvDtype, NinferSpec } from '../../contract/engines';
import type { NinferManifest } from '../../contract/formats';
import { NINFER_MAX_CONCURRENCY, ninferFamilyOf, ninferFit } from '../../contract/ninfer';
import type { TuneBudget, TuneKvType } from '../../contract/results';
import { ninferArtifactInfo } from '../engines/ninfer/adapter';
import type { ModelTarget } from '../engines/types';
import { keptParams } from './tune-space';
import type { Dimension, TuneExpect, TunerInput, TuneSpace } from './tuner';

type Backend = Exclude<NinferSpec, 'off'>;

/** Capacity rungs per budget, most precise first. */
export const NINFER_KV_LADDER: Record<TuneBudget, readonly TuneKvType[]> = {
  fast: ['bf16', 'int8', 'nvfp4'],
  thorough: ['bf16', 'int8', 'k8v4', 'nvfp4'],
  recheck: ['bf16', 'int8', 'k8v4', 'nvfp4'],
};

/** Draft tokens tried per backend, NInfer's recommendation first. */
export const NINFER_DRAFTS: Record<Backend, readonly number[]> = { mtp: [3, 2, 4], dflash: [7, 5, 9], dflash2: [7, 5, 9] };

/** What NInfer usually does on an RTX 5090 before anything is measured here (README tables, startup logs). */
export const NINFER_EXPECT: TuneExpect = { anchors: [{ depth: 1024, prefillTps: 8000, decodeTps: 120 }], loadMs: 15_000 };

/** The speculative backends an artifact carries, the family's own first (35B-A3B: DFlash; 27B: MTP, then DFlash2). */
export function ninferBackends(manifest: Pick<NinferManifest, 'components' | 'name'> | undefined): Backend[] {
  const has = new Set(manifest?.components ?? []);
  const order: Backend[] = ninferFamilyOf(manifest?.name) === 'moe-35b-a3b' ? ['dflash', 'mtp', 'dflash2'] : ['mtp', 'dflash2', 'dflash'];
  return order.filter((b) => has.has(b));
}

/** The capacity ladder of a budget for a build that lists `kvDtypes` (undefined = the official list). */
export function ninferKvLadder(budget: TuneBudget, kvDtypes?: readonly string[]): TuneKvType[] {
  const ladder: TuneKvType[] = [...NINFER_KV_LADDER[budget]];
  if (!kvDtypes) return ladder;
  if (kvDtypes.includes('rk8v4')) ladder.splice(ladder.indexOf('int8') + 1, 0, 'rk8v4');
  return ladder.filter((kv) => kvDtypes.includes(kv));
}

export interface NinferSpaceOptions {
  budget: TuneBudget;
  /** The --kv-dtype values the build lists (EngineCaps.choices); undefined = the official ones. */
  kvDtypes?: readonly string[] | undefined;
  /** The user's launch parameters (benchmark NInfer settings included). */
  params: LaunchParams;
  /** Goal 'multi': users at once. */
  users?: number;
  /** Speculative backends the artifact carries (ninferBackends); none = never speculative. */
  backends: readonly Backend[];
}

export function ninferSpace(o: NinferSpaceOptions): TuneSpace {
  const kept = keptParams(o.params);
  const own = o.params.ninfer ?? {};
  const users = o.users !== undefined && o.users > 1 ? Math.min(o.users, NINFER_MAX_CONCURRENCY) : undefined;
  const thorough = o.budget === 'thorough';
  const first = o.backends[0];
  const vision = own.vision === true;
  const dims: Dimension[] = [];
  if (first) {
    dims.push({ key: 'spec', values: () => [...o.backends, 'off'] });
    dims.push({ key: 'draft', values: (v) => (v.spec === 'off' ? [] : NINFER_DRAFTS[v.spec as Backend]) });
    if (thorough) dims.push({ key: 'lmhead', values: (v) => (v.spec === 'off' ? [] : [true, false]) });
  }
  dims.push({ key: 'kv8', values: (v) => (v.kv === 'int8' ? ['int8', 'fp8'] : []) });
  if (thorough) dims.push({ key: 'vision', values: () => [vision, !vision] });
  return {
    kvLadder: ninferKvLadder(o.budget, o.kvDtypes),
    base: (kv) => ({
      kv,
      spec: first ?? 'off',
      ...(first ? { draft: NINFER_DRAFTS[first][0] as number, lmhead: true } : {}),
      ...(kv === 'int8' ? { kv8: 'int8' } : {}),
      vision,
      ...(users ? { np: users } : {}),
    }),
    dimensions: dims,
    // N users of C tokens each: the pool holds all of them (each request may use C).
    contextFor: (n, perUser) => n * perUser,
    params: (v, ctx) => {
      const lanes = typeof v.np === 'number' ? v.np : 1;
      const spec = v.spec as NinferSpec;
      const kvDtype = (v.kv === 'int8' && typeof v.kv8 === 'string' ? v.kv8 : v.kv) as NinferKvDtype;
      const { draftTokens: _draft, lmHeadDraft: _head, ...rest } = own;
      return {
        ...kept,
        contextSize: Math.floor(ctx / lanes),
        parallel: lanes,
        ninfer: {
          ...rest,
          kvCapacity: ctx,
          kvDtype,
          spec,
          ...(spec !== 'off' ? { draftTokens: v.draft as number, lmHeadDraft: v.lmhead === true } : {}),
          vision: v.vision === true,
        },
      };
    },
    tags: () => [],
  };
}

/**
 * The tuner's input for NInfer: its own search space, its own VRAM estimate (contract/ninfer.ts
 * ninferFit: the artifact, the KV pool by precision, the runtime) on the memory free before the
 * search, and its usual speeds until this model was measured here.
 */
export async function ninferTuneInput(
  common: Omit<TunerInput, 'space'>,
  o: {
    budget: TuneBudget;
    params: LaunchParams;
    model: ModelTarget;
    gpu?: { totalMiB: number; freeMiB: number } | undefined;
    seen?: TuneExpect | undefined;
    users?: number;
    /** The build's --kv-dtype values (a variant's own among them). */
    kvDtypes?: readonly string[] | undefined;
  },
): Promise<TunerInput> {
  const info = await ninferArtifactInfo(o.model).catch(() => undefined);
  const { predict: _generic, ...rest } = common;
  const space = ninferSpace({ budget: o.budget, params: o.params, backends: ninferBackends(info?.manifest), kvDtypes: o.kvDtypes, ...(o.users !== undefined ? { users: o.users } : {}) });
  const gpu = o.gpu;
  return {
    ...rest,
    space,
    expect: o.seen ?? NINFER_EXPECT,
    ...(gpu && info ? { predict: (params: LaunchParams) => ninferFit({ artifactBytes: info.bytes, manifest: info.manifest, label: info.label, params, gpu }) } : {}),
  };
}
