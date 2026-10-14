import { useQueryClient } from '@tanstack/react-query';
import { Container, Download, Eraser, HardDrive, Play, RefreshCw, RotateCcw, ScanSearch, SquareTerminal, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useI18n } from '../../i18n';
import { useDockerActions } from '../../lib/queries-docker';
import { IMAGES_KEY, removalRef, useLocalImages, useRemoveImage } from '../../lib/queries-images';
import { DockerCause } from '../docker/docker-cause';
import { DockerGateDialog, RestartProgress } from '../docker/docker-gate';
import { activeEvent, useDockerCleanup, useDockerStatus, useGpuCheck, useInstallEvent, useStartInstall, useSystemInfo } from '../../lib/queries-library';
import { ErrorCallout } from '../library/error-callout';
import { DockerInstallDialog } from '../setup/docker-install-dialog';
import { InstallProgress } from '../setup/install-progress';
import { Badge } from '../ui/badge';
import { Button, IconButton } from '../ui/button';
import { ConfirmDialog } from '../ui/dialog';
import { Callout } from '../ui/callout';
import type { StatusDotProps } from '../ui/status-dot';
import { EngineCard } from './engine-card';

export const LLAMA_IMAGE = 'ghcr.io/ggml-org/llama.cpp:server-cuda';

const TONES: Record<string, StatusDotProps['tone']> = {
  running: 'success',
  starting: 'accent',
  stopped: 'warning',
  'not-responding': 'danger',
  'no-gpu': 'warning',
  'no-permission': 'warning',
  'not-installed': 'neutral',
  unsupported: 'neutral',
  unknown: 'neutral',
};

/**
 * Installs a Docker engine by pulling its image (POST /api/engines/:engine/install), with the
 * progress of its 'engine.install' events (keyed by image, see installKey).
 */
export function PullButton({ engine, image, label, disabled }: { engine: 'llamacpp-docker' | 'vllm-docker' | 'sglang-docker'; image: string; label: string; disabled?: boolean }) {
  const { t } = useI18n();
  const key = `pull:${image}`;
  const event = useInstallEvent(key);
  const start = useStartInstall();
  const running = activeEvent(event);
  const qc = useQueryClient();
  const done = event?.stage === 'done';
  // Downloaded: the version is on the PC now ("Sul PC", "Usa questa").
  useEffect(() => {
    if (done) void qc.invalidateQueries({ queryKey: IMAGES_KEY });
  }, [done, qc]);
  if (running) return <InstallProgress event={running} label={label} className="w-full" />;
  return (
    <div className="flex flex-col items-start gap-2">
      <Button size="sm" disabled={disabled || start.isPending} onClick={() => start.mutate({ key, path: `/api/engines/${engine}/install`, body: { image } })}>
        <Download aria-hidden />
        {label}
      </Button>
      {event?.stage === 'done' && <p className="text-xs text-success-text">{t('docker.pulled', { image })}</p>}
      {event?.stage === 'error' && <ErrorCallout error={event.error ?? { code: 'DOCKER_PULL_FAILED', message: image }} />}
    </div>
  );
}

/**
 * The llama.cpp image (its tag moves with every release): "Scarica" when it is not on the PC; when it
 * is, its size, "Aggiorna" (pulls the tag again) and its removal, like the vLLM and SGLang versions.
 */
export function LlamaImageActions() {
  const { t, bytes } = useI18n();
  const repo = LLAMA_IMAGE.slice(0, LLAMA_IMAGE.lastIndexOf(':'));
  const tag = LLAMA_IMAGE.slice(LLAMA_IMAGE.lastIndexOf(':') + 1);
  const local = useLocalImages(repo, true);
  const remove = useRemoveImage();
  const [confirm, setConfirm] = useState(false);
  const mine = local.data?.find((i) => i.tags.includes(tag));
  if (!mine) return <PullButton engine="llamacpp-docker" image={LLAMA_IMAGE} label={t('engines.docker.pullLlama')} />;
  const ref = removalRef(repo, tag, mine);
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Badge size="sm" tone="outline">
        <HardDrive aria-hidden />
        {t('engines.docker.llamaOnPc', { size: bytes(mine.sizeBytes) })}
      </Badge>
      <PullButton engine="llamacpp-docker" image={LLAMA_IMAGE} label={t('engines.docker.updateLlama')} />
      {mine.running ? (
        <IconButton label={t('engines.images.removeRunning')} icon={<Trash2 />} size="sm" aria-disabled className="cursor-not-allowed opacity-50" onClick={() => undefined} />
      ) : (
        <IconButton label={t('engines.images.remove', { image: LLAMA_IMAGE })} icon={<Trash2 />} size="sm" onClick={() => setConfirm(true)} />
      )}
      {remove.isError && <ErrorCallout error={remove.error} />}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t('engines.images.removeTitle', { image: ref })}
        description={t('engines.images.removeBody', { size: bytes(mine.sizeBytes), command: `docker image rm ${ref}` })}
        confirmLabel={t('engines.images.removeConfirm')}
        cancelLabel={t('common.cancel')}
        onConfirm={() => remove.mutate(ref)}
      />
    </span>
  );
}

