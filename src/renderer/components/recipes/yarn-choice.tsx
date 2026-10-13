/**
 * "Contesto oltre il limite del modello (YaRN)": 300K, 500K or another context, the factor it means
 * for this model (target ÷ trained context) and, while one is chosen, the plain warning that quality
 * there is not guaranteed (only speed and memory are measured).
 */
import { YARN_TARGETS, yarnScaling } from '../../../contract/recipes';
import { useI18n } from '../../i18n';
import { depthLabel } from '../tune/tune-format';
import { Callout } from '../ui/callout';
import { HelpTip } from '../ui/help-tip';
import { Field, Input } from '../ui/input';
import { SegmentedControl } from '../ui/segmented-control';

const OFF = 'off';
const CUSTOM = 'custom';
/** What "Altro" starts from: 1M tokens. */
const CUSTOM_DEFAULT = 1_048_576;

export interface YarnChoiceProps {
  /** The context to reach, tokens as typed ('' = none). */
  value: string;
  onChange: (value: string) => void;
  /** The context the model was trained with (undefined: unknown). */
  trained: number | undefined;
  /** "No" is a choice (expert mode); the recipe editor shows this only once YaRN is chosen. */
  allowOff?: boolean;
  invalid?: boolean;
  /** Visible title (the expert panel); the recipe editor has its own. */
  title?: boolean;
}

/** Which segment a value is: off, one of the offered targets, or another one. */
export function yarnSegment(value: string): string {
  if (!value.trim()) return OFF;
  return (YARN_TARGETS as readonly number[]).includes(Number(value)) ? value.trim() : CUSTOM;
}

export function YarnChoice({ value, onChange, trained, allowOff = false, invalid, title = false }: YarnChoiceProps) {
  const f = useI18n();
  const { t, integer, number } = f;
  const segment = yarnSegment(value);
  const target = Number(value);
  const rope = Number.isInteger(target) && target > 0 ? yarnScaling(target, trained) : undefined;
  const unknown = trained === undefined;
  return (
    <div className="flex flex-col gap-2">
      {title && (
        <span className="inline-flex items-center gap-1 text-sm font-medium text-fg">
          {t('context.yarn.title')}
          <HelpTip term={t('context.yarn.title')}>{t('context.yarn.help')}</HelpTip>
        </span>
      )}
      <SegmentedControl
        size="sm"
        label={t('context.yarn.title')}
        value={segment}
        onValueChange={(v) => onChange(v === OFF ? '' : v === CUSTOM ? String(CUSTOM_DEFAULT) : v)}
        options={[
          ...(allowOff ? [{ value: OFF, label: t('context.yarn.off') }] : []),
          ...YARN_TARGETS.map((n) => ({ value: String(n), label: depthLabel(n, f), disabled: unknown || (trained as number) >= n })),
          { value: CUSTOM, label: t('context.yarn.custom'), disabled: unknown },
        ]}
      />
      {segment === CUSTOM && (
        <Field label={t('context.yarn.customLabel')} className="max-w-56">
          {({ id }) => <Input id={id} inputMode="numeric" value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={invalid || undefined} className="tabular-nums" autoComplete="off" />}
        </Field>
      )}
      {unknown ? (
        <p className="text-xs text-fg-3">{t('context.yarn.unknown')}</p>
      ) : segment === OFF ? null : rope ? (
        <>
          <p className="text-xs text-fg-2 tabular-nums">{t('context.yarn.factor', { factor: number(rope.factor, 2), trained: integer(trained) })}</p>
          <Callout tone="warning" title={t('context.yarn.warningTitle', { trained: depthLabel(trained, f) })}>
            {t('context.yarn.warningBody', { trained: integer(trained), ctx: integer(target) })}
          </Callout>
        </>
      ) : (
        <p className="text-xs text-danger-text">{t('context.yarn.within', { trained: integer(trained) })}</p>
      )}
    </div>
  );
}
