import { Box, TriangleAlert } from 'lucide-react';
import { useI18n } from '../../i18n';
import {
  activeEvent,
  useDockerStatus,
  useEngineStatuses,
  useInstallEvent,
  useSaveEngine,
  useStartInstall,
  useSystemCheck,
  useVllmTags,
} from '../../lib/queries-library';
import { useSettings } from '../../lib/settings';
import { ErrorCallout } from '../library/error-callout';
import { InstallProgress } from '../setup/install-progress';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Skeleton } from '../ui/skeleton';
import { EngineCard } from './engine-card';
import { EngineUpdatePanel } from './engine-update';
import { NativeEnvRow } from './native-env';
import { ImageTagList } from './image-tags';

export const VLLM_REPO = 'vllm/vllm-openai';

/** vLLM in Docker: the image tags from Docker Hub, the one recommended for this GPU marked. */
export function VllmDockerCard() {
  const { t } = useI18n();
  const { settings } = useSettings();
  const docker = useDockerStatus();
  const tags = useVllmTags(true);
  const save = useSaveEngine();
  const running = docker.data?.state === 'running';
  const current = settings.lastEngine?.kind === 'vllm-docker' ? settings.lastEngine.image : undefined;
  const list = tags.data ?? [];
  return (
    <EngineCard
      icon={<Box />}
      title={t('engines.kinds.vllm-docker')}
      description={t('engines.desc.vllm-docker')}
      status={running ? { tone: 'success', text: t('engines.status.ready') } : { tone: 'warning', text: t('engines.status.needsDocker') }}
    >
      {tags.isError && <ErrorCallout error={tags.error} />}
      {tags.isPending && <Skeleton className="h-24" />}
      {list.length > 0 && (
        <ImageTagList
          repo={VLLM_REPO}
          engine="vllm-docker"
          tags={list}
          current={current}
          dockerUp={running}
          label={t('engines.vllm.tags')}
          allLabel={(n) => t('engines.vllm.allTags', { n })}
          onUse={(image) => save.mutate({ kind: 'vllm-docker', image })}
          badges={(tag) =>
            tag.supportsGpu === false && (
              <Badge size="sm" tone="warning">
                <TriangleAlert aria-hidden />
                {t('engines.vllm.noGpuSupport')}
              </Badge>
            )
          }
        />
      )}
      <EngineUpdatePanel target="vllm-docker" name={t('engines.kinds.vllm-docker')} enabled={running} />
      {save.isError && <ErrorCallout error={save.error} />}
    </EngineCard>
  );
}

/** vLLM installed on Linux (in its own environment, through uv). */
export function VllmNativeCard() {
  const { t } = useI18n();
  const engines = useEngineStatuses();
  const check = useSystemCheck();
  const start = useStartInstall();
  const item = check.data?.items.find((i) => i.id === 'vllm-native');
  const status = engines.data?.find((e) => e.kind === 'vllm-native');
  const action = item?.action;
  const key = action?.kind === 'install-uv' ? 'uv' : 'vllm-native';
  const event = useInstallEvent(key);
  const running = activeEvent(event);
  const supported = status?.supported !== false && item?.state !== 'unsupported';
  return (
    <EngineCard
      icon={<Box />}
      title={t('engines.kinds.vllm-native')}
      description={t('engines.desc.vllm-native')}
      status={
        !supported
          ? { tone: 'neutral', text: t('engines.status.unsupported') }
          : status?.available
            ? { tone: 'success', text: t('engines.status.ready') }
            : { tone: 'neutral', text: t('engines.status.notInstalled') }
      }
      footer={
        supported && action ? (
          running ? (
            <InstallProgress event={running} label={t('engines.kinds.vllm-native')} className="w-full" />
          ) : (
            <Button
              size="sm"
              onClick={() => start.mutate({ key, path: action.kind === 'install-uv' ? '/api/setup/uv/install' : '/api/engines/vllm-native/install' })}
            >
              {t(`setup.actions.${action.kind as 'install-uv'}`)}
            </Button>
          )
        ) : undefined
      }
    >
      {supported && status?.version && <p className="text-sm text-fg-2">{t('engines.vllm.nativeVersion', { version: status.version })}</p>}
      <EngineUpdatePanel target="vllm-native" name={t('engines.kinds.vllm-native')} enabled={supported && status?.available === true} />
      <NativeEnvRow kind="vllm-native" name={t('engines.kinds.vllm-native')} />
      {event?.stage === 'error' && <ErrorCallout error={event.error ?? { code: 'ENGINE_INSTALL_FAILED', message: key }} />}
    </EngineCard>
  );
}
