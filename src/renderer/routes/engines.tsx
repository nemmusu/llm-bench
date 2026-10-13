import { useNavigate, useSearch } from '@tanstack/react-router';
import { Globe } from 'lucide-react';
import { CUSTOM_ENGINE_TEMPLATES } from '../../contract/custom-engines';
import { CustomEnginesSection } from '../components/engines/custom-engines';
import { DockerCard } from '../components/engines/docker-card';
import { EngineCard } from '../components/engines/engine-card';
import { LlamaCard } from '../components/engines/llama-card';
import { SglangDockerCard, SglangNativeCard } from '../components/engines/sglang-card';
import { NinferCard } from '../components/engines/ninfer-card';
import { VllmDockerCard, VllmNativeCard } from '../components/engines/vllm-card';
import { SystemCheckPanel } from '../components/setup/system-check';
import { Page } from '../components/shell/page';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { useI18n } from '../i18n';
import { useBenchLocalModels } from '../lib/queries-runs';
import { useSystemCheck } from '../lib/queries-library';
import { useSettings } from '../lib/settings';

/**
 * /engines?customTemplate=<id>&model=<weakKey>&modelName=<label>: opens "Aggiungi motore" filled from
 * a built-in template (CUSTOM_ENGINE_TEMPLATES), saying which model asked for it. Unknown ids are dropped.
 */
export interface EnginesSearch {
  customTemplate?: string;
  model?: string;
  modelName?: string;
}

export function validateEnginesSearch(s: Record<string, unknown>): EnginesSearch {
  const pick = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const template = pick(s.customTemplate);
  const model = pick(s.model);
  const modelName = pick(s.modelName);
  return {
    ...(template && CUSTOM_ENGINE_TEMPLATES.some((x) => x.id === template) ? { customTemplate: template } : {}),
    ...(model ? { model } : {}),
    ...(modelName ? { modelName } : {}),
  };
}

/** Engines and the system check: install, update, pick a version, custom executable, Docker with the GPU, custom engines. */
export function EnginesPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const search = useSearch({ from: '/engines' });
  const { update } = useSettings();
  const check = useSystemCheck();
  const local = useBenchLocalModels();
  const llamaBytes = check.data?.items.find((i) => i.id === 'llamacpp')?.action?.bytes;
  const template = CUSTOM_ENGINE_TEMPLATES.find((x) => x.id === search.customTemplate);
  // The model that asked for it: its name as given, else the library's name for its weak key.
  const asked = search.modelName ?? local.data?.find((m) => m.identity.weakKey === search.model)?.identity.displayName;
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
          <SglangDockerCard />
          <SglangNativeCard />
          <NinferCard />
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
        <CustomEnginesSection
          // A new deep link mounts a new section (its dialog opens from it).
          key={search.customTemplate ?? 'none'}
          template={template}
          forModel={asked}
          onTemplateDone={() => {
            if (search.customTemplate) void navigate({ to: '/engines', search: {}, replace: true });
          }}
        />
      </div>
    </Page>
  );
}
