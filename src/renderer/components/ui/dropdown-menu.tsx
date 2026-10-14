import { Check } from 'lucide-react';
import { DropdownMenu as M } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn';
import { floatingPanelClass } from './tooltip';

export const DropdownMenu = M.Root;
export const DropdownMenuTrigger = M.Trigger;
export const DropdownMenuRadioGroup = M.RadioGroup;

export function DropdownMenuContent({ className, sideOffset = 6, align = 'end', ...props }: ComponentProps<typeof M.Content>) {
  return (
    <M.Portal>
      <M.Content
        sideOffset={sideOffset}
        align={align}
        className={cn(floatingPanelClass, 'min-w-52 p-1 shadow-lg', className)}
        {...props}
      />
    </M.Portal>
  );
}

const itemClass =
  'flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-fg outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-2 [&_svg]:size-4 [&_svg]:text-fg-3';

export function DropdownMenuItem({ className, ...props }: ComponentProps<typeof M.Item>) {
  return <M.Item className={cn(itemClass, className)} {...props} />;
}

/** One choice of a radio group: a check on the left marks the chosen one, like Select (screen readers hear "checked"). */
export function DropdownMenuRadioItem({ className, children, ...props }: ComponentProps<typeof M.RadioItem>) {
  return (
    <M.RadioItem className={cn(itemClass, 'relative pl-7 [&_svg]:size-3.5 [&_svg]:text-accent', className)} {...props}>
      <M.ItemIndicator className="absolute left-2 flex">
        <Check aria-hidden />
      </M.ItemIndicator>
      {children}
    </M.RadioItem>
  );
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof M.Label>) {
  return <M.Label className={cn('px-2 py-1.5 text-xs font-medium text-fg-3', className)} {...props} />;
}

export function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof M.Separator>) {
  return <M.Separator className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />;
}
