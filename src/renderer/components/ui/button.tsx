import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Tooltip } from './tooltip';

export const buttonVariants = cva(
  [
    'relative inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium select-none',
    'transition-[background-color,border-color,color,box-shadow,filter] duration-150 focus-ring',
    'disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50',
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        primary:
          'bg-accent-solid bg-[linear-gradient(180deg,rgb(255_255_255/0.08),rgb(255_255_255/0))] text-accent-fg shadow-xs hover:bg-accent-solid-hover',
        secondary: 'border border-border-strong bg-surface text-fg shadow-xs hover:bg-surface-2',
        outline: 'border border-border-strong bg-transparent text-fg hover:bg-surface-2',
        ghost: 'bg-transparent text-fg-2 hover:bg-surface-2 hover:text-fg',
        danger: 'bg-danger-solid text-white shadow-xs hover:brightness-110',
        'danger-outline':
          'border border-border-strong bg-surface text-danger-text shadow-xs hover:border-danger hover:bg-danger-soft',
        link: 'text-accent-text underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-control-sm px-2.5 text-sm [&_svg]:size-3.5',
        md: 'h-control px-3.5 text-sm [&_svg]:size-4',
        lg: 'h-11 rounded-lg px-5 text-md [&_svg]:size-[18px]',
        xl: 'h-16 rounded-xl px-8 text-lg font-semibold tracking-[-0.01em] [&_svg]:size-5',
      },
    },
    compoundVariants: [
      { variant: 'primary', size: 'xl', class: 'shadow-glow' },
      { variant: 'link', class: 'h-auto px-0' },
    ],
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export type ButtonProps = ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    /** Render the child element (e.g. a router Link) with button styles. */
    asChild?: boolean;
  };

export function Button({ className, variant, size, asChild = false, type, ...props }: ButtonProps) {
  const classes = cn(buttonVariants({ variant, size }), className);
  if (asChild) return <Slot.Root className={classes} {...props} />;
  return <button type={type ?? 'button'} className={classes} {...props} />;
}

const iconSizes = {
  sm: 'size-control-sm [&_svg]:size-3.5',
  md: 'size-control [&_svg]:size-4',
  lg: 'size-11 [&_svg]:size-5',
} as const;

export type IconButtonProps = Omit<ComponentProps<'button'>, 'children'> & {
  /** Accessible name, also shown as tooltip. Icon-only controls must always have one. */
  label: string;
  icon: ReactNode;
  variant?: 'ghost' | 'secondary' | 'outline' | 'primary';
  size?: keyof typeof iconSizes;
  /** Hide the hover tooltip (e.g. when a visible label is nearby). */
  noTooltip?: boolean;
};

export function IconButton({ label, icon, variant = 'ghost', size = 'md', noTooltip, className, ...props }: IconButtonProps) {
  const button = (
    <button
      type="button"
      aria-label={label}
      className={cn(buttonVariants({ variant }), 'px-0', iconSizes[size], className)}
      {...props}
    >
      {icon}
    </button>
  );
  return noTooltip ? button : <Tooltip content={label}>{button}</Tooltip>;
}
