/**
 * One of NInfer's two builds on its card ("NInfer (ufficiale)", "NInfer-all"): where it comes from and
 * where it is, its state in words, and one obvious thing to do — "Scarica e compila" when it is not
 * there, "Ricompila" when its program is missing, broken or older than its code, "Aggiorna" (pull and
 * rebuild in one click) when its branch has new commits — with the progress, "Annulla" and, when it
 * stops, why in plain words. "Cambia cartella" points it at a build of the user's own; "Avanzate" holds
 * the folder, the repository and the exact commands.
 */
import { CircleCheck, Download, FolderSearch, Hammer, RefreshCw, RotateCcw } from 'lucide-react';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { customUpdateTarget, updateCancelPath, updateEventKind, type EngineUpdateCheck } from '../../../contract/engine-updates';
import type { EngineStatus } from '../../../contract/engines';
import { NINFER_ALL_NAME, type NinferBuildInfo, type NinferBuildState, type NinferKind } from '../../../contract/ninfer';
import { useI18n } from '../../i18n';
import { useApi } from '../../lib/api-context';
import { updatePath, useEngineUpdate, useRecheckUpdate } from '../../lib/queries-engines';
import { activeEvent, useInstallEvent, useStartInstall } from '../../lib/queries-library';
import { useSetBuildPath } from '../../lib/queries-ninfer';
import { cn } from '../../lib/cn';
import { ErrorCallout } from '../library/error-callout';
import { Button } from '../ui/button';
import { Field, Input } from '../ui/input';
import { StatusDot, type StatusDotProps } from '../ui/status-dot';
import { CommitLog, rebuildOnly, Restored, updateHeadline, updateStateText } from './engine-update';
import { NinferArtifacts } from './ninfer-artifacts';
import { repoText } from './ninfer-build-dialog';
import { BuildFailure, BuildProgress, Checking, PlanCommands, PlanNeeds, useGuidedBuild } from './ninfer-guided';
import { NinferProblem } from './ninfer-problem';

const TONES: Record<NinferBuildState, StatusDotProps['tone']> = { ready: 'success', stale: 'warning', 'not-built': 'warning', broken: 'danger', missing: 'neutral' };

/** The update target of NInfer-all before it is saved: never asked (its queries stay off). */
const NO_TARGET = 'custom:none';

/** What the row's main button does. */
type Primary = 'download' | 'rebuild' | 'update' | undefined;

/** The one thing to do: get it, build again what is there, or pull what is new and build it. */
export function primaryOf(info: Pick<NinferBuildInfo, 'state' | 'commit'>, update: EngineUpdateCheck | undefined): Primary {
  if (info.state === 'missing') return 'download';
  // A program that does not answer from a folder that is not a checkout: a fresh copy in its own folder.
  if (info.state === 'broken' && info.commit === undefined) return 'download';
  // New commits on its branch: pulled and built in one go (also when its program is older than its code).
  const pull = update?.state === 'available' && !rebuildOnly(update);
  if (pull && (info.state === 'ready' || info.state === 'stale')) return 'update';
  return info.state === 'ready' ? undefined : 'rebuild';
}

export interface NinferBuildRowProps {
  info: NinferBuildInfo;
  kind: NinferKind;
  /** ninfer-wsl: the distro a build not saved yet goes into. */
  distro?: string | undefined;
  /** Opened from a model that needs it (/engines?ninfer=all): drawn out, with that model named. */
  highlight?: boolean;
  forModel?: string | undefined;
}

