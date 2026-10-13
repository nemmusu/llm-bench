/**
 * "Comando completo": the exact command a model starts with these commands, per engine, from the core
 * (POST /api/servers/plan with the recipe inline: the same resolution as "Avvia solo il server").
 */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { ServerPlan, StartServerRequest } from '../../../contract/api';
import type { EngineKind } from '../../../contract/engines';
import { useI18n } from '../../i18n';
import { useApi } from '../../lib/api-context';
import { apiErrorData, useDebounced } from '../../lib/queries-runs';
import { CodeBlock } from '../ui/code-block';
import { SegmentedControl } from '../ui/segmented-control';
import { Skeleton } from '../ui/skeleton';
import type { RecipeTarget } from './recipe-model';

/** An unsaved recipe as a request carries it. */
export type InlineRecipe = NonNullable<NonNullable<StartServerRequest['recipe']>['inline']>;

/** The server plan of the model on `kind` with this recipe (an unsaved one inline, a saved one by id). */
export function useRecipePlan(target: RecipeTarget, kind: EngineKind, recipe: { inline: InlineRecipe } | { id: string } | undefined) {
  const api = useApi();
  const body: StartServerRequest = { engine: { kind }, model: target.request, recipe: { use: true, ...recipe } };
  // Debounced: the editor's preview follows the typing without a request per key.
  const json = useDebounced(JSON.stringify(body), 300);
  return useQuery({
    queryKey: ['recipes', 'preview', json],
    queryFn: ({ signal }) => api.post<ServerPlan>('/api/servers/plan', JSON.parse(json) as StartServerRequest, signal),
    staleTime: 10_000,
    retry: false,
    placeholderData: (prev) => prev,
  });
}

export function RecipePreview({ target, recipe, live = false }: { target: RecipeTarget; recipe: { inline: InlineRecipe } | { id: string } | undefined; live?: boolean }) {
  const f = useI18n();
  const { t } = f;
  const [kind, setKind] = useState<EngineKind>(target.engines[0] as EngineKind);
  const plan = useRecipePlan(target, kind, recipe);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col">
          <h3 className="text-sm font-semibold text-fg">{t('recipes.preview.title')}</h3>
          <p className="text-xs text-fg-3">{t(live ? 'recipes.preview.hintLive' : 'recipes.preview.hint')}</p>
        </div>
        {target.engines.length > 1 && (
          <SegmentedControl<EngineKind>
            size="sm"
            label={t('recipes.preview.title')}
            value={kind}
            onValueChange={setKind}
            options={target.engines.map((k) => ({ value: k, label: t(`benchmark.engines.${k}`) }))}
          />
        )}
      </div>
      {plan.data ? (
        <CodeBlock commands={plan.data.command} label={t('recipes.preview.title')} />
      ) : plan.isError ? (
        <p className="rounded-lg border border-dashed border-border-strong px-4 py-3 text-sm text-fg-2">{t('recipes.preview.error', { reason: t(`errors.${apiErrorData(plan.error).code}.title`) })}</p>
      ) : (
        <div role="status" aria-label={t('recipes.preview.loading')}>
          <Skeleton className="h-16 w-full" />
        </div>
      )}
    </div>
  );
}
