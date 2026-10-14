import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { HelpTip } from './help-tip';
import { Sparkline } from './sparkline';

export interface StatDelta {
  /** Already formatted, e.g. "+23%". */
  text: string;
  direction: 'up' | 'down';
  /** Whether this direction is good news (drives the color). */
  good: boolean;
  /** What the delta is relative to, e.g. "vs gemma 31B". */
  context?: string;
}

export interface StatTileProps {
  label: string;
  value: ReactNode;
  unit?: string;
  help?: ReactNode;
  icon?: ReactNode;
  delta?: StatDelta;
  /** Secondary line under the value. */
  hint?: ReactNode;
  sparkline?: readonly number[];
  className?: string;
  size?: 'md' | 'lg';
}

/** KPI tile: label (+ "?"), big value with unit, then delta / hint with an optional sparkline. */
export function StatTile({ label, value, unit, help, icon, delta, hint, sparkline, className, size = 'md' }: StatTileProps) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5 rounded-xl border border-border bg-surface p-card shadow-xs', className)}>
      <div className="flex min-h-5 items-center gap-1.5 text-sm text-fg-2">
        {icon && <span className="text-fg-3 [&_svg]:size-4">{icon}</span>}
        <span className="truncate" title={label}>
          {label}
        </span>
        {help && <HelpTip term={label}>{help}</HelpTip>}
      </div>
      <p className="flex min-w-0 items-baseline gap-1.5">
        <span className={cn('font-semibold tracking-[-0.02em] text-fg tabular-nums', size === 'lg' ? 'text-4xl' : 'text-3xl compact:text-2xl')}>
          {value}
        </span>
        {unit && <span className="text-sm font-medium text-fg-3">{unit}</span>}
      </p>
      {(delta || hint || sparkline) && (
        <div className="mt-auto flex min-h-6 items-end justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-fg-3">
            {delta && (
              <span className={cn('inline-flex items-center gap-0.5 font-medium', delta.good ? 'text-success-text' : 'text-danger-text')}>
                {delta.direction === 'up' ? <ArrowUpRight aria-hidden className="size-3.5" /> : <ArrowDownRight aria-hidden className="size-3.5" />}
                {delta.text}
              </span>
            )}
            {delta?.context && <span>{delta.context}</span>}
            {hint && <span>{hint}</span>}
          </div>
          {sparkline && <Sparkline values={sparkline} width={72} height={24} />}
        </div>
      )}
    </div>
  );
}
