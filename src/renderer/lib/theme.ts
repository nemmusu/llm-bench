import type { Settings } from '../../contract/settings';

export type ThemePref = Settings['theme'];
export type ResolvedTheme = 'light' | 'dark';
export type Density = Settings['density'];

/** Title bar surface colors per theme; must match `--canvas` / `--fg-2` in styles.css. */
export const TITLE_BAR_COLORS: Record<ResolvedTheme, { background: string; symbols: string }> = {
  light: { background: '#f4f5f8', symbols: '#1b1f2a' },
  dark: { background: '#0b0d12', symbols: '#e6e8ee' },
};

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** Resolves "system" through prefers-color-scheme; explicit choices win. */
export function resolveTheme(pref: ThemePref, win: Window = window): ResolvedTheme {
  if (pref !== 'system') return pref;
  return win.matchMedia?.(DARK_QUERY).matches ? 'dark' : 'light';
}

/**
 * Writes theme and density on <html> (CSS tokens key off these attributes) and keeps the native
 * Windows caption buttons in sync with our title bar surface.
 */
export function applyDocumentTheme(theme: ResolvedTheme, density: Density, doc: Document = document): void {
  const root = doc.documentElement;
  root.dataset.theme = theme;
  root.dataset.density = density;
  root.style.colorScheme = theme;
  const bridge = doc.defaultView?.gpubench;
  if (bridge) void bridge.setTitleBarTheme(TITLE_BAR_COLORS[theme]).catch(() => undefined);
}

/** Calls `onChange` when the OS theme flips; returns an unsubscribe function. */
export function watchSystemTheme(onChange: (theme: ResolvedTheme) => void, win: Window = window): () => void {
  const mq = win.matchMedia?.(DARK_QUERY);
  if (!mq) return () => undefined;
  const listener = (e: MediaQueryListEvent) => onChange(e.matches ? 'dark' : 'light');
  mq.addEventListener('change', listener);
  return () => mq.removeEventListener('change', listener);
}

/** True when the user asked the OS for less motion (charts and counters skip animations). */
export function prefersReducedMotion(win: Window = window): boolean {
  return Boolean(win.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}
