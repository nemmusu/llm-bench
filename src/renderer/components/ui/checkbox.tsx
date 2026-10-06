import { Check } from 'lucide-react';
import { Checkbox as C } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn';

export function Checkbox({ className, ...props }: ComponentProps<typeof C.Root>) {
  return (
    <C.Root
      className={cn(
        'grid size-4 shrink-0 place-items-center rounded-xs border border-border-strong bg-surface shadow-xs transition-colors focus-ring disabled:opacity-50 data-[state=checked]:border-accent-solid data-[state=checked]:bg-accent-solid data-[state=checked]:text-accent-fg',
        className,
      )}
      {...props}
    >
      <C.Indicator>
        <Check aria-hidden className="size-3" strokeWidth={3} />
      </C.Indicator>
    </C.Root>
  );
}
