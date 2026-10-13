import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { barOption, concurrencyOption, mmss, sparkAreaOption, timelineOption } from '../../../src/renderer/components/charts/builders';
import { ChartCard, LegendKey } from '../../../src/renderer/components/charts/chart-card';
import { EChart } from '../../../src/renderer/components/charts/echart';
import { axisStyle, baseOption, readChartTokens, type ChartTokens } from '../../../src/renderer/components/charts/echarts';
import { fakeApi, renderUi } from './helpers';

const chart = { setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() };
vi.mock('echarts/core', () => ({ use: vi.fn(), init: vi.fn(() => chart) }));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({
  AxisPointerComponent: {},
  DataZoomComponent: {},
  GridComponent: {},
  LegendComponent: {},
  MarkAreaComponent: {},
  MarkLineComponent: {},
  TooltipComponent: {},
}));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

const tk: ChartTokens = {
  font: 'Inter',
  fg: '#000',
  fg2: '#111',
  fg3: '#222',
  surface: '#fff',
  elevated: '#fff',
  border: '#eee',
  grid: '#ddd',
  axis: '#ccc',
  band: 'rgba(0,0,0,.05)',
  bandAlt: 'rgba(0,0,0,.02)',
  series: ['#1', '#2', '#3', '#4', '#5', '#6', '#7', '#8'],
  accent2: '#0ea5b7',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- reaching into ECharts option unions
type Any = any;

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('builders', () => {
  it('mmss formats seconds', () => {
    expect(mmss(0)).toBe('0:00');
    expect(mmss(125.4)).toBe('2:05');
    expect(mmss(-3)).toBe('0:00');
  });

  it('timeline: one grid per series, linked axes, phase bands and tooltip', () => {
    const o: Any = timelineOption(
      tk,
      [0, 10, 20],
      [
        { name: 'Util', unit: '%', values: [1, null, 3], format: (v) => `${v} %`, max: 100 },
        { name: 'Power', values: [10, 20], format: (v) => `${v} W` },
      ],
      [
        { start: 0, end: 1, label: 'A' },
        { start: 1, end: 20, label: 'Long phase' },
      ],
    );
    expect(o.grid).toHaveLength(2);
    expect(o.yAxis[0].name).toBe('Util (%)');
    expect(o.yAxis[0].interval).toBe(50);
    expect(o.yAxis[1].splitNumber).toBe(2);
    expect(o.yAxis[1].name).toBe('Power');
    expect(o.yAxis[0].axisLabel.formatter(49.6)).toBe('50');
    expect(o.xAxis[1].axisLabel.formatter(65)).toBe('1:05');
    expect(o.xAxis[0].axisLabel.show).toBe(false);
    expect(o.series[1].data[2]).toEqual([20, null]);
    const area = o.series[0].markArea.data;
    expect(area[0][0].label.formatter).toBe('');
    expect(area[1][0].label.formatter).toBe('Long phase');
    expect(o.series[1].markArea.data[0][0].label.show).toBe(false);
    const html = o.tooltip.formatter([
      { seriesIndex: 0, data: [10, null] },
      { seriesIndex: 1, data: [10, 20] },
    ]);
    expect(html).toContain('0:10 · Long phase');
    expect(html).toContain('–');
    expect(html).toContain('20 W');
    expect(o.tooltip.formatter([{ seriesIndex: 0, data: [99, 1] }])).not.toContain('·');
    expect(o.tooltip.formatter([])).toContain('0:00');
    const empty: Any = timelineOption(tk, [], [{ name: 'X', values: [], format: String }], [], { rowHeight: 40, gap: 10, xMax: 50 });
    expect(empty.xAxis[0].max).toBe(50);
    expect((timelineOption(tk, [], [], []) as Any).xAxis).toEqual([]);
  });

  it('bar: thin bars, peak label, axis and tooltip formatters', () => {
    const o: Any = barOption(tk, ['128', '512'], [10, 20], { name: 'Gen', format: (v) => `${v} tok/s`, xName: 'Prompt' });
    expect(o.series[0].barMaxWidth).toBe(24);
    expect(o.series[0].data[1].label.show).toBe(true);
    expect(o.series[0].data[0].label.show).toBe(false);
    expect(o.series[0].data[1].label.formatter()).toBe('20 tok/s');
    expect(o.yAxis.axisLabel.formatter(150)).toBe('150');
    expect(o.tooltip.valueFormatter(5)).toBe('5 tok/s');
    expect(o.xAxis.name).toBe('Prompt');
    const custom: Any = barOption(tk, ['a'], [1], { name: 'x', format: String, axis: (v) => `#${v}` });
    expect(custom.yAxis.axisLabel.formatter(2)).toBe('#2');
    expect(custom.xAxis.name).toBeUndefined();
  });

  it('concurrency: two series on one axis with legend and end labels', () => {
    const o: Any = concurrencyOption(tk, [1, 2, 4], [10, 18, 30], [10, 9, 7], { aggregateName: 'Tot', perUserName: 'User', format: (v) => `${v} t`, xName: 'Utenti' });
    expect(o.legend.data).toEqual(['Tot', 'User']);
    expect(o.series[0].itemStyle.color).toBe('#1');
    expect(o.series[1].itemStyle.color).toBe('#2');
    expect(o.series[0].endLabel.formatter({ value: [4, 30] })).toBe('30 t');
    expect(o.xAxis.axisLabel.formatter(8)).toBe('8');
    expect(o.yAxis.axisLabel.formatter(1000)).toBe('1000');
    expect(o.tooltip.valueFormatter(3)).toBe('3 t');
    const withAxis: Any = concurrencyOption(tk, [1], [1], [1], { aggregateName: 'a', perUserName: 'b', format: String, xName: 'x', axis: (v) => `~${v}` });
    expect(withAxis.yAxis.axisLabel.formatter(5)).toBe('~5');
  });

  it('spark area: relative time axis, optional max and color', () => {
    const o: Any = sparkAreaOption(tk, [100, 160], [1, 2], { name: 'U', format: (v) => `${v}%`, max: 575, colorIndex: 2, axis: (v) => `n${v}` });
    expect(o.yAxis.interval).toBe(287.5);
    // Half of 575 W is a whole number on the axis, in the user's language.
    expect(o.yAxis.axisLabel.formatter(287.5)).toBe('n288');
    expect(o.series[0].lineStyle.color).toBe('#3');
    expect(o.xAxis.axisLabel.formatter(100)).toBe('-1:00');
    expect(o.tooltip.valueFormatter(4)).toBe('4%');
    const noMax: Any = sparkAreaOption(tk, [], [], { name: 'V', format: String });
    expect(noMax.yAxis.splitNumber).toBe(2);
    expect(noMax.yAxis.axisLabel.formatter(1500.4)).toBe('1500');
    expect(noMax.xAxis.min).toBe(0);
    expect(noMax.series[0].lineStyle.color).toBe('#1');
  });
});

describe('echarts theme', () => {
  it('reads tokens from CSS variables with fallbacks', () => {
    document.documentElement.style.setProperty('--fg', '#123456');
    const t = readChartTokens();
    expect(t.fg).toBe('#123456');
    expect(t.series).toHaveLength(8);
    document.documentElement.style.removeProperty('--fg');
    expect(readChartTokens().fg).toBe('#0e1117');
  });

  it('base option and axis style', () => {
    expect((baseOption(tk, false) as Any).animation).toBe(false);
    expect((baseOption(tk, true) as Any).color).toBe(tk.series);
    expect(axisStyle(tk).splitLine.lineStyle.type).toBe('solid');
  });
});

describe('EChart', () => {
  let observed: (() => void) | undefined;
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          observed = cb;
        }
        observe() {}
        disconnect() {}
      },
    );
  });

  it('initializes, resizes, re-themes and disposes', async () => {
    const build = vi.fn(() => ({ series: [] }));
    const api = fakeApi({ theme: 'light' });
    const { unmount, findByRole } = renderUi(<EChart build={build} height={200} label="Grafico" className="x" />, { withSettings: true, api });
    const el = await findByRole('img', { name: 'Grafico' });
    expect(el.style.height).toBe('200px');
    expect(chart.setOption).toHaveBeenCalled();
    expect(chart.setOption.mock.calls[0]![1]).toMatchObject({ notMerge: true });
    act(() => observed?.());
    expect(chart.resize).toHaveBeenCalled();
    unmount();
    expect(chart.dispose).toHaveBeenCalled();
  });
});

