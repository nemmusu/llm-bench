import { FolderOpen } from 'lucide-react';
import type { ReactNode } from 'react';
import { isDockerKind, type ApiFlavor, type EngineKind } from '../../../contract/engines';
import { useI18n } from '../../i18n';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Checkbox } from '../ui/checkbox';
import { Field, Input, Textarea } from '../ui/input';
import { Select } from '../ui/select';
import type { EngineField, EngineForm } from './engine-form';
import type { ParamsField, ParamsForm, ScenarioField, ScenarioForm } from './expert-form';
import { engineFamily } from './model-options';

export interface ExpertPanelProps {
  engine: EngineKind;
  engineForm: EngineForm;
  engineInvalid: readonly EngineField[];
  onEngine: (patch: Partial<EngineForm>) => void;
  params: ParamsForm;
  paramsInvalid: readonly ParamsField[];
  onParams: (patch: Partial<ParamsForm>) => void;
  custom: boolean;
  scenario: ScenarioForm;
  scenarioInvalid: readonly ScenarioField[];
  onScenario: (patch: Partial<ScenarioForm>) => void;
  /** Image used when the field is empty (from the engine status). */
  defaultImage: string | undefined;
  /** A custom engine is chosen: its executable / image / command are set on the Engines page. */
  customEngine?: string | undefined;
}

interface TextProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string | undefined;
  hint?: ReactNode;
  invalid?: boolean;
  mono?: boolean;
  type?: 'text' | 'password' | 'url';
  inputMode?: 'numeric' | 'decimal' | 'text';
}

function Text({ label, value, onChange, placeholder, hint, invalid, mono, type = 'text', inputMode }: TextProps) {
  const { t } = useI18n();
  return (
    <Field label={label} hint={invalid ? <span className="text-danger-text">{t('benchmark.expert.invalid')}</span> : hint}>
      {({ id, describedBy }) => (
        <Input
          id={id}
          type={type}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className={mono ? 'font-mono text-xs' : 'tabular-nums'}
          {...(inputMode ? { inputMode } : {})}
          autoComplete="off"
          spellCheck={false}
        />
      )}
    </Field>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-4">
      <legend className="mb-3 text-xs font-semibold tracking-wide text-fg-3 uppercase">{title}</legend>
      {children}
    </fieldset>
  );
}

