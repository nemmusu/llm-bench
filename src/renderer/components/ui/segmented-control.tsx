import { RadioGroup as R } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface SegmentOption<V extends string> {
  value: V;
  label: ReactNode;
  /** Secondary text (e.g. "~2 min"): under the label horizontally, right-aligned in a list. */
  sublabel?: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface SegmentedControlProps<V extends string> {
  value: V;
  onValueChange: (value: V) => void;
  options: readonly SegmentOption<V>[];
  /** Accessible name of the radio group. */
  label: string;
  size?: 'sm' | 'md' | 'lg';
  /** "list" stacks the options as full-width rows (roomy choices with a value on the right). */
  layout?: 'segments' | 'list';
  className?: string;
  fullWidth?: boolean;
}

/**
 * One-of-N choice drawn as segments (or a list of rows). It is a radio group underneath, so
 * arrow keys move the selection and screen readers announce "1 of 3".
 */
export function SegmentedControl<V extends string>({
  value,
  onValueChange,
  options,
  label,
  size = 'md',
  layout = 'segments',
  className,
  fullWidth,
}: SegmentedControlProps<V>) {
  if (layout === 'list') {
    return (
      <R.Root
        value={value}
        onValueChange={(v) => onValueChange(v as V)}
        aria-label={label}
        className={cn('flex flex-col gap-1.5', className)}
      >
        {options.map((o) => (
          <R.Item
            key={o.value}
            value={o.value}
            {...(o.disabled ? { disabled: true } : {})}
            className={cn(
              'group flex h-11 items-center gap-3 rounded-lg border border-border bg-surface px-3 text-left text-sm transition-colors hover:border-border-strong focus-ring disabled:opacity-50',
              'data-[state=checked]:border-accent data-[state=checked]:bg-accent-soft data-[state=checked]:ring-1 data-[state=checked]:ring-accent',
            )}
          >
            <span
              aria-hidden
              className="grid size-4 shrink-0 place-items-center rounded-full border border-border-strong bg-surface group-data-[state=checked]:border-accent-solid group-data-[state=checked]:bg-accent-solid"
            >
              <span className="size-1.5 rounded-full bg-white opacity-0 group-data-[state=checked]:opacity-100" />
            </span>
            {o.icon}
            <span className="flex-1 font-medium text-fg">{o.label}</span>
            {o.sublabel && <span className="text-xs font-medium text-fg-3 tabular-nums group-data-[state=checked]:text-accent-text">{o.sublabel}</span>}
          </R.Item>
        ))}
      </R.Root>
    );
  }
  return (
    <R.Root
      value={value}
      onValueChange={(v) => onValueChange(v as V)}
      aria-label={label}
      orientation="horizontal"
      className={cn('inline-flex gap-1 rounded-lg bg-surface-3 p-1', fullWidth && 'flex w-full', size === 'lg' && 'rounded-xl', className)}
    >
      {options.map((o) => (
        <R.Item
          key={o.value}
          value={o.value}
          {...(o.disabled ? { disabled: true } : {})}
          className={cn(
            'inline-flex flex-1 items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap text-fg-2 transition-[background-color,color,box-shadow] hover:text-fg focus-ring disabled:opacity-50',
            'data-[state=checked]:bg-surface data-[state=checked]:text-fg data-[state=checked]:shadow-sm dark:data-[state=checked]:bg-surface-2',
            '[&_svg]:size-4',
            size === 'sm' && 'h-6 px-2 text-xs',
            size === 'md' && 'h-[calc(var(--control-h)-8px)] px-3 text-sm',
            size === 'lg' && 'min-h-14 flex-col gap-0.5 rounded-lg px-3 py-2 text-sm',
          )}
        >
          {o.icon}
          <span>{o.label}</span>
          {o.sublabel && <span className="text-xs font-normal text-fg-3 tabular-nums">{o.sublabel}</span>}
        </R.Item>
      ))}
    </R.Root>
  );
}
