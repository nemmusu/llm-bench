import { ExternalLink, FolderOpen } from 'lucide-react';
import { useI18n } from '../../i18n';
import { useAppHealth, useSystemInfo } from '../../lib/queries-library';
import { Logo } from '../brand/logo';
import { Button } from '../ui/button';
import { Section } from './section';

/** Projects LLM Bench builds on, with their licenses. */
export const CREDITS = [
  { name: 'llama.cpp', license: 'MIT', url: 'https://github.com/ggml-org/llama.cpp' },
  { name: 'vLLM', license: 'Apache-2.0', url: 'https://github.com/vllm-project/vllm' },
  { name: 'SGLang', license: 'Apache-2.0', url: 'https://github.com/sgl-project/sglang' },
  { name: 'llmfit', license: 'MIT', url: 'https://github.com/AlexsJones/llmfit', noteKey: 'about.llmfit' },
  { name: 'Hugging Face Hub', license: 'Apache-2.0', url: 'https://github.com/huggingface/huggingface.js' },
] as const;

/** Where new versions of LLM Bench are: the app does not update itself, so it says where to look. */
export const RELEASES_URL = 'https://github.com/nemmusu/llm-bench/releases/latest';

export function AboutSection() {
  const { t } = useI18n();
  const health = useAppHealth();
  const system = useSystemInfo();
  const dataDir = system.data?.paths.dataDir;
  return (
    <Section title={t('about.title')}>
      <div className="flex flex-col gap-5 pb-1">
        <div className="flex items-start gap-4">
          <Logo size={40} />
          <div className="flex flex-col gap-1 text-sm">
            <p className="font-semibold">
              {t('app.name')} {health.data && <span className="font-normal text-fg-3 tabular-nums">{t('about.version', { version: health.data.version })}</span>}
            </p>
            <p className="text-fg-2">{t('about.body')}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="min-w-0 flex-1 text-sm text-fg-2">{t('about.updateHow')}</p>
          <Button size="sm" onClick={() => void window.gpubench?.openExternal(RELEASES_URL)}>
            <ExternalLink aria-hidden />
            {t('about.releases')}
          </Button>
        </div>
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-fg-3">{t('about.credits')}</h3>
          <ul className="flex flex-col gap-1.5 text-sm">
            {CREDITS.map((c) => (
              <li key={c.name} className="flex flex-wrap items-center gap-x-2">
                <Button variant="link" onClick={() => void window.gpubench?.openExternal(c.url)}>
                  {c.name}
                  <ExternalLink aria-hidden />
                </Button>
                <span className="text-xs text-fg-3">{t('about.license', { license: c.license })}</span>
                {'noteKey' in c && <span className="w-full text-xs text-fg-2">{t(c.noteKey)}</span>}
              </li>
            ))}
          </ul>
        </div>
        {dataDir && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <div className="flex min-w-0 flex-col">
              <span className="text-sm font-medium">{t('about.dataDir')}</span>
              <span className="truncate font-mono text-xs text-fg-3" title={dataDir}>
                {dataDir}
              </span>
            </div>
            <Button size="sm" onClick={() => void window.gpubench?.revealPath(dataDir)}>
              <FolderOpen aria-hidden />
              {t('about.openDataDir')}
            </Button>
          </div>
        )}
      </div>
    </Section>
  );
}
