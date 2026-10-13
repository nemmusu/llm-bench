import { Outlet, useRouterState } from '@tanstack/react-router';
import { MotionConfig, motion, useReducedMotion } from 'motion/react';
import { useCallback, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { CompareTray } from '../compare/compare-tray';
import { LibraryEvents } from '../library/library-events';
import { CommandPalette, usePaletteShortcut } from './command-palette';
import { Sidebar } from './sidebar';
import { TitleBar } from './title-bar';

const SIDEBAR_KEY = 'gpubench.sidebarCollapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Window layout: title bar on top, sidebar + content panel below. The welcome wizard runs
 * full-width (no sidebar) so a first-time user has a single path forward.
 */
export function AppShell() {
  const { t } = useI18n();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const mainRef = useRef<HTMLElement>(null);
  const togglePalette = useCallback(() => setPaletteOpen((o) => !o), []);
  usePaletteShortcut(togglePalette);
  const onboarding = pathname.startsWith('/welcome');
  // With reduced motion pages appear instantly (no fade either).
  const reduceMotion = useReducedMotion();

  const toggleSidebar = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(SIDEBAR_KEY, c ? '0' : '1');
      } catch {
        /* storage unavailable: keep it for this session only */
      }
      return !c;
    });
  };

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex h-full flex-col bg-canvas text-fg">
        {/* A real in-page link (axe recognizes skip links); the hash router must not see it. */}
        <a
          href="#main"
          onClick={(e) => {
            e.preventDefault();
            mainRef.current?.focus();
          }}
          className="sr-only z-[60] rounded-md bg-accent-solid px-3 py-2 text-sm text-accent-fg focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
        >
          {t('nav.skipToContent')}
        </a>
        <TitleBar onOpenPalette={() => setPaletteOpen(true)} />
        <div className="flex min-h-0 flex-1">
          {!onboarding && <Sidebar collapsed={collapsed} onToggle={toggleSidebar} />}
          <main
            ref={mainRef}
            id="main"
            tabIndex={-1}
            className="relative min-w-0 flex-1 overflow-y-auto border-t border-border bg-panel outline-none data-[edge=left]:rounded-tl-xl data-[edge=left]:border-l"
            data-edge={onboarding ? 'none' : 'left'}
          >
            <motion.div
              key={pathname}
              initial={reduceMotion ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              className="min-h-full"
            >
              <Outlet />
            </motion.div>
            {/* What is picked for "Confronta", on every page: stays at the bottom while the page scrolls. */}
            <CompareTray />
          </main>
        </div>
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
        <LibraryEvents />
      </div>
    </MotionConfig>
  );
}
