import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider, Outlet, createRoute } from '@tanstack/react-router';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppErrorData, ErrorCode } from '../../../../src/contract/errors';
import { ErrorCard, fixFor } from '../../../../src/renderer/components/bench/error-card';
import { RecentRuns } from '../../../../src/renderer/components/bench/recent-runs';
import { ServersPanel } from '../../../../src/renderer/components/bench/servers';
import { ApiProvider } from '../../../../src/renderer/lib/api-context';
import { newQueryClient, renderUi } from '../helpers';
import { IDS, seeded, seededRuns } from './fixtures';
import { apiError, benchApi, deferred, serverInfo } from './world';

const clipboard = { writeText: vi.fn(async (_t: string) => undefined) };
beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
});
afterEach(() => vi.restoreAllMocks());

/** Renders `ui` inside a router (for links/navigation) with the fake API. */
function inRouter(ui: ReactNode, api = benchApi()) {
  const root = createRootRoute({ component: () => <Outlet /> });
  const routes = ['/', '/engines', '/models', '/settings', '/welcome', '/results', '/run/$runId', '/results/$runId'].map((path) =>
    createRoute({ getParentRoute: () => root, path, component: () => (path === '/' ? <>{ui}</> : <p>page {path}</p>) }),
  );
  const router = createRouter({ routeTree: root.addChildren(routes), history: createMemoryHistory({ initialEntries: ['/'] }) });
  const view = renderUi(
    <ApiProvider api={api}>
      <QueryClientProvider client={newQueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ApiProvider>,
  );
  return { ...view, router, api };
}

describe('ErrorCard', () => {
  const cases: [ErrorCode, string, string][] = [
    ['ENGINE_NOT_INSTALLED', 'Apri Motori', '/engines'],
    ['MODEL_NOT_FOUND', 'Apri Modelli', '/models'],
    ['ENGINE_OOM', 'Scegli un altro modello', '/'],
    ['HF_AUTH_REQUIRED', 'Apri Impostazioni', '/settings'],
    ['DRIVER_MISSING', 'Ricontrolla il sistema', '/welcome'],
    ['RUN_NOT_FOUND', 'Torna ai risultati', '/results'],
  ];
  for (const [code, label, path] of cases) {
    it(`${code} → ${label}`, async () => {
      const { router } = inRouter(<ErrorCard error={{ code, message: 'm' }} />);
      await userEvent.click(await screen.findByRole('button', { name: label }));
      await waitFor(() => expect(router.state.location.pathname).toBe(path));
    });
  }

  it('the running test, retry handlers, and no button without a way forward', async () => {
    const { router } = inRouter(<ErrorCard error={{ code: 'RUN_IN_PROGRESS', message: '', params: { runId: 'r1' } }} headingLevel={3} />);
    expect(await screen.findByRole('heading', { level: 3, name: 'C’è già un test in corso' })).toBeTruthy();
    expect(screen.queryByText('Dettagli tecnici')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Vai al test in corso' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/run/r1'));
    expect(fixFor('NETWORK')).toBe('retry');
  });

  it('messages carry the error params (the missing library and its package)', async () => {
    inRouter(<ErrorCard error={{ code: 'ENGINE_MISSING_LIBRARY', message: 'x', params: { library: 'libgomp.so.1', package: 'libgomp1' } }} />);
    expect(await screen.findByRole('heading', { name: 'Manca una libreria di sistema: libgomp.so.1' })).toBeTruthy();
    expect(screen.getByText(/«sudo apt install libgomp1»/)).toBeTruthy();
    expect(fixFor('ENGINE_MISSING_LIBRARY')).toBe('retry');
  });

  it('without handlers some errors have no button', async () => {
    const errs: AppErrorData[] = [
      { code: 'RUN_IN_PROGRESS', message: 'x' },
      { code: 'NETWORK', message: 'x' },
      { code: 'VRAM_BUSY', message: 'x' },
    ];
    inRouter(
      <>
        {errs.map((e) => (
          <ErrorCard key={e.code} error={e} />
        ))}
      </>,
    );
    expect(await screen.findAllByText('Cosa fare:')).toHaveLength(3);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});

describe('ServersPanel', () => {
  const server = serverInfo('s1', { port: 5000, contextSize: undefined, startedAt: new Date(Date.now() - 120_000).toISOString() });

  it('lists running servers, copies the address, stops them', async () => {
    const api = benchApi({ servers: [server] });
    let fail = true;
    api.world.routes['DELETE /api/servers/s1'] = () => {
      if (fail) throw apiError('VALIDATION');
      api.world.servers = [];
      return { ok: true };
    };
    const error = vi.spyOn(toast, 'error');
    const success = vi.spyOn(toast, 'success');
    inRouter(<ServersPanel />, api);
    expect(await screen.findByRole('heading', { name: /Server attivi/ })).toBeTruthy();
    expect(screen.getByText(/llama\.cpp b11438 · avviato 2 minuti fa/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Copia l’indirizzo compatibile OpenAI' }));
    expect(clipboard.writeText).toHaveBeenCalledWith('http://127.0.0.1:5000/v1');
    await userEvent.click(screen.getByRole('button', { name: 'Ferma il server di Qwen3 8B' }));
    await waitFor(() => expect(error).toHaveBeenCalledWith('Alcuni valori non sono validi'));
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Ferma il server di Qwen3 8B' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: /Server attivi/ })).toBeNull());
    expect(success).toHaveBeenCalledWith('Server di Qwen3 8B fermato');
  });
});

describe('RecentRuns', () => {
  it('loading, empty, and a speed history', async () => {
    const api = benchApi({ runs: [] });
    const gate = deferred<unknown>();
    api.world.routes['GET /api/runs'] = () => gate.promise;
    const { container } = inRouter(<RecentRuns />, api);
    await waitFor(() => expect(container.querySelectorAll('.skeleton-shimmer').length).toBe(3));
    await act(async () => gate.resolve([]));
    expect(await screen.findByText('Qui vedrai i tuoi test più recenti.')).toBeTruthy();
  });

  it('shows sparklines when a model was measured more than once', async () => {
    const older = { ...seeded(IDS.full), id: '01K6A00000000000000000000A', createdAt: '2026-09-01T10:00:00.000Z' };
    const noSpeed = { ...seeded(IDS.full), id: '01K6A00000000000000000000B', createdAt: '2026-10-07T10:00:00.000Z', metrics: { ...seeded(IDS.full).metrics, latency: [] } };
    const { container } = inRouter(<RecentRuns limit={3} />, benchApi({ runs: [...seededRuns(), older, noSpeed] }));
    expect(await screen.findByText('Qwen3 8B · Q4_K_M', { selector: 'span' }).catch(() => screen.findAllByText('Qwen3 8B · Q4_K_M'))).toBeTruthy();
    await waitFor(() => expect(container.querySelectorAll('svg').length).toBeGreaterThan(1));
    expect(screen.getByText('–')).toBeTruthy();
  });
});
