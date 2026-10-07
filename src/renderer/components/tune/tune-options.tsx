import type { ReactNode } from 'react';
import type { StartRunRequest } from '../../../contract/api';
import type { TuneBudget } from '../../../contract/results';
import { useI18n } from '../../i18n';
import { HelpTip } from '../ui/help-tip';
import { SegmentedControl } from '../ui/segmented-control';
import { Switch } from '../ui/switch';

export type TuneRequest = NonNullable<StartRunRequest['tune']>;

export const DEFAULT_TUNE: TuneRequest = { budget: 'fast', fidelity: false };

export interface TuneOptionsProps {
  value: TuneRequest;
  onChange: (v: TuneRequest) => void;
  expert: boolean;
  /** More choices shown first, in the same box (e.g. what the search is for). */
  children?: ReactNode;
}

/**
 * Options of "Trova le impostazioni migliori" on the Benchmark page: how long to search, and (experts
 * only) the fidelity check, which is an indication and not a quality test.
 */
export function TuneOptions({ value, onChange, expert, children }: TuneOptionsProps) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-2/60 p-3">
      {children}
      <div className="flex flex-col gap-1.5">
        <span className="inline-flex items-center gap-1 text-xs font-medium text-fg-2">
          {t('tune.options.budget')}
          <HelpTip term={t('tune.options.budget')}>{t('tune.options.budgetHelp')}</HelpTip>
        </span>
        <SegmentedControl<TuneBudget>
          layout="list"
          label={t('tune.options.budget')}
          value={value.budget}
          onValueChange={(budget) => onChange({ ...value, budget })}
          options={[
            { value: 'fast', label: t('tune.options.fast'), sublabel: t('tune.options.fastTime') },
            { value: 'thorough', label: t('tune.options.thorough'), sublabel: t('tune.options.thoroughTime') },
          ]}
        />
        <p className="text-xs text-fg-3">{t(value.budget === 'fast' ? 'tune.options.fastDesc' : 'tune.options.thoroughDesc')}</p>
      </div>
      {expert && (
        <div className="flex items-start gap-2.5">
          <Switch id="tune-fidelity" checked={value.fidelity} onCheckedChange={(fidelity) => onChange({ ...value, fidelity })} aria-describedby="tune-fidelity-hint" className="mt-0.5" />
          <div className="flex flex-col">
            <label htmlFor="tune-fidelity" className="cursor-pointer text-sm font-medium text-fg">
              {t('tune.options.fidelity')}
            </label>
            <span id="tune-fidelity-hint" className="text-xs text-fg-3">
              {t('tune.options.fidelityHint')}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
