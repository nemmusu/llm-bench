import { Progress as P } from 'radix-ui';
import { cn } from '../../lib/cn';

export interface ProgressProps {
  /** 0..100 */
  value: number;
  label: string;
  valueText?: string;
  className?: string;
  tone?: 'accent' | 'success' | 'warning' | 'danger';
  size?: 'sm' | 'md';
}

const tones = {
  accent: 'bg-[linear-gradient(90deg,var(--accent),var(--accent-2))]',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
} as const;

/** Determinate progress bar with an accessible name and value text. */
export function Progress({ value, label, valueText, className, tone = 'accent', size = 'md' }: ProgressProps) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <P.Root
      value={clamped}
      max={100}
      aria-label={label}
      {...(valueText ? { getValueLabel: () => valueText } : {})}
      className={cn('relative w-full overflow-hidden rounded-full bg-surface-3', size === 'sm' ? 'h-1.5' : 'h-2', className)}
    >
      <P.Indicator
        className={cn('h-full rounded-full transition-[width] duration-500 ease-out', tones[tone])}
        style={{ width: `${clamped}%` }}
      />
    </P.Root>
  );
}
