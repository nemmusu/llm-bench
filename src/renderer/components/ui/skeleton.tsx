import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn';

export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return <div aria-hidden className={cn('skeleton-shimmer rounded-md', className)} {...props} />;
}
