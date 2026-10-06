import { Link, useNavigate, useParams } from '@tanstack/react-router';
import {
  ArrowLeft,
  ChevronDown,
  Copy,
  FileJson,
  FileSpreadsheet,
  FileText,
  GitCompareArrows,
  Globe,
  Play,
  RotateCcw,
  Server,
  SlidersHorizontal,
  Upload,
} from 'lucide-react';
import { Collapsible } from 'radix-ui';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import type { LatencyPoint, RunResult, Stat, ValidityFlag } from '../../contract/results';
import { barOption, concurrencyOption, timelineOption } from '../components/charts/builders';
import { ChartCard } from '../components/charts/chart-card';
import { EChart } from '../components/charts/echart';
import type { ChartTokens } from '../components/charts/echarts';
import { Page } from '../components/shell/page';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Callout } from '../components/ui/callout';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { CodeBlock } from '../components/ui/code-block';
import { columnHelper, DataTable } from '../components/ui/data-table';
import { Dialog, DialogClose, DialogContent } from '../components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../components/ui/dropdown-menu';
import { HelpTip } from '../components/ui/help-tip';
import { SegmentedControl } from '../components/ui/segmented-control';
import { Skeleton } from '../components/ui/skeleton';
import { StatTile } from '../components/ui/stat-tile';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { useI18n, type Formatters } from '../i18n';
import { useRun } from '../lib/queries';
import { mockSystem } from '../mock/system';

/** Average words per token (Italian/English prose) used for the plain-language sentence. */
export const WORDS_PER_TOKEN = 0.7;
/** Typical silent reading speed: ~240 words per minute. */
export const READING_WORDS_PER_SEC = 4;

const statusTone = { completed: 'success', failed: 'danger', cancelled: 'neutral' } as const;
const calloutTone: Partial<Record<ValidityFlag, 'warning' | 'info'>> = { gpu_shared: 'warning', throttling: 'warning', unstable: 'warning' };

function gb(mib: number | undefined): number {
  return (mib ?? 0) / 1024;
}

function ScoreCard({ run }: { run: RunResult }) {
  const { t, integer } = useI18n();
  const decode = run.metrics.latency.find((p) => p.promptTokens === 512)?.decodeTps.median ?? run.metrics.latency[0]?.decodeTps.median ?? 0;
  const words = Math.round(decode * WORDS_PER_TOKEN);
  const score = run.metrics.score;
  return (
    <Card className="hero-wash relative flex h-full flex-col overflow-hidden p-6 compact:p-5">
      <p className="flex items-center gap-1.5 text-sm font-medium text-fg-2">
        {t('metrics.score.label')}
        <HelpTip term={t('metrics.score.label')}>{t('metrics.score.help')}</HelpTip>
      </p>
      {score ? (
        <p className="mt-1 flex items-baseline gap-3">
          <span className="bg-[linear-gradient(120deg,var(--fg)_30%,var(--accent-text))] bg-clip-text text-6xl font-semibold tracking-[-0.035em] text-transparent">
            {integer(score.value)}
          </span>
          <span className="text-sm text-fg-3">{t('result.scoreOf')}</span>
        </p>
      ) : (
        <p className="mt-2 text-sm text-fg-3">{t('result.noScore')}</p>
      )}
      <p className="mt-3 text-lg leading-7 font-medium text-balance text-fg">
        {words > READING_WORDS_PER_SEC * 3 ? t('result.sentence', { words: integer(words) }) : t('result.sentenceSlow', { words: integer(words) })}
      </p>
      <div className="mt-4 flex flex-col gap-2.5" role="img" aria-label={t('result.readingCompare', { reading: READING_WORDS_PER_SEC, words: integer(words) })}>
        {[
          { label: t('result.you'), value: READING_WORDS_PER_SEC, cls: 'bg-fg-3' },
          { label: t('result.thisGpu'), value: words, cls: 'bg-[linear-gradient(90deg,var(--accent),var(--accent-2))]' },
        ].map((b) => (
          <div key={b.label} className="grid grid-cols-[84px_1fr_auto] items-center gap-3 text-xs">
            <span className="text-fg-2">{b.label}</span>
            <span className="h-2 overflow-hidden rounded-full bg-surface-3">
              <span className={`block h-full rounded-full ${b.cls}`} style={{ width: `${Math.max(2, (b.value / Math.max(words, 1)) * 100)}%` }} />
            </span>
            <span className="w-24 text-right font-medium text-fg tabular-nums">
              {integer(b.value)} {t('units.wordsPerSec')}
            </span>
          </div>
        ))}
      </div>
      {score && <p className="mt-auto pt-4 text-xs text-fg-3">{t('result.scoreReference', { version: score.referenceVersion })}</p>}
    </Card>
  );
}

