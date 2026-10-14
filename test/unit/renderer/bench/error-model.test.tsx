/**
 * A model the engine build cannot read, said plainly: the format (or architecture, or container) it
 * does not know; for a GGUF-NInfer model on the official NInfer, NInfer-all (built in one click, then the
 * same test again) instead of "Aggiorna NInfer", which would never read it; another variant that reads a
 * format with "Aggiungi <variant>"; "Aggiorna <engine>".
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { AppErrorData } from '../../../../src/contract/errors';
import { ErrorCard, fixFor } from '../../../../src/renderer/components/bench/error-card';
import { ApiProvider, EventsProvider } from '../../../../src/renderer/lib/api-context';
import { SettingsProvider } from '../../../../src/renderer/lib/settings';
import { useLibraryEvents } from '../../../../src/renderer/lib/queries-library';
import { newQueryClient, renderUi } from '../helpers';
import { benchApi, type BenchApi } from './world';

/** The app shell's folding of server events into the cache (a build's progress). */
function Events() {
  useLibraryEvents('it', () => undefined);
  return null;
}

function inRouter(ui: ReactNode, api: BenchApi = benchApi()) {
  const root = createRootRoute({
    component: () => (
      <>
        <Events />
        <Outlet />
      </>
    ),
  });
  const routes = ['/', '/engines'].map((path) => createRoute({ getParentRoute: () => root, path, component: () => (path === '/' ? <>{ui}</> : <p>page {path}</p>) }));
  const router = createRouter({ routeTree: root.addChildren(routes), history: createMemoryHistory({ initialEntries: ['/'] }) });
  renderUi(
    <ApiProvider api={api}>
      <EventsProvider>
        <QueryClientProvider client={newQueryClient()}>
          <SettingsProvider>
            <RouterProvider router={router} />
          </SettingsProvider>
        </QueryClientProvider>
      </EventsProvider>
    </ApiProvider>,
  );
  return router;
}

const layout: AppErrorData = {
  code: 'ENGINE_MODEL_UNSUPPORTED',
  message: 'NInfer cannot read this model (layout gguf_blocks_v1)',
  params: { engine: 'NInfer', reason: 'layout', value: 'gguf_blocks_v1', build: '81c8ce093b2c', template: 'ninfer-all', variant: 'NInfer-all' },
  detail: 'FATAL server failed during startup | weight/000130: unknown tensor layout: gguf_blocks_v1',
};

const builtAll = { kind: 'ninfer-wsl' as const, builds: [{ build: 'all' as const, kind: 'ninfer-wsl' as const, state: 'ready' as const, source: { url: 'https://github.com/iamwavecut/ninfer-all.git' }, dir: '/home/u/ninfer-all' }] };

