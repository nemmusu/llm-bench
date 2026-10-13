import { Boxes, FlaskConical, FolderOpen, GitBranch, Terminal } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { CUSTOM_ENGINE_BASES, COMMAND_PLACEHOLDERS, type CustomEngine, type CustomEngineBase, type CustomEngineTemplate } from '../../../contract/custom-engines';
import { useI18n, type MessageKey } from '../../i18n';
import { useCheckCustomEngine, useSaveCustomEngine } from '../../lib/queries-engines';
import { useSystemInfo } from '../../lib/queries-library';
import { ErrorCallout } from '../library/error-callout';
import { Button } from '../ui/button';
import { Dialog, DialogContent } from '../ui/dialog';
import { Field, Input, Textarea } from '../ui/input';
import { SegmentedControl } from '../ui/segmented-control';
import { Stepper, type StepState } from '../ui/stepper';
import { CheckView } from './custom-engine-check';
import { draftOf, EMPTY_FORM, formOf, formOfTemplate, modeFor, type CustomEngineForm, type FieldProblem, type FormField } from './custom-engine-form';

export interface CustomEngineDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The engine to edit; absent = a new one. */
  editing?: CustomEngine | undefined;
  /** A new engine from a built-in template (its type and rules filled in). */
  template?: CustomEngineTemplate | undefined;
  /** The model that asked for it ("Serve per Ternary-Bonsai-8B PQ2_0"). */
  forModel?: string | undefined;
  onSaved?: (engine: CustomEngine) => void;
}

const BASE_ICONS: Record<CustomEngineBase, ReactNode> = {
  llamacpp: <GitBranch />,
  vllm: <Boxes />,
  sglang: <FlaskConical />,
  'openai-server': <Terminal />,
};

const STEPS = ['kind', 'where', 'options'] as const;
type Step = (typeof STEPS)[number];

/** Fields checked before leaving a step. */
const STEP_FIELDS: Record<Step, readonly FormField[]> = { kind: [], where: ['name', 'path', 'image', 'template'], options: ['extraArgs', 'env', 'names'] };

/**
 * "Aggiungi motore": what kind of engine, where it is (with "Prova": its version and the GPU Bench
 * settings it does not know), then the optional extra arguments, environment and model rules.
 */
export function CustomEngineDialog(p: CustomEngineDialogProps) {
  return (
    <Dialog open={p.open} onOpenChange={p.onOpenChange}>
      {/* Mounted only while open: every opening starts from its own data. */}
      {p.open && <DialogBody {...p} />}
    </Dialog>
  );
}

