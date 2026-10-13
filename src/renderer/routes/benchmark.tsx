import { Navigate, useNavigate } from '@tanstack/react-router';
import { Check, ChevronsUpDown, Download, HardDrive, Play, Server, Timer, TriangleAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import type { RunPlan, StartRunRequest } from '../../contract/api';
import type { Settings } from '../../contract/settings';
import { customEngineConfigOf, customEngineKindOf } from '../../contract/custom-engines';
import type { EngineKind } from '../../contract/engines';
import { customEngineLabel, customEngineWhere } from '../components/engines/custom-engine-check';
import { EngineSuggestion } from '../components/engines/engine-suggestion';
import { useCustomEngines } from '../lib/queries-engines';
import type { FitEstimate } from '../../contract/models';
import type { Profile } from '../../contract/results';
import { ENGINE_ORDER, engineConfigOf, engineFormOf, savableEngine, type EngineForm } from '../components/bench/engine-form';
import { ExpertPanel } from '../components/bench/expert-panel';
import { formFromParams, formFromScenario, hasCustomParams, paramsFromForm, scenarioFromForm, type ParamsForm, type ScenarioForm } from '../components/bench/expert-form';
import { MIB_PER_GB, shortGpuName } from '../components/bench/format';
import { BenchModelPicker } from '../components/bench/model-picker';
import { initialModelKey, modelOptions, newestTried, requestModel, savedModelId, triedHere, type ModelOption } from '../components/bench/model-options';
import { PlanCard, type FitPatch } from '../components/bench/plan-card';
import { RecentRuns } from '../components/bench/recent-runs';
import { ServersPanel } from '../components/bench/servers';
import { guessNeeds, needsFromPlan } from '../components/bench/needs';
import { useStartFlow } from '../components/bench/start-flow';
import { GpuCard } from '../components/domain/gpu-card';
import { withNinferPreset, type NinferChoice } from '../components/engines/ninfer-format';
import { NinferPresetPicker } from '../components/engines/ninfer-presets';
import { isNinferKind, ninferPresetsFor } from '../../contract/ninfer';
import { PresetBanner } from '../components/presets/preset-banner';
import { usePresetDraft } from '../components/presets/use-preset-draft';
import { DEFAULT_TUNE, TuneOptions, tuneRequestOf, type TuneRequest } from '../components/tune/tune-options';
import { Page } from '../components/shell/page';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { FitBadge } from '../components/ui/fit-badge';
import { HelpTip } from '../components/ui/help-tip';
import { SegmentedControl } from '../components/ui/segmented-control';
import { Select } from '../components/ui/select';
import { Skeleton } from '../components/ui/skeleton';
import { Switch } from '../components/ui/switch';
import { TriedHereBadge } from '../components/ui/tried-badge';
import { useI18n } from '../i18n';
import { cn } from '../lib/cn';
import {
  apiErrorData,
  useBenchEngines,
  useBenchLocalModels,
  useBenchSystem,
  useCurated,
  useDebounced,
  useLocalFit,
  usePlan,
  useRuns,
  useRunsLiveRefresh,
  useTried,
} from '../lib/queries-runs';
import { useSettings } from '../lib/settings';

const PROFILES = ['quick', 'standard', 'full', 'tune'] as const;

function ChoiceCard({ step, title, help, badge, children, footer }: { step: number; title: string; help: string; badge?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <Card className="flex min-w-0 flex-col">
      <div className="flex items-center gap-2.5 px-card pt-card">
        <span aria-hidden className="grid size-6 place-items-center rounded-full bg-accent-soft text-xs font-semibold text-accent-text">
          {step}
        </span>
        <h2 className="text-md font-semibold tracking-[-0.01em]">{title}</h2>
        <HelpTip term={title}>{help}</HelpTip>
        {badge && <span className="ml-auto">{badge}</span>}
      </div>
      <div className="flex flex-1 flex-col gap-3 px-card pt-4 pb-card">{children}</div>
      {footer && <div className="flex min-h-11 items-center gap-2 border-t border-border px-card py-2.5 text-sm">{footer}</div>}
    </Card>
  );
}

function Note({ icon, tone = 'muted', children }: { icon: ReactNode; tone?: 'muted' | 'accent' | 'success' | 'warning'; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex min-w-0 items-center gap-1.5 [&_svg]:size-4 [&_svg]:shrink-0',
        tone === 'accent' && 'text-accent-text',
        tone === 'success' && 'text-success-text',
        tone === 'warning' && 'text-warning-text',
        tone === 'muted' && 'text-fg-2',
      )}
    >
      {icon}
      <span className="min-w-0">{children}</span>
    </span>
  );
}

