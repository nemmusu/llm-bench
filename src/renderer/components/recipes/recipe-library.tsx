/**
 * "Scegli da una ricetta pronta": the built-in recipes (contract/recipes.ts RECIPE_TEMPLATES) in plain
 * words, each with what it sets, where it is documented and "Usa" — or why it does not fit this model.
 * "Usa" hands the model's recipe with the built-in's settings added to the editor: nothing is saved
 * before the user sees it.
 */
import { BookOpen, Cpu, ExternalLink, Gauge, Image, Ruler, Server } from 'lucide-react';
import { useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { defaultYarnTarget, recipeCustomEngine, RECIPE_TEMPLATES, YARN_TARGETS, yarnScaling, type RecipeTemplate, type RecipeTemplateId } from '../../../contract/recipes';
import { useI18n } from '../../i18n';
import { useSettings } from '../../lib/settings';
import { depthLabel } from '../tune/tune-format';
import { Button } from '../ui/button';
import { Dialog, DialogContent } from '../ui/dialog';
import { SegmentedControl } from '../ui/segmented-control';
import { templateEngineAction, templateEngineLink, type RecipeTarget } from './recipe-model';

const ICONS: Record<RecipeTemplateId, typeof Ruler> = { yarn: Ruler, mtp: Gauge, 'prismml-bonsai': Cpu, vision: Image, ninfer: Server, 'ninfer-all': Server };

/** Built-in recipes that choose a custom engine made from a template of the same id (the PrismML fork, NInfer-all). */
const ENGINE_TEMPLATES = ['prismml-bonsai', 'ninfer-all'] as const;
type EngineTemplateId = (typeof ENGINE_TEMPLATES)[number];
const enginesFrom = (id: RecipeTemplateId): id is EngineTemplateId => (ENGINE_TEMPLATES as readonly string[]).includes(id);

export interface RecipeLibraryProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: RecipeTarget;
  /** "Usa": the built-in and its options (the YaRN context). */
  onUse: (template: RecipeTemplate, opts: { yarnTarget?: number }) => void;
}

/** The text of why a built-in does not fit (its block reason, with the built-in for "no file"). */
function blockedKey(t: RecipeTemplate, reason: NonNullable<ReturnType<RecipeTemplate['blocked']>>) {
  if (reason === 'no_file') return t.id === 'vision' ? ('recipes.library.blocked.no_file_vision' as const) : ('recipes.library.blocked.no_file_mtp' as const);
  return `recipes.library.blocked.${reason}` as const;
}

export function RecipeLibrary({ open, onOpenChange, target, onUse }: RecipeLibraryProps) {
  const { t } = useI18n();
  // The ones that fit this model first, in the library's order.
  const sorted = [...RECIPE_TEMPLATES].sort((a, b) => Number(a.blocked(target.template) !== undefined) - Number(b.blocked(target.template) !== undefined));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" title={t('recipes.library.title')} description={t('recipes.library.description')}>
        <ul className="flex flex-col gap-3 pb-2">
          {sorted.map((x) => (
            <TemplateCard key={x.id} template={x} target={target} onUse={(opts) => onUse(x, opts)} />
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

function TemplateCard({ template, target, onUse }: { template: RecipeTemplate; target: RecipeTarget; onUse: (opts: { yarnTarget?: number }) => void }) {
  const f = useI18n();
  const { t, integer, number } = f;
  const router = useRouter();
  const { settings } = useSettings();
  const blocked = template.blocked(target.template);
  const trained = target.template.trainedContext;
  // The offered targets beyond the trained context; a model trained past them all: twice its context.
  const beyond = trained === undefined ? [] : YARN_TARGETS.filter((n) => n > trained);
  const targets = beyond.length || trained === undefined ? beyond : [defaultYarnTarget(trained)];
  const [yarn, setYarn] = useState(String(targets[0]));
  const rope = trained === undefined ? undefined : yarnScaling(Number(yarn), trained);
  const Icon = ICONS[template.id];
  const sets = template.parts.map((p) => t(`recipes.applied.partNames.${p}`)).join(' · ');
  // The PrismML and NInfer-all cards: whether that engine is set up already.
  const engineTemplate = enginesFrom(template.id) ? template.id : undefined;
  const fork = engineTemplate && !blocked ? recipeCustomEngine({ type: 'template', template: engineTemplate }, settings.customEngines, target.ref) : undefined;
  const docs = template.docs[0] as string;
  return (
    <li className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-xs data-[blocked=true]:bg-surface-2/60" data-blocked={blocked !== undefined}>
      <div className="flex items-start gap-3">
        <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-text data-[blocked=true]:bg-surface-3 data-[blocked=true]:text-fg-3" data-blocked={blocked !== undefined}>
          <Icon className="size-[18px]" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h3 className="text-sm font-semibold text-fg">{t(`recipes.library.${template.id}.title`)}</h3>
          <p className="text-sm text-fg-2">{t(`recipes.library.${template.id}.body`)}</p>
          <p className="text-xs text-fg-3">{t('recipes.library.sets', { parts: sets })}</p>
        </div>
      </div>
      {blocked ? (
        <p className="pl-12 text-sm text-fg-3">{t(blockedKey(template, blocked))}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pl-12">
          {template.id === 'yarn' && (
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-fg-2">{t('recipes.library.yarn.target')}</span>
              <SegmentedControl
                size="sm"
                label={t('recipes.library.yarn.target')}
                value={yarn}
                onValueChange={setYarn}
                options={targets.map((n) => ({ value: String(n), label: depthLabel(n, f) }))}
              />
              {rope && <span className="text-xs text-fg-3 tabular-nums">{t('recipes.library.yarn.factor', { factor: number(rope.factor, 2), trained: integer(trained as number) })}</span>}
            </span>
          )}
          {engineTemplate && <span className="text-xs text-fg-2">{fork ? t(`recipes.library.${engineTemplate}.found`, { name: fork.name }) : t(`recipes.library.${engineTemplate}.missing`)}</span>}
          <span className="ml-auto flex items-center gap-2">
            <Button variant="link" size="sm" onClick={() => void window.gpubench?.openExternal(docs)}>
              <BookOpen aria-hidden />
              {t('recipes.actions.docs')}
              <ExternalLink aria-hidden />
            </Button>
            {engineTemplate && !fork && (
              <Button size="sm" onClick={() => void router.history.push(templateEngineLink(engineTemplate, target))}>
                {templateEngineAction(engineTemplate, f)}
              </Button>
            )}
            <Button size="sm" variant="primary" onClick={() => onUse(template.id === 'yarn' ? { yarnTarget: Number(yarn) } : {})} aria-label={`${t('recipes.library.use')}: ${t(`recipes.library.${template.id}.title`)}`}>
              {t('recipes.library.use')}
            </Button>
          </span>
        </div>
      )}
    </li>
  );
}
