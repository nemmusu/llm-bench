/**
 * "Modifica" / "Scrivi i comandi": a recipe in plain fields — who it is for, the context (YaRN), the
 * engine, the MTP / draft file and the image projector (llama.cpp), extra arguments per engine,
 * environment, notes and the model page — with the exact command it gives, live. Saving a recipe with
 * nothing in it removes it.
 */
import { Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { CUSTOM_ENGINE_TEMPLATES, templateForModel } from '../../../contract/custom-engines';
import { ENGINE_KINDS } from '../../../contract/engines';
import {
  modelRecipeDraftSchema,
  modelRecipeSchema,
  recipeIdFor,
  recipeIsEmpty,
  RECIPE_ARG_TARGETS,
  type ModelRecipe,
  type RecipeArgTarget,
} from '../../../contract/recipes';
import { useI18n } from '../../i18n';
import { useSettings } from '../../lib/settings';
import { parseInteger } from '../bench/expert-form';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Dialog, DialogClose, DialogContent } from '../ui/dialog';
import { Field, Input, Textarea } from '../ui/input';
import { SegmentedControl } from '../ui/segmented-control';
import { Select } from '../ui/select';
import { Switch } from '../ui/switch';
import { formOfRecipe, recipeOfForm, type ContextMode, type DraftMode, type RecipeField, type RecipeForm } from './recipe-form';
import { templateEngineName, type RecipeTarget } from './recipe-model';
import { RecipePreview } from './recipe-preview';
import { useRecipeStore } from './use-model-recipe';
import { YarnChoice } from './yarn-choice';

export interface RecipeEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: RecipeTarget;
  /** What the form starts from: the saved recipe, or a new one (a built-in recipe's settings). */
  initial: Partial<ModelRecipe> | undefined;
  /** The saved recipe being edited; absent = a new one. */
  editing?: ModelRecipe | undefined;
}

