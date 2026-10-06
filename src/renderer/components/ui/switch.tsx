import { Switch as S } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn';

export function Switch({ className, ...props }: ComponentProps<typeof S.Root>) {
  return (
    <S.Root
      className={cn(
        'peer inline-flex h-[22px] w-[38px] shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-surface-3 shadow-[inset_0_0_0_1px_var(--border-strong)] transition-colors focus-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-accent-solid data-[state=checked]:shadow-none',
        className,
      )}
      {...props}
    >
      <S.Thumb className="pointer-events-none block size-4 translate-x-[2px] rounded-full bg-white shadow-sm ring-0 transition-transform duration-200 data-[state=checked]:translate-x-[18px]" />
    </S.Root>
  );
}
