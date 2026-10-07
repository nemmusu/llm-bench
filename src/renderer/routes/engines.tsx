import { useNavigate } from '@tanstack/react-router';
import { Globe } from 'lucide-react';
import { DockerCard } from '../components/engines/docker-card';
import { EngineCard } from '../components/engines/engine-card';
import { LlamaCard } from '../components/engines/llama-card';
import { VllmDockerCard, VllmNativeCard } from '../components/engines/vllm-card';
import { SystemCheckPanel } from '../components/setup/system-check';
import { Page } from '../components/shell/page';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { useI18n } from '../i18n';
import { useSystemCheck } from '../lib/queries-library';
import { useSettings } from '../lib/settings';

/** Engines and the system check: install, update, pick a version, custom executable, Docker with the GPU. */
export function EnginesPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { update } = useSettings();
  const check = useSystemCheck();
  const llamaBytes = check.data?.items.find((i) => i.id === 'llamacpp')?.action?.bytes;
  return (
    <Page title={t('engines.title')} subtitle={t('engines.subtitle')}>
      <div className="flex flex-col gap-section">
        <Card className="p-card">
          <SystemCheckPanel onPickModel={() => void navigate({ to: '/models', search: { tab: 'download', view: 'curated' } })} />
        </Card>
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <LlamaCard installBytes={llamaBytes} />
          <DockerCard />
          <VllmDockerCard />
          <VllmNativeCard />
          <EngineCard
            icon={<Globe />}
            title={t('engines.kinds.external')}
            description={t('engines.desc.external')}
            status={{ tone: 'neutral', text: t('engines.status.configure') }}
            footer={
              <Button
                size="sm"
                onClick={() => {
                  update({ expertMode: true, lastEngine: { kind: 'external' } });
                  void navigate({ to: '/' });
                }}
              >
                {t('engines.external.configure')}
              </Button>
            }
          />
        </div>
      </div>
    </Page>
  );
}
