/**
 * TensorRT-LLM in Docker: Docker first (one button that moves it forward), then NVIDIA's image. With
 * nothing on the PC the one thing to do is the download of the recommended version; then each version
 * says "Sul PC" with its size, "In uso", or "Usa questa", and goes away after a confirmation.
 */
import { Check, Download, HardDrive, Play, RefreshCw, RotateCcw, SquareTerminal, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { DockerState } from '../../../contract/docker';
import { useI18n } from '../../i18n';
import { useDockerActions } from '../../lib/queries-docker';
import { activeEvent, useDockerStatus, useInstallEvent, useSaveEngine, useStartInstall, useSystemInfo } from '../../lib/queries-library';
import { useRemoveTrtllmImage } from '../../lib/queries-trtllm';
import { useSettings } from '../../lib/settings';
import { DockerGateDialog, RestartProgress } from '../docker/docker-gate';
import { ErrorCallout } from '../library/error-callout';
import { DockerInstallDialog } from '../setup/docker-install-dialog';
import { InstallProgress } from '../setup/install-progress';
import { Badge } from '../ui/badge';
import { Button, IconButton } from '../ui/button';
import { Callout } from '../ui/callout';
import { ConfirmDialog } from '../ui/dialog';
import { EngineUpdatePanel } from './engine-update';
import { firstVersion, imageInUse, sortVersions, type TrtllmVersion } from './trtllm-format';

/** Versions listed before "Tutte le versioni". */
const PREVIEW = 4;

/** Docker is not there yet for TensorRT-LLM: why, in words, with the one button that fixes it (or its progress). */
export function TrtllmDockerNeed({ state }: { state: DockerState }) {
  const { t } = useI18n();
  const docker = useDockerStatus();
  const system = useSystemInfo();
  const actions = useDockerActions();
  const start = useStartInstall();
  const installEvent = useInstallEvent(system.data?.os.platform === 'linux' ? 'docker-linux' : 'docker-desktop');
  const [gate, setGate] = useState(false);
  const [install, setInstall] = useState(false);
  const linux = system.data?.os.platform === 'linux';
  const busy = activeEvent(actions.restartEvent) ?? activeEvent(actions.startEvent) ?? activeEvent(installEvent);
  if (busy) return busy.kind === 'docker-restart' ? <RestartProgress event={busy} className="w-full" /> : <InstallProgress event={busy} label={t('engines.docker.title')} className="w-full" />;

  let action: { label: string; onClick: () => void } | undefined;
  if (state === 'stopped') action = linux ? { label: t('engines.docker.howToStart'), onClick: () => setGate(true) } : { label: t('engines.actions.startDocker'), onClick: actions.start };
  else if (state === 'not-responding') action = { label: t(linux ? 'dockerFix.banner.details' : 'dockerFix.restart'), onClick: () => setGate(true) };
  else if (state === 'not-installed' || (linux && (state === 'no-permission' || state === 'no-gpu'))) action = { label: t('engines.docker.install'), onClick: () => setInstall(true) };
  else if (state !== 'starting') action = { label: t('setup.recheck'), onClick: () => void docker.refetch() };
  const text = state === 'stopped' && linux ? t('trtllm.docker.need.stoppedLinux') : t(`trtllm.docker.need.${state as Exclude<DockerState, 'running'>}`);
  const icon = state === 'stopped' ? (linux ? <SquareTerminal aria-hidden /> : <Play aria-hidden />) : state === 'not-responding' ? <RotateCcw aria-hidden /> : state === 'not-installed' ? <Download aria-hidden /> : <RefreshCw aria-hidden />;
  return (
    <>
      <Callout tone={state === 'not-responding' ? 'danger' : 'warning'} title={text}>
        {action && (
          <Button variant="primary" size="sm" className="mt-1" onClick={action.onClick}>
            {icon}
            {action.label}
          </Button>
        )}
      </Callout>
      <DockerGateDialog open={gate} onOpenChange={setGate} autoRestart={!linux && state === 'not-responding'} engineLabel="TensorRT-LLM" />
      <DockerInstallDialog
        platform={linux ? 'linux' : 'win32'}
        open={install}
        onOpenChange={setInstall}
        onConfirm={() => start.mutate({ key: linux ? 'docker-linux' : 'docker-desktop', path: '/api/setup/docker/install' })}
      />
    </>
  );
}

/** Downloads a version (POST /api/engines/trtllm-docker/install), with its progress ('engine.install' keyed pull:<image>). */
function PullVersion({ image, label, primary, disabled }: { image: string; label: string; primary?: boolean; disabled: boolean }) {
  const { t } = useI18n();
  const key = `pull:${image}`;
  const event = useInstallEvent(key);
  const start = useStartInstall();
  const running = activeEvent(event);
  if (running) return <InstallProgress event={running} label={label} className="w-full" />;
  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        size="sm"
        variant={primary ? 'primary' : 'secondary'}
        disabled={disabled || start.isPending}
        onClick={() => start.mutate({ key, path: '/api/engines/trtllm-docker/install', body: { image } })}
      >
        <Download aria-hidden />
        {label}
      </Button>
      {event?.stage === 'error' && <ErrorCallout error={event.error ?? { code: 'DOCKER_PULL_FAILED', message: image }} />}
      {event?.stage === 'done' && <p className="text-xs text-success-text">{t('docker.pulled', { image })}</p>}
    </div>
  );
}

