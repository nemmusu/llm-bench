/**
 * "Usa i comandi di questo modello: YaRN 300K · MTP": the model's recipe where a run or a server is
 * started (Benchmark, the Server page's slot), with a switch to start without it and "Apri" to see or
 * change it; and what a plan or a run actually applied (AppliedRecipeLine).
 */
import { SquareTerminal } from 'lucide-react';
import { useId } from 'react';
import type { AppliedRecipe } from '../../../contract/recipes';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/cn';
import { useSettings } from '../../lib/settings';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { HelpTip } from '../ui/help-tip';
import { Switch } from '../ui/switch';
import { appliedLines, recipeParts, type RecipeTarget } from './recipe-model';
import { useRecipeDialogs } from './recipe-section';
import { useModelRecipe } from './use-model-recipe';

export interface RecipeChipProps {
  target: RecipeTarget;
  /** The recipe is used (the request then carries nothing: the core applies it). */
  use: boolean;
  onUseChange: (use: boolean) => void;
  className?: string;
}

/**
 * Nothing when the model has no recipe, or when its only command is the engine: on the Benchmark page the
 * engine choice and its suggestion ("Usa PrismML", "Questo modello richiede il fork PrismML") already say
 * it, so the chip never repeats them. One row where there is room (the Benchmark page, under the three
 * choices), stacked in a narrow place (a container query).
 */
export function RecipeChip({ target, use, onUseChange, className }: RecipeChipProps) {
  const f = useI18n();
  const { t } = f;
  const { settings } = useSettings();
  const info = useModelRecipe(target);
  const dialogs = useRecipeDialogs(target);
  const id = useId();
  const parts = info.recipe ? recipeParts(info.recipe, f, { customEngines: settings.customEngines, aux: target.aux, ref: target.ref, engine: false }) : [];
  if (!info.recipe || parts.length === 0) return null;
  return (
    <div className={cn('@container rounded-lg border transition-colors', use ? 'border-accent/30 bg-accent-soft/50' : 'border-border bg-surface-2/60', className)}>
      <div className="flex flex-col gap-2 px-3 py-2.5 @2xl:flex-row @2xl:items-center @2xl:gap-3 @2xl:px-4">
        <div className="flex shrink-0 items-start gap-2.5 @2xl:items-center">
          <Switch id={id} checked={use} onCheckedChange={onUseChange} className="mt-px @2xl:mt-0" />
          <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer text-sm leading-5 font-medium text-fg">
            {t('recipes.chip.label')}
          </label>
          <HelpTip term={t('recipes.chip.label')}>{t('recipes.chip.help')}</HelpTip>
        </div>
        {use ? (
          <ul className="flex flex-wrap gap-1" aria-label={info.recipe.name}>
            {parts.map((p) => (
              <li key={p}>
                <Badge tone="accent" size="sm">
                  {p}
                </Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-fg-3">{t('recipes.chip.off')}</p>
        )}
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-fg-3 @2xl:ml-auto">
          <SquareTerminal aria-hidden className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate" title={info.recipe.name}>
            {info.recipe.name}
          </span>
          <Button variant="link" size="sm" className="ml-auto h-auto text-xs @2xl:ml-1" onClick={dialogs.edit} aria-label={`${t('recipes.chip.open')}: ${info.recipe.name}`}>
            {t('recipes.chip.open')}
          </Button>
        </span>
      </div>
      {dialogs.ui}
    </div>
  );
}

/** What a plan, a server or a run applied: the recipe and its parts, what the user's values replaced, what did not apply. */
export function AppliedRecipeLine({ applied, className }: { applied: AppliedRecipe | undefined; className?: string }) {
  const f = useI18n();
  if (!applied) return null;
  const lines = appliedLines(applied, f);
  return (
    <div className={cn('flex items-start gap-2 text-sm text-fg-2', className)}>
      <SquareTerminal aria-hidden className="mt-0.5 size-4 shrink-0 text-accent-text" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-fg">{lines.line}</span>
        {lines.overridden && <span className="text-xs">{lines.overridden}</span>}
        {lines.skipped && <span className="text-xs text-fg-3">{lines.skipped}</span>}
      </div>
    </div>
  );
}
