import { useQueryClient } from '@tanstack/react-query';
import { Check, Hammer, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { NinferBuildPlan, NinferBuildRequest, NinferKind } from '../../../contract/ninfer';
import { useI18n } from '../../i18n';
import { activeEvent, useInstallEvent, useStartInstall } from '../../lib/queries-library';
import { refreshEngines, useNinferBuildPlan } from '../../lib/queries-ninfer';
import { SETTINGS_QUERY_KEY } from '../../lib/settings';
import { ErrorCallout } from '../library/error-callout';
import { InstallProgress } from '../setup/install-progress';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Callout } from '../ui/callout';
import { CodeBlock } from '../ui/code-block';
import { Dialog, DialogContent } from '../ui/dialog';
import { Field, Input } from '../ui/input';
import { Skeleton } from '../ui/skeleton';

export interface NinferBuildDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: NinferKind;
  /** ninfer-wsl: the distro picked on the card. */
  distro?: string | undefined;
}

/**
 * "Compila NInfer": the folder, what is missing (with the apt line to copy: LLM Bench never installs
 * system packages), the exact commands, then the build after an explicit confirmation, with progress.
 */
export function NinferBuildDialog({ open, onOpenChange, kind, distro }: NinferBuildDialogProps) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [dir, setDir] = useState('~/ninfer');
  const [req, setReq] = useState<NinferBuildRequest | undefined>(undefined);
  const plan = useNinferBuildPlan(open ? req : undefined);
  const start = useStartInstall();
  const event = useInstallEvent(kind);
  const running = activeEvent(event);
  const where = kind === 'ninfer-wsl' ? t('ninfer.build.whereWsl', { distro: distro ?? '–' }) : t('ninfer.build.whereLinux');
  const check = () => setReq({ kind, dir: dir.trim() || '~/ninfer', ...(kind === 'ninfer-wsl' && distro ? { distro } : {}) });

  // The build saved where NInfer is: the app's copy of the settings is refreshed before anything else saves them.
  const finished = event?.stage === 'done' && start.isSuccess;
  useEffect(() => {
    if (!finished) return;
    void qc.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY });
    refreshEngines(qc);
    toast.success(t('ninfer.build.done', { path: String(event?.result?.ninferPath ?? '') }));
    start.reset();
    onOpenChange(false);
  }, [finished, qc, t, event, start, onOpenChange]);

  const p = plan.data;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="lg"
        title={t('ninfer.build.title')}
        description={t('ninfer.build.description', { where })}
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!p?.ready || running !== undefined || req === undefined}
              // Enabled only with a plan that is ready: the folder it checked (absolute) is the one built.
              onClick={() => start.mutate({ key: kind, path: '/api/engines/ninfer/build', body: { ...req, dir: (p as NinferBuildPlan).dir, confirm: true } })}
            >
              <Hammer aria-hidden />
              {t('ninfer.build.confirm')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label={t('ninfer.build.folder')} hint={t('ninfer.build.folderHint')}>
            {({ id, describedBy }) => (
              <div className="flex gap-2">
                <Input id={id} aria-describedby={describedBy} value={dir} onChange={(e) => setDir(e.target.value)} className="min-w-0 flex-1 font-mono" spellCheck={false} />
                <Button className="shrink-0" onClick={check} disabled={running !== undefined}>
                  {t('ninfer.build.check')}
                </Button>
              </div>
            )}
          </Field>
          {plan.isFetching && <Skeleton className="h-32" />}
          {plan.isError && <ErrorCallout error={plan.error} />}
          {p && !plan.isFetching && (
            <>
              {p.existing && <Callout tone="info" title={t('ninfer.build.existing')} />}
              <section className="flex flex-col gap-2" aria-label={t('ninfer.build.prereqs')}>
                <h3 className="text-sm font-semibold text-fg">{t('ninfer.build.prereqs')}</h3>
                <ul className="grid gap-1.5 sm:grid-cols-2">
                  {p.prereqs.map((r) => (
                    <li key={r.id} className="flex items-center gap-2 text-sm">
                      {r.found ? <Check aria-hidden className="size-4 text-success-text" /> : <X aria-hidden className="size-4 text-danger-text" />}
                      <span className="font-medium text-fg">{t(`ninfer.build.tools.${r.id}`)}</span>
                      <span className="text-fg-3 tabular-nums">{r.version ?? ''}</span>
                      {!r.found && (
                        <Badge size="sm" tone="danger">
                          {r.need ? t('ninfer.build.needs', { version: r.need }) : t('ninfer.build.missing')}
                        </Badge>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
              {p.aptCommand && (
                <Callout tone="warning" title={t('ninfer.build.aptTitle')}>
                  <p className="mb-2">{t('ninfer.build.aptBody', { where })}</p>
                  <CodeBlock single commands={{ bash: p.aptCommand, powershell: p.aptCommand }} defaultShell="bash" label={t('ninfer.build.aptLabel')} />
                </Callout>
              )}
              {p.cudaFromNvidia && <Callout tone="warning" title={t('ninfer.build.cuda')} />}
              <section className="flex flex-col gap-2">
                <CodeBlock single commands={{ bash: p.commands.join('\n'), powershell: p.commands.join('\n') }} defaultShell="bash" label={t('ninfer.build.commands')} />
                <p className="text-xs text-fg-3">{t('ninfer.build.confirmNote', { where })}</p>
              </section>
            </>
          )}
          {running && <InstallProgress event={running} label={t('ninfer.build.running')} />}
          {event?.stage === 'error' && <ErrorCallout error={event.error ?? { code: 'ENGINE_INSTALL_FAILED', message: kind }} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
