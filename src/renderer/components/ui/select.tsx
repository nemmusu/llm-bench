import { Check, ChevronDown } from 'lucide-react';
import { Select as S } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { floatingPanelClass } from './tooltip';

export interface SelectOption<V extends string = string> {
  value: V;
  label: ReactNode;
  /** Plain text used for type-ahead and the trigger when `label` is rich. */
  text?: string;
  description?: ReactNode;
  disabled?: boolean;
}

export interface SelectProps<V extends string> {
  value: V;
  onValueChange: (value: V) => void;
  options: readonly SelectOption<V>[];
  id?: string;
  /** Accessible name when there is no <label htmlFor>. */
  'aria-label'?: string;
  'aria-describedby'?: string;
  className?: string;
  disabled?: boolean;
}

/** Accessible single-choice dropdown (Radix Select). */
export function Select<V extends string>({ value, onValueChange, options, className, disabled, ...aria }: SelectProps<V>) {
  return (
    <S.Root value={value} onValueChange={(v) => onValueChange(v as V)} {...(disabled ? { disabled } : {})}>
      <S.Trigger
        {...(aria.id ? { id: aria.id } : {})}
        aria-label={aria['aria-label']}
        aria-describedby={aria['aria-describedby']}
        className={cn(
          'inline-flex h-control w-full items-center justify-between gap-2 rounded-md border border-border-strong bg-surface px-3 text-sm text-fg shadow-xs transition-colors hover:border-fg-3 focus-ring data-[placeholder]:text-fg-3 disabled:opacity-50',
          className,
        )}
      >
        <S.Value />
        <S.Icon asChild>
          <ChevronDown aria-hidden className="size-4 text-fg-3" />
        </S.Icon>
      </S.Trigger>
      <S.Portal>
        <S.Content
          position="popper"
          sideOffset={6}
          className={cn(floatingPanelClass, 'max-h-80 min-w-[var(--radix-select-trigger-width)] overflow-hidden p-1 shadow-lg')}
        >
          <S.Viewport>
            {options.map((o) => (
              <S.Item
                key={o.value}
                value={o.value}
                {...(o.text ? { textValue: o.text } : {})}
                {...(o.disabled ? { disabled: true } : {})}
                className="relative flex cursor-default select-none items-start gap-2 rounded-sm py-1.5 pr-2 pl-7 text-sm outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-2"
              >
                <S.ItemIndicator className="absolute top-2 left-2">
                  <Check aria-hidden className="size-3.5 text-accent" />
                </S.ItemIndicator>
                <div className="flex flex-col">
                  <S.ItemText>{o.label}</S.ItemText>
                  {o.description && <span className="text-xs text-fg-3">{o.description}</span>}
                </div>
              </S.Item>
            ))}
          </S.Viewport>
        </S.Content>
      </S.Portal>
    </S.Root>
  );
}
