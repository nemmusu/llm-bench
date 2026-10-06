import { Navigate, useNavigate } from '@tanstack/react-router';
import { Check, ChevronsUpDown, Download, FolderOpen, HardDrive, Play, Timer } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import type { EngineKind } from '../../contract/engines';
import type { Profile } from '../../contract/results';
import { ModelPicker } from '../components/domain/model-picker';
import { GpuCard } from '../components/domain/gpu-card';
import { RecentResults } from '../components/domain/recent-results';
import { Page } from '../components/shell/page';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { CodeBlock } from '../components/ui/code-block';
import { FitBadge } from '../components/ui/fit-badge';
import { HelpTip } from '../components/ui/help-tip';
import { Field, Input, Textarea } from '../components/ui/input';
import { SegmentedControl } from '../components/ui/segmented-control';
import { Select } from '../components/ui/select';
import { Skeleton } from '../components/ui/skeleton';
import { Switch } from '../components/ui/switch';
import { TriedBadge } from '../components/ui/tried-badge';
import { useI18n } from '../i18n';
import { cn } from '../lib/cn';
import { useEngines, useRecommendedModels, useSystem } from '../lib/queries';
import { useSettings } from '../lib/settings';
import { findChoice } from '../mock/models';
import { DEFAULT_EXPERT, DEFAULT_IMAGES, previewCommand, type ExpertParams } from '../mock/plan';
import { MOCK_LIVE_RUN_ID } from '../mock/runs';
import { LLAMACPP_BUILD, LLAMACPP_DOWNLOAD_BYTES } from '../mock/system';

const ENGINE_ORDER: EngineKind[] = ['llamacpp-native', 'llamacpp-docker', 'vllm-docker', 'vllm-native', 'external'];
const PROFILES = ['quick', 'standard', 'full'] as const;

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

function Note({ icon, tone = 'muted', children }: { icon: ReactNode; tone?: 'muted' | 'accent' | 'success'; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 [&_svg]:size-4',
        tone === 'accent' && 'text-accent-text',
        tone === 'success' && 'text-success-text',
        tone === 'muted' && 'text-fg-2',
      )}
    >
      {icon}
      {children}
    </span>
  );
}

