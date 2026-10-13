/**
 * Settings → "Area di notifica": what closing the window does, and "Avvia GPU Bench all'accesso".
 * The main process follows these settings (tray, close-to-tray, the login item); on a Linux desktop
 * without a notification area the window is minimized instead, and this section says so.
 */
import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import type { CloseBehavior } from '../../../contract/servers';
import { useI18n } from '../../i18n';
import { useSettings } from '../../lib/settings';
import { Callout } from '../ui/callout';
import { SegmentedControl } from '../ui/segmented-control';
import { Switch } from '../ui/switch';
import { Row, Section } from './section';

const BEHAVIORS: readonly CloseBehavior[] = ['tray-if-servers', 'tray', 'quit'];
const LABELS = { 'tray-if-servers': 'servers.tray.closeIfServers', tray: 'servers.tray.closeAlways', quit: 'servers.tray.closeQuit' } as const;

export function TraySection() {
  const { t } = useI18n();
  const { settings, update } = useSettings();
  const loginId = useId();
  const desktop = window.gpubench;
  // Asked once: whether this desktop shows tray icons at all (the main process checked at start-up).
  const shell = useQuery({ queryKey: ['shell', 'info'], queryFn: () => desktop!.shellInfo(), enabled: desktop !== undefined, staleTime: Infinity });
  return (
    <Section title={t('servers.tray.title')} hint={t('servers.tray.hint')}>
      <div className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0">
        <span className="text-sm font-medium">{t('servers.tray.close')}</span>
        <SegmentedControl<CloseBehavior>
          label={t('servers.tray.close')}
          layout="list"
          value={settings.closeBehavior}
          onValueChange={(closeBehavior) => update({ closeBehavior })}
          options={BEHAVIORS.map((b) => ({ value: b, label: t(LABELS[b]) }))}
        />
        {shell.data?.tray === false && <Callout tone="warning" title={t('servers.tray.noTray')} />}
      </div>
      <Row
        label={t('servers.tray.login')}
        hint={desktop ? t('servers.tray.loginHint') : t('servers.tray.desktopOnly')}
        htmlFor={loginId}
        control={<Switch id={loginId} checked={settings.launchAtLogin} disabled={!desktop} onCheckedChange={(launchAtLogin) => update({ launchAtLogin })} />}
      />
    </Section>
  );
}
