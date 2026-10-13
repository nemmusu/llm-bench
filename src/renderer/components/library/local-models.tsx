import { useNavigate } from '@tanstack/react-router';
import { FolderOpen, Gauge, HardDrive, Server, SquareTerminal, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { EngineConfig, EngineStatus } from '../../../contract/engines';
import type { LocalModel } from '../../../contract/models';
import { useI18n } from '../../i18n';
import { useDeleteModel, useEngineStatuses, useLibraryModels } from '../../lib/queries-library';
import { useSettings } from '../../lib/settings';
import { useStartFlow } from '../bench/start-flow';
import { targetOfLocal, type RecipeTarget } from '../recipes/recipe-model';
import { ModelRecipeDialog } from '../recipes/recipe-section';
import { useModelRecipe } from '../recipes/use-model-recipe';
import { Badge } from '../ui/badge';
import { Button, IconButton } from '../ui/button';
import { Card } from '../ui/card';
import { ConfirmDialog } from '../ui/dialog';
import { EmptyState } from '../ui/empty-state';
import { Skeleton } from '../ui/skeleton';
import { DockerVolumeAction, useVolumeSupport } from './docker-volume';
import { ErrorCallout } from './error-callout';
import { FitFor, TriedFor } from './model-badges';

/**
 * The engine a local model is served with: a GGUF with the llama.cpp last used (else the native one),
 * safetensors with vLLM (installed on Linux when it works, else in Docker).
 */
export function serveEngineFor(m: LocalModel, lastEngine: EngineConfig | undefined, engines: EngineStatus[] | undefined): EngineConfig {
  if (m.identity.format === 'safetensors') {
    return { kind: engines?.some((e) => e.kind === 'vllm-native' && e.available) ? 'vllm-native' : 'vllm-docker' };
  }
  return lastEngine?.kind === 'llamacpp-native' || lastEngine?.kind === 'llamacpp-docker' ? lastEngine : { kind: 'llamacpp-native' };
}

function LocalRow({
  m,
  onDelete,
  onServe,
  inDocker,
  onRecipe,
}: {
  m: LocalModel;
  onDelete: (m: LocalModel) => void;
  onServe: (m: LocalModel) => void;
  inDocker: boolean | undefined;
  /** "Comandi": the model's command recipe. */
  onRecipe: (m: LocalModel) => void;
}) {
  const { t, bytes, number } = useI18n();
  const navigate = useNavigate();
  const { update } = useSettings();
  const recipe = useModelRecipe(m);
  const id = m.identity;
  const bench = () => {
    update({ lastModelId: m.id });
    void navigate({ to: '/' });
  };
  const meta = [id.quant, id.facts?.paramsB !== undefined ? t('models.params', { n: number(id.facts.paramsB, 1) }) : undefined, bytes(id.sizeBytes ?? 0)].filter(Boolean).join(' · ');
  return (
    <li className="flex flex-wrap items-center gap-4 px-card py-4">
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
          <FitFor req={{ localId: m.id, engine: id.format === 'safetensors' ? 'vllm-docker' : 'llamacpp-native' }} />
          <TriedFor weakKey={id.weakKey} sha256={id.sha256} />
          {recipe.recipe && (
            <Badge size="sm" tone="accent">
              <SquareTerminal aria-hidden />
              {t('recipes.badge', { name: recipe.recipe.name })}
            </Badge>
          )}
          {m.auxiliary.map((a) => (
            <Badge key={a.path} size="sm" tone="outline">
              {t(`models.aux.${a.kind}`)}
            </Badge>
          ))}
        </div>
        {inDocker !== undefined && <DockerVolumeAction model={m} copied={inDocker} />}
      </div>
      <div className="flex items-center gap-1">
        <Button variant="secondary" onClick={bench} aria-label={`${t('models.benchmark')}: ${id.displayName}`}>
          <Gauge aria-hidden />
          {t('models.benchmark')}
        </Button>
        <Button variant="ghost" onClick={() => onServe(m)} aria-label={`${t('models.serve')}: ${id.displayName}`}>
          <Server aria-hidden />
          {t('models.serve')}
        </Button>
        <Button variant="ghost" onClick={() => onRecipe(m)} aria-label={t('recipes.rowButtonLabel', { model: id.displayName })}>
          <SquareTerminal aria-hidden />
          {t('recipes.rowButton')}
        </Button>
        <IconButton label={`${t('models.reveal')}: ${id.displayName}`} icon={<FolderOpen />} onClick={() => void window.gpubench?.revealPath(m.paths[0] as string)} />
        {m.origin === 'library' && <IconButton label={`${t('models.delete')}: ${id.displayName}`} icon={<Trash2 />} onClick={() => onDelete(m)} />}
      </div>
    </li>
  );
}

/** "Sul tuo PC": every model the library found, with fit, tried badge and the three actions. */
export function LocalModels({ onDownload }: { onDownload: () => void }) {
  const { t, bytes } = useI18n();
  const local = useLibraryModels();
  const del = useDeleteModel();
  const volumes = useVolumeSupport();
  const engines = useEngineStatuses();
  const { settings } = useSettings();
  const flow = useStartFlow();
  const [target, setTarget] = useState<LocalModel>();
  const [recipeFor, setRecipeFor] = useState<RecipeTarget>();
  /** "Avvia server": this model with the recommended settings for this card (the core picks them). */
  const serve = (m: LocalModel) => {
    const engine = serveEngineFor(m, settings.lastEngine, engines.data);
    flow.serve({ engine, model: { localId: m.id } }, { modelLabel: m.identity.displayName, engineLabel: t(`benchmark.engines.${engine.kind}`) });
  };
  if (local.isError) return <ErrorCallout error={local.error} action={{ label: t('common.retry'), onClick: () => void local.refetch() }} />;
  if (!local.data) return <Skeleton className="h-40" />;
  return (
    <>
      {del.isError && <ErrorCallout error={del.error} className="mb-4" />}
      <Card>
        {local.data.length === 0 ? (
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
        ) : (
          <ul className="divide-y divide-border" aria-label={t('models.tabs.local')}>
            {local.data.map((m) => (
              <LocalRow
                key={m.id}
                m={m}
                onDelete={setTarget}
                onServe={serve}
                onRecipe={(x) => setRecipeFor(targetOfLocal(x))}
                inDocker={volumes.enabled && m.identity.format === 'gguf' ? volumes.copied.has(m.id) : undefined}
              />
            ))}
          </ul>
        )}
      </Card>
      <ConfirmDialog
        open={target !== undefined}
        onOpenChange={(o) => !o && setTarget(undefined)}
        title={t('models.deleteTitle', { name: target?.identity.displayName ?? '' })}
        description={t('models.deleteBody', { size: bytes(target?.identity.sizeBytes ?? 0) })}
        confirmLabel={t('models.delete')}
        cancelLabel={t('common.cancel')}
        onConfirm={() => del.mutate((target as LocalModel).id)}
      />
      <ModelRecipeDialog target={recipeFor} onOpenChange={(o) => !o && setRecipeFor(undefined)} />
      {flow.ui}
    </>
  );
}
