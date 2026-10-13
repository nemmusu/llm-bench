import { createHashHistory, createRootRoute, createRoute, createRouter, type RouterHistory } from '@tanstack/react-router';
import { AppShell } from '../components/shell/app-shell';
import { BenchmarkPage } from './benchmark';
import { ComparePage, validateCompareSearch } from './compare';
import { EnginesPage, validateEnginesSearch } from './engines';
import { ModelDetailPage } from './model-detail';
import { ModelsPage } from './models';
import { MonitorPage } from './monitor';
import { NotFoundPage } from './not-found';
import { ResultPage } from './result';
import { ResultsPage } from './results';
import { RunPage } from './run';
import { ServerStartPage } from './server-start';
import { ServersPage } from './servers';
import { SettingsPage } from './settings';
import { WelcomePage } from './welcome';

/**
 * Code-based route tree. Hash history keeps every URL on the core's single index.html, so the
 * static server never needs to know client routes.
 */
const rootRoute = createRootRoute({ component: AppShell, notFoundComponent: NotFoundPage });

const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: '/', component: BenchmarkPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/welcome', component: WelcomePage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/run/$runId', component: RunPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/servers', component: ServersPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/servers/new', component: ServerStartPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/results',
    component: ResultsPage,
    // "Test" (default) or "Configurazioni".
    validateSearch: (s: Record<string, unknown>): { view?: 'configs' } => (s.view === 'configs' ? { view: 'configs' as const } : {}),
  }),
  createRoute({ getParentRoute: () => rootRoute, path: '/results/$runId', component: ResultPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/compare', component: ComparePage, validateSearch: validateCompareSearch }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/models',
    component: ModelsPage,
    validateSearch: (s: Record<string, unknown>): { tab?: 'download'; view?: 'curated' | 'tried' } => ({
      ...(s.tab === 'download' ? { tab: 'download' as const } : {}),
      ...(s.view === 'curated' || s.view === 'tried' ? { view: s.view } : {}),
    }),
  }),
  createRoute({ getParentRoute: () => rootRoute, path: '/models/hub/$owner/$name', component: ModelDetailPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/engines', component: EnginesPage, validateSearch: validateEnginesSearch }),
  createRoute({ getParentRoute: () => rootRoute, path: '/monitor', component: MonitorPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: SettingsPage }),
]);

export function createAppRouter(history: RouterHistory = createHashHistory()) {
  return createRouter({ routeTree, history, scrollRestoration: true, defaultPreload: false });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter;
  }
}
