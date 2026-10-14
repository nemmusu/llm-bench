/**
 * "Modifica" / "Scrivi i comandi": a recipe in plain fields — who it is for, the context (YaRN), the
 * engine, the MTP / draft file and the image projector (llama.cpp), extra arguments per engine (with
 * the common ones a click away), environment, notes and the model page — with the exact command it
 * gives, live and always in view (beside the fields in a wide dialog, pinned under them in a narrow
 * one). Only the engines that can run the model are offered. "Elimina ricetta" removes it, after a
 * confirmation; saving one left with nothing in it asks the same.
 */
import { Check, Plus, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { CUSTOM_ENGINE_TEMPLATES, templateForModel, type CustomEngineBase } from '../../../contract/custom-engines';
import { engineBaseOf, ENGINE_KINDS } from '../../../contract/engines';
import { modelRecipeDraftSchema, modelRecipeSchema, recipeIdFor, recipeIsEmpty, type ModelRecipe, type RecipeArgTarget } from '../../../contract/recipes';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/cn';
import { useSettings } from '../../lib/settings';
import { parseInteger } from '../bench/expert-form';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { ConfirmDialog, Dialog, DialogClose, DialogContent } from '../ui/dialog';
import { Field, Input, Textarea } from '../ui/input';
import { SegmentedControl } from '../ui/segmented-control';
import { Select } from '../ui/select';
import { Switch } from '../ui/switch';
import {
  ARG_SUGGESTIONS,
  argPresent,
  argTargetsFor,
  baseFits,
  formOfRecipe,
  recipeOfForm,
  toggleArg,
  type ArgSuggestion,
  type ContextMode,
  type DraftMode,
  type RecipeField,
  type RecipeForm,
} from './recipe-form';
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

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t border-border pt-4 first:border-t-0 first:pt-0">
      <h3 className="text-xs font-semibold tracking-wide text-fg-3 uppercase">{title}</h3>
      {children}
    </section>
  );
}

/** A field's hint, or its "invalid" message once the user tried to save. */
function hintFor(bad: boolean, message: string, hint?: string): ReactNode {
  return bad ? <span className="text-danger-text">{message}</span> : hint;
}

/** One-click argument: "--jinja · il template di chat del modello"; pressed while it is in the arguments (a click takes it out). */
function ArgChip({ flag, label, pressed, onClick }: { flag: string; label: string; pressed: boolean | undefined; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={pressed === true}
      disabled={pressed === undefined}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors focus-ring disabled:opacity-50',
        pressed ? 'border-accent bg-accent-soft text-accent-text' : 'border-border-strong bg-surface text-fg-2 hover:border-fg-3 hover:text-fg',
      )}
    >
      {pressed ? <Check aria-hidden className="size-3 shrink-0" /> : <Plus aria-hidden className="size-3 shrink-0" />}
      <span className="font-mono">{flag}</span>
      <span className={cn('truncate', pressed ? 'text-accent-text/80' : 'text-fg-3')}>{label}</span>
    </button>
  );
}

