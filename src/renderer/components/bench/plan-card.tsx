import { ChevronDown, Download, ListChecks, Timer } from 'lucide-react';
import { Collapsible } from 'radix-ui';
import { useState } from 'react';
import type { RunPlan } from '../../../contract/api';
import type { AppErrorData } from '../../../contract/errors';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/cn';
import { Card } from '../ui/card';
import { Callout } from '../ui/callout';
import { CodeBlock } from '../ui/code-block';
import { FitBadge } from '../ui/fit-badge';
import { HelpTip } from '../ui/help-tip';
import { Skeleton } from '../ui/skeleton';
import { ErrorCard } from './error-card';
import { MIB_PER_GB } from './format';
import { noteText } from './notes';
import type { Need } from './start-flow';
import { scenarioLines } from './summary';

export interface PlanCardProps {
  plan: RunPlan | undefined;
  loading: boolean;
  /** Plan error worth showing (ENGINE_NOT_INSTALLED is a "need", not an error). */
  error: AppErrorData | undefined;
  needs: Need[];
  /** Why the command is not known yet (engine to install, model to download). */
  commandLater?: 'engine' | 'model';
  expert: boolean;
}

/** "Anteprima": duration, VRAM fit, what gets downloaded, warnings and the exact command. */
export function PlanCard({ plan, loading, error, needs, commandLater, expert }: PlanCardProps) {
  const f = useI18n();
  const { t, bytes, duration, number } = f;
  const [open, setOpen] = useState(expert);
  const [prevExpert, setPrevExpert] = useState(expert);
  // Expert mode opens the command; switching it off folds it again.
  if (prevExpert !== expert) {
    setPrevExpert(expert);
    setOpen(expert);
  }
  const fit = plan?.fit;
  return (
    <Card className="flex flex-col" aria-busy={loading}>
      <div className="flex items-center gap-2 px-card pt-card">
        <ListChecks aria-hidden className="size-4 text-accent-text" />
        <h2 className="text-md font-semibold tracking-[-0.01em]">{t('benchmark.plan.title')}</h2>
        <HelpTip term={t('benchmark.plan.title')}>{t('benchmark.plan.help')}</HelpTip>
      </div>
      <div className="flex flex-col gap-4 px-card pt-4 pb-card">
        {loading && !plan && !error ? (
          <div role="status" className="flex flex-col gap-2" aria-label={t('common.loading')}>
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-5 w-1/2" />
          </div>
        ) : (
          <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
            {plan && (
              <div className="flex flex-col gap-1">
                <dt className="inline-flex items-center gap-1.5 text-xs text-fg-3">
                  <Timer aria-hidden className="size-3.5" />
                  {t('benchmark.plan.duration')}
                </dt>
                <dd className="font-semibold text-fg tabular-nums">≈ {duration(plan.estimatedSeconds * 1000)}</dd>
              </div>
            )}
            {fit && (
              <div className="flex flex-col gap-1">
                <dt className="text-xs text-fg-3">{t('benchmark.plan.fit')}</dt>
                <dd className="flex flex-wrap items-center gap-2">
                  <FitBadge level={fit.level} size="sm" />
                  <span className="text-fg-2 tabular-nums">
                    {t('fit.estimate', { need: `${number(fit.needMiB / MIB_PER_GB, 1)} GB`, available: `${number(fit.availableMiB / MIB_PER_GB, 1)} GB` })}
                  </span>
                </dd>
              </div>
            )}
            {plan && (
              <div className="flex flex-col gap-1 sm:col-span-2">
                <dt className="text-xs text-fg-3">{t('benchmark.plan.steps')}</dt>
                <dd className="text-fg-2">{scenarioLines(plan.scenario, f).join(' · ')}</dd>
              </div>
            )}
            {needs.length > 0 && (
              <div className="flex flex-col gap-1 sm:col-span-2">
                <dt className="inline-flex items-center gap-1.5 text-xs text-fg-3">
                  <Download aria-hidden className="size-3.5" />
                  {t('benchmark.plan.needs')}
                </dt>
                <dd className="text-fg-2">
                  {needs.map((n) => (n.bytes === undefined ? n.label : `${n.label} (${bytes(n.bytes)})`)).join(', ')}
                </dd>
              </div>
            )}
          </dl>
        )}
        {error && <ErrorCard error={error} headingLevel={3} />}
        {plan && plan.warnings.length > 0 && (
          <ul className="flex flex-col gap-2" aria-label={t('benchmark.plan.warnings')}>
            {plan.warnings.map((w, i) => {
              const n = noteText(w, f);
              return (
                <li key={`${w.code}-${i}`}>
                  <Callout tone={n.tone} title={n.title}>
                    {n.body}
                  </Callout>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <Collapsible.Root open={open} onOpenChange={setOpen} className="border-t border-border">
        <Collapsible.Trigger asChild>
          <button type="button" className="flex w-full items-center justify-between gap-3 px-card py-3 text-left hover:bg-surface-2/60 focus-ring">
            <span className="flex flex-col">
              <span className="text-sm font-semibold">{t('benchmark.expert.preview')}</span>
              <span className="text-xs text-fg-3">{t('benchmark.expert.previewHint')}</span>
            </span>
            <ChevronDown aria-hidden className={cn('size-4 text-fg-3 transition-transform', open && 'rotate-180')} />
          </button>
        </Collapsible.Trigger>
        <Collapsible.Content className="px-card pb-card">
          {plan && !commandLater ? (
            <CodeBlock commands={plan.command} label={t('benchmark.expert.preview')} />
          ) : (
            <p className="rounded-lg border border-dashed border-border-strong px-4 py-3 text-sm text-fg-2">
              {commandLater ? t(`benchmark.plan.commandAfter.${commandLater}`) : t('benchmark.plan.commandUnavailable')}
            </p>
          )}
        </Collapsible.Content>
      </Collapsible.Root>
    </Card>
  );
}
