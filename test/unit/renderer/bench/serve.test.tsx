/** "Avvia solo il server" from the Benchmark page: plan, confirmation, downloads, GPU busy, ready, Stop. */
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerInfo, ServerPlan, StartServerRequest } from '../../../../src/contract/api';
import type { DownloadJob } from '../../../../src/contract/models';
import { renderApp } from '../helpers';
import { apiError, benchApi, curatedModel, deferred, localModel, serverInfo, serverPlanFor } from './world';

vi.mock('echarts/core', () => ({ use: vi.fn(), init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })) }));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({ AxisPointerComponent: {}, DataZoomComponent: {}, GridComponent: {}, LegendComponent: {}, MarkAreaComponent: {}, MarkLineComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

const clipboard = { writeText: vi.fn(async (_t: string) => undefined) };
beforeAll(() => {
  Object.assign(Element.prototype, { hasPointerCapture: () => false, releasePointerCapture: () => undefined, scrollIntoView: () => undefined });
});
beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
});
afterEach(() => {
  delete (window as { gpubench?: unknown }).gpubench;
});

const posted = (api: ReturnType<typeof benchApi>, path: string) => api.calls.filter((c) => c.method === 'POST' && c.path === path);
const serveButton = () => screen.getByRole('button', { name: 'Avvia solo il server' });
const notInstalled = () => benchApi().world.engines.map((e) => (e.kind === 'llamacpp-native' ? { ...e, installed: false, available: false } : e));
const job = (over: Partial<DownloadJob> = {}): DownloadJob => ({ id: 'j', label: 'g', files: [], dest: 'x', state: 'running', bytesDone: 0, createdAt: '2026-10-06T00:00:00.000Z', ...over });

async function ready(api: ReturnType<typeof benchApi>) {
  renderApp('/', api);
  await screen.findAllByText('≈ 1 min 35 s');
}