function EditorBody({ onOpenChange, target, initial, editing }: RecipeEditorProps) {
  const f = useI18n();
  const { t } = f;
  const { settings } = useSettings();
  const store = useRecipeStore();
  const [form, setForm] = useState<RecipeForm>(() => formOfRecipe(initial, target));
  const [tried, setTried] = useState(false);
  const [confirm, setConfirm] = useState<'delete' | 'empty' | undefined>(undefined);
  const [argsTab, setArgsTab] = useState<RecipeArgTarget | undefined>(undefined);
  const format = target.template.format;
  const family = form.scope === 'pattern';
  const fits = (base: CustomEngineBase) => baseFits(base, format, family);
  const llama = format === 'gguf' || format === undefined;
  const set = (patch: Partial<RecipeForm>) => setForm((cur) => ({ ...cur, ...patch }));
  const result = recipeOfForm(form, target);
  const bad = (field: RecipeField) => tried && result.invalid.includes(field);
  const trainedKnown = target.template.trainedContext;
  const original = parseInteger(form.yarnOriginal) ?? trainedKnown;
  const draftFile = target.aux.find((a) => a.kind === 'mtp' || a.kind === 'draft');
  const projector = target.aux.some((a) => a.kind === 'mmproj');
  // NInfer runs its models as trained: no YaRN for a .ninfer model (unless the recipe already has it).
  const yarn = family || format !== 'ninfer' || form.context === 'yarn';
  // Arguments only for the engines that can run the model; "Programma" when a program is saved.
  const targets = argTargetsFor(form, format, settings.customEngines.some((e) => e.base === 'openai-server'));
  const tab = argsTab && targets.includes(argsTab) ? argsTab : (targets[0] as RecipeArgTarget);
  const setArgs = (text: string) => set({ args: { ...form.args, [tab]: text } });

  // While a field is not valid the preview keeps the last command it could show.
  const valid = result.draft ? { inline: modelRecipeDraftSchema.parse(result.draft) } : undefined;
  const [preview, setPreview] = useState(valid);
  if (valid && JSON.stringify(valid) !== JSON.stringify(preview)) setPreview(valid);
  const empty = valid !== undefined && recipeIsEmpty(valid.inline);

  const save = () => {
    setTried(true);
    if (!valid) return;
    if (empty) {
      // Nothing left in a saved recipe: say it is going to be deleted. A new one: say what to set.
      if (editing) setConfirm('empty');
      return;
    }
    const id = editing?.id ?? recipeIdFor(valid.inline.name, store.recipes.map((r) => r.id));
    store.save(modelRecipeSchema.parse({ ...valid.inline, id, updatedAt: new Date().toISOString() }));
    toast.success(t('recipes.toast.saved'));
    onOpenChange(false);
  };
  // Only offered while editing a saved recipe, once confirmed.
  const remove = (saved: ModelRecipe) => {
    store.remove(saved.id);
    toast.success(t('recipes.toast.removed'));
    onOpenChange(false);
  };

  // Engines a recipe can prefer: LLM Bench's own, the saved custom engines, and the templates for this model — those that can run it, and the one already chosen.
  const templates = CUSTOM_ENGINE_TEMPLATES.filter((x) => templateForModel(target.template)?.id === x.id || form.engine === `template:${x.id}`);
  const engineOptions = [
    { value: 'default', label: t('recipes.editor.engineDefault') },
    ...ENGINE_KINDS.filter((k) => k !== 'external' && k !== 'command' && (fits(engineBaseOf(k) as CustomEngineBase) || form.engine === `builtin:${k}`)).map((k) => ({
      value: `builtin:${k}`,
      label: t(`benchmark.engines.${k}`),
    })),
    ...settings.customEngines.filter((e) => fits(e.base) || form.engine === `custom:${e.id}`).map((e) => ({ value: `custom:${e.id}`, label: e.name })),
    ...templates.map((x) => ({ value: `template:${x.id}`, label: t('recipes.editor.engineTemplate', { name: templateEngineName(x.id, f) }) })),
  ];
  const footerNote = tried && result.invalid.length ? t('recipes.editor.invalid') : tried && empty && !editing ? t('recipes.editor.empty') : undefined;

  return (
    <DialogContent
      size="xl"
      className="max-h-[92vh] max-w-[1240px]"
      title={editing ? t('recipes.editor.titleEdit') : t('recipes.editor.titleNew', { model: target.label })}
      description={t('recipes.editor.description')}
      footer={
        <div className="flex w-full flex-wrap items-center gap-2">
          {editing && (
            <Button variant="danger-outline" onClick={() => setConfirm('delete')}>
              <Trash2 aria-hidden />
              {t('recipes.actions.remove')}
            </Button>
          )}
          <span role="status" className="ml-auto text-xs text-danger-text">
            {footerNote}
          </span>
          <DialogClose asChild>
            <Button>{t('common.cancel')}</Button>
          </DialogClose>
          <Button variant="primary" onClick={save}>
            {t('recipes.editor.save')}
          </Button>
          {editing && (
            <ConfirmDialog
              open={confirm !== undefined}
              onOpenChange={(o) => !o && setConfirm(undefined)}
              title={t('recipes.editor.deleteTitle', { name: editing.name })}
              description={confirm === 'empty' ? t('recipes.editor.deleteEmptyBody') : t('recipes.editor.deleteBody')}
              confirmLabel={t('recipes.editor.deleteConfirm')}
              cancelLabel={t('common.cancel')}
              onConfirm={() => remove(editing)}
            />
          )}
        </div>
      }
    >
      <div className="@container">
        <div className="grid gap-x-8 @min-[1040px]:grid-cols-[minmax(0,1fr)_minmax(0,440px)]">
          <div className="@container/form flex min-w-0 flex-col gap-4 pb-4 @min-[1040px]:pb-1">
            <Section title={t('recipes.editor.scope')}>
              <div className="grid gap-4 @lg/form:grid-cols-2">
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
                <div className="grid gap-4 @lg/form:grid-cols-2">
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
                  ...(yarn ? [{ value: 'yarn' as const, label: t('recipes.editor.contextYarn') }] : []),
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
                <div className="grid gap-4 @lg/form:grid-cols-2">
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
              {targets.length > 1 && (
                <SegmentedControl<RecipeArgTarget>
                  size="sm"
                  label={t('recipes.editor.args')}
                  value={tab}
                  onValueChange={setArgsTab}
                  className="self-start"
                  options={targets.map((k) => ({
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
              )}
              {ARG_SUGGESTIONS[tab].length > 0 && (
                <div role="group" aria-label={t('recipes.editor.suggest.title')} className="flex flex-wrap items-center gap-1.5">
                  <span aria-hidden className="mr-1 text-xs text-fg-3">
                    {t('recipes.editor.suggest.title')}
                  </span>
                  {ARG_SUGGESTIONS[tab].map((s: ArgSuggestion) => (
                    <ArgChip key={s.id} flag={s.args[0] as string} label={t(`recipes.editor.suggest.${s.id}`)} pressed={argPresent(form.args[tab], s)} onClick={() => setArgs(toggleArg(form.args[tab], s) as string)} />
                  ))}
                </div>
              )}
              <div className="grid gap-4 @2xl/form:grid-cols-[3fr_2fr]">
                <Field label={`${t('recipes.editor.args')} · ${t(`recipes.targets.${tab}`)}`} hint={hintFor(bad(`args.${tab}`), t('recipes.editor.argsInvalid'), t('recipes.editor.argsHint'))}>
                  {({ id, describedBy }) => (
                    <Textarea
                      id={id}
                      aria-describedby={describedBy}
                      aria-invalid={bad(`args.${tab}`) || undefined}
                      value={form.args[tab]}
                      onChange={(e) => setArgs(e.target.value)}
                      placeholder={tab === 'llamacpp' ? '--jinja' : tab === 'vllm' ? '--enable-chunked-prefill' : ''}
                      rows={2}
                      className="min-h-16 font-mono text-xs"
                      spellCheck={false}
                    />
                  )}
                </Field>
                <Field label={t('recipes.editor.env')} hint={hintFor(bad('env'), t('recipes.editor.envInvalid'), t('recipes.editor.envHint'))}>
                  {({ id, describedBy }) => (
                    <Textarea
                      id={id}
                      aria-describedby={describedBy}
                      aria-invalid={bad('env') || undefined}
                      value={form.env}
                      onChange={(e) => set({ env: e.target.value })}
                      placeholder={llama ? 'GGML_CUDA_GRAPH_OPT=1' : undefined}
                      rows={2}
                      className="min-h-16 font-mono text-xs"
                      spellCheck={false}
                    />
                  )}
                </Field>
              </div>
            </Section>

            <Section title={t('recipes.editor.notes')}>
              <div className="grid gap-4 @lg/form:grid-cols-2">
                <Field label={t('recipes.editor.notes')} hint={hintFor(bad('notes'), t('benchmark.expert.invalid'))}>
                  {({ id, describedBy }) => (
                    <Textarea id={id} aria-describedby={describedBy} value={form.notes} maxLength={4000} rows={2} onChange={(e) => set({ notes: e.target.value })} placeholder={t('recipes.editor.notesPlaceholder')} className="min-h-16" />
                  )}
                </Field>
                <Field label={t('recipes.editor.link')} hint={hintFor(bad('link'), t('recipes.editor.linkInvalid'))}>
                  {({ id, describedBy }) => (
                    <Input id={id} type="url" aria-describedby={describedBy} aria-invalid={bad('link') || undefined} value={form.link} onChange={(e) => set({ link: e.target.value })} placeholder="https://huggingface.co/…" className="font-mono text-xs" spellCheck={false} />
                  )}
                </Field>
              </div>
            </Section>
          </div>

          {/* The command, always in view: pinned under the fields, or beside them in a wide dialog. */}
          <aside
            className={cn(
              // -bottom-3: flush with the dialog's footer, over the body's bottom padding.
              'sticky -bottom-3 z-10 -mx-6 -mb-3 border-t border-border bg-elevated px-6 pt-3 pb-3 shadow-[0_-10px_16px_-14px_rgb(0_0_0/0.35)] [&_pre]:max-h-24',
              '@min-[1040px]:top-0 @min-[1040px]:bottom-auto @min-[1040px]:mx-0 @min-[1040px]:mb-0 @min-[1040px]:self-start @min-[1040px]:border-t-0 @min-[1040px]:px-0 @min-[1040px]:pt-0 @min-[1040px]:shadow-none @min-[1040px]:[&_pre]:max-h-[56vh]',
            )}
          >
            <RecipePreview target={target} recipe={preview} live />
          </aside>
        </div>
      </div>
    </DialogContent>
  );
}
