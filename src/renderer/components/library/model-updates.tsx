import { ArrowUpCircle, Download, Plus, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import type { LocalModel, ModelUpdate } from '../../../contract/models';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/cn';
import { useCheckUpdates, useLibraryModels, useModelUpdates } from '../../lib/queries-library';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { HelpTip } from '../ui/help-tip';
import type { DownloadChoice } from './download-dialog';
import { TriedFor } from './model-badges';

/** A download that adds to a local model (an update, its mmproj / MTP head): into its own folder, next to it. */
function addTo(m: LocalModel, files: string[], label: string, sizeBytes: number): DownloadChoice {
  return { repo: m.identity.repo as string, files, label, sizeBytes, weakKey: m.identity.weakKey, into: m.id };
}

/**
 * What the last check found for one local model: "Aggiornamento disponibile" with what changed ("Il file
 * Q4_K_M è cambiato (17,8 → 17,6 GB)") and "Aggiorna", and the parts its repo has and the PC does not
 * ("Aggiungi la parte visione (mmproj, 0,9 GB)", "Aggiungi MTP"). Each opens the download dialog.
 */
export function ModelUpdateInfo({ m, update, onDownload }: { m: LocalModel; update: ModelUpdate | undefined; onDownload: (c: DownloadChoice) => void }) {
  const { t, bytes } = useI18n();
  if (!update) return null;
  const name = m.identity.displayName;
  return (
    <div className="flex flex-col gap-2">
      {update.changed.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <Badge tone="info" size="sm">
            <ArrowUpCircle aria-hidden />
            {t('models.updates.available')}
          </Badge>
          <ul className="flex flex-col text-xs text-fg-2">
            {update.changed.map((c) => (
              <li key={c.path}>{t('models.updates.changed', { name: c.label, old: bytes(c.oldBytes), new: bytes(c.newBytes) })}</li>
            ))}
          </ul>
          <Button
            size="sm"
            variant="secondary"
            aria-label={`${t('models.updates.update')}: ${name}`}
            onClick={() =>
              onDownload(
                addTo(
                  m,
                  update.changed.map((c) => c.path),
                  t('models.updates.updateLabel', { name }),
                  update.changed.reduce((a, c) => a + c.newBytes, 0),
                ),
              )
            }
          >
            <Download aria-hidden />
            {t('models.updates.update')}
          </Button>
        </div>
      )}
      {update.extras.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {update.extras.map((x) => {
            const text = t(`models.extras.${x.kind}`, { size: bytes(x.sizeBytes) });
            return (
              <Button key={x.path} size="sm" variant="ghost" aria-label={`${text}: ${name}`} onClick={() => onDownload(addTo(m, [x.path], t(`models.extras.${x.kind}Label`, { name }), x.sizeBytes))}>
                <Plus aria-hidden />
                {text}
              </Button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * "Controlla aggiornamenti" with when the last check ran: every downloaded repo (the library), or one
 * (`repo`, the model page). The core spaces the requests and answers a repeated click from the last check.
 */
export function CheckUpdates({ repo, className }: { repo?: string; className?: string }) {
  const { t, relative } = useI18n();
  const updates = useModelUpdates();
  const check = useCheckUpdates();
  const run = () =>
    check.mutate(repo, {
      onSuccess: (u) => {
        const n = u.models.filter((x) => repo === undefined || x.repo === repo).length;
        toast.success(n === 0 ? t('models.updates.upToDate') : n === 1 ? t('models.updates.found1') : t('models.updates.found', { n }));
      },
    });
  const when = updates.data?.checkedAt;
  return (
    <div className={cn('flex flex-wrap items-center gap-2 text-sm text-fg-3', className)}>
      <span>{when ? t('models.updates.lastCheck', { when: relative(when) }) : t('models.updates.never')}</span>
      <HelpTip term={t('models.updates.check')}>{t('models.updates.help')}</HelpTip>
      <Button size="sm" onClick={run} disabled={check.isPending}>
        <RefreshCw aria-hidden className={check.isPending ? 'animate-spin' : undefined} />
        {check.isPending ? t('models.updates.checking') : t('models.updates.check')}
      </Button>
    </div>
  );
}

/**
 * The model page's "Sul tuo PC": the copies of this repo already downloaded, each with its tried badge,
 * the update the last check found and the parts it lacks; nothing when there is no copy.
 */
export function OnThisPc({ repo, onDownload }: { repo: string; onDownload: (c: DownloadChoice) => void }) {
  const { t, bytes } = useI18n();
  const local = useLibraryModels();
  const updates = useModelUpdates();
  const copies = (local.data ?? []).filter((m) => m.identity.repo === repo && !m.incomplete);
  if (copies.length === 0) return null;
  return (
    <Card data-on-this-pc>
      <CardHeader>
        <div className="flex min-w-0 flex-col gap-1.5">
          <CardTitle>{t('models.updates.onPc')}</CardTitle>
          <CardDescription>{t('models.updates.onPcHint')}</CardDescription>
        </div>
        <CheckUpdates repo={repo} className="ml-auto" />
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col divide-y divide-border" aria-label={t('models.updates.onPc')}>
          {copies.map((m) => (
            <li key={m.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-semibold text-fg">{m.identity.displayName}</span>
                <span className="text-sm text-fg-3">{[m.identity.quant, bytes(m.identity.sizeBytes ?? 0)].filter(Boolean).join(' · ')}</span>
                {m.auxiliary.map((a) => (
                  <Badge key={a.path} size="sm" tone="outline">
                    {t(`models.aux.${a.kind}`)}
                  </Badge>
                ))}
                <TriedFor weakKey={m.identity.weakKey} sha256={m.identity.sha256} previous={m.previous} />
              </div>
              <ModelUpdateInfo m={m} update={updates.data?.models.find((u) => u.modelId === m.id)} onDownload={onDownload} />
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