function DialogBody({ editing, template, forModel, onOpenChange, onSaved }: CustomEngineDialogProps) {
  const { t } = useI18n();
  const system = useSystemInfo();
  const save = useSaveCustomEngine();
  const check = useCheckCustomEngine();
  const [form, setForm] = useState<CustomEngineForm>(() =>
    editing ? formOf(editing) : template ? formOfTemplate(template, t(`engines.custom.templates.${template.id}.name` as MessageKey)) : EMPTY_FORM,
  );
  // A known type (editing, a template) starts at "where it is".
  const [step, setStep] = useState<Step>(editing || template ? 'where' : 'kind');
  const [shown, setShown] = useState<ReadonlySet<FormField>>(new Set());
  const linuxOnlyNative = system.data !== undefined && system.data.os.platform !== 'linux';
  const mode = modeFor(form.base, form.mode);
  // vLLM and SGLang have no Windows build: there they are Docker images only.
  const nativeBlocked = linuxOnlyNative && (form.base === 'vllm' || form.base === 'sglang');
  const effMode = nativeBlocked && mode === 'native' ? 'docker' : mode;
  const effForm = { ...form, mode: effMode };
  const { draft, problems } = draftOf(effForm);

  const set = (patch: Partial<CustomEngineForm>) => {
    setForm((cur) => ({ ...cur, ...patch }));
    check.reset();
  };
  const problem = (f: FormField): FieldProblem | undefined => (shown.has(f) ? problems[f] : undefined);
  const hint = (f: FormField, normal: ReactNode): ReactNode => {
    const pr = problem(f);
    return pr ? <span className="text-danger-text">{t(`engines.custom.dialog.${pr.key}` as MessageKey, { port: '{port}', ...pr.params })}</span> : normal;
  };
  const stepOk = (s: Step) => STEP_FIELDS[s].every((f) => problems[f] === undefined);
  const next = () => {
    if (!stepOk(step)) {
      setShown(new Set(STEP_FIELDS[step]));
      return;
    }
    setStep(STEPS[STEPS.indexOf(step) + 1] as Step);
  };
  const submit = () => {
    // "Salva" is on the last step, reached only with "Dove si trova" complete: what is wrong is on this step.
    if (!draft) {
      setShown(new Set([...STEP_FIELDS.where, ...STEP_FIELDS.options]));
      return;
    }
    save.mutate(
      { id: editing?.id, draft },
      {
        onSuccess: (saved) => {
          toast.success(t('engines.custom.saved'));
          onSaved?.(saved);
          onOpenChange(false);
        },
      },
    );
  };
  const pick = async (folder: boolean) => {
    const bridge = window.gpubench;
    const title = t(`engines.custom.dialog.${form.base === 'llamacpp' ? 'pathLlama' : form.base === 'vllm' ? 'pathVllm' : 'pathSglang'}`);
    const path = folder ? await bridge?.pickFolder({ title }) : await bridge?.pickFile({ title });
    if (path) set({ path });
  };

  const baseLabel = t(`engines.custom.bases.${form.base}`);
  const at = STEPS.indexOf(step);
  const stateOf = (i: number): StepState => (i < at ? 'done' : i === at ? 'current' : 'pending');
  const examples: Record<CustomEngineBase, string> = { llamacpp: 'ghcr.io/me/llama.cpp:fork', vllm: 'me/vllm-fork:latest', sglang: 'me/sglang-fork:latest', 'openai-server': '' };

  return (
    <DialogContent
      size="lg"
      title={editing ? t('engines.custom.dialog.editTitle', { name: editing.name }) : t('engines.custom.dialog.addTitle')}
      description={forModel ? t('engines.custom.dialog.forModel', { model: forModel }) : undefined}
      footer={
        <>
          {at > 0 && (
            <Button variant="ghost" onClick={() => setStep(STEPS[at - 1] as Step)} className="mr-auto">
              {t('engines.custom.dialog.back')}
            </Button>
          )}
          {step === 'options' ? (
            <Button variant="primary" onClick={submit} disabled={save.isPending}>
              {t('engines.custom.dialog.save')}
            </Button>
          ) : (
            <Button variant="primary" onClick={next}>
              {t('engines.custom.dialog.next')}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <Stepper
          size="sm"
          label={t('engines.custom.dialog.stepLabel')}
          stateLabels={{ done: t('phases.state.done'), current: t('phases.state.current'), pending: t('phases.state.pending'), skipped: t('phases.state.skipped') }}
          steps={STEPS.map((s, i) => ({ id: s, label: t(`engines.custom.dialog.steps.${s}`), state: stateOf(i) }))}
        />

        {step === 'kind' && (
          <SegmentedControl<CustomEngineBase>
            layout="list"
            label={t('engines.custom.dialog.kindQuestion')}
            value={form.base}
            onValueChange={(base) => set({ base, mode: modeFor(base, form.mode) })}
            options={CUSTOM_ENGINE_BASES.map((b) => ({ value: b, icon: BASE_ICONS[b], label: t(`engines.custom.bases.${b}`), sublabel: t(`engines.custom.basesDesc.${b}`) }))}
          />
        )}

        {step === 'where' && (
          <div className="flex flex-col gap-4">
            <p className="inline-flex items-center gap-2 text-sm font-medium text-fg-2 [&_svg]:size-4">
              {BASE_ICONS[form.base]}
              {baseLabel}
            </p>
            <Field label={t('engines.custom.dialog.name')} hint={hint('name', t('engines.custom.dialog.nameHint'))}>
              {({ id, describedBy }) => (
                <Input id={id} aria-describedby={describedBy} aria-invalid={problem('name') ? true : undefined} value={form.name} maxLength={60} onChange={(e) => set({ name: e.target.value })} />
              )}
            </Field>

            {form.base !== 'openai-server' && (
              <div className="flex flex-col gap-2">
                <SegmentedControl<'native' | 'docker'>
                  label={t('engines.custom.dialog.mode')}
                  value={effMode === 'docker' ? 'docker' : 'native'}
                  onValueChange={(m) => set({ mode: m })}
                  options={[
                    { value: 'native', label: t('engines.custom.dialog.modeNative'), disabled: nativeBlocked },
                    { value: 'docker', label: t('engines.custom.dialog.modeDocker') },
                  ]}
                />
                {nativeBlocked && <p className="text-xs text-fg-3">{t('engines.custom.dialog.nativeLinuxOnly', { base: form.base === 'vllm' ? 'vLLM' : 'SGLang' })}</p>}
              </div>
            )}

            {effMode === 'native' && (
              <Field
                label={t(`engines.custom.dialog.${form.base === 'llamacpp' ? 'pathLlama' : form.base === 'vllm' ? 'pathVllm' : 'pathSglang'}`)}
                hint={hint('path', t(`engines.custom.dialog.${form.base === 'llamacpp' ? 'pathLlamaHint' : form.base === 'vllm' ? 'pathVllmHint' : 'pathSglangHint'}`))}
              >
                {({ id, describedBy }) => (
                  <div className="flex flex-wrap gap-2">
                    <Input
                      id={id}
                      aria-describedby={describedBy}
                      aria-invalid={problem('path') ? true : undefined}
                      value={form.path}
                      onChange={(e) => set({ path: e.target.value })}
                      className="min-w-0 flex-1 font-mono text-xs"
                      spellCheck={false}
                    />
                    {window.gpubench && (
                      <>
                        <Button onClick={() => void pick(false)}>
                          <FolderOpen aria-hidden />
                          {t('engines.custom.dialog.pickFile')}
                        </Button>
                        {form.base !== 'llamacpp' && <Button onClick={() => void pick(true)}>{t('engines.custom.dialog.pickFolder')}</Button>}
                      </>
                    )}
                  </div>
                )}
              </Field>
            )}

            {effMode === 'docker' && form.base !== 'openai-server' && (
              <Field label={t('engines.custom.dialog.image')} hint={hint('image', t('engines.custom.dialog.imageHint', { example: examples[form.base] }))}>
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    aria-invalid={problem('image') ? true : undefined}
                    value={form.image}
                    placeholder={examples[form.base]}
                    onChange={(e) => set({ image: e.target.value })}
                    className="font-mono text-xs"
                    spellCheck={false}
                  />
                )}
              </Field>
            )}

            {effMode === 'command' && (
              <>
                <Field
                  label={t('engines.custom.dialog.template')}
                  hint={hint(
                    'template',
                    t('engines.custom.dialog.templateHint', {
                      placeholders: COMMAND_PLACEHOLDERS.map((ph) => `{${ph}} = ${t(`engines.custom.dialog.placeholders.${ph}`)}`).join(' · '),
                      port: '{port}',
                    }),
                  )}
                >
                  {({ id, describedBy }) => (
                    <Textarea
                      id={id}
                      aria-describedby={describedBy}
                      aria-invalid={problem('template') ? true : undefined}
                      value={form.template}
                      maxLength={4000}
                      placeholder="python -m my_server --model {model} --port {port} --name {alias}"
                      onChange={(e) => set({ template: e.target.value })}
                      className="font-mono text-xs"
                      spellCheck={false}
                    />
                  )}
                </Field>
                <p className="text-xs text-fg-3">{t('engines.custom.dialog.aliasTip', { alias: '{alias}' })}</p>
                <div className="flex flex-col gap-1.5">
                  <SegmentedControl<'completions' | 'chat'>
                    label={t('engines.custom.dialog.api')}
                    value={form.api}
                    onValueChange={(api) => set({ api })}
                    options={[
                      { value: 'completions', label: t('engines.custom.dialog.apiCompletions') },
                      { value: 'chat', label: t('engines.custom.dialog.apiChat') },
                    ]}
                  />
                  <p className="text-xs text-fg-3">{t('engines.custom.dialog.apiHint')}</p>
                </div>
              </>
            )}

            <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-2 p-3">
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  onClick={() => {
                    if (draft) check.mutate(draft);
                    else setShown(new Set(STEP_FIELDS.where));
                  }}
                  disabled={check.isPending}
                >
                  <FlaskConical aria-hidden />
                  {t('engines.custom.dialog.test')}
                </Button>
                <p className="min-w-0 flex-1 text-xs text-fg-3">{t(effMode === 'command' ? 'engines.custom.dialog.testCommandHint' : 'engines.custom.dialog.testHint')}</p>
              </div>
              {check.isPending && <p className="text-sm text-fg-2">{t('engines.custom.checking')}</p>}
              {check.data && draft && <CheckView check={check.data} baseLabel={baseLabel} run={draft.run as CustomEngine['run']} />}
              {check.isError && <ErrorCallout error={check.error} />}
            </div>
          </div>
        )}

        {step === 'options' && (
          <div className="flex flex-col gap-4">
            <Field label={t('engines.custom.dialog.extraArgs')} hint={hint('extraArgs', t('engines.custom.dialog.extraArgsHint', { example: form.base === 'llamacpp' ? '--ternary-kernels on' : '--trust-remote-code' }))}>
              {({ id, describedBy }) => (
                <Input id={id} aria-describedby={describedBy} value={form.extraArgs} onChange={(e) => set({ extraArgs: e.target.value })} className="font-mono text-xs" spellCheck={false} />
              )}
            </Field>
            <Field label={t('engines.custom.dialog.env')} hint={hint('env', t('engines.custom.dialog.envHint'))}>
              {({ id, describedBy }) => (
                <Textarea id={id} aria-describedby={describedBy} value={form.env} onChange={(e) => set({ env: e.target.value })} className="min-h-16 font-mono text-xs" spellCheck={false} />
              )}
            </Field>
            <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-3">
              <legend className="px-1 text-sm font-medium text-fg">{t('engines.custom.dialog.rules')}</legend>
              <p className="text-xs text-fg-3">{t('engines.custom.dialog.rulesHint')}</p>
              <Field label={t('engines.custom.dialog.ruleNames')} hint={hint('names', t('engines.custom.dialog.ruleNamesHint'))}>
                {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} value={form.names} onChange={(e) => set({ names: e.target.value })} />}
              </Field>
              <Field label={t('engines.custom.dialog.ruleQuants')} hint={t('engines.custom.dialog.ruleQuantsHint')}>
                {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} value={form.quants} onChange={(e) => set({ quants: e.target.value })} className="font-mono text-xs" />}
              </Field>
            </fieldset>
            <Field label={t('engines.custom.dialog.notes')}>
              {({ id }) => <Textarea id={id} value={form.notes} maxLength={2000} onChange={(e) => set({ notes: e.target.value })} className="min-h-16" />}
            </Field>
            {save.isError && <ErrorCallout error={save.error} />}
          </div>
        )}
      </div>
    </DialogContent>
  );
}
