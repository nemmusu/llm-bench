import { useNavigate } from '@tanstack/react-router';
import { ArrowLeft, ArrowRight, Box, Check, Cpu, Download, Gauge, HardDrive, Minus, MonitorCog, RefreshCw, Server, Timer, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Logo } from '../components/brand/logo';
import { VersionLabel } from '../components/domain/version-label';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Callout } from '../components/ui/callout';
import { Card } from '../components/ui/card';
import { FitBadge } from '../components/ui/fit-badge';
import { Stepper, type StepState } from '../components/ui/stepper';
import { TriedBadge } from '../components/ui/tried-badge';
import { useI18n } from '../i18n';
import { cn } from '../lib/cn';
import { useLocalModels, useSystem } from '../lib/queries';
import { useSettings } from '../lib/settings';
import { findChoice } from '../mock/models';
import { LLAMACPP_BUILD, LLAMACPP_DOWNLOAD_BYTES } from '../mock/system';

type CheckState = 'ok' | 'missing' | 'optional';

function CheckIcon({ state }: { state: CheckState }) {
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-9 shrink-0 place-items-center rounded-full [&_svg]:size-[18px]',
        state === 'ok' && 'bg-success-soft text-success-text',
        state === 'missing' && 'bg-danger-soft text-danger-text',
        state === 'optional' && 'bg-surface-3 text-fg-3',
      )}
    >
      {state === 'ok' ? <Check strokeWidth={2.75} /> : state === 'missing' ? <X strokeWidth={2.75} /> : <Minus strokeWidth={2.75} />}
    </span>
  );
}

function CheckRow({ state, icon, title, detail, action, stateLabel }: { state: CheckState; icon: ReactNode; title: string; detail: string; action?: ReactNode; stateLabel: string }) {
  return (
    <li className="flex items-center gap-4 py-3.5 first:pt-1 last:pb-1">
      <CheckIcon state={state} />
      <div className="flex min-w-0 flex-1 flex-col">
        <p className="flex items-center gap-2 font-medium text-fg">
          <span className="text-fg-3 [&_svg]:size-4" aria-hidden>
            {icon}
          </span>
          {title}
          <span className="sr-only">: {stateLabel}</span>
        </p>
        <p className="text-sm text-fg-2">{detail}</p>
      </div>
      {action ?? (
        <Badge tone={state === 'ok' ? 'success' : 'neutral'} size="sm">
          {stateLabel}
        </Badge>
      )}
    </li>
  );
}

function SetupRow({ icon, label, value, why, extra }: { icon: ReactNode; label: string; value: string; why: string; extra?: ReactNode }) {
  return (
    <li className="flex items-start gap-4 py-4 first:pt-1 last:pb-1">
      <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-text [&_svg]:size-5">
        {icon}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-xs font-medium text-fg-3">{label}</p>
        <p className="text-md font-semibold text-fg">{value}</p>
        <p className="text-sm text-fg-2">{why}</p>
        {extra && <div className="mt-1 flex flex-wrap gap-1.5">{extra}</div>}
      </div>
    </li>
  );
}

