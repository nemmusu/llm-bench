import { useId } from 'react';
import { cn } from '../../lib/cn';

export interface SparklineProps {
  values: readonly number[];
  width?: number;
  height?: number;
  className?: string;
  /** CSS color of the line; defaults to the first chart color. */
  color?: string;
  /** Mark the last point (the "now" value). */
  endDot?: boolean;
}

/** Tiny trend line. Decorative: the value it summarizes is always printed next to it. */
export function Sparkline({ values, width = 96, height = 28, className, color = 'var(--chart-1)', endDot = true }: SparklineProps) {
  const gradientId = useId();
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = 3;
  const points = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (width - pad * 2);
    const y = pad + (1 - (v - min) / span) * (height - pad * 2);
    return [x, y] as const;
  });
  const line = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const last = points[points.length - 1]!;
  const area = `M${points[0]![0]},${height} L${line.replaceAll(' ', ' L')} L${last[0]},${height} Z`;
  return (
    <svg
      aria-hidden
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn('shrink-0 overflow-visible', className)}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.18} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradientId})`} />
      <polyline points={line} fill="none" stroke={color} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
      {endDot && <circle cx={last[0]} cy={last[1]} r={2.75} fill={color} stroke="var(--surface)" strokeWidth={1.5} />}
    </svg>
  );
}