interface RowProps {
  v: TrtllmVersion;
  inUse: boolean;
  dockerUp: boolean;
  onUse: () => void;
  onRemove: () => void;
}

function VersionRow({ v, inUse, dockerUp, onUse, onRemove }: RowProps) {
  const { t, bytes } = useI18n();
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5" data-local={v.local ? 'true' : undefined}>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-semibold text-fg">{v.tag}</span>
          {v.recommended && (
            <Badge size="sm" tone="accent">
              {t('common.recommended')}
            </Badge>
          )}
          {v.prerelease && (
            <Badge size="sm" tone="neutral">
              {t('trtllm.docker.prerelease')}
            </Badge>
          )}
          {inUse && v.local && (
            <Badge size="sm" tone="success">
              <Check aria-hidden />
              {t('trtllm.inUse')}
            </Badge>
          )}
          {v.local && (
            <Badge size="sm" tone="outline">
              <HardDrive aria-hidden />
              {v.local.sizeBytes ? t('trtllm.onPc', { size: bytes(v.local.sizeBytes) }) : t('trtllm.onPcNoSize')}
            </Badge>
          )}
        </span>
        {!v.local && v.sizeBytes ? <span className="text-xs text-fg-3 tabular-nums">{bytes(v.sizeBytes)}</span> : null}
      </span>
      {v.local ? (
        <span className="flex items-center gap-1">
          {!inUse && (
            <Button size="sm" onClick={onUse}>
              {t('trtllm.docker.use')}
            </Button>
          )}
          {v.local.running ? (
            // Said, not hidden: why it cannot go now.
            <IconButton label={t('trtllm.docker.removeRunning')} icon={<Trash2 />} size="sm" aria-disabled className="cursor-not-allowed opacity-50" onClick={() => undefined} />
          ) : (
            <IconButton label={t('trtllm.docker.remove', { version: v.tag })} icon={<Trash2 />} size="sm" onClick={onRemove} />
          )}
        </span>
      ) : (
        <PullVersion image={v.image} label={t('trtllm.docker.pull')} disabled={!dockerUp} />
      )}
    </li>
  );
}

