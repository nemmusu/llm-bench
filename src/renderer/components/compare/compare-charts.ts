/**
 * The compared items on one chart, one color each (the same as their letter on the cards): speed as
 * the context fills up, and the speed every user gets as users are added.
 */
import { axisStyle, type ChartOption, type ChartTokens } from '../charts/echarts';
import { tooltipHtml, yOf, type AxisParam } from '../charts/tooltip';
import { prefillStat } from '../bench/format';
import { usersPoint, type CompareItem, type UsersChoice } from './compare-model';

export interface ItemSeries {
  name: string;
  /** Index of the item (its color). */
  item: number;
  values: (number | null)[];
}

/** A speed line: its values and, at each depth, the exact tokens of the prompt (or of the context) it was measured with. */
export interface SpeedSeries extends ItemSeries {
  tokens: (number | null)[];
}

/** Generation (or prompt reading) of every item at every depth any of them measured; null where one did not. */
export function speedSeries(items: readonly CompareItem[], names: readonly string[], metric: 'decode' | 'prefill'): { depths: number[]; series: SpeedSeries[] } {
  const depths = [...new Set(items.flatMap((it) => it.points.map((p) => p.depth)))].sort((a, b) => a - b);
  return {
    depths,
    series: items.map((it, i) => {
      const at = depths.map((d) => it.points.find((q) => q.depth === d));
      return {
        name: names[i]!,
        item: i,
        values: at.map((p) => (p === undefined ? null : metric === 'decode' ? p.point.decodeTps.median : prefillStat(p.point).median)),
        tokens: at.map((p) => p?.point.promptTokens ?? null),
      };
    }),
  };
}

/** Per-user generation (or the total) of the items that measured the chosen level with the same prompt, at every level. */
export function usersSeries(items: readonly CompareItem[], names: readonly string[], choice: UsersChoice, metric: 'perUser' | 'total'): { levels: number[]; series: ItemSeries[] } {
  const shown = items.flatMap((it, i) => (usersPoint(it, i, choice) ? [{ it, i }] : []));
  const levels = [...new Set(shown.flatMap(({ it }) => it.concurrency.map((p) => p.level)))].sort((a, b) => a - b);
  return {
    levels,
    series: shown.map(({ it, i }) => ({
      name: names[i]!,
      item: i,
      values: levels.map((l) => {
        const p = it.concurrency.find((q) => q.level === l);
        return p === undefined ? null : metric === 'perUser' ? p.perRequestDecodeTpsP50 : p.aggregateTps;
      }),
    })),
  };
}

export interface UsersLinesOpts {
  format: (v: number) => string;
  /** "con 4 utenti insieme, prompt da 512 token ciascuno". */
  head: (users: number) => string;
  xName: string;
  axis: (v: number) => string;
}

/** One line per item over the number of users (doubling steps evenly spaced). */
export function usersLinesOption(tk: ChartTokens, levels: readonly number[], series: readonly ItemSeries[], o: UsersLinesOpts): ChartOption {
  const ax = axisStyle(tk);
  return {
    grid: { left: 8, right: 16, top: 40, bottom: 8, outerBoundsMode: 'same', outerBoundsContain: 'all' },
    legend: { type: 'scroll', top: 0, left: 0, right: 0, icon: 'roundRect', itemWidth: 14, itemHeight: 3, textStyle: { color: tk.fg2, fontSize: 12 }, pageTextStyle: { color: tk.fg3 }, pageIconColor: tk.fg2, pageIconInactiveColor: tk.axis },
    tooltip: {
      trigger: 'axis',
      formatter: (params: unknown) => {
        const list = params as AxisParam[];
        const users = levels[list[0]!.dataIndex]!;
        return tooltipHtml(
          tk,
          o.head(users),
          list.map((p) => {
            const v = yOf(p.value);
            return { name: p.seriesName, value: v === null ? '–' : o.format(v), color: p.color };
          }),
        );
      },
    },
    xAxis: { type: 'category', data: levels.map(String), boundaryGap: false, ...ax, splitLine: { show: false }, name: o.xName, nameLocation: 'middle', nameGap: 28 },
    yAxis: { type: 'value', min: 0, ...ax, axisLine: { show: false }, splitNumber: 4, axisLabel: { ...ax.axisLabel, formatter: (v: number) => o.axis(v) } },
    series: series.map((s) => {
      const color = tk.series[s.item]!;
      return {
        type: 'line' as const,
        name: s.name,
        data: [...s.values],
        connectNulls: true,
        symbol: 'circle',
        symbolSize: 7,
        lineStyle: { width: 2, color },
        itemStyle: { color, borderColor: tk.surface, borderWidth: 1.5 },
        emphasis: { focus: 'series' as const },
      };
    }),
  };
}
