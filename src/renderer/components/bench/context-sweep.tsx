/** "Velocità al crescere del contesto": the context sweep of a run, as a chart and as tables. */
import { useCallback, useState } from 'react';
import { nominalDepth, type LatencyPoint } from '../../../contract/results';
import { useI18n } from '../../i18n';
import { ChartCard } from '../charts/chart-card';
import { depthLinesOption } from '../charts/depth-lines';
import { EChart } from '../charts/echart';
import type { ChartTokens } from '../charts/echarts';
import { SegmentedControl } from '../ui/segmented-control';
import { depthLabel } from '../tune/tune-format';
import { prefillStat } from './format';
import { MeasureTable, type MeasureColumn } from './measure-table';

const byDepth = (points: readonly LatencyPoint[]) => [...points].sort((a, b) => a.promptTokens - b.promptTokens);

/** Generation (or prompt reading) speed at each depth, with the numbers behind "Mostra tabella". */
export function ContextSweepChart({ points }: { points: readonly LatencyPoint[] }) {
  const f = useI18n();
  const { t, number, integer } = f;
  const [metric, setMetric] = useState<'decode' | 'prefill'>('decode');
  const sorted = byDepth(points);
  const title = t('result.sweep.title');
  const build = useCallback(
    (tk: ChartTokens) =>
      depthLinesOption(
        tk,
        sorted.map((p) => nominalDepth(p.promptTokens)),
        [{ name: t(metric === 'decode' ? 'metrics.decode.label' : 'metrics.prefill.label'), values: sorted.map((p) => (metric === 'decode' ? p.decodeTps.median : prefillStat(p).median)) }],
        {
          format: (v) => `${metric === 'decode' ? number(v, 1) : integer(v)} tok/s`,
          axis: integer,
          depthLabel: (d) => depthLabel(d, f),
          xName: t('tune.chart.depth'),
        },
      ),
    [sorted, metric, t, number, integer, f],
  );
  return (
    <ChartCard
      title={title}
      help={t('result.sweep.help')}
      controls={
        <SegmentedControl
          size="sm"
          label={title}
          value={metric}
          onValueChange={setMetric}
          options={[
            { value: 'decode', label: t('metrics.decode.label') },
            { value: 'prefill', label: t('metrics.prefill.label') },
          ]}
        />
      }
      table={{
        columns: [t('tune.measures.depth'), t('tune.columns.prefill'), t('tune.measures.ttftMs'), t('tune.columns.decode'), t('tune.measures.n')],
        numeric: [0, 1, 2, 3, 4],
        rows: sorted.map((p) => [integer(p.promptTokens), integer(prefillStat(p).median), integer(p.ttftMs.median), number(p.decodeTps.median, 1), p.decodeTps.n]),
      }}
    >
      <EChart build={build} height={260} label={title} />
    </ChartCard>
  );
}

/** Every depth: prompt reading, first token, generation (engine figure when it reports one), pauses, repetitions, spread. */
export function SweepTable({ caption, points, framed }: { caption: string; points: readonly LatencyPoint[]; framed?: boolean }) {
  const f = useI18n();
  const { t, number, integer } = f;
  const engine = points.some((p) => p.decodeTpsEngine !== undefined);
  const columns: MeasureColumn[] = [
    { label: t('tune.measures.depth') },
    { label: t('tune.columns.prefill'), numeric: true },
    { label: t('tune.measures.ttftMs'), numeric: true },
    { label: t('tune.columns.decode'), numeric: true },
    ...(engine ? [{ label: t('tune.measures.decodeEngine'), numeric: true }] : []),
    { label: t('tune.measures.itlP50'), numeric: true },
    { label: t('tune.measures.itlP95'), numeric: true },
    { label: t('tune.measures.n'), numeric: true },
    { label: t('tune.measures.cv'), numeric: true },
  ];
  return (
    <MeasureTable
      caption={caption}
      framed={framed}
      columns={columns}
      rows={byDepth(points).map((p) => ({
        key: p.promptTokens,
        cells: [
          <span key="d" title={integer(p.promptTokens)}>
            {depthLabel(nominalDepth(p.promptTokens), f)}
          </span>,
          integer(prefillStat(p).median),
          integer(p.ttftMs.median),
          number(p.decodeTps.median, 1),
          ...(engine ? [p.decodeTpsEngine ? number(p.decodeTpsEngine.median, 1) : '–'] : []),
          number(p.itlP50Ms, 1),
          number(p.itlP95Ms, 1),
          p.decodeTps.n,
          number(p.decodeTps.cv * 100, 1),
        ],
      }))}
    />
  );
}
