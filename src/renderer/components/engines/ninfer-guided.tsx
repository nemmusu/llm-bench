/**
 * NInfer's guided build in one click, for the card's two builds and for "Serve NInfer-all" in the start
 * flow: the read-only check of what it needs (useGuidedBuild.check), the build when everything is there
 * (begin), its progress and "Annulla" (cancel), and when it stops what it said in plain words with its
 * last lines and the whole log (BuildFailure). What is missing is shown with the exact "sudo apt install
 * …" line to copy (PlanNeeds): LLM Bench never installs system packages.
 */
import { useQueryClient } from '@tanstack/react-query';
import { Check, FileText, Loader, X } from 'lucide-react';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { AppErrorData } from '../../../contract/errors';
import { ninferBuildEventKind, type NinferBuildId, type NinferBuildPlan, type NinferBuildRequest, type NinferKind } from '../../../contract/ninfer';
import { useI18n, type Formatters } from '../../i18n';
import { useApi } from '../../lib/api-context';
import { activeEvent, errorData, useInstallEvent, useStartInstall, type InstallEvent } from '../../lib/queries-library';
import { refreshAfterBuild } from '../../lib/queries-ninfer';
import { ErrorCallout } from '../library/error-callout';
import { InstallProgress, stageLabel } from '../setup/install-progress';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Callout } from '../ui/callout';
import { CodeBlock } from '../ui/code-block';

export interface GuidedBuildOptions {
  kind: NinferKind;
  /** ninfer-wsl: the distro it is built in. */
  distro?: string | undefined;
  build: NinferBuildId;
  /** Another folder than its own (Avanzate). */
  dir?: string | undefined;
  /** The build finished and was saved. */
  onDone?: () => void;
}

export interface GuidedBuild {
  request: NinferBuildRequest;
  /** The checked plan (what it needs, the commands), once checked. */
  plan?: NinferBuildPlan | undefined;
  /** Why the check could not be made. */
  planError?: AppErrorData | undefined;
  checking: boolean;
  /** The build or its start is running. */
  running?: InstallEvent | undefined;
  /** The last build stopped: why (its last lines, its log). */
  failed?: AppErrorData | undefined;
  /** Checks what it needs (read-only). */
  check: () => Promise<NinferBuildPlan | undefined>;
  /** Builds with a checked plan that is ready. */
  begin: (plan: NinferBuildPlan) => void;
  /** Check, then build at once when everything is there ("Scarica e compila", "Ricompila"). */
  run: () => Promise<void>;
  cancel: () => void;
}

/** "Annulla" on a running build (only one runs at a time): a request that fails changes nothing. */
export function cancelNinferBuild(api: ReturnType<typeof useApi>): void {
  void api.post('/api/engines/ninfer/build/cancel').catch(() => undefined);
}

export function useGuidedBuild({ kind, distro, build, dir, onDone }: GuidedBuildOptions): GuidedBuild {
  const api = useApi();
  const qc = useQueryClient();
  const request: NinferBuildRequest = { kind, ...(kind === 'ninfer-wsl' && distro ? { distro } : {}), ...(build === 'all' ? { build } : {}), ...(dir ? { dir } : {}) };
  const key = ninferBuildEventKind(request);
  const event = useInstallEvent(key);
  const running = activeEvent(event);
  const start = useStartInstall();
  const [plan, setPlan] = useState<NinferBuildPlan | undefined>(undefined);
  const [planError, setPlanError] = useState<AppErrorData | undefined>(undefined);
  const [checking, setChecking] = useState(false);
  // Only a build started here ends here (an earlier one's 'done' is still in the cache).
  const mine = useRef(false);
  const fireDone = useEffectEvent(() => onDone?.());

  const done = event?.stage === 'done';
  useEffect(() => {
    if (!done || !mine.current) return;
    mine.current = false;
    refreshAfterBuild(qc);
    fireDone();
  }, [done, qc]);

  const check = async (): Promise<NinferBuildPlan | undefined> => {
    setChecking(true);
    setPlanError(undefined);
    try {
      const p = await api.post<NinferBuildPlan>('/api/engines/ninfer/build-plan', request);
      setPlan(p);
      return p;
    } catch (e) {
      setPlan(undefined);
      setPlanError(errorData(e));
      return undefined;
    } finally {
      setChecking(false);
    }
  };
  const begin = (p: NinferBuildPlan) => {
    mine.current = true;
    // The folder it checked (absolute) is the one built.
    start.mutate({ key, path: '/api/engines/ninfer/build', body: { ...request, dir: p.dir, confirm: true } });
  };
  return {
    request,
    plan,
    planError,
    checking,
    running,
    failed: event?.stage === 'error' && !running ? (event.error ?? { code: 'ENGINE_INSTALL_FAILED', message: key }) : undefined,
    check,
    begin,
    run: async () => {
      const p = await check();
      if (p?.ready) begin(p);
    },
    cancel: () => cancelNinferBuild(api),
  };
}

