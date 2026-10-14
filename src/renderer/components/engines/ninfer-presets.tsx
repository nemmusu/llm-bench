import { Cpu } from 'lucide-react';
import type { NinferAuto } from '../../../contract/api';
import type { NinferParams } from '../../../contract/engines';
import { ninferParamsText, type NinferPreset } from '../../../contract/ninfer';
import { useI18n, type Formatters } from '../../i18n';
import { Card } from '../ui/card';
import { SegmentedControl } from '../ui/segmented-control';
import { presetTitle, specText, type NinferChoice } from './ninfer-format';

export interface NinferPresetPickerProps {
  presets: readonly NinferPreset[];
  /** The NInfer settings of the result a preset came from, offered as their own choice. */
  run?: NinferParams | undefined;
  value: NinferChoice;
  onChange: (v: NinferChoice) => void;
  /** A test or a server: what "Scelte da LLM Bench" means differs (a test sizes everything for itself). */
  use?: 'test' | 'server';
  /** What LLM Bench chose for this test (the plan's ninferAuto), said under "Scelte da LLM Bench". */
  auto?: NinferAuto | undefined;
  /** The user's own settings ('custom'), as their flags: the choice the card shows once a field differs. */
  custom?: string | undefined;
}

/** "Scelte da LLM Bench" in words: what the plan chose (a test), else what it will choose. */
export function autoText(auto: NinferAuto | undefined, use: 'test' | 'server', f: Pick<Formatters, 't' | 'date'>): string {
  const { t } = f;
  if (use === 'server') return t('ninfer.presets.autoDescServer');
  if (!auto) return t('ninfer.presets.autoDesc');
  const kv = auto.kvDtype === undefined ? undefined : auto.fits === false ? t('ninfer.presets.autoKvTight', { kv: auto.kvDtype }) : auto.source === 'fit' ? t('ninfer.presets.autoKvFit', { kv: auto.kvDtype }) : t('ninfer.presets.autoKv', { kv: auto.kvDtype });
  const spec = auto.spec === undefined ? undefined : auto.spec === 'off' ? t('ninfer.presets.autoNoSpec') : specText({ spec: auto.spec, draftTokens: auto.draftTokens }, t);
  const parts = [kv, spec].filter((s): s is string => s !== undefined).join(', ');
  if (!parts) return t('ninfer.presets.autoDesc');
  return auto.source === 'tuned' && auto.createdAt ? t('ninfer.presets.autoTuned', { date: f.date(auto.createdAt), parts }) : t('ninfer.presets.autoFit', { parts });
}

/** "Impostazioni di NInfer" for a .ninfer model: the built-in presets, the result's own, LLM Bench's choice, or the user's own. */
export function NinferPresetPicker({ presets, run, value, onChange, use = 'test', auto, custom }: NinferPresetPickerProps) {
  const f = useI18n();
  const { t } = f;
  const chosen = presets.find((p) => p.id === value);
  const options = [
    ...presets.map((p) => ({ value: p.id as NinferChoice, label: presetTitle(p, t) })),
    ...(run ? [{ value: 'run' as const, label: t('ninfer.presets.run', { flags: ninferParamsText(run) || '–' }) }] : []),
    { value: 'auto' as const, label: t('ninfer.presets.auto') },
    // Only while the expert fields say something no preset is.
    ...(value === 'custom' ? [{ value: 'custom' as const, label: t('ninfer.presets.custom', { flags: custom || '–' }) }] : []),
  ];
  const desc = chosen
    ? t(`ninfer.presets.desc.${chosen.id}`, { kv: chosen.params.ninfer.kvDtype as string })
    : value === 'run'
      ? t('ninfer.presets.runDesc')
      : value === 'custom'
        ? t('ninfer.presets.customDesc')
        : autoText(auto, use, f);
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
      <p className="text-sm text-fg-3">{desc}</p>
    </Card>
  );
}
