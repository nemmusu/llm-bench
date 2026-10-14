import { useNavigate } from '@tanstack/react-router';
import { ChevronDown } from 'lucide-react';
import { Collapsible } from 'radix-ui';
import { useState } from 'react';
import { configParamsOf, configTagsOf } from '../../../contract/configs';
import type { EngineKind } from '../../../contract/engines';
import { fullContextPoint, nominalDepth, type TuneCombination, type Tuning, type ValidityFlag } from '../../../contract/results';
import { useI18n, type Formatters } from '../../i18n';
import { cn } from '../../lib/cn';
import { MIB_PER_GB, prefillStat } from '../bench/format';
import { useConfigLabel } from '../presets/config-label';
import { Badge } from '../ui/badge';
import { Callout } from '../ui/callout';
import { Card } from '../ui/card';
import { CodeBlock } from '../ui/code-block';
import { HelpTip } from '../ui/help-tip';
import { Tooltip } from '../ui/tooltip';
import { depthLabel, discardReason, kvName, loadTime, outcomeText, roughDuration, settingsText } from './tune-format';
import { capacityAtLeast, discardedAttempts, lastPoint, launchedCapacity, limitFound, medianLoadSeconds } from './tune-logic';

/**
 * The search stopped early: why (its time limit, its launch cap, or the run was cancelled or failed),
 * how many launches it made in how much time, and the requests it left out because they would have
 * ended after the time limit. Out of time: how long each engine start took against what the estimate
 * expected, and — the model read from a Windows folder by Docker or WSL — how to make starts faster.
 */
export function StoppedNote({
  tuning,
  validity = [],
}: {
  tuning: Pick<Tuning, 'stoppedBy' | 'attempts' | 'limitSeconds' | 'expectedLoadSeconds'>;
  /** The run's validity flags (slow_shared_filesystem says why starts were slow). */
  validity?: readonly ValidityFlag[];
}) {
  const f = useI18n();
  const { t, duration } = f;
  const navigate = useNavigate();
  const why = tuning.stoppedBy as NonNullable<Tuning['stoppedBy']>;
  const outOfTime = why === 'budget';
  const load = outOfTime ? medianLoadSeconds(tuning.attempts) : undefined;
  const slowDisk = outOfTime && validity.includes('slow_shared_filesystem');
  const skipped = tuning.attempts.flatMap((a) => a.skipped ?? []);
  const depths = [...new Set(skipped.map((s) => nominalDepth(s.depth)))].sort((a, b) => a - b);
  const n = tuning.attempts.length;
  const body =
    why === 'cancelled' || why === 'failed'
      ? n === 1
        ? t('tune.stopped.bodyEndedOne')
        : t('tune.stopped.bodyEnded', { n })
      : tuning.limitSeconds !== undefined
        ? t('tune.stopped.bodyLimit', { n, limit: duration(tuning.limitSeconds * 1000) })
        : t('tune.stopped.body', { n });
  return (
    <Callout
      className="mt-4"
      tone="info"
      title={t(`tune.stopped.${why}`)}
      {...(slowDisk ? { action: { label: t('validity.slow_shared_filesystem.action'), onClick: () => void navigate({ to: '/engines' }) } } : {})}
    >
      <p>{body}</p>
      {load !== undefined && (
        <p className="mt-1">
          {tuning.expectedLoadSeconds === undefined
            ? t('tune.stopped.loads', { actual: loadTime(load, f) })
            : t('tune.stopped.loadsExpected', { actual: loadTime(load, f), expected: loadTime(tuning.expectedLoadSeconds, f) })}
        </p>
      )}
      {slowDisk && <p className="mt-1">{t('tune.stopped.slowDisk')}</p>}
      {skipped.length > 0 && (
        <p className="mt-1">
          {t('tune.discarded.skipped', {
            depths: depths.map((d) => depthLabel(d, f)).join(', '),
            time: roughDuration(Math.max(...skipped.map((s) => s.predictedMs)) / 1000),
          })}
        </p>
      )}
    </Callout>
  );
}

/**
 * "Misurata in parte (tempo finito)": a combination the search could not measure to the end, with what
 * that means on hover — not measured with its context full, or (with `combo`, measured that far) not at
 * every depth nor against all its settings.
 */
