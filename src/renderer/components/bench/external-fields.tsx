/**
 * "Server esterno" in the expert panel: an OpenAI server LLM Bench only talks to (address, model name,
 * key, server type). Its own component, so the expert panel only decides which engine's fields to show:
 * an external server or a command template has no launch settings of LLM Bench's (launch-fields.ts).
 */
import type { ApiFlavor } from '../../../contract/engines';
import { useI18n } from '../../i18n';
import { Field, Input } from '../ui/input';
import { Select } from '../ui/select';
import type { EngineField, EngineForm } from './engine-form';

export interface ExternalFieldsProps {
  engineForm: EngineForm;
  engineInvalid: readonly EngineField[];
  onEngine: (patch: Partial<EngineForm>) => void;
}

export function ExternalFields({ engineForm, engineInvalid, onEngine }: ExternalFieldsProps) {
  const { t } = useI18n();
  const text = (field: 'baseUrl' | 'modelName' | 'apiKey', placeholder: string | undefined, type: 'url' | 'text' | 'password', invalid = false) => (
    <Field label={t(`benchmark.expert.${field}`)} hint={invalid ? <span className="text-danger-text">{t('benchmark.expert.invalid')}</span> : t(`benchmark.expert.${field}Hint`)}>
      {({ id, describedBy }) => (
        <Input
          id={id}
          type={type}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          value={engineForm[field]}
          placeholder={placeholder}
          onChange={(e) => onEngine({ [field]: e.target.value })}
          className="font-mono text-xs"
          autoComplete="off"
          spellCheck={false}
        />
      )}
    </Field>
  );
  return (
    <>
      {text('baseUrl', 'http://127.0.0.1:8080', 'url', engineInvalid.includes('baseUrl') && engineForm.baseUrl !== '')}
      {text('modelName', 'qwen3-8b', 'text')}
      {text('apiKey', undefined, 'password')}
      <Field label={t('benchmark.expert.flavor')} hint={t('benchmark.expert.flavorHint')}>
        {({ id, describedBy }) => (
          <Select<ApiFlavor>
            id={id}
            // The field has a hint, so it is always described.
            aria-describedby={describedBy!}
            value={engineForm.flavor}
            onValueChange={(v) => onEngine({ flavor: v })}
            options={[
              { value: 'openai', label: t('benchmark.expert.flavors.openai') },
              { value: 'llamacpp', label: 'llama.cpp' },
              { value: 'vllm', label: 'vLLM' },
            ]}
          />
        )}
      </Field>
    </>
  );
}
