/**
 * Option builders for the app's charts. They follow the dataviz rules: one y-scale per plot
 * (different units become small multiples), thin marks, hairline grid, legend only for ≥2 series,
 * categorical colors in fixed order.
 */
import { axisStyle, type ChartOption, type ChartTokens } from './echarts';
import { tooltipSentence, type AxisParam } from './tooltip';

export interface PhaseBand {
  start: number;
  end: number;
  label: string;
}

export interface TimelineSeries {
  name: string;
  /** Unit shown next to the panel name, e.g. "W". */
  unit?: string;
  values: (number | null)[];
  /** Formats a value for the tooltip and axis (e.g. "420 W"). */
  format: (v: number) => string;
  max?: number;
}

/** "m:ss" for a number of seconds (axis labels). */
export function mmss(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Time series stacked as small multiples sharing one x-axis, with phase bands behind them. */
export function timelineOption(
  tk: ChartTokens,
  t: readonly number[],
  series: readonly TimelineSeries[],
  bands: readonly PhaseBand[],
  opts: { rowHeight?: number; gap?: number; xMax?: number } = {},
): ChartOption {
  const rowH = opts.rowHeight ?? 64;
  const gap = opts.gap ?? 40;
  const top = 34;
  const ax = axisStyle(tk);
  const xMax = opts.xMax ?? t[t.length - 1] ?? 0;
  return {
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    tooltip: {
      trigger: 'axis',
      formatter: (params: unknown) => {
        const list = params as { seriesIndex: number; data: [number, number | null] }[];
        const x = list[0]?.data[0] ?? 0;
        const band = bands.find((b) => x >= b.start && x < b.end);
        const head = `<div style="font-weight:600;margin-bottom:4px">${mmss(x)}${band ? ` · ${band.label}` : ''}</div>`;
        const rows = list
          .map((p) => {
            const s = series[p.seriesIndex]!;
            const v = p.data[1];
            return `<div style="display:flex;gap:12px;justify-content:space-between"><span style="color:${tk.fg2}">${s.name}</span><b>${v === null ? '–' : s.format(v)}</b></div>`;
          })
          .join('');
        return head + rows;
      },
    },
    grid: series.map((_, i) => ({ left: 52, right: 16, top: top + i * (rowH + gap), height: rowH, outerBoundsMode: 'none' as const })),
    xAxis: series.map((_, i) => ({
      type: 'value' as const,
      gridIndex: i,
      min: 0,
      max: xMax,
      ...ax,
      splitLine: { show: false },
      axisLabel: { ...ax.axisLabel, show: i === series.length - 1, formatter: (v: number) => mmss(v) },
      axisLine: { lineStyle: { color: tk.axis } },
    })),
    yAxis: series.map((s, i) => ({
      type: 'value' as const,
      gridIndex: i,
      min: 0,
      // Two clean intervals (0 / half / max) keep each small panel readable.
      ...(s.max === undefined ? { splitNumber: 2 } : { max: s.max, interval: s.max / 2 }),
      ...ax,
      axisLine: { show: false },
      axisLabel: { ...ax.axisLabel, formatter: (v: number) => String(Math.round(v)) },
      name: s.unit ? `${s.name} (${s.unit})` : s.name,
      nameLocation: 'end' as const,
      nameGap: 12,
      nameTextStyle: { ...ax.nameTextStyle, align: 'left' as const, fontWeight: 600, color: tk.fg2, padding: [0, 0, 0, -44] },
    })),
    series: series.map((s, i) => ({
      type: 'line' as const,
      name: s.name,
      xAxisIndex: i,
      yAxisIndex: i,
      data: t.map((x, k) => [x, s.values[k] ?? null]),
      showSymbol: false,
      sampling: 'lttb' as const,
      lineStyle: { width: 1.75, color: tk.series[0] },
      itemStyle: { color: tk.series[0] },
      areaStyle: { color: tk.series[0], opacity: 0.08 },
      emphasis: { disabled: true },
      markArea: {
        silent: true,
        data: bands.map((b, k) => [
          {
            xAxis: b.start,
            itemStyle: { color: k % 2 ? tk.bandAlt : tk.band },
            label: {
              show: i === 0,
              position: 'insideTop' as const,
              distance: -18,
              color: tk.fg3,
              fontSize: 10.5,
              fontFamily: tk.font,
              formatter: b.end - b.start >= xMax * 0.06 ? b.label : '',
            },
          },
          { xAxis: b.end },
        ]),
      },
    })),
  };
}

/** Single-series vertical bars over categories (thin bars, rounded data end). */
export function barOption(
  tk: ChartTokens,
  categories: readonly string[],
  values: readonly number[],
  opts: {
    name: string;
    format: (v: number) => string;
    xName?: string;
    axis?: (v: number) => string;
    /** The tooltip as one sentence for a category ("prompt da 512 token: scrittura 54,6 tok/s, lettura 2.244 tok/s"). */
    tooltipText?: (index: number) => string;
  },
): ChartOption {
  const ax = axisStyle(tk);
  const peak = Math.max(...values);
  const text = opts.tooltipText;
  return {
    grid: { left: 8, right: 8, top: 28, bottom: 8, outerBoundsMode: 'same', outerBoundsContain: 'all' },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow', shadowStyle: { color: tk.band } },
      ...(text
        ? { formatter: (params: unknown) => tooltipSentence(text((params as AxisParam[])[0]!.dataIndex)) }
        : { valueFormatter: (v: unknown) => opts.format(Number(v)) }),
    },
    xAxis: {
      type: 'category',
      data: [...categories],
      ...ax,
      splitLine: { show: false },
      ...(opts.xName ? { name: opts.xName, nameLocation: 'middle' as const, nameGap: 28 } : {}),
    },
    yAxis: { type: 'value', ...ax, axisLine: { show: false }, splitNumber: 4, axisLabel: { ...ax.axisLabel, formatter: (v: number) => (opts.axis ?? String)(v) } },
    series: [
      {
        type: 'bar',
        name: opts.name,
        data: values.map((v) => ({
          value: v,
          // Direct label only on the peak (selective labelling).
          label: { show: v === peak, position: 'top' as const, color: tk.fg2, fontSize: 11, formatter: () => opts.format(v) },
        })),
        barMaxWidth: 24,
        itemStyle: { color: tk.series[0], borderRadius: [4, 4, 0, 0] },
        emphasis: { itemStyle: { color: tk.series[0], opacity: 0.85 } },
      },
    ],
  };
}