/** What the build downloads and how long it takes, in words ("Da scaricare: circa 38 MB." "Compilazione: circa 10 minuti con 16 core."). */
export function buildEstimate(p: Pick<NinferBuildPlan, 'existing' | 'downloadBytes' | 'cpus' | 'minutes'>, f: Pick<Formatters, 't' | 'bytes'>): string[] {
  const download = p.existing ? f.t('ninfer.build.nothingToDownload') : p.downloadBytes !== undefined ? f.t('ninfer.build.download', { size: f.bytes(p.downloadBytes) }) : undefined;
  const time = p.cpus ? f.t('ninfer.build.time', { minutes: p.minutes, cpus: p.cpus }) : f.t('ninfer.build.timeNoCpus', { minutes: p.minutes });
  return download ? [download, time] : [time];
}

/**
 * What a checked plan still needs, in words: another folder (a checkout of another repository, other
 * files), the prerequisites (the missing ones marked), the "sudo apt install …" line with why CUDA must
 * be newer, NVIDIA's repository when apt has no toolkit new enough.
 */
export function PlanNeeds({ plan: p, where, compact = false }: { plan: NinferBuildPlan; where: string; compact?: boolean }) {
  const { t } = useI18n();
  const shown = compact ? p.prereqs.filter((r) => !r.found) : p.prereqs;
  const cuda = p.cuda;
  const cudaMissing = p.prereqs.some((r) => r.id === 'cuda' && !r.found);
  return (
    <div className="flex flex-col gap-3">
      {p.otherRepo && <Callout tone="danger" title={t('ninfer.build.otherRepo', { origin: p.otherRepo })} />}
      {p.notEmpty && <Callout tone="danger" title={t('ninfer.build.notEmpty', { dir: p.dir })} />}
      {p.existing && !p.otherRepo && !compact && <Callout tone="info" title={t('ninfer.build.existing')} />}
      {p.clearCache && !compact && <p className="text-sm text-fg-2">{t('ninfer.build.clearCache')}</p>}
      {shown.length > 0 && (
        <section className="flex flex-col gap-2" aria-label={t('ninfer.build.prereqs')}>
          <h3 className="text-sm font-semibold text-fg">{compact ? t('ninfer.build.missingTitle') : t('ninfer.build.prereqs')}</h3>
          <ul className="grid gap-1.5 sm:grid-cols-2">
            {shown.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 text-sm">
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
      )}
      {/* Why NInfer-all needs a newer CUDA than the one there (none at all: the line to install it says enough). */}
      {cudaMissing && cuda?.allNeeds && cuda.have && <p className="text-sm text-fg-2">{t('ninfer.build.cudaWhyAll', { need: cuda.need, have: cuda.have })}</p>}
      {p.aptCommand && (
        <Callout tone="warning" title={t('ninfer.build.aptTitle')}>
          <p className="mb-2">{t('ninfer.build.aptBody', { where })}</p>
          <CodeBlock single commands={{ bash: p.aptCommand, powershell: p.aptCommand }} defaultShell="bash" label={t('ninfer.build.aptLabel')} />
          {cudaMissing && cuda?.package && <p className="mt-2 text-xs">{t('ninfer.build.cudaPackage', { package: cuda.package, need: cuda.need })}</p>}
        </Callout>
      )}
      {p.cudaFromNvidia && <Callout tone="warning" title={t('ninfer.build.cuda', { need: cuda?.need ?? '13.1' })} />}
    </div>
  );
}

/** The exact commands a plan runs (Avanzate). */
export function PlanCommands({ plan, where }: { plan: NinferBuildPlan; where: string }) {
  const { t } = useI18n();
  return (
    <section className="flex flex-col gap-2">
      <CodeBlock single commands={{ bash: plan.commands.join('\n'), powershell: plan.commands.join('\n') }} defaultShell="bash" label={t('ninfer.build.commands')} />
      <p className="text-xs text-fg-3">{t('ninfer.build.confirmNote', { where })}</p>
    </section>
  );
}

/** "Controllo cosa serve…" while the read-only check runs. */
export function Checking({ where }: { where: string }) {
  const { t } = useI18n();
  return (
    <p className="flex items-center gap-2 text-sm text-fg-2" aria-live="polite">
      <Loader aria-hidden className="size-4 animate-spin text-accent [animation-duration:2.4s]" />
      {t('ninfer.build.checking', { where })}
    </p>
  );
}

/** A build or update running: its step, how far, and "Annulla". */
export function BuildProgress({ event, label, onCancel }: { event: InstallEvent; label: string; onCancel: () => void }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-2" aria-live="polite">
      <InstallProgress event={event} label={label} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-fg-3">{t('ninfer.build.longHint')}</p>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
}

/** The readings a failed step can have (core/engines/ninfer/build.ts BUILD_READINGS). */
const READINGS = ['cuda-too-old', 'out-of-memory', 'disk-full', 'no-network', 'local-changes', 'diverged', 'not-empty', 'cmake-too-old', 'missing-package'] as const;
type Reading = (typeof READINGS)[number];

/**
 * A build or update that stopped: what its output said in plain words (when it is a known case), what to
 * do, its last lines, and the whole log (LLM Bench keeps it in its data folder). A cancel is just said.
 */
export function BuildFailure({ error, where }: { error: AppErrorData; where: string }) {
  const { t } = useI18n();
  const p = error.params ?? {};
  if (error.code === 'CANCELLED') return <Callout tone="info" title={t('ninfer.failure.cancelled')} />;
  const reading = typeof p.reading === 'string' && (READINGS as readonly string[]).includes(p.reading) ? (p.reading as Reading) : undefined;
  const stage = typeof p.stage === 'string' ? p.stage : undefined;
  const log = typeof p.log === 'string' ? p.log : undefined;
  // Prerequisites missing, another repository in the folder: the error catalog's own words.
  if (!reading && !error.detail) return <ErrorCallout error={error} />;
  const params = { need: String(p.need ?? ''), have: String(p.have ?? ''), what: String(p.what ?? ''), where };
  return (
    <section role="alert" className="flex flex-col gap-2 rounded-lg border border-danger/30 bg-danger-soft p-3">
      <h3 className="text-sm font-semibold text-fg">{reading ? t(`ninfer.failure.${reading}.title`, params) : t('ninfer.failure.title', { stage: stageLabel(t, stage ?? 'build') })}</h3>
      <p className="text-sm text-fg-2">{reading ? t(`ninfer.failure.${reading}.body`, params) : t('ninfer.failure.body')}</p>
      {error.detail && (
        <details className="text-xs text-fg-3" open={!reading}>
          <summary className="cursor-pointer rounded-xs select-none hover:text-fg focus-ring">{t('ninfer.failure.lastLines')}</summary>
          <pre className="mt-1 max-h-60 overflow-auto rounded-md bg-surface-2 p-2 font-mono text-xs break-all whitespace-pre-wrap text-fg-2">{error.detail}</pre>
        </details>
      )}
      {log && window.gpubench && (
        <Button size="sm" variant="ghost" className="self-start" onClick={() => void window.gpubench?.revealPath(log)}>
          <FileText aria-hidden />
          {t('ninfer.failure.log')}
        </Button>
      )}
    </section>
  );
}