describe('Avvia solo il server (Benchmark page)', () => {
  it('shows the recommended context, the fit and the command, then the address; the panel lists it', async () => {
    const api = benchApi();
    await ready(api);
    await userEvent.click(serveButton());
    expect(await screen.findByText('32.768 token')).toBeTruthy();
    const dialog = screen.getByRole('dialog', { name: 'Avvia il server' });
    expect(within(dialog).getByText(/con llama\.cpp\. Altri programmi potranno usarlo finché non lo fermi\./)).toBeTruthy();
    expect(within(dialog).getByText(/È quanto testo il modello può leggere in una volta.*L’ho scelto perché entri bene nella tua scheda video\./)).toBeTruthy();
    expect(within(dialog).getByText('Entra perfettamente')).toBeTruthy();
    expect(within(dialog).getByText('Mentre il server è acceso non puoi fare benchmark: occupa la scheda video.')).toBeTruthy();
    expect(within(dialog).getByRole('region', { name: 'Comando esatto' }).textContent).toContain('-c 32768');
    expect(within(dialog).queryByText('Prima di avviarlo preparo')).toBeNull();
    // Beginners send no parameters: the core picks them for this card.
    expect(posted(api, '/api/servers/plan')[0]!.body).toEqual({ engine: { kind: 'llamacpp-native' }, model: { localId: 'qwen3-8b' } });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Avvia server' }));
    const done = await screen.findByRole('dialog', { name: 'Il server è pronto' });
    expect(within(done).getByText('Modello: Qwen3 8B · Contesto 32.768 token')).toBeTruthy();
    await userEvent.click(within(done).getByRole('button', { name: 'Copia l’indirizzo compatibile OpenAI' }));
    expect(clipboard.writeText).toHaveBeenCalledWith('http://127.0.0.1:5123/v1');
    await userEvent.click(within(done).getByRole('button', { name: 'Lascia acceso' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(posted(api, '/api/servers')[0]!.body).toEqual({ engine: { kind: 'llamacpp-native' }, model: { localId: 'qwen3-8b' } });
    // The running server is listed with its context, and the choices are remembered (the duration is not a server's).
    expect(await screen.findByRole('heading', { name: /Server attivi/ })).toBeTruthy();
    expect(screen.getByText('Contesto 32.768 token')).toBeTruthy();
    await waitFor(() => expect(api.settings).toMatchObject({ lastEngine: { kind: 'llamacpp-native' }, lastModelId: 'qwen3-8b', lastProfile: 'quick' }));
  });

  it('installs and downloads what is missing first, asks about a busy GPU, then starts', async () => {
    const api = benchApi({ engines: notInstalled(), local: [], curated: [curatedModel('gemma-12b')] });
    api.world.routes['POST /api/engines/llamacpp-native/install'] = () => ({ ok: true });
    api.world.routes['POST /api/downloads'] = () => job({ id: 'd1' });
    renderApp('/', api);
    await screen.findByText('Verrà scaricato prima del test: 2,3 GB');
    await userEvent.click(serveButton());
    const dialog = await screen.findByRole('dialog', { name: 'Avvia il server' });
    expect(await within(dialog).findByText('Prima di avviarlo preparo')).toBeTruthy();
    expect(within(dialog).getByText('Installo llama.cpp')).toBeTruthy();
    expect(within(dialog).getByText('Scarico gemma-12b · Q4_K_M')).toBeTruthy();
    expect(within(dialog).getByText('Il modello da usare. Resta sul PC anche dopo.')).toBeTruthy();
    expect(within(dialog).getByText('2,3 GB')).toBeTruthy();
    // Once everything is in place, the fresh preview sees another server on the GPU.
    api.world.serverPlan = () => serverPlanFor({ warnings: [{ code: 'VRAM_BUSY', params: { names: 'ollama.exe', pids: '77' } }] });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Avvia server' }));
    const progress = await screen.findByRole('dialog', { name: 'Preparo il server' });
    expect(within(progress).getByText('Appena è tutto pronto il server parte da solo.')).toBeTruthy();
    act(() => api.emit({ type: 'engine.install', kind: 'llamacpp-native', stage: 'done', bytesDone: 1, bytesTotal: 1 }));
    await waitFor(() => expect(posted(api, '/api/downloads')).toHaveLength(1));
    api.world.local = [localModel('gemma-12b')];
    act(() => api.emit({ type: 'download.update', job: job({ id: 'd1', state: 'done', bytesDone: 1, bytesTotal: 1 }) }));
    const busy = await screen.findByRole('dialog', { name: 'La scheda video è già occupata' });
    expect(within(busy).getByText(/Posso avviare il server lo stesso/)).toBeTruthy();
    expect(within(busy).getByText('ollama.exe (PID 77)')).toBeTruthy();
    await userEvent.click(within(busy).getByRole('button', { name: 'Continua comunque' }));
    expect(await screen.findByRole('dialog', { name: 'Il server è pronto' })).toBeTruthy();
    // The same request: the core finds the copy just downloaded.
    expect(posted(api, '/api/servers')[0]!.body).toEqual({ engine: { kind: 'llamacpp-native' }, model: { repo: 'org/gemma-12b-GGUF', file: 'gemma-12b.gguf', revision: 'b'.repeat(40) } });
    expect(posted(api, '/api/servers/plan')).toHaveLength(2);
  });

  it('a failed install says it could not prepare the server', async () => {
    const api = benchApi({ engines: notInstalled() });
    api.world.routes['POST /api/engines/llamacpp-native/install'] = () => {
      throw apiError('GITHUB_RATE_LIMITED');
    };
    renderApp('/', api);
    await screen.findByText('Verrà installato prima del test: 480 MB');
    await userEvent.click(serveButton());
    await userEvent.click(await screen.findByRole('button', { name: 'Avvia server' }));
    expect(await screen.findByRole('dialog', { name: 'Non sono riuscito a preparare il server' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'GitHub ha limitato le richieste' })).toBeTruthy();
  });

  it('no preview possible, then a benchmark in progress; a preview without context or fit', async () => {
    const api = benchApi();
    const plan = deferred<ServerPlan>();
    api.world.serverPlan = () => plan.promise as never;
    api.world.routes['POST /api/servers'] = () => {
      throw apiError('RUN_IN_PROGRESS', { runId: '01K6Y7Q2ZC4M8N3B5V9R1T0XWE' }, 409);
    };
    await ready(api);
    await userEvent.click(serveButton());
    // While the preview is on its way.
    expect(await screen.findByText('Controllo cosa serve e quanta memoria video c’è…')).toBeTruthy();
    await act(async () => plan.reject(apiError('NETWORK', undefined, 0)));
    let dialog = await screen.findByRole('dialog', { name: 'Avvia il server' });
    expect(await within(dialog).findByRole('heading', { name: 'Connessione a internet non disponibile' })).toBeTruthy();
    expect(within(dialog).queryByRole('region', { name: 'Comando esatto' })).toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Avvia server' }));
    dialog = await screen.findByRole('dialog', { name: 'Il server non è partito' });
    expect(within(dialog).getByRole('heading', { name: 'C’è già un test in corso' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Riprova' })).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cambia le scelte' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    api.world.serverPlan = () => serverPlanFor({ contextSize: undefined, fit: undefined, warnings: [{ code: 'gpu_memory_reduced', params: { utilization: 0.6, freeMiB: 20543, totalMiB: 32607 } }] });
    await userEvent.click(serveButton());
    dialog = await screen.findByRole('dialog', { name: 'Avvia il server' });
    expect(await within(dialog).findByText('vLLM userà meno memoria del solito')).toBeTruthy();
    expect(within(dialog).queryByText('Contesto')).toBeNull();
    expect(within(dialog).queryByText('Memoria video')).toBeNull();
  });

  it('closing while it loads: the server keeps starting and the panel lists it', async () => {
    const api = benchApi();
    const started = deferred<ServerInfo>();
    api.world.routes['POST /api/servers'] = () => started.promise;
    await ready(api);
    await userEvent.click(serveButton());
    await userEvent.click(await screen.findByRole('button', { name: 'Avvia server' }));
    expect(await screen.findByRole('dialog', { name: 'Avvio il server…' })).toBeTruthy();
    expect(screen.getByText('Avvio il motore e carico il modello…')).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    api.world.servers = [serverInfo('late', { contextSize: undefined })];
    await act(async () => started.resolve(api.world.servers[0]!));
    expect(await screen.findByRole('heading', { name: /Server attivi/ })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText(/Contesto/)).toBeNull();
  });

  it('expert parameters are sent as chosen', async () => {
    const api = benchApi();
    api.settings.expertMode = true;
    api.settings.lastParams = { contextSize: 16384, extraArgs: [], env: {} };
    api.world.serverPlan = (body) => serverPlanFor({ contextSize: 16384, params: (body as StartServerRequest).params! });
    await ready(api);
    await userEvent.click(serveButton());
    expect(await screen.findByText('16.384 token')).toBeTruthy();
    expect(screen.getByText(/Viene dalle impostazioni scelte\./)).toBeTruthy();
    expect((posted(api, '/api/servers/plan')[0]!.body as StartServerRequest).params).toMatchObject({ contextSize: 16384 });
    await userEvent.click(screen.getByRole('button', { name: 'Annulla' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('an external endpoint is already running: no server to start', async () => {
    const api = benchApi();
    api.settings.expertMode = true;
    api.settings.lastEngine = { kind: 'external', baseUrl: 'http://h:1' };
    renderApp('/', api);
    expect(await screen.findByText('Server già acceso: misuro soltanto')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Avvia benchmark' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Avvia solo il server' })).toBeNull();
  });
});
