import { useEffect, useRef } from 'react';
import { cn } from '../../lib/cn';
import { useSettings } from '../../lib/settings';
import { prefersReducedMotion } from '../../lib/theme';
import { baseOption, echarts, readChartTokens, type ChartOption, type ChartTokens } from './echarts';

export interface EChartProps {
  /** Builds the option from the current theme tokens; memoize it (useCallback) in the caller. */
  build: (tokens: ChartTokens) => ChartOption;
  height: number;
  /** Accessible name of the canvas; the data itself is reachable through "Show table". */
  label: string;
  className?: string;
}

/**
 * React wrapper around one ECharts instance: themed from CSS tokens, resized with a
 * ResizeObserver, no animation when the user prefers reduced motion.
 */
export function EChart({ build, height, label, className }: EChartProps) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const themeRef = useRef<string | null>(null);
  const { resolvedTheme } = useSettings();

  useEffect(() => {
    const el = ref.current!;
    const chart = echarts.init(el, undefined, { renderer: 'canvas' });
    chartRef.current = chart;
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
      themeRef.current = null;
    };
  }, []);

  useEffect(() => {
    // Always set: the init effect above runs first, also when StrictMode re-runs effects.
    const chart = chartRef.current!;
    const tokens = readChartTokens();
    const option = { ...baseOption(tokens, !prefersReducedMotion()), ...build(tokens) };
    // A theme switch replaces everything; live updates merge so lines glide instead of redrawing.
    chart.setOption(option, { notMerge: themeRef.current !== resolvedTheme, lazyUpdate: true });
    themeRef.current = resolvedTheme;
  }, [build, resolvedTheme]);

  return <div ref={ref} role="img" aria-label={label} className={cn('w-full', className)} style={{ height }} />;
}
