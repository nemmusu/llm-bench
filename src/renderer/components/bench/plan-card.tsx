import { Box, ChevronDown, Container, Download, ListChecks, Timer } from 'lucide-react';
import { Collapsible } from 'radix-ui';
import { useId, useState } from 'react';
import type { RunPlan } from '../../../contract/api';
import type { LaunchParams } from '../../../contract/engines';
import type { AppErrorData } from '../../../contract/errors';
import type { FitEstimate } from '../../../contract/models';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/cn';
import { depthLabel } from '../tune/tune-format';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Callout } from '../ui/callout';
import { CodeBlock } from '../ui/code-block';
import { FitBadge } from '../ui/fit-badge';
import { HelpTip } from '../ui/help-tip';
import { Skeleton } from '../ui/skeleton';
import { BusyVramNote, FitTotalHelp } from '../library/busy-note';
import { ErrorCard } from './error-card';
import { MIB_PER_GB } from './format';
import type { Need } from './needs';
import { noteText } from './notes';
import { scenarioLines } from './summary';

export interface PlanCardProps {
  plan: RunPlan | undefined;
  loading: boolean;
  /** Why no plan could be made for these choices. */
  error: AppErrorData | undefined;
  /** Installs and downloads done before the test (they are part of the preview, not a blocker). */
  needs: Need[];
  expert: boolean;
  /** "Usa cache q4_0" / "Contesto massimo che entra" of a "does not fit" warning. */
  onFix: (patch: FitPatch) => void;
}

const NEED_ICONS = { engine: Box, image: Container, model: Download } as const;

/**
 * The VRAM verdict and its estimate ("Stima: 6,8 GB su 31,8 GB della scheda"), judged on the card's total
 * (a "?" says how), "stima tarata su N misure" when the measured peaks of this card corrected it, and a
 * calm line for a context extended with YaRN or NInfer's own estimate.
 */
export function FitSummary({ fit }: { fit: FitEstimate }) {
  const { t, number, percent } = useI18n();
  const cal = fit.calibration;
  return (
    <span className="flex flex-wrap items-center gap-2">
      <FitBadge level={fit.level} size="sm" />
      <span className="inline-flex items-center gap-1 text-fg-2 tabular-nums">
        {t('fit.estimate', { need: `${number(fit.needMiB / MIB_PER_GB, 1)} GB`, available: `${number(fit.availableMiB / MIB_PER_GB, 1)} GB` })}
        <FitTotalHelp totalMiB={fit.totalMiB} />
      </span>
      {fit.notes.includes('context.rope-extended') && <span className="basis-full text-xs text-fg-3">{t('fit.ropeExtended')}</span>}
      {fit.notes.includes('ninfer.estimate') && <span className="basis-full text-xs text-fg-3">{t('fit.approximate')}</span>}
      {cal && (
        <span className="inline-flex items-center gap-1 text-xs text-fg-3 tabular-nums">
          {t('fit.calibrated', { n: cal.samples, err: percent(cal.errorPct / 100, 1) })}
          <HelpTip term={t('fit.calibrated', { n: cal.samples, err: percent(cal.errorPct / 100, 1) })}>
            {t('fit.calibratedHelp', { scope: t(cal.scope === 'model' ? 'fit.calibratedModel' : 'fit.calibratedArchitecture') })}
          </HelpTip>
        </span>
      )}
    </span>
  );
}

/** A setting that makes the launch fit ("Usa cache q4_0", "Contesto massimo che entra"). */
export type FitPatch = Pick<LaunchParams, 'kvCacheType' | 'flashAttention' | 'contextSize'>;

/** The quick fixes a "does not fit" warning carries (the plan's fit.fixes), as buttons. */
function FitFixButtons({ params, onFix }: { params: Record<string, unknown> | undefined; onFix: (patch: FitPatch) => void }) {
  const f = useI18n();
  const ctx = typeof params?.maxContext === 'number' ? params.maxContext : undefined;
  if (params?.kvCacheType !== 'q4_0' && ctx === undefined) return null;
  return (
    <span className="mt-2 flex flex-wrap gap-2">
      {params?.kvCacheType === 'q4_0' && (
        <Button size="sm" onClick={() => onFix({ kvCacheType: 'q4_0', flashAttention: 'on' })}>
          {f.t('spill.fix.q4')}
        </Button>
      )}
      {ctx !== undefined && (
        <Button size="sm" onClick={() => onFix({ contextSize: ctx })}>
          {f.t('spill.fix.context', { ctx: depthLabel(ctx, f) })}
        </Button>
      )}
    </span>
  );
}

