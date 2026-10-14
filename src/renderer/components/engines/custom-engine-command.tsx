/**
 * "Programma con API OpenAI" in the add/edit dialog, in two columns on a wide window. Left: the examples
 * (one click fills every command), the server command, which API it is measured with, the KV types {kv}
 * takes (only when a command uses it) and, folded, the commands before and after the server. Right,
 * always in view while typing: every command filled in with example values, which LLM Bench settings it
 * takes (only those appear in the Benchmark), whether "Trova le impostazioni migliori" can search it
 * (it needs {ctx}), "Prova" and, folded, what each placeholder becomes.
 */
import { useState, type ReactNode } from 'react';
import { COMMAND_KV_TYPES, COMMAND_PLACEHOLDERS, commandSettings, commandTuneProblem, type CommandKvType } from '../../../contract/custom-engines';
import { useI18n } from '../../i18n';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { CodeBlock } from '../ui/code-block';
import { Field, Textarea } from '../ui/input';
import { SegmentedControl } from '../ui/segmented-control';
import { settingLabel } from './command-settings';
import { COMMAND_EXAMPLES, commandPreview, formCommands, usesKv, withExample, type CustomEngineForm, type FieldProblem, type FormField } from './custom-engine-form';

export interface CommandFieldsProps {
  form: CustomEngineForm;
  set: (patch: Partial<CustomEngineForm>) => void;
  /** A field's hint, or its problem in words once shown. */
  hint: (f: FormField, normal: ReactNode) => ReactNode;
  problem: (f: FormField) => FieldProblem | undefined;
  /** The system the commands will run on (the example model path). */
  platform: string | undefined;
  /** "Prova", shown under the preview. */
  aside?: ReactNode;
}

