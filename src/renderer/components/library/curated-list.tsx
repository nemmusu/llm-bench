import { Check, Download } from 'lucide-react';
import { useState } from 'react';
import type { CuratedModel, CuratedResponse } from '../../../contract/views';

/** A suggestion as the core sends it: the bundled entry plus its VRAM verdict on this card. */
export type Suggestion = CuratedResponse['models'][number];
import { useI18n } from '../../i18n';
import { useCurated, useLibraryModels } from '../../lib/queries-library';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { EmptyState } from '../ui/empty-state';
import { FitBadge } from '../ui/fit-badge';
import { Skeleton } from '../ui/skeleton';
import { RowFacts, RowTitle, rowClass } from './catalog-rows';
import { DownloadDialog, type DownloadChoice } from './download-dialog';
import { ErrorCallout } from './error-callout';
import type { CatalogFormat } from './formats';
import { curatedWeakKey, fileName } from './helpers';
import { TriedFor } from './model-badges';

/** The suggestions a format can run: GGUF for llama.cpp, whole repos for vLLM / SGLang, both; none for NInfer yet. */
export function curatedFor<T extends Pick<CuratedModel, 'engine'>>(models: readonly T[], format: CatalogFormat): T[] {
  if (format === 'ninfer') return [];
  const engine = format === 'gguf' ? 'llamacpp' : format === 'safetensors' ? 'vllm' : undefined;
  return models.filter((m) => !engine || m.engine === engine);
}

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
 * "Consigliati per la tua GPU" as compact rows in the catalog: the bundled, verified list for this
 * VRAM tier, each with its exact file. The core judges each entry on that file size, so the fit
 * badges come with the list; the download button is right on the row.
 */
export function CuratedRows({ models, showEngine }: { models: Suggestion[]; showEngine: boolean }) {
  const { t, bytes, number } = useI18n();
  const curated = useCurated();
  const local = useLibraryModels();
  const [choice, setChoice] = useState<DownloadChoice>();
  const isLocal = (m: CuratedModel) => local.data?.some((l) => l.identity.repo === m.repo && (!m.file || fileName(l.identity.file ?? '') === m.file));
  // The tier ("32 GB"), not the 31.8 GiB the card reports.
  const vram = curated.data?.tierGB ?? curated.data?.vramGB;
  const mib = (n: number) => bytes(n * 1024 * 1024);

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-fg-2">{vram ? t('models.curated.subtitle', { vram: number(vram, 0) }) : t('models.curated.subtitleNoGpu')}</p>
      {curated.isError && <ErrorCallout error={curated.error} />}
      {curated.isPending && <Skeleton className="h-32 rounded-lg" />}
      {curated.isSuccess && models.length === 0 && (
        <EmptyState illustration="search" title={t('models.search.noResults')} description={t('models.search.noResultsBody')} headingLevel={3} className="rounded-xl border border-dashed border-border" />
      )}
      <ul className="grid gap-2 @5xl/page:grid-cols-2 @[100rem]/page:grid-cols-3" aria-label={t('models.curated.title')}>
        {models.map((m) => {
          const [owner, name] = m.repo.split('/') as [string, string];
          return (
            <li key={m.id} className={`${rowClass} sm:flex-row sm:items-center sm:gap-3`}>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <RowTitle
                  owner={owner}
                  name={name}
                  extra={
                    <span className="relative z-10 shrink-0">
                      <TriedFor weakKey={curatedWeakKey(m)} sha256={m.sha256} />
                    </span>
                  }
                />
                <RowFacts>
                  {[
                    <span className="font-medium text-fg-2">{m.quant}</span>,
                    m.reference && (
                      <Badge tone="accent" size="sm">
                        {t('models.curated.reference')}
                      </Badge>
                    ),
                    m.fit && (
                      <span className="relative z-10">
                        <FitBadge short level={m.fit.level} size="sm" detail={t('models.catalog.fitDetail', { quant: m.fit.quant, need: mib(m.fit.needMiB), available: mib(m.fit.availableMiB) })} />
                      </span>
                    ),
                    <span>{t('models.paramsShort', { n: number(m.paramsB, Number.isInteger(m.paramsB) || m.paramsB >= 10 ? 0 : 1) })}</span>,
                    // The engine is news only when the list mixes llama.cpp and vLLM suggestions.
                    showEngine && <span>{t(`models.engineFor.${m.engine}`)}</span>,
                  ]}
                </RowFacts>
              </div>
              <div className="relative z-10 shrink-0">
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
          );
        })}
      </ul>
      <DownloadDialog choice={choice} onOpenChange={(o) => !o && setChoice(undefined)} />
    </div>
  );
}
