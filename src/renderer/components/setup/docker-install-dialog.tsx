import { ShieldCheck } from 'lucide-react';
import type { SystemCheckReport } from '../../../contract/views';
import { useI18n } from '../../i18n';
import { useDockerPlan, useLinuxScript } from '../../lib/queries-library';
import { ErrorCallout } from '../library/error-callout';
import { Button } from '../ui/button';
import { Callout } from '../ui/callout';
import { Dialog, DialogClose, DialogContent } from '../ui/dialog';
import { Skeleton } from '../ui/skeleton';

export interface DockerInstallDialogProps {
  platform: SystemCheckReport['platform'];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

function WindowsPlan() {
  const { t, bytes } = useI18n();
  const plan = useDockerPlan(true);
  if (plan.isError) return <ErrorCallout error={plan.error} />;
  const p = plan.data;
  if (!p) return <Skeleton className="h-24" />;
  if (p.kind !== 'docker-desktop' || !p.supported) return <Callout tone="warning" title={t('docker.install.unsupported')} />;
  return (
    <div className="flex flex-col gap-3 text-sm text-fg-2">
      <p>{t('docker.install.body')}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-fg-3">{t('docker.install.size')}</dt>
        <dd className="font-medium text-fg tabular-nums">{p.sizeBytes ? bytes(p.sizeBytes) : '–'}</dd>
        <dt className="text-fg-3">{t('docker.install.source')}</dt>
        <dd className="truncate font-mono text-xs text-fg">{new URL(p.url).host}</dd>
      </dl>
      {!p.wsl.available && <Callout tone="info" title={t('docker.install.wslMissing')} />}
      {p.wsl.meetsDockerMinimum === false && <Callout tone="info" title={t('docker.install.wslOld')} />}
      <p className="flex items-start gap-2">
        <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-accent-text" />
        {t('docker.install.uac')}
      </p>
    </div>
  );
}

function LinuxPlan() {
  const { t } = useI18n();
  const script = useLinuxScript(true);
  if (script.isError) return <ErrorCallout error={script.error} />;
  const s = script.data;
  if (!s) return <Skeleton className="h-40" />;
  return (
    <div className="flex flex-col gap-3 text-sm text-fg-2">
      <p>{t('docker.linux.body')}</p>
      <ol className="list-decimal space-y-0.5 pl-5">
        {s.steps.map((step) => (
          <li key={step}>{t(`docker.linux.steps.${step as 'prepare'}`)}</li>
        ))}
      </ol>
      <details className="rounded-lg border border-border bg-surface-2">
        <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-fg focus-ring rounded-lg">{t('docker.linux.showScript')}</summary>
        <pre tabIndex={0} aria-label={t('docker.linux.script')} className="max-h-72 overflow-auto border-t border-border p-3 font-mono text-xs leading-5 text-fg focus-ring">
          {s.script}
        </pre>
      </details>
      <p className="flex items-start gap-2">
        <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-accent-text" />
        {t('docker.linux.password')}
      </p>
    </div>
  );
}

/**
 * Asks before installing Docker: Windows shows size and what Windows will ask (UAC); Linux shows
 * the exact script that will run as administrator, before any password prompt.
 */
export function DockerInstallDialog({ platform, open, onOpenChange, onConfirm }: DockerInstallDialogProps) {
  const { t } = useI18n();
  const linux = platform === 'linux';
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={t(linux ? 'docker.linux.title' : 'docker.install.title')}
        size="lg"
        footer={
          <>
            <DialogClose asChild>
              <Button>{t('common.cancel')}</Button>
            </DialogClose>
            <Button
              variant="primary"
              onClick={() => {
                onOpenChange(false);
                onConfirm();
              }}
            >
              {t(linux ? 'docker.linux.confirm' : 'docker.install.confirm')}
            </Button>
          </>
        }
      >
        {linux ? <LinuxPlan /> : <WindowsPlan />}
      </DialogContent>
    </Dialog>
  );
}