export function PartialBadge({ why, combo }: { why: NonNullable<TuneCombination['partial']>; combo?: Pick<TuneCombination, 'maxContext' | 'sweep'> }) {
  const f = useI18n();
  const { t } = f;
  const help = combo ? t(fullContextPoint(combo) ? 'tune.partial.helpFull' : 'tune.partial.helpNotFull', { ctx: depthLabel(combo.maxContext, f) }) : t('tune.partial.help');
  return (
    <Tooltip content={help}>
      <Badge tone="warning" size="sm">
        {t(`tune.partial.${why}`)}
      </Badge>
    </Tooltip>
  );
}

/** "Prove scartate": every launch that did not make it, why in words, its quick numbers and its command. Folded. */
export function DiscardedAttempts({ tuning, engineKind }: { tuning: Pick<Tuning, 'attempts'>; engineKind: EngineKind }) {
  const f = useI18n();
  const { t, number, integer } = f;
  const label = useConfigLabel();
  const [open, setOpen] = useState(false);
  const list = discardedAttempts(tuning);
  if (!list.length) return null;
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <Card className="overflow-hidden">
        <Collapsible.Trigger asChild>
          <button type="button" className="flex w-full items-center justify-between gap-3 px-card py-3.5 text-left hover:bg-surface-2/60 focus-ring">
            <span className="flex flex-col">
              <span className="flex items-center gap-2">
                <span className="text-md font-semibold">{t('tune.discarded.title')}</span>
                <Badge size="sm">{integer(list.length)}</Badge>
              </span>
              <span className="text-sm text-fg-3">{t('tune.discarded.subtitle')}</span>
            </span>
            <ChevronDown aria-hidden className={cn('size-4 shrink-0 text-fg-3 transition-transform', open && 'rotate-180')} />
          </button>
        </Collapsible.Trigger>
        <Collapsible.Content>
          <ul className="flex flex-col divide-y divide-border border-t border-border">
            {list.map(({ attempt: a, index }) => {
              const p = lastPoint(a);
              const settings = settingsText(a.params, engineKind, label);
              const numbers = [
                t('tune.discarded.context', { ctx: depthLabel(a.contextSize, f) }),
                // Its numbers with the depth they were measured at (not the launch's context).
                p ? t('tune.discarded.measured', { depth: depthLabel(nominalDepth(p.promptTokens), f), decode: number(p.decodeTps.median, 1), prefill: integer(prefillStat(p).median) }) : undefined,
                a.vramPeakMiB === undefined ? undefined : t('tune.discarded.vram', { size: number(a.vramPeakMiB / MIB_PER_GB, 1) }),
                a.sharedPeakMiB === undefined ? undefined : t('tune.discarded.shared', { size: number(a.sharedPeakMiB / MIB_PER_GB, 1) }),
              ].filter(Boolean);
              return (
                <li key={index} className="flex flex-col gap-2 px-card py-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={a.outcome === 'ok' ? 'neutral' : a.outcome === 'error' ? 'danger' : 'warning'} size="sm">
                      {outcomeText(a, f)}
                    </Badge>
                    <span className="text-sm font-medium text-fg">{settings}</span>
                  </div>
                  <p className="text-sm text-fg-2">{discardReason(a, f)}</p>
                  <p className="text-xs text-fg-3 tabular-nums">{numbers.join(' · ')}</p>
                  <CodeBlock commands={a.command} label={t('tune.discarded.command', { n: index + 1, settings, ctx: depthLabel(a.contextSize, f) })} />
                </li>
              );
            })}
          </ul>
        </Collapsible.Content>
      </Card>
    </Collapsible.Root>
  );
}

/**
 * The note of a KV type's largest context: why it was not tried ("Non provato (test annullato | tempo
 * finito | non serviva)"…), that it was deduced, or what is known above it — "Limite trovato" (the next
 * context up did not fit, within the search's precision) against "Almeno …" (larger ones were not tried:
 * the estimate stopped there, the time ran out, the run ended mid-search, or — older runs — the context
 * that did not fit is far above, the ones in between untried). "Nessun contesto è entrato" only when
 * every context tried failed and the search came to its end. Runs before the bound was saved: "measured".
 */
