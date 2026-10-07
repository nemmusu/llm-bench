/**
 * Speed as the context fills up: one line per launch configuration over the depths (1K, 4K, 8K…),
 * evenly spaced like the grid they come from. A line stops where its configuration stops.
 */
import { axisStyle, type ChartOption, type ChartTokens } from './echarts';

export interface DepthSeries {
  name: string;
  /** One value per depth (null = not measured there). */
  values: readonly (number | null)[];
  /** Drawn thicker (the recommended configuration). */
  emphasis?: boolean;
}

export interface DepthLinesOpts {
  /** Tooltip value, e.g. "91,2 tok/s". */
  format: (v: number) => string;
  /** Axis value, e.g. "91". */
  axis?: (v: number) => string;
  /** Depth label, e.g. "32K". */
  depthLabel: (depth: number) => string;
  xName: string;
  /** Depth to mark with a vertical line (the compared one). */
  marker?: number;
}

export function depthLinesOption(tk: ChartTokens, depths: readonly number[], series: readonly DepthSeries[], o: DepthLinesOpts): ChartOption {
  const ax = axisStyle(tk);
  const many = series.length > 1;
  const markerAt = o.marker === undefined ? -1 : depths.indexOf(o.marker);
  return {
    grid: { left: 8, right: 16, top: many ? 40 : 16, bottom: 8, outerBoundsMode: 'same', outerBoundsContain: 'axisLabel' },
    ...(many
      ? {
          legend: {
            type: 'scroll' as const,
            top: 0,
            left: 0,
            right: 0,
            icon: 'roundRect',
            itemWidth: 14,
            itemHeight: 3,
            textStyle: { color: tk.fg2, fontSize: 12 },
            pageTextStyle: { color: tk.fg3 },
            pageIconColor: tk.fg2,
            pageIconInactiveColor: tk.axis,
          },
        }
      : {}),
    tooltip: { trigger: 'axis', valueFormatter: (v) => (v === null || v === undefined ? '–' : o.format(Number(v))) },
    xAxis: {
      type: 'category',
      data: depths.map(o.depthLabel),
      boundaryGap: false,
      ...ax,
      splitLine: { show: false },
      name: o.xName,
      nameLocation: 'middle',
      nameGap: 28,
    },
    yAxis: { type: 'value', min: 0, ...ax, axisLine: { show: false }, splitNumber: 4, axisLabel: { ...ax.axisLabel, formatter: (v: number) => (o.axis ?? String)(v) } },
    series: series.map((s, i) => {
      const color = tk.series[i % tk.series.length]!;
      return {
        type: 'line' as const,
        name: s.name,
        data: [...s.values],
        connectNulls: false,
        symbol: 'circle',
        symbolSize: s.emphasis ? 8 : 6,
        lineStyle: { width: s.emphasis ? 2.75 : 1.75, color, type: i >= tk.series.length ? ('dashed' as const) : ('solid' as const) },
        itemStyle: { color, borderColor: tk.surface, borderWidth: 1.5 },
        emphasis: { focus: 'series' as const },
        ...(i === 0 && markerAt >= 0
          ? {
              markLine: {
                silent: true,
                symbol: 'none',
                lineStyle: { color: tk.fg3, type: 'dashed' as const, width: 1 },
                label: { show: false },
                data: [{ xAxis: markerAt }],
              },
            }
          : {}),
      };
    }),
  };
}
