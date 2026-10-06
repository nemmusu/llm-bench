import { FolderOpen, KeyRound, Monitor, Moon, Sun, Trash } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Logo } from '../components/brand/logo';
import { Page } from '../components/shell/page';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { SegmentedControl } from '../components/ui/segmented-control';
import { Select } from '../components/ui/select';
import { Switch } from '../components/ui/switch';
import { useI18n } from '../i18n';
import { useSystem } from '../lib/queries';
import { useSettings } from '../lib/settings';

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <Card className="grid gap-6 p-card md:grid-cols-[240px_1fr]">
      <div className="flex flex-col gap-1">
        <h2 className="text-md font-semibold">{title}</h2>
        {hint && <p className="text-sm text-fg-3">{hint}</p>}
      </div>
      <div className="flex flex-col divide-y divide-border">{children}</div>
    </Card>
  );
}

function Row({ label, hint, control, htmlFor }: { label: string; hint?: string; control: ReactNode; htmlFor?: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3 first:pt-0 last:pb-0">
      <div className="flex max-w-md flex-col gap-0.5">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-sm font-medium">
            {label}
          </label>
        ) : (
          <span className="text-sm font-medium">{label}</span>
        )}
        {hint && <span className="text-xs text-fg-3">{hint}</span>}
      </div>
      {control}
    </div>
  );
}

/** Appearance, benchmark options, folders, Hugging Face token, data, about. */
export function SettingsPage() {
  const { t } = useI18n();
  const { settings, update } = useSettings();
  const system = useSystem();
  const [token, setToken] = useState('');
  const ids = { expert: useId(), cold: useId(), token: useId(), lang: useId() };
  const pickFolder = (key: 'resultsDir' | 'modelsDir') => {
    void window.gpubench?.pickFolder({ title: t(`settings.${key}`) }).then((p) => p && update({ [key]: p }));
  };
  return (
    <Page title={t('settings.title')} subtitle={t('settings.subtitle')} width="narrow">
      <div className="flex flex-col gap-section">
        <Section title={t('settings.appearance')} hint={t('settings.appearanceHint')}>
          <Row
            label={t('theme.label')}
            control={
              <SegmentedControl
                label={t('theme.label')}
                value={settings.theme}
                onValueChange={(theme) => update({ theme })}
                options={[
                  { value: 'light', label: t('theme.light'), icon: <Sun aria-hidden /> },
                  { value: 'dark', label: t('theme.dark'), icon: <Moon aria-hidden /> },
                  { value: 'system', label: t('theme.system'), icon: <Monitor aria-hidden /> },
                ]}
              />
            }
          />
          <Row
            label={t('density.label')}
            control={
              <SegmentedControl
                label={t('density.label')}
                value={settings.density}
                onValueChange={(density) => update({ density })}
                options={[
                  { value: 'comfortable', label: t('density.comfortable') },
                  { value: 'compact', label: t('density.compact') },
                ]}
              />
            }
          />
          <Row
            label={t('language.label')}
            htmlFor={ids.lang}
            control={
              <Select
                id={ids.lang}
                className="w-44"
                value={settings.language}
                onValueChange={(language) => update({ language })}
                options={[
                  { value: 'it', label: t('language.it') },
                  { value: 'en', label: t('language.en') },
                ]}
              />
            }
          />
        </Section>

        <Section title={t('settings.benchmarkSection')}>
          <Row
            label={t('benchmark.expert.label')}
            hint={t('settings.expertHint')}
            htmlFor={ids.expert}
            control={<Switch id={ids.expert} checked={settings.expertMode} onCheckedChange={(expertMode) => update({ expertMode })} />}
          />
          <Row
            label={t('settings.coldOptIn')}
            hint={t('settings.coldOptInHint')}
            htmlFor={ids.cold}
            control={<Switch id={ids.cold} checked={settings.coldCacheOptIn} onCheckedChange={(coldCacheOptIn) => update({ coldCacheOptIn })} />}
          />
        </Section>

        <Section title={t('settings.folders')}>
          <Row
            label={t('settings.resultsDir')}
            hint={settings.resultsDir || system.data?.paths.resultsDir || t('settings.defaultFolder')}
            control={
              <Button size="sm" onClick={() => pickFolder('resultsDir')}>
                <FolderOpen aria-hidden />
                {t('settings.browseFolder')}
              </Button>
            }
          />
          <Row
            label={t('settings.modelsDir')}
            hint={settings.modelsDir || system.data?.paths.modelsDir || t('settings.defaultFolder')}
            control={
              <Button size="sm" onClick={() => pickFolder('modelsDir')}>
                <FolderOpen aria-hidden />
                {t('settings.browseFolder')}
              </Button>
            }
          />
        </Section>

        <Section title={t('settings.huggingface')} hint={t('settings.hfTokenHint')}>
          <Row
            label={t('settings.hfToken')}
            htmlFor={ids.token}
            control={
              <div className="flex gap-2">
                <Input id={ids.token} type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="hf_…" className="w-56 font-mono" />
                <Button
                  size="md"
                  disabled={!token}
                  onClick={() => {
                    void window.gpubench?.saveHfToken(token);
                    setToken('');
                    update({ hasHfToken: true });
                    toast.success(t('settings.hfTokenSaved'));
                  }}
                >
                  <KeyRound aria-hidden />
                  {t('common.save')}
                </Button>
              </div>
            }
          />
        </Section>

        <Section title={t('settings.data')}>
          <Row
            label={t('settings.clearCache')}
            hint={t('settings.clearCacheHint')}
            control={
              <Button size="sm" variant="danger-outline">
                <Trash aria-hidden />
                {t('settings.clearCache')}
              </Button>
            }
          />
        </Section>

        <Section title={t('settings.about')}>
          <div className="flex items-start gap-4">
            <Logo size={40} />
            <div className="flex flex-col gap-1 text-sm">
              <p className="font-semibold">{t('app.name')}</p>
              <p className="text-fg-2">{t('settings.aboutBody')}</p>
              <p className="text-xs text-fg-3">{t('settings.credits')}</p>
            </div>
          </div>
        </Section>
      </div>
    </Page>
  );
}
