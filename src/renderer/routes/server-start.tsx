/**
 * "Avvia un server": the one way to start a server. Model, engine (built-in, forks, command
 * templates), where the settings come from (your tests, your presets, custom commands), port and
 * network; the exact plan is always visible on the side, with "Avvia" and "Salva come preset".
 * Other pages open it with their choices made (server-flow.ts ServerDraft).
 */
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import type { StartServerRequest } from '../../contract/api';
import { customEngineConfigOf, customEngineForModel } from '../../contract/custom-engines';
import type { EngineConfig } from '../../contract/engines';
import { ninferPresetOf, ninferPresetsFor } from '../../contract/ninfer';
import type { ServerNetwork, ServerPresetInput } from '../../contract/servers';
import { formFromParams, paramsFromForm, type ParamsForm } from '../components/bench/expert-form';
import { MIB_PER_GB } from '../components/bench/format';
import { needsFromPlan } from '../components/bench/needs';
import { presetOf } from '../components/bench/rerun';
import { useStartFlow } from '../components/bench/start-flow';
import { sourceFor } from '../components/configs/depths';
import { serverNinfer, withNinferPreset, type NinferChoice } from '../components/engines/ninfer-format';
import { NinferPresetPicker } from '../components/engines/ninfer-presets';
import { NinferAllCallout, useNinferAllNeed, withNinferAll } from '../components/engines/ninfer-all-note';
import { engineNameOf } from '../components/servers/engine-name';
import { RecipeChip } from '../components/recipes/recipe-chip';
import { targetOfOption } from '../components/recipes/recipe-model';
import { useModelRecipe } from '../components/recipes/use-model-recipe';
import { SavePresetDialog } from '../components/servers/save-preset-dialog';
import {
  engineChoices,
  engineKeyOf,
  optionFor,
  optionFormat,
  optionModel,
  parsePort,
  presetsForModel,
  serverModelOptions,
  serverRequest,
  presetSource,
  takeServerDraft,
  testedConfigs,
} from '../components/servers/server-flow';
import { EngineStep } from '../components/servers/start/engine-step';
import { ModelStep } from '../components/servers/start/model-step';
import { NetworkStep } from '../components/servers/start/network-step';
import { SettingsStep, type SettingsTab } from '../components/servers/start/settings-step';
import { Summary } from '../components/servers/start/summary';
import { Page } from '../components/shell/page';
import { Card } from '../components/ui/card';
import { HelpTip } from '../components/ui/help-tip';
import { useI18n } from '../i18n';
import { useConfigs } from '../lib/queries-configs';
import { apiErrorData, useBenchEngines, useBenchLocalModels, useBenchSystem, useCurated, useDebounced, useRun } from '../lib/queries-runs';
import { useCustomEngines } from '../lib/queries-engines';
import { usePresetMutations, useServerPlan, useServerPresets, useServersLiveRefresh } from '../lib/queries-servers';

function StepCard({ step, title, help, children }: { step: number; title: string; help: string; children: ReactNode }) {
  return (
    <Card className="flex min-w-0 flex-col">
      <div className="flex items-center gap-2.5 px-card pt-card">
        <span aria-hidden className="grid size-6 place-items-center rounded-full bg-accent-soft text-xs font-semibold text-accent-text">
          {step}
        </span>
        <h2 className="text-md font-semibold tracking-[-0.01em]">{title}</h2>
        <HelpTip term={title}>{help}</HelpTip>
      </div>
      <div className="flex flex-1 flex-col gap-3 px-card pt-4 pb-card">{children}</div>
    </Card>
  );
}

/** A request as text (the plan query is debounced on it). */
const keyOf = (r: StartServerRequest | undefined) => (r ? JSON.stringify(r) : '');

