import { Tabs as T } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn';

export const Tabs = T.Root;

export function TabsList({ className, ...props }: ComponentProps<typeof T.List>) {
  return <T.List className={cn('flex items-center gap-1 border-b border-border', className)} {...props} />;
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof T.Trigger>) {
  return (
    <T.Trigger
      className={cn(
        'relative -mb-px inline-flex h-10 items-center gap-2 rounded-t-md px-3 text-sm font-medium text-fg-2 transition-colors hover:text-fg focus-ring',
        'after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-transparent after:transition-colors',
        'data-[state=active]:text-fg data-[state=active]:after:bg-accent [&_svg]:size-4',
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof T.Content>) {
  return <T.Content className={cn('pt-section outline-none', className)} {...props} />;
}
