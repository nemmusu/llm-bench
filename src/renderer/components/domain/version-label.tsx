import { useI18n } from '../../i18n';
import { cn } from '../../lib/cn';
import { useHealth } from '../../lib/queries';

/**
 * App version as reported by the core (/api/health), so it also proves the core answers.
 * role="note" lets the element carry its localized name ("Versione 0.1.0").
 */
export function VersionLabel({ className, prefix }: { className?: string; prefix?: string }) {
  const { t } = useI18n();
  const health = useHealth();
  if (!health.data) return null;
  return (
    <span className={cn('text-2xs text-fg-3 tabular-nums', className)}>
      {prefix && <span aria-hidden>{prefix} </span>}
      <span role="note" aria-label={t('app.version', { version: health.data.version })}>
        v{health.data.version}
      </span>
    </span>
  );
}
