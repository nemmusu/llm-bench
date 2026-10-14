import { FolderOpen } from 'lucide-react';
import type { ReactNode } from 'react';
import type { CommandRun, MissingFlag } from '../../../contract/custom-engines';
import { engineBaseOf, isDockerKind, type EngineKind, type LaunchParams, type NinferParams } from '../../../contract/engines';
import { argGroups, mergeRecipeParams, type RecipePatch } from '../../../contract/recipes';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/cn';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Checkbox } from '../ui/checkbox';
import { Field, Input, Textarea } from '../ui/input';
import { SegmentedControl } from '../ui/segmented-control';
import { depthLabel } from '../tune/tune-format';
import type { EngineField, EngineForm } from './engine-form';
import { parseArgs, parseEnv, parseInteger, type ParamsField, type ParamsForm, type ScenarioField, type ScenarioForm } from './expert-form';
import { CommandExpertSection } from '../engines/command-settings';
import { ExternalFields } from './external-fields';
import { LaunchFields } from './launch-fields-panel';
import type { NinferSupport } from './ninfer-support';

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
  /** The model's trained context (YaRN), when known. */
  trainedContext?: number | undefined;
  /** The model's recipe in use: its values are shown, marked, where the user's would go. */
  recipe?: { name: string; patch: RecipePatch | undefined } | undefined;
  /** A custom engine is chosen: its executable / image / command are set on the Engines page. */
  customEngine?: string | undefined;
  /** The flags the chosen build lacks (a fork's check): those fields are disabled with the reason. */
  missing?: readonly MissingFlag[] | undefined;
  /** NInfer: what the model and build take. */
  ninfer?: NinferSupport | undefined;
  /** NInfer: the settings chosen in "Impostazioni di NInfer" (the empty fields take their values). */
  ninferPreset?: { name: string; params: Pick<LaunchParams, 'contextSize' | 'parallel'> & { ninfer: NinferParams } } | undefined;
  /** A program with an OpenAI API is chosen: only the settings its commands take (engines/command-settings.tsx). */
  command?: { name: string; run: CommandRun } | undefined;
  /** The -ctk values a llama.cpp fork lists (its check): its own types join the KV cache choices. */
  kvCacheTypes?: readonly string[] | undefined;
}

interface TextProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string | undefined;
  hint?: ReactNode;
  invalid?: boolean;
  mono?: boolean;
}

