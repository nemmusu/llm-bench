import { Download } from 'lucide-react';
import { useI18n } from '../../i18n';
import { activeEvent, useInstallEvent, useStartInstall } from '../../lib/queries-library';
import { ErrorCallout } from '../library/error-callout';
import { Button } from '../ui/button';
import { InstallProgress } from './install-progress';

export const LLAMA_KEY = 'llamacpp-native';

export interface LlamaInstallProps {
  /** Download size of the build the core would pick (from the system check). */
  bytes?: number | undefined;
  label?: string;
  variant?: 'primary' | 'secondary';
}

/** "Installa · 480 MB": one click downloads and prepares llama.cpp, with progress and errors in place. */
export function LlamaInstall({ bytes, label, variant = 'primary' }: LlamaInstallProps) {
  const { t, bytes: fmt } = useI18n();
  const event = useInstallEvent(LLAMA_KEY);
  const start = useStartInstall();
  const running = activeEvent(event);
  if (running) return <InstallProgress event={running} label={t('setup.items.llamacpp.title')} className="w-full" />;
  const text = label ?? (bytes ? t('setup.actions.withSize', { label: t('setup.actions.install-llamacpp'), size: fmt(bytes) }) : t('setup.actions.install-llamacpp'));
  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        variant={variant}
        size="sm"
        disabled={start.isPending}
        onClick={() => start.mutate({ key: LLAMA_KEY, path: '/api/engines/llamacpp-native/install', body: {} })}
      >
        <Download aria-hidden />
        {text}
      </Button>
      {event?.stage === 'error' && <ErrorCallout error={event.error ?? { code: 'ENGINE_INSTALL_FAILED', message: 'error' }} />}
    </div>
  );
}
