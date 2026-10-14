import { useNavigate } from '@tanstack/react-router';
import { Box, Download, Eraser, FolderOpen, Pause, Play, RotateCcw, X } from 'lucide-react';
import { Dialog as D } from 'radix-ui';
import { NINFER_FILE } from '../../../contract/formats';
import type { DownloadJob } from '../../../contract/models';
import { NINFER_ALL_BUILD, NINFER_VARIANT_BUILD } from '../../../contract/ninfer';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/cn';
import {
  installKey,
  isDownloadActive,
  isDownloadFinished,
  useActiveInstalls,
  useClearDownloads,
  useDownloadAction,
  useDownloadJobs,
  useDownloadsPanel,
  useRemoveDownload,
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
  if (e.kind.startsWith('update:')) return t('downloads.kinds.update', { name: e.label ?? e.kind.slice('update:'.length) });
  // NInfer's guided build, NInfer-all's, or a variant's (its name is the event's label).
  if (e.kind === 'ninfer-native' || e.kind === 'ninfer-wsl') return t('ninfer.build.running');
  if (e.kind === NINFER_ALL_BUILD) return t('ninfer.build.runningVariant', { name: 'NInfer-all' });
  if (e.kind === NINFER_VARIANT_BUILD) return t('ninfer.build.runningVariant', { name: e.label ?? 'NInfer' });
  const kinds = ['llamacpp-native', 'docker-desktop', 'docker-restart', 'docker-linux', 'uv', 'vllm-native', 'sglang-native', 'docker-volume'] as const;
  return (kinds as readonly string[]).includes(e.kind) ? t(`downloads.kinds.${e.kind as (typeof kinds)[number]}`) : e.kind;
}

/** A split GGUF's shard suffix ("-00001-of-00003"), and a quant at the end of a GGUF name ("…-UD-Q4_K_XL"). */
const SHARD = /-\d{5}-of-\d{5}$/i;
const QUANT = /(?:^|[-_.])((?:UD-)?I?Q\d[A-Za-z0-9_]*|BF16|F16|F32|MXFP4)$/i;
const MMPROJ = /mmproj/i;

/**
 * What tells a download apart from another with the same name: "GGUF · Q4_K_M · 17,8 GB · 6 ott 2026",
 * "GGUF · parte visione", "safetensors · FP8", "NInfer · <artifact>".
 */
export function jobDetails(job: DownloadJob, i18n: Pick<ReturnType<typeof useI18n>, 't' | 'bytes' | 'date'>): string {
  const names = job.files.map((f) => f.path.split('/').pop() as string);
  const gguf = names.filter((n) => /\.gguf$/i.test(n));
  const ninfer = names.find((n) => NINFER_FILE.test(n));
  const parts: string[] = [];
  if (ninfer) parts.push('NInfer', ninfer.replace(NINFER_FILE, ''));
  else if (gguf.length > 0) {
    parts.push('GGUF');
    const model = gguf.find((n) => !MMPROJ.test(n));
    if (model) {
      const stem = model.replace(/\.gguf$/i, '').replace(SHARD, '');
      parts.push(QUANT.exec(stem)?.[1] ?? stem);
    }
    if (gguf.some((n) => MMPROJ.test(n))) parts.push(i18n.t('downloads.visionPart'));
  } else if (names.some((n) => /\.safetensors$/i.test(n))) {
    parts.push('safetensors');
    // A variant folder of the repo ("FP8/…") names what was fetched.
    const dirs = new Set(job.files.map((f) => (f.path.includes('/') ? f.path.split('/')[0] : '')));
    const dir = dirs.size === 1 ? [...dirs][0] : '';
    if (dir) parts.push(dir);
  }
  const size = job.files.reduce((a, f) => a + (f.sizeBytes ?? 0), 0);
  if (size > 0) parts.push(i18n.bytes(size));
  parts.push(i18n.date(job.createdAt));
  return parts.join(' · ');
}

