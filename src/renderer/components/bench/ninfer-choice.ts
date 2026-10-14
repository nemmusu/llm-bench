/**
 * "Impostazioni di NInfer" and the expert fields as one thing: the preset chosen is the starting point,
 * what the user typed in the fields goes over it, and the card says which preset that still is, or
 * "Personalizzate" once a field says otherwise. Picking a preset empties the NInfer fields again, so
 * they show the preset's values (as their "Vuoto: …").
 */
import type { LaunchParams, NinferParams } from '../../../contract/engines';
import type { NinferPreset } from '../../../contract/ninfer';
import type { NinferChoice } from '../engines/ninfer-format';
import { EMPTY_PARAMS_FORM, NINFER_PRESET_FIELDS, type ParamsForm } from './expert-form';
import type { ModelAbilities } from './model-switches';

export type NinferPick = NinferChoice;

/** What a pick sets: context, users and NInfer's own settings ('run': NInfer's settings only). */
export type NinferOverlay = Pick<LaunchParams, 'contextSize' | 'parallel'> & { ninfer: NinferParams };

/** The launch params: the pick's settings, then what the form says over them. */
export function overNinfer(overlay: NinferOverlay | undefined, form: LaunchParams | undefined): LaunchParams | undefined {
  if (!overlay) return form;
  const base: LaunchParams = form ?? { extraArgs: [], env: {} };
  return {
    ...base,
    ...(base.contextSize === undefined && overlay.contextSize !== undefined ? { contextSize: overlay.contextSize } : {}),
    ...(base.parallel === undefined && overlay.parallel !== undefined ? { parallel: overlay.parallel } : {}),
    ninfer: { ...overlay.ninfer, ...base.ninfer },
  };
}

/** True when the form itself says something NInfer reads (context, users or one of its settings). */
export function formSaysNinfer(p: LaunchParams | undefined): boolean {
  return p !== undefined && (p.contextSize !== undefined || p.parallel !== undefined || Object.values(p.ninfer ?? {}).some((v) => v !== undefined));
}

/**
 * Settings compared as they run: thinking unset is on, vision unset is on for a model that has it
 * (model-switches.tsx), the draft count unset is NInfer's default.
 */
function normalized(p: Pick<LaunchParams, 'contextSize' | 'parallel' | 'ninfer'>, abilities: ModelAbilities): string {
  const n: NinferParams = { ...p.ninfer };
  n.thinking ??= true;
  if (abilities.vision === true) n.vision ??= true;
  else delete n.vision;
  const entries = Object.entries(n)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return JSON.stringify([p.contextSize, p.parallel, entries]);
}

/** The built-in preset these settings are, compared as they run (thinking and vision unset are on). */
export function matchingPreset(params: Pick<LaunchParams, 'contextSize' | 'parallel' | 'ninfer'>, presets: readonly NinferPreset[], abilities: ModelAbilities): NinferPreset['id'] | undefined {
  const key = normalized(params, abilities);
  return presets.find((p) => normalized(p.params, abilities) === key)?.id;
}

/** Which pick the settings are: the chosen one while the form says nothing of NInfer's, else the preset they equal, the result's own, or 'custom'. */
export function ninferPickOf(o: {
  chosen: NinferPick;
  form: LaunchParams | undefined;
  overlay: NinferOverlay | undefined;
  presets: readonly NinferPreset[];
  run: NinferParams | undefined;
  abilities: ModelAbilities;
}): NinferPick {
  if (!formSaysNinfer(o.form)) return o.chosen;
  const merged = overNinfer(o.overlay, o.form) as LaunchParams;
  const preset = matchingPreset(merged, o.presets, o.abilities);
  if (preset) return preset;
  if (o.run && normalized({ contextSize: merged.contextSize, parallel: merged.parallel, ninfer: o.run }, o.abilities) === normalized(merged, o.abilities)) return 'run';
  return 'custom';
}

/** The form with every NInfer field empty again (a pick replaces them all). */
export function clearNinferFields(form: ParamsForm): ParamsForm {
  const out = { ...form };
  for (const k of NINFER_PRESET_FIELDS) (out as Record<string, unknown>)[k] = EMPTY_PARAMS_FORM[k];
  return out;
}
