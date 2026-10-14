/**
 * "Questo modello funziona solo con NInfer-all": what to show when a model needs NInfer-all and it is not
 * built yet, like "Serve Docker" — in the start flow (then the benchmark or the server starts by
 * itself), from the Benchmark page and from a failed run. It checks at once what the build needs inside
 * the distro, says in one sentence what it will do ("Lo scarico (~38 MB) e lo compilo io dentro
 * Ubuntu-24.04 (~10 min)"), lists what is missing with the exact "sudo apt install …" line to copy and
 * "Ricontrolla", then builds with its progress; once built, `onReady`. No repository or branch to fill
 * in: the folder and the commands are under "Avanzate".
 */
import { Check, Download, Hammer, RotateCcw } from 'lucide-react';
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react';
import { NINFER_ALL_DIR, NINFER_ALL_SOURCE } from '../../../contract/custom-engines';
import { useI18n } from '../../i18n';
import { useNinferDistro, useNinferDistros, useNinferKind } from '../../lib/queries-ninfer';
import { useSettings } from '../../lib/settings';
import { ErrorCallout } from '../library/error-callout';
import { Button } from '../ui/button';
import { Dialog, DialogContent } from '../ui/dialog';
import { Field, Input } from '../ui/input';
import { repoText } from './ninfer-build-dialog';
import { BuildFailure, BuildProgress, Checking, PlanCommands, PlanNeeds, useGuidedBuild } from './ninfer-guided';

export interface NinferGate {
  view: 'no-wsl' | 'checking' | 'plan-error' | 'needs' | 'ready' | 'building' | 'failed';
  title: string;
  description?: string;
  body: ReactNode;
  /** The button that moves it forward (none while it builds, or where nothing can be done from here). */
  actions: ReactNode;
}

