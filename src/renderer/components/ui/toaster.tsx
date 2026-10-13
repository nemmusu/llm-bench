import { Toaster as Sonner } from 'sonner';
import { useI18n } from '../../i18n';
import type { ResolvedTheme } from '../../lib/theme';

/** App-wide toasts, styled with our tokens so they match both themes. */
export function Toaster({ theme }: { theme: ResolvedTheme }) {
  const { t } = useI18n();
  return (
    <Sonner
      theme={theme}
      position="bottom-right"
      offset={20}
      gap={8}
      toastOptions={{
        // The × of toasts that stay until closed (app-notices.tsx), in the app's language.
        closeButtonAriaLabel: t('common.close'),
        classNames: {
          toast:
            '!rounded-lg !border !border-border !bg-elevated !text-fg !shadow-lg !font-sans !text-sm !gap-2.5 !px-4 !py-3',
          description: '!text-fg-2',
          success: '[&_[data-icon]]:!text-success',
          error: '[&_[data-icon]]:!text-danger',
          warning: '[&_[data-icon]]:!text-warning',
          info: '[&_[data-icon]]:!text-info',
          actionButton: '!bg-accent-solid !text-accent-fg',
        },
      }}
    />
  );
}
