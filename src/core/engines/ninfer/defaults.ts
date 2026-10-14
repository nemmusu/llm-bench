/**
 * "Scelte da LLM Bench" for a NInfer test: what LLM Bench sets for the NInfer settings the user left
 * unset, the same way as the other engines' defaults (a representative launch of this engine on this
 * card, not the bare program's):
 *
 *  - the recommended combination of the latest "Trova le impostazioni migliori" of this model here
 *    (tune-setup.ts tunedServerParams): its KV type and token prediction;
 *  - otherwise token prediction with the head the artifact carries (the family's own first: MTP 3 for
 *    the 27B models, DFlash 7 for 35B-A3B; NInfer's README advice), never --lm-head-draft (NInfer uses
 *    the optimized head by itself when the artifact stores one, and GGUF-NInfer artifacts have none),
 *    and the most precise KV type whose pool holds the test on this card (bf16, int8, nvfp4: those the
 *    build lists; none fits: the most compact one).
 *
 * Context, users and the pool stay what the test needs (scenarios.ts autoLaunchParams); what the user
 * set always wins. RunPlan.ninferAuto says what was chosen, for the "Impostazioni di NInfer" card.
 */
import type { LaunchParams, NinferParams, NinferSpec } from '../../../contract/engines';
import { NINFER_DEFAULT_DRAFT_TOKENS } from '../../../contract/ninfer';
import type { NinferAuto } from '../../../contract/api';

type Head = Exclude<NinferSpec, 'off'>;

/** The KV types tried, most precise first. */
export const NINFER_AUTO_KV_LADDER = ['bf16', 'int8', 'nvfp4'] as const;

export interface NinferTestDefaultsInput {
  /** The launch params after the test's sizes (context, users, pool). */
  params: LaunchParams;
  /** What the request itself set (these are never replaced). */
  user: NinferParams | undefined;
  /** The heads the artifact carries, the family's own first (tune-ninfer.ts ninferBackends). */
  heads: readonly Head[];
  /** The --kv-dtype values the build lists (undefined: the official ones). */
  kvDtypes?: readonly string[] | undefined;
  /** The launch with this KV type fits the card (the VRAM estimate). */
  fits: (kvDtype: string) => Promise<boolean>;
  /** The latest tune's recommended settings here, when there is one. */
  tuned?: { ninfer: NinferParams | undefined; createdAt: string } | undefined;
}

export async function ninferTestDefaults(i: NinferTestDefaultsInput): Promise<{ params: LaunchParams; auto: NinferAuto | undefined }> {
  const user = i.user ?? {};
  const own: NinferParams = { ...i.params.ninfer };
  const auto: NinferAuto = { source: i.tuned ? 'tuned' : 'fit', ...(i.tuned ? { createdAt: i.tuned.createdAt } : {}) };
  const tuned = i.tuned?.ninfer;
  if (user.spec === undefined) {
    const spec = i.tuned ? (tuned?.spec ?? 'off') : (i.heads[0] ?? 'off');
    own.spec = spec;
    auto.spec = spec;
    if (spec !== 'off' && user.draftTokens === undefined) {
      own.draftTokens = tuned?.draftTokens ?? NINFER_DEFAULT_DRAFT_TOKENS[spec];
      auto.draftTokens = own.draftTokens;
      if (tuned?.lmHeadDraft !== undefined && user.lmHeadDraft === undefined) own.lmHeadDraft = tuned.lmHeadDraft;
    }
  }
  if (user.kvDtype === undefined) {
    if (tuned?.kvDtype !== undefined) own.kvDtype = tuned.kvDtype;
    else {
      const ladder = NINFER_AUTO_KV_LADDER.filter((kv) => !i.kvDtypes || i.kvDtypes.includes(kv));
      let chosen: string | undefined;
      for (const kv of ladder) {
        if (await i.fits(kv).catch(() => false)) {
          chosen = kv;
          break;
        }
      }
      own.kvDtype = chosen ?? ladder.at(-1) ?? 'bf16';
      auto.fits = chosen !== undefined;
    }
    auto.kvDtype = own.kvDtype;
  }
  const changed = auto.spec !== undefined || auto.kvDtype !== undefined;
  return { params: changed ? { ...i.params, ninfer: own } : i.params, auto: changed ? auto : undefined };
}
