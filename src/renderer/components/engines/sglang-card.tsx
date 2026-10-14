import { FlaskConical } from 'lucide-react';
import { useI18n } from '../../i18n';
import { useSglangTags } from '../../lib/queries-engines';
import { activeEvent, useDockerStatus, useEngineStatuses, useInstallEvent, useSaveEngine, useStartInstall, useSystemCheck } from '../../lib/queries-library';
import { useSettings } from '../../lib/settings';
import { ErrorCallout } from '../library/error-callout';
import { InstallProgress } from '../setup/install-progress';
import { Button } from '../ui/button';
import { Skeleton } from '../ui/skeleton';
import { EngineCard } from './engine-card';
import { EngineUpdatePanel } from './engine-update';
import { NativeEnvRow } from './native-env';
import { ImageTagList } from './image-tags';

export const SGLANG_REPO = 'lmsysorg/sglang';

/**
 * SGLang in Docker (Windows through Docker Desktop's WSL2 GPU, Linux with the NVIDIA toolkit): the
 * release tags from Docker Hub, the recommended one marked; each one downloaded, used or removed (ImageTagList).
 */
export function SglangDockerCard() {
  const { t } = useI18n();
  const { settings } = useSettings();
  const docker = useDockerStatus();
  const tags = useSglangTags(true);
  const save = useSaveEngine();
  const running = docker.data?.state === 'running';
  const last = settings.lastEngine;
  const current = last?.kind === 'sglang-docker' && last.customEngineId === undefined ? last.image : undefined;
  const list = tags.data ?? [];
  return (
    <EngineCard
      icon={<FlaskConical />}
      title={t('engines.sglang.dockerTitle')}
      description={t('engines.sglang.dockerDesc')}
      status={running ? { tone: 'success', text: t('engines.status.ready') } : { tone: 'warning', text: t('engines.status.needsDocker') }}
    >
      {tags.isError && <ErrorCallout error={tags.error} />}
      {tags.isPending && <Skeleton className="h-24" />}
      {list.length > 0 && (
        <ImageTagList
          repo={SGLANG_REPO}
          engine="sglang-docker"
          tags={list}
          current={current}
          dockerUp={running}
          label={t('engines.sglang.tags')}
          allLabel={(n) => t('engines.sglang.allTags', { n })}
          onUse={(image) => save.mutate({ kind: 'sglang-docker', image })}
        />
      )}
      <EngineUpdatePanel target="sglang-docker" name={t('engines.sglang.dockerTitle')} enabled={running} />
      {save.isError && <ErrorCallout error={save.error} />}
    </EngineCard>
  );
}

/** SGLang installed on Linux, in its own environment through uv (uv first when it is missing). Hidden where it cannot run. */
export function SglangNativeCard() {
  const { t } = useI18n();
  const engines = useEngineStatuses();
  const check = useSystemCheck();
  const start = useStartInstall();
  const status = engines.data?.find((e) => e.kind === 'sglang-native');
  // uv comes with the vLLM check item: the same installer serves both.
  const needsUv = check.data?.items.find((i) => i.id === 'vllm-native')?.action?.kind === 'install-uv';
  const key = needsUv ? 'uv' : 'sglang-native';
  const event = useInstallEvent(key);
  const running = activeEvent(event);
  if (!status || status.supported === false) return null;
  return (
    <EngineCard
      icon={<FlaskConical />}
      title={t('engines.sglang.nativeTitle')}
      description={t('engines.sglang.nativeDesc')}
      status={status.available ? { tone: 'success', text: t('engines.status.ready') } : { tone: 'neutral', text: t('engines.status.notInstalled') }}
      footer={
        status.available ? undefined : running ? (
          <InstallProgress event={running} label={t('engines.sglang.nativeTitle')} className="w-full" />
        ) : (
          <Button size="sm" onClick={() => start.mutate({ key, path: needsUv ? '/api/setup/uv/install' : '/api/engines/sglang-native/install' })}>
            {needsUv ? t('setup.actions.install-uv') : t('engines.sglang.install')}
          </Button>
        )
      }
    >
      {status.version && <p className="text-sm text-fg-2">{t('engines.sglang.nativeVersion', { version: status.version })}</p>}
      <EngineUpdatePanel target="sglang-native" name={t('engines.sglang.nativeTitle')} enabled={status.available} />
      <NativeEnvRow kind="sglang-native" name={t('engines.sglang.nativeTitle')} />
      {event?.stage === 'error' && <ErrorCallout error={event.error ?? { code: 'ENGINE_INSTALL_FAILED', message: key }} />}
    </EngineCard>
  );
}
