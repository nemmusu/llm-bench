import { useId, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { useTweened } from '../../lib/use-tweened';
import { HelpTip } from './help-tip';

export interface RadialGaugeProps {
  value: number;
  max: number;
  label: string;
  unit: string;
  /** Formats the center number (locale-aware). */
  format: (v: number) => string;
  help?: ReactNode;
  /** Above these fractions of max the arc turns warning / danger (e.g. temperature). */
  warnAt?: number;
  dangerAt?: number;
  size?: number;
  /** Secondary text under the value, e.g. "di 32 GB". */
  caption?: ReactNode;
  className?: string;
}

const SWEEP = 270;
const START = 135; // degrees, measured clockwise from +x: arc opens at the bottom.

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

function arcPath(cx: number, cy: number, r: number, fromDeg: number, toDeg: number): string {
  const [x1, y1] = polar(cx, cy, r, fromDeg);
  const [x2, y2] = polar(cx, cy, r, toDeg);
  const large = toDeg - fromDeg > 180 ? 1 : 0;
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

/**
 * 270° meter for live values. Exposed as role="meter" with the formatted value as text, so the
 * number is never conveyed by the arc alone.
 */
export function RadialGauge({
  value,
  max,
  label,
  unit,
  format,
  help,
  warnAt,
  dangerAt,
  size = 148,
  caption,
  className,
}: RadialGaugeProps) {
  const gradientId = useId();
  const shown = useTweened(value);
  const ratio = Math.max(0, Math.min(1, shown / max));
  const level = dangerAt !== undefined && value / max >= dangerAt ? 'danger' : warnAt !== undefined && value / max >= warnAt ? 'warning' : 'ok';
  const stroke = 11;
  const r = (size - stroke) / 2 - 2;
  const c = size / 2;
  const end = START + SWEEP * ratio;
  const valueText = `${format(value)} ${unit}`;
  return (
    <div className={cn('flex flex-col items-center gap-2', className)}>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={Math.round(value * 100) / 100}
        aria-valuetext={valueText}
        className="relative"
        style={{ width: size, height: size * 0.86 }}
      >
        <svg aria-hidden width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="absolute top-0 left-0">
          <defs>
            <linearGradient id={gradientId} x1="0" y1="1" x2="1" y2="0">
              <stop offset="0%" stopColor="var(--accent)" />
              <stop offset="100%" stopColor="var(--accent-2)" />
            </linearGradient>
          </defs>
          <path
            d={arcPath(c, c, r, START, START + SWEEP)}
            fill="none"
            stroke="var(--surface-3)"
            strokeWidth={stroke}
            strokeLinecap="round"
          />
          {ratio > 0.002 && (
            <path
              d={arcPath(c, c, r, START, end)}
              fill="none"
              stroke={level === 'danger' ? 'var(--danger)' : level === 'warning' ? 'var(--warning)' : `url(#${gradientId})`}
              strokeWidth={stroke}
              strokeLinecap="round"
            />
          )}
        </svg>
        <div className="absolute inset-x-0 top-[30%] flex flex-col items-center">
          <span className="text-[28px] leading-8 font-semibold tracking-[-0.02em] text-fg tabular-nums">{format(shown)}</span>
          <span className="text-xs font-medium text-fg-3">{caption ?? unit}</span>
        </div>
      </div>
      <div className="-mt-1 flex items-center gap-1 text-sm font-medium text-fg-2">
        {label}
        {help && <HelpTip term={label}>{help}</HelpTip>}
      </div>
    </div>
  );
}
