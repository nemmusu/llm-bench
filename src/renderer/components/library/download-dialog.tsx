import { useNavigate } from '@tanstack/react-router';
import { Download } from 'lucide-react';
import { toast } from 'sonner';
import type { DownloadJob } from '../../../contract/models';
import { useI18n } from '../../i18n';
import { useDownloadsPanel, useMainGpu, useStartDownload, useSystemCheck, useSystemInfo, useTried } from '../../lib/queries-library';
import { useSettings } from '../../lib/settings';
import { Button } from '../ui/button';
import { Callout } from '../ui/callout';
import { Dialog, DialogClose, DialogContent } from '../ui/dialog';
import { ErrorCallout } from './error-callout';
import { bestRunHere } from './helpers';

export interface DownloadChoice {
  repo: string;
  revision?: string;
  /** Files to fetch (all split parts); ["*"] = the whole repo for vLLM. */
  files: string[];
  /** What the user is downloading, e.g. "Qwen3 4B · Q4_K_M". */
  label: string;
  sizeBytes: number;
  /** Identity of the model a download would produce, for "già provato". */
  weakKey: string;
  sha256?: string | undefined;
}

export interface DownloadDialogProps {
  choice: DownloadChoice | undefined;
  onOpenChange: (open: boolean) => void;
  onStarted?: (job: DownloadJob) => void;
}

const GIB = 1024 ** 3;

/** Destination folder as the user will find it: <models folder>/<owner>/<name>. */
export function destinationOf(modelsDir: string, repo: string): string {
  const sep = modelsDir.includes('\\') ? '\\' : '/';
  return [modelsDir.replace(/[\\/]+$/, ''), ...repo.split('/')].join(sep);
}

function Body({ choice }: { choice: DownloadChoice }) {
  const { t, bytes, number, date } = useI18n();
  const navigate = useNavigate();
  const { settings } = useSettings();
  const system = useSystemInfo();
  const disk = useSystemCheck().data?.items.find((i) => i.id === 'disk');
  const tried = useTried(choice.weakKey, choice.sha256);
  const gpu = useMainGpu();
  const best = bestRunHere(tried.data, gpu);
  const freeGb = disk?.params.freeGb === undefined ? undefined : Number(disk.params.freeGb);
  const modelsDir = settings.modelsDir || system.data?.paths.modelsDir;
  const tooBig = freeGb !== undefined && choice.sizeBytes > freeGb * GIB;
  return (
    <div className="flex flex-col gap-4 text-sm">
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
        <dt className="text-fg-3">{t('downloads.confirm.size')}</dt>
        <dd className="font-semibold text-fg tabular-nums">{bytes(choice.sizeBytes)}</dd>
        <dt className="text-fg-3">{t('downloads.confirm.free')}</dt>
        <dd className="text-fg tabular-nums">{freeGb === undefined ? '–' : `${number(freeGb, 0)} GB`}</dd>
        <dt className="text-fg-3">{t('downloads.confirm.dest')}</dt>
        <dd className="font-mono text-xs break-all text-fg">{modelsDir ? destinationOf(modelsDir, choice.repo) : '–'}</dd>
      </dl>
      {best && <Callout tone="info" title={t('downloads.confirm.tried', { tps: number(best.tps, 0), date: date(best.date) })} />}
      {tooBig && (
        <Callout tone="danger" title={t('downloads.confirm.noSpace')} action={{ label: t('downloads.confirm.changeFolder'), onClick: () => void navigate({ to: '/settings' }) }}>
          {t('downloads.confirm.noSpaceBody', { size: bytes(choice.sizeBytes) })}
        </Callout>
      )}
      <p className="text-fg-2">{t('downloads.confirm.resumeNote')}</p>
    </div>
  );
}

/** "Scarico 4,9 GB, va bene?": size, free space, destination and "already measured" before any byte moves. */
export function DownloadDialog({ choice, onOpenChange, onStarted }: DownloadDialogProps) {
  const { t, bytes } = useI18n();
  const start = useStartDownload();
  const [, setPanel] = useDownloadsPanel();
  const disk = useSystemCheck().data?.items.find((i) => i.id === 'disk');
  const tooBig = choice !== undefined && disk?.params.freeGb !== undefined && choice.sizeBytes > Number(disk.params.freeGb) * GIB;

  const confirm = (c: DownloadChoice) =>
    start.mutate(
      { repo: c.repo, revision: c.revision ?? 'main', files: c.files, label: c.label },
      {
        onSuccess: (job) => {
          onOpenChange(false);
          onStarted?.(job);
          toast.success(t('downloads.started', { name: c.label }), { action: { label: t('downloads.open'), onClick: () => setPanel(true) } });
        },
      },
    );

  return (
    <Dialog
      open={choice !== undefined}
      onOpenChange={(o) => {
        // Only closing reaches here (the dialog has no trigger): forget a failed attempt.
        start.reset();
        onOpenChange(o);
      }}
    >
      {choice && (
        <DialogContent
          title={t('downloads.confirm.title', { name: choice.label })}
          description={choice.repo}
          footer={
            <>
              <DialogClose asChild>
                <Button>{t('common.cancel')}</Button>
              </DialogClose>
              <Button variant="primary" disabled={tooBig || start.isPending} onClick={() => confirm(choice)}>
                <Download aria-hidden />
                {t('downloads.confirm.go', { size: bytes(choice.sizeBytes) })}
              </Button>
            </>
          }
        >
          <Body choice={choice} />
          {start.isError && <ErrorCallout error={start.error} className="mt-4" />}
        </DialogContent>
      )}
    </Dialog>
  );
}
