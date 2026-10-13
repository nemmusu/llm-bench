import { createHashHistory, createRootRoute, createRoute, createRouter, type RouterHistory } from '@tanstack/react-router';
import { validateModelsSearch } from '../components/library/catalog-search';
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
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/results',
    component: ResultsPage,
    // "Test" (default) or "Configurazioni".
    validateSearch: (s: Record<string, unknown>): { view?: 'configs' } => (s.view === 'configs' ? { view: 'configs' as const } : {}),
  }),
  createRoute({ getParentRoute: () => rootRoute, path: '/results/$runId', component: ResultPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/compare', component: ComparePage, validateSearch: validateCompareSearch }),
  // Tab and every catalog choice live in the URL (components/library/catalog-search.ts).
  createRoute({ getParentRoute: () => rootRoute, path: '/models', component: ModelsPage, validateSearch: validateModelsSearch }),
  createRoute({ getParentRoute: () => rootRoute, path: '/models/hub/$owner/$name', component: ModelDetailPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/engines', component: EnginesPage, validateSearch: validateEnginesSearch }),
  createRoute({ getParentRoute: () => rootRoute, path: '/monitor', component: MonitorPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: SettingsPage }),
]);

export function createAppRouter(history: RouterHistory = createHashHistory()) {
  // The content panel (#main) is the scrolling element: a new page starts at its top, "back" returns
  // to where the previous one was (the catalog's list, page after page).
  return createRouter({ routeTree, history, scrollRestoration: true, scrollToTopSelectors: ['#main'], defaultPreload: false });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter;
  }
}
