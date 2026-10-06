import { errorText, useI18n } from '../../i18n';
import { errorData } from '../../lib/queries-library';
import { Callout } from '../ui/callout';

export interface ErrorCalloutProps {
  error: unknown;
  /** The "what to do" button; defaults to nothing (the text already says what to do). */
  action?: { label: string; onClick: () => void };
  className?: string;
}

/** Any failure from the core, in plain words from the error catalog, with its technical text folded away. */
export function ErrorCallout({ error, action, className }: ErrorCalloutProps) {
  const i18n = useI18n();
  const data = errorData(error);
  const { title, what } = errorText(i18n, data.code, data.params);
  return (
    <Callout tone="danger" title={title} {...(action ? { action } : {})} {...(className ? { className } : {})}>
      <p>{what}</p>
      <details className="mt-1 text-xs text-fg-3">
        <summary className="cursor-pointer select-none focus-ring rounded-xs">{i18n.t('setup.technicalDetails')}</summary>
        <p className="mt-1 font-mono break-all">{data.message}</p>
      </details>
    </Callout>
  );
}
