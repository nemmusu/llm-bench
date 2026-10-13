import { useQueryClient } from '@tanstack/react-query';
import { ArrowUpCircle, ExternalLink, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { AppErrorData } from '../../../contract/errors';
import type { ServerEvent } from '../../../contract/events';
import { NINFER_UPGRADE_DOC, type NinferKind, type NinferUpdateStatus } from '../../../contract/ninfer';
import { useI18n } from '../../i18n';
import { activeEvent, useInstallEvent, useStartInstall } from '../../lib/queries-library';
import { refreshEngines, useNinferUpdateCheck } from '../../lib/queries-ninfer';
import { ErrorCallout } from '../library/error-callout';
import { InstallProgress } from '../setup/install-progress';
import { Button } from '../ui/button';
import { Callout } from '../ui/callout';
import { CodeBlock } from '../ui/code-block';
import { Dialog, DialogContent } from '../ui/dialog';

type InstallEvent = Extract<ServerEvent, { type: 'engine.install' }>;

const short = (sha: string | undefined): string => (sha ?? '').slice(0, 7);
/** Commit titles shown before "e altri N". */
const SHOWN_COMMITS = 5;

/**
 * "Controlla aggiornamenti" on the NInfer card: the commits its checkout is behind (git fetch), the
 * guided "Aggiorna" (exact commands, confirmation, progress), and the library artifacts this build
 * cannot read with NInfer's own upgrade command. Runs only in NInfer's checkout.
 */
export function NinferUpdates({ kind, where }: { kind: NinferKind; where: string }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const check = useNinferUpdateCheck();
  const start = useStartInstall();
  const event = useInstallEvent(kind);
  const [open, setOpen] = useState(false);
  const status = check.data;

  // The update this card started (its POST answered) is over: done → the build is read again, and so is
  // where it stands; error → shown in the dialog until the next attempt.
  const done = start.isSuccess && event?.stage === 'done' ? event : undefined;
  const failure = (start.isSuccess || start.isError) && event?.stage === 'error' ? event.error : undefined;
  const finish = (e: InstallEvent) => {
    refreshEngines(qc);
    toast.success(t('ninfer.update.done', { commit: short(String(e.result?.commit ?? '')) }));
    setOpen(false);
    check.mutate(kind);
    start.reset();
  };
  const confirm = () => start.mutate({ key: kind, path: '/api/engines/ninfer/update', body: { kind, confirm: true } });

  return (
    <section className="flex flex-col gap-2 border-t border-border pt-3" aria-label={t('ninfer.update.title')}>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" onClick={() => check.mutate(kind)} disabled={check.isPending}>
          <RefreshCw aria-hidden />
          {check.isPending ? t('ninfer.update.checking') : t('ninfer.update.check')}
        </Button>
        {status && status.behind > 0 && status.updatable && (
          <Button size="sm" variant="primary" onClick={() => setOpen(true)} disabled={status.dirty.length > 0 || status.ahead > 0}>
            <ArrowUpCircle aria-hidden />
            {t('ninfer.update.open')}
          </Button>
        )}
      </div>
      {check.isError && <ErrorCallout error={check.error} />}
      {status && <UpdateSummary status={status} where={where} />}
      {status && (
        <NinferUpdateDialog open={open} onOpenChange={setOpen} status={status} where={where} onConfirm={confirm} event={activeEvent(event)} failure={failure} starting={start.isPending} />
      )}
      {done && <OnDone event={done} onDone={finish} />}
    </section>
  );
}

/** Calls `onDone` once for a finished update (the toast, the dialog closed, a new check). */
function OnDone({ event, onDone }: { event: InstallEvent; onDone: (e: InstallEvent) => void }) {
  const seen = useRef<InstallEvent | undefined>(undefined);
  useEffect(() => {
    if (seen.current === event) return;
    seen.current = event;
    onDone(event);
  }, [event, onDone]);
  return null;
}

/** Where the checkout stands, in words. */
function UpdateSummary({ status, where }: { status: NinferUpdateStatus; where: string }) {
  const { t } = useI18n();
  if (!status.updatable) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm text-fg-2">{t('ninfer.update.notCheckout')}</p>
        <Artifacts status={status} where={where} />
      </div>
    );
  }
  const more = status.behind - Math.min(status.commits.length, SHOWN_COMMITS);
  return (
    <div className="flex flex-col gap-2">
      {!status.fetched && <Callout tone="warning" title={t('ninfer.update.offline')} />}
      {status.behind === 0 ? (
        <p className="text-sm text-success-text">{t('ninfer.update.upToDate', { commit: short(status.current) })}</p>
      ) : (
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-fg">
            {t(status.behind === 1 ? 'ninfer.update.availableOne' : 'ninfer.update.available', { n: status.behind, from: short(status.current), to: short(status.latest) })}
          </p>
          <ul className="flex flex-col gap-0.5 text-sm text-fg-2">
            {status.commits.slice(0, SHOWN_COMMITS).map((c) => (
              <li key={c.sha} className="flex gap-2">
                <span className="font-mono text-xs text-fg-3 tabular-nums">{short(c.sha)}</span>
                <span className="min-w-0 truncate">{c.title}</span>
              </li>
            ))}
          </ul>
          {more > 0 && <p className="text-xs text-fg-3">{t('ninfer.update.more', { n: more })}</p>}
        </div>
      )}
      {status.dirty.length > 0 && (
        <Callout tone="danger" title={t('ninfer.update.dirtyTitle')}>
          {t('ninfer.update.dirty', { files: status.dirty.join(', ') })}
        </Callout>
      )}
      {status.ahead > 0 && (
        <Callout tone="warning" title={t('ninfer.update.aheadTitle')}>
          {t('ninfer.update.ahead', { n: status.ahead, upstream: status.upstream ?? 'GitHub' })}
        </Callout>
      )}
      <Artifacts status={status} where={where} />
    </div>
  );
}

