import { Monitor, Moon, Sun } from 'lucide-react';
import { useId } from 'react';
import { AboutSection } from '../components/settings/about';
import { ColdCacheRow } from '../components/settings/cold-cache';
import { DataSection } from '../components/settings/data-section';
import { FoldersSection } from '../components/settings/folders';
import { TraySection } from '../components/settings/tray-section';
import { Row, Section } from '../components/settings/section';
import { HfTokenForm } from '../components/library/hf-token';
import { Page } from '../components/shell/page';
import { SegmentedControl } from '../components/ui/segmented-control';
import { Select } from '../components/ui/select';
import { Switch } from '../components/ui/switch';
import { useI18n } from '../i18n';
import { useSettings } from '../lib/settings';

const INTERVALS = [250, 500, 1000] as const;

/** Appearance, benchmark options, folders, Hugging Face token, results export/import, about. */
export function SettingsPage() {
  const { t } = useI18n();
  const { settings, update } = useSettings();
  const ids = { expert: useId(), lang: useId(), interval: useId() };
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
            label={t('settings.expert')}
            hint={t('settings.expertHint')}
            htmlFor={ids.expert}
            control={<Switch id={ids.expert} checked={settings.expertMode} onCheckedChange={(expertMode) => update({ expertMode })} />}
          />
          <ColdCacheRow />
          <Row
            label={t('settings.interval.label')}
            hint={t('settings.interval.hint')}
            htmlFor={ids.interval}
            control={
              <Select
                id={ids.interval}
                className="w-44"
                value={String(settings.telemetryIntervalMs)}
                onValueChange={(v) => update({ telemetryIntervalMs: Number(v) })}
                options={INTERVALS.map((ms) => ({ value: String(ms), label: t(`settings.interval.ms${ms}`) }))}
              />
            }
          />
        </Section>

        <TraySection />

        <FoldersSection />

        <Section title={t('settings.huggingface')} hint={t('settings.hfTokenHint')}>
          <Row label={t('settings.hfToken')} control={<HfTokenForm />} />
        </Section>

        <DataSection />
        <AboutSection />
      </div>
    </Page>
  );
}
