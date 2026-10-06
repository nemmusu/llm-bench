import { useId, type ComponentProps, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

const fieldClass =
  'w-full rounded-md border border-border-strong bg-surface text-sm text-fg shadow-xs placeholder:text-fg-3 transition-colors hover:border-fg-3 focus-visible:border-accent focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-accent/25 disabled:opacity-50 aria-invalid:border-danger';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn(fieldClass, 'h-control px-3', className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cn(fieldClass, 'min-h-20 px-3 py-2 leading-5', className)} {...props} />;
}

export function Label({ className, ...props }: ComponentProps<'label'>) {
  return <label className={cn('text-sm font-medium text-fg', className)} {...props} />;
}

export interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  /** Renders the control with the generated id and aria-describedby wired in. */
  children: (ids: { id: string; describedBy: string | undefined }) => ReactNode;
  className?: string;
  /** Extra element next to the label (e.g. a HelpTip). */
  aside?: ReactNode;
}

/** Label + control + hint, with the accessibility wiring done once. */
export function Field({ label, hint, children, className, aside }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex items-center gap-1.5">
        <Label htmlFor={id}>{label}</Label>
        {aside}
      </div>
      {children({ id, describedBy: hintId })}
      {hint && (
        <p id={hintId} className="text-xs text-fg-3">
          {hint}
        </p>
      )}
    </div>
  );
}