/** Library artifacts in an older container version, with NInfer's upgrade command. */
function Artifacts({ status, where }: { status: NinferUpdateStatus; where: string }) {
  const { t } = useI18n();
  if (status.artifacts.length === 0) return null;
  return (
    <Callout tone="warning" title={t('ninfer.update.artifactsTitle')}>
      <div className="flex flex-col gap-2">
        <p>{t('ninfer.update.artifactsBody', { needs: status.containerVersion, where })}</p>
        {status.artifacts.map((a) => (
          <div key={a.id} className="flex flex-col gap-1">
            <p className="font-medium text-fg">{t('ninfer.update.artifact', { name: a.name, version: a.version })}</p>
            {a.command ? (
              <CodeBlock single commands={{ bash: a.command, powershell: a.command }} defaultShell="bash" label={t('ninfer.update.artifactCommand')} />
            ) : (
              <p className="text-fg-2">{t('ninfer.update.noTool')}</p>
            )}
          </div>
        ))}
        <Button size="sm" variant="link" className="self-start" onClick={() => void window.gpubench?.openExternal(NINFER_UPGRADE_DOC)}>
          <ExternalLink aria-hidden />
          {t('ninfer.update.artifactsDoc')}
        </Button>
      </div>
    </Callout>
  );
}

export interface NinferUpdateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: NinferUpdateStatus;
  where: string;
  onConfirm: () => void;
  /** The update under way, while it runs. */
  event: InstallEvent | undefined;
  failure: AppErrorData | undefined;
  starting: boolean;
}

/** "Aggiorna NInfer": the exact commands and what happens if the build fails, then the progress. */
export function NinferUpdateDialog({ open, onOpenChange, status, where, onConfirm, event, failure, starting }: NinferUpdateDialogProps) {
  const { t } = useI18n();
  const join = (lines: string[]) => ({ bash: lines.join('\n'), powershell: lines.join('\n') });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="lg"
        title={t('ninfer.update.dialogTitle')}
        description={t('ninfer.update.description', { where, dir: status.dir ?? '' })}
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={onConfirm} disabled={event !== undefined || starting}>
              <ArrowUpCircle aria-hidden />
              {t('ninfer.update.confirm')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-fg">
            {t(status.behind === 1 ? 'ninfer.update.availableOne' : 'ninfer.update.available', { n: status.behind, from: short(status.current), to: short(status.latest) })}
          </p>
          <CodeBlock single commands={join(status.commands)} defaultShell="bash" label={t('ninfer.update.commands')} />
          <div className="flex flex-col gap-1.5">
            <p className="text-sm text-fg-2">{t('ninfer.update.restoreNote')}</p>
            <CodeBlock single commands={join(status.restore)} defaultShell="bash" label={t('ninfer.update.restore')} />
          </div>
          {event && <InstallProgress event={event} label={t('ninfer.update.running')} />}
          {failure && <UpdateFailure error={failure} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Why the update stopped: local changes, or a failed step (and whether NInfer is back as it was). */
export function UpdateFailure({ error }: { error: AppErrorData }) {
  const { t } = useI18n();
  const p = error.params ?? {};
  if (p.reason === 'ninfer_dirty') {
    return (
      <Callout tone="danger" title={t('ninfer.update.dirtyTitle')}>
        {t('ninfer.update.dirty', { files: String(p.files ?? '') })}
      </Callout>
    );
  }
  if (p.reason === 'ninfer_update') {
    return (
      <Callout tone="danger" title={t('ninfer.update.failedTitle')}>
        <p>{p.restored === true ? t('ninfer.update.restored', { commit: short(String(p.commit ?? '')) }) : t('ninfer.update.notRestored')}</p>
        {error.detail && (
          <pre role="region" tabIndex={0} aria-label={t('ninfer.update.log')} className="mt-2 max-h-40 overflow-auto rounded-md bg-surface-2 p-2 font-mono text-xs whitespace-pre-wrap text-fg-2 focus-ring">
            {error.detail}
          </pre>
        )}
      </Callout>
    );
  }
  return <ErrorCallout error={error} />;
}