export interface TrtllmDockerProps {
  /** NGC's versions with what is on the PC (trtllm-format.ts trtllmVersions). */
  versions: readonly TrtllmVersion[];
  /** NGC's list could not be read: only the versions on the PC are there. */
  offline: boolean;
  onRetry: () => void;
  dockerState: DockerState | undefined;
  /** The image the engine status names as its default (used when none was chosen). */
  defaultImage: string | undefined;
}

/** The Docker way: Docker's state, the versions, the update. */
export function TrtllmDocker({ versions, offline, onRetry, dockerState, defaultImage }: TrtllmDockerProps) {
  const { t, bytes } = useI18n();
  const { settings } = useSettings();
  const save = useSaveEngine();
  const remove = useRemoveTrtllmImage();
  const [all, setAll] = useState(false);
  const [confirm, setConfirm] = useState<TrtllmVersion>();
  const up = dockerState === 'running';
  const inUse = imageInUse(settings.lastEngine, defaultImage);
  const sorted = sortVersions(versions);
  const anyLocal = sorted.some((v) => v.local);
  const first = anyLocal ? undefined : firstVersion(versions);
  // Nothing on the PC: the recommended download is the one thing to do; the other versions wait behind "Tutte le versioni".
  const listed = all ? sorted : anyLocal ? sorted.slice(0, PREVIEW) : [];
  const confirmSize = confirm?.local?.sizeBytes;
  return (
    <div className="flex flex-col gap-3">
      {!up && <TrtllmDockerNeed state={dockerState ?? 'unknown'} />}
      {offline && <Callout tone="info" title={t('trtllm.docker.offline')} action={{ label: t('common.retry'), onClick: onRetry }} />}
      {first && (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-2 p-3">
          <PullVersion
            image={first.image}
            label={first.sizeBytes ? t('trtllm.docker.firstSize', { version: first.tag, size: bytes(first.sizeBytes) }) : t('trtllm.docker.first', { version: first.tag })}
            primary
            disabled={!up}
          />
          <p className="text-xs text-fg-3">{t('trtllm.docker.firstHint')}</p>
        </div>
      )}
      {sorted.length === 0 && !offline && <p className="text-sm text-fg-2">{t('trtllm.docker.none')}</p>}
      {listed.length > 0 && (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border" aria-label={t('trtllm.docker.versions')}>
          {listed.map((v) => (
            <VersionRow key={v.image} v={v} inUse={inUse === v.image} dockerUp={up} onUse={() => save.mutate({ kind: 'trtllm-docker', image: v.image })} onRemove={() => setConfirm(v)} />
          ))}
        </ul>
      )}
      {(anyLocal ? sorted.length > PREVIEW : sorted.length > 1) && (
        <Button variant="link" className="self-start" onClick={() => setAll((a) => !a)}>
          {all ? t('trtllm.docker.fewer') : t('trtllm.docker.all', { n: sorted.length })}
        </Button>
      )}
      <EngineUpdatePanel target="trtllm-docker" name={t('benchmark.engines.trtllm-docker')} enabled={up && anyLocal} />
      {save.isError && <ErrorCallout error={save.error} />}
      {remove.isError && <ErrorCallout error={remove.error} />}
      <ConfirmDialog
        open={confirm !== undefined}
        onOpenChange={(o) => !o && setConfirm(undefined)}
        title={t('trtllm.docker.removeTitle', { version: confirm?.tag ?? '' })}
        description={
          confirmSize
            ? t('trtllm.docker.removeBody', { size: bytes(confirmSize), command: `docker image rm ${(confirm as TrtllmVersion).image}` })
            : t('trtllm.docker.removeBodyNoSize', { command: `docker image rm ${confirm?.image ?? ''}` })
        }
        confirmLabel={t('trtllm.docker.removeConfirm')}
        cancelLabel={t('common.cancel')}
        onConfirm={() => {
          const v = confirm as TrtllmVersion;
          remove.mutate(v.image, { onSuccess: () => toast.success(t('trtllm.docker.removed', { version: v.tag })) });
        }}
      />
    </div>
  );
}
