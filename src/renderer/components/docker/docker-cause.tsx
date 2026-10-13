import { ExternalLink, Lightbulb, SearchCheck } from 'lucide-react';
import { useId } from 'react';
import { toast } from 'sonner';
import type { DockerDiagnosis } from '../../../contract/docker';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/cn';
import { useDockerActions, useDockerDiagnosis } from '../../lib/queries-docker';
import { errorData } from '../../lib/queries-library';
import { Button } from '../ui/button';

/** Minutes of Resource Saver's idle time, as people say it ("5"). */
const minutesOf = (d: DockerDiagnosis) => Math.max(1, Math.round((d.resourceSaver?.timeoutSeconds ?? 300) / 60));

/**
 * Why Docker got stuck (from Docker Desktop's own log) and how to avoid it next time: Resource
 * Saver turned off in Docker Desktop's settings. LLM Bench never changes them: it says where they
 * are and opens Docker Desktop.
 */
export function DockerCause({ className, windows }: { className?: string; windows: boolean }) {
  const { t, dateTime } = useI18n();
  const id = useId();
  const diagnosis = useDockerDiagnosis(windows);
  const actions = useDockerActions();
  const d = diagnosis.data;
  if (!d) return null;
  const known = d.cause === 'resource-saver' || d.cause === 'stuck-stopping';
  const when = d.since ? dateTime(d.since) : '';
  const prevent = d.resourceSaver?.enabled === true;
  if (!known && d.cause !== 'not-answering' && !prevent) return null;
  const open = () =>
    actions.open.mutate(undefined, {
      onSuccess: () => toast.success(t('dockerFix.prevent.opened')),
      onError: (e) => toast.error(t(`errors.${errorData(e).code}.title`)),
    });
  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {(known || d.cause === 'not-answering') && (
        <section aria-labelledby={`${id}-cause`} className="flex items-start gap-3 rounded-lg border border-border bg-surface px-4 py-3 text-sm">
          <SearchCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-accent-text" />
          <div className="flex min-w-0 flex-col gap-1">
            <h3 id={`${id}-cause`} className="font-semibold text-fg">
              {t('dockerFix.cause.title')}
            </h3>
            <p className="text-fg-2">{t(`dockerFix.cause.${d.cause as 'resource-saver'}`, { minutes: minutesOf(d), when })}</p>
            {d.evidence.length > 0 && (
              <details className="text-xs text-fg-3">
                <summary className="cursor-pointer rounded-xs select-none hover:text-fg focus-ring">{t('dockerFix.cause.evidence')}</summary>
                <ul className="mt-1 flex flex-col gap-0.5 font-mono break-all">
                  {d.evidence.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        </section>
      )}
      {prevent && (
        <section aria-labelledby={`${id}-prevent`} className="flex items-start gap-3 rounded-lg border border-info/25 bg-info-soft px-4 py-3 text-sm">
          <Lightbulb aria-hidden className="mt-0.5 size-4 shrink-0 text-info-text" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <h3 id={`${id}-prevent`} className="font-semibold text-fg">
              {t('dockerFix.prevent.title')}
            </h3>
            <p className="text-fg-2">{t('dockerFix.prevent.resourceSaver', { minutes: minutesOf(d) })}</p>
            <Button size="sm" className="self-start" onClick={open} disabled={actions.open.isPending}>
              <ExternalLink aria-hidden />
              {t('dockerFix.prevent.open')}
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}