/** Planning warnings in plain words (runs and servers); with `onFix`, a "does not fit" one offers its fixes. */
export function PlanWarnings({ warnings, onFix }: { warnings: RunPlan['warnings']; onFix?: (patch: FitPatch) => void }) {
  const f = useI18n();
  return (
    <ul className="flex flex-col gap-2" aria-label={f.t('benchmark.plan.warnings')}>
      {warnings.map((w, i) => {
        const n = noteText(w, f);
        return (
          <li key={`${w.code}-${i}`}>
            <Callout tone={n.tone} title={n.title}>
              {n.body}
              {onFix && (w.code === 'spill_risk' || w.code === 'oom_risk') && <FitFixButtons params={w.params} onFix={onFix} />}
            </Callout>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * "Anteprima": duration, VRAM fit, what gets installed or downloaded first, warnings and the exact
 * command. It is complete before anything is downloaded: a missing llama.cpp or model already has
 * its final path in the command, marked as prepared before the test.
 */
export function PlanCard({ plan, loading, error, needs, expert, onFix }: PlanCardProps) {
  const f = useI18n();
  const { t, bytes, duration } = f;
  const [open, setOpen] = useState(expert);
  const [prevExpert, setPrevExpert] = useState(expert);
  // Expert mode opens the command; switching it off folds it again.
  if (prevExpert !== expert) {
    setPrevExpert(expert);
    setOpen(expert);
  }
  const fit = plan?.fit;
  const pending = plan?.pending ?? [];
  const titleId = useId();
  return (
    <Card role="region" aria-labelledby={titleId} className="flex flex-col" aria-busy={loading}>
      <div className="flex items-center gap-2 px-card pt-card">
        <ListChecks aria-hidden className="size-4 text-accent-text" />
        <h2 id={titleId} className="text-md font-semibold tracking-[-0.01em]">
          {t('benchmark.plan.title')}
        </h2>
        <HelpTip term={t('benchmark.plan.title')}>{t('benchmark.plan.help')}</HelpTip>
        {needs.length > 0 && (
          <Badge tone="accent" size="sm" className="ml-auto">
            <Download aria-hidden />
            {t('benchmark.plan.pendingBadge')}
          </Badge>
        )}
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
                <dd>
                  <FitSummary fit={fit} />
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
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <dt className="inline-flex items-center gap-1.5 text-xs text-fg-3">
                  <Download aria-hidden className="size-3.5" />
                  {t('benchmark.plan.needs')}
                </dt>
                <dd>
                  <ul className="flex flex-col gap-1.5">
                    {needs.map((n) => {
                      const Icon = NEED_ICONS[n.kind];
                      return (
                        <li key={n.label} className="flex min-w-0 items-start gap-2 text-fg-2">
                          <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-accent-text" />
                          <span className="min-w-0 break-words">
                            <span className="font-medium text-fg">{n.label}</span>
                            {n.bytes !== undefined && <span className="tabular-nums"> ({bytes(n.bytes)})</span>}
                            <span> · {t(`benchmark.plan.needWhen.${n.kind}`)}</span>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </dd>
              </div>
            )}
          </dl>
        )}
        {error && <ErrorCard error={error} headingLevel={3} />}
        <BusyVramNote fit={fit} kind="run" />
        {plan && plan.warnings.length > 0 && <PlanWarnings warnings={plan.warnings} onFix={onFix} />}
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
        <Collapsible.Content className="flex flex-col gap-3 px-card pb-card">
          {plan ? (
            <>
              {pending.map((p) => (
                <Callout key={p} tone="info" title={t(`benchmark.plan.pending.${p}`)} />
              ))}
              <CodeBlock commands={plan.command} label={t('benchmark.expert.preview')} />
            </>
          ) : loading ? (
            <Skeleton className="h-16 w-full" />
          ) : (
            <p className="rounded-lg border border-dashed border-border-strong px-4 py-3 text-sm text-fg-2">{t('benchmark.plan.commandUnavailable')}</p>
          )}
        </Collapsible.Content>
      </Collapsible.Root>
    </Card>
  );
}