export function NinferBuildRow({ info, kind, distro, highlight, forModel }: NinferBuildRowProps) {
  const { t } = useI18n();
  const api = useApi();
  const titleId = useId();
  const all = info.build === 'all';
  const name = all ? t('ninfer.builds.all.title') : t('ninfer.builds.official.title');
  // In a toast or a progress bar: "NInfer-all è pronto", "Compilazione di NInfer (ufficiale)".
  const short = all ? NINFER_ALL_NAME : name;
  // Its own distro, else the one a build not saved yet goes into (WSL only: none on Linux).
  const inDistro = info.distro ?? distro;
  const where = kind === 'ninfer-wsl' ? t('ninfer.build.whereWsl', { distro: inDistro ?? '–' }) : t('ninfer.build.whereLinux');
  const [folder, setFolder] = useState('');
  const [changing, setChanging] = useState(false);
  const [path, setPath] = useState(info.path ?? '');
  const setBuildPath = useSetBuildPath(info.build);
  // Built again where its checkout is; a fresh copy in its own folder; or the folder asked for (Avanzate).
  const checkout = info.state !== 'missing' && info.commit !== undefined ? info.dir : undefined;
  const guided = useGuidedBuild({
    kind,
    distro: inDistro,
    build: info.build,
    dir: folder.trim() || checkout,
    onDone: () => toast.success(t('ninfer.builds.done', { name: short })),
  });
  // NInfer-all is updated as its saved engine; not saved yet, there is nothing to update.
  const target = all ? (info.customEngineId ? customUpdateTarget(info.customEngineId) : NO_TARGET) : kind;
  const installed = info.state === 'ready' || info.state === 'stale';
  const update = useEngineUpdate(target, installed && target !== NO_TARGET);
  const recheck = useRecheckUpdate(target);
  const startUpdate = useStartInstall();
  const updateEvent = useInstallEvent(updateEventKind(target));
  const updating = activeEvent(updateEvent);
  const check = update.data;
  const primary = primaryOf(info, check);
  const busy = guided.running !== undefined || updating !== undefined || guided.checking;
  const runUpdate = () => startUpdate.mutate({ key: updateEventKind(target), path: updatePath(target) });
  const cancelUpdate = () => void api.post(updateCancelPath(target)).catch(() => undefined);

  const stateText = guided.running ? t('ninfer.builds.state.building') : updating ? t('ninfer.builds.state.updating') : t(`ninfer.builds.state.${info.state}`);
  const tone: StatusDotProps['tone'] = guided.running || updating ? 'accent' : TONES[info.state];
  const showPlan = guided.plan !== undefined && !guided.plan.ready && !guided.running;
  // What is missing is shown with its own "Ricontrolla": no second button that does the same.
  const action = showPlan ? undefined : primary;
  const updateFailed = updateEvent?.stage === 'error' ? updateEvent.error : undefined;

  const usePath = () =>
    setBuildPath.mutate(
      { path: path.trim(), ...(inDistro ? { distro: inDistro } : {}) },
      {
        onSuccess: (r) => {
          if (!r.saved) return;
          setChanging(false);
          toast.success(t('ninfer.builds.pathSaved', { name: short }));
        },
      },
    );

  return (
    <section
      aria-labelledby={titleId}
      className={cn('flex flex-col gap-3 rounded-lg border border-border bg-surface-2 p-3', highlight && 'ring-2 ring-accent ring-offset-2 ring-offset-surface')}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 id={titleId} className="text-sm font-semibold text-fg">
            {name}
          </h3>
          <p className="text-xs text-fg-3">{all ? t('ninfer.builds.all.desc') : t('ninfer.builds.official.desc')}</p>
        </div>
        <span className="inline-flex shrink-0 items-center gap-2 text-sm text-fg-2">
          <StatusDot tone={tone} pulse={tone === 'accent'} />
          {stateText}
        </span>
      </div>
      {highlight && forModel && <p className="text-sm text-fg">{t('ninfer.builds.forModel', { model: forModel })}</p>}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
        <dt className="text-fg-3">{t('ninfer.builds.from')}</dt>
        <dd className="break-all text-fg">{info.source.branch ? t('ninfer.builds.sourceBranch', { repo: repoText(info.source.url), branch: info.source.branch }) : repoText(info.source.url)}</dd>
        <dt className="text-fg-3">{t('ninfer.builds.folder')}</dt>
        <dd className="font-mono text-xs break-all text-fg">{info.state === 'missing' ? t('ninfer.builds.folderNew', { dir: info.dir, where }) : `${info.dir}${info.distro ? ` · ${info.distro}` : ''}`}</dd>
        {info.release && (
          <>
            <dt className="text-fg-3">{t('ninfer.builds.release')}</dt>
            <dd className="font-mono text-xs break-all text-fg">{info.release}</dd>
          </>
        )}
        {info.commit && (
          <>
            <dt className="text-fg-3">{t('ninfer.found.commit')}</dt>
            <dd className="font-mono text-xs text-fg">{info.built && info.built !== info.commit ? t('ninfer.builds.commitBuilt', { commit: info.commit, built: info.built }) : info.commit}</dd>
          </>
        )}
      </dl>
      {info.state === 'stale' && <p className="text-sm text-warning-text">{t('ninfer.builds.staleBody')}</p>}
      {info.state === 'not-built' && <p className="text-sm text-fg-2">{t('ninfer.builds.notBuiltBody', { commit: info.commit as string })}</p>}
      {/* A build that does not answer always says why (its probe's status). */}
      {info.state === 'broken' && <NinferProblem status={info.status as EngineStatus} fallback={info.dir} />}
      {info.state === 'missing' && all && <p className="text-sm text-fg-2">{t('ninfer.builds.all.why')}</p>}
      {guided.checking && <Checking where={where} />}
      {guided.planError && !guided.checking && <BuildFailure error={guided.planError} where={where} />}
      {showPlan && (
        <div className="flex flex-col gap-2">
          <PlanNeeds plan={guided.plan!} where={where} compact />
          <Button size="sm" className="self-start" onClick={() => void guided.run()} disabled={busy}>
            <RotateCcw aria-hidden />
            {t('ninfer.builds.recheck')}
          </Button>
        </div>
      )}
      {guided.running && <BuildProgress event={guided.running} label={t('ninfer.builds.building', { name: short })} onCancel={guided.cancel} />}
      {guided.failed && !guided.running && !guided.checking && <BuildFailure error={guided.failed} where={where} />}
      {updating && <BuildProgress event={updating} label={t('engines.update.progress', { name: short })} onCancel={cancelUpdate} />}
      {updateFailed && !updating && (
        <>
          <BuildFailure error={updateFailed} where={where} />
          <Restored params={updateFailed.params} />
        </>
      )}
      {!busy && (
        <div className="flex flex-wrap items-center gap-2">
          {action === 'download' && (
            <Button size="sm" variant="primary" onClick={() => void guided.run()}>
              <Download aria-hidden />
              {t('ninfer.builds.download')}
            </Button>
          )}
          {action === 'rebuild' && (
            <Button size="sm" variant="primary" onClick={() => void guided.run()}>
              <Hammer aria-hidden />
              {t('ninfer.builds.rebuild')}
            </Button>
          )}
          {action === 'update' && (
            <Button size="sm" variant="primary" onClick={runUpdate}>
              <RefreshCw aria-hidden />
              {t('engines.update.update')}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setChanging((c) => !c)} aria-expanded={changing}>
            <FolderSearch aria-hidden />
            {info.state === 'missing' ? t('ninfer.builds.have') : t('ninfer.builds.change')}
          </Button>
        </div>
      )}
      {installed && !busy && check && <UpdateLine check={check} onRecheck={() => recheck.mutate()} rechecking={recheck.isPending} />}
      {!all && installed && check && <NinferArtifacts check={check} where={where} />}
      {changing && (
        <div className="flex flex-col gap-2">
          <Field label={t('ninfer.where.label')} hint={t('ninfer.where.hint')}>
            {({ id, describedBy }) => (
              <div className="flex gap-2">
                <Input id={id} aria-describedby={describedBy} value={path} onChange={(e) => setPath(e.target.value)} placeholder={info.dir} className="min-w-0 flex-1 font-mono" spellCheck={false} />
                <Button variant="primary" className="shrink-0" onClick={usePath} disabled={setBuildPath.isPending || !path.trim()}>
                  {setBuildPath.isPending ? t('ninfer.where.checking') : t('ninfer.where.check')}
                </Button>
              </div>
            )}
          </Field>
          {setBuildPath.data && !setBuildPath.data.saved && <NinferProblem status={setBuildPath.data.status} fallback={path} />}
          {setBuildPath.isError && <ErrorCallout error={setBuildPath.error} />}
        </div>
      )}
      <details className="text-sm">
        <summary className="cursor-pointer rounded-xs text-fg-2 select-none hover:text-fg focus-ring">{t('ninfer.builds.advanced')}</summary>
        <div className="mt-2 flex flex-col gap-3">
          <Field label={t('ninfer.build.folder')} hint={t('ninfer.builds.folderHint', { dir: checkout ?? info.dir })}>
            {({ id, describedBy }) => (
              <Input id={id} aria-describedby={describedBy} value={folder} onChange={(e) => setFolder(e.target.value)} placeholder={checkout ?? info.dir} className="font-mono" spellCheck={false} />
            )}
          </Field>
          {guided.plan ? (
            <PlanCommands plan={guided.plan} where={where} />
          ) : (
            <Button size="sm" className="self-start" onClick={() => void guided.check()} disabled={busy}>
              {t('ninfer.builds.showCommands')}
            </Button>
          )}
        </div>
      </details>
    </section>
  );
}

/**
 * "Hai l'ultima versione", what an update brings ("3 commit nuovi: a1b2c3d → e4f5a6b"), or why it cannot
 * be updated from here (local changes…), and "Controlla aggiornamenti".
 */
function UpdateLine({ check, onRecheck, rechecking }: { check: EngineUpdateCheck; onRecheck: () => void; rechecking: boolean }) {
  const { t, bytes } = useI18n();
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 flex-col gap-1">
        {/* Only a rebuild due: the row says so already ("Da ricompilare", "Ricompila"). */}
        {!rebuildOnly(check) && (
          <p className="flex items-center gap-1.5 text-sm text-fg-2">
            {check.state === 'current' && <CircleCheck aria-hidden className="size-4 text-success-text" />}
            {check.state === 'available' ? updateHeadline({ t, bytes }, check) : updateStateText(t, check)}
          </p>
        )}
        {/* The new commits only come with an update ("3 commit nuovi"). */}
        {check.log?.length ? <CommitLog log={check.log} total={check.commits} /> : null}
      </div>
      <Button size="sm" variant="ghost" disabled={rechecking} onClick={onRecheck}>
        <RefreshCw aria-hidden />
        {rechecking ? t('engines.update.checking') : t('engines.update.check')}
      </Button>
    </div>
  );
}
