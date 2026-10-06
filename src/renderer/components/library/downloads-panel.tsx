import { Download, FolderOpen, Pause, Play, RotateCcw, X } from 'lucide-react';
import { Dialog as D } from 'radix-ui';
import type { DownloadJob } from '../../../contract/models';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/cn';
import {
  installKey,
  isDownloadActive,
  useActiveInstalls,
  useDownloadAction,
  useDownloadJobs,
  useDownloadsPanel,
  type InstallEvent,
} from '../../lib/queries-library';
import { InstallProgress } from '../setup/install-progress';
import { Badge } from '../ui/badge';
import { Button, IconButton } from '../ui/button';
import { EmptyState } from '../ui/empty-state';
import { DownloadProgressLine } from './download-progress';
import { ErrorCallout } from './error-callout';
import { repoUrl } from './helpers';

const STATE_TONE: Record<DownloadJob['state'], 'accent' | 'neutral' | 'success' | 'danger' | 'warning'> = {
  queued: 'neutral',
  running: 'accent',
  verifying: 'accent',
  paused: 'warning',
  done: 'success',
  failed: 'danger',
  cancelled: 'neutral',
};

/** What an install-like operation is, in words. */
export function installLabel(t: ReturnType<typeof useI18n>['t'], e: InstallEvent): string {
  if (e.image) return t('downloads.kinds.image', { image: e.image });
  const kinds = ['llamacpp-native', 'docker-desktop', 'docker-linux', 'uv', 'vllm-native', 'docker-volume'] as const;
  return (kinds as readonly string[]).includes(e.kind) ? t(`downloads.kinds.${e.kind as (typeof kinds)[number]}`) : e.kind;
}

function JobRow({ job }: { job: DownloadJob }) {
  const { t } = useI18n();
  const act = useDownloadAction();
  const active = isDownloadActive(job);
  const run = (action: 'pause' | 'resume' | 'cancel') => act.mutate({ id: job.id, action });
  const gated = job.error?.code === 'HF_GATED' || job.error?.code === 'HF_AUTH_REQUIRED';
  return (
    <li className="flex flex-col gap-2.5 px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-semibold text-fg">{job.label}</span>
          <span className="truncate font-mono text-xs text-fg-3">{job.repo}</span>
        </div>
        <Badge tone={STATE_TONE[job.state]} size="sm">
          {t(`downloads.state.${job.state}`)}
        </Badge>
      </div>
      {job.state !== 'done' && job.state !== 'cancelled' && <DownloadProgressLine job={job} />}
      {job.state === 'failed' && job.error && (
        <ErrorCallout
          error={job.error}
          {...(gated ? { action: { label: t('models.detail.acceptLicense'), onClick: () => void window.gpubench?.openExternal(repoUrl(job.repo as string)) } } : {})}
        />
      )}
      <div className="flex flex-wrap gap-2">
        {active && (
          <Button size="sm" onClick={() => run('pause')} disabled={act.isPending}>
            <Pause aria-hidden />
            {t('models.pause')}
          </Button>
        )}
        {(job.state === 'paused' || job.state === 'failed') && (
          <Button size="sm" variant="primary" onClick={() => run('resume')} disabled={act.isPending}>
            {job.state === 'failed' ? <RotateCcw aria-hidden /> : <Play aria-hidden />}
            {job.state === 'failed' ? t('common.retry') : t('models.resume')}
          </Button>
        )}
        {job.state !== 'done' && job.state !== 'cancelled' && (
          <Button size="sm" variant="ghost" onClick={() => run('cancel')} disabled={act.isPending}>
            <X aria-hidden />
            {t('downloads.cancel')}
          </Button>
        )}
        {job.state === 'done' && (
          <Button size="sm" variant="ghost" onClick={() => void window.gpubench?.revealPath(job.dest)}>
            <FolderOpen aria-hidden />
            {t('models.reveal')}
          </Button>
        )}
      </div>
      {act.isError && <ErrorCallout error={act.error} />}
    </li>
  );
}

/** Downloads and installs from anywhere: the title bar button opens this side panel. */
export function DownloadsPanel() {
  const { t } = useI18n();
  const [open, setOpen] = useDownloadsPanel();
  const jobs = useDownloadJobs();
  const installs = useActiveInstalls();
  const list = [...(jobs.data ?? [])].sort((a, b) => Number(isDownloadActive(b)) - Number(isDownloadActive(a)) || b.createdAt.localeCompare(a.createdAt));
  const activeCount = installs.length + list.filter(isDownloadActive).length;
  return (
    <D.Root open={open} onOpenChange={setOpen}>
      <D.Trigger asChild>
        <IconButton
          size="sm"
          label={activeCount > 0 ? t('downloads.buttonActive', { n: activeCount }) : t('downloads.button')}
          icon={
            <span className="relative">
              <Download className={cn(activeCount > 0 && 'text-accent-text')} />
              {activeCount > 0 && (
                <span aria-hidden className="absolute -top-1.5 -right-2 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-accent-solid px-0.5 text-[9px] leading-none font-semibold text-accent-fg">
                  {activeCount}
                </span>
              )}
            </span>
          }
        />
      </D.Trigger>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-overlay data-[state=open]:animate-fade-in" />
        <D.Content className="fixed top-0 right-0 bottom-0 z-50 flex w-[min(440px,100vw)] flex-col border-l border-border bg-elevated shadow-lg outline-none data-[state=open]:animate-fade-in">
          <div className="flex items-start justify-between gap-3 border-b border-border px-5 pt-5 pb-4">
            <div>
              <D.Title className="text-lg font-semibold tracking-[-0.01em]">{t('downloads.title')}</D.Title>
              <D.Description className="text-sm text-fg-2">{t('downloads.subtitle')}</D.Description>
            </div>
            <D.Close asChild>
              <IconButton label={t('common.close')} icon={<X />} size="sm" noTooltip />
            </D.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {installs.length > 0 && (
              <section aria-label={t('downloads.installs')} className="border-b border-border">
                <h3 className="px-5 pt-4 text-xs font-medium text-fg-3">{t('downloads.installs')}</h3>
                <ul className="divide-y divide-border">
                  {installs.map((e) => (
                    <li key={installKey(e)} className="flex flex-col gap-2 px-5 py-4">
                      <span className="font-semibold text-fg">{installLabel(t, e)}</span>
                      <InstallProgress event={e} label={installLabel(t, e)} />
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {list.length === 0 && installs.length === 0 ? (
              <EmptyState illustration="downloads" headingLevel={3} title={t('models.downloadsEmptyTitle')} description={t('models.downloadsEmptyBody')} />
            ) : (
              <ul className="divide-y divide-border" aria-label={t('downloads.title')}>
                {list.map((j) => (
                  <JobRow key={j.id} job={j} />
                ))}
              </ul>
            )}
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
