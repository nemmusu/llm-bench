import { useRouterState } from '@tanstack/react-router';
import { ChevronRight, Moon, Search, Sun } from 'lucide-react';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/cn';
import { pageTitleKey } from '../../lib/nav';
import { useSettings } from '../../lib/settings';
import { Logo } from '../brand/logo';
import { DownloadsPanel } from '../library/downloads-panel';
import { IconButton } from '../ui/button';
import { Kbd } from '../ui/kbd';
import { LanguageMenu } from './language-menu';

/** Width Windows/Linux reserve on the right for the native min/max/close overlay. */
export const WINDOW_CONTROLS_WIDTH = 138;

export function hasWindowControlsOverlay(platform: string | undefined): boolean {
  return platform === 'win32' || platform === 'linux';
}

export function isMac(platform: string | undefined): boolean {
  return platform === 'darwin' || (platform === undefined && /Mac/.test(navigator.platform));
}

/**
 * Custom 40px title bar: draggable surface, app identity + current page, the command palette
 * trigger, the language menu, downloads and the theme toggle. Leaves room for the native window buttons.
 */
export function TitleBar({ onOpenPalette }: { onOpenPalette: () => void }) {
  const { t } = useI18n();
  const { resolvedTheme, update } = useSettings();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const platform = window.gpubench?.platform;
  const overlay = hasWindowControlsOverlay(platform);
  const modKey = isMac(platform) ? '⌘' : 'Ctrl';

  return (
    <header
      className="app-drag relative flex h-10 shrink-0 items-center gap-3 bg-canvas pl-3.5 select-none"
      style={{ paddingRight: overlay ? WINDOW_CONTROLS_WIDTH : 10 }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Logo size={20} />
        <span className="text-sm font-semibold tracking-[-0.01em] text-fg">{t('app.name')}</span>
        <ChevronRight aria-hidden className="size-3.5 text-fg-3" />
        <span className="truncate text-sm text-fg-2">{t(pageTitleKey(pathname))}</span>
      </div>

      <div className="pointer-events-none absolute inset-x-0 flex justify-center">
        <button
          type="button"
          onClick={onOpenPalette}
          aria-label={t('shell.openPalette')}
          aria-keyshortcuts={isMac(platform) ? 'Meta+K' : 'Control+K'}
          className={cn(
            'app-no-drag pointer-events-auto flex h-7 w-[min(420px,36vw)] items-center gap-2 rounded-md border border-border bg-surface px-2.5 text-sm text-fg-3 shadow-xs transition-colors hover:border-border-strong hover:text-fg-2 focus-ring',
          )}
        >
          <Search aria-hidden className="size-3.5" />
          <span className="flex-1 truncate text-left">{t('shell.searchPlaceholder')}</span>
          <span className="flex items-center gap-0.5" aria-hidden>
            <Kbd>{modKey}</Kbd>
            <Kbd>K</Kbd>
          </span>
        </button>
      </div>

      <div className="app-no-drag ml-auto flex items-center gap-1">
        <LanguageMenu />
        <DownloadsPanel />
        <IconButton
          size="sm"
          label={t('shell.toggleTheme')}
          icon={resolvedTheme === 'dark' ? <Sun /> : <Moon />}
          onClick={() => update({ theme: resolvedTheme === 'dark' ? 'light' : 'dark' })}
        />
      </div>
    </header>
  );
}
