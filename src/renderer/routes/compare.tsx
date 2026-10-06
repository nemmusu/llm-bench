import { ArrowDownRight, ArrowUpRight, Equal } from 'lucide-react';
import type { ReactNode } from 'react';
import { Page } from '../components/shell/page';
import { Card, CardHeader, CardTitle } from '../components/ui/card';
import { useI18n } from '../i18n';
import { cn } from '../lib/cn';
import { mockRunSummaries } from '../mock/runs';

interface Row {
  label: string;
  a: number | undefined;
  b: number | undefined;
  format: (v: number) => string;
  /** Whether a higher value is better (speed) or worse (time, memory). */
  higherIsBetter: boolean;
}

function Delta({ a, b, higherIsBetter }: { a: number | undefined; b: number | undefined; higherIsBetter: boolean }) {
  const { t, percent } = useI18n();
  if (a === undefined || b === undefined || a === 0) return <span className="text-fg-3">–</span>;
  const change = (b - a) / a;
  if (Math.abs(change) < 0.005)
    return (
      <span className="inline-flex items-center gap-1 text-fg-3">
        <Equal aria-hidden className="size-3.5" />
        {t('compare.same')}
      </span>
    );
  const good = change > 0 === higherIsBetter;
  return (
    <span className={cn('inline-flex items-center gap-1 font-medium', good ? 'text-success-text' : 'text-danger-text')}>
      {change > 0 ? <ArrowUpRight aria-hidden className="size-3.5" /> : <ArrowDownRight aria-hidden className="size-3.5" />}
      {change > 0 ? '+' : ''}
      {percent(change, 0)}
      <span className="sr-only">({good ? t('compare.better') : t('compare.worse')})</span>
    </span>
  );
}

function Head({ children }: { children: ReactNode }) {
  return <th scope="col" className="h-10 border-b border-border px-4 text-right text-xs font-medium text-fg-3 first:pl-card first:text-left last:pr-card">{children}</th>;
}

/** Side-by-side comparison of two runs (mock: llama.cpp vs vLLM on the same model). */
export function ComparePage() {
  const { t, number, integer } = useI18n();
  const a = mockRunSummaries[0]!;
  const b = mockRunSummaries[3]!;
  const rows: Row[] = [
    { label: t('metrics.decode.label'), a: a.decodeTps, b: b.decodeTps, format: (v) => `${number(v, 1)} tok/s`, higherIsBetter: true },
    { label: t('metrics.prefill.label'), a: a.prefillTps, b: b.prefillTps, format: (v) => `${integer(v)} tok/s`, higherIsBetter: true },
    { label: t('metrics.ttft.label'), a: a.ttftMs, b: b.ttftMs, format: (v) => `${integer(v)} ms`, higherIsBetter: false },
    { label: t('metrics.coldLoad.label'), a: a.coldLoadMs, b: b.coldLoadMs, format: (v) => `${number(v / 1000, 1)} s`, higherIsBetter: false },
    { label: t('metrics.warmLoad.label'), a: a.warmLoadMs, b: b.warmLoadMs, format: (v) => `${number(v / 1000, 1)} s`, higherIsBetter: false },
    { label: t('metrics.vramPeak.label'), a: a.vramPeakMiB, b: b.vramPeakMiB, format: (v) => `${number(v / 1024, 1)} GB`, higherIsBetter: false },
  ];
  const params: [string, string, string][] = [
    [t('benchmark.choice.engine'), a.engineLabel, b.engineLabel],
    [t('benchmark.choice.model'), `${a.modelName} ${a.quant}`, `${b.modelName} ${b.quant}`],
    [t('benchmark.expert.ctx'), '8192', '8192'],
    [t('benchmark.expert.parallel'), '1', '16'],
    [t('benchmark.expert.flashAttention'), t('common.on'), t('common.auto')],
  ];
  const title = (r: typeof a) => (
    <span className="flex flex-col items-end">
      <span className="text-sm font-semibold text-fg">{r.engineLabel}</span>
      <span className="font-normal">
        {r.modelName} {r.quant}
      </span>
    </span>
  );
  return (
    <Page title={t('compare.title')} subtitle={t('compare.subtitle')}>
      <div className="flex flex-col gap-section">
        <Card className="overflow-hidden">
          <table className="w-full border-separate border-spacing-0 text-sm">
            <caption className="sr-only">{t('compare.title')}</caption>
            <thead>
              <tr>
                <Head>{t('compare.metric')}</Head>
                <Head>{title(a)}</Head>
                <Head>{title(b)}</Head>
                <Head>{t('compare.difference')}</Head>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label} className="hover:bg-surface-2">
                  <th scope="row" className="h-row border-b border-border px-4 pl-card text-left font-medium">
                    {r.label}
                  </th>
                  <td className="h-row border-b border-border px-4 text-right tabular-nums">{r.a === undefined ? '–' : r.format(r.a)}</td>
                  <td className="h-row border-b border-border px-4 text-right tabular-nums">{r.b === undefined ? '–' : r.format(r.b)}</td>
                  <td className="h-row border-b border-border px-4 pr-card text-right tabular-nums">
                    <Delta a={r.a} b={r.b} higherIsBetter={r.higherIsBetter} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card className="overflow-hidden">
          <CardHeader className="pb-3">
            <CardTitle>{t('compare.params')}</CardTitle>
          </CardHeader>
          <table className="w-full border-separate border-spacing-0 text-sm">
            <caption className="sr-only">{t('compare.params')}</caption>
            <thead>
              <tr>
                <Head>{t('compare.parameter')}</Head>
                <Head>A</Head>
                <Head>B</Head>
              </tr>
            </thead>
            <tbody>
              {params.map(([label, x, y]) => {
                const differs = x !== y;
                return (
                  <tr key={label} className={cn(differs && 'bg-warning-soft/60')}>
                    <th scope="row" className="h-row border-b border-border px-4 pl-card text-left font-medium">
                      {label}
                    </th>
                    <td className={cn('h-row border-b border-border px-4 text-right font-mono text-xs', differs && 'font-semibold text-fg')}>{x}</td>
                    <td className={cn('h-row border-b border-border px-4 pr-card text-right font-mono text-xs', differs && 'font-semibold text-fg')}>{y}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      </div>
    </Page>
  );
}