/** Docker as a state machine, each state with the one button that moves it forward. */
export function DockerCard() {
  const { t } = useI18n();
  const docker = useDockerStatus();
  const system = useSystemInfo();
  const start = useStartInstall();
  const startEvent = useInstallEvent('docker-desktop');
  const linuxEvent = useInstallEvent('docker-linux');
  const gpuCheck = useGpuCheck();
  const cleanup = useDockerCleanup();
  const dockerActions = useDockerActions();
  const [confirm, setConfirm] = useState(false);
  const [gate, setGate] = useState(false);
  const state = docker.data?.state ?? 'unknown';
  const linux = system.data?.os.platform === 'linux';
  const busy = activeEvent(startEvent) ?? activeEvent(linuxEvent);
  const restarting = activeEvent(dockerActions.restartEvent);
  const install = () => start.mutate({ key: linux ? 'docker-linux' : 'docker-desktop', path: '/api/setup/docker/install' });

  let action = null;
  if (restarting) action = <RestartProgress event={restarting} className="w-full" />;
  else if (busy) action = <InstallProgress event={busy} label={t('engines.docker.title')} className="w-full" />;
  else if (state === 'not-responding')
    // Windows: the restart, in its dialog (it says what to try if a normal restart is not enough); Linux: the command.
    action = (
      <Button variant="primary" size="sm" onClick={() => setGate(true)}>
        <RotateCcw aria-hidden />
        {linux ? t('dockerFix.banner.details') : t('dockerFix.restart')}
      </Button>
    );
  else if (state === 'stopped')
    // Windows: LLM Bench starts Docker Desktop; Linux: a system service, its command in the dialog.
    action = linux ? (
      <Button variant="primary" size="sm" onClick={() => setGate(true)}>
        <SquareTerminal aria-hidden />
        {t('engines.docker.howToStart')}
      </Button>
    ) : (
      <Button variant="primary" size="sm" onClick={() => start.mutate({ key: 'docker-desktop', path: '/api/docker/start' })}>
        <Play aria-hidden />
        {t('engines.actions.startDocker')}
      </Button>
    );
  else if (state === 'not-installed' || (linux && (state === 'no-permission' || state === 'no-gpu')))
    action = (
      <Button variant="primary" size="sm" onClick={() => setConfirm(true)}>
        <Download aria-hidden />
        {t('engines.docker.install')}
      </Button>
    );
  else if (state === 'running' || state === 'no-gpu')
    action = (
      <>
        <Button size="sm" onClick={() => gpuCheck.mutate()} disabled={gpuCheck.isPending}>
          <ScanSearch aria-hidden />
          {t('engines.actions.testGpu')}
        </Button>
        <LlamaImageActions />
        <Button
          size="sm"
          variant="ghost"
          disabled={cleanup.isPending}
          onClick={() => cleanup.mutate(undefined, { onSuccess: (r) => toast.success(t('engines.docker.cleaned', { n: r.removed.length })) })}
        >
          <Eraser aria-hidden />
          {t('engines.docker.cleanup')}
        </Button>
        {/* Running but acting strange: a restart without waiting for it to count as stuck. */}
        {!linux && (
          <Button size="sm" variant="ghost" onClick={() => dockerActions.restart()}>
            <RotateCcw aria-hidden />
            {t('dockerFix.restart')}
          </Button>
        )}
      </>
    );
  else
    action = (
      <Button size="sm" variant="ghost" onClick={() => void docker.refetch()}>
        <RefreshCw aria-hidden />
        {t('setup.recheck')}
      </Button>
    );

  return (
    <EngineCard
      icon={<Container />}
      title={t('engines.docker.title')}
      description={t('engines.docker.desc')}
      status={{ tone: TONES[state] as StatusDotProps['tone'], text: t(`engines.docker.state.${state}`) }}
      footer={action}
    >
      <p className="text-sm text-fg-2">
        {linux && (state === 'stopped' || state === 'not-responding') ? t(`engines.docker.explainLinux.${state}`) : t(`engines.docker.explain.${state}`, { version: docker.data?.version ?? '' })}
      </p>
      {/* Not responding: "Perché è successo" says it in words instead. */}
      {docker.data?.reason && state !== 'running' && state !== 'not-responding' && <p className="text-xs text-fg-3">{t('engines.docker.reason', { reason: docker.data.reason })}</p>}
      {startEvent?.stage === 'error' && <ErrorCallout error={startEvent.error ?? { code: 'DOCKER_NOT_RUNNING', message: 'start' }} />}
      {dockerActions.restartEvent?.stage === 'error' && state !== 'not-responding' && <ErrorCallout error={dockerActions.restartEvent.error ?? { code: 'DOCKER_NOT_RESPONDING', message: 'restart' }} />}
      {state === 'not-responding' && <DockerCause windows={!linux} />}
      {gpuCheck.data && (
        <Callout tone="success" title={t('engines.docker.gpuOk')}>
          <ul className="font-mono text-xs">
            {gpuCheck.data.gpus.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        </Callout>
      )}
      {gpuCheck.isError && <ErrorCallout error={gpuCheck.error} />}
      {cleanup.isError && <ErrorCallout error={cleanup.error} />}
      <DockerInstallDialog platform={linux ? 'linux' : 'win32'} open={confirm} onOpenChange={setConfirm} onConfirm={install} />
      <DockerGateDialog open={gate} onOpenChange={setGate} autoRestart={!linux} />
    </EngineCard>
  );
}
