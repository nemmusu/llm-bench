import { X } from 'lucide-react';
import { AlertDialog as A, Dialog as D } from 'radix-ui';
import type { ReactNode } from 'react';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/cn';
import { Button, IconButton } from './button';

const overlayClass = 'fixed inset-0 z-50 bg-overlay backdrop-blur-[2px] data-[state=open]:animate-fade-in';
const contentClass =
  'fixed top-1/2 left-1/2 z-50 flex max-h-[85vh] w-[calc(100vw-48px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-border bg-elevated shadow-lg outline-none data-[state=open]:animate-pop-in';

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

export interface DialogContentProps {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
  /** Tailwind max-width class, e.g. "max-w-xl". */
  size?: 'sm' | 'md' | 'lg' | 'xl';
}

const sizes = { sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' } as const;

/** Modal panel with title, optional description, scrollable body and footer. */
export function DialogContent({ title, description, children, footer, className, size = 'md' }: DialogContentProps) {
  const { t } = useI18n();
  return (
    <D.Portal>
      <D.Overlay className={overlayClass} />
      <D.Content className={cn(contentClass, sizes[size], className)} {...(description ? {} : { 'aria-describedby': undefined })}>
        <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-2">
          <div className="flex flex-col gap-1">
            <D.Title className="text-lg font-semibold tracking-[-0.01em]">{title}</D.Title>
            {description && <D.Description className="text-sm text-fg-2">{description}</D.Description>}
          </div>
          <D.Close asChild>
            <IconButton label={t('common.close')} icon={<X />} size="sm" noTooltip className="-mr-2" />
          </D.Close>
        </div>
        {children && <div className="min-h-0 flex-1 overflow-y-auto px-6 py-3">{children}</div>}
        {footer && <div className="flex justify-end gap-2 border-t border-border px-6 py-4">{footer}</div>}
      </D.Content>
    </D.Portal>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  tone?: 'danger' | 'primary';
}

/** Blocking yes/no question (Radix AlertDialog): focus starts on the safe choice. */
export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel, cancelLabel, onConfirm, tone = 'danger' }: ConfirmDialogProps) {
  return (
    <A.Root open={open} onOpenChange={onOpenChange}>
      <A.Portal>
        <A.Overlay className={overlayClass} />
        <A.Content className={cn(contentClass, 'max-w-md p-6')}>
          <A.Title className="text-lg font-semibold tracking-[-0.01em]">{title}</A.Title>
          <A.Description className="mt-2 text-sm text-fg-2">{description}</A.Description>
          <div className="mt-6 flex justify-end gap-2">
            <A.Cancel asChild>
              <Button variant="secondary">{cancelLabel}</Button>
            </A.Cancel>
            <A.Action asChild>
              <Button variant={tone} onClick={onConfirm}>
                {confirmLabel}
              </Button>
            </A.Action>
          </div>
        </A.Content>
      </A.Portal>
    </A.Root>
  );
}
