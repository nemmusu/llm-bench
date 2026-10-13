import { Container, Download, Eraser, Play, RefreshCw, ScanSearch } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { useI18n } from '../../i18n';
import { activeEvent, useDockerCleanup, useDockerStatus, useGpuCheck, useInstallEvent, useStartInstall, useSystemInfo } from '../../lib/queries-library';
import { ErrorCallout } from '../library/error-callout';
import { DockerInstallDialog } from '../setup/docker-install-dialog';
import { InstallProgress } from '../setup/install-progress';
import { Button } from '../ui/button';
import { Callout } from '../ui/callout';
import type { StatusDotProps } from '../ui/status-dot';
import { EngineCard } from './engine-card';

export const LLAMA_IMAGE = 'ghcr.io/ggml-org/llama.cpp:server-cuda';

const TONES: Record<string, StatusDotProps['tone']> = {
  running: 'success',
  starting: 'accent',
  stopped: 'warning',
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
  const [confirm, setConfirm] = useState(false);
  const state = docker.data?.state ?? 'unknown';
  const linux = system.data?.os.platform === 'linux';
  const busy = activeEvent(startEvent) ?? activeEvent(linuxEvent);
  const install = () => start.mutate({ key: linux ? 'docker-linux' : 'docker-desktop', path: '/api/setup/docker/install' });

  let action = null;
  if (busy) action = <InstallProgress event={busy} label={t('engines.docker.title')} className="w-full" />;
  else if (state === 'stopped')
    action = (
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
        <PullButton engine="llamacpp-docker" image={LLAMA_IMAGE} label={t('engines.docker.pullLlama')} />
        <Button
          size="sm"
          variant="ghost"
          disabled={cleanup.isPending}
          onClick={() => cleanup.mutate(undefined, { onSuccess: (r) => toast.success(t('engines.docker.cleaned', { n: r.removed.length })) })}
        >
          <Eraser aria-hidden />
          {t('engines.docker.cleanup')}
        </Button>
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
      <p className="text-sm text-fg-2">{t(`engines.docker.explain.${state}`, { version: docker.data?.version ?? '' })}</p>
      {docker.data?.reason && state !== 'running' && <p className="text-xs text-fg-3">{t('engines.docker.reason', { reason: docker.data.reason })}</p>}
      {startEvent?.stage === 'error' && <ErrorCallout error={startEvent.error ?? { code: 'DOCKER_NOT_RUNNING', message: 'start' }} />}
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
    </EngineCard>
  );
}