export function ServerStartPage() {
  const f = useI18n();
  const { t } = f;
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [draft] = useState(() => takeServerDraft(qc));
  useServersLiveRefresh();
  const local = useBenchLocalModels();
  const system = useBenchSystem();
  const engines = useBenchEngines();
  const customList = useCustomEngines().data ?? [];
  const presets = useServerPresets();
  const configs = useConfigs({});
  const gpu = system.data?.gpus[0];
  const curated = useCurated(gpu ? gpu.memoryTotalMiB / MIB_PER_GB : undefined);
  const flow = useStartFlow();
  const { create, update } = usePresetMutations();
  const editing = draft?.presetId !== undefined ? presets.data?.find((p) => p.id === draft.presetId) : undefined;

  // 1. The model.
  const options = useMemo(() => serverModelOptions(local.data ?? [], curated.data?.models ?? [], draft?.hub), [local.data, curated.data, draft?.hub]);
  const [modelKey, setModelKey] = useState<string | undefined>(undefined);
  const option = options.find((o) => o.key === modelKey) ?? optionFor(options, draft?.model) ?? options.find((o) => o.source === 'local') ?? options[0];
  const format = option ? optionFormat(option) : 'gguf';

  // "Comandi per questo modello": the model's recipe (the core applies it unless it is turned off here).
  const recipeTarget = option ? targetOfOption(option) : undefined;
  const recipe = useModelRecipe(recipeTarget);
  const [recipeOn, setRecipeOn] = useState(!draft?.recipeOff);

  // 2. The engine: the user's pick, the one handed over (a test's, a preset's), the recipe's, a suggested one, a
  //    custom engine whose rules are for this model (NInfer-all for a GGUF-NInfer artifact), else the first usable
  //    one for the model's files.
  const choices = engineChoices(format, engines.data ?? [], customList, system.data?.os.platform ?? 'win32');
  const forModel = option?.source === 'local' ? customEngineForModel(customList.map((c) => c.engine), option.local.identity) : undefined;
  const [engineKey, setEngineKey] = useState<string | undefined>(undefined);
  const choiceOf = (config: EngineConfig | undefined) => (config ? choices.find((c) => c.key === engineKeyOf(config) && !c.disabled) : undefined);
  const engineChoice =
    choices.find((c) => c.key === engineKey) ??
    choiceOf(draft?.engine) ??
    (recipeOn ? choiceOf(recipe.engine) : undefined) ??
    choiceOf(draft?.suggestedEngine) ??
    choiceOf(forModel ? customEngineConfigOf(forModel) : undefined) ??
    choices.find((c) => !c.disabled);
  // A handed-over engine keeps its own executable or image (a test's custom build, the llama.cpp used last).
  const handed = [draft?.engine, draft?.suggestedEngine].find((e) => e !== undefined && engineKeyOf(e) === engineChoice?.key);
  const engine = handed ?? engineChoice?.config;
  const engineName = engineChoice ? engineNameOf(engineChoice.config, customList, f) : '';

  // 3. The settings.
  // A preset to change, or NInfer settings handed over (the Benchmark's NInfer preset): "I tuoi preset"; other
  // settings of the Benchmark's expert mode: "Comandi personalizzati"; a test's settings or nothing: "Le migliori".
  const draftNinfer = draft?.params?.ninfer;
  const [tab, setTab] = useState<SettingsTab>(
    draft?.presetId !== undefined || (draftNinfer && !draft!.provenance) ? 'presets' : draft?.params && !draft.provenance ? 'custom' : 'best',
  );
  const [best, setBest] = useState(draft?.provenance ? 'draft' : 'auto');
  const [presetId, setPresetId] = useState<string | undefined>(draft?.presetId);
  const [form, setForm] = useState<ParamsForm>(() => formFromParams(draft?.params));
  const [formTouched, setFormTouched] = useState(draft?.params !== undefined && !draft.provenance);

  // 4. Port and network (a preset being changed brings its own once it is read).
  const [portText, setPortText] = useState('');
  const [network, setNetwork] = useState<ServerNetwork>('local');
  const [seeded, setSeeded] = useState(false);
  if (editing && !seeded) {
    setSeeded(true);
    setPortText(editing.port !== undefined ? String(editing.port) : '');
    setNetwork(editing.network);
  }

  const identity = option?.source === 'local' ? option.local.identity : undefined;
  const tested = identity && engineChoice ? testedConfigs(configs.data?.configs ?? [], identity, engineChoice.kind) : [];
  const configId = best.startsWith('config:') ? best.slice('config:'.length) : undefined;
  const configEntry = tested.find((c) => c.entry.id === configId)?.entry;
  const configSource = configEntry ? sourceFor(configEntry, undefined) : undefined;
  const configRun = useRun(configSource?.runId);
  const configParams =
    configRun.data && local.data ? presetOf(configRun.data, local.data, system.data?.paths.enginesDir, { combo: configSource?.combo }).params : undefined;
  // A .ninfer model only NInfer-all reads: NInfer-all runs it (the page says so).
  const chosenCustom = customList.find((c) => c.engine.id === engineChoice?.config.customEngineId)?.engine;
  const ninferAll = useNinferAllNeed(engineChoice?.kind ?? 'llamacpp-native', chosenCustom, identity);
  // A .ninfer model: NInfer's own presets ("Consigliata da NInfer", "Provata su RTX 5090"), those the build that runs it has, a test's own NInfer settings, or LLM Bench's choice.
  const ninferPresets =
    option?.source === 'local' && format === 'ninfer'
      ? ninferPresetsFor({ name: option.local.identity.facts?.name, label: option.name, repo: option.local.identity.repo, file: option.local.identity.file }, ninferAll.kvDtypes)
      : [];
  // Handed-over NInfer settings are the preset they match, else offered as they are ('run').
  const [ninferPicked, setNinferChoice] = useState<NinferChoice | undefined>(undefined);
  // A variant of NInfer (NInfer-all among them) starts with its model card's settings (they may need its own KV type); NInfer with its recommended ones.
  const firstChoice: NinferChoice = (engineChoice?.base === 'ninfer' || ninferAll.needed) && ninferPresets[0]?.id === 'model-card' ? 'model-card' : 'ninfer-recommended';
  const ninferChoice: NinferChoice = ninferPicked ?? (draftNinfer ? (ninferPresetOf(draft!.params!, ninferPresets) ?? 'run') : firstChoice);
  const ninferParams = ninferChoice === 'run' ? draft!.params : withNinferPreset(undefined, ninferPresets.find((p) => p.id === ninferChoice)?.params);
  const modelPresets = option ? presetsForModel(presets.data ?? [], optionModel(option)) : [];
  const pickedPreset = modelPresets.find((p) => p.id === presetId);
  const parsed = paramsFromForm(form);

  let params: StartServerRequest['params'];
  let paramsReady = true;
  if (tab === 'best') {
    if (best === 'draft') params = draft?.params;
    else if (configId !== undefined) {
      params = configParams;
      paramsReady = configParams !== undefined;
    }
  } else if (tab === 'presets') {
    // One of the user's presets, else NInfer's choice ('auto': LLM Bench decides).
    params = pickedPreset ? pickedPreset.params : ninferParams;
    paramsReady = pickedPreset !== undefined || ninferPresets.length > 0;
  } else {
    params = parsed.params;
    paramsReady = parsed.invalid.length === 0;
  }
  // A server keeps NInfer's own defaults for what only a benchmark sets (every prompt in full, no thinking).
  if (params) params = serverNinfer(params);
  const port = parsePort(portText);
  const lanUnsupported = engineChoice?.kind === 'command';
  const effNetwork: ServerNetwork = lanUnsupported ? 'local' : network;

  const request = option && engine && paramsReady && !port.invalid ? serverRequest({ engine, model: optionModel(option), params, port: port.port, network: effNetwork, ...recipe.requestPart(recipeOn) }) : undefined;
  const requestKey = keyOf(request);
  const planKey = useDebounced(requestKey, 300);
  const planQ = useServerPlan(planKey ? (JSON.parse(planKey) as StartServerRequest) : undefined);
  const plan = planQ.isError ? undefined : planQ.data;
  // The preview of exactly these choices (not the previous one still on screen while typing).
  const current = plan && !planQ.isPlaceholderData && planKey === requestKey ? plan : undefined;
  // "Scelte da LLM Bench": what it would choose (the latest "Trova le impostazioni migliori", else the context that fits).
  const autoRequest = option && engine && tab === 'best' ? serverRequest({ engine, model: optionModel(option), params: undefined, port: port.port, network: effNetwork, ...recipe.requestPart(recipeOn) }) : undefined;
  const autoKey = useDebounced(keyOf(autoRequest), 300);
  const autoPlan = useServerPlan(autoKey ? (JSON.parse(autoKey) as StartServerRequest) : undefined);
  const modelLabel = option ? `${option.name}${option.quant ? ` · ${option.quant}` : ''}` : '';
  const needs = current && request ? needsFromPlan(request, current, modelLabel) : [];
  const portProblem = current?.warnings.some((w) => w.code === 'port_taken' || w.code === 'port_ours') === true;
  const unsupportedWarning = plan?.warnings.find((w) => w.code === 'flag_unsupported');
  const own = !(tab === 'best' && best === 'auto');
  // The recipe may run the model on its own engine (a fork): the summary names the one that will run.
  const applied = current?.recipe?.engine;
  const summaryEngine = withNinferAll(applied ? engineNameOf({ kind: applied.kind ?? engine!.kind, ...(applied.customEngineId !== undefined ? { customEngineId: applied.customEngineId } : {}) }, customList, f) : engineName, ninferAll, t);

  const [saving, setSaving] = useState(false);

  const start = () => {
    // The port the plan said: always the same one, even when the field was left empty.
    const req = { ...request!, port: request!.port ?? current!.port };
    flow.serve(req, {
      plan: current!,
      modelLabel,
      engineLabel: summaryEngine,
      onStarted: () => {
        toast.success(t('servers.flow.ready', { name: option!.name }));
        void navigate({ to: '/servers' });
      },
      onBackground: () => void navigate({ to: '/servers' }),
    });
  };

  /** What the preset remembers: the settings the plan will really use, so it starts the same way every time. */
  const presetInput = (): Omit<ServerPresetInput, 'name' | 'autoStart'> => {
    const source = presetSource({ tab, best, tunedRunId: current!.tuned?.runId, test: best === 'draft' ? draft!.provenance : configSource });
    return { engine: engine!, model: optionModel(option!), modelLabel, params: current!.params, port: request!.port ?? current!.port, network: effNetwork, source, ...recipe.requestPart(recipeOn) };
  };

  const save = () => {
    if (!editing) {
      setSaving(true);
      return;
    }
    update.mutate(
      { id: editing.id, patch: presetInput() },
      {
        onSuccess: (p) => {
          toast.success(t('servers.presets.updated', { name: p.name }));
          void navigate({ to: '/servers' });
        },
        onError: (e) => toast.error(t(`errors.${apiErrorData(e).code}.title`)),
      },
    );
  };

  const onSaveNew = async (name: string, autoStart: boolean) => {
    const saved = await create.mutateAsync({ ...presetInput(), name, autoStart });
    toast.success(t('servers.presets.saved', { name: saved.name }));
    setSaving(false);
  };

  const onTab = (next: SettingsTab) => {
    // "Comandi personalizzati" starts from what is chosen now (context included), or what was last previewed.
    const shown = current ?? plan;
    if (next === 'custom' && !formTouched && shown) setForm(formFromParams(shown.params));
    setTab(next);
  };

  /** One of the user's presets (it brings its port and network). */
  const onPreset = (id: string) => {
    setPresetId(id);
    const p = modelPresets.find((x) => x.id === id)!;
    setPortText(p.port !== undefined ? String(p.port) : '');
    setNetwork(p.network);
  };

  return (
    <Page
      eyebrow={
        <Link to="/servers" className="inline-flex items-center gap-1 self-start rounded-xs text-sm font-medium text-fg-2 hover:text-fg focus-ring">
          <ArrowLeft aria-hidden className="size-4" />
          {t('servers.flow.back')}
        </Link>
      }
      title={editing ? t('servers.flow.editTitle', { name: editing.name }) : t('servers.flow.title')}
      subtitle={t('servers.flow.subtitle')}
      width="wide"
    >
      <div className="grid gap-section xl:grid-cols-[minmax(0,1fr)_460px]">
        <div className="flex min-w-0 flex-col gap-section">
          <div className="grid gap-4 lg:grid-cols-2">
            <StepCard step={1} title={t('servers.flow.step.model')} help={t('servers.flow.step.modelHelp')}>
              <ModelStep options={options} value={option} onChange={setModelKey} onOpenModels={() => void navigate({ to: '/models' })} />
            </StepCard>
            <StepCard step={2} title={t('servers.flow.step.engine')} help={t('servers.flow.step.engineHelp')}>
              <EngineStep choices={choices} value={engineChoice} onChange={setEngineKey} customs={customList} />
              {ninferAll.needed && <p className="text-sm text-fg-2">{ninferAll.ready ? t('ninfer.allNote.ready') : t('ninfer.allNote.toBuildServer')}</p>}
            </StepCard>
          </div>
          {ninferAll.needed && !ninferAll.ready && <NinferAllCallout />}
          <StepCard step={3} title={t('servers.flow.step.settings')} help={t('servers.flow.step.settingsHelp')}>
            <SettingsStep
              engineKind={engineChoice?.kind ?? 'llamacpp-native'}
              tab={tab}
              onTab={onTab}
              best={best}
              onBest={setBest}
              autoTuned={autoPlan.data?.tuned}
              provenance={draft?.provenance}
              configs={tested}
              loadingConfig={configId !== undefined && configParams === undefined}
              presets={modelPresets}
              builtins={
                ninferPresets.length > 0 ? (
                  <NinferPresetPicker
                    presets={ninferPresets}
                    run={draftNinfer}
                    // Nothing checked here while one of the user's presets is chosen.
                    value={pickedPreset ? ('' as NinferChoice) : ninferChoice}
                    onChange={(v) => {
                      setNinferChoice(v);
                      setPresetId(undefined);
                    }}
                  />
                ) : undefined
              }
              preset={presetId}
              onPreset={onPreset}
              othersCount={(presets.data?.length ?? 0) - modelPresets.length}
              form={form}
              invalid={parsed.invalid}
              onForm={(patch) => {
                setFormTouched(true);
                setForm((cur) => ({ ...cur, ...patch }));
              }}
              unsupported={unsupportedWarning ? { engine: String(unsupportedWarning.params?.engine), flags: String(unsupportedWarning.params?.flags) } : undefined}
              // "Comandi per questo modello": nothing when the model has no recipe, or when its only command is the engine (preselected above).
              recipeSlot={recipeTarget && <RecipeChip target={recipeTarget} use={recipeOn} onUseChange={setRecipeOn} />}
            />
          </StepCard>
          <StepCard step={4} title={t('servers.flow.step.port')} help={t('servers.flow.step.portHelp')}>
            <NetworkStep
              portText={portText}
              onPort={setPortText}
              portInvalid={port.invalid}
              suggested={plan?.port}
              warnings={current?.warnings ?? []}
              lan={effNetwork === 'lan'}
              onLan={(on) => setNetwork(on ? 'lan' : 'local')}
              lanUrls={plan?.lanUrls ?? []}
              lanUnsupported={lanUnsupported}
            />
          </StepCard>
        </div>
        <div className="xl:sticky xl:top-6 xl:self-start">
          <Summary
            plan={plan}
            planning={planQ.isFetching || (request !== undefined && requestKey !== planKey)}
            error={planQ.isError ? apiErrorData(planQ.error) : undefined}
            needs={needs}
            engineKind={engineChoice?.kind}
            engineName={summaryEngine}
            own={own}
            canStart={current !== undefined && !portProblem}
            canSave={current !== undefined}
            editing={editing !== undefined}
            onStart={start}
            onSave={save}
          />
        </div>
      </div>
      {flow.ui}
      {saving && current && <SavePresetDialog port={request!.port ?? current.port} defaultName={option!.name} onClose={() => setSaving(false)} onSave={onSaveNew} />}
    </Page>
  );
}
