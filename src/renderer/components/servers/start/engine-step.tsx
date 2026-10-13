/** Step 2 of "Avvia un server": the engines that read the chosen model (built-in, forks, command templates). */
import type { CustomEngineInfo } from '../../../../contract/custom-engines';
import { useI18n } from '../../../i18n';
import { Select } from '../../ui/select';
import { engineNameOf } from '../engine-name';
import type { EngineChoice } from '../server-flow';

export interface EngineStepProps {
  choices: readonly EngineChoice[];
  value: EngineChoice | undefined;
  onChange: (key: string) => void;
  customs: readonly CustomEngineInfo[];
}

export function EngineStep({ choices, value, onChange, customs }: EngineStepProps) {
  const f = useI18n();
  const { t } = f;
  // A custom engine says what it is built on ("Fork di llama.cpp"), as in the Benchmark's engine choice.
  const describe = (c: EngineChoice) => (c.base ? t(`engines.custom.bases.${c.base}`) : t(`benchmark.engineDesc.${c.kind}`));
  return (
    <div className="flex flex-col gap-2">
      <Select<string>
        aria-label={t('servers.flow.engine.label')}
        value={value?.key ?? ''}
        onValueChange={onChange}
        className="h-11 text-md font-semibold"
        options={choices.map((c) => ({ value: c.key, label: engineNameOf(c.config, customs, f), description: describe(c), disabled: c.disabled }))}
      />
      {value && <p className="text-sm text-fg-2">{describe(value)}</p>}
      {/* Only forks lack standard flags: a built-in engine has every one. */}
      {value && value.missing.length > 0 && (
        <p className="text-sm text-warning-text">{t('servers.flow.engine.missing', { engine: value.customName!, flags: value.missing.map((m) => m.flag).join(', ') })}</p>
      )}
    </div>
  );
}
