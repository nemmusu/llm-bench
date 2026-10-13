import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { defaultSettings, type Settings } from '../../contract/settings';
import { useApi } from './api-context';
import { applyDocumentTheme, resolveTheme, watchSystemTheme, type ResolvedTheme } from './theme';

export const SETTINGS_QUERY_KEY = ['settings'] as const;

interface SettingsValue {
  settings: Settings;
  /** False until the first GET /api/settings answered (or failed): avoids a wrong first redirect. */
  ready: boolean;
  resolvedTheme: ResolvedTheme;
  update(patch: Partial<Settings>): void;
}

const SettingsContext = createContext<SettingsValue | null>(null);

/**
 * Loads settings from the core and applies theme/density to the document. Changes are applied
 * optimistically and kept locally even if the core rejects them, so the UI never gets stuck
 * on a broken or missing settings API.
 */
export function SettingsProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: () => api.get<Settings>('/api/settings'),
    staleTime: Infinity,
    retry: 1,
  });
  const fallback = useMemo(() => defaultSettings(), []);
  const settings = query.data ?? fallback;

  const { mutate } = useMutation({
    // Custom engines are saved through their own API (/api/engines/custom): never sent here, so a stale
    // list in this cache cannot undo an engine just added or removed.
    mutationFn: ({ customEngines: _engines, ...patch }: Partial<Settings>) => api.put<Settings>('/api/settings', patch),
    // One save at a time, in order: each carries the full object, so the last one wins correctly.
    scope: { id: 'settings' },
    onSuccess: (saved) => {
      // Keep any newer optimistic edit made while this request was in flight.
      qc.setQueryData<Settings>(SETTINGS_QUERY_KEY, (old) => ({ ...saved, ...pendingOverlay(old, saved) }));
    },
  });

  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() => resolveTheme('system'));
  useEffect(() => watchSystemTheme(setSystemTheme), []);
  const resolvedTheme: ResolvedTheme = settings.theme === 'system' ? systemTheme : settings.theme;

  // Layout effect: runs before children's passive effects, so charts read the new tokens.
  useLayoutEffect(() => {
    applyDocumentTheme(resolvedTheme, settings.density);
  }, [resolvedTheme, settings.density]);

  useEffect(() => {
    document.documentElement.lang = settings.language;
  }, [settings.language]);

  const value = useMemo<SettingsValue>(
    () => ({
      settings,
      ready: query.isFetched || query.isError,
      resolvedTheme,
      update: (patch) => {
        // Apply synchronously: a navigation right after update() must already see the new values.
        const next = { ...(qc.getQueryData<Settings>(SETTINGS_QUERY_KEY) ?? fallback), ...patch };
        qc.setQueryData<Settings>(SETTINGS_QUERY_KEY, next);
        // Send the whole object (a save that failed is carried by the next one), but never what other
        // routes own: a copy read before a preset or an engine was saved would erase it.
        const { serverPresets: _presets, customEngines: _engines, ...mine } = next;
        mutate(mine);
      },
    }),
    [settings, query.isFetched, query.isError, resolvedTheme, mutate, qc, fallback],
  );
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

/** Fields the user changed locally that the server answer does not reflect yet. */
function pendingOverlay(local: Settings | undefined, saved: Settings): Partial<Settings> {
  if (!local) return {};
  const out: Partial<Settings> = {};
  for (const key of ['language', 'theme', 'density', 'expertMode'] as const) {
    if (local[key] !== saved[key]) (out as Record<string, unknown>)[key] = local[key];
  }
  return out;
}

export function useSettings(): SettingsValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used inside <SettingsProvider>');
  return ctx;
}
