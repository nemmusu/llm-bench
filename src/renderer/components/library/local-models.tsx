import { useNavigate } from '@tanstack/react-router';
import { FolderOpen, Gauge, HardDrive, Server, Trash2, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import type { EngineConfig, EngineKind, EngineStatus } from '../../../contract/engines';
import type { LocalModel } from '../../../contract/models';
import { isNinferKind, ninferKindFor } from '../../../contract/ninfer';
import { useI18n } from '../../i18n';
import { useDeleteModel, useEngineStatuses, useLibraryModels, useSystemInfo } from '../../lib/queries-library';
import { useSettings } from '../../lib/settings';
import { useStartFlow } from '../bench/start-flow';
import { Badge } from '../ui/badge';
import { Button, IconButton } from '../ui/button';
import { Card } from '../ui/card';
import { ConfirmDialog } from '../ui/dialog';
import { EmptyState } from '../ui/empty-state';
import { Skeleton } from '../ui/skeleton';
import { Tooltip } from '../ui/tooltip';
import { DockerVolumeAction, useVolumeSupport } from './docker-volume';
import { ErrorCallout } from './error-callout';
import { ForkBadge, FormatBadge, type ModelFormat } from './formats';
import { FitFor, TriedFor } from './model-badges';

/**
 * The engine a local model is served with: a GGUF with the llama.cpp last used (else the native one),
 * safetensors with vLLM (installed on Linux when it works, else in Docker), a .ninfer artifact with
 * NInfer (native on Linux, in WSL on Windows).
 */
export function serveEngineFor(m: LocalModel, lastEngine: EngineConfig | undefined, engines: EngineStatus[] | undefined, platform?: string): EngineConfig {
  if (m.identity.format === 'safetensors') {
    return { kind: engines?.some((e) => e.kind === 'vllm-native' && e.available) ? 'vllm-native' : 'vllm-docker' };
  }
  if (m.identity.format === 'ninfer') {
    const ready = engines?.find((e) => isNinferKind(e.kind) && e.available)?.kind;
    return { kind: ready ?? ninferKindFor(platform ?? '') ?? 'ninfer-native' };
  }
  return lastEngine?.kind === 'llamacpp-native' || lastEngine?.kind === 'llamacpp-docker' ? lastEngine : { kind: 'llamacpp-native' };
}

/** The engine a local model's fit is judged for (the estimate follows the model's own format). */
function fitEngineOf(format: LocalModel['identity']['format']): EngineKind {
  return format === 'safetensors' ? 'vllm-docker' : 'llamacpp-native';
}

/** Sections of the list, by format. */
const SECTIONS: readonly ModelFormat[] = ['gguf', 'safetensors', 'ninfer'];

function LocalRow({
  m,
  onDelete,
  onServe,
  inDocker,
}: {
  m: LocalModel;
  onDelete: (m: LocalModel) => void;
  onServe: (m: LocalModel) => void;
  inDocker: boolean | undefined;
}) {
  const { t, bytes, number } = useI18n();
  const navigate = useNavigate();
  const { update } = useSettings();
  const id = m.identity;
  const bench = () => {
    update({ lastModelId: m.id });
    void navigate({ to: '/' });
  };
  const meta = [id.quant, id.facts?.paramsB !== undefined ? t('models.params', { n: number(id.facts.paramsB, 1) }) : undefined, bytes(id.sizeBytes ?? 0)].filter(Boolean).join(' · ');
  const incomplete = m.incomplete;
  return (
    <li className="flex flex-wrap items-center gap-4 px-card py-4" data-incomplete={incomplete ? 'true' : undefined}>
      <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-lg bg-surface-3 text-fg-2">
        <HardDrive className="size-5" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-semibold text-fg">{id.displayName}</span>
          <span className="text-sm text-fg-3">{meta}</span>
        </p>
        <p className="truncate font-mono text-xs text-fg-3" title={m.paths[0]}>
          {m.paths[0]}
          <span className="ml-2 font-sans">· {t(`models.origin.${m.origin}`)}</span>
        </p>
        <div className="mt-0.5 flex flex-wrap gap-1.5">
          {incomplete ? (
            <Tooltip content={t('models.incompleteHelp')}>
              <Badge tone="warning" size="sm" tabIndex={0} className="focus-ring">
                <TriangleAlert aria-hidden />
                {t('models.incomplete', { have: incomplete.have, total: incomplete.total })}
              </Badge>
            </Tooltip>
          ) : (
            <>
              <FitFor req={{ localId: m.id, engine: fitEngineOf(id.format) }} />
              <TriedFor weakKey={id.weakKey} sha256={id.sha256} />
            </>
          )}
          {id.format === 'gguf' && <ForkBadge model={id} weakKey={id.weakKey} label={id.displayName} />}
          {m.auxiliary.map((a) => (
            <Badge key={a.path} size="sm" tone="outline">
              {t(`models.aux.${a.kind}`)}
            </Badge>
          ))}
        </div>
        {inDocker !== undefined && !incomplete && <DockerVolumeAction model={m} copied={inDocker} />}
      </div>
      <div className="flex items-center gap-1">
        {!incomplete && (
          <>
            <Button variant="secondary" onClick={bench} aria-label={`${t('models.benchmark')}: ${id.displayName}`}>
              <Gauge aria-hidden />
              {t('models.benchmark')}
            </Button>
            <Button variant="ghost" onClick={() => onServe(m)} aria-label={`${t('models.serve')}: ${id.displayName}`}>
              <Server aria-hidden />
              {t('models.serve')}
            </Button>
          </>
        )}
        <IconButton label={`${t('models.reveal')}: ${id.displayName}`} icon={<FolderOpen />} onClick={() => void window.gpubench?.revealPath(m.paths[0] as string)} />
        {m.origin === 'library' && <IconButton label={`${t('models.delete')}: ${id.displayName}`} icon={<Trash2 />} onClick={() => onDelete(m)} />}
      </div>
    </li>
  );
}

/**
 * "Sul tuo PC": every model the library found, grouped by format (the engine that runs them), with fit,
 * tried badge and the actions. A folder with both formats shows up in both groups; a download stopped
 * halfway is listed as incomplete, without the actions that would run it.
 */
export function LocalModels({ onDownload }: { onDownload: () => void }) {
  const { t, bytes } = useI18n();
  const local = useLibraryModels();
  const del = useDeleteModel();
  const volumes = useVolumeSupport();
  const engines = useEngineStatuses();
  const platform = useSystemInfo().data?.os.platform;
  const { settings } = useSettings();
  const flow = useStartFlow();
  const [target, setTarget] = useState<LocalModel>();
  /** "Avvia server": this model with the recommended settings for this card (the core picks them). */
  const serve = (m: LocalModel) => {
    const engine = serveEngineFor(m, settings.lastEngine, engines.data, platform);
    flow.serve({ engine, model: { localId: m.id } }, { modelLabel: m.identity.displayName, engineLabel: t(`benchmark.engines.${engine.kind}`) });
  };
  if (local.isError) return <ErrorCallout error={local.error} action={{ label: t('common.retry'), onClick: () => void local.refetch() }} />;
  if (!local.data) return <Skeleton className="h-40" />;
  const all = local.data;
  const groups = SECTIONS.map((format) => ({ format, models: all.filter((m) => m.identity.format === format) })).filter((g) => g.models.length > 0);
  return (
    <>
      {del.isError && <ErrorCallout error={del.error} className="mb-4" />}
      {local.data.length === 0 ? (
        <Card>
          <EmptyState
            illustration="search"
            title={t('models.localEmptyTitle')}
            description={t('models.localEmptyBody')}
            action={
              <Button variant="primary" onClick={onDownload}>
                {t('models.localEmptyAction')}
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-section">
          {groups.map((g) => (
            <section key={g.format} aria-labelledby={`local-${g.format}`} data-format-section={g.format}>
              <div className="mb-2.5 flex flex-wrap items-center gap-2">
                <h2 id={`local-${g.format}`} className="text-md font-semibold tracking-[-0.01em] text-fg">
                  {t(`models.localSections.${g.format}`)}
                </h2>
                <FormatBadge format={g.format} />
                <span className="text-sm text-fg-3 tabular-nums">{g.models.length}</span>
              </div>
              <Card>
                <ul className="divide-y divide-border" aria-label={t(`models.localSections.${g.format}`)}>
                  {g.models.map((m) => (
                    <LocalRow
                      key={m.id}
                      m={m}
                      onDelete={setTarget}
                      onServe={serve}
                      inDocker={volumes.enabled && m.identity.format === 'gguf' ? volumes.copied.has(m.id) : undefined}
                    />
                  ))}
                </ul>
              </Card>
            </section>
          ))}
        </div>
      )}
      <ConfirmDialog
        open={target !== undefined}
        onOpenChange={(o) => !o && setTarget(undefined)}
        title={t('models.deleteTitle', { name: target?.identity.displayName ?? '' })}
        description={t('models.deleteBody', { size: bytes(target?.identity.sizeBytes ?? 0) })}
        confirmLabel={t('models.delete')}
        cancelLabel={t('common.cancel')}
        onConfirm={() => del.mutate((target as LocalModel).id)}
      />
      {flow.ui}
    </>
  );
}