export function CommandFields({ form, set, hint, problem, platform, aside }: CommandFieldsProps) {
  const { t } = useI18n();
  const commands = formCommands(form);
  const settings = commandSettings(commands);
  const kv = usesKv(form);
  // The commands before and after stay folded until there are some (or one has a problem to show).
  const hasSteps = commands.before.length > 0 || commands.after.length > 0;
  const [stepsOpen, setStepsOpen] = useState(hasSteps);
  // Once there were some (an example, an edit), they stay open even when emptied.
  if (hasSteps && !stepsOpen) setStepsOpen(true);
  const showSteps = stepsOpen || hasSteps;
  const preview = commandPreview(form, platform, { before: t('engines.custom.dialog.previewBefore'), server: t('engines.custom.dialog.previewServer'), after: t('engines.custom.dialog.previewAfter') });
  const toggleKv = (k: CommandKvType, on: boolean) => set({ kvTypes: on ? [...form.kvTypes, k] : form.kvTypes.filter((x) => x !== k) });
  const steps = (field: 'before' | 'after', placeholder: string) => (
    <Field label={t(`engines.custom.dialog.${field}`)} hint={hint(field, t(`engines.custom.dialog.${field}Hint`))}>
      {({ id, describedBy }) => (
        <Textarea
          id={id}
          aria-describedby={describedBy}
          aria-invalid={problem(field) ? true : undefined}
          value={form[field]}
          placeholder={placeholder}
          onChange={(e) => set({ [field]: e.target.value })}
          className="min-h-14 font-mono text-xs"
          spellCheck={false}
        />
      )}
    </Field>
  );

  return (
    <div className="grid gap-x-6 gap-y-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-fg">{t('engines.custom.dialog.examples')}</p>
          <div className="flex flex-wrap gap-2">
            {COMMAND_EXAMPLES.map((e) => (
              <Button key={e.id} size="sm" onClick={() => set(withExample(form, e))}>
                {t(`engines.custom.dialog.examplesList.${e.id}`)}
              </Button>
            ))}
          </div>
        </div>

        <Field label={t('engines.custom.dialog.template')} hint={hint('template', t('engines.custom.dialog.templateHint', { port: '{port}' }))}>
          {({ id, describedBy }) => (
            <Textarea
              id={id}
              aria-describedby={describedBy}
              aria-invalid={problem('template') ? true : undefined}
              value={form.template}
              maxLength={4000}
              placeholder="python -m my_server --model {model} --port {port}"
              onChange={(e) => set({ template: e.target.value })}
              className="min-h-20 font-mono text-xs"
              spellCheck={false}
            />
          )}
        </Field>

        {kv && (
          <fieldset className="flex flex-col gap-2" aria-describedby="kv-types-hint">
            <legend className="mb-1 text-sm font-medium text-fg">{t('engines.custom.dialog.kvTypes', { kv: '{kv}' })}</legend>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {COMMAND_KV_TYPES.map((k) => (
                <label key={k} className="flex items-center gap-2 font-mono text-sm text-fg">
                  <Checkbox checked={form.kvTypes.includes(k)} onCheckedChange={(v) => toggleKv(k, v === true)} />
                  {k}
                </label>
              ))}
            </div>
            <p id="kv-types-hint" className="text-xs text-fg-3">
              {hint('kvTypes', t('engines.custom.dialog.kvTypesHint'))}
            </p>
          </fieldset>
        )}

        <div className="flex flex-col gap-1.5">
          <SegmentedControl<'completions' | 'chat'>
            label={t('engines.custom.dialog.api')}
            value={form.api}
            onValueChange={(api) => set({ api })}
            size="sm"
            options={[
              { value: 'completions', label: t('engines.custom.dialog.apiCompletions') },
              { value: 'chat', label: t('engines.custom.dialog.apiChat') },
            ]}
          />
          <p className="text-xs text-fg-3">{t('engines.custom.dialog.apiHint')}</p>
        </div>

        {showSteps ? (
          <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-3">
            <legend className="px-1 text-sm font-medium text-fg">{t('engines.custom.dialog.stepsTitle')}</legend>
            {steps('before', 'python prepare.py --model {model}')}
            {steps('after', 'python cleanup.py')}
            <p className="text-xs text-fg-3">{t('engines.custom.dialog.stepsNote')}</p>
          </fieldset>
        ) : (
          <Button size="sm" variant="ghost" className="self-start" onClick={() => setStepsOpen(true)}>
            {t('engines.custom.dialog.stepsAdd')}
          </Button>
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-3 md:sticky md:top-0 md:self-start">
        {preview !== undefined ? (
          <CodeBlock single label={t('engines.custom.dialog.preview')} commands={{ powershell: preview, bash: preview }} />
        ) : (
          <p className="rounded-lg border border-dashed border-border-strong px-3 py-4 text-sm text-fg-3">{t('engines.custom.dialog.previewEmpty')}</p>
        )}
        <p className="text-xs text-fg-3">{t('engines.custom.dialog.previewHint')}</p>
        {aside}
        {commands.template !== '' && (
          <ul className="flex flex-col gap-1 text-sm text-fg-2">
            <li>
              {settings.length
                ? t('engines.custom.dialog.settingsUsed', { list: settings.map((s) => settingLabel(t, s)).join(', ') })
                : t('engines.custom.dialog.settingsNone', { ctx: '{ctx}', kv: '{kv}', parallel: '{parallel}' })}
            </li>
            <li>{commandTuneProblem(commands) === undefined ? t('engines.custom.dialog.tuneYes', { ctx: '{ctx}' }) : t('engines.custom.dialog.tuneNo', { ctx: '{ctx}' })}</li>
          </ul>
        )}
        <details className="rounded-lg border border-border px-3 py-2 text-xs">
          <summary className="cursor-pointer rounded-xs text-sm font-medium text-fg select-none focus-ring">{t('engines.custom.dialog.placeholdersTitle')}</summary>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            {COMMAND_PLACEHOLDERS.map((ph) => (
              <div key={ph} className="contents">
                <dt className="font-mono text-fg">{`{${ph}}`}</dt>
                <dd className="text-fg-2">{t(`engines.custom.dialog.placeholders.${ph}`)}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-fg-3">{t('engines.custom.dialog.aliasTip', { alias: '{alias}' })}</p>
        </details>
      </div>
    </div>
  );
}
