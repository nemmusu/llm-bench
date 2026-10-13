import { Link, useLocation, useParams, useRouter } from '@tanstack/react-router';
import { ArrowLeft, Download, ExternalLink, FileBox, FolderTree, Heart, Lock, RotateCcw } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { repoLayout, type RepoLayout } from '../../contract/formats';
import type { HubFile, HubModel } from '../../contract/models';
import { ninferGpuSupported } from '../../contract/ninfer';
import type { HubFitResult } from '../../contract/views';
import { lastCatalogSearch } from '../components/library/catalog-search';
import { DownloadDialog, type DownloadChoice } from '../components/library/download-dialog';
import { ErrorCallout } from '../components/library/error-callout';
import { FormatBadge, FormatBadges, OtherFormatBadge, type ModelFormat } from '../components/library/formats';
import { HF_BASE, fileName, repoFiles, repoUrl } from '../components/library/helpers';
import { HfTokenForm } from '../components/library/hf-token';
import { ModelDetailSlots } from '../components/library/model-detail-slots';
import { OnThisPc } from '../components/library/model-updates';
import { QuantChooser } from '../components/library/quant-chooser';
import { Page } from '../components/shell/page';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Callout } from '../components/ui/callout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Skeleton } from '../components/ui/skeleton';
import { useI18n } from '../i18n';
import { Markdown } from '../lib/markdown/render';
import { errorData, useHubFiles, useHubFit, useHubModel, useMainGpu, useReadme, useRelated } from '../lib/queries-library';
import { useSettings } from '../lib/settings';

const openHf = (repo: string) => void window.gpubench?.openExternal(repoUrl(repo));

/** "Serve accettare la licenza": what to do, in order, each step with its button. */
function LicenseHelp({ repo, onRetry }: { repo: string; onRetry: () => void }) {
  const { t } = useI18n();
  const { settings } = useSettings();
  return (
    <Callout tone="warning" title={t('models.detail.gatedTitle')}>
      <ol className="mt-1 flex list-decimal flex-col gap-3 pl-5">
        <li>
          <p>{t('models.detail.gatedStep1')}</p>
          <Button size="sm" className="mt-2" onClick={() => openHf(repo)}>
            <ExternalLink aria-hidden />
            {t('models.detail.acceptLicense')}
          </Button>
        </li>
        <li>
          <p>{settings.hasHfToken ? t('models.detail.gatedStep2Done') : t('models.detail.gatedStep2')}</p>
          {!settings.hasHfToken && (
            <div className="mt-2">
              <HfTokenForm onSaved={onRetry} allowClear={false} />
            </div>
          )}
        </li>
        <li>
          <p>{t('models.detail.gatedStep3')}</p>
          <Button size="sm" variant="primary" className="mt-2" onClick={onRetry}>
            <RotateCcw aria-hidden />
            {t('common.retry')}
          </Button>
        </li>
      </ol>
    </Callout>
  );
}

