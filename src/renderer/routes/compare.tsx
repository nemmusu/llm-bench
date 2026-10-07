import { useNavigate, useSearch } from '@tanstack/react-router';
import { ArrowDownRight, ArrowLeftRight, ArrowUpRight, Equal, Share2 } from 'lucide-react';
import { useCallback, useState, type ReactNode } from 'react';
import type { RunResult, RunSummary } from '../../contract/results';
import { concurrencyPairs, decodePairs, pairBarsOption, pairLinesOption, type PairSeries } from '../components/bench/compare-charts';
import { diffRows, metricRows, type MetricRow } from '../components/bench/compare-rows';
import { rowWords } from '../components/bench/compare-words';
import { ErrorCard } from '../components/bench/error-card';
import { engineLabelOf, modelLabelOf, prettyEngineLabel, shortGpuName, summaryModelLabel } from '../components/bench/format';
import { SheetDialog } from '../components/bench/sheet-dialog';
import { ChartCard } from '../components/charts/chart-card';
import { EChart } from '../components/charts/echart';
import type { ChartTokens } from '../components/charts/echarts';
import { Page } from '../components/shell/page';
import { Button } from '../components/ui/button';
import { Card, CardHeader, CardTitle } from '../components/ui/card';
import { Select } from '../components/ui/select';
import { Skeleton } from '../components/ui/skeleton';
import { Switch } from '../components/ui/switch';
import { useI18n } from '../i18n';
import { cn } from '../lib/cn';
import { apiErrorData, useRun, useRuns } from '../lib/queries-runs';

export interface CompareSearch {
  a?: string;
  b?: string;
}

/** Router search validation for /compare?a=…&b=… */
export function validateCompareSearch(search: Record<string, unknown>): CompareSearch {
  const pick = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const a = pick(search.a);
  const b = pick(search.b);
  return { ...(a ? { a } : {}), ...(b ? { b } : {}) };
}

function Head({ children, className }: { children: ReactNode; className?: string }) {
  return <th scope="col" className={cn('h-10 border-b border-border px-4 text-right text-xs font-medium text-fg-3 first:pl-card first:text-left last:pr-card', className)}>{children}</th>;
}

/** The difference in words: "2,2 volte più veloce", "+16%", "−54%", "prima riletto da capo, ora 1,00 s". */
function Delta({ row }: { row: MetricRow }) {
  const f = useI18n();
  const { t } = f;
  const d = rowWords(row, f);
  if (!d) return <span className="text-fg-3">–</span>;
  if (d.direction === 'same')
    return (
      <span className="inline-flex items-center gap-1 text-fg-3">
        <Equal aria-hidden className="size-3.5" />
        {t('compare.same')}
      </span>
    );
  return (
    <span className={cn('inline-flex items-center gap-1 font-medium', d.good ? 'text-success-text' : 'text-danger-text')}>
      {d.direction === 'up' ? <ArrowUpRight aria-hidden className="size-3.5" /> : <ArrowDownRight aria-hidden className="size-3.5" />}
      {d.text}
      <span className="sr-only">({d.good ? t('compare.better') : t('compare.worse')})</span>
    </span>
  );
}

function runOption(r: RunSummary, dateTime: (iso: string) => string) {
  return { value: r.id, label: `${summaryModelLabel(r)} · ${prettyEngineLabel(r.engineLabel)} · ${dateTime(r.createdAt)}`, description: shortGpuName(r.gpuName) };
}

/** Two pickers when the page is opened without both runs. */
function Pickers({ search }: { search: CompareSearch }) {
  const { t, dateTime } = useI18n();
  const navigate = useNavigate();
  const runs = useRuns();
  const list = (runs.data ?? []).filter((r) => r.status === 'completed');
  const go = (next: CompareSearch) => void navigate({ to: '/compare', search: next, replace: true });
  const options = list.map((r) => runOption(r, dateTime));
  return (
    <Card className="flex flex-col gap-4 p-card">
      <p className="text-sm text-fg-2">{t('compare.pickBody')}</p>
      {runs.isPending ? (
        <Skeleton className="h-10 w-full" />
      ) : list.length < 2 ? (
        <p className="text-sm text-fg-3">{t('compare.notEnough')}</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <Select aria-label={t('compare.pickA')} value={search.a ?? ''} onValueChange={(v) => go({ ...search, a: v })} options={options} />
          <Select aria-label={t('compare.pickB')} value={search.b ?? ''} onValueChange={(v) => go({ ...search, b: v })} options={options} />
        </div>
      )}
    </Card>
  );
}

