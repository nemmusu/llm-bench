import { useNavigate } from '@tanstack/react-router';
import { Check, Download, Sparkles } from 'lucide-react';
import { useState } from 'react';
import type { CuratedModel } from '../../../contract/views';
import { useI18n } from '../../i18n';
import { useCurated, useLibraryModels } from '../../lib/queries-library';
import { Badge } from '../ui/badge';
import { FitBadge } from '../ui/fit-badge';
import { Button } from '../ui/button';
import { Skeleton } from '../ui/skeleton';
import { DownloadDialog, type DownloadChoice } from './download-dialog';
import { ErrorCallout } from './error-callout';
import { curatedWeakKey, fileName } from './helpers';
import { TriedFor } from './model-badges';

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

/**
 * "Consigliati per la tua GPU": the bundled, verified list for this VRAM tier, highlighted above the
 * catalog. The core judges each entry on its exact file size, so the badges come with the list.
 */
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
  // The tier ("32 GB"), not the 31.8 GiB the card reports.
  const vram = curated.data?.tierGB ?? curated.data?.vramGB;
  const mib = (n: number) => bytes(n * 1024 * 1024);

  return (
    <section aria-labelledby="curated-title" className="flex flex-col gap-4 rounded-2xl border border-accent-line bg-accent-soft/40 p-5">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <div className="flex flex-col gap-1">
          <h2 id="curated-title" className="flex items-center gap-2 text-lg font-semibold tracking-[-0.01em]">
            <Sparkles aria-hidden className="size-4 text-accent-text" />
            {t('models.curated.title')}
          </h2>
          <p className="text-sm text-fg-2">{vram ? t('models.curated.subtitle', { vram: number(vram, 0) }) : t('models.curated.subtitleNoGpu')}</p>
        </div>
        {models.length > PREVIEW && (
          <Button variant="link" onClick={() => setAll((a) => !a)}>
            {all ? t('models.curated.less') : t('models.curated.all', { n: models.length })}
          </Button>
        )}
      </div>
      {curated.isError && <ErrorCallout error={curated.error} />}
      {curated.isPending && <Skeleton className="h-40 rounded-xl" />}
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label={t('models.curated.title')}>
        {shown.map((m) => (
          <li key={m.id} className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-xs">
            <div className="flex min-w-0 flex-col gap-0.5">
              <h3 className="text-sm leading-snug font-semibold text-fg">{m.label}</h3>
              <p className="text-xs text-fg-3 tabular-nums">
                {t('models.params', { n: number(m.paramsB, 1) })} · {bytes(m.sizeBytes)} · {t(`models.engineFor.${m.engine}`)}
              </p>
              <p className="truncate font-mono text-2xs text-fg-3">{m.repo}</p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {m.reference && (
                <Badge tone="accent" size="sm">
                  {t('models.curated.reference')}
                </Badge>
              )}
              {m.fit && <FitBadge level={m.fit.level} size="sm" detail={t('models.catalog.fitDetail', { quant: m.fit.quant, need: mib(m.fit.needMiB), available: mib(m.fit.availableMiB) })} />}
              <TriedFor weakKey={curatedWeakKey(m)} sha256={m.sha256} />
            </div>
            <div className="mt-auto flex items-center justify-end gap-2 border-t border-border pt-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void navigate({ to: '/models/hub/$owner/$name', params: { owner: m.repo.split('/')[0] as string, name: m.repo.split('/')[1] as string } })}
              >
                {t('models.details')}
              </Button>
              {isLocal(m) ? (
                <Badge tone="success">
                  <Check aria-hidden />
                  {t('models.onPc')}
                </Badge>
              ) : (
                <Button size="sm" variant="primary" onClick={() => setChoice(choiceOf(m))} aria-label={`${t('common.download')} ${m.label} · ${bytes(m.sizeBytes)}`}>
                  <Download aria-hidden />
                  {bytes(m.sizeBytes)}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      <DownloadDialog choice={choice} onOpenChange={(o) => !o && setChoice(undefined)} />
    </section>
  );
}
