import { useCallback, useMemo, useState } from 'react';
import type { EngineKind } from '../../../contract/engines';
import { fullContextPoint, nominalDepth, type LatencyPoint, type Tuning } from '../../../contract/results';
import { useI18n } from '../../i18n';
import { axisName, tooltipHead } from '../../lib/speed-at';
import { prefillStat } from '../bench/format';
import { ChartCard } from '../charts/chart-card';
import { depthLinesOption } from '../charts/depth-lines';
import { EChart } from '../charts/echart';
import type { ChartTokens } from '../charts/echarts';
import { useConfigLabel } from '../presets/config-label';
import { Button } from '../ui/button';
import { SegmentedControl } from '../ui/segmented-control';
import { comboText, depthLabel } from './tune-format';
import { drawnPoints, measuredCombinations } from './tune-logic';

/** Lines shown before "Mostra tutte". */
export const TOP_LINES = 5;

export interface TuneChartProps {
  tuning: Pick<Tuning, 'combinations'>;
  engineKind: EngineKind;
  /** Combination indexes in ranking order (the first TOP_LINES are drawn by default). */
  order?: readonly number[];
  /** Drawn thicker. */
  recommended?: number;
  /** Depth marked with a vertical line (the ranking's compared depth; none when each is read at its own context). */
  marker?: number;
  title: string;
  help: string;
}

/** One combination's value at one depth: the number, and how the tooltip and the table say it. */
interface Cell {
  value: number | null;
  /** Tooltip text instead of the plain value (undefined = the value). */
  tip: string | undefined;
  table: string;
}

/**
 * Generation (or prompt reading) speed against how full the context is, one line per combination. Each
 * line ends at its own context, the point with the context full drawn there (its exact tokens in the
 * tooltip and the table); the axis reaches the largest context of the lines shown, and where a line's
 * context reaches a depth it was not measured at, the tooltip says "non misurata".
 */
export function TuneChart({ tuning, engineKind, order, recommended, marker, title, help }: TuneChartProps) {
  const f = useI18n();
  const { t, number, integer } = f;
  const label = useConfigLabel();
  const [metric, setMetric] = useState<'decode' | 'prefill'>('decode');
  const [all, setAll] = useState(false);
  const ids = useMemo(() => order ?? measuredCombinations(tuning), [order, tuning]);
  const fmt = useCallback((v: number) => (metric === 'decode' ? number(v, 1) : integer(v)), [metric, number, integer]);
  const { depths, series } = useMemo(() => {
    const shown = ids.slice(0, all ? ids.length : TOP_LINES).map((i) => {
      const combo = tuning.combinations[i]!;
      return { i, combo, points: drawnPoints(combo), full: fullContextPoint(combo), context: nominalDepth(combo.maxContext) };
    });
    const ds = [...new Set(shown.flatMap((s) => [...s.points.keys(), s.context]))].sort((a, b) => a - b);
    const valueOf = (p: LatencyPoint) => (metric === 'decode' ? p.decodeTps.median : prefillStat(p).median);
    return {
      depths: ds,
      series: shown.map((s) => {
        const cells = ds.map((d): Cell => {
          const p = s.points.get(d);
          if (p === undefined) {
            // Past its context it has nothing to measure; within it, nothing was measured there.
            const blank = d > s.context ? t('tune.ranking.reachesOnly', { depth: depthLabel(s.combo.maxContext, f) }) : t('tune.chart.notMeasured');
            return { value: null, tip: blank, table: blank };
          }
          const v = valueOf(p);
          if (p !== s.full) return { value: v, tip: undefined, table: fmt(v) };
          const tokens = integer(p.promptTokens);
          return { value: v, tip: t('tune.chart.full', { value: `${fmt(v)} tok/s`, tokens }), table: t('tune.chart.full', { value: fmt(v), tokens }) };
        });
        return {
          name: comboText(s.combo, engineKind, label),
          emphasis: s.i === recommended,
          values: cells.map((c) => c.value),
          texts: cells.map((c) => c.tip),
          table: cells.map((c) => c.table),
        };
      }),
    };
  }, [all, ids, tuning, engineKind, label, recommended, metric, fmt, integer, t, f]);
  const metricLabel = t(metric === 'decode' ? 'metrics.decode.label' : 'metrics.prefill.label');
  const build = useCallback(
    (tk: ChartTokens) =>
      depthLinesOption(tk, depths, series, {
        format: (v) => `${fmt(v)} tok/s`,
        axis: integer,
        depthLabel: (d) => depthLabel(d, f),
        xName: axisName('depth', f),
        // "a 32.768 token di contesto · Generazione", then one line per combination.
        tooltipHead: (d) => `${tooltipHead(d, 'depth', f)} · ${metricLabel}`,
        // A line goes on across depths it was not measured at (the dots mark what was).
        connectNulls: true,
        ...(marker === undefined ? {} : { marker }),
      }),
    [depths, series, fmt, integer, f, marker, metricLabel],
  );
  return (
    <ChartCard
      title={title}
      help={help}
      controls={
        <>
          {ids.length > TOP_LINES && (
            <Button size="sm" variant="ghost" onClick={() => setAll((v) => !v)}>
              {all ? t('tune.chart.top', { n: TOP_LINES }) : t('tune.chart.all', { n: ids.length })}
            </Button>
          )}
          <SegmentedControl
            size="sm"
            label={t('tune.chart.metric')}
            value={metric}
            onValueChange={setMetric}
            options={[
              { value: 'decode', label: t('metrics.decode.label') },
              { value: 'prefill', label: t('metrics.prefill.label') },
            ]}
          />
        </>
      }
      table={{
        columns: [t('tune.columns.settings'), ...depths.map((d) => `${metricLabel} ${depthLabel(d, f)} (tok/s)`)],
        numeric: depths.map((_, k) => k + 1),
        rows: series.map((s) => [s.name, ...s.table]),
      }}
    >
      {/* Only drawn once a combination was measured: there is always a depth. */}
      <EChart build={build} height={300} label={title} />
    </ChartCard>
  );
}
