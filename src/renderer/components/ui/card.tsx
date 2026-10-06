import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn';

export function Card({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('rounded-xl border border-border bg-surface shadow-xs', className)} {...props} />;
}

export function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex items-start justify-between gap-3 px-card pt-card', className)} {...props} />;
}

export function CardTitle({ className, ...props }: ComponentProps<'h2'>) {
  return <h2 className={cn('text-md font-semibold tracking-[-0.01em] text-fg', className)} {...props} />;
}

export function CardDescription({ className, ...props }: ComponentProps<'p'>) {
  return <p className={cn('text-sm text-fg-2', className)} {...props} />;
}

export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('p-card', className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex items-center gap-2 border-t border-border px-card py-3 text-sm text-fg-2', className)}
      {...props}
    />
  );
}
