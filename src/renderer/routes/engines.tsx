import { Box, Container, Download, FileCog, Globe, Play, Server } from 'lucide-react';
import type { ReactNode } from 'react';
import type { EngineKind, EngineStatus } from '../../contract/engines';
import { Page } from '../components/shell/page';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Skeleton } from '../components/ui/skeleton';
import { StatusDot } from '../components/ui/status-dot';
import { useI18n } from '../i18n';
import { useEngines } from '../lib/queries';
import { DEFAULT_IMAGES } from '../mock/plan';
import { LLAMACPP_DOWNLOAD_BYTES } from '../mock/system';

const icons: Record<EngineKind, ReactNode> = {
  'llamacpp-native': <Server />,
  'llamacpp-docker': <Container />,
  'vllm-docker': <Box />,
  'vllm-native': <FileCog />,
  external: <Globe />,
};

function EngineCard({ e }: { e: EngineStatus }) {
  const { t, bytes } = useI18n();
  const dockerDown = e.problems.includes('DOCKER_NOT_RUNNING');
  const status = !e.supported
    ? { tone: 'neutral' as const, text: t('engines.status.unsupported') }
    : e.available
      ? { tone: 'success' as const, text: e.kind === 'external' ? t('engines.status.configure') : t('engines.status.ready') }
      : dockerDown
        ? { tone: 'warning' as const, text: t('engines.status.dockerStopped') }
        : { tone: 'danger' as const, text: t('engines.status.notInstalled') };
  return (
    <Card className="flex flex-col">
      <div className="flex items-start gap-4 p-card">
        <span aria-hidden className="grid size-11 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-text [&_svg]:size-5">
          {icons[e.kind]}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-md font-semibold">{t(`benchmark.engines.${e.kind}`)}</h2>
            {e.kind === 'llamacpp-native' && (
              <Badge tone="accent" size="sm">
                {t('common.recommended')}
              </Badge>
            )}
          </div>
          <p className="text-sm text-fg-2">{t(`benchmark.engineDesc.${e.kind}`)}</p>
          {DEFAULT_IMAGES[e.kind] && (
            <p className="mt-1 font-mono text-xs text-fg-3">
              {t('engines.image')}: {DEFAULT_IMAGES[e.kind]}
            </p>
          )}
        </div>
        <span className="inline-flex items-center gap-2 text-sm text-fg-2">
          <StatusDot tone={status.tone} />
          {status.text}
        </span>
      </div>
      <div className="mt-auto flex flex-wrap gap-2 border-t border-border px-card py-3">
        {e.kind === 'llamacpp-native' && (
          <>
            <Button variant="primary" size="sm">
              <Download aria-hidden />
              {t('engines.actions.install', { size: bytes(LLAMACPP_DOWNLOAD_BYTES) })}
            </Button>
            <Button size="sm">{t('engines.actions.customExe')}</Button>
          </>
        )}
        {dockerDown && (
          <Button size="sm">
            <Play aria-hidden />
            {t('engines.actions.startDocker')}
          </Button>
        )}
        {e.kind === 'external' && <Button size="sm">{t('engines.actions.configure')}</Button>}
      </div>
    </Card>
  );
}

/** Engine status and one-click fixes. */
export function EnginesPage() {
  const { t } = useI18n();
  const engines = useEngines();
  return (
    <Page title={t('engines.title')} subtitle={t('engines.subtitle')}>
      <div className="grid gap-4 lg:grid-cols-2">
        {engines.isPending
          ? [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-40" />)
          : (engines.data ?? []).map((e) => <EngineCard key={e.kind} e={e} />)}
      </div>
    </Page>
  );
}
