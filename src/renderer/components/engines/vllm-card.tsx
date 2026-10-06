import { Box, Check, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
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
import { PullButton } from './docker-card';
import { EngineCard } from './engine-card';

export const VLLM_REPO = 'vllm/vllm-openai';
const PREVIEW = 6;

/** vLLM in Docker: the image tags from Docker Hub, the one recommended for this GPU marked. */
export function VllmDockerCard() {
  const { t, bytes, date } = useI18n();
  const { settings } = useSettings();
  const docker = useDockerStatus();
  const tags = useVllmTags(true);
  const save = useSaveEngine();
  const [all, setAll] = useState(false);
  const running = docker.data?.state === 'running';
  const current = settings.lastEngine?.kind === 'vllm-docker' ? settings.lastEngine.image : undefined;
  const list = tags.data ?? [];
  const shown = all ? list : list.slice(0, PREVIEW);
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
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border" aria-label={t('engines.vllm.tags')}>
          {shown.map((tag) => {
            const image = `${VLLM_REPO}:${tag.name}`;
            return (
              <li key={tag.name} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-semibold text-fg">{tag.name}</span>
                    {tag.recommended && (
                      <Badge size="sm" tone="accent">
                        {t('common.recommended')}
                      </Badge>
                    )}
                    {tag.supportsGpu === false && (
                      <Badge size="sm" tone="warning">
                        <TriangleAlert aria-hidden />
                        {t('engines.vllm.noGpuSupport')}
                      </Badge>
                    )}
                    {current === image && (
                      <Badge size="sm" tone="success">
                        <Check aria-hidden />
                        {t('engines.llama.inUse')}
                      </Badge>
                    )}
                  </span>
                  <span className="text-xs text-fg-3 tabular-nums">
                    {[tag.cuda ? `CUDA ${tag.cuda}` : undefined, tag.sizeBytes ? bytes(tag.sizeBytes) : undefined, tag.lastUpdated ? date(tag.lastUpdated) : undefined].filter(Boolean).join(' · ')}
                  </span>
                </span>
                {current !== image && (
                  <Button size="sm" variant="ghost" onClick={() => save.mutate({ kind: 'vllm-docker', image })}>
                    {t('engines.vllm.use')}
                  </Button>
                )}
                <PullButton engine="vllm-docker" image={image} label={t('engines.vllm.pull')} disabled={!running} />
              </li>
            );
          })}
        </ul>
      )}
      {list.length > PREVIEW && (
        <Button variant="link" className="self-start" onClick={() => setAll((a) => !a)}>
          {all ? t('models.curated.less') : t('engines.vllm.allTags', { n: list.length })}
        </Button>
      )}
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
      {event?.stage === 'error' && <ErrorCallout error={event.error ?? { code: 'ENGINE_INSTALL_FAILED', message: key }} />}
    </EngineCard>
  );
}