export function capacityNote(c: Tuning['capacity'][number], f: Pick<Formatters, 't' | 'number' | 'integer'>): string {
  const { t } = f;
  if (c.measuredMax === undefined) {
    if (c.skipped) return t(`tune.capacity.skipped.${c.skipped}`);
    // The run ended mid-search: nothing tried so far had loaded (a cut search always has a failed context).
    if (c.bound === 'cancelled' || c.bound === 'failed') return t(`tune.capacity.cut.${c.bound}`, { next: depthLabel(c.failedAt as number, f) });
    return t('tune.capacity.none');
  }
  if (c.inferred) return t('tune.capacity.inferred');
  const ctx = depthLabel(c.measuredMax, f);
  switch (c.bound) {
    case 'found':
      return t(limitFound(c) ? 'tune.capacity.bound.found' : 'tune.capacity.bound.gap', { ctx, next: depthLabel(c.failedAt as number, f) });
    case 'model':
      return t('tune.capacity.bound.model');
    case 'estimate':
      // A type is only searched up to its estimate.
      return t('tune.capacity.bound.estimate', { ctx, est: depthLabel(c.predictedMax as number, f) });
    case 'budget':
    case 'cancelled':
    case 'failed':
      return t(`tune.capacity.bound.${c.bound}`, { ctx });
    default:
      return c.skipped ? t(`tune.capacity.skipped.${c.skipped}`) : t('tune.capacity.measuredNote');
  }
}

/**
 * "Contesto massimo per tipo di cache": the estimate, what was measured (as its launches say it), and why a
 * type was not tried. Plus the fidelity check.
 */