/** First-launch wizard: system check → recommended setup → ready. */
export function WelcomePage() {
  const { t, bytes, integer } = useI18n();
  const navigate = useNavigate();
  const { settings, update } = useSettings();
  const system = useSystem();
  const local = useLocalModels();
  const [step, setStep] = useState(0);
  const gpu = system.data?.gpus[0];
  const gpuShort = gpu?.name.replace('NVIDIA GeForce ', '') ?? 'GPU';
  const model = findChoice('qwen3-8b-q4km');

  const [leaving, setLeaving] = useState(false);
  const finish = () => {
    update({ onboardingDone: true, lastEngine: { kind: 'llamacpp-native' }, lastModelId: model.id, lastProfile: 'quick' });
    setLeaving(true);
  };
  // Leave only once the new settings are visible, or the Benchmark page would bounce us back here.
  useEffect(() => {
    if (leaving && settings.onboardingDone) void navigate({ to: '/' });
  }, [leaving, settings.onboardingDone, navigate]);

  const stepIds = ['check', 'setup', 'done'] as const;
  const steps = stepIds.map((id, i) => ({
    id,
    label: t(`welcome.steps.${id}`),
    state: (i < step ? 'done' : i === step ? 'current' : 'pending') as StepState,
  }));

  return (
    <div className="hero-wash min-h-full">
      <div className="mx-auto flex w-full max-w-[780px] flex-col gap-7 px-8 pt-10 pb-12">
        <div className="flex items-start justify-between gap-6">
          <div className="flex items-center gap-4">
            <Logo size={48} />
            <div className="flex flex-col gap-1">
              <h1 className="text-3xl font-semibold tracking-[-0.025em]">{t('welcome.title')}</h1>
              <p className="max-w-[520px] text-md text-fg-2">{t('welcome.subtitle')}</p>
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={finish} className="mt-1">
            {t('welcome.skip')}
          </Button>
        </div>

        <Stepper
          label={t('welcome.stepOf', { n: step + 1, total: 3 })}
          steps={steps}
          size="sm"
          className="mx-auto max-w-[520px]"
          stateLabels={{
            done: t('phases.state.done'),
            current: t('phases.state.current'),
            pending: t('phases.state.pending'),
            skipped: t('phases.state.skipped'),
          }}
        />

        <Card className="shadow-md">
          {step === 0 && (
            <section aria-labelledby="welcome-check" className="flex flex-col">
              <div className="flex items-start justify-between gap-4 px-7 pt-6">
                <div>
                  <h2 id="welcome-check" className="text-xl font-semibold tracking-[-0.015em]">
                    {t('welcome.check.title')}
                  </h2>
                  <p className="mt-1 text-sm text-fg-2">{t('welcome.check.intro')}</p>
                </div>
                <Button variant="ghost" size="sm">
                  <RefreshCw aria-hidden />
                  {t('welcome.check.recheck')}
                </Button>
              </div>
              <ul className="mx-7 mt-3 divide-y divide-border">
                <CheckRow
                  state="ok"
                  icon={<MonitorCog />}
                  title={t('welcome.check.driver')}
                  detail={t('welcome.check.driverDetail', { version: gpu?.driverVersion ?? '–', cuda: gpu?.cudaVersion ?? '–' })}
                  stateLabel={t('welcome.check.ok')}
                />
                <CheckRow
                  state="ok"
                  icon={<Cpu />}
                  title={t('welcome.check.gpu')}
                  detail={t('welcome.check.gpuDetail', { name: gpu?.name ?? '–', vram: `${integer((gpu?.memoryTotalMiB ?? 0) / 1024)} GB` })}
                  stateLabel={t('welcome.check.ok')}
                />
                <CheckRow
                  state="missing"
                  icon={<Server />}
                  title={t('welcome.check.engine')}
                  detail={t('welcome.check.engineDetail')}
                  stateLabel={t('welcome.check.missing')}
                  action={
                    <Button variant="primary" size="sm">
                      <Download aria-hidden />
                      {t('welcome.check.engineInstall', { size: bytes(LLAMACPP_DOWNLOAD_BYTES) })}
                    </Button>
                  }
                />
                <CheckRow
                  state="optional"
                  icon={<Box />}
                  title={t('welcome.check.docker')}
                  detail={t('welcome.check.dockerDetail')}
                  stateLabel={t('welcome.check.optional')}
                  action={
                    <Button variant="secondary" size="sm">
                      {t('common.install')}
                    </Button>
                  }
                />
                <CheckRow
                  state="ok"
                  icon={<HardDrive />}
                  title={t('welcome.check.models')}
                  detail={t('welcome.check.modelsDetail', { count: local.data?.length ?? 0, path: 'C:\\models' })}
                  stateLabel={t('welcome.check.ok')}
                />
              </ul>
              <div className="px-7 pt-2 pb-6">
                <Callout tone="info" title={t('welcome.check.summaryMissing')} className="mt-3" />
              </div>
            </section>
          )}

          {step === 1 && (
            <section aria-labelledby="welcome-setup" className="flex flex-col px-7 pt-6 pb-4">
              <h2 id="welcome-setup" className="text-xl font-semibold tracking-[-0.015em]">
                {t('welcome.setup.title')}
              </h2>
              <p className="mt-1 text-sm text-fg-2">{t('welcome.setup.intro', { gpu: gpuShort })}</p>
              <ul className="mt-4 divide-y divide-border">
                <SetupRow
                  icon={<Server />}
                  label={t('benchmark.choice.engine')}
                  value={`llama.cpp ${LLAMACPP_BUILD}`}
                  why={t('welcome.setup.engineWhy')}
                  extra={<Badge tone="accent" size="sm">{t('common.recommended')}</Badge>}
                />
                <SetupRow
                  icon={<Gauge />}
                  label={t('benchmark.choice.model')}
                  value={`${model.name} · ${model.quant} · ${bytes(model.sizeBytes)}`}
                  why={t('welcome.setup.modelWhy')}
                  extra={
                    <>
                      <FitBadge level={model.fit} size="sm" />
                      {model.tried && <TriedBadge tps={model.tried.tps} size="sm" />}
                    </>
                  }
                />
                <SetupRow
                  icon={<Timer />}
                  label={t('benchmark.choice.duration')}
                  value={`${t('benchmark.profiles.quick')} · ${t('benchmark.profileTime.quick')}`}
                  why={t('welcome.setup.durationWhy')}
                />
              </ul>
            </section>
          )}

          {step === 2 && (
            <section aria-labelledby="welcome-done" className="flex flex-col items-center gap-3 px-7 py-12 text-center">
              <span aria-hidden className="grid size-16 place-items-center rounded-full bg-[linear-gradient(135deg,var(--accent),var(--accent-2))] text-white shadow-glow">
                <Check className="size-8" strokeWidth={3} />
              </span>
              <h2 id="welcome-done" className="mt-3 text-2xl font-semibold tracking-[-0.02em]">
                {t('welcome.done.title')}
              </h2>
              <p className="max-w-md text-md text-fg-2">{t('welcome.done.body')}</p>
              <Button variant="primary" size="xl" className="mt-4" onClick={finish}>
                {t('welcome.done.go')}
                <ArrowRight aria-hidden />
              </Button>
            </section>
          )}

          {step < 2 && (
            <div className="flex items-center justify-between gap-3 border-t border-border px-7 py-4">
              <Button variant="ghost" onClick={() => setStep((s) => s - 1)} disabled={step === 0}>
                <ArrowLeft aria-hidden />
                {t('common.back')}
              </Button>
              <Button variant="primary" size="lg" onClick={() => setStep((s) => s + 1)}>
                {step === 1 ? t('welcome.setup.use') : t('common.continue')}
                <ArrowRight aria-hidden />
              </Button>
            </div>
          )}
        </Card>

        <p className="flex items-center justify-center gap-1.5 text-center">
          <VersionLabel prefix={t('app.name')} />
        </p>
      </div>
    </div>
  );
}
