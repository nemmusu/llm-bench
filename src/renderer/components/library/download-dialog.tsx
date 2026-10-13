import { useNavigate } from '@tanstack/react-router';
import { Download } from 'lucide-react';
import { toast } from 'sonner';
import type { DownloadRequest } from '../../../contract/api';
import type { DownloadJob, DownloadPlan } from '../../../contract/models';
import { useI18n, type Formatters } from '../../i18n';
import { useDownloadPlan, useDownloadsPanel, useMainGpu, useStartDownload, useSystemCheck, useSystemInfo, useTried } from '../../lib/queries-library';
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
  /** A local model the files belong with (an update, its mmproj): they go into its folder. */
  into?: string | undefined;
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

/** The request a choice makes (also what its plan is asked for). */
function requestOf(c: DownloadChoice): DownloadRequest {
  return { repo: c.repo, revision: c.revision ?? 'main', files: c.files, label: c.label, ...(c.into ? { into: c.into } : {}) };
}

/** What the plan fetches, in words: "la parte visione (mmproj)", "la testa MTP", else the file names. */
function whatOf(t: Formatters['t'], files: DownloadPlan['files']): string {
  return files.map((f) => (f.kind === 'mmproj' || f.kind === 'mtp' ? t(`downloads.what.${f.kind}`) : (f.path.split('/').pop() as string))).join(', ');
}

/**
 * What the PC already has of the request: "Il modello è già sul PC: scarico solo la parte visione (mmproj)
 * (0,9 GB)", that there is nothing to fetch, that files already there are checked first, that an update
 * keeps the file until the new one is verified.
 */
function PlanNotes({ plan, onPc }: { plan: DownloadPlan; onPc: boolean }) {
  const { t, bytes } = useI18n();
  const fetch = plan.files.filter((f) => f.local === 'get' || f.local === 'update');
  const checking = plan.files.filter((f) => f.local === 'check').reduce((a, f) => a + f.sizeBytes, 0);
  return (
    <>
      {onPc &&
        (fetch.length > 0 ? (
          <Callout tone="info" title={t('downloads.confirm.alreadyHere', { what: whatOf(t, fetch), size: bytes(plan.bytesToGet) })} />
        ) : (
          checking === 0 && <Callout tone="success" title={t('downloads.confirm.nothing')} />
        ))}
      {checking > 0 && <p className="text-fg-2">{t('downloads.confirm.checkNote', { size: bytes(checking) })}</p>}
      {plan.files.some((f) => f.local === 'update') && <p className="text-fg-2">{t('downloads.confirm.updateNote')}</p>}
    </>
  );
}

function Body({ choice, plan, size }: { choice: DownloadChoice; plan: DownloadPlan | undefined; size: number }) {
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
  const tooBig = freeGb !== undefined && size > freeGb * GIB;
  // The folder the core picked (the one already holding the model), else where the library puts it.
  const dest = plan?.dest ?? (modelsDir ? destinationOf(modelsDir, choice.repo) : undefined);
  return (
    <div className="flex flex-col gap-4 text-sm">
      {/* Adding to a model of the PC (an update, its mmproj), or a request whose files are partly here. */}
      {plan && <PlanNotes plan={plan} onPc={choice.into !== undefined || plan.bytesHave > 0} />}
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
        <dt className="text-fg-3">{t('downloads.confirm.size')}</dt>
        <dd className="font-semibold text-fg tabular-nums">{bytes(size)}</dd>
        <dt className="text-fg-3">{t('downloads.confirm.free')}</dt>
        <dd className="text-fg tabular-nums">{freeGb === undefined ? '–' : `${number(freeGb, 0)} GB`}</dd>
        <dt className="text-fg-3">{t('downloads.confirm.dest')}</dt>
        <dd className="font-mono text-xs break-all text-fg">{dest ?? '–'}</dd>
      </dl>
      {best &&
        (best.tps !== undefined ? (
          <Callout tone="info" title={t('downloads.confirm.tried', { tps: number(best.tps, 0), date: date(best.date) })} />
        ) : (
          <Callout tone="warning" title={t('tried.spillTooltip', { date: date(best.date) })} />
        ))}
      {tooBig && (
        <Callout tone="danger" title={t('downloads.confirm.noSpace')} action={{ label: t('downloads.confirm.changeFolder'), onClick: () => void navigate({ to: '/settings' }) }}>
          {t('downloads.confirm.noSpaceBody', { size: bytes(size) })}
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
  const plan = useDownloadPlan(choice ? requestOf(choice) : undefined).data;
  // Part of it already on the PC: only what is not there yet counts (the plan). Else the size the choice showed.
  const partly = plan !== undefined && plan.files.some((f) => f.local !== 'get');
  const size = partly ? plan.bytesToGet : (choice?.sizeBytes ?? 0);
  const tooBig = choice !== undefined && disk?.params.freeGb !== undefined && size > Number(disk.params.freeGb) * GIB;
  const nothing = plan !== undefined && plan.files.every((f) => f.local === 'have');

  const confirm = (c: DownloadChoice) =>
    start.mutate(
      requestOf(c),
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
              <Button variant="primary" disabled={tooBig || nothing || start.isPending} onClick={() => confirm(choice)}>
                <Download aria-hidden />
                {nothing ? t('downloads.confirm.nothingButton') : t('downloads.confirm.go', { size: bytes(size) })}
              </Button>
            </>
          }
        >
          <Body choice={choice} plan={plan} size={size} />
          {start.isError && <ErrorCallout error={start.error} className="mt-4" />}
        </DialogContent>
      )}
    </Dialog>
  );
}
