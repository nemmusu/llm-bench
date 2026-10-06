import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn';

export function Kbd({ className, ...props }: ComponentProps<'kbd'>) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-xs border border-border-strong bg-surface px-1 font-sans text-2xs font-medium text-fg-2 shadow-[0_1px_0_var(--border-strong)]',
        className,
      )}
      {...props}
    />
  );
}
