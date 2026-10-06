import { useNavigate } from '@tanstack/react-router';
import { Command } from 'cmdk';
import { GitCompareArrows, Languages, Monitor, Moon, Play, Rows3, Search, SlidersHorizontal, Sun } from 'lucide-react';
import { Dialog, VisuallyHidden } from 'radix-ui';
import { useEffect, type ReactNode } from 'react';
import { toast } from 'sonner';
import { translate, useI18n } from '../../i18n';
import { NAV_MAIN, NAV_SETTINGS } from '../../lib/nav';
import { useSettings } from '../../lib/settings';
import { MOCK_LIVE_RUN_ID } from '../../mock/runs';
import { Kbd } from '../ui/kbd';

/** Ctrl+K / ⌘K toggles the palette from anywhere. */
export function usePaletteShortcut(toggle: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);
}

function Item({ onSelect, icon, children, value }: { onSelect: () => void; icon: ReactNode; children: ReactNode; value: string }) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className="flex h-10 cursor-default items-center gap-3 rounded-md px-3 text-sm text-fg-2 select-none data-[selected=true]:bg-accent-soft data-[selected=true]:text-fg [&_svg]:size-4 [&_svg]:text-fg-3 data-[selected=true]:[&_svg]:text-accent-text"
    >
      {icon}
      {children}
    </Command.Item>
  );
}

const groupClass =
  'px-2 pb-2 [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-fg-3';

/** Searchable list of pages, actions and preferences (cmdk inside a Radix dialog). */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { settings, update } = useSettings();

  const run = (fn: () => void) => () => {
    onOpenChange(false);
    fn();
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-overlay data-[state=open]:animate-fade-in" />
        <Dialog.Content className="fixed top-[14vh] left-1/2 z-50 w-[min(640px,calc(100vw-48px))] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-elevated shadow-lg outline-none data-[state=open]:animate-pop-in">
          <VisuallyHidden.Root>
            <Dialog.Title>{t('palette.title')}</Dialog.Title>
            <Dialog.Description>{t('palette.description')}</Dialog.Description>
          </VisuallyHidden.Root>
          <Command label={t('palette.title')} loop>
            <div className="flex items-center gap-3 border-b border-border px-4">
              <Search aria-hidden className="size-4 text-fg-3" />
              <Command.Input
                placeholder={t('palette.placeholder')}
                aria-label={t('palette.placeholder')}
                className="h-12 flex-1 bg-transparent text-md text-fg outline-none placeholder:text-fg-3"
              />
              <Kbd>Esc</Kbd>
            </div>
            <Command.List className="max-h-[min(420px,60vh)] overflow-y-auto py-2">
              <Command.Empty className="px-4 py-8 text-center text-sm text-fg-3">{t('palette.empty')}</Command.Empty>
              <Command.Group heading={t('palette.groupActions')} className={groupClass}>
                <Item value="action-start" icon={<Play />} onSelect={run(() => void navigate({ to: '/run/$runId', params: { runId: MOCK_LIVE_RUN_ID } }))}>
                  {t('palette.startBenchmark')}
                </Item>
                <Item value="action-compare" icon={<GitCompareArrows />} onSelect={run(() => void navigate({ to: '/compare' }))}>
                  {t('palette.newCompare')}
                </Item>
              </Command.Group>
              <Command.Group heading={t('palette.groupNavigate')} className={groupClass}>
                {[...NAV_MAIN, NAV_SETTINGS].map((item) => {
                  const Icon = item.icon;
                  return (
                    <Item key={item.id} value={`nav-${item.id} ${t(item.label)}`} icon={<Icon />} onSelect={run(() => void navigate({ to: item.to }))}>
                      {t(item.label)}
                    </Item>
                  );
                })}
              </Command.Group>
              <Command.Group heading={t('palette.groupPreferences')} className={groupClass}>
                <Item value="theme-light" icon={<Sun />} onSelect={run(() => update({ theme: 'light' }))}>
                  {t('palette.themeLight')}
                </Item>
                <Item value="theme-dark" icon={<Moon />} onSelect={run(() => update({ theme: 'dark' }))}>
                  {t('palette.themeDark')}
                </Item>
                <Item value="theme-system" icon={<Monitor />} onSelect={run(() => update({ theme: 'system' }))}>
                  {t('palette.themeSystem')}
                </Item>
                <Item
                  value="language switch english italiano"
                  icon={<Languages />}
                  onSelect={run(() => {
                    const language = settings.language === 'it' ? 'en' : 'it';
                    update({ language });
                    toast(translate(language, 'language.switched'));
                  })}
                >
                  {t('palette.switchLanguage')}
                </Item>
                <Item
                  value="density"
                  icon={<Rows3 />}
                  onSelect={run(() => update({ density: settings.density === 'compact' ? 'comfortable' : 'compact' }))}
                >
                  {settings.density === 'compact' ? t('palette.densityComfortable') : t('palette.densityCompact')}
                </Item>
                <Item value="expert" icon={<SlidersHorizontal />} onSelect={run(() => update({ expertMode: !settings.expertMode }))}>
                  {settings.expertMode ? t('palette.expertOff') : t('palette.expertOn')}
                </Item>
              </Command.Group>
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