function statLine(s: Stat | undefined, f: Formatters, digits: number): string {
  if (!s) return '–';
  return `${f.number(s.median, digits)}`;
}

function KpiGrid({ run }: { run: RunResult }) {
  const f = useI18n();
  const { t, number, integer } = f;
  const m = run.metrics;
  const p512 = m.latency.find((p) => p.promptTokens === 512) ?? m.latency[0];
  const peakConc = m.concurrency[m.concurrency.length - 1];
  const cv = (s: Stat | undefined) => (s ? t('result.variation', { cv: f.percent(s.cv, 1) }) : undefined);
  return (
    <section aria-label={t('result.kpis')} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatTile
        label={t('metrics.decode.label')}
        help={t('metrics.decode.help')}
        value={statLine(p512?.decodeTps, f, 1)}
        unit="tok/s"
        hint={`≈ ${integer((p512?.decodeTps.median ?? 0) * WORDS_PER_TOKEN)} ${t('units.wordsPerSec')} · ${cv(p512?.decodeTps)}`}
        {...(p512 ? { sparkline: p512.decodeTps.values } : {})}
      />
      <StatTile
        label={t('metrics.prefill.label')}
        help={t('metrics.prefill.help')}
        value={p512 ? integer(p512.prefillTps.median) : '–'}
        unit="tok/s"
        hint={t('units.tokens', { n: p512?.promptTokens ?? 0 })}
        {...(p512 ? { sparkline: p512.prefillTps.values } : {})}
      />
      <StatTile
        label={t('metrics.ttft.label')}
        help={t('metrics.ttft.help')}
        value={p512 ? integer(p512.ttftMs.median) : '–'}
        unit="ms"
        hint={t('units.tokens', { n: p512?.promptTokens ?? 0 })}
      />
      <StatTile
        label={t('metrics.efficiency.label')}
        help={t('metrics.efficiency.help')}
        value={m.energy.tokensPerJoule === undefined ? '–' : number(m.energy.tokensPerJoule, 2)}
        unit="tok/J"
        hint={m.energy.avgPowerW ? `${t('metrics.avgPower.label')} ${integer(m.energy.avgPowerW)} W` : undefined}
      />
      <StatTile
        label={t('metrics.coldLoad.label')}
        help={t('metrics.coldLoad.help')}
        value={m.load.coldMs ? number(m.load.coldMs.median / 1000, 2) : '–'}
        unit="s"
        hint={m.load.coldReadBytesPerSec ? `${f.bytes(m.load.coldReadBytesPerSec)}/s` : undefined}
      />
      <StatTile
        label={t('metrics.warmLoad.label')}
        help={t('metrics.warmLoad.help')}
        value={m.load.warmMs ? number(m.load.warmMs.median / 1000, 2) : '–'}
        unit="s"
        hint={cv(m.load.warmMs)}
      />
      <StatTile
        label={t('metrics.vramPeak.label')}
        help={t('metrics.vramPeak.help')}
        value={number(gb(m.vram.deltaMiB), 1)}
        unit="GB"
        hint={m.vram.estimateMiB ? `${t('fit.estimate', { need: `${number(gb(m.vram.estimateMiB), 1)} GB`, available: `${number(gb(mockSystem.gpus[0]!.memoryTotalMiB), 1)} GB` })}` : undefined}
      />
      <StatTile
        label={t('metrics.concurrency.label')}
        help={t('metrics.concurrency.help')}
        value={peakConc ? integer(peakConc.aggregateTps) : '–'}
        unit="tok/s"
        hint={peakConc ? t('units.users', { n: peakConc.level }) : undefined}
        {...(m.concurrency.length > 1 ? { sparkline: m.concurrency.map((c) => c.aggregateTps) } : {})}
      />
    </section>
  );
}