function JobRow({ job, onOpenModel }: { job: DownloadJob; onOpenModel: (repo: string) => void }) {
  const i18n = useI18n();
  const { t } = i18n;
  const act = useDownloadAction();
  const remove = useRemoveDownload();
  const active = isDownloadActive(job);
  const run = (action: 'pause' | 'resume' | 'cancel') => act.mutate({ id: job.id, action });
  const gated = job.error?.code === 'HF_GATED' || job.error?.code === 'HF_AUTH_REQUIRED';
  return (
    <li className="flex flex-col gap-2.5 px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-semibold text-fg" title={job.label}>
            {job.label}
          </span>
          <span className="truncate text-xs text-fg-2 tabular-nums" title={job.files.map((f) => f.path).join('\n')}>
            {jobDetails(job, i18n)}
          </span>
          <span className="truncate font-mono text-xs text-fg-3" title={job.repo}>
            {job.repo}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Badge tone={STATE_TONE[job.state]} size="sm">
            {t(`downloads.state.${job.state}`)}
          </Badge>
          {isDownloadFinished(job) && (
            <IconButton size="sm" label={t('downloads.remove', { name: job.label })} icon={<X />} onClick={() => remove.mutate(job.id)} disabled={remove.isPending} />
          )}
        </div>
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
        {job.state === 'done' && job.repo && (
          <Button size="sm" variant="ghost" onClick={() => onOpenModel(job.repo as string)}>
            <Box aria-hidden />
            {t('downloads.openModel')}
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
      {remove.isError && <ErrorCallout error={remove.error} />}
    </li>
  );
}

/** Downloads and installs from anywhere: the title bar button opens this side panel. */
export function DownloadsPanel() {
  const { t } = useI18n();
  const [open, setOpen] = useDownloadsPanel();
  const navigate = useNavigate();
  const jobs = useDownloadJobs();
  const clear = useClearDownloads();
  const installs = useActiveInstalls();
  const list = [...(jobs.data ?? [])].sort((a, b) => Number(isDownloadActive(b)) - Number(isDownloadActive(a)) || b.createdAt.localeCompare(a.createdAt));
  const activeCount = installs.length + list.filter(isDownloadActive).length;
  const finished = list.some(isDownloadFinished);
  const openModel = (repo: string) => {
    const [owner, name] = repo.split('/') as [string, string];
    setOpen(false);
    void navigate({ to: '/models/hub/$owner/$name', params: { owner, name } });
  };
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
        {/* Below the 40px title bar: the window's own minimise / maximise / close buttons stay visible and usable. */}
        <D.Overlay className="fixed inset-x-0 top-10 bottom-0 z-50 bg-overlay data-[state=open]:animate-fade-in" />
        <D.Content className="fixed top-10 right-0 bottom-0 z-50 flex w-[min(440px,100vw)] flex-col border-l border-border bg-elevated shadow-lg outline-none data-[state=open]:animate-fade-in">
          <div className="flex items-start justify-between gap-3 border-b border-border px-5 pt-5 pb-4">
            <div>
              <D.Title className="text-lg font-semibold tracking-[-0.01em]">{t('downloads.title')}</D.Title>
              <D.Description className="text-sm text-fg-2">{t('downloads.subtitle')}</D.Description>
            </div>
            <D.Close asChild>
              <IconButton label={t('common.close')} icon={<X />} size="sm" noTooltip />
            </D.Close>
          </div>
          {finished && (
            <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-2">
              <span className="text-xs text-fg-3">{t('downloads.clearHint')}</span>
              <Button size="sm" variant="ghost" onClick={() => clear.mutate()} disabled={clear.isPending}>
                <Eraser aria-hidden />
                {t('downloads.clear')}
              </Button>
            </div>
          )}
          {clear.isError && <ErrorCallout error={clear.error} className="mx-5 mt-3" />}
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
                  <JobRow key={j.id} job={j} onOpenModel={openModel} />
                ))}
              </ul>
            )}
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
