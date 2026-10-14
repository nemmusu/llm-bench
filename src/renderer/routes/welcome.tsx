import { useNavigate } from '@tanstack/react-router';
import { ArrowLeft, ArrowRight, Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Settings } from '../../contract/settings';
import { Logo } from '../components/brand/logo';
import { VersionLabel } from '../components/domain/version-label';
import { DownloadProgressLine } from '../components/library/download-progress';
import { RecommendedSetup, useRecommendation, useReferenceJob } from '../components/setup/recommended-setup';
import { LanguageSwitch } from '../components/shell/language-menu';
import { SystemCheckPanel } from '../components/setup/system-check';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Stepper, type StepState } from '../components/ui/stepper';
import { useI18n } from '../i18n';
import { useMainGpu } from '../lib/queries-library';
import { useSettings } from '../lib/settings';

/** Step 3: ready, with the model download still visible if it is running. */
function Done({ onGo }: { onGo: () => void }) {
  const { t } = useI18n();
  const job = useReferenceJob();
  return (
    <section aria-labelledby="welcome-done" className="flex flex-col items-center gap-3 px-7 py-12 text-center">
      <span aria-hidden className="grid size-16 place-items-center rounded-full bg-[linear-gradient(135deg,var(--accent),var(--accent-2))] text-white shadow-glow">
        <Check className="size-8" strokeWidth={3} />
      </span>
      <h2 id="welcome-done" className="mt-3 text-2xl font-semibold tracking-[-0.02em]">
        {t('welcome.done.title')}
      </h2>
      <p className="max-w-md text-md text-fg-2">{t('welcome.done.body')}</p>
      {job && job.state !== 'done' && (
        <div className="mt-2 w-full max-w-md text-left">
          <p className="mb-2 text-sm text-fg-2">{t('welcome.done.downloading', { name: job.label })}</p>
          <DownloadProgressLine job={job} />
        </div>
      )}
      <Button variant="primary" size="xl" className="mt-4" onClick={onGo}>
        {t('welcome.done.go')}
        <ArrowRight aria-hidden />
      </Button>
    </section>
  );
}

/** First-launch wizard: the language at the top, system check (each problem fixed with one button) → recommended setup → ready. */
export function WelcomePage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { settings, update } = useSettings();
  const gpu = useMainGpu();
  const rec = useRecommendation();
  const [step, setStep] = useState(0);
  const [leaving, setLeaving] = useState(false);

  const finish = (patch: Partial<Settings>) => {
    update({ onboardingDone: true, ...patch });
    setLeaving(true);
  };
  const applySetup = () =>
    finish({ lastEngine: { kind: 'llamacpp-native' }, lastProfile: 'quick', ...(rec.local ? { lastModelId: rec.local.id } : {}) });
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
          {/* The language first: someone who does not read English switches in one click. */}
          <div className="mt-1 flex shrink-0 flex-col items-end gap-2">
            <LanguageSwitch />
            <Button variant="ghost" size="sm" onClick={() => finish({})}>
              {t('welcome.skip')}
            </Button>
          </div>
        </div>

        <Stepper
          label={t('welcome.stepOf', { n: step + 1, total: 3 })}
          steps={steps}
          size="sm"
          className="mx-auto max-w-[520px]"
          stateLabels={{
            done: t('welcome.stepState.done'),
            current: t('welcome.stepState.current'),
            pending: t('welcome.stepState.pending'),
            skipped: t('welcome.stepState.pending'),
          }}
        />

        <Card className="shadow-md">
          {step === 0 && <SystemCheckPanel className="px-7 pt-6 pb-6" onPickModel={() => setStep(1)} />}
          {step === 1 && <RecommendedSetup gpuName={gpu ? gpu.name.replace('NVIDIA GeForce ', '') : t('welcome.setup.yourGpu')} />}
          {step === 2 && <Done onGo={applySetup} />}
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