/** Home: waits for settings (last choices are restored from them), then shows the screen. */
export function BenchmarkPage() {
  const { settings, ready } = useSettings();
  if (!ready) return <BenchmarkSkeleton />;
  if (!settings.onboardingDone) return <Navigate to="/welcome" replace />;
  return <BenchmarkScreen />;
}

function BenchmarkSkeleton() {
  return (
    <div className="mx-auto flex max-w-[1440px] flex-col gap-section px-8 pt-7">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-56 w-full" />
    </div>
  );
}

/** Model card body: the picker button and the verdicts for the selected model (a suggestion's fit comes from the plan). */
function SelectedModel({
  option,
  engine,
  onOpen,
  params,
  planFit,
}: {
  option: ModelOption;
  engine: EngineKind;
  onOpen: () => void;
  params: StartRunRequest['params'];
  planFit: FitEstimate | undefined;
}) {
  const { t, bytes } = useI18n();
  const system = useBenchSystem();
  const local = option.source === 'local' ? option.local : undefined;
  const fit = useLocalFit(local?.id, engine, params);
  const fitLevel = (fit.data ?? planFit)?.level;
  const tried = useTried(local ? { weakKey: local.identity.weakKey, ...(local.identity.sha256 ? { sha256: local.identity.sha256 } : {}) } : undefined);
  const gpuName = system.data?.gpus[0]?.name;
  // A run that spilled to shared memory never stands for "tried here", unless it is the only one (then it says so).
  const best = newestTried((tried.data ?? []).filter((r) => r.gpuName === gpuName));
  const detail = [option.quant, option.sizeBytes === undefined ? undefined : bytes(option.sizeBytes)].filter(Boolean).join(' · ');
  return (
    <>
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${t('benchmark.changeModel')}: ${option.name}${option.quant ? ` ${option.quant}` : ''}`}
        className="flex items-center gap-3 rounded-lg border border-border-strong bg-surface px-3 py-2 text-left shadow-xs transition-colors hover:bg-surface-2 focus-ring"
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-md font-semibold text-fg">{option.name}</span>
          <span className="text-sm text-fg-3 tabular-nums">{detail}</span>
        </span>
        <ChevronsUpDown aria-hidden className="size-4 shrink-0 text-fg-3" />
      </button>
      <div className="flex flex-wrap gap-1.5">
        {fitLevel && <FitBadge level={fitLevel} size="sm" />}
        {option.source === 'curated' && (
          <Badge tone="accent" size="sm">
            {option.preset ? t('presets.badge') : t('benchmark.pickModel.suggested')}
          </Badge>
        )}
        {best && <TriedHereBadge tried={triedHere(best)} short={false} size="sm" />}
      </div>
    </>
  );
}

/** One big Start button and three friendly choices (engine, model, duration). */
function BenchmarkScreen() {
  const f = useI18n();
  const { t, bytes, integer, duration } = f;
  const { settings, update } = useSettings();
  const navigate = useNavigate();
  // "Usa questo preset" / "Usa queste impostazioni": the choices handed over, read once.
  const preset = usePresetDraft();
  const draft = preset.draft;
  const system = useBenchSystem();
  const engines = useBenchEngines();
  const local = useBenchLocalModels();
  const runs = useRuns();
  useRunsLiveRefresh();
  const gpu = system.data?.gpus[0];
  // The card's real size (31.8 GB for a "32 GB" one): the core decides which tier it counts as.
  const vramGB = gpu ? gpu.memoryTotalMiB / MIB_PER_GB : undefined;
  const curated = useCurated(vramGB);
  const tierGB = curated.data?.tierGB;
  const flow = useStartFlow();
  const expert = settings.expertMode;

  const savedEngine = draft?.engine ?? settings.lastEngine;
  const [engine, setEngine] = useState<EngineKind>(savedEngine?.kind ?? 'llamacpp-native');
  // A custom engine ("Motori personalizzati"): its base kind is `engine`, its id here.
  const [customId, setCustomId] = useState<string | undefined>(savedEngine?.customEngineId);
  const customInfo = useCustomEngines();
  const [engineForm, setEngineForm] = useState<EngineForm>(() => ({ ...engineFormOf(savedEngine), modelName: draft?.modelName ?? '' }));
  const [profile, setProfile] = useState<Profile>(draft?.profile ?? settings.lastProfile);
  const [paramsForm, setParamsForm] = useState<ParamsForm>(() => formFromParams(draft?.params ?? settings.lastParams));
  const [scenarioForm, setScenarioForm] = useState<ScenarioForm>(() => formFromScenario(draft?.scenario));
  const [tune, setTune] = useState<TuneRequest>(DEFAULT_TUNE);
  // The latest tune of the same question, as the last plan said (it decides whether "Ricontrollo rapido" is offered).
  const [previousTune, setPreviousTune] = useState<RunPlan['previousTune']>(undefined);
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const [pickerOpen, setPickerOpen] = useState(false);
  // NInfer: a result's own settings when its preset brought them, else NInfer's recommended ones.
  const draftNinfer = draft?.params?.ninfer;
  const [ninferChoice, setNinferChoice] = useState<NinferChoice>(draftNinfer ? 'run' : 'ninfer-recommended');

  const statusOf = (k: EngineKind) => engines.data?.find((e) => e.kind === k);
  // A saved custom engine whose kind runs here (vLLM / SGLang native only on Linux).
  const savedCustom = customId === undefined ? undefined : settings.customEngines.find((e) => e.id === customId);
  const effCustom = savedCustom && statusOf(customEngineKindOf(savedCustom))?.supported !== false ? savedCustom : undefined;
  // External endpoints and custom plans are expert features; unsupported engines fall back to llama.cpp.
  const effEngine: EngineKind = effCustom
    ? customEngineKindOf(effCustom)
    : (engine === 'external' && !expert) || engine === 'command' || statusOf(engine)?.supported === false
      ? 'llamacpp-native'
      : engine;
  const effProfile: Profile = (profile === 'custom' && !expert) || (profile === 'tune' && effEngine === 'command') ? 'quick' : profile;
  const custom = effProfile === 'custom';
  const status = effCustom ? customInfo.data?.find((i) => i.engine.id === effCustom.id)?.check.status : statusOf(effEngine);

  const { withModel } = preset;
  // Memoized by the React Compiler (it follows the custom engine chosen too).
  const options = withModel(modelOptions(effEngine, local.data ?? [], curated.data?.models ?? []), effEngine);
  const modelKey =
    picked !== undefined && options.some((o) => o.key === picked)
      ? picked
      : initialModelKey(options, preset.modelKey(options) ?? draft?.localId ?? draft?.repo ?? settings.lastModelId, curated.data?.models);
  const option = options.find((o) => o.key === modelKey);
  // NInfer: the built-in settings of a .ninfer model (NInfer's README quick start, one tested on an RTX 5090).
  const ninferPresets = isNinferKind(effEngine) && option?.source === 'local' ? ninferPresetsFor({ name: option.local.identity.facts?.name, label: option.local.identity.displayName }) : [];
  const ninferRun = ninferChoice === 'run' && draftNinfer ? { ninfer: draftNinfer } : undefined;
  const ninferPreset = ninferPresets.length > 0 ? (ninferPresets.find((p) => p.id === ninferChoice)?.params ?? ninferRun) : undefined;

  const plainEngine = engineConfigOf(effEngine, engineForm, expert);
  // A custom engine brings its own executable, image or command: the request only names it.
  const config = effCustom ? customEngineConfigOf(effCustom) : plainEngine.config;
  const engineInvalid = effCustom ? [] : plainEngine.invalid;
  const parsedParams = paramsFromForm(paramsForm);
  const parsedScenario = scenarioFromForm(scenarioForm);
  const sendParams = expert && effEngine !== 'external' && hasCustomParams(parsedParams.params);
  const runParams = withNinferPreset(sendParams ? parsedParams.params : undefined, ninferPreset);
  const external = effEngine === 'external';
  const model: StartRunRequest['model'] | undefined = external ? (engineForm.modelName.trim() ? { name: engineForm.modelName.trim() } : {}) : option ? requestModel(option) : undefined;
  const valid =
    engineInvalid.length === 0 &&
    !(sendParams && parsedParams.invalid.length) &&
    !(custom && (parsedScenario.invalid.length > 0 || parsedScenario.scenario.steps.length === 0)) &&
    (external || option !== undefined);
  const base: StartRunRequest = {
    engine: config,
    model: model ?? {},
    profile: effProfile,
    ...(custom ? { scenario: parsedScenario.scenario } : {}),
    ...(runParams ? { params: runParams } : {}),
    allowSharedGpu: false,
    // "Ricontrollo rapido" only while the plan says the last tune of this question ran with another build.
    ...(effProfile === 'tune' ? { tune: tuneRequestOf(tune, { expert, previous: previousTune }) } : {}),
  };
  const baseJson = JSON.stringify(base);
  const planJson = useDebounced(valid ? baseJson : '', 400);
  const plan = usePlan(planJson ? (JSON.parse(planJson) as StartRunRequest) : undefined);
  const planError = plan.isError ? apiErrorData(plan.error) : undefined;
  const planData = plan.isError ? undefined : plan.data;
  // Remembered for the next render (the request depends on it): the React way to keep what a previous render saw.
  if (planData && JSON.stringify(planData.previousTune) !== JSON.stringify(previousTune)) setPreviousTune(planData.previousTune);
  // The preview of exactly these choices (not the previous one still on screen while typing).
  const currentPlan = planData && !plan.isPlaceholderData && planJson === baseJson ? planData : undefined;

  const modelLabel = external
    ? engineForm.modelName.trim() || engineForm.baseUrl.trim() || t('benchmark.engines.external')
    : option
      ? `${option.name}${option.quant ? ` · ${option.quant}` : ''}`
      : t('benchmark.noModel');
  // What gets installed or downloaded before the test: the plan says it exactly; until then, a good guess.
  const needs = currentPlan ? needsFromPlan(base, currentPlan, modelLabel) : guessNeeds({ engine: config, status, option, modelLabel });
  const engineNeed = needs.find((n) => n.kind !== 'model');
  const modelNeed = needs.find((n) => n.kind === 'model');

  const gpuShort = gpu ? shortGpuName(gpu.name) : 'GPU';
  const engineLabel = effCustom ? customEngineLabel(t, effCustom) : t(`benchmark.engines.${effEngine}`);
  const profileTime = planData ? `≈ ${duration(planData.estimatedSeconds * 1000)}` : t(`benchmark.profileTime.${effProfile}`);
  const list = new Intl.ListFormat(f.locale, { type: 'conjunction' });

  /** Remembers these choices for next time (once the run or the server really started). */
  const remember = (more: Partial<Settings> = {}) =>
    update({
      lastEngine: savableEngine(config),
      ...(option ? { lastModelId: savedModelId(option) } : {}),
      ...(expert ? { lastParams: parsedParams.params } : {}),
      ...more,
    });

  const start = () => {
    flow.start(base, {
      needs,
      ...(currentPlan ? { plan: currentPlan } : {}),
      modelLabel,
      engineLabel,
      onStarted: () => remember({ lastProfile: effProfile }),
    });
  };

  /**
   * "Usa cache q4_0" / "Contesto massimo che entra" of a "does not fit" warning: into the advanced
   * parameters (turned on: only they are sent), the preview follows.
   */
  const applyFix = (patch: FitPatch) => {
    setParamsForm((cur) => ({
      ...cur,
      ...(patch.kvCacheType ? { kvCacheType: patch.kvCacheType, flashAttention: 'on' as const } : {}),
      ...(patch.contextSize !== undefined ? { contextSize: String(patch.contextSize) } : {}),
    }));
    if (!expert) update({ expertMode: true });
    toast.success(t('spill.fix.applied'));
  };

  /** The same engine, model and expert parameters, without a test: the core fills in the rest for this card. */
  const serve = () => {
    flow.serve({ engine: base.engine, model: base.model, params: base.params }, { modelLabel, engineLabel, onStarted: () => remember() });
  };

  const engineFooter = (() => {
    if (external) return <Note icon={<Check />}>{t('benchmark.engineExternal')}</Note>;
    if (engineNeed) {
      const b = engineNeed.bytes;
      const [soon, sized] = engineNeed.kind === 'engine' ? (['engineToInstallSoon', 'engineToInstall'] as const) : (['imageToPullSoon', 'imageToPull'] as const);
      return (
        <Note icon={<Download />} tone="accent">
          {b === undefined ? t(`benchmark.${soon}`) : t(`benchmark.${sized}`, { size: bytes(b) })}
        </Note>
      );
    }
    if (!status) return <Skeleton className="h-4 w-40" />;
    if (status.available || config.executable) {
      return (
        <Note icon={<Check />} tone="success">
          {status.version ? t('benchmark.engineInstalled', { version: status.version }) : t('common.installed')}
        </Note>
      );
    }
    const problem = status.problems[0];
    return (
      <span className="flex w-full items-center justify-between gap-2">
        <Note icon={<TriangleAlert />} tone="warning">
          {problem ? t(`errors.${problem as 'INTERNAL'}.title`, status.problemParams) : t('common.notInstalled')}
        </Note>
        <Button size="sm" variant="link" onClick={() => void navigate({ to: '/engines' })}>
          {t('benchmark.openEngines')}
        </Button>
      </span>
    );
  })();

  const modelFooter = (() => {
    if (external) return <Note icon={<HardDrive />}>{t('benchmark.modelOnServer')}</Note>;
    if (!option) return null;
    if (modelNeed) {
      return (
        <Note icon={<Download />} tone="accent">
          {modelNeed.bytes === undefined ? t('benchmark.modelToDownloadSoon') : t('benchmark.modelToDownload', { size: bytes(modelNeed.bytes) })}
        </Note>
      );
    }
    // A local pick, or a suggestion the plan found already downloaded.
    return <Note icon={<HardDrive />}>{t('benchmark.modelLocal')}</Note>;
  })();

  const modelsLoading = local.isPending || (vramGB !== undefined && curated.isPending);

  return (
    <Page title={t('benchmark.title')} subtitle={t('benchmark.subtitle')} width="wide">
      <div className="grid gap-section xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-section">
          <PresetBanner preset={preset} />
          {/* Hero: the one obvious thing to do. */}
          <Card className="hero-wash relative overflow-hidden">
            <svg aria-hidden viewBox="0 0 200 200" className="pointer-events-none absolute -top-16 -right-10 size-80 opacity-[0.07] dark:opacity-[0.1]">
              <path d="M30 140a70 70 0 1 1 140 0" fill="none" stroke="var(--accent)" strokeWidth="14" strokeLinecap="round" />
              <path d="M100 136 L142 70" stroke="var(--accent)" strokeWidth="10" strokeLinecap="round" />
              <circle cx="100" cy="138" r="14" fill="var(--accent)" />
            </svg>
            <div className="relative flex flex-col gap-6 p-7 compact:p-5">
              <div className="flex min-w-0 flex-col gap-2">
                {system.data ? (
                  <h2 className="text-3xl font-semibold tracking-[-0.025em] text-balance">
                    {gpu ? t('benchmark.heroTitle', { gpu: gpuShort }) : t('benchmark.heroNoGpu')}
                  </h2>
                ) : (
                  <Skeleton className="h-9 w-80" />
                )}
                <p className="text-md text-fg-2">
                  {t('benchmark.heroSummary', { engine: engineLabel, model: modelLabel, duration: `${t(`benchmark.profiles.${effProfile}`)} (${profileTime})` })}
                </p>
                {system.data && !gpu && (
                  // No NVIDIA card (or no driver): say so first, with the way to fix it.
                  <div className="mt-1 flex flex-wrap items-center gap-3 rounded-lg border border-warning/30 bg-warning-soft px-4 py-3 text-sm">
                    <TriangleAlert aria-hidden className="size-4 shrink-0 text-warning-text" />
                    <span className="min-w-0 flex-1 text-fg">{t('benchmark.noGpuBody')}</span>
                    <Button size="sm" onClick={() => void navigate({ to: '/welcome' })}>
                      {t('benchmark.noGpuAction')}
                    </Button>
                  </div>
                )}
                {needs.length > 0 && (
                  <p className="mt-1 inline-flex items-center gap-2 text-sm text-fg-2">
                    <Download aria-hidden className="size-4 text-accent-text" />
                    {needs.every((n) => n.bytes !== undefined)
                      ? t('benchmark.willDownload', { items: list.format(needs.map((n) => n.label)), size: bytes(needs.reduce((a, n) => a + n.bytes!, 0)) })
                      : t('benchmark.willDownloadNoSize', { items: list.format(needs.map((n) => n.label)) })}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                <Button variant="primary" size="xl" onClick={start} disabled={!valid} className="min-w-64">
                  <Play aria-hidden className="fill-current" />
                  {t('benchmark.start')}
                </Button>
                {/* The other thing people want: the model running for their own programs, no test. */}
                {!external && (
                  <span className="inline-flex items-center gap-1.5">
                    <Button size="lg" onClick={serve} disabled={!valid}>
                      <Server aria-hidden />
                      {t('benchmark.serve')}
                    </Button>
                    <HelpTip term={t('benchmark.serve')}>{t('benchmark.serveHelp')}</HelpTip>
                  </span>
                )}
                <span className="flex flex-col text-sm text-fg-3">
                  <span className="inline-flex items-center gap-1.5 font-medium text-fg-2">
                    <Timer aria-hidden className="size-4" />
                    {profileTime}
                  </span>
                  {valid ? t('benchmark.startHint') : t('benchmark.startBlocked')}
                </span>
              </div>
            </div>
          </Card>

          <div className="grid gap-4 lg:grid-cols-3">
            <ChoiceCard
              step={1}
              title={t('benchmark.choice.engine')}
              help={t('benchmark.choice.engineHelp')}
              badge={effEngine === 'llamacpp-native' ? <Badge tone="accent" size="sm">{t('common.recommended')}</Badge> : undefined}
              footer={engineFooter}
            >
              <Select<string>
                aria-label={t('benchmark.changeEngine')}
                value={effCustom ? `custom:${effCustom.id}` : effEngine}
                onValueChange={(v) => {
                  const chosen = v.startsWith('custom:') ? settings.customEngines.find((e) => `custom:${e.id}` === v) : undefined;
                  setCustomId(chosen?.id);
                  setEngine(chosen ? customEngineKindOf(chosen) : (v as EngineKind));
                  setPicked(undefined);
                }}
                className="h-11 text-md font-semibold"
                // Custom engines right under the engine they are built on ("llama.cpp · PrismML fork"); programs of the user's own last.
                // NInfer is listed only as the kind this system runs (Linux natively, Windows in WSL).
                options={[...ENGINE_ORDER.filter((k) => (expert || k !== 'external') && !(isNinferKind(k) && statusOf(k)?.supported === false)), 'command' as const].flatMap((k) => [
                  ...(k === 'command' ? [] : [{ value: k as string, label: t(`benchmark.engines.${k}`), description: t(`benchmark.engineDesc.${k}`), disabled: statusOf(k)?.supported === false }]),
                  ...settings.customEngines
                    .filter((e) => customEngineKindOf(e) === k)
                    .map((e) => ({ value: `custom:${e.id}`, label: customEngineLabel(t, e), description: t(`engines.custom.bases.${e.base}`), disabled: statusOf(k)?.supported === false })),
                ])}
              />
              <p className="text-sm text-fg-2">
                {effCustom ? (
                  <>
                    {t(`engines.custom.bases.${effCustom.base}`)} · <span className="font-mono text-xs break-all">{customEngineWhere(effCustom)}</span>
                  </>
                ) : (
                  t(`benchmark.engineDesc.${effEngine}`)
                )}
              </p>
            </ChoiceCard>

            <ChoiceCard step={2} title={t('benchmark.choice.model')} help={t('benchmark.choice.modelHelp')} footer={modelFooter}>
              {external ? (
                <p className="text-sm text-fg-2">{engineForm.modelName.trim() ? t('benchmark.externalModel', { name: engineForm.modelName.trim() }) : t('benchmark.externalModelDefault')}</p>
              ) : modelsLoading ? (
                <Skeleton className="h-16 w-full" />
              ) : option ? (
                <SelectedModel option={option} engine={effEngine} onOpen={() => setPickerOpen(true)} params={sendParams ? parsedParams.params : undefined} planFit={currentPlan?.fit} />
              ) : (
                <div className="flex flex-col items-start gap-2">
                  <p className="text-sm text-fg-2">{t('benchmark.noModelBody')}</p>
                  <Button size="sm" onClick={() => void navigate({ to: '/models' })}>
                    {t('benchmark.openModels')}
                  </Button>
                </div>
              )}
            </ChoiceCard>

            <ChoiceCard step={3} title={t('benchmark.choice.duration')} help={t('benchmark.choice.durationHelp')}>
              <SegmentedControl<Profile>
                label={t('benchmark.choice.duration')}
                value={effProfile}
                onValueChange={setProfile}
                layout="list"
                // A program of the user's own has no settings to search.
                options={[...PROFILES.filter((p) => p !== 'tune' || effEngine !== 'command'), ...(expert ? (['custom'] as const) : [])].map((p) => ({
                  value: p,
                  label: t(`benchmark.profiles.${p}`),
                  sublabel: t(`benchmark.profileTime.${p}`),
                }))}
              />
              <p className="text-sm text-fg-2">{t(`benchmark.profileDesc.${effProfile}`)}</p>
              {effProfile === 'tune' && <TuneOptions value={tune} onChange={setTune} expert={expert} previous={previousTune} times={planData?.tuneSeconds} recheckTime={tune.budget === 'recheck' ? planData?.estimatedSeconds : undefined} />}
            </ChoiceCard>
          </div>

          {ninferPresets.length > 0 && <NinferPresetPicker presets={ninferPresets} run={draftNinfer} value={ninferChoice} onChange={setNinferChoice} />}

          <EngineSuggestion
            model={
              option && !external
                ? option.source === 'local'
                  ? { displayName: option.local.identity.displayName, repo: option.local.identity.repo, file: option.local.identity.file, quant: option.local.identity.quant, weakKey: option.local.identity.weakKey }
                  : { displayName: option.name, repo: option.curated.repo, file: option.curated.file, quant: option.quant }
                : undefined
            }
            current={config}
            engines={settings.customEngines}
            onUse={(c) => {
              setCustomId(c.customEngineId);
              setEngine(c.kind);
              setPicked(undefined);
            }}
          />

          <div className="flex items-center gap-3 self-start px-1 py-1">
            <Switch id="expert-switch" checked={expert} onCheckedChange={(v) => update({ expertMode: v })} aria-describedby="expert-hint" />
            <div className="flex flex-col">
              <label htmlFor="expert-switch" className="cursor-pointer text-sm font-semibold text-fg">
                {t('benchmark.expert.label')}
              </label>
              <span id="expert-hint" className="text-xs text-fg-3">
                {t('benchmark.expert.hint')}
              </span>
            </div>
          </div>

          {expert && (
            <ExpertPanel
              engine={effEngine}
              engineForm={engineForm}
              engineInvalid={engineInvalid}
              onEngine={(p) => setEngineForm((cur) => ({ ...cur, ...p }))}
              params={paramsForm}
              paramsInvalid={parsedParams.invalid}
              onParams={(p) => setParamsForm((cur) => ({ ...cur, ...p }))}
              custom={custom}
              scenario={scenarioForm}
              scenarioInvalid={parsedScenario.invalid}
              onScenario={(p) => setScenarioForm((cur) => ({ ...cur, ...p }))}
              defaultImage={status?.location}
              customEngine={effCustom?.name}
            />
          )}

          <PlanCard plan={planData} loading={planJson !== '' && plan.isFetching} error={planError} needs={needs} expert={expert} onFix={applyFix} />
        </div>

        <section className="flex flex-col gap-section" aria-label={t('benchmark.gpu.title')}>
          <GpuCard />
          <ServersPanel />
          <RecentRuns />
        </section>
      </div>

      <BenchModelPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        options={options}
        value={modelKey ?? ''}
        onChange={setPicked}
        engine={effEngine}
        runs={runs.data ?? []}
        gpuName={gpu?.name}
        description={t('benchmark.pickModel.description', { gpu: gpuShort, vram: tierGB ? `${integer(tierGB)} GB` : vramGB ? `${f.number(vramGB, 1)} GB` : '–' })}
        onOpenModels={() => void navigate({ to: '/models' })}
      />
      {flow.ui}
    </Page>
  );
}

