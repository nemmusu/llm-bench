import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn';

export const badgeVariants = cva(
  'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full font-medium [&_svg]:shrink-0',
  {
    variants: {
      tone: {
        neutral: 'bg-surface-3 text-fg-2',
        accent: 'bg-accent-soft text-accent-text',
        success: 'bg-success-soft text-success-text',
        warning: 'bg-warning-soft text-warning-text',
        danger: 'bg-danger-soft text-danger-text',
        info: 'bg-info-soft text-info-text',
        outline: 'border border-border-strong text-fg-2',
      },
      size: {
        sm: 'h-5 px-2 text-2xs [&_svg]:size-3',
        md: 'h-6 px-2.5 text-xs [&_svg]:size-3.5',
      },
    },
    defaultVariants: { tone: 'neutral', size: 'md' },
  },
);

export type BadgeProps = ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { dot?: boolean };

export function Badge({ className, tone, size, dot, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ tone, size }), className)} {...props}>
      {dot && <span aria-hidden className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}
