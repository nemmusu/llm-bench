import { ChevronDown } from 'lucide-react';
import { Collapsible } from 'radix-ui';
import { useState } from 'react';
import type { EngineKind } from '../../../contract/engines';
import type { Tuning } from '../../../contract/results';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/cn';
import { MIB_PER_GB, prefillStat } from '../bench/format';
import { useConfigLabel } from '../presets/config-label';
import { Badge } from '../ui/badge';
import { Card } from '../ui/card';
import { CodeBlock } from '../ui/code-block';
import { HelpTip } from '../ui/help-tip';
import { depthLabel, discardReason, kvName, outcomeText, settingsText } from './tune-format';
import { discardedAttempts, lastPoint } from './tune-logic';

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
                p ? t('tune.discarded.decode', { tps: number(p.decodeTps.median, 1) }) : undefined,
                p ? t('tune.discarded.prefill', { tps: integer(prefillStat(p).median) }) : undefined,
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
                  <CodeBlock commands={a.command} label={t('tune.measures.command', { settings })} />
                </li>
              );
            })}
          </ul>
        </Collapsible.Content>
      </Card>
    </Collapsible.Root>
  );
}

/** "Contesto massimo per tipo di cache": the estimate, what was measured, and why a type was not tried. Plus the fidelity check. */
export function CapacityCard({ tuning }: { tuning: Pick<Tuning, 'capacity' | 'fidelity'> }) {
  const f = useI18n();
  const { t, integer } = f;
  const ctx = (n: number | undefined) => (n === undefined ? '–' : depthLabel(n, f));
  const fid = tuning.fidelity;
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-1.5 px-card pt-card">
        <h2 className="text-md font-semibold tracking-[-0.01em]">{t('tune.capacity.title')}</h2>
        <HelpTip term={t('tune.help.kvTerm')}>{t('tune.help.kv')}</HelpTip>
      </div>
      <div className="mt-3 overflow-x-auto">
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
            {tuning.capacity.map((c) => (
              <tr key={c.kvType}>
                <th scope="row" className="h-row border-b border-border px-3 pl-card text-left font-medium whitespace-nowrap">
                  {kvName(c.kvType, f)}
                </th>
                <td className="h-row border-b border-border px-3 text-right tabular-nums" title={c.predictedMax === undefined ? undefined : integer(c.predictedMax)}>
                  {c.predictedMax === undefined ? t('tune.capacity.noFit') : ctx(c.predictedMax)}
                </td>
                <td className="h-row border-b border-border px-3 text-right font-semibold tabular-nums" title={c.measuredMax === undefined ? undefined : integer(c.measuredMax)}>
                  {ctx(c.measuredMax)}
                </td>
                <td className="h-row border-b border-border px-3 pr-card text-fg-2">
                  {c.skipped ? t(`tune.capacity.skipped.${c.skipped}`) : c.inferred ? t('tune.capacity.inferred') : c.measuredMax === undefined ? t('tune.capacity.none') : t('tune.capacity.measuredNote')}
                </td>
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

/** The words of the settings, each with its explanation: cache KV, context, flash attention, ub / b, shared RAM. */
export function TuneGlossary({ className }: { className?: string }) {
  const { t } = useI18n();
  const terms = [
    { term: t('tune.help.kvTerm'), help: t('tune.help.kv') },
    { term: t('tune.help.contextTerm'), help: t('tune.help.context') },
    { term: t('tune.help.faTerm'), help: t('tune.help.fa') },
    { term: t('tune.help.batchTerm'), help: t('tune.help.batch') },
    { term: t('tune.help.sharedTerm'), help: t('tune.help.shared') },
  ];
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
