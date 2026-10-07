import { useCallback, useMemo, useState } from 'react';
import type { EngineKind } from '../../../contract/engines';
import { nominalDepth, type Tuning } from '../../../contract/results';
import { useI18n } from '../../i18n';
import { prefillStat } from '../bench/format';
import { ChartCard } from '../charts/chart-card';
import { depthLinesOption } from '../charts/depth-lines';
import { EChart } from '../charts/echart';
import type { ChartTokens } from '../charts/echarts';
import { useConfigLabel } from '../presets/config-label';
import { Button } from '../ui/button';
import { SegmentedControl } from '../ui/segmented-control';
import { comboText, depthLabel } from './tune-format';
import { measuredCombinations, pointAt } from './tune-logic';

/** Lines shown before "Mostra tutte". */
export const TOP_LINES = 5;

export interface TuneChartProps {
  tuning: Pick<Tuning, 'combinations'>;
  engineKind: EngineKind;
  /** Combination indexes in ranking order (the first TOP_LINES are drawn by default). */
  order?: readonly number[];
  /** Drawn thicker. */
  recommended?: number;
  /** Depth marked with a vertical line. */
  marker?: number;
  title: string;
  help: string;
}

/** Generation (or prompt reading) speed against how full the context is, one line per combination. */
export function TuneChart({ tuning, engineKind, order, recommended, marker, title, help }: TuneChartProps) {
  const f = useI18n();
  const { t, number, integer } = f;
  const label = useConfigLabel();
  const [metric, setMetric] = useState<'decode' | 'prefill'>('decode');
  const [all, setAll] = useState(false);
  const ids = useMemo(() => order ?? measuredCombinations(tuning), [order, tuning]);
  const { depths, series } = useMemo(() => {
    const shown = all ? ids : ids.slice(0, TOP_LINES);
    const ds = [...new Set(shown.flatMap((i) => tuning.combinations[i]!.sweep.map((p) => nominalDepth(p.promptTokens))))].sort((a, b) => a - b);
    return {
      depths: ds,
      series: shown.map((i) => ({
        name: comboText(tuning.combinations[i]!, engineKind, label),
        emphasis: i === recommended,
        values: ds.map((d) => {
          const p = pointAt(tuning.combinations[i]!, d);
          return p === undefined ? null : metric === 'decode' ? p.decodeTps.median : prefillStat(p).median;
        }),
      })),
    };
  }, [all, ids, tuning, engineKind, label, recommended, metric]);
  const fmt = useCallback((v: number) => (metric === 'decode' ? number(v, 1) : integer(v)), [metric, number, integer]);
  const build = useCallback(
    (tk: ChartTokens) =>
      depthLinesOption(tk, depths, series, {
        format: (v) => `${fmt(v)} tok/s`,
        axis: integer,
        depthLabel: (d) => depthLabel(d, f),
        xName: t('tune.chart.depth'),
        ...(marker === undefined ? {} : { marker }),
      }),
    [depths, series, fmt, integer, f, t, marker],
  );
  const metricLabel = t(metric === 'decode' ? 'metrics.decode.label' : 'metrics.prefill.label');
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
        rows: series.map((s) => [s.name, ...s.values.map((v) => (v === null ? '–' : fmt(v)))]),
      }}
    >
      {/* Only drawn once a combination was measured: there is always a depth. */}
      <EChart build={build} height={300} label={title} />
    </ChartCard>
  );
}
