import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, type RenderResult } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import type { ReactNode } from 'react';
import { afterEach, vi } from 'vitest';
import type { ServerEvent } from '../../../src/contract/events';
import { defaultSettings, type Settings } from '../../../src/contract/settings';
import { App } from '../../../src/renderer/app';
import { TooltipProvider } from '../../../src/renderer/components/ui/tooltip';
import { I18nProvider, type Lang } from '../../../src/renderer/i18n';
import type { ApiClient } from '../../../src/renderer/lib/api';
import { setCompareSelection } from '../../../src/renderer/lib/compare-selection';
import { ApiProvider } from '../../../src/renderer/lib/api-context';
import { SettingsProvider } from '../../../src/renderer/lib/settings';
import { createAppRouter } from '../../../src/renderer/routes/router';

// happy-dom's Web Animations reject on cancel; page transitions are irrelevant to these tests.
MotionGlobalConfig.skipAnimations = true;

// No vitest globals in this project: register Testing Library's cleanup explicitly.
afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-density');
  // What a test picked for "Confronta" stays in the module (and the storage) of the next one otherwise.
  setCompareSelection([]);
});

export interface FakeApi extends ApiClient {
  settings: Settings;
  emit(e: ServerEvent): void;
  setConnected(ok: boolean): void;
  calls: { method: string; path: string; body?: unknown }[];
}

/** In-memory ApiClient: settings round-trip, health, and a controllable event stream. */
export function fakeApi(initial: Partial<Settings> = {}, opts: { failSettings?: boolean } = {}): FakeApi {
  let onEvent: ((e: ServerEvent) => void) | undefined;
  let onStatus: ((ok: boolean) => void) | undefined;
  const api: FakeApi = {
    settings: { ...defaultSettings(), ...initial },
    calls: [],
    get: vi.fn(async <T,>(path: string) => {
      api.calls.push({ method: 'GET', path });
      if (path === '/api/health') return { ok: true, version: '0.1.0', pid: 1 } as T;
      if (path === '/api/settings') {
        if (opts.failSettings) throw new Error('settings unavailable');
        return { ...api.settings } as T;
      }
      throw new Error(`unexpected GET ${path}`);
    }) as ApiClient['get'],
    post: vi.fn(async () => ({})) as ApiClient['post'],
    put: vi.fn(async <T,>(path: string, body?: unknown) => {
      api.calls.push({ method: 'PUT', path, body });
      if (opts.failSettings) throw new Error('settings unavailable');
      api.settings = { ...api.settings, ...(body as Partial<Settings>) };
      return { ...api.settings } as T;
    }) as ApiClient['put'],
    del: vi.fn(async () => ({})) as ApiClient['del'],
    events: (e, s) => {
      onEvent = e;
      onStatus = s;
      s?.(true);
      return () => {
        onEvent = undefined;
        onStatus = undefined;
      };
    },
    emit: (e) => onEvent?.(e),
    setConnected: (ok) => onStatus?.(ok),
  };
  return api;
}

export function newQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
}

/** Renders the whole app on a memory history at `path`. */
export function renderApp(path: string, api: FakeApi = fakeApi({ onboardingDone: true })): RenderResult & { api: FakeApi; router: ReturnType<typeof createAppRouter> } {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  const result = render(<App api={api} router={router} queryClient={newQueryClient()} />);
  return Object.assign(result, { api, router });
}

/** Providers for isolated component tests (i18n + tooltips, optionally settings). */
export function renderUi(ui: ReactNode, opts: { lang?: Lang; withSettings?: boolean; api?: FakeApi } = {}): RenderResult {
  const inner = (
    <I18nProvider lang={opts.lang ?? 'it'}>
      <TooltipProvider delayDuration={0}>{ui}</TooltipProvider>
    </I18nProvider>
  );
  if (!opts.withSettings) return render(inner);
  const api = opts.api ?? fakeApi();
  return render(
    <ApiProvider api={api}>
      <QueryClientProvider client={newQueryClient()}>
        <SettingsProvider>{inner}</SettingsProvider>
      </QueryClientProvider>
    </ApiProvider>,
  );
}
