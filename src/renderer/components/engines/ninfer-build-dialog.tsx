import { useQueryClient } from '@tanstack/react-query';
import { Hammer } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { GitSource } from '../../../contract/custom-engines';
import { NINFER_DEFAULT_DIR, ninferBuildEventKind, type NinferBuildPlan, type NinferBuildRequest, type NinferKind, type NinferVariantTarget } from '../../../contract/ninfer';
import { useI18n } from '../../i18n';
import { useApi } from '../../lib/api-context';
import { activeEvent, useInstallEvent, useStartInstall } from '../../lib/queries-library';
import { refreshAfterBuild, useNinferBuildPlan } from '../../lib/queries-ninfer';
import { ErrorCallout } from '../library/error-callout';
import { Button } from '../ui/button';
import { Dialog, DialogContent } from '../ui/dialog';
import { Field, Input } from '../ui/input';
import { Skeleton } from '../ui/skeleton';
import { buildEstimate, BuildFailure, BuildProgress, cancelNinferBuild, PlanCommands, PlanNeeds } from './ninfer-guided';

/** A NInfer variant the build makes: its name, the custom engine it is saved as, where it comes from. */
export type NinferBuildVariant = NinferVariantTarget & { source?: GitSource | undefined };

export interface NinferBuildDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: NinferKind;
  /** ninfer-wsl: the distro picked on the card (the buttons that open a WSL build need one). */
  distro?: string | undefined;
  /** The folder it starts with (its own; a checkout already there is built in place, nothing downloaded). */
  dir: string;
  /** The variant (a fork of the user's): built from its repository and saved as its custom engine. */
  variant: NinferBuildVariant;
  /** The build finished and was saved (its custom engine's id). */
  onBuilt?: (result: { ninferPath: string; customEngineId?: string }) => void;
}

/** "github.com/iamwavecut/ninfer-all" of a clone URL, for the sentence. */
export function repoText(url: string): string {
  return url.replace(/^https:\/\//, '').replace(/\.git$/, '');
}

/**
 * "Scarica e compila" a variant of NInfer (a fork of the user's, "Motori personalizzati"; the official
 * build and NInfer-all are built from NInfer's own card): the folder, what it downloads and how long it
 * takes, what is missing (with the apt line to copy: LLM Bench never installs system packages), the
 * exact commands, then the build after an explicit confirmation, with progress and "Annulla". The plan
 * is checked as soon as it opens; once built, the variant's custom engine is saved by the core.
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
  const api = useApi();
  const [dir, setDir] = useState(initialDir);
  const requestFor = (folder: string): NinferBuildRequest => ({
    kind,
    dir: folder.trim() || NINFER_DEFAULT_DIR,
    ...(kind === 'ninfer-wsl' && distro ? { distro } : {}),
    ...(variant.source ? { source: variant.source } : {}),
    variant: { name: variant.name, ...(variant.id ? { id: variant.id } : {}), ...(variant.template ? { template: variant.template } : {}) },
  });
  const [req, setReq] = useState<NinferBuildRequest>(() => requestFor(dir));
  const plan = useNinferBuildPlan(req);
  const start = useStartInstall();
  const key = ninferBuildEventKind(req);
  const event = useInstallEvent(key);
  const running = activeEvent(event);
  const where = kind === 'ninfer-wsl' ? t('ninfer.build.whereWsl', { distro: distro as string }) : t('ninfer.build.whereLinux');
  const { name, source } = variant;

  // The variant saved as its custom engine: every copy the app has is read again.
  const finished = event?.stage === 'done' && start.isSuccess;
  useEffect(() => {
    if (!finished) return;
    refreshAfterBuild(qc);
    const result = { ninferPath: String(event?.result?.ninferPath ?? ''), ...(typeof event?.result?.customEngineId === 'string' ? { customEngineId: event.result.customEngineId } : {}) };
    toast.success(t('ninfer.build.doneVariant', { name, path: result.ninferPath }));
    start.reset();
    onBuilt?.(result);
    onOpenChange(false);
  }, [finished, qc, t, event, start, onOpenChange, onBuilt, name]);

  const p = plan.data;
  return (
    <DialogContent
      size="lg"
      title={p?.existing ? t('ninfer.build.titleExisting', { name }) : t('ninfer.build.titleVariant', { name })}
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
        {running && <BuildProgress event={running} label={t('ninfer.build.runningVariant', { name })} onCancel={() => cancelNinferBuild(api)} />}
        {event?.stage === 'error' && <BuildFailure error={event.error ?? { code: 'ENGINE_INSTALL_FAILED', message: kind }} where={where} />}
      </div>
    </DialogContent>
  );
}

/** A checked build: what it downloads and how long it takes, what is missing, the exact commands. */
export function NinferPlanView({ plan: p, where }: { plan: NinferBuildPlan; where: string }) {
  const f = useI18n();
  return (
    <>
      <div className="flex flex-col gap-0.5 text-sm text-fg-2">
        {buildEstimate(p, f).map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
      <PlanNeeds plan={p} where={where} />
      <PlanCommands plan={p} where={where} />
    </>
  );
}
