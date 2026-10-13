import { CircleCheck, RefreshCw } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { updateEventKind, type EngineUpdateCheck } from '../../../contract/engine-updates';
import { useI18n, type Formatters } from '../../i18n';
import { updatePath, useEngineUpdate, useRecheckUpdate } from '../../lib/queries-engines';
import { activeEvent, useInstallEvent, useStartInstall } from '../../lib/queries-library';
import { ErrorCallout } from '../library/error-callout';
import { InstallProgress } from '../setup/install-progress';
import { Button } from '../ui/button';
import { Callout } from '../ui/callout';
import { CodeBlock } from '../ui/code-block';
import { Dialog, DialogClose, DialogContent } from '../ui/dialog';

/** One command line as typed in a terminal (arguments with spaces quoted). */
export function commandLine(argv: readonly string[]): string {
  return argv.map((a) => (/[\s"']/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ');
}

/** "Aggiornamento disponibile: v0.5.21 → v0.5.22 · 9,8 GB", "3 commit nuovi: a1b2c3d → e4f5a6b". */
export function updateHeadline(f: Pick<Formatters, 't' | 'bytes'>, c: EngineUpdateCheck): string {
  const p = { current: c.current ?? '', latest: c.latest ?? '' };
  const text =
    c.method === 'git'
      ? c.commits === 1
        ? f.t('engines.update.commitsOne', p)
        : f.t('engines.update.commits', { ...p, n: c.commits ?? 0 })
      : c.method === 'docker-pull'
        ? f.t('engines.update.availableSame', p)
        : f.t('engines.update.available', p);
  return c.sizeBytes ? f.t('engines.update.withSize', { text, size: f.bytes(c.sizeBytes) }) : text;
}

/** What the update does, in the confirmation. */
function confirmText(t: Formatters['t'], c: EngineUpdateCheck, name: string): string {
  const p = { name, image: c.image ?? '', current: c.current ?? '', latest: c.latest ?? '', repo: c.repo ?? '' };
  if (c.method === 'git') return t('engines.update.confirm.git', p);
  if (c.method === 'uv') return t('engines.update.confirm.uv', p);
  if (c.method === 'docker-tag') return t(c.target.startsWith('custom:') ? 'engines.update.confirm.dockerTagCustom' : 'engines.update.confirm.dockerTag', p);
  return t('engines.update.confirm.dockerPull', p);
}

export interface EngineUpdatePanelProps {
  /** 'sglang-docker', 'vllm-native', 'custom:<id>'… */
  target: string;
  /** The engine's name in the confirmation and the progress. */
  name: string;
  /** False while the engine is not there (the card offers its install): nothing is checked. */
  enabled: boolean;
}

/**
 * "Aggiorna" on an engine card, like llama.cpp's install: whether a newer version exists (and how big
 * it is, or how many commits), the exact commands in a confirmation, then the update with its progress.
 * Engines updated with their own tools get a short note instead.
 */
export function EngineUpdatePanel({ target, name, enabled }: EngineUpdatePanelProps) {
  const { t, bytes } = useI18n();
  const query = useEngineUpdate(target, enabled);
  const recheck = useRecheckUpdate(target);
  const start = useStartInstall();
  const key = updateEventKind(target);
  const event = useInstallEvent(key);
  const [confirm, setConfirm] = useState(false);
  const running = activeEvent(event);
  if (!enabled) return null;
  if (running) return <InstallProgress event={running} label={t('engines.update.progress', { name })} className="w-full" />;

  const version = typeof event?.result?.version === 'string' ? event.result.version : undefined;
  const outcome =
    event?.stage === 'done' ? (
      <p className="text-sm text-success-text">{version ? t('engines.update.done', { version }) : t('engines.update.doneNoVersion')}</p>
    ) : event?.stage === 'error' ? (
      <ErrorCallout error={event.error ?? { code: 'ENGINE_UPDATE_FAILED', message: target }} />
    ) : null;
  const checkButton = (
    <Button size="sm" variant="ghost" className="self-start" disabled={recheck.isPending} onClick={() => recheck.mutate()}>
      <RefreshCw aria-hidden />
      {recheck.isPending ? t('engines.update.checking') : t('engines.update.check')}
    </Button>
  );
  const c = query.data;

  let body: ReactNode = null;
  if (query.isError || recheck.isError) {
    body = (
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-fg-3">{t('engines.update.checkFailed')}</p>
        {checkButton}
      </div>
    );
  } else if (c === undefined || (c.state === 'blocked' && c.reason === 'not-installed')) {
    body = null;
  } else if (c.state === 'none') {
    body = <p className="text-xs text-fg-3">{t(`engines.update.reasons.${c.reason ?? 'tools'}`)}</p>;
  } else if (c.state === 'blocked') {
    const reason = c.reason ?? 'tools';
    body = (
      <div className="flex flex-col gap-2">
        <Callout tone={reason === 'no-docker' || reason === 'busy' ? 'info' : 'warning'} title={t(`engines.update.reasons.${reason}`, { repo: c.repo ?? '', n: c.changed ?? 0, branch: c.branch ?? '' })}>
          {c.detail ? <pre className="font-mono text-xs break-all whitespace-pre-wrap">{c.detail}</pre> : undefined}
        </Callout>
        {checkButton}
      </div>
    );
  } else if (c.state === 'current') {
    body = (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm text-fg-2">
          <CircleCheck aria-hidden className="size-4 text-success-text" />
          {c.current ? t('engines.update.current', { current: c.current }) : t('engines.update.currentNoVersion')}
        </p>
        {checkButton}
      </div>
    );
  } else if (c.state === 'unknown') {
    body = (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-fg-2">{t('engines.update.unknown', { image: c.image ?? '' })}</p>
        <Button size="sm" onClick={() => setConfirm(true)}>
          <RefreshCw aria-hidden />
          {t('engines.update.repull')}
        </Button>
      </div>
    );
  } else {
    body = <Callout tone="info" title={updateHeadline({ t, bytes }, c)} action={{ label: t('engines.update.update'), onClick: () => setConfirm(true) }} />;
  }

  return (
    <div className="flex flex-col gap-2">
      {body}
      {outcome}
      {c && (
        <Dialog open={confirm} onOpenChange={setConfirm}>
          <DialogContent
            title={t('engines.update.confirmTitle', { name })}
            description={confirmText(t, c, name)}
            footer={
              <>
                <DialogClose asChild>
                  <Button>{t('common.cancel')}</Button>
                </DialogClose>
                <Button
                  variant="primary"
                  onClick={() => {
                    setConfirm(false);
                    start.mutate({ key, path: updatePath(target) });
                  }}
                >
                  {c.state === 'unknown' ? t('engines.update.repull') : t('engines.update.update')}
                </Button>
              </>
            }
          >
            {/* The code block names itself ("Comandi che eseguo"). */}
            <CodeBlock single label={t('engines.update.commands')} commands={{ powershell: c.commands.map(commandLine).join('\n'), bash: c.commands.map(commandLine).join('\n') }} />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
