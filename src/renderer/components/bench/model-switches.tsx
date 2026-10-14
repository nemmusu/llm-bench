/**
 * "Immagini" and "Ragionamento": the model's image input and its thinking, on when the model has them,
 * one switch each, the same on the Benchmark page (with or without expert mode) and in "Avvia un server".
 * They write the form's own fields: LaunchParams.vision / reasoning, or NInfer's --vision / --no-thinking
 * (ninfer.vision / ninfer.thinking). An engine whose model may not think says so under the switch.
 */
import { launchParamsSchema, type EngineBase, type LaunchParams, type NinferParams } from '../../../contract/engines';
import type { LocalModel } from '../../../contract/models';
import { useI18n } from '../../i18n';
import { HelpTip } from '../ui/help-tip';
import { Switch } from '../ui/switch';
import type { ParamsForm, Tri } from './expert-form';

/** What a model can do: true = it has it, false = it has not, undefined = not known. */
export interface ModelAbilities {
  vision: boolean | undefined;
  reasoning: boolean | undefined;
}

/**
 * From what the library knows: a NInfer artifact's manifest lists its vision part (and the Qwen3.5 family
 * always thinks); a GGUF has its image projector (mmproj) next to it; a checkpoint's config.json has a
 * vision part (facts.vision); the chat template says whether it thinks (facts.reasoning). Anything else
 * is not known.
 */
export function abilitiesOf(base: EngineBase, model: Pick<LocalModel, 'identity' | 'auxiliary'> | undefined): ModelAbilities {
  const facts = model?.identity.facts;
  if (base === 'ninfer') {
    const parts = facts?.components;
    return { vision: parts && parts.length > 0 && facts?.noManifest !== true ? parts.includes('vision') : undefined, reasoning: true };
  }
  const projector = base === 'llamacpp' && model?.auxiliary.some((a) => a.kind === 'mmproj') === true;
  return { vision: projector || facts?.vision === true ? true : undefined, reasoning: facts?.reasoning };
}

type SwitchField = 'vision' | 'reasoning';
const formField = (base: EngineBase, which: SwitchField): keyof ParamsForm & ('vision' | 'reasoning' | 'ninferVision' | 'ninferThinking') =>
  base === 'ninfer' ? (which === 'vision' ? 'ninferVision' : 'ninferThinking') : which;

/** A switch's state: what the form says, else the NInfer preset's value, else on (the model has it). */
export function switchOn(base: EngineBase, which: SwitchField, form: SwitchesForm, preset?: NinferParams | undefined): boolean {
  const v: Tri = form[formField(base, which)];
  if (v !== 'default') return v === 'on';
  const fromPreset = base === 'ninfer' ? (which === 'vision' ? preset?.vision : preset?.thinking) : undefined;
  return fromPreset ?? true;
}

/**
 * The launch params with the switches said explicitly where the engine's own default differs from "on
 * when the model has it": NInfer starts without --vision and LLM Bench's tests add --no-thinking, so its
 * two settings are always written (vision only for an artifact that has it).
 */
export function withSwitches(params: LaunchParams, base: EngineBase, form: SwitchesForm, abilities: ModelAbilities, preset?: NinferParams | undefined): LaunchParams {
  if (base !== 'ninfer') return params;
  const ninfer: NinferParams = { ...params.ninfer, thinking: switchOn(base, 'reasoning', form, preset) };
  if (abilities.vision === true) ninfer.vision = switchOn(base, 'vision', form, preset);
  else if (abilities.vision === false) delete ninfer.vision;
  return { ...params, ninfer };
}

/** The switches' part of the form. */
export type SwitchesForm = Pick<ParamsForm, 'vision' | 'reasoning' | 'ninferVision' | 'ninferThinking'>;

export const NO_SWITCHES: SwitchesForm = { vision: 'default', reasoning: 'default', ninferVision: 'default', ninferThinking: 'default' };

/**
 * A server's params with the switches over them, whatever the settings came from (a test, a preset, the
 * custom fields): NInfer's two always said (withSwitches, the source's own values as the starting point),
 * the other engines' only when switched.
 */
export function withServerSwitches(params: LaunchParams | undefined, base: EngineBase, sw: SwitchesForm, abilities: ModelAbilities): LaunchParams | undefined {
  if (base === 'external') return params;
  if (base === 'ninfer') {
    // A server thinks by default (NInfer's own): thinking is said only when switched; vision is, for a model that has it (NInfer starts without).
    const n: NinferParams = { ...params?.ninfer };
    if (sw.ninferThinking !== 'default') n.thinking = sw.ninferThinking === 'on';
    if (abilities.vision === true) n.vision = switchOn(base, 'vision', sw, params?.ninfer);
    else if (abilities.vision === false) delete n.vision;
    if (!params && Object.keys(n).length === 0) return undefined;
    return { ...(params ?? launchParamsSchema.parse({})), ninfer: n };
  }
  if (sw.vision === 'default' && sw.reasoning === 'default') return params;
  return {
    ...(params ?? launchParamsSchema.parse({})),
    ...(sw.vision !== 'default' ? { vision: sw.vision === 'on' } : {}),
    ...(sw.reasoning !== 'default' ? { reasoning: sw.reasoning === 'on' } : {}),
  };
}

export interface ModelSwitchesProps {
  base: EngineBase;
  form: SwitchesForm;
  onForm: (patch: Partial<SwitchesForm>) => void;
  abilities: ModelAbilities;
  /** NInfer: the preset chosen (its vision and thinking are the switches' starting point). */
  preset?: NinferParams | undefined;
}

/** The two switches (only the image one the model has; nothing for an external server). */
export function ModelSwitches({ base, form, onForm, abilities, preset }: ModelSwitchesProps) {
  const { t } = useI18n();
  if (base === 'external' || (abilities.vision !== true && abilities.reasoning === false)) return null;
  const one = (which: SwitchField) => {
    const id = `switch-${which}`;
    const on = switchOn(base, which, form, preset);
    return (
      <div key={which} className="flex min-w-0 items-start gap-3">
        <Switch id={id} checked={on} onCheckedChange={(v) => onForm({ [formField(base, which)]: v ? 'on' : 'off' })} aria-describedby={`${id}-hint`} className="mt-0.5" />
        <div className="flex min-w-0 flex-col">
          <span className="inline-flex items-center gap-1">
            <label htmlFor={id} className="cursor-pointer text-sm font-semibold text-fg">
              {t(`benchmark.switches.${which}.label`)}
            </label>
            <HelpTip term={t(`benchmark.switches.${which}.label`)}>{t(`benchmark.switches.${which}.help`)}</HelpTip>
          </span>
          <span id={`${id}-hint`} className="text-xs text-fg-3">
            {which === 'reasoning' && abilities.reasoning === undefined ? t('benchmark.switches.reasoning.unknown') : t(`benchmark.switches.${which}.${on ? 'on' : 'off'}`)}
          </span>
        </div>
      </div>
    );
  };
  return (
    <div className="flex flex-wrap gap-x-8 gap-y-3" role="group" aria-label={t('benchmark.switches.title')}>
      {abilities.vision === true && one('vision')}
      {abilities.reasoning !== false && one('reasoning')}
    </div>
  );
}