function ExpertPanel({
  engine,
  params,
  onChange,
  command,
}: {
  engine: EngineKind;
  params: ExpertParams;
  onChange: (p: ExpertParams) => void;
  command: { powershell: string; bash: string };
}) {
  const { t } = useI18n();
  const set = <K extends keyof ExpertParams>(key: K) => (value: ExpertParams[K]) => onChange({ ...params, [key]: value });
  const text = (key: keyof ExpertParams, label: string, placeholder: string, hint?: string) => (
    <Field label={label} hint={hint}>
      {({ id, describedBy }) => (
        <Input
          id={id}
          aria-describedby={describedBy}
          value={params[key]}
          placeholder={placeholder}
          onChange={(e) => set(key)(e.target.value as never)}
          className="tabular-nums"
        />
      )}
    </Field>
  );
  const docker = engine === 'llamacpp-docker' || engine === 'vllm-docker';
  return (
    <Card className="flex flex-col">
      <div className="flex flex-col gap-1 px-card pt-card">
        <h2 className="text-md font-semibold tracking-[-0.01em]">{t('benchmark.expert.title')}</h2>
        <p className="text-sm text-fg-2">{t('benchmark.expert.description')}</p>
      </div>
      <div className="grid gap-x-8 gap-y-6 p-card lg:grid-cols-2">
        <fieldset className="flex flex-col gap-4">
          <legend className="mb-3 text-xs font-semibold tracking-wide text-fg-3 uppercase">{t('benchmark.expert.sectionLaunch')}</legend>
          <div className="grid grid-cols-2 gap-4">
            {text('ctx', t('benchmark.expert.ctx'), '8192')}
            {text('ngl', t('benchmark.expert.ngl'), t('benchmark.expert.nglAll'))}
            <Field label={t('benchmark.expert.flashAttention')}>
              {({ id }) => (
                <Select
                  id={id}
                  value={params.flashAttention}
                  onValueChange={set('flashAttention')}
                  options={[
                    { value: 'auto', label: t('common.auto') },
                    { value: 'on', label: t('common.on') },
                    { value: 'off', label: t('common.off') },
                  ]}
                />
              )}
            </Field>
            <Field label={t('benchmark.expert.kvCache')}>
              {({ id }) => (
                <Select
                  id={id}
                  value={params.kvCache}
                  onValueChange={set('kvCache')}
                  options={[
                    { value: 'auto', label: t('common.auto') },
                    { value: 'f16', label: 'f16' },
                    { value: 'q8_0', label: 'q8_0' },
                    { value: 'q4_0', label: 'q4_0' },
                  ]}
                />
              )}
            </Field>
            {text('batch', t('benchmark.expert.batch'), '2048')}
            {text('ubatch', t('benchmark.expert.ubatch'), '512')}
            {text('threads', t('benchmark.expert.threads'), t('common.auto'))}
            {text('parallel', t('benchmark.expert.parallel'), '1')}
          </div>
        </fieldset>
        <fieldset className="flex flex-col gap-4">
          <legend className="mb-3 text-xs font-semibold tracking-wide text-fg-3 uppercase">{t('benchmark.expert.sectionTest')}</legend>
          <div className="grid grid-cols-2 gap-4">
            {text('promptLengths', t('benchmark.expert.promptLengths'), '512, 4096', t('benchmark.expert.listHint'))}
            {text('outputTokens', t('benchmark.expert.outputTokens'), '256')}
            {text('repetitions', t('benchmark.expert.repetitions'), '5')}
            {text('concurrency', t('benchmark.expert.concurrency'), '1, 4', t('benchmark.expert.listHint'))}
          </div>
          <Field label={t('benchmark.expert.executable')} hint={t('benchmark.expert.executableHint')}>
            {({ id, describedBy }) => (
              <div className="flex gap-2">
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  value={params.executable}
                  placeholder={`…\\llama.cpp\\${LLAMACPP_BUILD}\\llama-server.exe`}
                  onChange={(e) => set('executable')(e.target.value)}
                  className="font-mono text-xs"
                />
                <Button
                  onClick={() =>
                    void window.gpubench
                      ?.pickFile({ title: t('benchmark.expert.executable') })
                      .then((p) => p && set('executable')(p))
                  }
                >
                  <FolderOpen aria-hidden />
                  {t('common.browse')}
                </Button>
              </div>
            )}
          </Field>
          {docker && text('image', t('benchmark.expert.dockerImage'), DEFAULT_IMAGES[engine] ?? '')}
        </fieldset>
        <Field label={t('benchmark.expert.extraArgs')} hint={t('benchmark.expert.extraArgsHint')}>
          {({ id, describedBy }) => (
            <Textarea
              id={id}
              aria-describedby={describedBy}
              value={params.extraArgs}
              placeholder="--mlock"
              onChange={(e) => set('extraArgs')(e.target.value)}
              className="font-mono text-xs"
            />
          )}
        </Field>
        <Field label={t('benchmark.expert.env')} hint={t('benchmark.expert.envHint')}>
          {({ id, describedBy }) => (
            <Textarea
              id={id}
              aria-describedby={describedBy}
              value={params.env}
              placeholder="CUDA_VISIBLE_DEVICES=0"
              onChange={(e) => set('env')(e.target.value)}
              className="font-mono text-xs"
            />
          )}
        </Field>
      </div>
      <div className="flex flex-col gap-2 border-t border-border p-card">
        <div className="flex items-center gap-1.5">
          <h3 className="text-sm font-semibold">{t('benchmark.expert.preview')}</h3>
          <span className="text-xs text-fg-3">· {t('benchmark.expert.previewHint')}</span>
        </div>
        <CodeBlock commands={command} label={t('benchmark.expert.preview')} />
      </div>
    </Card>
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

/** One big Start button and three friendly choices (engine, model, duration). */
function BenchmarkScreen() {
  const { t, bytes, integer } = useI18n();
  const { settings, update } = useSettings();
  const navigate = useNavigate();
  const system = useSystem();
  const engines = useEngines();
  const models = useRecommendedModels();
  const [engine, setEngine] = useState<EngineKind>(settings.lastEngine?.kind ?? 'llamacpp-native');
  const [modelId, setModelId] = useState(settings.lastModelId ?? 'qwen3-8b-q4km');
  const [profile, setProfile] = useState<Profile>(settings.lastProfile === 'custom' ? 'quick' : settings.lastProfile);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [expert, setExpert] = useState<ExpertParams>(DEFAULT_EXPERT);

  const model = findChoice(modelId);
  const engineStatus = engines.data?.find((e) => e.kind === engine);
  const gpu = system.data?.gpus[0];
  const gpuShort = gpu?.name.replace('NVIDIA GeForce ', '') ?? 'GPU';
  const vram = gpu ? `${integer(gpu.memoryTotalMiB / 1024)} GB` : '';
  const engineMissing = engine === 'llamacpp-native' && engineStatus?.installed === false;
  const command = useMemo(() => previewCommand(engine, model, expert), [engine, model, expert]);

  const downloads: { label: string; bytes: number }[] = [];
  if (engineMissing) downloads.push({ label: 'llama.cpp', bytes: LLAMACPP_DOWNLOAD_BYTES });
  if (!model.local) downloads.push({ label: model.name, bytes: model.sizeBytes });
  const list = new Intl.ListFormat(settings.language, { type: 'conjunction' });

  const start = () => {
    update({ lastEngine: { kind: engine }, lastModelId: modelId, lastProfile: profile });
    void navigate({ to: '/run/$runId', params: { runId: MOCK_LIVE_RUN_ID } });
  };

  return (
    <Page title={t('benchmark.title')} subtitle={t('benchmark.subtitle')} width="wide">
      <div className="grid gap-section xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-section">
          {/* Hero: the one obvious thing to do. */}
          <Card className="hero-wash relative overflow-hidden">
            <svg aria-hidden viewBox="0 0 200 200" className="pointer-events-none absolute -top-16 -right-10 size-80 opacity-[0.07] dark:opacity-[0.1]">
              <path d="M30 140a70 70 0 1 1 140 0" fill="none" stroke="var(--accent)" strokeWidth="14" strokeLinecap="round" />
              <path d="M100 136 L142 70" stroke="var(--accent)" strokeWidth="10" strokeLinecap="round" />
              <circle cx="100" cy="138" r="14" fill="var(--accent)" />
            </svg>
            <div className="relative flex flex-col gap-6 p-7 compact:p-5">
              <div className="flex min-w-0 flex-col gap-2">
                {gpu ? (
                  <h2 className="text-3xl font-semibold tracking-[-0.025em] text-balance">{t('benchmark.heroTitle', { gpu: gpuShort })}</h2>
                ) : (
                  <Skeleton className="h-9 w-80" />
                )}
                <p className="text-md text-fg-2">
                  {t('benchmark.heroSummary', {
                    engine: t(`benchmark.engines.${engine}`),
                    model: `${model.name} ${model.quant}`,
                    duration: `${t(`benchmark.profiles.${profile}`)} (${t(`benchmark.profileTime.${profile}`)})`,
                  })}
                </p>
                {downloads.length > 0 && (
                  <p className="mt-1 inline-flex items-center gap-2 text-sm text-fg-2">
                    <Download aria-hidden className="size-4 text-accent-text" />
                    {t('benchmark.willDownload', {
                      items: list.format(downloads.map((d) => d.label)),
                      size: bytes(downloads.reduce((a, d) => a + d.bytes, 0)),
                    })}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                <Button variant="primary" size="xl" onClick={start} className="min-w-64">
                  <Play aria-hidden className="fill-current" />
                  {t('benchmark.start')}
                </Button>
                <span className="flex flex-col text-sm text-fg-3">
                  <span className="inline-flex items-center gap-1.5 font-medium text-fg-2">
                    <Timer aria-hidden className="size-4" />
                    {t(`benchmark.profileTime.${profile}`)}
                  </span>
                  {t('benchmark.startHint')}
                </span>
              </div>
            </div>
          </Card>

          <div className="grid gap-4 lg:grid-cols-3">
            <ChoiceCard
              step={1}
              title={t('benchmark.choice.engine')}
              help={t('benchmark.choice.engineHelp')}
              badge={engine === 'llamacpp-native' ? <Badge tone="accent" size="sm">{t('common.recommended')}</Badge> : undefined}
              footer={
                engineMissing ? (
                  <Note icon={<Download />} tone="accent">
                    {t('benchmark.engineToInstall', { size: bytes(LLAMACPP_DOWNLOAD_BYTES) })}
                  </Note>
                ) : (
                  <Note icon={<Check />} tone="success">
                    {t('benchmark.engineInstalled', { version: engineStatus?.version ?? LLAMACPP_BUILD })}
                  </Note>
                )
              }
            >
              <Select
                aria-label={t('benchmark.changeEngine')}
                value={engine}
                onValueChange={setEngine}
                className="h-11 text-md font-semibold"
                options={ENGINE_ORDER.map((k) => ({
                  value: k,
                  label: t(`benchmark.engines.${k}`),
                  description: t(`benchmark.engineDesc.${k}`),
                  disabled: engines.data?.find((e) => e.kind === k)?.supported === false,
                }))}
              />
              <p className="text-sm text-fg-2">{t(`benchmark.engineDesc.${engine}`)}</p>
            </ChoiceCard>

            <ChoiceCard
              step={2}
              title={t('benchmark.choice.model')}
              help={t('benchmark.choice.modelHelp')}
              footer={
                model.local ? (
                  <Note icon={<HardDrive />}>{t('benchmark.modelLocal')}</Note>
                ) : (
                  <Note icon={<Download />} tone="accent">
                    {t('benchmark.modelToDownload', { size: bytes(model.sizeBytes) })}
                  </Note>
                )
              }
            >
              {models.isPending ? (
                <Skeleton className="h-16 w-full" />
              ) : (
                <button
                  type="button"
                  onClick={() => setPickerOpen(true)}
                  aria-label={`${t('benchmark.changeModel')}: ${model.name} ${model.quant}`}
                  className="flex items-center gap-3 rounded-lg border border-border-strong bg-surface px-3 py-2 text-left shadow-xs transition-colors hover:bg-surface-2 focus-ring"
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-md font-semibold text-fg">{model.name}</span>
                    <span className="text-sm text-fg-3 tabular-nums">
                      {model.quant} · {bytes(model.sizeBytes)}
                    </span>
                  </span>
                  <ChevronsUpDown aria-hidden className="size-4 shrink-0 text-fg-3" />
                </button>
              )}
              <div className="flex flex-wrap gap-1.5">
                <FitBadge level={model.fit} size="sm" />
                {model.tried && <TriedBadge tps={model.tried.tps} date={model.tried.date} size="sm" />}
              </div>
            </ChoiceCard>

            <ChoiceCard step={3} title={t('benchmark.choice.duration')} help={t('benchmark.choice.durationHelp')}>
              <SegmentedControl
                label={t('benchmark.choice.duration')}
                value={profile}
                onValueChange={setProfile}
                layout="list"
                options={PROFILES.map((p) => ({ value: p, label: t(`benchmark.profiles.${p}`), sublabel: t(`benchmark.profileTime.${p}`) }))}
              />
              <p className="text-sm text-fg-2">{t(`benchmark.profileDesc.${profile}`)}</p>
            </ChoiceCard>
          </div>

          <div className="flex items-center gap-3 self-start px-1 py-1">
            <Switch id="expert-switch" checked={settings.expertMode} onCheckedChange={(v) => update({ expertMode: v })} aria-describedby="expert-hint" />
            <div className="flex flex-col">
              <label htmlFor="expert-switch" className="cursor-pointer text-sm font-semibold text-fg">
                {t('benchmark.expert.label')}
              </label>
              <span id="expert-hint" className="text-xs text-fg-3">
                {t('benchmark.expert.hint')}
              </span>
            </div>
          </div>

          {settings.expertMode && <ExpertPanel engine={engine} params={expert} onChange={setExpert} command={command} />}
        </div>

        <section className="flex flex-col gap-section" aria-label={t('benchmark.gpu.title')}>
          <GpuCard />
          <RecentResults />
        </section>
      </div>

      <ModelPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        models={models.data ?? []}
        value={modelId}
        onChange={setModelId}
        gpuName={gpuShort}
        vram={vram}
      />
    </Page>
  );
}
