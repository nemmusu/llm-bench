import { useNavigate } from '@tanstack/react-router';
import { Check, Download, Sparkles } from 'lucide-react';
import { useState } from 'react';
import type { CuratedModel } from '../../../contract/views';
import { useI18n } from '../../i18n';
import { useCurated, useLibraryModels } from '../../lib/queries-library';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Skeleton } from '../ui/skeleton';
import { DownloadDialog, type DownloadChoice } from './download-dialog';
import { ErrorCallout } from './error-callout';
import { curatedWeakKey, fileName } from './helpers';
import { FitFor, TriedFor } from './model-badges';

const PREVIEW = 6;

export type EngineFormat = 'gguf' | 'safetensors' | 'any';

function choiceOf(m: CuratedModel): DownloadChoice {
  return {
    repo: m.repo,
    revision: m.revision,
    files: m.file ? [m.file] : ['*'],
    label: m.label,
    sizeBytes: m.sizeBytes,
    weakKey: curatedWeakKey(m),
    sha256: m.sha256,
  };
}

/** "Consigliati per la tua GPU": the bundled list for this VRAM tier, each with fit and tried badges. */
export function CuratedList({ format }: { format: EngineFormat }) {
  const { t, bytes, number } = useI18n();
  const navigate = useNavigate();
  const curated = useCurated();
  const local = useLibraryModels();
  const [all, setAll] = useState(false);
  const [choice, setChoice] = useState<DownloadChoice>();
  const engine = format === 'gguf' ? 'llamacpp' : format === 'safetensors' ? 'vllm' : undefined;
  const models = (curated.data?.models ?? []).filter((m) => !engine || m.engine === engine);
  const shown = all ? models : models.slice(0, PREVIEW);
  const isLocal = (m: CuratedModel) => local.data?.some((l) => l.identity.repo === m.repo && (!m.file || fileName(l.identity.file ?? '') === m.file));

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-1">
          <CardTitle className="flex items-center gap-2">
            <Sparkles aria-hidden className="size-4 text-accent-text" />
            {t('models.curated.title')}
          </CardTitle>
          <CardDescription>
            {curated.data?.vramGB ? t('models.curated.subtitle', { vram: number(curated.data.vramGB, 0) }) : t('models.curated.subtitleNoGpu')}
          </CardDescription>
        </div>
      </CardHeader>
      {curated.isError && <ErrorCallout error={curated.error} className="m-card" />}
      {curated.isPending && <Skeleton className="m-card h-32" />}
      <ul className="mt-3 divide-y divide-border border-t border-border" aria-label={t('models.curated.title')}>
        {shown.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center gap-4 px-card py-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <p className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-semibold text-fg">{m.label}</span>
                <span className="text-sm text-fg-3">
                  {t('models.params', { n: number(m.paramsB, 1) })} · {bytes(m.sizeBytes)} · {t(`models.engineFor.${m.engine}`)}
                </span>
              </p>
              <p className="truncate font-mono text-xs text-fg-3">{m.repo}</p>
              <div className="mt-0.5 flex flex-wrap gap-1.5">
                {m.reference && (
                  <Badge tone="accent" size="sm">
                    {t('models.curated.reference')}
                  </Badge>
                )}
                <FitFor req={m.file ? { repo: m.repo, file: m.file, engine: 'llamacpp-native' } : { repo: m.repo, engine: 'vllm-docker' }} />
                <TriedFor weakKey={curatedWeakKey(m)} sha256={m.sha256} />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => void navigate({ to: '/models/hub/$owner/$name', params: { owner: m.repo.split('/')[0] as string, name: m.repo.split('/')[1] as string } })}>
                {t('models.details')}
              </Button>
              {isLocal(m) ? (
                <Badge tone="success">
                  <Check aria-hidden />
                  {t('models.onPc')}
                </Badge>
              ) : (
                <Button size="sm" onClick={() => setChoice(choiceOf(m))} aria-label={`${t('common.download')} ${m.label} · ${bytes(m.sizeBytes)}`}>
                  <Download aria-hidden />
                  {bytes(m.sizeBytes)}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {models.length > PREVIEW && (
        <div className="border-t border-border px-card py-3">
          <Button variant="link" onClick={() => setAll((a) => !a)}>
            {all ? t('models.curated.less') : t('models.curated.all', { n: models.length })}
          </Button>
        </div>
      )}
      <DownloadDialog choice={choice} onOpenChange={(o) => !o && setChoice(undefined)} />
    </Card>
  );
}
