import { Cpu } from 'lucide-react';
import type { NinferParams } from '../../../contract/engines';
import { ninferParamsText, type NinferPreset } from '../../../contract/ninfer';
import { useI18n } from '../../i18n';
import { Card } from '../ui/card';
import { SegmentedControl } from '../ui/segmented-control';
import { presetTitle, type NinferChoice } from './ninfer-format';

export interface NinferPresetPickerProps {
  presets: readonly NinferPreset[];
  /** The NInfer settings of the result a preset came from, offered as their own choice. */
  run?: NinferParams | undefined;
  value: NinferChoice;
  onChange: (v: NinferChoice) => void;
}

/** "Impostazioni di NInfer" for a .ninfer model: the built-in presets, the result's own, or LLM Bench's choice. */
export function NinferPresetPicker({ presets, run, value, onChange }: NinferPresetPickerProps) {
  const { t } = useI18n();
  const chosen = presets.find((p) => p.id === value);
  const options = [
    ...presets.map((p) => ({ value: p.id as NinferChoice, label: presetTitle(p, t) })),
    ...(run ? [{ value: 'run' as const, label: t('ninfer.presets.run', { flags: ninferParamsText(run) || '–' }) }] : []),
    { value: 'auto' as const, label: t('ninfer.presets.auto') },
  ];
  return (
    <Card className="flex flex-col gap-3 p-card">
      <div className="flex items-center gap-2.5">
        <span aria-hidden className="grid size-6 place-items-center rounded-full bg-accent-soft text-accent-text [&_svg]:size-3.5">
          <Cpu />
        </span>
        <h2 className="text-md font-semibold tracking-[-0.01em]">{t('ninfer.presets.title')}</h2>
      </div>
      <p className="text-sm text-fg-2">{t('ninfer.presets.hint')}</p>
      <SegmentedControl<NinferChoice> label={t('ninfer.presets.title')} value={value} onValueChange={onChange} layout="list" options={options} />
      <p className="text-sm text-fg-3">{chosen ? t(`ninfer.presets.desc.${chosen.id}`, { kv: chosen.params.ninfer.kvDtype as string }) : value === 'run' ? t('ninfer.presets.runDesc') : t('ninfer.presets.autoDesc')}</p>
    </Card>
  );
}
