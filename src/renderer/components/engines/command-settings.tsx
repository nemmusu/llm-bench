/**
 * The LLM Bench settings of a program with an OpenAI API, as the Benchmark's expert mode and "Avvia un
 * server" ask for them: only those whose placeholder its commands use ({ctx}, {kv}, {parallel},
 * {gpuLayers}, {batch}, {ubatch}), with their usual names, each saying where it goes. Nothing else of an
 * engine's launch applies to it (flash attention, memory share, YaRN…): it is not shown.
 */
import { commandKvTypes, commandSettings, type CommandRun, type CommandSetting } from '../../../contract/custom-engines';
import { useI18n, type Formatters } from '../../i18n';
import type { ParamsField, ParamsForm } from '../bench/expert-form';
import { Field, Input, Textarea } from '../ui/input';
import { Select } from '../ui/select';

/** The form field each setting is typed in. */
const FIELDS: Record<CommandSetting, ParamsField> = {
  ctx: 'contextSize',
  kv: 'kvCacheType',
  parallel: 'parallel',
  gpuLayers: 'gpuLayers',
  batch: 'batchSize',
  ubatch: 'ubatchSize',
};

/** A setting's usual name ("Contesto (token)", "Tipo di cache KV"…). */
export function settingLabel(t: Formatters['t'], s: CommandSetting): string {
  const keys = { ctx: 'ctx', kv: 'kvCache', parallel: 'parallel', gpuLayers: 'ngl', batch: 'batch', ubatch: 'ubatch' } as const;
  return t(`benchmark.expert.${keys[s]}`);
}

export interface CommandSettingsFieldsProps {
  run: Pick<CommandRun, 'template' | 'before' | 'after' | 'kvTypes'>;
  form: ParamsForm;
  invalid: readonly ParamsField[];
  onForm: (patch: Partial<ParamsForm>) => void;
}

/** One field per setting the commands take; empty = LLM Bench decides (the context for the test, every layer…). */
export function CommandSettingsFields({ run, form, invalid, onForm }: CommandSettingsFieldsProps) {
  const { t } = useI18n();
  const kvTypes = commandKvTypes(run);
  const hint = (s: CommandSetting) =>
    invalid.includes(FIELDS[s]) ? <span className="text-danger-text">{t('benchmark.expert.invalid')}</span> : t('engines.custom.command.goesInto', { ph: `{${s}}` });
  const num = (s: Exclude<CommandSetting, 'kv' | 'ctx'>, placeholder: string) => {
    const field = FIELDS[s] as 'parallel' | 'gpuLayers' | 'batchSize' | 'ubatchSize';
    return (
      <Field key={s} label={settingLabel(t, s)} hint={hint(s)}>
        {({ id, describedBy }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            aria-invalid={invalid.includes(field) || undefined}
            value={form[field]}
            placeholder={placeholder}
            inputMode="numeric"
            onChange={(e) => onForm({ [field]: e.target.value })}
            className="tabular-nums"
            autoComplete="off"
          />
        )}
      </Field>
    );
  };
  return (
    <div className="grid grid-cols-2 gap-4">
      {commandSettings(run).map((s) => {
        if (s === 'ctx') {
          return (
            <Field key={s} label={settingLabel(t, s)} hint={hint(s)}>
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid.includes('contextSize') || undefined}
                  // A context typed for another engine (its own field, YaRN) is the one sent: shown here.
                  value={form.yarnTarget || form.contextSize || form.maxModelLen}
                  placeholder={t('common.auto')}
                  inputMode="numeric"
                  onChange={(e) => onForm({ contextSize: e.target.value, maxModelLen: '', yarnTarget: '', yarnOriginal: '' })}
                  className="tabular-nums"
                  autoComplete="off"
                />
              )}
            </Field>
          );
        }
        if (s === 'kv') {
          // A type this program does not take (chosen for another engine) counts as automatic.
          const value = (kvTypes as string[]).includes(form.kvCacheType) ? form.kvCacheType : 'default';
          return (
            <Field key={s} label={settingLabel(t, s)} hint={hint(s)}>
              {({ id, describedBy }) => (
                <Select<ParamsForm['kvCacheType']>
                  id={id}
                  // The field has a hint, so it is always described.
                  aria-describedby={describedBy!}
                  value={value}
                  onValueChange={(v) => onForm({ kvCacheType: v })}
                  options={[{ value: 'default', label: t('engines.custom.command.kvAuto', { kv: kvTypes[0] as string }) }, ...kvTypes.map((k) => ({ value: k, label: k }))]}
                />
              )}
            </Field>
          );
        }
        if (s === 'parallel') return num(s, t('common.auto'));
        if (s === 'gpuLayers') return num(s, t('benchmark.expert.nglAll'));
        return num(s, s === 'batch' ? '2048' : '512');
      })}
    </div>
  );
}

export interface CommandExpertSectionProps {
  /** The engine's name and commands. */
  name: string;
  run: CommandRun;
  params: ParamsForm;
  invalid: readonly ParamsField[];
  onParams: (patch: Partial<ParamsForm>) => void;
}

/** The Benchmark's expert mode on a program with an OpenAI API: its settings, extra arguments and environment. */
export function CommandExpertSection({ name, run, params, invalid, onParams }: CommandExpertSectionProps) {
  const { t } = useI18n();
  const any = commandSettings(run).length > 0;
  return (
    <fieldset className="flex min-w-0 flex-col gap-4">
      <legend className="mb-3 text-xs font-semibold tracking-wide text-fg-3 uppercase">{t('engines.custom.command.title', { name })}</legend>
      <p className="text-sm text-fg-2">{any ? t('engines.custom.command.intro') : t('engines.custom.command.none', { ctx: '{ctx}', kv: '{kv}', parallel: '{parallel}' })}</p>
      {any && <CommandSettingsFields run={run} form={params} invalid={invalid} onForm={onParams} />}
      <Field label={t('benchmark.expert.extraArgs')} hint={t('engines.custom.command.extraArgsHint')}>
        {({ id, describedBy }) => (
          <Textarea id={id} aria-describedby={describedBy} value={params.extraArgs} onChange={(e) => onParams({ extraArgs: e.target.value })} className="font-mono text-xs" spellCheck={false} />
        )}
      </Field>
      <Field label={t('benchmark.expert.env')} hint={invalid.includes('env') ? <span className="text-danger-text">{t('benchmark.expert.envInvalid')}</span> : t('engines.custom.command.envHint')}>
        {({ id, describedBy }) => (
          <Textarea
            id={id}
            aria-describedby={describedBy}
            aria-invalid={invalid.includes('env') || undefined}
            value={params.env}
            placeholder="CUDA_VISIBLE_DEVICES=0"
            onChange={(e) => onParams({ env: e.target.value })}
            className="font-mono text-xs"
            spellCheck={false}
          />
        )}
      </Field>
    </fieldset>
  );
}
