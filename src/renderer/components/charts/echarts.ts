/**
 * ECharts with only the pieces we use (keeps the bundle small) plus a theme built from the
 * live CSS tokens, so charts follow light/dark exactly like the rest of the UI.
 */
import { BarChart, LineChart, type BarSeriesOption, type LineSeriesOption } from 'echarts/charts';
import {
  AxisPointerComponent,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TooltipComponent,
  type GridComponentOption,
  type LegendComponentOption,
  type MarkAreaComponentOption,
  type MarkLineComponentOption,
  type TooltipComponentOption,
} from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
  LineChart,
  BarChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  DataZoomComponent,
  AxisPointerComponent,
  CanvasRenderer,
]);

export { echarts };

export type ChartOption = echarts.ComposeOption<
  | LineSeriesOption
  | BarSeriesOption
  | GridComponentOption
  | TooltipComponentOption
  | LegendComponentOption
  | MarkAreaComponentOption
  | MarkLineComponentOption
>;

export interface ChartTokens {
  font: string;
  fg: string;
  fg2: string;
  fg3: string;
  surface: string;
  elevated: string;
  border: string;
  grid: string;
  axis: string;
  band: string;
  bandAlt: string;
  series: string[];
  accent2: string;
}

/** Reads the chart-related CSS variables currently applied to <html>. */
export function readChartTokens(doc: Document = document): ChartTokens {
  const css = getComputedStyle(doc.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    font: "'Inter Variable', system-ui, sans-serif",
    fg: v('--fg', '#0e1117'),
    fg2: v('--fg-2', '#4b5263'),
    fg3: v('--fg-3', '#646b7c'),
    surface: v('--surface', '#ffffff'),
    elevated: v('--elevated', '#ffffff'),
    border: v('--border', '#e5e7ed'),
    grid: v('--chart-grid', '#eceef2'),
    axis: v('--chart-axis', '#d3d7e0'),
    band: v('--chart-band', 'rgba(99,85,232,0.06)'),
    bandAlt: v('--chart-band-alt', 'rgba(14,17,23,0.025)'),
    series: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => v(`--chart-${i}`, '#6355e8')),
    accent2: v('--accent-2', '#0ea5b7'),
  };
}

/**
 * Base option every chart starts from: recessive hairline grid, muted axis text, one tooltip
 * style. Callers merge their series/axes on top.
 */
export function baseOption(tk: ChartTokens, animate: boolean): ChartOption {
  return {
    animation: animate,
    animationDuration: 500,
    animationDurationUpdate: 300,
    color: tk.series,
    textStyle: { fontFamily: tk.font, color: tk.fg2, fontSize: 12 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: tk.elevated,
      borderColor: tk.border,
      borderWidth: 1,
      padding: [8, 12],
      textStyle: { color: tk.fg, fontFamily: tk.font, fontSize: 12 },
      extraCssText: 'border-radius:8px;box-shadow:0 8px 24px -6px rgba(0,0,0,.25);',
      axisPointer: { type: 'line', lineStyle: { color: tk.axis, width: 1 } },
    },
  };
}

/** Shared axis styling (hairline, solid, recessive). */
export function axisStyle(tk: ChartTokens) {
  return {
    axisLine: { lineStyle: { color: tk.axis } },
    axisTick: { show: false },
    axisLabel: { color: tk.fg3, fontSize: 11, fontFamily: tk.font },
    splitLine: { lineStyle: { color: tk.grid, width: 1, type: 'solid' as const } },
    nameTextStyle: { color: tk.fg3, fontSize: 11, fontFamily: tk.font },
  };
}