function Text({ label, value, onChange, placeholder, hint, invalid, mono }: TextProps) {
  const { t } = useI18n();
  return (
    <Field label={label} hint={invalid ? <span className="text-danger-text">{t('benchmark.expert.invalid')}</span> : hint}>
      {({ id, describedBy }) => (
        <Input
          id={id}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className={mono ? 'font-mono text-xs' : 'tabular-nums'}
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

/**
 * The recipe's arguments and variables before the user's own: each one marked when the user's replaces it
 * (the same flag in the extra arguments, the same variable).
 */
function RecipeExtras({ recipe, params }: { recipe: { name: string; patch: RecipePatch }; params: ParamsForm }) {
  const { t } = useI18n();
  const { overridden } = mergeRecipeParams({ extraArgs: parseArgs(params.extraArgs), env: parseEnv(params.env).env }, recipe.patch);
  const groups = argGroups(recipe.patch.args);
  const env = Object.entries(recipe.patch.env);
  if (!groups.length && !env.length) return null;
  const struck = (on: boolean) => (on ? 'text-fg-3 line-through' : 'text-fg');
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-accent/25 bg-accent-soft/40 px-3 py-2.5 text-xs @3xl/page:col-span-2" aria-label={t('recipes.expert.fromRecipe', { name: recipe.name })}>
      {groups.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-fg-2">{t('recipes.expert.recipeArgs', { name: recipe.name })}</span>
          <p className="flex flex-wrap gap-x-3 gap-y-1 font-mono">
            {groups.map((g, i) => {
              const replaced = overridden.includes(g[0] as string);
              return (
                <span key={`${g.join(' ')}-${i}`} className={struck(replaced)} {...(replaced ? { title: t('recipes.expert.replacedArg') } : {})}>
                  {g.join(' ')}
                </span>
              );
            })}
          </p>
        </div>
      )}
      {env.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-fg-2">{t('recipes.expert.recipeEnv', { name: recipe.name })}</span>
          <p className="flex flex-wrap gap-x-3 gap-y-1 font-mono">
            {env.map(([k, v]) => (
              <span key={k} className={struck(overridden.includes(`env:${k}`))}>
                {k}={v}
              </span>
            ))}
          </p>
        </div>
      )}
    </div>
  );
}

/** Every launch parameter, the engine's executable/image/endpoint and the custom test plan. Empty = automatic. */
export function ExpertPanel(p: ExpertPanelProps) {
  const f = useI18n();
  const { t, integer } = f;
  const recipe = p.recipe?.patch ? { name: p.recipe.name, patch: p.recipe.patch } : undefined;
  const recipeCtx = recipe?.patch.params.contextSize ?? recipe?.patch.params.maxModelLen;
  const yarnOn = p.params.yarnTarget.trim() !== '';
  const base = engineBaseOf(p.engine);
  const bad = (f: ParamsField) => p.paramsInvalid.includes(f);
  // The context field: the recipe's value as its placeholder, and a line when the user's replaces it.
  const ctxText = base === 'vllm' || base === 'sglang' ? p.params.maxModelLen : p.params.contextSize;
  const typedCtx = parseInteger(ctxText);
  const context =
    recipe !== undefined && recipeCtx !== undefined && !yarnOn
      ? {
          placeholder: t('recipes.expert.recipeValue', { value: integer(recipeCtx) }),
          hint: typedCtx !== null && typedCtx !== recipeCtx ? t('recipes.expert.replaced', { value: integer(recipeCtx) }) : t('recipes.expert.fromRecipe', { name: recipe.name }),
        }
      : undefined;
  const sc = (field: Exclude<ScenarioField, 'llamaBench' | 'concurrencyExact' | 'sessionsExact'>, label: string, placeholder: string, hint?: string) => (
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
      {/* Side by side only when there is a custom plan to fill; otherwise the settings take the whole width. */}
      <div className={cn('grid grid-cols-1 gap-x-8 gap-y-6 p-card', p.custom && '@7xl/page:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]')}>
        {p.command ? (
          <CommandExpertSection {...p.command} params={p.params} invalid={p.paramsInvalid} onParams={p.onParams} />
        ) : base === 'external' ? (
          // An external server (a program of the user's own always comes with its commands, above).
          <Section title={t('benchmark.expert.sectionEndpoint')}>
            <ExternalFields engineForm={p.engineForm} engineInvalid={p.engineInvalid} onEngine={p.onEngine} />
          </Section>
        ) : (
          <Section title={t('benchmark.expert.sectionLaunch')}>
            <LaunchFields
              base={base}
              form={p.params}
              invalid={p.paramsInvalid}
              onForm={p.onParams}
              use="test"
              missing={p.missing}
              ninfer={p.ninfer}
              kvCacheTypes={p.kvCacheTypes}
              preset={p.ninferPreset}
              context={context}
              trainedContext={p.trainedContext}
            />
            {recipe?.patch.params.ropeScaling && !yarnOn && (
              <p className="-mt-2 text-xs text-accent-text">
                {t('recipes.expert.fromRecipe', { name: recipe.name })}: {recipeCtx !== undefined ? t('recipes.parts.yarn', { ctx: depthLabel(recipeCtx, f) }) : t('recipes.parts.ropeOnly', { factor: f.number(recipe.patch.params.ropeScaling.factor, 2) })}
              </p>
            )}
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
            <div className="grid gap-4 sm:grid-cols-2">
              {sc('coldReps', t('benchmark.expert.coldReps'), '1')}
              {sc('warmReps', t('benchmark.expert.warmReps'), '3')}
              {sc('promptTokens', t('benchmark.expert.promptLengths'), '512, 4096', t('benchmark.expert.listHint'))}
              {sc('outputTokens', t('benchmark.expert.outputTokens'), '256')}
              {sc('warmup', t('benchmark.expert.warmup'), '1')}
              {sc('reps', t('benchmark.expert.repetitions'), '5')}
              <UsersField which="concurrency" scenario={p.scenario} invalid={p.scenarioInvalid.includes('concurrency')} onScenario={p.onScenario} />
              {sc('requestsPerWorker', t('benchmark.expert.requestsPerWorker'), '4')}
              <div className="sm:col-span-2">
                <UsersField which="sessions" scenario={p.scenario} invalid={p.scenarioInvalid.includes('sessions')} onScenario={p.onScenario} />
              </div>
              {sc('sessionsDepth', t('benchmark.expert.sessionsDepth'), t('common.auto'), t('benchmark.expert.sessionsDepthHint'))}
              {sc('sessionsTurns', t('benchmark.expert.sessionsTurns'), '4', t('benchmark.expert.sessionsTurnsHint'))}
              {/* llama-bench is llama.cpp's own tool: only offered there. */}
              {base === 'llamacpp' && (
                <label className="flex items-center gap-2.5 text-sm font-medium text-fg sm:col-span-2">
                  <Checkbox checked={p.scenario.llamaBench} onCheckedChange={(v) => p.onScenario({ llamaBench: v === true })} />
                  {t('benchmark.expert.llamaBench')}
                </label>
              )}
            </div>
          ) : (
            <p className="rounded-lg border border-dashed border-border-strong px-4 py-3 text-sm text-fg-2">{t('benchmark.expert.customHint')}</p>
          )}
        </Section>

        {base !== 'external' && (
          <div className={cn('grid grid-cols-1 gap-x-8 gap-y-6 @3xl/page:grid-cols-2', p.custom && '@7xl/page:col-span-2')}>
            {recipe && <RecipeExtras recipe={recipe} params={p.params} />}
            <Field label={t('benchmark.expert.extraArgs')} hint={t('benchmark.expert.extraArgsHint')}>
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
          </div>
        )}
      </div>
    </Card>
  );
}

/**
 * "Utenti contemporanei" / "Conversazioni lunghe insieme": a number, and whether it means every step from 1
 * up to it or only that many at once ("Solo 2 utenti insieme"); a list (1, 4, 8) is taken as written.
 */
function UsersField({ which, scenario, invalid, onScenario }: { which: 'concurrency' | 'sessions'; scenario: ScenarioForm; invalid: boolean; onScenario: (patch: Partial<ScenarioForm>) => void }) {
  const { t } = useI18n();
  const text = scenario[which];
  const exactKey = which === 'concurrency' ? 'concurrencyExact' : 'sessionsExact';
  const n = parseInteger(text.trim());
  const label = t(which === 'concurrency' ? 'benchmark.expert.concurrency' : 'benchmark.expert.sessions');
  return (
    <div className="flex flex-col gap-2">
      <Text
        label={label}
        value={text}
        onChange={(v) => onScenario({ [which]: v })}
        placeholder={which === 'concurrency' ? '4' : '2'}
        invalid={invalid}
        hint={t(which === 'concurrency' ? 'benchmark.expert.usersHint' : 'benchmark.expert.sessionsHint')}
      />
      {/* One number above 1: from 1 up to it, or only that many at once. */}
      {n !== null && n > 1 && (
        <SegmentedControl<'upTo' | 'exact'>
          size="sm"
          label={t(`benchmark.expert.usersMode.${which}`)}
          value={scenario[exactKey] ? 'exact' : 'upTo'}
          onValueChange={(v) => onScenario({ [exactKey]: v === 'exact' })}
          options={[
            { value: 'upTo', label: t('benchmark.expert.usersUpTo', { n }) },
            { value: 'exact', label: t(which === 'concurrency' ? 'benchmark.expert.usersExact' : 'benchmark.expert.sessionsExact', { n }) },
          ]}
        />
      )}
    </div>
  );
}