/** Every launch parameter, the engine's executable/image/endpoint and the custom test plan. Empty = automatic. */
export function ExpertPanel(p: ExpertPanelProps) {
  const { t } = useI18n();
  const family = engineFamily(p.engine);
  const bad = (f: ParamsField) => p.paramsInvalid.includes(f);
  const num = (field: ParamsField & keyof ParamsForm, label: string, placeholder: string) => (
    <Text label={label} value={p.params[field] as string} onChange={(v) => p.onParams({ [field]: v })} placeholder={placeholder} invalid={bad(field)} inputMode="numeric" />
  );
  const sc = (field: Exclude<ScenarioField, 'llamaBench'>, label: string, placeholder: string, hint?: string) => (
    <Text
      label={label}
      value={p.scenario[field]}
      onChange={(v) => p.onScenario({ [field]: v })}
      placeholder={placeholder}
      invalid={p.scenarioInvalid.includes(field)}
      {...(hint ? { hint } : {})}
    />
  );

  return (
    <Card className="flex flex-col">
      <div className="flex flex-col gap-1 px-card pt-card">
        <h2 className="text-md font-semibold tracking-[-0.01em]">{t('benchmark.expert.title')}</h2>
        <p className="text-sm text-fg-2">{t('benchmark.expert.description')}</p>
      </div>
      <div className="grid gap-x-8 gap-y-6 p-card lg:grid-cols-2">
        {family === 'external' ? (
          <Section title={t('benchmark.expert.sectionEndpoint')}>
            <Text
              label={t('benchmark.expert.baseUrl')}
              value={p.engineForm.baseUrl}
              onChange={(v) => p.onEngine({ baseUrl: v })}
              placeholder="http://127.0.0.1:8080"
              hint={t('benchmark.expert.baseUrlHint')}
              invalid={p.engineInvalid.includes('baseUrl') && p.engineForm.baseUrl !== ''}
              type="url"
              mono
            />
            <Text
              label={t('benchmark.expert.modelName')}
              value={p.engineForm.modelName}
              onChange={(v) => p.onEngine({ modelName: v })}
              placeholder="qwen3-8b"
              hint={t('benchmark.expert.modelNameHint')}
              mono
            />
            <Text
              label={t('benchmark.expert.apiKey')}
              value={p.engineForm.apiKey}
              onChange={(v) => p.onEngine({ apiKey: v })}
              hint={t('benchmark.expert.apiKeyHint')}
              type="password"
              mono
            />
            <Field label={t('benchmark.expert.flavor')} hint={t('benchmark.expert.flavorHint')}>
              {({ id, describedBy }) => (
                <Select<ApiFlavor>
                  id={id}
                  // The field has a hint, so it is always described.
                  aria-describedby={describedBy!}
                  value={p.engineForm.flavor}
                  onValueChange={(v) => p.onEngine({ flavor: v })}
                  options={[
                    { value: 'openai', label: t('benchmark.expert.flavors.openai') },
                    { value: 'llamacpp', label: 'llama.cpp' },
                    { value: 'vllm', label: 'vLLM' },
                  ]}
                />
              )}
            </Field>
          </Section>
        ) : (
          <Section title={t('benchmark.expert.sectionLaunch')}>
            <div className="grid grid-cols-2 gap-4">
              {family === 'llamacpp' ? (
                <>
                  {num('contextSize', t('benchmark.expert.ctx'), t('common.auto'))}
                  {num('gpuLayers', t('benchmark.expert.ngl'), t('benchmark.expert.nglAll'))}
                  <Field label={t('benchmark.expert.flashAttention')}>
                    {({ id }) => (
                      <Select<ParamsForm['flashAttention']>
                        id={id}
                        value={p.params.flashAttention}
                        onValueChange={(v) => p.onParams({ flashAttention: v })}
                        options={[
                          { value: 'default', label: t('common.auto') },
                          { value: 'on', label: t('common.on') },
                          { value: 'off', label: t('common.off') },
                        ]}
                      />
                    )}
                  </Field>
                  <Field label={t('benchmark.expert.kvCache')}>
                    {({ id }) => (
                      <Select<ParamsForm['kvCacheType']>
                        id={id}
                        value={p.params.kvCacheType}
                        onValueChange={(v) => p.onParams({ kvCacheType: v })}
                        options={[
                          { value: 'default', label: t('common.auto') },
                          { value: 'f16', label: 'f16' },
                          { value: 'q8_0', label: 'q8_0' },
                          { value: 'q4_0', label: 'q4_0' },
                        ]}
                      />
                    )}
                  </Field>
                  {num('batchSize', t('benchmark.expert.batch'), '2048')}
                  {num('ubatchSize', t('benchmark.expert.ubatch'), '512')}
                  {num('threads', t('benchmark.expert.threads'), t('common.auto'))}
                  {num('parallel', t('benchmark.expert.parallel'), t('common.auto'))}
                </>
              ) : (
                <>
                  {num('maxModelLen', t('benchmark.expert.maxModelLen'), t('common.auto'))}
                  <Text
                    label={t('benchmark.expert.gpuMemory')}
                    value={p.params.gpuMemoryUtilization}
                    onChange={(v) => p.onParams({ gpuMemoryUtilization: v })}
                    placeholder="0,90"
                    hint={t('benchmark.expert.gpuMemoryHint')}
                    invalid={bad('gpuMemoryUtilization')}
                    inputMode="decimal"
                  />
                  {num('parallel', t('benchmark.expert.maxSeqs'), t('common.auto'))}
                  <Text label={t('benchmark.expert.dtype')} value={p.params.dtype} onChange={(v) => p.onParams({ dtype: v })} placeholder="auto" mono />
                  <Text
                    label={t('benchmark.expert.quantization')}
                    value={p.params.quantization}
                    onChange={(v) => p.onParams({ quantization: v })}
                    placeholder={t('common.auto')}
                    mono
                  />
                </>
              )}
            </div>
            {p.customEngine !== undefined && <p className="text-sm text-fg-2">{t('engines.custom.expertNote', { name: p.customEngine })}</p>}
            {p.customEngine === undefined && p.engine === 'llamacpp-native' && (
              <Field label={t('benchmark.expert.executable')} hint={t('benchmark.expert.executableHint')}>
                {({ id, describedBy }) => (
                  <div className="flex gap-2">
                    <Input
                      id={id}
                      aria-describedby={describedBy}
                      value={p.engineForm.executable}
                      placeholder="llama-server"
                      onChange={(e) => p.onEngine({ executable: e.target.value })}
                      className="font-mono text-xs"
                      spellCheck={false}
                    />
                    {window.gpubench && (
                      <Button
                        onClick={() =>
                          void window.gpubench!.pickFile({ title: t('benchmark.expert.executable') }).then((path) => {
                            if (path) p.onEngine({ executable: path });
                          })
                        }
                      >
                        <FolderOpen aria-hidden />
                        {t('common.browse')}
                      </Button>
                    )}
                  </div>
                )}
              </Field>
            )}
            {p.customEngine === undefined && isDockerKind(p.engine) && (
              <Text
                label={t('benchmark.expert.dockerImage')}
                value={p.engineForm.image}
                onChange={(v) => p.onEngine({ image: v })}
                placeholder={p.defaultImage}
                hint={t('benchmark.expert.dockerImageHint')}
                mono
              />
            )}
            {p.customEngine === undefined && p.engine === 'vllm-native' && (
              <Text
                label={t('benchmark.expert.vllmPath')}
                value={p.engineForm.vllmPath}
                onChange={(v) => p.onEngine({ vllmPath: v })}
                placeholder="vllm"
                hint={t('benchmark.expert.vllmPathHint')}
                mono
              />
            )}
            {p.customEngine === undefined && p.engine === 'sglang-native' && (
              <Text
                label={t('benchmark.expert.sglangPath')}
                value={p.engineForm.sglangPath}
                onChange={(v) => p.onEngine({ sglangPath: v })}
                placeholder="python"
                hint={t('benchmark.expert.sglangPathHint')}
                mono
              />
            )}
          </Section>
        )}

        <Section title={t('benchmark.expert.sectionTest')}>
          {p.custom ? (
            <div className="grid grid-cols-2 gap-4">
              {sc('coldReps', t('benchmark.expert.coldReps'), '1')}
              {sc('warmReps', t('benchmark.expert.warmReps'), '3')}
              {sc('promptTokens', t('benchmark.expert.promptLengths'), '512, 4096', t('benchmark.expert.listHint'))}
              {sc('outputTokens', t('benchmark.expert.outputTokens'), '256')}
              {sc('warmup', t('benchmark.expert.warmup'), '1')}
              {sc('reps', t('benchmark.expert.repetitions'), '5')}
              {sc('concurrency', t('benchmark.expert.concurrency'), '4', t('benchmark.expert.usersHint'))}
              {sc('requestsPerWorker', t('benchmark.expert.requestsPerWorker'), '4')}
              <div className="col-span-2">{sc('sessions', t('benchmark.expert.sessions'), '2', t('benchmark.expert.sessionsHint'))}</div>
              {sc('sessionsDepth', t('benchmark.expert.sessionsDepth'), t('common.auto'), t('benchmark.expert.sessionsDepthHint'))}
              {sc('sessionsTurns', t('benchmark.expert.sessionsTurns'), '4', t('benchmark.expert.sessionsTurnsHint'))}
              <label className="col-span-2 flex items-center gap-2.5 text-sm font-medium text-fg">
                <Checkbox checked={p.scenario.llamaBench} onCheckedChange={(v) => p.onScenario({ llamaBench: v === true })} />
                {t('benchmark.expert.llamaBench')}
              </label>
            </div>
          ) : (
            <p className="rounded-lg border border-dashed border-border-strong px-4 py-3 text-sm text-fg-2">{t('benchmark.expert.customHint')}</p>
          )}
        </Section>

        {family !== 'external' && (
          <>
            <Field
              label={t('benchmark.expert.extraArgs')}
              hint={t('benchmark.expert.extraArgsHint')}
            >
              {({ id, describedBy }) => (
                <Textarea
                  id={id}
                  aria-describedby={describedBy}
                  value={p.params.extraArgs}
                  placeholder="--mlock"
                  onChange={(e) => p.onParams({ extraArgs: e.target.value })}
                  className="font-mono text-xs"
                  spellCheck={false}
                />
              )}
            </Field>
            <Field
              label={t('benchmark.expert.env')}
              hint={bad('env') ? <span className="text-danger-text">{t('benchmark.expert.envInvalid')}</span> : t('benchmark.expert.envHint')}
            >
              {({ id, describedBy }) => (
                <Textarea
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={bad('env') || undefined}
                  value={p.params.env}
                  placeholder="CUDA_VISIBLE_DEVICES=0"
                  onChange={(e) => p.onParams({ env: e.target.value })}
                  className="font-mono text-xs"
                  spellCheck={false}
                />
              )}
            </Field>
          </>
        )}
      </div>
    </Card>
  );
}