describe('ErrorCard: a GGUF-NInfer model on the official NInfer', () => {
  it('why, in one sentence; NInfer-all not built: "Scarica e compila NInfer-all e riprova" builds it, then tries again', async () => {
    const retry = vi.fn();
    const api = benchApi();
    inRouter(<ErrorCard error={layout} handlers={{ retry }} model={{ weakKey: 'nerkyor/gguf', name: 'Qwen3.8-27B-Coder390-EfficientThink-Q6_K-MTP' }} />, api);
    expect(await screen.findByRole('heading', { name: 'Questa versione del motore non sa leggere il modello' })).toBeTruthy();
    expect(screen.getByText(/Il NInfer ufficiale non sa leggere il formato gguf_blocks_v1 di questo modello, nemmeno aggiornato/)).toBeTruthy();
    expect(fixFor('ENGINE_MODEL_UNSUPPORTED')).toBe('updateEngine');
    // An update of NInfer would never read it: not offered.
    expect(screen.queryByRole('button', { name: 'Aggiorna NInfer' })).toBeNull();
    await userEvent.click(await screen.findByRole('button', { name: 'Scarica e compila NInfer-all e riprova' }));
    const gate = await screen.findByRole('dialog', { name: 'Questo modello funziona solo con NInfer-all' });
    expect(await within(gate).findByText('Lo scarico (circa 38,4 MB) e lo compilo io dentro Ubuntu-24.04 (circa 10 min). Poi riparto da solo.')).toBeTruthy();
    await userEvent.click(within(gate).getByRole('button', { name: 'Scarica e compila' }));
    await waitFor(() => expect(api.calls.find((c) => c.path === '/api/engines/ninfer/build')?.body).toEqual({ kind: 'ninfer-wsl', distro: 'Ubuntu-24.04', build: 'all', dir: '/home/u/ninfer-all', confirm: true }));
    act(() => api.emit({ type: 'engine.install', kind: 'ninfer-all', stage: 'done', bytesDone: 0, result: { customEngineId: 'ninfer-all' } }));
    await waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('NInfer-all built: "Riprova con NInfer-all"; without a retry here, it opens NInfer-all\'s card or its build', async () => {
    const retry = vi.fn();
    inRouter(<ErrorCard error={layout} handlers={{ retry }} />, benchApi({ ninferBuilds: builtAll }));
    await userEvent.click(await screen.findByRole('button', { name: 'Riprova con NInfer-all' }));
    expect(retry).toHaveBeenCalledTimes(1);
    const router = inRouter(<ErrorCard error={layout} />, benchApi({ ninferBuilds: builtAll }));
    await userEvent.click(await screen.findByRole('button', { name: 'Apri NInfer-all' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/engines'));
    expect(router.state.location.search).toEqual({ ninfer: 'all' });
    inRouter(<ErrorCard error={layout} />, benchApi());
    expect((await screen.findAllByRole('button', { name: 'Scarica e compila NInfer-all' })).length).toBeGreaterThan(0);
  });
});

describe('ErrorCard: a model the engine cannot read', () => {
  it('a format another variant reads: "Aggiungi <variant>" opens its template for this model', async () => {
    const other: AppErrorData = { ...layout, params: { ...layout.params, template: 'prismml-bonsai', variant: 'PrismML' } };
    const router = inRouter(<ErrorCard error={other} model={{ weakKey: 'w', name: 'm' }} />);
    expect(await screen.findByText('Questo modello usa un formato (gguf_blocks_v1) che questa versione di NInfer non sa leggere. Serve una variante di NInfer che lo supporti, come PrismML.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Aggiorna NInfer' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Aggiungi PrismML' }));
    await waitFor(() => expect(router.state.location.search).toEqual({ customTemplate: 'prismml-bonsai', model: 'w', modelName: 'm' }));
    const bare = inRouter(<ErrorCard error={{ ...other, params: { ...other.params, reason: 'format' } }} />);
    await userEvent.click((await screen.findAllByRole('button', { name: 'Aggiungi PrismML' })).at(-1)!);
    await waitFor(() => expect(bare.state.location.search).toEqual({ customTemplate: 'prismml-bonsai' }));
    const named = inRouter(<ErrorCard error={other} model={{ name: 'n' }} />);
    await userEvent.click((await screen.findAllByRole('button', { name: 'Aggiungi PrismML' })).at(-1)!);
    await waitFor(() => expect(named.state.location.search).toEqual({ customTemplate: 'prismml-bonsai', modelName: 'n' }));
  });

  it('an architecture, an older container, a format no variant reads, a KV type the build does not have', async () => {
    const cards: AppErrorData[] = [
      { code: 'ENGINE_MODEL_UNSUPPORTED', message: 'x', params: { engine: 'llama.cpp', reason: 'architecture', value: 'qwen35' } },
      { code: 'ENGINE_MODEL_UNSUPPORTED', message: 'x', params: { engine: 'NInfer', reason: 'container', value: 'v2', needs: 'v3' } },
      { code: 'ENGINE_MODEL_UNSUPPORTED', message: 'x', params: { engine: 'NInfer', reason: 'format', value: 'q3_k_gguf' } },
      { code: 'ENGINE_BAD_FLAG', message: 'x', params: { flag: '--kv-dtype', value: 'rk8v4', values: 'bf16, int8, fp8, nvfp4, k8v4', reason: 'kv_dtype_unsupported' } },
      { code: 'ENGINE_BAD_FLAG', message: 'x', params: { flag: '--lm-head-draft', reason: 'proposal_head_missing' } },
      { code: 'ENGINE_NOT_INSTALLED', message: 'x', params: { reason: 'ninfer_all_missing', engine: 'NInfer-all' } },
    ];
    const router = inRouter(
      <>
        {cards.map((e) => (
          <ErrorCard key={String(e.params?.value ?? e.params?.reason)} error={e} />
        ))}
      </>,
    );
    expect(await screen.findByText(/Questo modello usa un’architettura \(qwen35\) che questa versione di llama\.cpp non conosce/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Aggiorna llama.cpp' })).toBeTruthy();
    expect(screen.getByText(/Questo file \.ninfer è nel formato v2, ma questa versione di NInfer legge solo il v3/)).toBeTruthy();
    expect(screen.getByText('Questo modello usa un formato (q3_k_gguf) che questa versione di NInfer non sa leggere. Aggiorna NInfer, oppure usa una sua variante che lo legga.')).toBeTruthy();
    expect(screen.getByText(/Questa versione di NInfer non ha la cache KV «rk8v4» \(ha: bf16, int8, fp8, nvfp4, k8v4\)/)).toBeTruthy();
    expect(screen.getByText(/Questo modello non ha la «testa di bozza ottimizzata» che --lm-head-draft richiede/)).toBeTruthy();
    expect(screen.getByText(/Questo modello funziona solo con NInfer-all, che non è ancora compilato/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Aggiungi/ })).toBeNull();
    // "Aggiorna llama.cpp": its card, in Motori.
    await userEvent.click(screen.getByRole('button', { name: 'Aggiorna llama.cpp' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/engines'));
  });
});