function Related({ info, repo }: { info: HubModel | null | undefined; repo: string }) {
  const { t, integer } = useI18n();
  const base = info?.baseModel ?? repo;
  const related = useRelated(info === undefined ? undefined : base);
  const list = (related.data ?? []).filter((m) => m.repo !== repo);
  if (list.length === 0) return null;
  const byAuthor = new Map<string, HubModel[]>();
  for (const m of list) byAuthor.set(m.author, [...(byAuthor.get(m.author) ?? []), m]);
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>{t('models.detail.related')}</CardTitle>
          <CardDescription>{t('models.detail.relatedHint', { base })}</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {[...byAuthor].map(([author, models]) => (
          <div key={author}>
            <h3 className="text-xs font-medium text-fg-3">{author}</h3>
            <ul className="mt-1 flex flex-col">
              {models.map((m) => (
                <li key={m.repo}>
                  <Link
                    to="/models/hub/$owner/$name"
                    params={{ owner: m.author, name: m.name }}
                    className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-surface-2 focus-ring"
                  >
                    <span className="font-medium text-fg">{m.name}</span>
                    <span className="inline-flex items-center gap-1 text-xs text-fg-3 tabular-nums">
                      <Download aria-hidden className="size-3" />
                      {integer(m.downloads)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/** A download section of one format: its badge, what it means, and its choices (or why there are none). */
function FormatSection({ format, hint, fit, children }: { format: ModelFormat; hint: string; fit: ReturnType<typeof useHubFit>; children: (data: HubFitResult) => ReactNode }) {
  const { t } = useI18n();
  return (
    <Card data-format-section={format}>
      <CardHeader>
        <div className="flex min-w-0 flex-col gap-1.5">
          <CardTitle className="flex flex-wrap items-center gap-2">
            {t(`models.detail.sections.${format}`)}
            <FormatBadge format={format} />
          </CardTitle>
          <CardDescription>{hint}</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {fit.data ? (
          fit.data.choices.length > 0 ? (
            children(fit.data)
          ) : (
            <p className="text-sm text-fg-2">{t('models.detail.sections.empty')}</p>
          )
        ) : fit.isError ? (
          <p className="text-sm text-fg-3">{t('models.detail.fitUnavailable')}</p>
        ) : (
          <div className="flex flex-col gap-2" aria-label={t('common.loading')}>
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Files of formats GPU Bench cannot run: listed by format and folder, never downloaded as a model. */
function OtherFormats({ groups }: { groups: RepoLayout<HubFile>['other'] }) {
  const { t, bytes } = useI18n();
  return (
    <Card data-format-section="other">
      <CardHeader>
        <div className="flex min-w-0 flex-col gap-1.5">
          <CardTitle>{t('models.detail.sections.other')}</CardTitle>
          <CardDescription>{t('models.detail.sections.otherHint')}</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-2 text-sm">
          {groups.map((g) => (
            <li key={`${g.format}|${g.dir}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border px-3 py-2">
              <FileBox aria-hidden className="size-4 text-fg-3" />
              <OtherFormatBadge name={g.format === 'safetensors' ? undefined : g.format === 'MTP' ? t('models.aux.mtp') : g.format === 'draft' ? t('models.aux.draft') : g.format} module={g.format === 'MTP' || g.format === 'draft'} />
              <span className="font-mono text-xs text-fg-2">{g.dir ? t('models.detail.folder', { dir: g.dir }) : t('models.detail.rootFolder')}</span>
              <span className="text-xs text-fg-3">{t(g.files.length === 1 ? 'models.detail.fileCount1' : 'models.detail.fileCount', { n: g.files.length })}</span>
              <span className="ml-auto text-fg-2 tabular-nums">{bytes(g.sizeBytes)}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/**
 * One Hugging Face repo, split by format: "Per llama.cpp (GGUF)" (each quant, its extras), "Per vLLM /
 * SGLang (safetensors)" (each model folder, one download), "Per NInfer" (each .ninfer artifact with its
 * checks) and "Altri formati" (shown, never downloaded); then sections other features add, and the card.
 */
export function ModelDetailPage() {
  const { t, bytes, integer, number, relative } = useI18n();
  const { owner, name } = useParams({ from: '/models/hub/$owner/$name' });
  const router = useRouter();
  const fromCatalog = useLocation({ select: (l) => l.state.fromCatalog === true });
  const repo = `${owner}/${name}`;
  const info = useHubModel(repo);
  const files = useHubFiles(repo);
  const readme = useReadme(repo);
  const gpu = useMainGpu();
  const layout = files.data ? repoLayout(files.data, { name, tags: info.data?.tags ?? [] }) : undefined;
  const ggufFit = useHubFit(repo, layout && layout.gguf.weights.length > 0 ? 'llamacpp-native' : undefined);
  const stFit = useHubFit(repo, layout && layout.safetensors.length > 0 ? 'vllm-docker' : undefined);
  const ninferFit = useHubFit(repo, layout && layout.ninfer.length > 0 ? 'llamacpp-native' : undefined, 'ninfer');
  const fits = [ggufFit, stFit, ninferFit];
  const [choice, setChoice] = useState<DownloadChoice>();
  const m = info.data;
  const failed = fits.find((f) => f.isError);
  const fitCode = failed ? errorData(failed.error).code : undefined;
  const gated = fitCode === 'HF_GATED' || fitCode === 'HF_AUTH_REQUIRED';
  const retry = () => fits.forEach((f) => f.isError && void f.refetch());
  const facts = ggufFit.data?.facts ?? stFit.data?.facts ?? ninferFit.data?.facts;
  const nothing = layout !== undefined && layout.gguf.weights.length + layout.safetensors.length + layout.ninfer.length === 0;

  return (
    <Page
      title={name}
      subtitle={
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>{owner}</span>
          {m && (
            <span className="inline-flex items-center gap-3 text-sm text-fg-3 tabular-nums">
              <span className="inline-flex items-center gap-1">
                <Download aria-hidden className="size-3.5" />
                {t('models.search.downloads', { n: integer(m.downloads) })}
              </span>
              <span className="inline-flex items-center gap-1">
                <Heart aria-hidden className="size-3.5" />
                {t('models.search.likes', { n: integer(m.likes) })}
              </span>
              {m.updatedAt && <span>{t('models.search.updated', { when: relative(m.updatedAt) })}</span>}
            </span>
          )}
        </span>
      }
      eyebrow={
        <Link
          to="/models"
          search={lastCatalogSearch()}
          // Opened from the catalog: back to it as it was (same list, same pages, same scroll).
          onClick={(e) => {
            if (!fromCatalog) return;
            e.preventDefault();
            router.history.back();
          }}
          className="inline-flex items-center gap-1 self-start rounded-xs text-sm text-fg-2 hover:text-fg focus-ring"
        >
          <ArrowLeft aria-hidden className="size-3.5" />
          {t('models.title')}
        </Link>
      }
      actions={
        <Button onClick={() => openHf(repo)}>
          <ExternalLink aria-hidden />
          {t('models.detail.openOnHf')}
        </Button>
      }
    >
      <div className="grid gap-section lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-w-0 flex-col gap-section">
          {files.isError && <ErrorCallout error={files.error} action={{ label: t('common.retry'), onClick: () => void files.refetch() }} />}
          {gated && <LicenseHelp repo={repo} onRetry={retry} />}
          {failed && !gated && <ErrorCallout error={failed.error} action={{ label: t('common.retry'), onClick: retry }} />}
          {!layout && !files.isError && (
            <div className="flex flex-col gap-2" aria-label={t('common.loading')}>
              <Skeleton className="h-28 rounded-xl" />
            </div>
          )}
          <OnThisPc repo={repo} onDownload={setChoice} />
          {nothing && (
            <Card>
              <CardContent>
                <p className="text-sm text-fg-2">{t('models.detail.noWeights')}</p>
              </CardContent>
            </Card>
          )}
          {layout && layout.gguf.weights.length > 0 && (
            <FormatSection format="gguf" hint={t('models.detail.sections.ggufHint')} fit={ggufFit}>
              {(data) => <QuantChooser repo={repo} fit={data} format="gguf" extras={layout.gguf.extras} onDownload={setChoice} />}
            </FormatSection>
          )}
          {layout && layout.safetensors.length > 0 && (
            <FormatSection format="safetensors" hint={t('models.detail.sections.safetensorsHint')} fit={stFit}>
              {(data) => <QuantChooser repo={repo} fit={data} format="safetensors" onDownload={setChoice} />}
            </FormatSection>
          )}
          {layout && layout.ninfer.length > 0 && (
            <FormatSection format="ninfer" hint={t('models.detail.sections.ninferHint')} fit={ninferFit}>
              {(data) => (
                <QuantChooser
                  repo={repo}
                  fit={data}
                  format="ninfer"
                  unsupported={gpu !== undefined && !ninferGpuSupported({ name: gpu.name, computeCapability: gpu.computeCapability, memTotalMiB: gpu.memoryTotalMiB })}
                  onDownload={setChoice}
                />
              )}
            </FormatSection>
          )}
          {layout && layout.other.length > 0 && <OtherFormats groups={layout.other} />}
          <ModelDetailSlots repo={repo} info={m} files={files.data} layout={layout} />
          <Card>
            <CardHeader>
              <CardTitle>{t('models.detail.card')}</CardTitle>
            </CardHeader>
            <CardContent>
              {readme.data ? (
                <>
                  <Markdown text={readme.data.text} linkBase={`${HF_BASE}/${repo}/blob/main/`} imageBase={`${HF_BASE}/${repo}/resolve/main/`} />
                  {readme.data.truncated && <p className="mt-4 text-xs text-fg-3">{t('models.detail.truncated')}</p>}
                </>
              ) : readme.isError ? (
                <p className="text-sm text-fg-3">{t('models.detail.noCard')}</p>
              ) : (
                <Skeleton className="h-32" />
              )}
            </CardContent>
          </Card>
        </div>
        <div className="flex flex-col gap-section">
          <Card>
            <CardHeader>
              <CardTitle>{t('models.detail.facts')}</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                {m?.license && (
                  <>
                    <dt className="text-fg-3">{t('models.detail.license')}</dt>
                    <dd className="text-fg">{m.license}</dd>
                  </>
                )}
                {(facts?.paramsB ?? m?.paramsB) !== undefined && (
                  <>
                    <dt className="text-fg-3">{t('models.detail.paramsLabel')}</dt>
                    <dd className="text-fg tabular-nums">{t('models.params', { n: number((facts?.paramsB ?? m?.paramsB) as number, 1) })}</dd>
                  </>
                )}
                {facts?.architecture && (
                  <>
                    <dt className="text-fg-3">{t('models.detail.architecture')}</dt>
                    <dd className="font-mono text-xs text-fg">{facts.architecture}</dd>
                  </>
                )}
                {facts?.contextLength !== undefined && (
                  <>
                    <dt className="text-fg-3">{t('models.detail.context')}</dt>
                    <dd className="text-fg tabular-nums">{t('models.detail.tokens', { n: integer(facts.contextLength) })}</dd>
                  </>
                )}
              </dl>
              {m && (m.formats.length > 0 || m.otherFormats.length > 0) && (
                <div className="mt-3 flex flex-col gap-1.5">
                  <span className="text-xs text-fg-3">{t('models.formats.label')}</span>
                  <FormatBadges m={m} className="flex-col items-start" />
                </div>
              )}
              {m && m.gated !== false && (
                <Badge tone="warning" className="mt-3">
                  <Lock aria-hidden />
                  {t('models.search.gated')}
                </Badge>
              )}
            </CardContent>
          </Card>
          {files.data && files.data.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>{t('models.detail.files')}</CardTitle>
              </CardHeader>
              <CardContent className="pt-3">
                <ul className="flex flex-col gap-2 text-sm">
                  {repoFiles(files.data).root.map((g) => (
                    <li key={`${g.kind}-${g.label}`} className="flex min-w-0 flex-col">
                      <span className="flex justify-between gap-3">
                        <span className="min-w-0 truncate font-medium text-fg" title={g.label}>
                          {g.kind === 'weights' ? g.label : t(`models.fileKinds.${g.kind}`)}
                        </span>
                        <span className="shrink-0 text-fg-3 tabular-nums">{bytes(g.sizeBytes)}</span>
                      </span>
                      {g.files.map((f) => (
                        <span key={f.path} className="truncate font-mono text-2xs text-fg-3" title={f.path}>
                          {fileName(f.path)}
                        </span>
                      ))}
                    </li>
                  ))}
                  {repoFiles(files.data).folders.map((d) => (
                    <li key={d.dir} className="flex min-w-0 justify-between gap-3">
                      <span className="inline-flex min-w-0 items-center gap-1.5">
                        <FolderTree aria-hidden className="size-3.5 shrink-0 text-fg-3" />
                        <span className="truncate font-mono text-xs text-fg" title={d.dir}>
                          {d.dir}/
                        </span>
                        <span className="shrink-0 text-xs text-fg-3">{t(d.count === 1 ? 'models.detail.fileCount1' : 'models.detail.fileCount', { n: d.count })}</span>
                      </span>
                      <span className="shrink-0 text-fg-3 tabular-nums">{bytes(d.sizeBytes)}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
          <Related info={info.isPending ? undefined : (m ?? null)} repo={repo} />
        </div>
      </div>
      <DownloadDialog choice={choice} onOpenChange={(o) => !o && setChoice(undefined)} />
    </Page>
  );
}
