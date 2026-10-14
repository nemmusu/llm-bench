/** NInfer settings in words (presets, labels), and what a choice of them sets on a launch. */
import { launchParamsSchema, type LaunchParams, type NinferParams } from '../../../contract/engines';
import type { NinferPreset, NinferPresetId } from '../../../contract/ninfer';
import type { Formatters } from '../../i18n';

/** The user's pick: a built-in preset, the settings of the result a preset came from ('run'), LLM Bench's own choice ('auto'), or the user's own in the expert fields ('custom'). */
export type NinferChoice = NinferPresetId | 'run' | 'auto' | 'custom';

/** What a choice sets on the launch: context, users and NInfer's own settings. */
export type NinferOverlay = Pick<LaunchParams, 'contextSize' | 'parallel'> & { ninfer: NinferParams };

/** The launch params of a run or server with a choice: its settings over what the user set (expert mode). */
export function withNinferPreset(params: LaunchParams | undefined, overlay: NinferOverlay | undefined): LaunchParams | undefined {
  if (!overlay) return params;
  const base = params ?? launchParamsSchema.parse({});
  return { ...base, ...overlay, ninfer: { ...base.ninfer, ...overlay.ninfer } };
}

/** A server keeps NInfer's own defaults for what only a benchmark sets (every prompt read in full, no thinking). */
export function serverNinfer(params: LaunchParams): LaunchParams {
  if (!params.ninfer) return params;
  const { prefixReuse: _reuse, thinking: _thinking, ...ninfer } = params.ninfer;
  return { ...params, ninfer };
}

/** 65 536 → "64K", 131 072 → "128K", 240 000 → "240K" (binary K when exact, else thousands). */
export function kTokens(n: number): string {
  return n % 1024 === 0 ? `${n / 1024}K` : `${Math.round(n / 1000)}K`;
}

/** "MTP 3", "DFlash 7"; '' without speculative decoding. */
export function specText(n: Pick<NinferParams, 'spec' | 'draftTokens'>, t: Formatters['t']): string {
  const spec = n.spec ?? 'off';
  if (spec === 'off') return '';
  return t(`ninfer.spec.${spec}`, { n: n.draftTokens ?? (spec === 'mtp' ? 3 : 7) });
}

/** "Consigliata da NInfer: contesto 240K, KV fp8, 2 utenti, MTP 3". */
export function presetTitle(p: NinferPreset, t: Formatters['t']): string {
  const n = p.params.ninfer;
  const pool = kTokens(typeof n.kvCapacity === 'number' ? n.kvCapacity : (p.params.contextSize as number));
  return t(`ninfer.presets.${p.id}`, {
    ctx: kTokens(p.params.contextSize as number),
    pool,
    // "condivisa da 400K", or as much as fits ('auto': NInfer sizes it at start-up).
    shared: n.kvCapacity === 'auto' ? t('ninfer.presets.sharedAuto') : t('ninfer.presets.shared', { pool }),
    kv: n.kvDtype ?? 'bf16',
    users: p.params.parallel ?? 1,
    spec: specText(n, t),
  });
}
