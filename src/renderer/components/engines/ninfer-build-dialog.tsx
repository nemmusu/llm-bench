import { useQueryClient } from '@tanstack/react-query';
import { Check, Hammer, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { GitSource } from '../../../contract/custom-engines';
import { NINFER_DEFAULT_DIR, ninferBuildEventKind, type NinferBuildPlan, type NinferBuildRequest, type NinferKind, type NinferVariantTarget } from '../../../contract/ninfer';
import { useI18n, type Formatters } from '../../i18n';
import { engineKeys } from '../../lib/queries-engines';
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

/** A NInfer variant the build makes: its name, the custom engine it is saved as, where it comes from. */
export type NinferBuildVariant = NinferVariantTarget & { source?: GitSource | undefined };

export interface NinferBuildDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: NinferKind;
  /** ninfer-wsl: the distro picked on the card (the buttons that open a WSL build need one). */
  distro?: string | undefined;
  /** The folder it starts with (~/ninfer, a variant's own; a checkout already there is built in place, nothing downloaded). */
  dir: string;
  /** A variant (NInfer-all, a fork): built from its repository and saved as its custom engine. Absent = the official NInfer. */
  variant?: NinferBuildVariant | undefined;
  /** The build finished and was saved (a variant: its custom engine's id). */
  onBuilt?: (result: { ninferPath: string; customEngineId?: string }) => void;
}

