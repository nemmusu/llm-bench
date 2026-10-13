/**
 * "Comandi per questo modello": the model's recipe in words (what it sets, who it is for, notes, the
 * model page), with "Modifica", "Scegli da una ricetta pronta", "Scrivi i comandi" and the exact
 * command it gives. On the model page and, in a dialog, for every model of "Sul tuo PC".
 */
import { useRouter } from '@tanstack/react-router';
import { ExternalLink, ListPlus, Pencil, SquareTerminal, Wand2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { recipeForModel, recipeIsExactFor, withTemplate, type ModelRecipe, type RecipeTemplate } from '../../../contract/recipes';
import { useI18n } from '../../i18n';
import { useSettings } from '../../lib/settings';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Callout } from '../ui/callout';
import { Card } from '../ui/card';
import { Dialog, DialogContent } from '../ui/dialog';
import { HelpTip } from '../ui/help-tip';
import { RecipeEditor } from './recipe-editor';
import { RecipeLibrary } from './recipe-library';
import { scopeText, templateEngineLink, templateEngineName, type RecipeTarget } from './recipe-model';
import { RecipePreview } from './recipe-preview';
import { useModelRecipe } from './use-model-recipe';

interface EditorState {
  initial: Partial<ModelRecipe> | undefined;
  editing: ModelRecipe | undefined;
}

/** The editor and the ready-recipe chooser of one model, with the ways to open them. */
export function useRecipeDialogs(target: RecipeTarget): { edit: () => void; write: () => void; pick: () => void; ui: ReactNode } {
  const { settings } = useSettings();
  const recipe = recipeForModel(settings.modelRecipes, target.ref);
  const [editor, setEditor] = useState<EditorState | undefined>(undefined);
  const [library, setLibrary] = useState(false);
  const use = (template: RecipeTemplate, opts: { yarnTarget?: number }) => {
    setLibrary(false);
    // Into this model's own recipe, or a new one: a family recipe is not changed from one model's page.
    const own = recipe && recipeIsExactFor(recipe.match, target.ref) ? recipe : undefined;
    const base: Partial<ModelRecipe> & Pick<ModelRecipe, 'args' | 'from'> = own ?? { name: target.label, match: { models: [target.entry] }, args: {}, env: {}, from: [] };
    setEditor({ initial: withTemplate(base, template, target.template, opts), editing: own });
  };
  return {
    edit: () => setEditor({ initial: recipe, editing: recipe }),
    write: () => setEditor({ initial: undefined, editing: undefined }),
    pick: () => setLibrary(true),
    ui: (
      <>
        <RecipeEditor open={editor !== undefined} onOpenChange={(o) => !o && setEditor(undefined)} target={target} initial={editor?.initial} editing={editor?.editing} />
        <RecipeLibrary open={library} onOpenChange={setLibrary} target={target} onUse={use} />
      </>
    ),
  };
}

/** "Indica dove si trova il fork": a recipe whose custom engine is not set up yet. */
export function EngineMissing({ template, target }: { template: string; target: RecipeTarget }) {
  const f = useI18n();
  const router = useRouter();
  return (
    <Callout
      tone="warning"
      title={f.t('recipes.engineMissing.title')}
      action={{ label: f.t('recipes.engineMissing.action'), onClick: () => void router.history.push(templateEngineLink(template, target)) }}
    >
      {f.t('recipes.engineMissing.body', { engine: templateEngineName(template, f) })}
    </Callout>
  );
}

/** The section's content (a card on the model page, a dialog's body for "Sul tuo PC"). */
export function RecipeSectionBody({ target }: { target: RecipeTarget }) {
  const f = useI18n();
  const { t } = f;
  const { recipe, parts, missingTemplate: missing } = useModelRecipe(target);
  const dialogs = useRecipeDialogs(target);
  return (
    <div className="flex flex-col gap-4">
      {recipe ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-md font-semibold text-fg">{t('recipes.active', { name: recipe.name })}</span>
            <span className="text-sm text-fg-3">{scopeText(recipe, f)}</span>
          </div>
          {parts.length > 0 && (
            <ul className="flex flex-wrap gap-1.5" aria-label={t('recipes.title')}>
              {parts.map((p) => (
                <li key={p}>
                  <Badge tone="accent">{p}</Badge>
                </li>
              ))}
            </ul>
          )}
          {recipe.notes && <p className="text-sm whitespace-pre-line text-fg-2">{recipe.notes}</p>}
          {recipe.link && (
            <Button variant="link" size="sm" className="self-start" onClick={() => void window.gpubench?.openExternal(recipe.link as string)}>
              <ExternalLink aria-hidden />
              {recipe.link}
            </Button>
          )}
          {missing && <EngineMissing template={missing} target={target} />}
        </div>
      ) : (
        <p className="text-sm text-fg-2">{t('recipes.none')}</p>
      )}
      <div className="flex flex-wrap gap-2">
        {recipe ? (
          <>
            <Button onClick={dialogs.edit}>
              <Pencil aria-hidden />
              {t('recipes.actions.edit')}
            </Button>
            <Button variant="ghost" onClick={dialogs.pick}>
              <Wand2 aria-hidden />
              {t('recipes.actions.pick')}
            </Button>
          </>
        ) : (
          <>
            <Button variant="primary" onClick={dialogs.pick}>
              <Wand2 aria-hidden />
              {t('recipes.actions.pick')}
            </Button>
            <Button onClick={dialogs.write}>
              <ListPlus aria-hidden />
              {t('recipes.actions.write')}
            </Button>
          </>
        )}
      </div>
      {recipe && <RecipePreview target={target} recipe={{ id: recipe.id }} />}
      {dialogs.ui}
    </div>
  );
}

/** The card on the model page. */
export function ModelRecipeSection({ target }: { target: RecipeTarget }) {
  const { t } = useI18n();
  return (
    <Card>
      <div className="flex items-center gap-2 px-card pt-card">
        <SquareTerminal aria-hidden className="size-4 text-accent-text" />
        <h2 className="text-md font-semibold tracking-[-0.01em]">{t('recipes.title')}</h2>
        <HelpTip term={t('recipes.title')}>{t('recipes.help')}</HelpTip>
      </div>
      <div className="p-card pt-4">
        <RecipeSectionBody target={target} />
      </div>
    </Card>
  );
}

/** "Comandi" of a model in "Sul tuo PC": the section in a dialog. */
export function ModelRecipeDialog({ target, onOpenChange }: { target: RecipeTarget | undefined; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n();
  return (
    <Dialog open={target !== undefined} onOpenChange={onOpenChange}>
      {target && (
        <DialogContent size="lg" title={`${t('recipes.title')} · ${target.label}`} description={t('recipes.help')}>
          <div className="pb-2">
            <RecipeSectionBody target={target} />
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
