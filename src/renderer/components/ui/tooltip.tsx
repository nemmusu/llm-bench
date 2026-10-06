import { Tooltip as T } from 'radix-ui';
import type { ReactElement, ReactNode } from 'react';
import { cn } from '../../lib/cn';

export const TooltipProvider = T.Provider;

export const floatingPanelClass = 'z-50 rounded-md border border-border bg-elevated text-fg shadow-md';

export interface TooltipProps {
  content: ReactNode;
  children: ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

/** Hover/focus hint. The trigger keeps its own accessible name; the content becomes its description. */
export function Tooltip({ content, children, side = 'top', align = 'center', open, onOpenChange, className }: TooltipProps) {
  return (
    <T.Root {...(open === undefined ? {} : { open })} {...(onOpenChange ? { onOpenChange } : {})}>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          className={cn(floatingPanelClass, 'max-w-72 px-2.5 py-1.5 text-xs leading-[18px]', className)}
        >
          {content}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
