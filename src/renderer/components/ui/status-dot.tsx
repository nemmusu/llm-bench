import { cn } from '../../lib/cn';

export interface StatusDotProps {
  tone: 'success' | 'warning' | 'danger' | 'neutral' | 'accent';
  /** Soft ring animation for "live" things. */
  pulse?: boolean;
  className?: string;
}

const colors = {
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  neutral: 'bg-fg-3',
  accent: 'bg-accent',
} as const;

/** Decorative state dot; always paired with a text label by the caller. */
export function StatusDot({ tone, pulse, className }: StatusDotProps) {
  return (
    <span aria-hidden className={cn('relative inline-flex size-2 shrink-0', className)}>
      {pulse && <span className={cn('absolute inset-0 rounded-full animate-ping-soft', colors[tone])} />}
      <span className={cn('relative size-2 rounded-full', colors[tone])} />
    </span>
  );
}