export function useNinferAllGate({ onReady }: { onReady: () => void }): NinferGate {
  const { t, bytes } = useI18n();
  const kind = useNinferKind();
  const { settings } = useSettings();
  const wsl = kind === 'ninfer-wsl';
  const distros = useNinferDistros(wsl);
  const distro = useNinferDistro(kind, settings.ninfer?.wsl?.distro);
  const [folder, setFolder] = useState('');
  // Built: carry on with what needed it (the guided build calls it once, from its own effect).
  // Shown only where NInfer runs (a NInfer launch asked for it): Linux, or a WSL distro on Windows.
  const guided = useGuidedBuild({ kind: kind ?? 'ninfer-native', distro, build: 'all', dir: folder.trim() || undefined, onDone: onReady });
  const canCheck = kind !== undefined && (!wsl || distro !== undefined);
  // What the build needs is checked as soon as the gate shows (read-only).
  const asked = useRef(false);
  const firstCheck = useEffectEvent(() => void guided.check());
  useEffect(() => {
    if (!canCheck || asked.current) return;
    asked.current = true;
    firstCheck();
  }, [canCheck]);

  const title = t('ninfer.gate.title');
  const where = wsl ? t('ninfer.build.whereWsl', { distro: distro ?? '–' }) : t('ninfer.build.whereLinux');
  const why = <p className="text-sm text-fg-2">{t('ninfer.gate.why')}</p>;
  const recheck = (
    <Button variant="primary" onClick={() => void guided.check()}>
      <RotateCcw aria-hidden />
      {t('ninfer.builds.recheck')}
    </Button>
  );
  const advanced = (
    <details className="text-sm">
      <summary className="cursor-pointer rounded-xs text-fg-2 select-none hover:text-fg focus-ring">{t('ninfer.builds.advanced')}</summary>
      <div className="mt-2 flex flex-col gap-3">
        <p className="text-sm text-fg-2">{t('ninfer.builds.sourceBranch', { repo: repoText(NINFER_ALL_SOURCE.url), branch: NINFER_ALL_SOURCE.branch as string })}</p>
        <Field label={t('ninfer.build.folder')} hint={t('ninfer.gate.folderHint')}>
          {({ id, describedBy }) => (
            <div className="flex gap-2">
              <Input id={id} aria-describedby={describedBy} value={folder} onChange={(e) => setFolder(e.target.value)} placeholder={NINFER_ALL_DIR} className="min-w-0 flex-1 font-mono" spellCheck={false} />
              <Button className="shrink-0" onClick={() => void guided.check()}>
                {t('ninfer.build.check')}
              </Button>
            </div>
          )}
        </Field>
        {guided.plan && <PlanCommands plan={guided.plan} where={where} />}
      </div>
    </details>
  );

  // WSL without a distro to build in: how to get one.
  if (wsl && distros.isSuccess && distro === undefined) return { view: 'no-wsl', title, description: t('ninfer.distro.noWsl'), body: why, actions: null };
  if (guided.running) {
    return {
      view: 'building',
      title: t('ninfer.gate.buildingTitle'),
      description: t('ninfer.gate.buildingBody'),
      body: <BuildProgress event={guided.running} label={t('ninfer.builds.building', { name: 'NInfer-all' })} onCancel={guided.cancel} />,
      actions: null,
    };
  }
  const plan = guided.plan;
  if (guided.failed && !guided.checking && plan?.ready) {
    return {
      view: 'failed',
      title: t('ninfer.gate.failedTitle'),
      body: (
        <div className="flex flex-col gap-3">
          <BuildFailure error={guided.failed} where={where} />
          {advanced}
        </div>
      ),
      actions: (
        <Button variant="primary" onClick={() => void guided.run()}>
          <RotateCcw aria-hidden />
          {t('common.retry')}
        </Button>
      ),
    };
  }
  if (guided.checking || (!plan && !guided.planError)) return { view: 'checking', title, body: <div className="flex flex-col gap-3">{why}<Checking where={where} /></div>, actions: null };
  if (!plan) {
    return { view: 'plan-error', title, body: <div className="flex flex-col gap-3">{why}<ErrorCallout error={guided.planError!} /></div>, actions: recheck };
  }
  if (!plan.ready) {
    return {
      view: 'needs',
      title,
      description: t('ninfer.gate.needsBody', { where }),
      body: (
        <div className="flex flex-col gap-3">
          {why}
          <PlanNeeds plan={plan} where={where} compact />
          {advanced}
        </div>
      ),
      actions: recheck,
    };
  }
  const minutes = plan.minutes;
  const description = plan.existing
    ? t('ninfer.gate.readyExisting', { where, minutes })
    : plan.downloadBytes !== undefined
      ? t('ninfer.gate.ready', { size: bytes(plan.downloadBytes), where, minutes })
      : t('ninfer.gate.readyNoSize', { where, minutes });
  return {
    view: 'ready',
    title,
    description,
    body: (
      <div className="flex flex-col gap-3">
        {why}
        <p className="flex items-center gap-2 text-sm text-success-text">
          <Check aria-hidden className="size-4" />
          {t('ninfer.gate.allThere')}
        </p>
        {advanced}
      </div>
    ),
    actions: (
      <Button variant="primary" onClick={() => guided.begin(plan)}>
        {plan.existing ? <Hammer aria-hidden /> : <Download aria-hidden />}
        {plan.existing ? t('ninfer.gate.build') : t('ninfer.gate.download')}
      </Button>
    ),
  };
}

/** The gate as a dialog's content (the start flow's step, NinferAllGateDialog). */
export function NinferGateContent({ onReady, onClose }: { onReady: () => void; onClose: () => void }) {
  const { t } = useI18n();
  const gate = useNinferAllGate({ onReady });
  return (
    <DialogContent
      title={gate.title}
      description={gate.description}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>{gate.view === 'building' ? t('ninfer.gate.background') : t('common.cancel')}</Button>
          {gate.actions}
        </>
      }
    >
      {gate.body}
    </DialogContent>
  );
}

/**
 * The gate in its own dialog (the Benchmark page's "Funziona con NInfer-all", a failed run's "Scarica e
 * compila NInfer-all e riprova"): it closes by itself once NInfer-all is built, then `onReady`.
 */
export function NinferAllGateDialog({ open, onOpenChange, onReady }: { open: boolean; onOpenChange: (open: boolean) => void; onReady?: () => void }) {
  const ready = () => {
    onOpenChange(false);
    onReady?.();
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && <NinferGateContent onReady={ready} onClose={() => onOpenChange(false)} />}
    </Dialog>
  );
}