describe('ChartCard', () => {
  it('toggles between chart and an accessible table', async () => {
    renderUi(
      <ChartCard
        title="Velocità"
        help="aiuto"
        controls={<span>ctrl</span>}
        footer={<span>legenda</span>}
        headingLevel={3}
        table={{ columns: ['Prompt', 'tok/s'], rows: [[512, '190,6']], numeric: [1] }}
      >
        <div>grafico</div>
      </ChartCard>,
    );
    expect(screen.getByRole('heading', { level: 3, name: 'Velocità' })).toBeTruthy();
    expect(screen.getByText('legenda')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Mostra tabella' }));
    const table = screen.getByRole('table', { name: 'Dati del grafico «Velocità»' });
    expect(table.textContent).toContain('190,6');
    expect(screen.queryByText('grafico')).toBeNull();
    expect(screen.queryByText('legenda')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Mostra grafico' }));
    expect(screen.getByText('grafico')).toBeTruthy();
  });

  it('defaults to h2 and works without numeric columns', async () => {
    renderUi(
      <ChartCard title="T" table={{ columns: ['a'], rows: [['x']] }}>
        <div />
      </ChartCard>,
    );
    expect(screen.getByRole('heading', { level: 2, name: 'T' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Mostra tabella' }));
    expect(screen.getByRole('table')).toBeTruthy();
  });

  it('LegendKey draws a line or square key', () => {
    const { container } = renderUi(
      <>
        <LegendKey color="red" label="Totale" />
        <LegendKey color="blue" label="Per utente" shape="square" />
      </>,
    );
    expect(screen.getByText('Totale')).toBeTruthy();
    expect(container.querySelectorAll('.rounded-xs')).toHaveLength(1);
  });
});
