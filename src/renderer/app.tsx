import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { Toaster } from './components/ui/toaster';
import { TooltipProvider } from './components/ui/tooltip';
import { I18nProvider } from './i18n';
import type { ApiClient } from './lib/api';
import { ApiProvider, EventsProvider } from './lib/api-context';
import { SettingsProvider, useSettings } from './lib/settings';
import { createAppRouter, type AppRouter } from './routes/router';

/** Language and toasts depend on settings, so they sit inside the settings provider. */
function Themed({ children }: { children: ReactNode }) {
  const { settings, resolvedTheme } = useSettings();
  return (
    <I18nProvider lang={settings.language}>
      <TooltipProvider delayDuration={250} skipDelayDuration={150}>
        {children}
        <Toaster theme={resolvedTheme} />
      </TooltipProvider>
    </I18nProvider>
  );
}

export interface AppProps {
  api: ApiClient;
  /** Tests inject a memory-history router; the app uses hash history. */
  router?: AppRouter;
  queryClient?: QueryClient;
}

export function App({ api, router, queryClient }: AppProps) {
  const [client] = useState(() => queryClient ?? new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } }));
  const [appRouter] = useState(() => router ?? createAppRouter());
  return (
    <ApiProvider api={api}>
      <QueryClientProvider client={client}>
        <EventsProvider>
          <SettingsProvider>
            <Themed>
              <RouterProvider router={appRouter} />
            </Themed>
          </SettingsProvider>
        </EventsProvider>
      </QueryClientProvider>
    </ApiProvider>
  );
}