function PromptChart({ points }: { points: LatencyPoint[] }) {
  const { t, number, integer } = useI18n();
  const [metric, setMetric] = useState<'decode' | 'prefill'>('decode');
  const build = useCallback(
    (tk: ChartTokens) => {
      const fmt = (v: number) => (metric === 'decode' ? `${number(v, 1)} tok/s` : `${integer(v)} tok/s`);
      return barOption(
        tk,
        points.map((p) => integer(p.promptTokens)),
        points.map((p) => (metric === 'decode' ? p.decodeTps.median : p.prefillTps.median)),
        { name: t(`metrics.${metric}.label`), format: fmt, xName: t('result.promptTokens'), axis: integer },
      );
    },
    [points, metric, t, number, integer],
  );
  return (
    <ChartCard
      title={t('result.chartByPrompt')}
      help={t('result.chartByPromptHelp')}
      controls={
        <SegmentedControl
          size="sm"
          label={t('result.chartByPrompt')}
          value={metric}
          onValueChange={setMetric}
          options={[
            { value: 'decode', label: t('metrics.decode.label') },
            { value: 'prefill', label: t('metrics.prefill.label') },
          ]}
        />
      }
      table={{
        columns: [t('result.promptTokens'), `${t('metrics.decode.label')} (tok/s)`, `${t('metrics.prefill.label')} (tok/s)`, `${t('metrics.ttft.label')} (ms)`],
        numeric: [0, 1, 2, 3],
        rows: points.map((p) => [integer(p.promptTokens), number(p.decodeTps.median, 1), integer(p.prefillTps.median), integer(p.ttftMs.median)]),
      }}
    >
      <EChart build={build} height={260} label={t('result.chartByPrompt')} />
    </ChartCard>
  );
}

function ConcurrencyChart({ run }: { run: RunResult }) {
  const { t, integer } = useI18n();
  const c = run.metrics.concurrency;
  const build = useCallback(
    (tk: ChartTokens) =>
      concurrencyOption(
        tk,
        c.map((p) => p.level),
        c.map((p) => p.aggregateTps),
        c.map((p) => p.perRequestDecodeTpsP50),
        { aggregateName: t('result.aggregate'), perUserName: t('result.perUser'), format: (v) => `${integer(v)} tok/s`, xName: t('result.users'), axis: integer },
      ),
    [c, t, integer],
  );
  return (
    <ChartCard
      title={t('result.chartConcurrency')}
      help={t('result.chartConcurrencyHelp')}
      table={{
        columns: [t('result.users'), `${t('result.aggregate')} (tok/s)`, `${t('result.perUser')} (tok/s)`, `${t('result.details.ttftP95')} (ms)`],
        numeric: [0, 1, 2, 3],
        rows: c.map((p) => [p.level, integer(p.aggregateTps), integer(p.perRequestDecodeTpsP50), integer(p.ttftP95Ms)]),
      }}
    >
      <EChart build={build} height={260} label={t('result.chartConcurrency')} />
    </ChartCard>
  );
}

