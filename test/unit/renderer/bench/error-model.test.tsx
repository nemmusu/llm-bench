/**
 * A model the engine build cannot read, said plainly: the format (or architecture, or container) it
 * does not know, the variant that reads it with "Aggiungi NInfer-all" (the Engines page's template, for
 * this model), and "Aggiorna <engine>".
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import type { AppErrorData } from '../../../../src/contract/errors';
import { ErrorCard, fixFor } from '../../../../src/renderer/components/bench/error-card';
import { ApiProvider } from '../../../../src/renderer/lib/api-context';
import { newQueryClient, renderUi } from '../helpers';
import { benchApi } from './world';

function inRouter(ui: ReactNode) {
  const root = createRootRoute({ component: () => <Outlet /> });
  const routes = ['/', '/engines'].map((path) => createRoute({ getParentRoute: () => root, path, component: () => (path === '/' ? <>{ui}</> : <p>page {path}</p>) }));
  const router = createRouter({ routeTree: root.addChildren(routes), history: createMemoryHistory({ initialEntries: ['/'] }) });
  renderUi(
    <ApiProvider api={benchApi()}>
      <QueryClientProvider client={newQueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>
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

describe('ErrorCard: a model the engine cannot read', () => {
  it('the format and the variant that reads it; "Aggiungi NInfer-all" opens its template for this model', async () => {
    const router = inRouter(<ErrorCard error={layout} model={{ weakKey: 'nerkyor/gguf', name: 'Qwen3.8-27B-Coder390-EfficientThink-Q6_K-MTP' }} />);
    expect(await screen.findByRole('heading', { name: 'Questa versione del motore non sa leggere il modello' })).toBeTruthy();
    expect(screen.getByText('Questo modello usa un formato (gguf_blocks_v1) che questa versione di NInfer non sa leggere. Serve una variante di NInfer che lo supporti, come NInfer-all.')).toBeTruthy();
    expect(fixFor('ENGINE_MODEL_UNSUPPORTED')).toBe('updateEngine');
    await userEvent.click(screen.getByRole('button', { name: 'Aggiungi NInfer-all' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/engines'));
    expect(router.state.location.search).toEqual({ customTemplate: 'ninfer-all', model: 'nerkyor/gguf', modelName: 'Qwen3.8-27B-Coder390-EfficientThink-Q6_K-MTP' });
  });

  it('"Aggiorna NInfer" opens the Engines page; without the model the template alone', async () => {
    const router = inRouter(<ErrorCard error={layout} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Aggiorna NInfer' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/engines'));
    const bare = inRouter(<ErrorCard error={{ ...layout, params: { ...layout.params, reason: 'format' } }} />);
    expect((await screen.findAllByText(/Serve una variante di NInfer che lo supporti, come NInfer-all/)).length).toBeGreaterThan(0);
    await userEvent.click(screen.getAllByRole('button', { name: 'Aggiungi NInfer-all' }).at(-1)!);
    await waitFor(() => expect(bare.state.location.search).toEqual({ customTemplate: 'ninfer-all' }));
    const again = inRouter(<ErrorCard error={layout} model={{ name: 'm' }} />);
    await userEvent.click((await screen.findAllByRole('button', { name: 'Aggiungi NInfer-all' })).at(-1)!);
    await waitFor(() => expect(again.state.location.search).toEqual({ customTemplate: 'ninfer-all', modelName: 'm' }));
  });

  it('an architecture, an older container, a format no variant reads, a KV type the build does not have', async () => {
    const cards: AppErrorData[] = [
      { code: 'ENGINE_MODEL_UNSUPPORTED', message: 'x', params: { engine: 'llama.cpp', reason: 'architecture', value: 'qwen35' } },
      { code: 'ENGINE_MODEL_UNSUPPORTED', message: 'x', params: { engine: 'NInfer', reason: 'container', value: 'v2', needs: 'v3' } },
      { code: 'ENGINE_MODEL_UNSUPPORTED', message: 'x', params: { engine: 'NInfer', reason: 'format', value: 'q3_k_gguf' } },
      { code: 'ENGINE_BAD_FLAG', message: 'x', params: { flag: '--kv-dtype', value: 'rk8v4', values: 'bf16, int8, fp8, nvfp4, k8v4', reason: 'kv_dtype_unsupported' } },
    ];
    inRouter(
      <>
        {cards.map((e) => (
          <ErrorCard key={String(e.params?.value)} error={e} />
        ))}
      </>,
    );
    expect(await screen.findByText(/Questo modello usa un’architettura \(qwen35\) che questa versione di llama\.cpp non conosce/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Aggiorna llama.cpp' })).toBeTruthy();
    expect(screen.getByText(/Questo file \.ninfer è nel formato v2, ma questa versione di NInfer legge solo il v3/)).toBeTruthy();
    expect(screen.getByText('Questo modello usa un formato (q3_k_gguf) che questa versione di NInfer non sa leggere. Aggiorna NInfer, oppure usa una sua variante che lo legga.')).toBeTruthy();
    expect(screen.getByText(/Questa versione di NInfer non ha la cache KV «rk8v4» \(ha: bf16, int8, fp8, nvfp4, k8v4\)/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Aggiungi/ })).toBeNull();
  });
});
