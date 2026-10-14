/**
 * What a NInfer launch can ask of this model and this build: the KV types the build's --help lists, the
 * speculative heads packed in the artifact (its manifest's components: "mtp", "dflash", "dflash2"), its
 * vision part, and the optimized proposal head --lm-head-draft needs (GGUF-NInfer artifacts have none:
 * the adapter leaves the flag out, core/engines/ninfer/adapter.ts). The expert fields offer only these,
 * and the built-in presets are trimmed to them, so a preset never shows a setting that would not run.
 */
import { NINFER_KV_DTYPES, type NinferParams, type NinferSpec } from '../../../contract/engines';
import { NINFER_ALL_LAYOUTS, type NinferPreset } from '../../../contract/ninfer';

export type NinferHead = Exclude<NinferSpec, 'off'>;
const HEADS: readonly NinferHead[] = ['mtp', 'dflash', 'dflash2'];

export interface NinferSupport {
  /** --kv-dtype values the build takes (the official ones while its --help is not known). */
  kvDtypes: readonly string[];
  /** Speculative heads in the artifact (all of them while its manifest is not known). */
  specs: readonly NinferHead[];
  /** The artifact packs its vision part (true while not known). */
  vision: boolean;
  /** The artifact stores the optimized proposal head (--lm-head-draft). */
  lmHead: boolean;
}

/** What the support module needs of a library model. */
export interface NinferSupportModel {
  displayName?: string | undefined;
  repo?: string | undefined;
  file?: string | undefined;
  facts?: { name?: string | undefined; components?: readonly string[] | undefined; layouts?: readonly string[] | undefined; noManifest?: boolean | undefined } | undefined;
}

export function ninferSupportOf(model: NinferSupportModel | undefined, kvDtypes: readonly string[] | undefined): NinferSupport {
  const facts = model?.facts;
  // A manifest lists every part; a name alone ("senza manifest") never says vision, so it is not ruled out.
  const parts = facts?.components !== undefined && facts.components.length > 0 ? facts.components : undefined;
  const text = [model?.repo, model?.file, model?.displayName, facts?.name].filter(Boolean).join('\n').toLowerCase();
  const ggufNinfer = (facts?.layouts ?? []).some((l) => NINFER_ALL_LAYOUTS.includes(l)) || text.includes('gguf-ninfer');
  return {
    kvDtypes: kvDtypes && kvDtypes.length > 0 ? kvDtypes : NINFER_KV_DTYPES,
    specs: parts ? HEADS.filter((h) => parts.includes(h)) : HEADS,
    vision: parts === undefined || facts?.noManifest === true || parts.includes('vision'),
    lmHead: !ggufNinfer,
  };
}

/** NInfer settings without what this model and build cannot take (a head it lacks, vision, the proposal head). */
export function ninferWithin(n: NinferParams, s: NinferSupport): NinferParams {
  const out: NinferParams = { ...n };
  if (out.spec !== undefined && out.spec !== 'off' && !s.specs.includes(out.spec)) {
    delete out.spec;
    delete out.draftTokens;
    delete out.lmHeadDraft;
  }
  if (out.lmHeadDraft === true && !s.lmHead) delete out.lmHeadDraft;
  if (out.vision === true && !s.vision) delete out.vision;
  return out;
}

/** The built-in presets as this model and build run them (a KV type the build lacks drops the preset: contract/ninfer.ts). */
export function presetsWithin(presets: readonly NinferPreset[], s: NinferSupport): NinferPreset[] {
  return presets.map((p) => ({ ...p, params: { ...p.params, ninfer: ninferWithin(p.params.ninfer, s) } }));
}