export function RecipeEditor(p: RecipeEditorProps) {
  return (
    <Dialog open={p.open} onOpenChange={p.onOpenChange}>
      {/* Keyed: every opening starts from its own recipe. */}
      {p.open && <EditorBody key={`${p.editing?.id ?? 'new'}:${JSON.stringify(p.initial ?? {})}`} {...p} />}
    </Dialog>
  );
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t border-border pt-4 first:border-t-0 first:pt-0">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-fg-3 uppercase">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** A field's hint, or its "invalid" message once the user tried to save. */
function hintFor(bad: boolean, message: string, hint?: string): ReactNode {
  return bad ? <span className="text-danger-text">{message}</span> : hint;
}

function EditorBody({ onOpenChange, target, initial, editing }: RecipeEditorProps) {
  const f = useI18n();
  const { t } = f;
  const { settings } = useSettings();
  const store = useRecipeStore();
  const [form, setForm] = useState<RecipeForm>(() => formOfRecipe(initial, target));
  const [tried, setTried] = useState(false);
  const llama = target.template.format === 'gguf' || target.template.format === undefined;
  const firstArgs: RecipeArgTarget = target.template.format === 'safetensors' ? 'vllm' : target.template.format === 'ninfer' ? 'ninfer' : 'llamacpp';
  const [argsTab, setArgsTab] = useState<RecipeArgTarget>(firstArgs);
  const set = (patch: Partial<RecipeForm>) => setForm((cur) => ({ ...cur, ...patch }));
  const result = recipeOfForm(form, target);
  const bad = (field: RecipeField) => tried && result.invalid.includes(field);
  const trainedKnown = target.template.trainedContext;
  const original = parseInteger(form.yarnOriginal) ?? trainedKnown;
  const draftFile = target.aux.find((a) => a.kind === 'mtp' || a.kind === 'draft');
  const projector = target.aux.some((a) => a.kind === 'mmproj');

  const save = () => {
    setTried(true);
    if (!result.draft) return;
    const draft = modelRecipeDraftSchema.parse(result.draft);
    if (recipeIsEmpty(draft)) {
      if (editing) {
        store.remove(editing.id);
        toast.success(t('recipes.toast.removed'));
      }
      onOpenChange(false);
      return;
    }
    const id = editing?.id ?? recipeIdFor(draft.name, store.recipes.map((r) => r.id));
    store.save(modelRecipeSchema.parse({ ...draft, id, updatedAt: new Date().toISOString() }));
    toast.success(t('recipes.toast.saved'));
    onOpenChange(false);
  };
  // Only offered while editing a saved recipe.
  const remove = (saved: ModelRecipe) => {
    store.remove(saved.id);
    toast.success(t('recipes.toast.removed'));
    onOpenChange(false);
  };

  // Engines a recipe can prefer: LLM Bench's own, the saved custom engines, and the templates for this model.
  const templates = CUSTOM_ENGINE_TEMPLATES.filter((x) => templateForModel(target.template)?.id === x.id || form.engine === `template:${x.id}`);
  const engineOptions = [
    { value: 'default', label: t('recipes.editor.engineDefault') },
    ...ENGINE_KINDS.filter((k) => k !== 'external' && k !== 'command').map((k) => ({ value: `builtin:${k}`, label: t(`benchmark.engines.${k}`) })),
    ...settings.customEngines.map((e) => ({ value: `custom:${e.id}`, label: e.name })),
    ...templates.map((x) => ({ value: `template:${x.id}`, label: t('recipes.editor.engineTemplate', { name: templateEngineName(x.id, f) }) })),
  ];
  // While a field is not valid the preview keeps the last command it could show.
  const valid = result.draft ? { inline: modelRecipeDraftSchema.parse(result.draft) } : undefined;
  const [preview, setPreview] = useState(valid);
  if (valid && JSON.stringify(valid) !== JSON.stringify(preview)) setPreview(valid);

  return (
    <DialogContent
      size="xl"
      title={editing ? t('recipes.editor.titleEdit') : t('recipes.editor.titleNew', { model: target.label })}
      description={t('recipes.editor.description')}
      footer={
        <div className="flex w-full flex-wrap items-center gap-2">
          {editing && (
            <Button variant="danger-outline" onClick={() => remove(editing)}>
              <Trash2 aria-hidden />
              {t('recipes.actions.remove')}
            </Button>
          )}
          <span className="ml-auto text-xs text-fg-3">{tried && result.invalid.length ? <span className="text-danger-text">{t('recipes.editor.invalid')}</span> : t('recipes.editor.emptyRemoves')}</span>
          <DialogClose asChild>
            <Button>{t('common.cancel')}</Button>
          </DialogClose>
          <Button variant="primary" onClick={save}>
            {t('recipes.editor.save')}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        <Section title={t('recipes.editor.scope')}>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label={t('recipes.editor.name')} hint={hintFor(bad('name'), t('benchmark.expert.invalid'), t('recipes.editor.nameHint'))}>
              {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} aria-invalid={bad('name') || undefined} value={form.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} />}
            </Field>
            <SegmentedControl<'model' | 'pattern'>
              layout="list"
              label={t('recipes.editor.scope')}
              value={form.scope}
              onValueChange={(scope) => set({ scope })}
              options={[
                { value: 'model', label: t('recipes.editor.scopeModel', { model: target.label }) },
                { value: 'pattern', label: t('recipes.editor.scopePattern') },
              ]}
            />
          </div>
          {form.scope === 'pattern' && (
            <div className="grid gap-4 md:grid-cols-2">
              <Field label={t('recipes.editor.pattern')} hint={hintFor(bad('pattern'), t('benchmark.expert.invalid'), t('recipes.editor.patternHint'))}>
                {({ id, describedBy }) => (
                  <Input id={id} aria-describedby={describedBy} aria-invalid={bad('pattern') || undefined} value={form.pattern} maxLength={200} onChange={(e) => set({ pattern: e.target.value })} className="font-mono text-xs" spellCheck={false} />
                )}
              </Field>
              <Field label={t('recipes.editor.quant')} hint={t('recipes.editor.quantHint')}>
                {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} value={form.quant} maxLength={60} onChange={(e) => set({ quant: e.target.value })} className="font-mono text-xs" spellCheck={false} />}
              </Field>
            </div>
          )}
        </Section>

        <Section title={t('recipes.editor.context')}>
          <SegmentedControl<ContextMode>
            label={t('recipes.editor.context')}
            value={form.context}
            onValueChange={(context) => set({ context })}
            options={[
              { value: 'auto', label: t('recipes.editor.contextAuto') },
              { value: 'yarn', label: t('recipes.editor.contextYarn') },
              { value: 'fixed', label: t('recipes.editor.contextFixed') },
            ]}
          />
          {form.context === 'yarn' && (
            <div className="flex flex-col gap-3 border-l-2 border-accent/40 pl-4">
              {trainedKnown === undefined && (
                <Field label={t('context.yarn.originalLabel')} hint={hintFor(bad('yarnOriginal'), t('benchmark.expert.invalid'))} className="max-w-56">
                  {({ id, describedBy }) => (
                    <Input id={id} aria-describedby={describedBy} inputMode="numeric" aria-invalid={bad('yarnOriginal') || undefined} value={form.yarnOriginal} onChange={(e) => set({ yarnOriginal: e.target.value })} className="tabular-nums" />
                  )}
                </Field>
              )}
              <YarnChoice value={form.yarnTarget} onChange={(yarnTarget) => set({ yarnTarget })} trained={original} invalid={bad('yarnTarget')} />
            </div>
          )}
          {form.context === 'fixed' && (
            <Field label={t('recipes.editor.contextFixedLabel')} hint={hintFor(bad('contextSize'), t('benchmark.expert.invalid'))} className="max-w-56 border-l-2 border-accent/40 pl-4">
              {({ id, describedBy }) => (
                <Input id={id} aria-describedby={describedBy} inputMode="numeric" aria-invalid={bad('contextSize') || undefined} value={form.contextSize} onChange={(e) => set({ contextSize: e.target.value })} className="tabular-nums" />
              )}
            </Field>
          )}
        </Section>

        <Section title={t('recipes.editor.engine')}>
          <Field label={t('recipes.editor.engine')} hint={t('recipes.editor.engineHint')} className="max-w-md">
            {({ id, describedBy }) => <Select id={id} aria-describedby={describedBy as string} value={form.engine} onValueChange={(engine) => set({ engine })} options={engineOptions} />}
          </Field>
          {llama && (
            <div className="grid gap-4 md:grid-cols-2">
              <div className="flex flex-col gap-2">
                <span className="text-sm font-medium text-fg">{t('recipes.editor.draft')}</span>
                <SegmentedControl<DraftMode>
                  layout="list"
                  label={t('recipes.editor.draft')}
                  value={form.draft}
                  onValueChange={(draft) => set({ draft })}
                  options={[
                    { value: 'none', label: t('recipes.editor.draftNone') },
                    { value: 'auto', label: t('recipes.editor.draftAuto') },
                    { value: 'file', label: t('recipes.editor.draftFile') },
                  ]}
                />
                {form.draft === 'auto' && (
                  <p className="text-xs text-fg-3">{draftFile ? t('recipes.editor.draftAutoFound', { file: draftFile.path.split(/[\\/]/).pop() as string }) : t('recipes.editor.draftAutoMissing')}</p>
                )}
                {form.draft === 'file' && (
                  <Field label={t('recipes.editor.draftFileLabel')} hint={hintFor(bad('draftFile'), t('benchmark.expert.invalid'))}>
                    {({ id, describedBy }) => (
                      <div className="flex gap-2">
                        <Input id={id} aria-describedby={describedBy} aria-invalid={bad('draftFile') || undefined} value={form.draftFile} onChange={(e) => set({ draftFile: e.target.value })} className="font-mono text-xs" spellCheck={false} />
                        {window.gpubench && (
                          <Button
                            onClick={() =>
                              void window.gpubench!.pickFile({ title: t('recipes.editor.draftFileLabel'), filters: [{ name: 'GGUF', extensions: ['gguf'] }] }).then((path) => {
                                if (path) set({ draftFile: path });
                              })
                            }
                          >
                            {t('common.browse')}
                          </Button>
                        )}
                      </div>
                    )}
                  </Field>
                )}
              </div>
              <div className="flex items-start gap-3">
                <Switch id="recipe-mmproj" checked={form.mmproj} onCheckedChange={(mmproj) => set({ mmproj })} aria-describedby="recipe-mmproj-hint" className="mt-0.5" />
                <div className="flex flex-col gap-0.5">
                  <label htmlFor="recipe-mmproj" className="cursor-pointer text-sm font-medium text-fg">
                    {t('recipes.editor.mmproj')}
                  </label>
                  <span id="recipe-mmproj-hint" className="text-xs text-fg-3">
                    {projector ? t('recipes.editor.mmprojHint') : t('recipes.editor.mmprojMissing')}
                  </span>
                </div>
              </div>
            </div>
          )}
        </Section>

        <Section title={t('recipes.editor.args')}>
          <SegmentedControl<RecipeArgTarget>
            size="sm"
            label={t('recipes.editor.args')}
            value={argsTab}
            onValueChange={setArgsTab}
            options={RECIPE_ARG_TARGETS.map((k) => ({
              value: k,
              label: (
                <span className="inline-flex items-center gap-1.5">
                  {t(`recipes.targets.${k}`)}
                  {form.args[k].trim() && (
                    <Badge tone="accent" size="sm" aria-hidden>
                      •
                    </Badge>
                  )}
                </span>
              ),
            }))}
          />
          <Field label={`${t('recipes.editor.args')} · ${t(`recipes.targets.${argsTab}`)}`} hint={hintFor(bad(`args.${argsTab}`), t('recipes.editor.argsInvalid'), t('recipes.editor.argsHint'))}>
            {({ id, describedBy }) => (
              <Textarea
                id={id}
                aria-describedby={describedBy}
                aria-invalid={bad(`args.${argsTab}`) || undefined}
                value={form.args[argsTab]}
                onChange={(e) => set({ args: { ...form.args, [argsTab]: e.target.value } })}
                placeholder={argsTab === 'llamacpp' ? '--jinja' : argsTab === 'vllm' ? '--enable-chunked-prefill' : ''}
                className="font-mono text-xs"
                spellCheck={false}
              />
            )}
          </Field>
          <Field label={t('recipes.editor.env')} hint={hintFor(bad('env'), t('recipes.editor.envInvalid'), t('recipes.editor.envHint'))}>
            {({ id, describedBy }) => (
              <Textarea id={id} aria-describedby={describedBy} aria-invalid={bad('env') || undefined} value={form.env} onChange={(e) => set({ env: e.target.value })} placeholder="GGML_CUDA_GRAPH_OPT=1" className="font-mono text-xs" spellCheck={false} />
            )}
          </Field>
        </Section>

        <Section title={t('recipes.editor.notes')}>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label={t('recipes.editor.notes')} hint={hintFor(bad('notes'), t('benchmark.expert.invalid'))}>
              {({ id, describedBy }) => <Textarea id={id} aria-describedby={describedBy} value={form.notes} maxLength={4000} onChange={(e) => set({ notes: e.target.value })} placeholder={t('recipes.editor.notesPlaceholder')} />}
            </Field>
            <Field label={t('recipes.editor.link')} hint={hintFor(bad('link'), t('recipes.editor.linkInvalid'))}>
              {({ id, describedBy }) => (
                <Input id={id} type="url" aria-describedby={describedBy} aria-invalid={bad('link') || undefined} value={form.link} onChange={(e) => set({ link: e.target.value })} placeholder="https://huggingface.co/…" className="font-mono text-xs" spellCheck={false} />
              )}
            </Field>
          </div>
        </Section>

        <Section title={t('recipes.preview.title')}>
          <RecipePreview target={target} recipe={preview} live />
        </Section>
      </div>
    </DialogContent>
  );
}
