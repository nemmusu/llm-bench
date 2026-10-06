/** Two runs on one chart: grouped bars per prompt length, two lines per number of users. */
import type { RunResult } from '../../../contract/results';
import { axisStyle, type ChartOption, type ChartTokens } from '../charts/echarts';

export interface PairSeries {
  x: number[];
  a: (number | null)[];
  b: (number | null)[];
}

/** Aligns two runs' points on the union of their x values (missing → null). */
export function alignPairs<T>(a: readonly T[], b: readonly T[], x: (p: T) => number, y: (p: T) => number): PairSeries {
  const xs = [...new Set([...a.map(x), ...b.map(x)])].sort((m, n) => m - n);
  const at = (list: readonly T[], v: number) => {
    const p = list.find((q) => x(q) === v);
    return p === undefined ? null : y(p);
  };
  return { x: xs, a: xs.map((v) => at(a, v)), b: xs.map((v) => at(b, v)) };
}

export function decodePairs(a: Pick<RunResult, 'metrics'>, b: Pick<RunResult, 'metrics'>): PairSeries {
  return alignPairs(a.metrics.latency, b.metrics.latency, (p) => p.promptTokens, (p) => p.decodeTps.median);
}

export function concurrencyPairs(a: Pick<RunResult, 'metrics'>, b: Pick<RunResult, 'metrics'>): PairSeries {
  return alignPairs(a.metrics.concurrency, b.metrics.concurrency, (p) => p.level, (p) => p.aggregateTps);
}

interface PairOpts {
  nameA: string;
  nameB: string;
  format: (v: number) => string;
  xLabel: (v: number) => string;
  xName: string;
}

const legend = (tk: ChartTokens, o: PairOpts) => ({
  top: 0,
  left: 0,
  icon: 'roundRect',
  itemWidth: 14,
  itemHeight: 8,
  textStyle: { color: tk.fg2, fontSize: 12 },
  data: [o.nameA, o.nameB],
});

/** Grouped bars: A and B side by side for each category. */
export function pairBarsOption(tk: ChartTokens, s: PairSeries, o: PairOpts): ChartOption {
  const ax = axisStyle(tk);
  const bar = (name: string, data: (number | null)[], color: string) => ({
    type: 'bar' as const,
    name,
    data,
    barMaxWidth: 22,
    itemStyle: { color, borderRadius: [4, 4, 0, 0] },
  });
  return {
    grid: { left: 8, right: 8, top: 36, bottom: 8, outerBoundsMode: 'same', outerBoundsContain: 'axisLabel' },
    legend: legend(tk, o),
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: tk.band } }, valueFormatter: (v) => (v === null || v === undefined ? '–' : o.format(Number(v))) },
    xAxis: { type: 'category', data: s.x.map(o.xLabel), ...ax, splitLine: { show: false }, name: o.xName, nameLocation: 'middle', nameGap: 28 },
    yAxis: { type: 'value', ...ax, axisLine: { show: false }, splitNumber: 4 },
    series: [bar(o.nameA, s.a, tk.series[0]!), bar(o.nameB, s.b, tk.series[1]!)],
  };
}

/** Two lines over the same x values (gaps where a run has no point). */
export function pairLinesOption(tk: ChartTokens, s: PairSeries, o: PairOpts): ChartOption {
  const ax = axisStyle(tk);
  const line = (name: string, data: (number | null)[], color: string) => ({
    type: 'line' as const,
    name,
    data: s.x.map((x, i) => [x, data[i] ?? null]),
    connectNulls: true,
    symbol: 'circle',
    symbolSize: 8,
    lineStyle: { width: 2, color },
    itemStyle: { color, borderColor: tk.surface, borderWidth: 2 },
  });
  return {
    grid: { left: 8, right: 16, top: 36, bottom: 8, outerBoundsMode: 'same', outerBoundsContain: 'axisLabel' },
    legend: legend(tk, o),
    tooltip: { trigger: 'axis', valueFormatter: (v) => (v === null || v === undefined ? '–' : o.format(Number(v))) },
    xAxis: {
      type: 'log',
      logBase: 2,
      min: s.x[0],
      max: s.x[s.x.length - 1],
      ...ax,
      splitLine: { show: false },
      axisLabel: { ...ax.axisLabel, formatter: (v: number) => o.xLabel(v) },
      name: o.xName,
      nameLocation: 'middle',
      nameGap: 26,
    },
    yAxis: { type: 'value', min: 0, ...ax, axisLine: { show: false }, splitNumber: 4 },
    series: [line(o.nameA, s.a, tk.series[0]!), line(o.nameB, s.b, tk.series[1]!)],
  };
}
