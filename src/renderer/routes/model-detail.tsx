import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft, Download, ExternalLink, GitCompareArrows, Heart, Lock, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import type { HubModel } from '../../contract/models';
import { DownloadDialog, type DownloadChoice } from '../components/library/download-dialog';
import { ErrorCallout } from '../components/library/error-callout';
import { groupFiles, HF_BASE, fileName, repoUrl } from '../components/library/helpers';
import { HfTokenForm } from '../components/library/hf-token';
import { QuantChooser } from '../components/library/quant-chooser';
import { Page } from '../components/shell/page';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Callout } from '../components/ui/callout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Skeleton } from '../components/ui/skeleton';
import { useI18n } from '../i18n';
import { Markdown } from '../lib/markdown/render';
import { errorData, useHubFiles, useHubFit, useHubModel, useReadme, useRelated } from '../lib/queries-library';
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

/** One Hugging Face repo: pick the quant (best preselected), see the files, read the model card. */
export function ModelDetailPage() {
  const { t, bytes, integer, number, relative } = useI18n();
  const { owner, name } = useParams({ from: '/models/hub/$owner/$name' });
  const repo = `${owner}/${name}`;
  const info = useHubModel(repo);
  const files = useHubFiles(repo);
  const readme = useReadme(repo);
  const gguf = files.data?.some((f) => f.kind === 'weights' && f.path.toLowerCase().endsWith('.gguf'));
  const fit = useHubFit(repo, files.data ? (gguf ? 'llamacpp-native' : 'vllm-docker') : undefined);
  const [choice, setChoice] = useState<DownloadChoice>();
  const m = info.data;
  const fitCode = fit.isError ? errorData(fit.error).code : undefined;
  const gated = fitCode === 'HF_GATED' || fitCode === 'HF_AUTH_REQUIRED';
  const extras = (files.data ?? []).filter((f) => f.kind === 'mmproj' || f.kind === 'mtp' || f.kind === 'draft');
  const facts = fit.data?.facts;

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
        <Link to="/models" search={{ tab: 'download' }} className="inline-flex items-center gap-1 self-start rounded-xs text-sm text-fg-2 hover:text-fg focus-ring">
          <ArrowLeft aria-hidden className="size-3.5" />
          {t('models.title')}
        </Link>
      }
      actions={
        <>
          {/* "Confronta modelli": this one against the others measured on this card. */}
          <Button asChild>
            <Link to="/compare" search={{ view: 'models' }}>
              <GitCompareArrows aria-hidden />
              {t('compare.openModels')}
            </Link>
          </Button>
          <Button onClick={() => openHf(repo)}>
            <ExternalLink aria-hidden />
            {t('models.detail.openOnHf')}
          </Button>
        </>
      }
    >
      <div className="grid gap-section lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-w-0 flex-col gap-section">
          {files.isError && <ErrorCallout error={files.error} action={{ label: t('common.retry'), onClick: () => void files.refetch() }} />}
          {gated && <LicenseHelp repo={repo} onRetry={() => void fit.refetch()} />}
          {fit.isError && !gated && <ErrorCallout error={fit.error} action={{ label: t('common.retry'), onClick: () => void fit.refetch() }} />}
          <Card>
            <CardHeader>
              <div>
                <CardTitle>{t('models.detail.chooseTitle')}</CardTitle>
                <CardDescription>{t('models.detail.chooseHint')}</CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              {fit.data ? (
                fit.data.choices.length > 0 ? (
                  <QuantChooser repo={repo} fit={fit.data} extras={extras} onDownload={setChoice} />
                ) : (
                  <p className="text-sm text-fg-2">{t('models.detail.noWeights')}</p>
                )
              ) : fit.isError || files.isError ? (
                <p className="text-sm text-fg-3">{t('models.detail.fitUnavailable')}</p>
              ) : (
                <div className="flex flex-col gap-2" aria-label={t('common.loading')}>
                  <Skeleton className="h-12" />
                  <Skeleton className="h-12" />
                </div>
              )}
            </CardContent>
          </Card>
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
                  {groupFiles(files.data).map((g) => (
                    <li key={`${g.kind}-${g.label}`} className="flex flex-col">
                      <span className="flex justify-between gap-3">
                        <span className="font-medium text-fg">{g.kind === 'weights' ? g.label : t(`models.fileKinds.${g.kind}`)}</span>
                        <span className="text-fg-3 tabular-nums">{bytes(g.sizeBytes)}</span>
                      </span>
                      {g.files.map((f) => (
                        <span key={f.path} className="truncate font-mono text-2xs text-fg-3" title={f.path}>
                          {fileName(f.path)}
                        </span>
                      ))}
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