export function CapacityCard({ tuning }: { tuning: Pick<Tuning, 'capacity' | 'fidelity' | 'attempts'> }) {
  const f = useI18n();
  const { t, integer } = f;
  const ctx = (n: number | undefined) => (n === undefined ? '–' : depthLabel(n, f));
  const fid = tuning.fidelity;
  const capacity = launchedCapacity(tuning);
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-1.5 px-card pt-card">
        <h2 className="text-md font-semibold tracking-[-0.01em]">{t('tune.capacity.title')}</h2>
        <HelpTip term={t('tune.help.kvTerm')}>{t('tune.help.kv')}</HelpTip>
      </div>
      <div role="region" aria-label={t('tune.capacity.title')} tabIndex={0} className="mt-3 overflow-x-auto focus-ring">
        <table className="w-full border-separate border-spacing-0 text-sm">
          <caption className="sr-only">{t('tune.capacity.title')}</caption>
          <thead>
            <tr>
              {[t('tune.capacity.kv'), t('tune.capacity.predicted'), t('tune.capacity.measured'), t('tune.capacity.note')].map((h, i) => (
                <th key={h} scope="col" className={cn('h-9 border-b border-border px-3 text-xs font-medium whitespace-nowrap text-fg-3 first:pl-card last:pr-card', i === 1 || i === 2 ? 'text-right' : 'text-left')}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {capacity.map((c) => (
              <tr key={c.kvType}>
                <th scope="row" className="h-row border-b border-border px-3 pl-card text-left font-medium whitespace-nowrap">
                  {kvName(c.kvType, f)}
                </th>
                <td className="h-row border-b border-border px-3 text-right tabular-nums" title={c.predictedMax === undefined ? undefined : integer(c.predictedMax)}>
                  {c.predictedMax === undefined ? t('tune.capacity.noFit') : ctx(c.predictedMax)}
                </td>
                <td className="h-row border-b border-border px-3 text-right font-semibold tabular-nums" title={c.measuredMax === undefined ? undefined : integer(c.measuredMax)}>
                  {/* Larger contexts left untried: it holds at least this much. */}
                  {capacityAtLeast(c) ? t('tune.capacity.atLeast', { ctx: ctx(c.measuredMax) }) : ctx(c.measuredMax)}
                </td>
                <td className="h-row border-b border-border px-3 pr-card text-fg-2">{capacityNote(c, f)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {fid && (
        <div className="flex flex-col gap-1 border-t border-border px-card py-4">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-fg">
            {t('tune.fidelity.title')}
            <HelpTip term={t('tune.fidelity.title')}>{t('tune.fidelity.help')}</HelpTip>
          </p>
          <p className="text-sm text-fg-2">
            {fid.identical >= fid.tokens
              ? t('tune.fidelity.allSame', { tokens: integer(fid.tokens), kv: kvName(fid.comparedKv, f), ref: kvName(fid.referenceKv, f), prompt: integer(fid.promptTokens) })
              : t('tune.fidelity.diverges', {
                  identical: integer(fid.identical),
                  tokens: integer(fid.tokens),
                  kv: kvName(fid.comparedKv, f),
                  ref: kvName(fid.referenceKv, f),
                  first: integer(fid.firstDivergence ?? fid.identical + 1),
                  prompt: integer(fid.promptTokens),
                })}
          </p>
          <p className="text-xs text-fg-3">{t('tune.fidelity.disclaimer')}</p>
        </div>
      )}
      {!fid && <div className="h-2" />}
    </Card>
  );
}

/** A word of the glossary: its term and its explanation are tune.help.{key}Term and tune.help.{key}. */
export type GlossaryTerm = 'kv' | 'context' | 'fa' | 'batch' | 'batchTokens' | 'eager' | 'speculative' | 'offload' | 'shared';

/** Without a run to read them from: the words of a llama.cpp search. */
const LLAMA_TERMS: readonly GlossaryTerm[] = ['kv', 'context', 'fa', 'batch', 'shared'];

/**
 * The words the settings of this run show (the same rules as their labels, engine defaults left out):
 * the KV cache and the context always; flash attention, ub / b, the batch in tokens, eager mode,
 * speculative decoding and the CPU only when a launch has them; the shared RAM when a launch spilled.
 */
export function glossaryTerms(engineKind: EngineKind, tuning: Pick<Tuning, 'combinations' | 'attempts'>): GlossaryTerm[] {
  const launches = [...tuning.combinations, ...tuning.attempts];
  const settings = launches.map((l) => ({ p: configParamsOf({ engineKind, params: l.params }), tags: 'tags' in l ? l.tags : [] }));
  const any = (test: (s: (typeof settings)[number]) => boolean) => settings.some(test);
  const has: Record<GlossaryTerm, boolean> = {
    kv: true,
    context: true,
    fa: any(({ p }) => p.flashAttention !== undefined),
    batch: any(({ p }) => p.ubatchSize !== undefined || p.batchSize !== undefined),
    batchTokens: any(({ p }) => p.maxNumBatchedTokens !== undefined),
    eager: any(({ p, tags }) => p.enforceEager === true || tags.includes('eager')),
    speculative: any(({ p, tags }) => configTagsOf(p).includes('draft') || p.draftMax !== undefined || tags.includes('draft')),
    offload: any(({ p, tags }) => configTagsOf(p).includes('cpu-offload') || tags.includes('cpu-offload')),
    shared: tuning.attempts.some((a) => a.outcome === 'spill'),
  };
  return (Object.keys(has) as GlossaryTerm[]).filter((k) => has[k]);
}

/**
 * The words of the settings, each with its explanation: those the run's labels show (glossaryTerms);
 * without a run, those of a llama.cpp search (cache KV, context, flash attention, ub / b, shared RAM).
 */
export function TuneGlossary({ className, engineKind, tuning }: { className?: string; engineKind?: EngineKind; tuning?: Pick<Tuning, 'combinations' | 'attempts'> }) {
  const { t } = useI18n();
  const keys = engineKind && tuning ? glossaryTerms(engineKind, tuning) : LLAMA_TERMS;
  const terms = keys.map((k) => ({ term: t(`tune.help.${k}Term`), help: t(`tune.help.${k}`) }));
  return (
    <p className={cn('flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-3', className)}>
      <span>{t('tune.help.glossary')}</span>
      {terms.map((x) => (
        <span key={x.term} className="inline-flex items-center gap-0.5 text-fg-2">
          {x.term}
          <HelpTip term={x.term}>{x.help}</HelpTip>
        </span>
      ))}
    </p>
  );
}