function TimelineChart({ run }: { run: RunResult }) {
  const { t, number, integer, duration } = useI18n();
  const tel = run.telemetry;
  const bands = useMemo(() => {
    const marks = tel?.marks ?? [];
    const end = (tel?.t[tel.t.length - 1] ?? 0) / 1000;
    return marks.map((m, i) => ({
      start: m.t / 1000,
      end: (marks[i + 1]?.t ?? end * 1000) / 1000,
      label: t(`phases.${m.label as 'prepare'}.label`),
    }));
  }, [tel, t]);
  const build = useCallback(
    (tk: ChartTokens) =>
      timelineOption(
        tk,
        (tel?.t ?? []).map((x) => x / 1000),
        [
          { name: t('metrics.util.label'), unit: '%', values: tel?.utilPct ?? [], format: (v) => `${integer(v)} %`, max: 100 },
          { name: t('metrics.vram.label'), unit: 'GB', values: (tel?.memUsedMiB ?? []).map((v) => (v === null ? null : v / 1024)), format: (v) => `${number(v, 1)} GB`, max: 32 },
          { name: t('metrics.power.label'), unit: 'W', values: tel?.powerW ?? [], format: (v) => `${integer(v)} W`, max: 600 },
        ],
        bands,
      ),
    [tel, bands, t, number, integer],
  );
  if (!tel) return null;
  return (
    <ChartCard
      title={t('result.chartTimeline')}
      help={t('result.chartTimelineHelp')}
      table={{
        columns: [t('chart.time'), t('chart.phase'), `${t('metrics.util.label')} (%)`, `${t('metrics.vram.label')} (GB)`, `${t('metrics.power.label')} (W)`, `${t('metrics.temp.label')} (°C)`],
        numeric: [2, 3, 4, 5],
        rows: tel.t
          .map((x, i) => [x, i] as const)
          .filter(([, i]) => i % 10 === 0)
          .map(([x, i]) => [
            duration(x),
            bands.find((b) => x / 1000 >= b.start && x / 1000 < b.end)?.label ?? '',
            integer(tel.utilPct[i] ?? 0),
            number((tel.memUsedMiB[i] ?? 0) / 1024, 1),
            integer(tel.powerW[i] ?? 0),
            integer(tel.tempC[i] ?? 0),
          ]),
      }}
    >
      <EChart build={build} height={34 + 3 * 64 + 2 * 40 + 32} label={t('result.chartTimeline')} />
    </ChartCard>
  );
}