/** Two series over the same unit (tok/s) vs concurrent users. */
export function concurrencyOption(
  tk: ChartTokens,
  levels: readonly number[],
  aggregate: readonly number[],
  perUser: readonly number[],
  opts: {
    aggregateName: string;
    perUserName: string;
    format: (v: number) => string;
    xName: string;
    axis?: (v: number) => string;
    /** The slowest users (p5 of the per-request rates), dashed under the per-user line; null where unknown. */
    slowest?: { name: string; values: readonly (number | null)[] };
  },
): ChartOption {
  const ax = axisStyle(tk);
  const line = (name: string, data: readonly (number | null)[], color: string, endLabel: boolean, dashed = false) => ({
    type: 'line' as const,
    name,
    data: levels.map((l, i) => [l, data[i]!]),
    symbol: 'circle',
    symbolSize: dashed ? 6 : 8,
    lineStyle: { width: dashed ? 1.5 : 2, color, type: dashed ? ('dashed' as const) : ('solid' as const) },
    itemStyle: { color, borderColor: tk.surface, borderWidth: 2 },
    endLabel: { show: endLabel, color: tk.fg2, fontSize: 11, formatter: (p: { value: unknown }) => opts.format((p.value as [number, number])[1]) },
  });
  return {
    grid: { left: 8, right: 64, top: 36, bottom: 8, outerBoundsMode: 'same', outerBoundsContain: 'all' },
    legend: {
      top: 0,
      left: 0,
      icon: 'roundRect',
      itemWidth: 14,
      itemHeight: 3,
      textStyle: { color: tk.fg2, fontSize: 12 },
      data: [opts.aggregateName, opts.perUserName, ...(opts.slowest ? [opts.slowest.name] : [])],
    },
    tooltip: { trigger: 'axis', valueFormatter: (v) => (v === null || v === undefined ? '–' : opts.format(Number(v))) },
    xAxis: {
      type: 'log',
      logBase: 2,
      min: levels[0],
      max: levels[levels.length - 1],
      ...ax,
      splitLine: { show: false },
      axisLabel: { ...ax.axisLabel, formatter: (v: number) => String(v) },
      name: opts.xName,
      nameLocation: 'middle',
      nameGap: 26,
    },
    yAxis: { type: 'value', min: 0, ...ax, axisLine: { show: false }, splitNumber: 4, axisLabel: { ...ax.axisLabel, formatter: (v: number) => (opts.axis ?? String)(v) } },
    series: [
      line(opts.aggregateName, aggregate, tk.series[0]!, true),
      line(opts.perUserName, perUser, tk.series[1]!, true),
      ...(opts.slowest ? [line(opts.slowest.name, opts.slowest.values, tk.series[1]!, false, true)] : []),
    ],
  };
}

/** One live metric over the last minutes (Monitor page). */
export function sparkAreaOption(
  tk: ChartTokens,
  t: readonly number[],
  values: readonly number[],
  opts: { name: string; format: (v: number) => string; max?: number; colorIndex?: number; axis?: (v: number) => string },
): ChartOption {
  const ax = axisStyle(tk);
  const color = tk.series[opts.colorIndex ?? 0]!;
  const t0 = t[t.length - 1] ?? 0;
  // Half of the max is often fractional (575 W → 287.5): whole numbers, in the user's language.
  const axis = opts.axis ?? ((v: number) => String(Math.round(v)));
  return {
    grid: { left: 8, right: 8, top: 10, bottom: 4, outerBoundsMode: 'same', outerBoundsContain: 'axisLabel' },
    tooltip: {
      trigger: 'axis',
      valueFormatter: (v) => opts.format(Number(v)),
      axisPointer: { type: 'line', lineStyle: { color: tk.axis } },
    },
    xAxis: {
      type: 'value',
      min: t[0] ?? 0,
      max: t0,
      ...ax,
      splitLine: { show: false },
      axisLabel: { ...ax.axisLabel, formatter: (v: number) => `-${mmss(t0 - v)}` },
    },
    yAxis: {
      type: 'value',
      min: 0,
      ...(opts.max === undefined ? { splitNumber: 2 } : { max: opts.max, interval: opts.max / 2 }),
      ...ax,
      axisLine: { show: false },
      axisLabel: { ...ax.axisLabel, formatter: (v: number) => axis(Math.round(v)) },
    },
    series: [
      {
        type: 'line',
        name: opts.name,
        data: t.map((x, i) => [x, values[i]!]),
        showSymbol: false,
        lineStyle: { width: 1.75, color },
        itemStyle: { color },
        areaStyle: { color, opacity: 0.1 },
        emphasis: { disabled: true },
      },
    ],
  };
}