function PairChart({ title, help, series, kind, nameA, nameB, format, xLabel, xName }: {
  title: string;
  help: string;
  series: PairSeries;
  kind: 'bars' | 'lines';
  nameA: string;
  nameB: string;
  format: (v: number) => string;
  xLabel: (v: number) => string;
  xName: string;
}) {
  const build = useCallback(
    (tk: ChartTokens) => (kind === 'bars' ? pairBarsOption : pairLinesOption)(tk, series, { nameA, nameB, format, xLabel, xName }),
    [kind, series, nameA, nameB, format, xLabel, xName],
  );
  const cell = (v: number | null) => (v === null ? '–' : format(v));
  return (
    <ChartCard
      title={title}
      help={help}
      table={{ columns: [xName, nameA, nameB], numeric: [0, 1, 2], rows: series.x.map((x, i) => [xLabel(x), cell(series.a[i]!), cell(series.b[i]!)]) }}
    >
      <EChart build={build} height={260} label={title} />
    </ChartCard>
  );
}

function Comparison({ a, b }: { a: RunResult; b: RunResult }) {
  const f = useI18n();
  const { t, number, integer } = f;
  const navigate = useNavigate();
  const [onlyDiff, setOnlyDiff] = useState(false);
  const [sheet, setSheet] = useState(false);
  // An older A and a newer B read as "Prima" and "Ora", like a before/after page.
  const ordered = Date.parse(a.createdAt) < Date.parse(b.createdAt);
  const cell = (r: MetricRow, v: number | undefined, reread: boolean | undefined) =>
    v === undefined ? '–' : reread ? `${t('longConversations.compare.reread')} (${r.format(v)})` : r.format(v);
  const metrics = metricRows(a, b, f);
  const diffs = diffRows(a, b, f);
  const shown = onlyDiff ? diffs.filter((d) => d.differs) : diffs;
  const title = (r: RunResult, letter: string) => (
    <span className="flex flex-col items-end gap-0.5">
      <span className="text-2xs font-semibold tracking-wide text-accent-text uppercase">{letter}</span>
      <span className="text-sm font-semibold text-fg">{modelLabelOf(r.model)}</span>
      <span className="font-normal">{engineLabelOf(r.engine)}</span>
      <span className="font-normal">{f.dateTime(r.createdAt)}</span>
    </span>
  );
  const nameA = `A · ${modelLabelOf(a.model)}`;
  const nameB = `B · ${modelLabelOf(b.model)}`;
  const decode = decodePairs(a, b);
  const conc = concurrencyPairs(a, b);
  const tps1 = useCallback((v: number) => `${number(v, 1)} tok/s`, [number]);
  const tps0 = useCallback((v: number) => `${integer(v)} tok/s`, [integer]);
  const groups = ['engine', 'model', 'params', 'system'] as const;
  return (
    <div className="flex flex-col gap-section">
      <Card className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-0 text-sm">
          <caption className="sr-only">{t('compare.title')}</caption>
          <thead>
            <tr>
              <Head>{t('compare.metric')}</Head>
              <Head>{title(a, ordered ? `A · ${t('longConversations.compare.before')}` : 'A')}</Head>
              <Head>{title(b, ordered ? `B · ${t('longConversations.compare.now')}` : 'B')}</Head>
              <Head>{t('compare.difference')}</Head>
            </tr>
          </thead>
          <tbody>
            {metrics.map((r) => (
              <tr key={r.id} className="hover:bg-surface-2">
                <th scope="row" className="h-row border-b border-border px-4 pl-card text-left font-medium">
                  {r.label}
                </th>
                <td className="h-row border-b border-border px-4 text-right tabular-nums">{cell(r, r.a, r.reread?.a)}</td>
                <td className="h-row border-b border-border px-4 text-right tabular-nums">{cell(r, r.b, r.reread?.b)}</td>
                <td className="h-row border-b border-border px-4 pr-card text-right tabular-nums">
                  <Delta row={r} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {(decode.x.length > 0 || conc.x.length > 0) && (
        <div className="grid gap-section lg:grid-cols-2">
          {decode.x.length > 0 && (
            <PairChart
              title={t('compare.chartDecode')}
              help={t('compare.chartDecodeHelp')}
              series={decode}
              kind="bars"
              nameA={nameA}
              nameB={nameB}
              format={tps1}
              xLabel={integer}
              xName={t('result.promptTokens')}
            />
          )}
          {conc.x.length > 0 && (
            <PairChart
              title={t('compare.chartConcurrency')}
              help={t('compare.chartConcurrencyHelp')}
              series={conc}
              kind="lines"
              nameA={nameA}
              nameB={nameB}
              format={tps0}
              xLabel={integer}
              xName={t('result.users')}
            />
          )}
        </div>
      )}

      <Card className="overflow-hidden">
        <CardHeader className="items-center pb-3">
          <CardTitle>{t('compare.params')}</CardTitle>
          <label className="flex items-center gap-2 text-sm font-medium text-fg">
            <Switch checked={onlyDiff} onCheckedChange={setOnlyDiff} />
            {t('compare.onlyDiff')}
          </label>
        </CardHeader>
        <div className="overflow-x-auto">
          <table className="w-full border-separate border-spacing-0 text-sm">
            <caption className="sr-only">{t('compare.params')}</caption>
            <thead>
              <tr>
                <Head>{t('compare.parameter')}</Head>
                <Head>A</Head>
                <Head>B</Head>
              </tr>
            </thead>
            {groups.map((g) => {
              const rows = shown.filter((d) => d.group === g);
              if (!rows.length) return null;
              return (
                <tbody key={g}>
                  <tr>
                    <th scope="colgroup" colSpan={3} className="bg-surface-2/60 px-card py-1.5 text-left text-2xs font-semibold tracking-wide text-fg-3 uppercase">
                      {t(`compare.groups.${g}`)}
                    </th>
                  </tr>
                  {rows.map((d) => (
                    <tr key={`${g}-${d.label}`} className={cn(d.differs && 'bg-warning-soft/60')}>
                      <th scope="row" className="h-row border-b border-border px-4 pl-card text-left font-medium">
                        {d.label}
                        {d.differs && <span className="sr-only"> ({t('compare.differs')})</span>}
                      </th>
                      <td className={cn('h-row border-b border-border px-4 text-right font-mono text-xs break-all', d.differs && 'font-semibold text-fg')}>{d.a}</td>
                      <td className={cn('h-row border-b border-border px-4 pr-card text-right font-mono text-xs break-all', d.differs && 'font-semibold text-fg')}>{d.b}</td>
                    </tr>
                  ))}
                </tbody>
              );
            })}
          </table>
          {shown.length === 0 && <p className="px-card py-6 text-center text-sm text-fg-3">{t('compare.noDiff')}</p>}
        </div>
      </Card>
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" onClick={() => void navigate({ to: '/compare', search: { a: b.id, b: a.id }, replace: true })}>
          <ArrowLeftRight aria-hidden />
          {t('compare.swap')}
        </Button>
        <Button onClick={() => setSheet(true)}>
          <Share2 aria-hidden />
          {t('sheet.open')}
        </Button>
      </div>
      <SheetDialog open={sheet} onOpenChange={setSheet} run={b} before={a} />
    </div>
  );
}

/** Side-by-side comparison of two runs: deltas, overlaid charts, every different setting. */
export function ComparePage() {
  const { t } = useI18n();
  const search = useSearch({ from: '/compare' });
  const a = useRun(search.a);
  const b = useRun(search.b);
  const failed = a.isError ? a.error : b.isError ? b.error : undefined;
  return (
    <Page title={t('compare.title')} subtitle={t('compare.subtitle')} width="wide">
      <div className="flex flex-col gap-section">
        <Pickers search={search} />
        {failed ? (
          <ErrorCard error={apiErrorData(failed)} />
        ) : a.data && b.data ? (
          <Comparison a={a.data} b={b.data} />
        ) : search.a && search.b ? (
          <Skeleton className="h-64 w-full" />
        ) : null}
      </div>
    </Page>
  );
}