/** Duration, repetitions and stability: how much to trust the numbers, in plain words. */
function RunSummaryCard({ run }: { run: RunResult }) {
  const { t, duration, percent } = useI18n();
  const reps = run.scenario.steps.find((s) => s.kind === 'latency');
  const cvs = run.metrics.latency.map((p) => p.decodeTps.cv);
  const worst = cvs.length ? Math.max(...cvs) : 0;
  const level = worst < 0.02 ? 'Good' : worst < 0.05 ? 'Ok' : 'Bad';
  const items: { label: string; value: ReactNode; help?: string }[] = [
    { label: t('result.summary.duration'), value: duration(Date.parse(run.finishedAt) - Date.parse(run.createdAt)) },
    { label: t('result.summary.repetitions'), value: t('result.summary.repetitionsValue', { n: reps?.kind === 'latency' ? reps.reps : 1 }) },
    {
      label: t('result.summary.stability'),
      help: t('result.summary.stabilityHelp'),
      value: (
        <span className={level === 'Good' ? 'text-success-text' : level === 'Ok' ? 'text-fg' : 'text-warning-text'}>
          {t(`result.summary.stability${level}`)} <span className="font-normal text-fg-3">· {percent(worst, 1)}</span>
        </span>
      ),
    },
  ];
  return (
    <Card className="mt-auto">
      <dl className="grid grid-cols-3 divide-x divide-border">
        {items.map((i) => (
          <div key={i.label} className="flex flex-col gap-1 px-card py-4">
            <dt className="flex items-center gap-1 text-xs text-fg-3">
              {i.label}
              {i.help && <HelpTip term={i.label}>{i.help}</HelpTip>}
            </dt>
            <dd className="text-md font-semibold text-fg tabular-nums">{i.value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function Overview({ run }: { run: RunResult }) {
  const { t, number } = useI18n();
  const navigate = useNavigate();
  const other = mockSystem.otherGpuUsers[0];
  const actionFor = (flag: ValidityFlag) => () => {
    if (flag === 'throttling') void navigate({ to: '/monitor' });
    else if (flag === 'cold_not_guaranteed' || flag === 'cold_probably_cached') void navigate({ to: '/settings' });
    else void navigate({ to: '/' });
  };
  return (
    <div className="flex flex-col gap-section">
      <div className={run.validity.length > 0 ? 'grid gap-section lg:grid-cols-12' : 'grid gap-section'}>
        <div className={run.validity.length > 0 ? 'lg:col-span-5' : ''}>
          <ScoreCard run={run} />
        </div>
        {run.validity.length > 0 && (
          <section aria-labelledby="validity-title" className="flex flex-col gap-3 lg:col-span-7">
            <h2 id="validity-title" className="text-md font-semibold tracking-[-0.01em]">
              {t('result.validityTitle')}
            </h2>
            {run.validity.map((flag) => (
              <Callout
                key={flag}
                tone={calloutTone[flag] ?? 'info'}
                title={t(`validity.${flag}.title`)}
                action={{ label: t(`validity.${flag}.action`), onClick: actionFor(flag) }}
              >
                {t(`validity.${flag}.body`, { name: other?.name ?? '', pid: other?.pid ?? 0, size: `${number(2.3, 1)} GB` })}
              </Callout>
            ))}
            <RunSummaryCard run={run} />
          </section>
        )}
      </div>
      <KpiGrid run={run} />
      <div className="grid gap-section lg:grid-cols-2">
        <PromptChart points={run.metrics.latency} />
        <ConcurrencyChart run={run} />
      </div>
      <TimelineChart run={run} />
    </div>
  );
}

function SimpleTable({ caption, head, rows, numericFrom = 1 }: { caption: string; head: string[]; rows: ReactNode[][]; numericFrom?: number }) {
  return (
    <table className="w-full border-separate border-spacing-0 text-sm">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>
          {head.map((h, i) => (
            <th key={h} scope="col" className={`h-9 border-b border-border px-3 text-xs font-medium text-fg-3 first:pl-card last:pr-card ${i >= numericFrom ? 'text-right' : 'text-left'}`}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, k) => (
          <tr key={k}>
            {r.map((c, i) =>
              i === 0 ? (
                <th key={i} scope="row" className="h-row border-b border-border px-3 pl-card text-left font-medium text-fg">
                  {c}
                </th>
              ) : (
                <td key={i} className={`h-row border-b border-border px-3 last:pr-card ${i >= numericFrom ? 'text-right tabular-nums' : ''}`}>
                  {c}
                </td>
              ),
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const latencyCol = columnHelper<LatencyPoint>();

function Details({ run }: { run: RunResult }) {
  const { t, number, integer, percent, bytes } = useI18n();
  const m = run.metrics;
  const columns = useMemo(
    () => [
      latencyCol.accessor('promptTokens', { header: t('result.details.prompt'), cell: (c) => integer(c.getValue()), meta: { numeric: true } }),
      latencyCol.accessor((p) => p.ttftMs.median, { id: 'ttft', header: `${t('metrics.ttft.label')} (ms)`, cell: (c) => integer(c.getValue()), meta: { numeric: true } }),
      latencyCol.accessor((p) => p.prefillTps.median, { id: 'prefill', header: `${t('metrics.prefill.label')} (tok/s)`, cell: (c) => integer(c.getValue()), meta: { numeric: true } }),
      latencyCol.accessor((p) => p.decodeTps.median, { id: 'decode', header: `${t('metrics.decode.label')} (tok/s)`, cell: (c) => number(c.getValue(), 1), meta: { numeric: true } }),
      latencyCol.accessor((p) => p.decodeTps.min, { id: 'min', header: t('result.details.min'), cell: (c) => number(c.getValue(), 1), meta: { numeric: true } }),
      latencyCol.accessor((p) => p.decodeTps.max, { id: 'max', header: t('result.details.max'), cell: (c) => number(c.getValue(), 1), meta: { numeric: true } }),
      latencyCol.accessor((p) => p.decodeTps.cv, { id: 'cv', header: t('result.details.cv'), cell: (c) => percent(c.getValue(), 1), meta: { numeric: true } }),
      latencyCol.accessor('itlP50Ms', { header: `${t('result.details.itlP50')} (ms)`, cell: (c) => number(c.getValue(), 2), meta: { numeric: true } }),
      latencyCol.accessor('itlP95Ms', { header: `${t('result.details.itlP95')} (ms)`, cell: (c) => number(c.getValue(), 2), meta: { numeric: true } }),
    ],
    [t, number, integer, percent],
  );
  const loadRow = (label: string, s: Stat | undefined) => [
    label,
    s ? number(s.median / 1000, 2) : '–',
    s ? number(s.min / 1000, 2) : '–',
    s ? number(s.max / 1000, 2) : '–',
    s ? percent(s.cv, 1) : '–',
    s ? s.n : '–',
  ];
  const hw = run.hardware;
  const gpu = hw.gpus[0];
  return (
    <div className="flex flex-col gap-section">
      <Card className="overflow-hidden">
        <CardHeader className="pb-3">
          <CardTitle>{t('result.details.latency')}</CardTitle>
        </CardHeader>
        <DataTable caption={t('result.details.latency')} columns={columns} data={m.latency} initialSorting={[{ id: 'promptTokens', desc: false }]} />
      </Card>
      <div className="grid gap-section lg:grid-cols-2">
        <Card className="overflow-hidden">
          <CardHeader className="pb-3">
            <CardTitle>{t('result.details.load')}</CardTitle>
          </CardHeader>
          <SimpleTable
            caption={t('result.details.load')}
            head={[t('result.details.measure'), `${t('result.details.median')} (s)`, t('result.details.min'), t('result.details.max'), t('result.details.cv'), t('result.details.n')]}
            rows={[loadRow(t('result.details.cold'), m.load.coldMs), loadRow(t('result.details.warm'), m.load.warmMs)]}
          />
        </Card>
        <Card className="overflow-hidden">
          <CardHeader className="pb-3">
            <CardTitle>{t('result.details.system')}</CardTitle>
          </CardHeader>
          <SimpleTable
            caption={t('result.details.system')}
            head={[t('result.details.measure'), t('result.details.value')]}
            numericFrom={99}
            rows={[
              [t('result.details.gpu'), `${gpu?.name ?? '–'} · ${integer((gpu?.memoryTotalMiB ?? 0) / 1024)} GB`],
              [t('result.details.driver'), gpu?.driverVersion ?? '–'],
              [t('result.details.cuda'), gpu?.cudaVersion ?? '–'],
              [t('result.details.cpu'), `${hw.cpu.model} · ${hw.cpu.cores}C/${hw.cpu.threads}T`],
              [t('result.details.ram'), bytes(hw.ramBytes)],
              [t('result.details.os'), hw.os.name],
              [t('result.details.powerPlan'), hw.os.powerPlan ?? '–'],
            ]}
          />
        </Card>
      </div>
      <Card className="overflow-hidden">
        <CardHeader className="pb-3">
          <CardTitle>{t('result.details.concurrency')}</CardTitle>
        </CardHeader>
        <SimpleTable
          caption={t('result.details.concurrency')}
          head={[t('result.users'), `${t('result.aggregate')} (tok/s)`, `${t('result.perUser')} (tok/s)`, `${t('result.details.ttftP50')} (ms)`, `${t('result.details.ttftP95')} (ms)`, t('result.details.errors')]}
          rows={m.concurrency.map((c) => [c.level, integer(c.aggregateTps), number(c.perRequestDecodeTpsP50, 1), integer(c.ttftP50Ms), integer(c.ttftP95Ms), c.errors])}
        />
      </Card>
    </div>
  );
}

function KeyValue({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-[200px_1fr] sm:gap-4">
      <dt className="text-sm text-fg-3">{label}</dt>
      <dd className="min-w-0 text-sm break-all text-fg">{children}</dd>
    </div>
  );
}

function Launch({ run }: { run: RunResult }) {
  const { t, integer } = useI18n();
  const navigate = useNavigate();
  const [showCommand, setShowCommand] = useState(true);
  const [serveOpen, setServeOpen] = useState(false);
  const p = run.launch.params;
  // llama.cpp convention: a layer count at or above the model's blocks (or 99 when unknown) means all.
  const allGpu = p.gpuLayers === undefined || p.gpuLayers >= (run.model.facts?.blockCount ?? 99);
  const parts = [
    `${run.engine.name} ${run.engine.version ?? ''}${run.engine.variant ? ` (${run.engine.variant})` : ''}`.trim(),
    `${run.model.displayName} ${run.model.quant ?? ''}`.trim(),
    ...(p.contextSize ? [t('result.launch.context', { n: integer(p.contextSize) })] : []),
    allGpu ? t('result.launch.allGpu') : t('result.launch.layers', { n: p.gpuLayers ?? 0 }),
    ...(p.flashAttention === 'on' ? [t('result.launch.flashAttention')] : []),
  ];
  const address = `http://${run.launch.host}:${run.launch.port}`;
  return (
    <div className="flex flex-col gap-section">
      <Card className="hero-wash">
        <CardContent className="flex flex-col gap-4 p-7 compact:p-5">
          <p className="text-xs font-semibold tracking-wide text-fg-3 uppercase">{t('result.launch.summaryTitle')}</p>
          <p className="text-xl leading-8 font-medium tracking-[-0.01em] text-balance">
            {parts.map((part, i) => (
              <span key={i}>
                {i > 0 && <span className="mx-2 text-fg-3">·</span>}
                {part}
              </span>
            ))}
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button variant="primary" onClick={() => void navigate({ to: '/' })}>
              <RotateCcw aria-hidden />
              {t('result.launch.rerun')}
            </Button>
            <Button
              onClick={() => {
                toast.success(t('result.launch.appliedToast'));
                void navigate({ to: '/' });
              }}
            >
              <SlidersHorizontal aria-hidden />
              {t('result.launch.useSettings')}
            </Button>
            <Button variant="outline" onClick={() => setServeOpen(true)}>
              <Server aria-hidden />
              {t('result.launch.serveOnly')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Collapsible.Root open={showCommand} onOpenChange={setShowCommand}>
        <Card className="overflow-hidden">
          <Collapsible.Trigger asChild>
            <button type="button" className="flex w-full items-center justify-between px-card py-3.5 text-left hover:bg-surface-2/60 focus-ring">
              <span className="text-md font-semibold">{showCommand ? t('result.launch.hideCommand') : t('result.launch.showCommand')}</span>
              <ChevronDown aria-hidden className={`size-4 text-fg-3 transition-transform ${showCommand ? 'rotate-180' : ''}`} />
            </button>
          </Collapsible.Trigger>
          <Collapsible.Content className="px-card pb-card">
            <CodeBlock commands={run.launch.display} label={t('result.launch.showCommand')} />
          </Collapsible.Content>
        </Card>
      </Collapsible.Root>

      <Card>
        <dl className="divide-y divide-border px-card py-1">
          <KeyValue label={t('result.launch.executable')}>
            <code className="font-mono text-xs">{run.launch.argv[0]}</code>
          </KeyValue>
          <KeyValue label={t('result.launch.build')}>
            {run.engine.name} {run.engine.build} · {run.engine.variant}
          </KeyValue>
          <KeyValue label={t('result.launch.env')}>
            <code className="font-mono text-xs">
              {Object.entries(run.launch.env)
                .map(([k, v]) => `${k}=${v}`)
                .join('  ') || t('common.none')}
            </code>
          </KeyValue>
          <KeyValue label={t('result.launch.cwd')}>
            <code className="font-mono text-xs">{run.launch.cwd}</code>
          </KeyValue>
          <KeyValue label={t('result.launch.address')}>
            <code className="font-mono text-xs">{address}</code>
          </KeyValue>
          <KeyValue label={t('result.launch.request')}>
            <pre className="overflow-x-auto rounded-md bg-surface-2 p-3 font-mono text-xs leading-5 text-fg-2">{JSON.stringify(run.launch.requestExample, null, 2)}</pre>
          </KeyValue>
        </dl>
      </Card>

      <Dialog open={serveOpen} onOpenChange={setServeOpen}>
        <DialogContent
          title={t('result.launch.serveTitle')}
          description={t('result.launch.serveBody')}
          footer={
            <>
              <DialogClose asChild>
                <Button>{t('common.cancel')}</Button>
              </DialogClose>
              <DialogClose asChild>
                <Button variant="primary">
                  <Play aria-hidden />
                  {t('result.launch.serveStart')}
                </Button>
              </DialogClose>
            </>
          }
        >
          <div className="flex items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-2">
            <Globe aria-hidden className="size-4 text-fg-3" />
            <code className="flex-1 font-mono text-sm">{address}/v1</code>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void navigator.clipboard.writeText(`${address}/v1`).then(() => toast.success(t('common.copied')))}
            >
              <Copy aria-hidden />
              {t('common.copy')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ExportMenu() {
  const { t } = useI18n();
  const items = [
    { key: 'csvIt', icon: <FileSpreadsheet /> },
    { key: 'csv', icon: <FileSpreadsheet /> },
    { key: 'json', icon: <FileJson /> },
    { key: 'markdown', icon: <FileText /> },
    { key: 'html', icon: <Globe /> },
  ] as const;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button>
          <Upload aria-hidden />
          {t('result.export.label')}
          <ChevronDown aria-hidden className="text-fg-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {items.map((i) => (
          <DropdownMenuItem key={i.key} onSelect={() => toast.success(t('result.export.done', { format: t(`result.export.${i.key}`) }))}>
            {i.icon}
            {t(`result.export.${i.key}`)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** One benchmark explained: score, plain-language sentence, KPIs, charts, launch command. */
export function ResultPage() {
  const { runId } = useParams({ from: '/results/$runId' });
  const { t, dateTime } = useI18n();
  const query = useRun(runId);
  const run = query.data;

  if (!run) {
    return (
      <div className="mx-auto flex max-w-[1240px] flex-col gap-4 px-8 pt-8">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <Page
      eyebrow={
        <Link to="/results" className="inline-flex items-center gap-1.5 self-start rounded-xs text-sm text-fg-2 hover:text-fg focus-ring">
          <ArrowLeft aria-hidden className="size-4" />
          {t('result.back')}
        </Link>
      }
      title={
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {run.model.displayName}
          <span className="font-normal text-fg-3">{run.model.quant}</span>
          <Badge tone={statusTone[run.status]} dot className="translate-y-[1px]">
            {t(`result.status.${run.status}`)}
          </Badge>
        </span>
      }
      subtitle={
        <span className="flex flex-wrap items-center gap-x-2 text-sm text-fg-2">
          <span>
            {run.engine.name} {run.engine.version} ({run.engine.variant})
          </span>
          <span aria-hidden className="text-fg-3">·</span>
          <span>{run.hardware.gpus[0]?.name}</span>
          <span aria-hidden className="text-fg-3">·</span>
          <span>{dateTime(run.createdAt)}</span>
          <span aria-hidden className="text-fg-3">·</span>
          <span>{t(`benchmark.profiles.${run.scenario.profile}`)}</span>
        </span>
      }
      actions={
        <>
          <Button asChild>
            <Link to="/compare">
              <GitCompareArrows aria-hidden />
              {t('common.compare')}
            </Link>
          </Button>
          <ExportMenu />
        </>
      }
    >
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">{t('result.tabs.overview')}</TabsTrigger>
          <TabsTrigger value="details">{t('result.tabs.details')}</TabsTrigger>
          <TabsTrigger value="launch">{t('result.tabs.launch')}</TabsTrigger>
          <TabsTrigger value="log">{t('result.tabs.log')}</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <Overview run={run} />
        </TabsContent>
        <TabsContent value="details">
          <Details run={run} />
        </TabsContent>
        <TabsContent value="launch">
          <Launch run={run} />
        </TabsContent>
        <TabsContent value="log">
          <Card className="overflow-hidden">
            <CardHeader className="pb-3">
              <CardTitle>{t('result.log.title')}</CardTitle>
            </CardHeader>
            <pre role="region" tabIndex={0} aria-label={t('result.log.title')} className="max-h-[480px] overflow-auto border-t border-border bg-surface-2 px-card py-3 font-mono text-[12px] leading-5 text-fg-2 focus-ring">
              {run.logExcerpt}
            </pre>
          </Card>
        </TabsContent>
      </Tabs>
    </Page>
  );
}