/** "github.com/iamwavecut/ninfer-all" of a clone URL, for the sentence. */
export function repoText(url: string): string {
  return url.replace(/^https:\/\//, '').replace(/\.git$/, '');
}

/** What the build downloads and how long it takes, in words ("Da scaricare: circa 38 MB." "Compilazione: circa 10 minuti con 16 core."). */
export function buildEstimate(p: Pick<NinferBuildPlan, 'existing' | 'downloadBytes' | 'cpus' | 'minutes'>, f: Pick<Formatters, 't' | 'bytes'>): string[] {
  const download = p.existing ? f.t('ninfer.build.nothingToDownload') : p.downloadBytes !== undefined ? f.t('ninfer.build.download', { size: f.bytes(p.downloadBytes) }) : undefined;
  const time = p.cpus ? f.t('ninfer.build.time', { minutes: p.minutes, cpus: p.cpus }) : f.t('ninfer.build.timeNoCpus', { minutes: p.minutes });
  return download ? [download, time] : [time];
}

/**
 * "Scarica e compila NInfer" (or a variant of it, from its repository): the folder, what it downloads
 * and how long it takes, what is missing (with the apt line to copy: LLM Bench never installs system
 * packages), the exact commands, then the build after an explicit confirmation, with progress. The plan
 * is checked as soon as it opens; once built, the build is saved (settings.ninfer, or the variant's
 * custom engine) by the core: nothing else to do.
 */
export function NinferBuildDialog(p: NinferBuildDialogProps) {
  return (
    <Dialog open={p.open} onOpenChange={p.onOpenChange}>
      {/* Mounted only while open: every opening starts from its own folder and checks it at once. */}
      {p.open && <BuildBody {...p} />}
    </Dialog>
  );
}

function BuildBody({ onOpenChange, kind, distro, dir: initialDir, variant, onBuilt }: NinferBuildDialogProps) {
  const f = useI18n();
  const { t } = f;
  const qc = useQueryClient();
  const [dir, setDir] = useState(initialDir);
  const requestFor = (folder: string): NinferBuildRequest => ({
    kind,
    dir: folder.trim() || NINFER_DEFAULT_DIR,
    ...(kind === 'ninfer-wsl' && distro ? { distro } : {}),
    ...(variant?.source ? { source: variant.source } : {}),
    ...(variant ? { variant: { name: variant.name, ...(variant.id ? { id: variant.id } : {}), ...(variant.template ? { template: variant.template } : {}) } } : {}),
  });
  const [req, setReq] = useState<NinferBuildRequest>(() => requestFor(dir));
  const plan = useNinferBuildPlan(req);
  const start = useStartInstall();
  const key = ninferBuildEventKind({ kind, ...(variant ? { variant } : {}) });
  const event = useInstallEvent(key);
  const running = activeEvent(event);
  const where = kind === 'ninfer-wsl' ? t('ninfer.build.whereWsl', { distro: distro as string }) : t('ninfer.build.whereLinux');
  const name = variant?.name ?? 'NInfer';
  const source = variant?.source;

  // The build saved where it is (settings.ninfer, or the variant's custom engine): every copy the app has is read again.
  const finished = event?.stage === 'done' && start.isSuccess;
  useEffect(() => {
    if (!finished) return;
    void qc.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY });
    void qc.invalidateQueries({ queryKey: engineKeys.custom });
    refreshEngines(qc);
    const result = { ninferPath: String(event?.result?.ninferPath ?? ''), ...(typeof event?.result?.customEngineId === 'string' ? { customEngineId: event.result.customEngineId } : {}) };
    toast.success(variant ? t('ninfer.build.doneVariant', { name, path: result.ninferPath }) : t('ninfer.build.done', { path: result.ninferPath }));
    start.reset();
    onBuilt?.(result);
    onOpenChange(false);
  }, [finished, qc, t, event, start, onOpenChange, onBuilt, variant, name]);

  const p = plan.data;
  return (
    <DialogContent
      size="lg"
      title={plan.data?.existing ? t('ninfer.build.titleExisting', { name }) : t('ninfer.build.titleVariant', { name })}
      description={source ? t('ninfer.build.descriptionVariant', { name, repo: repoText(source.url), where }) : t('ninfer.build.description', { where })}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!p?.ready || running !== undefined || plan.isFetching}
            // Enabled only with a plan that is ready: the folder it checked (absolute) is the one built.
            onClick={() => start.mutate({ key, path: '/api/engines/ninfer/build', body: { ...req, dir: (p as NinferBuildPlan).dir, confirm: true } })}
          >
            <Hammer aria-hidden />
            {p?.existing ? t('ninfer.build.confirm') : t('ninfer.build.confirmDownload')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label={t('ninfer.build.folder')} hint={t('ninfer.build.folderHint')}>
          {({ id, describedBy }) => (
            <div className="flex gap-2">
              <Input id={id} aria-describedby={describedBy} value={dir} onChange={(e) => setDir(e.target.value)} className="min-w-0 flex-1 font-mono" spellCheck={false} />
              <Button className="shrink-0" onClick={() => setReq(requestFor(dir))} disabled={running !== undefined}>
                {t('ninfer.build.check')}
              </Button>
            </div>
          )}
        </Field>
        {source && (
          <p className="text-sm text-fg-2">
            {source.branch ? t('ninfer.build.sourceBranch', { repo: repoText(source.url), branch: source.branch }) : t('ninfer.build.source', { repo: repoText(source.url) })}
          </p>
        )}
        {plan.isFetching && <Skeleton className="h-32" />}
        {plan.isError && <ErrorCallout error={plan.error} />}
        {p && !plan.isFetching && <NinferPlanView plan={p} where={where} />}
        {running && <InstallProgress event={running} label={variant ? t('ninfer.build.runningVariant', { name }) : t('ninfer.build.running')} />}
        {event?.stage === 'error' && <ErrorCallout error={event.error ?? { code: 'ENGINE_INSTALL_FAILED', message: kind }} />}
      </div>
    </DialogContent>
  );
}

/** A checked build: what it downloads and how long it takes, what is missing, the exact commands. */
export function NinferPlanView({ plan: p, where }: { plan: NinferBuildPlan; where: string }) {
  const f = useI18n();
  const { t } = f;
  return (
    <>
      {p.otherRepo && <Callout tone="danger" title={t('ninfer.build.otherRepo', { origin: p.otherRepo })} />}
      {p.existing && !p.otherRepo && <Callout tone="info" title={t('ninfer.build.existing')} />}
      <div className="flex flex-col gap-0.5 text-sm text-fg-2">
        {buildEstimate(p, f).map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
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
  );
}
