import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StartRunRequest } from '../../../../src/contract/api';
import type { DownloadJob } from '../../../../src/contract/models';
import { renderApp } from '../helpers';
import { apiError, benchApi, curatedModel, deferred, localModel, planFor, activeRun, serverInfo } from './world';

vi.mock('echarts/core', () => ({ use: vi.fn(), init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })) }));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({ AxisPointerComponent: {}, DataZoomComponent: {}, GridComponent: {}, LegendComponent: {}, MarkAreaComponent: {}, MarkLineComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

beforeAll(() => {
  Object.assign(Element.prototype, { hasPointerCapture: () => false, releasePointerCapture: () => undefined, scrollIntoView: () => undefined });
});

afterEach(() => {
  delete (window as { gpubench?: unknown }).gpubench;
  vi.useRealTimers();
});

const h1 = (name: string | RegExp) => screen.findByRole('heading', { level: 1, name });
const start = () => userEvent.click(screen.getByRole('button', { name: 'Avvia benchmark' }));
const posted = (api: ReturnType<typeof benchApi>, path: string) => api.calls.filter((c) => c.method === 'POST' && c.path === path);

async function choose(combobox: string, option: string | RegExp) {
  const trigger = screen.getByRole('combobox', { name: combobox });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
  fireEvent.click(await screen.findByRole('option', { name: option }));
}

describe('benchmark home', () => {
  it('shows the choices, the plan preview, and starts the run', async () => {
    const api = benchApi();
    renderApp('/', api);
    expect(await screen.findByRole('heading', { name: 'Pronto a misurare la tua RTX 5090' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: /Cambia modello: qwen3-8b model Q4_K_M/ })).toBeTruthy();
    expect((await screen.findAllByText('≈ 1 min 35 s')).length).toBe(2);
    expect(screen.getByText('1 caricamento a caldo · prompt da 512 token, 128 token generati, 3 ripetizioni')).toBeTruthy();
    expect(screen.getAllByText('Entra perfettamente').length).toBeGreaterThan(0);
    expect(screen.getByText('Installato · b11438')).toBeTruthy();
    expect(await screen.findByText(/Provato su questa GPU/)).toBeTruthy();
    expect(screen.getByText('Ultimi risultati')).toBeTruthy();
    // The command preview is folded for beginners.
    await userEvent.click(screen.getByRole('button', { name: /Anteprima comando/ }));
    expect(screen.getByRole('region', { name: 'Anteprima comando' }).textContent).toContain('llama-server -m m.gguf');
    await userEvent.click(screen.getByRole('radio', { name: /Standard/ }));
    await waitFor(() => expect(posted(api, '/api/runs/plan').some((c) => (c.body as StartRunRequest).profile === 'standard')).toBe(true));
    await start();
    expect(await h1('Test in corso')).toBeTruthy();
    const req = posted(api, '/api/runs')[0]!.body as StartRunRequest;
    expect(req).toMatchObject({ engine: { kind: 'llamacpp-native' }, model: { localId: 'qwen3-8b' }, profile: 'standard', allowSharedGpu: false });
    await waitFor(() => expect(api.settings).toMatchObject({ lastEngine: { kind: 'llamacpp-native' }, lastModelId: 'qwen3-8b', lastProfile: 'standard' }));
  });

  it('installs llama.cpp first, with progress, after one confirmation', async () => {
    const api = benchApi({ engines: benchApi().world.engines.map((e) => (e.kind === 'llamacpp-native' ? { ...e, installed: false, available: false } : e)) });
    api.world.routes['POST /api/engines/llamacpp-native/install'] = () => ({ ok: true });
    renderApp('/', api);
    // Before the plan arrives the status already says llama.cpp is missing; the plan adds its size.
    expect(await screen.findByText('Verrà installato prima del test')).toBeTruthy();
    expect(await screen.findByText('Verrà installato prima del test: 480 MB')).toBeTruthy();
    expect(screen.getByText('Prima scarico llama.cpp: 480 MB in tutto.')).toBeTruthy();
    // The whole preview is there before the install: duration, steps, what is prepared first, the command.
    expect(screen.getAllByText('≈ 1 min 35 s').length).toBe(2);
    expect(screen.getByText('Da preparare')).toBeTruthy();
    expect(screen.getByText('· verrà installato prima del test')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /Anteprima comando/ }));
    expect(screen.getByText('llama.cpp non è ancora installato: il comando usa già la cartella dove lo installerò prima del test.')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Anteprima comando' }).textContent).toContain('llama-server -m m.gguf');
    await start();
    const dialog = await screen.findByRole('dialog', { name: 'Prima di iniziare scarico quello che manca' });
    expect(within(dialog).getByText('Installo llama.cpp')).toBeTruthy();
    expect(within(dialog).getByText('480 MB')).toBeTruthy();
    api.world.engines = api.world.engines.map((e) => (e.kind === 'llamacpp-native' ? { ...e, installed: true, available: true } : e));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Scarica e avvia' }));
    const progress = await screen.findByRole('dialog', { name: 'Preparo il test' });
    act(() => api.emit({ type: 'engine.install', kind: 'other', stage: 'download', bytesDone: 1 }));
    act(() => api.emit({ type: 'runs.changed' }));
    act(() => api.emit({ type: 'engine.install', kind: 'llamacpp-native', stage: 'resolve', bytesDone: 0 }));
    expect(within(progress).getByText('Cerco la versione giusta…')).toBeTruthy();
    act(() => api.emit({ type: 'engine.install', kind: 'llamacpp-native', stage: 'download', bytesDone: 1024 * 1024, bytesTotal: 4 * 1024 * 1024 }));
    expect(within(progress).getByText('Scarico…')).toBeTruthy();
    expect(within(progress).getByRole('progressbar', { name: 'llama.cpp' }).getAttribute('aria-valuetext')).toBe('1,0 MB di 4,0 MB');
    act(() => api.emit({ type: 'engine.install', kind: 'llamacpp-native', stage: 'smoke', bytesDone: 4, bytesTotal: 4 }));
    act(() => api.emit({ type: 'engine.install', kind: 'llamacpp-native', stage: 'weird', bytesDone: 4, bytesTotal: 4 }));
    expect(within(progress).getByText('Un momento…')).toBeTruthy();
    act(() => api.emit({ type: 'engine.install', kind: 'llamacpp-native', stage: 'done', bytesDone: 4, bytesTotal: 4 }));
    expect(await h1('Test in corso')).toBeTruthy();
    // The live screen lists the install as done.
    expect(screen.getByRole('list', { name: 'Fasi del test' }).textContent).toContain('Installazione');
  });

  it('reports a failed install and can retry or give up', async () => {
    const api = benchApi({ engines: benchApi().world.engines.map((e) => (e.kind === 'llamacpp-native' ? { ...e, installed: false, available: false } : e)), installBytes: null });
    let fail = true;
    api.world.routes['POST /api/engines/llamacpp-native/install'] = () => {
      if (fail) throw apiError('GITHUB_RATE_LIMITED');
      return { ok: true };
    };
    renderApp('/', api);
    expect(await screen.findByText('Prima scarico llama.cpp.')).toBeTruthy();
    expect(screen.getByText('Verrà installato prima del test')).toBeTruthy();
    await start();
    expect(screen.getByText('dimensione da verificare')).toBeTruthy();
    expect(screen.getByText('Lo faccio io, poi il test parte da solo.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Scarica e avvia' }));
    expect(await screen.findByRole('heading', { name: 'GitHub ha limitato le richieste' })).toBeTruthy();
    expect(within(screen.getByRole('dialog')).getByText('Non riuscito')).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Riprova' }));
    act(() =>
      api.emit({ type: 'engine.install', kind: 'llamacpp-native', stage: 'error', bytesDone: 0, error: { code: 'ENGINE_INSTALL_FAILED', message: 'bad zip' } }),
    );
    expect(await screen.findByRole('heading', { name: 'Installazione del motore non riuscita' })).toBeTruthy();
    await userEvent.click(within(screen.getByRole('dialog')).getAllByRole('button', { name: 'Chiudi' }).at(-1)!);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('downloads a suggested model, then benchmarks the downloaded copy', async () => {
    const api = benchApi({ local: [], curated: [curatedModel('gemma-12b')] });
    const job: DownloadJob = { id: 'j1', label: 'gemma', files: [{ path: 'gemma-12b.gguf' }], dest: 'C:\\models', state: 'queued', bytesDone: 0, createdAt: '2026-10-06T00:00:00.000Z' };
    api.world.routes['POST /api/downloads'] = () => job;
    renderApp('/', api);
    expect(await screen.findByText('Verrà scaricato prima del test: 2,3 GB')).toBeTruthy();
    // The preview is planned before the download: the suggestion is named by repo and file.
    await waitFor(() => expect(posted(api, '/api/runs/plan')).toHaveLength(1));
    expect((posted(api, '/api/runs/plan')[0]!.body as StartRunRequest).model).toEqual({ repo: 'org/gemma-12b-GGUF', file: 'gemma-12b.gguf', revision: 'b'.repeat(40) });
    expect(await screen.findByText('· verrà scaricato prima del test')).toBeTruthy();
    expect(screen.getAllByText('Entra perfettamente').length).toBe(2);
    await userEvent.click(screen.getByRole('button', { name: /Anteprima comando/ }));
    expect(screen.getByText('Il modello non è ancora sul PC: il comando usa già il percorso dove lo salverò prima del test.')).toBeTruthy();
    await start();
    expect(await screen.findByText('Scarico gemma-12b · Q4_K_M')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Scarica e avvia' }));
    await waitFor(() => expect(posted(api, '/api/downloads')).toHaveLength(1));
    expect(posted(api, '/api/downloads')[0]!.body).toMatchObject({ repo: 'org/gemma-12b-GGUF', files: ['gemma-12b.gguf'], label: 'gemma-12b · Q4_K_M' });
    api.world.local = [localModel('gemma-12b')];
    act(() => api.emit({ type: 'download.update', job: { ...job, id: 'other', state: 'done' } }));
    act(() => api.emit({ type: 'download.update', job: { ...job, state: 'running', bytesDone: 1024 ** 3, bytesTotal: 2 * 1024 ** 3 } }));
    await waitFor(() => expect(screen.getByRole('progressbar', { name: 'gemma-12b · Q4_K_M' }).getAttribute('aria-valuetext')).toBe('1,0 GB di 2,0 GB'));
    act(() => api.emit({ type: 'download.update', job: { ...job, state: 'verifying', bytesDone: 2, bytesTotal: 2 } }));
    act(() => api.emit({ type: 'download.update', job: { ...job, state: 'done', bytesDone: 2, bytesTotal: 2 } }));
    expect(await h1('Test in corso')).toBeTruthy();
    // The same request: the core resolves the downloaded copy (the library was rescanned first).
    expect(posted(api, '/api/models/rescan').length).toBeGreaterThan(0);
    expect((posted(api, '/api/runs')[0]!.body as StartRunRequest).model).toEqual({ repo: 'org/gemma-12b-GGUF', file: 'gemma-12b.gguf', revision: 'b'.repeat(40) });
    expect(screen.getByRole('list', { name: 'Fasi del test' }).textContent).toContain('Download');
  });

  it('a download that finished before its id was known, a copy the core cannot find, a failed one', async () => {
    const api = benchApi({ local: [], curated: [curatedModel('gemma-12b')] });
    const job: DownloadJob = { id: 'j1', label: 'g', files: [], dest: 'x', state: 'queued', bytesDone: 0, createdAt: '2026-10-06T00:00:00.000Z' };
    const answer = deferred<DownloadJob>();
    api.world.routes['POST /api/downloads'] = () => answer.promise;
    api.world.routes['POST /api/runs'] = () => {
      throw apiError('MODEL_NOT_FOUND', { reason: 'not_downloaded' });
    };
    renderApp('/', api);
    await screen.findByText('Verrà scaricato prima del test: 2,3 GB');
    await start();
    await userEvent.click(screen.getByRole('button', { name: 'Scarica e avvia' }));
    await waitFor(() => expect(posted(api, '/api/downloads')).toHaveLength(1));
    act(() => api.emit({ type: 'download.update', job: { ...job, state: 'done', bytesDone: 5, bytesTotal: 5 } }));
    // Finished before its id was known; then the core still cannot find the copy.
    await act(async () => answer.resolve(job));
    expect(await screen.findByRole('dialog', { name: 'Il test non è partito' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Modello non trovato' })).toBeTruthy();
    await userEvent.keyboard('{Escape}');

    // Again: this time the download fails.
    api.world.routes['POST /api/downloads'] = () => job;
    await start();
    await userEvent.click(await screen.findByRole('button', { name: 'Scarica e avvia' }));
    await waitFor(() => expect(posted(api, '/api/downloads')).toHaveLength(2));
    act(() => api.emit({ type: 'download.update', job: { ...job, state: 'failed', bytesDone: 1, error: { code: 'DOWNLOAD_CHECKSUM', message: 'sha mismatch' } } }));
    expect(await screen.findByRole('heading', { name: 'Il file scaricato è danneggiato' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Riprova' }));
    await waitFor(() => expect(posted(api, '/api/downloads')).toHaveLength(3));
    act(() => api.emit({ type: 'download.update', job: { ...job, state: 'cancelled', bytesDone: 1 } }));
    expect(await screen.findByRole('heading', { name: 'Download non riuscito' })).toBeTruthy();

    // A POST that fails outright.
    api.world.routes['POST /api/downloads'] = () => {
      throw apiError('HF_GATED');
    };
    await userEvent.click(screen.getByRole('button', { name: 'Riprova' }));
    expect(await screen.findByRole('heading', { name: 'Serve accettare la licenza del modello' })).toBeTruthy();
  });

  it('closing during a download cancels it and ignores late answers', async () => {
    const api = benchApi({ local: [], curated: [curatedModel('gemma-12b')] });
    const job: DownloadJob = { id: 'j9', label: 'g', files: [], dest: 'x', state: 'running', bytesDone: 0, createdAt: '2026-10-06T00:00:00.000Z' };
    api.world.routes['POST /api/downloads'] = () => job;
    api.world.routes['POST /api/downloads/j9/cancel'] = () => job;
    renderApp('/', api);
    await screen.findByText('Verrà scaricato prima del test: 2,3 GB');
    await start();
    await userEvent.click(screen.getByRole('button', { name: 'Scarica e avvia' }));
    await waitFor(() => expect(posted(api, '/api/downloads')).toHaveLength(1));
    await userEvent.click(screen.getByRole('button', { name: 'Annulla' }));
    await waitFor(() => expect(posted(api, '/api/downloads/j9/cancel')).toHaveLength(1));
    expect(screen.queryByRole('dialog')).toBeNull();

    // A second attempt closed while POST /api/downloads is still pending: its late answer is ignored.
    const late = deferred<DownloadJob>();
    api.world.routes['POST /api/downloads'] = () => late.promise;
    await start();
    await userEvent.click(screen.getByRole('button', { name: 'Scarica e avvia' }));
    await waitFor(() => expect(posted(api, '/api/downloads')).toHaveLength(2));
    await userEvent.keyboard('{Escape}');
    await act(async () => late.reject(apiError('NETWORK')));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a vLLM repo the library does not have is downloaded whole first', async () => {
    const api = benchApi();
    api.settings.lastEngine = { kind: 'vllm-docker' };
    api.settings.lastModelId = 'curated:vllm-4b';
    api.world.plan = () => planFor({ needs: [{ kind: 'model', label: 'Qwen/Qwen3-4B-AWQ', bytes: 2 * 1024 ** 3 }] });
    const job: DownloadJob = { id: 'v1', label: 'q', files: [], dest: 'x', state: 'done', bytesDone: 2, bytesTotal: 2, createdAt: '2026-10-06T00:00:00.000Z' };
    api.world.routes['POST /api/downloads'] = () => job;
    renderApp('/', api);
    expect(await screen.findByText('Verrà scaricato prima del test: 2,0 GB')).toBeTruthy();
    await start();
    expect(await screen.findByText('Scarico vllm-4b · Q4_K_M')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Scarica e avvia' }));
    expect(await h1('Test in corso')).toBeTruthy();
    expect(posted(api, '/api/downloads')[0]!.body).toMatchObject({ repo: 'Qwen/Qwen3-4B-AWQ', files: ['*'] });
    expect((posted(api, '/api/runs')[0]!.body as StartRunRequest).model).toEqual({ repo: 'Qwen/Qwen3-4B-AWQ', revision: 'b'.repeat(40) });
  });

  it('asks before measuring on a busy GPU, and handles the other start errors', async () => {
    const api = benchApi();
    api.world.plan = () => planFor({ warnings: [{ code: 'VRAM_BUSY', params: { names: 'llama-server.exe', pids: '4242' } }] });
    renderApp('/', api);
    expect(await screen.findByText('Altri server stanno usando la scheda video')).toBeTruthy();
    await start();
    const busy = await screen.findByRole('dialog', { name: 'La scheda video è già occupata' });
    expect(within(busy).getByText('llama-server.exe (PID 4242)')).toBeTruthy();
    await userEvent.click(within(busy).getByRole('button', { name: 'Annulla' }));
    await start();
    await userEvent.click(await screen.findByRole('button', { name: 'Continua comunque' }));
    expect(await h1('Test in corso')).toBeTruthy();
    expect((posted(api, '/api/runs')[0]!.body as StartRunRequest).allowSharedGpu).toBe(true);
  });

  it('GPU busy when starting: other programs, or an LLM Bench server to stop first', async () => {
    const api = benchApi();
    let answer: 'memory' | 'own' | 'progress' | 'internal' | 'ok' = 'memory';
    api.world.routes['POST /api/runs'] = () => {
      if (answer === 'memory') throw apiError('VRAM_BUSY', { names: '', pids: '' });
      if (answer === 'own') throw apiError('VRAM_BUSY', { reason: 'own_server' });
      if (answer === 'progress') throw apiError('RUN_IN_PROGRESS', { runId: '01K6Y7Q2ZC4M8N3B5V9R1T0XWE' }, 409);
      if (answer === 'internal') throw new Error('boom');
      api.world.active = activeRun('01M48PNN41KKD0ABVXTGK97Y6P');
      return { runId: '01M48PNN41KKD0ABVXTGK97Y6P' };
    };
    api.world.servers = [serverInfo('s1', { port: 5000, modelName: 'Qwen', modelLabel: 'Qwen', engineLabel: 'llama.cpp', startedAt: '2026-10-06T10:00:00.000Z' })];
    api.world.routes['DELETE /api/servers/s1'] = () => ({ ok: true });
    renderApp('/', api);
    await screen.findAllByText('≈ 1 min 35 s');
    await start();
    expect(await screen.findByText('Programmi non identificati')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Annulla' }));

    answer = 'own';
    await start();
    const own = await screen.findByRole('dialog', { name: 'Un server avviato da LLM Bench sta usando la scheda video' });
    expect(within(own).getByText('Qwen · http://127.0.0.1:5000')).toBeTruthy();
    answer = 'internal';
    await userEvent.click(within(own).getByRole('button', { name: 'Ferma il server e avvia' }));
    expect(await screen.findByRole('dialog', { name: 'Il test non è partito' })).toBeTruthy();
    expect(api.calls.some((c) => c.method === 'DELETE' && c.path === '/api/servers/s1')).toBe(true);
    expect(screen.getByRole('heading', { name: 'Si è verificato un errore imprevisto' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Cambia le scelte' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    answer = 'progress';
    await start();
    expect(await screen.findByRole('heading', { name: 'C’è già un test in corso' })).toBeTruthy();
    answer = 'ok';
    await userEvent.click(screen.getByRole('button', { name: 'Vai al test in corso' }));
    expect(await h1(/Test in corso|Qwen3 8B/)).toBeTruthy();
  });

  it('retries a failed start from the error dialog', async () => {
    const api = benchApi();
    let fail = true;
    api.world.routes['POST /api/runs'] = () => {
      if (fail) throw apiError('ENGINE_PORT_IN_USE');
      api.world.active = activeRun('01M48PNN41KKD0ABVXTGK97Y6P');
      return { runId: '01M48PNN41KKD0ABVXTGK97Y6P' };
    };
    renderApp('/', api);
    await screen.findAllByText('≈ 1 min 35 s');
    await start();
    expect(await screen.findByRole('heading', { name: 'La porta di rete è già occupata' })).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Riprova' }));
    expect(await h1('Test in corso')).toBeTruthy();
  });
});

describe('benchmark choices', () => {
  it('engine footers: Docker problems, no version, loading, external', async () => {
    const api = benchApi();
    const status = deferred<unknown>();
    api.world.routes['GET /api/engines'] = () => status.promise;
    const { router } = renderApp('/', api);
    await screen.findByRole('heading', { name: 'Pronto a misurare la tua RTX 5090' });
    expect(document.querySelectorAll('.skeleton-shimmer').length).toBeGreaterThan(0);
    await act(async () =>
      status.resolve([
        { kind: 'llamacpp-native', available: true, installed: true, problems: [], supported: true },
        { kind: 'llamacpp-docker', available: false, installed: false, problems: ['DOCKER_NOT_RUNNING'], supported: true },
        { kind: 'vllm-docker', available: false, installed: false, problems: [], supported: true },
        { kind: 'vllm-native', available: false, installed: false, problems: [], supported: false },
      ]),
    );
    expect(await screen.findByText('Installato')).toBeTruthy();
    await choose('Cambia motore', /llama\.cpp \(Docker\)/);
    expect(await screen.findByText('Docker non è avviato')).toBeTruthy();
    await choose('Cambia motore', /vLLM \(Docker\)/);
    expect(await screen.findByText('Non installato')).toBeTruthy();
    // vLLM offers safetensors from the library first.
    expect(await screen.findByRole('button', { name: /Cambia modello: st model/ })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Apri Motori' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/engines'));
  });

  it('the model picker lists local models and suggestions with their verdicts', async () => {
    const api = benchApi({ curated: [curatedModel('gemma-12b', { sha256: 'abc' })] });
    api.world.runs = api.world.runs.map((r) => (r.id === '01K6WQ8D3N7B2X5C9V4M6K1JHT' ? { ...r, model: { ...r.model, sha256: 'abc' } } : r));
    const { router } = renderApp('/', api);
    await userEvent.click(await screen.findByRole('button', { name: /Cambia modello/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Scegli un modello' });
    expect(within(dialog).getByText('Consigliati per la tua RTX 5090 (32 GB). Quelli già sul PC partono subito.')).toBeTruthy();
    expect(within(dialog).getByText('Sul tuo PC', { selector: 'h3' })).toBeTruthy();
    expect(within(dialog).getByText(/Provato · 59 tok\/s/)).toBeTruthy();
    expect(within(dialog).getByText('Consigliato per la tua scheda')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('radio', { name: /gemma-12b/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Conferma' }));
    expect(await screen.findByText('Verrà scaricato prima del test: 2,3 GB')).toBeTruthy();
    expect(screen.getAllByText('Consigliato per la tua scheda').length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: /Cambia modello/ }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Altri modelli…' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/models'));
  });

  it('vLLM suggestions download through vLLM; no models at all points to the Models page', async () => {
    const api = benchApi({ local: [], curated: [curatedModel('vllm-4b', { engine: 'vllm', file: undefined, repo: 'Qwen/Qwen3-4B-AWQ' } as never)] });
    api.settings.lastEngine = { kind: 'vllm-docker' };
    const { router } = renderApp('/', api);
    expect(await screen.findByText('Verrà scaricato prima del test: 2,3 GB')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /Cambia modello/ }));
    expect(within(await screen.findByRole('dialog')).getByText('Da Hugging Face')).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    await choose('Cambia motore', 'llama.cpp');
    expect(await screen.findByText('Non ho trovato modelli adatti a questo motore. Scaricane uno da Modelli.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Avvia benchmark' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Apri Modelli' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/models'));
  });

  it('an empty picker, no GPU and a plan error', async () => {
    const api = benchApi({ local: [localModel('a')], curated: [], system: { ...benchApi().world.system, gpus: [] } });
    api.world.plan = () => {
      throw apiError('MODEL_INVALID');
    };
    const { router } = renderApp('/', api);
    // No NVIDIA card: the hero and the GPU card say so, and lead to the system check.
    expect(await screen.findByRole('heading', { name: 'Nessuna scheda NVIDIA trovata' })).toBeTruthy();
    expect(screen.getByText(/Per misurare serve una scheda video NVIDIA con il suo driver/)).toBeTruthy();
    expect(await screen.findByText('Quando avrai installato il driver NVIDIA, qui vedrai memoria, temperatura e consumo dal vivo.')).toBeTruthy();
    expect(screen.queryByText('Dal vivo')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Controlla il sistema' })).toHaveLength(2);
    expect(await screen.findByRole('heading', { name: 'Il file del modello non è valido' })).toBeTruthy();
    await choose('Cambia motore', /vLLM \(Docker\)/);
    expect(await screen.findByText('Non ho trovato modelli adatti a questo motore. Scaricane uno da Modelli.')).toBeTruthy();
    await userEvent.click(screen.getAllByRole('button', { name: 'Apri Modelli' })[0]!);
    await waitFor(() => expect(router.state.location.pathname).toBe('/models'));
  });

  it('without an NVIDIA card both "Controlla il sistema" buttons open the system check', async () => {
    for (const which of [0, 1]) {
      const api = benchApi({ local: [localModel('a')], system: { ...benchApi().world.system, gpus: [] } });
      const { router } = renderApp('/', api);
      await waitFor(() => expect(screen.getAllByRole('button', { name: 'Controlla il sistema' })).toHaveLength(2));
      await userEvent.click(screen.getAllByRole('button', { name: 'Controlla il sistema' })[which]!);
      await waitFor(() => expect(router.state.location.pathname).toBe('/welcome'));
      cleanup();
    }
  });

  it('the picker can be empty', async () => {
    const api = benchApi({ local: [localModel('a')], curated: [] });
    renderApp('/', api);
    await userEvent.click(await screen.findByRole('button', { name: /Cambia modello/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByText('Consigliati da scaricare')).toBeNull();
    await userEvent.keyboard('{Escape}');
    // A library without GGUF for llama.cpp: the empty state in the picker comes from the vLLM side.
    api.world.local = [];
  });

  it('waits for settings, and sends first-time users to the welcome', async () => {
    const api = benchApi({}, { onboardingDone: false });
    const gate = deferred<void>();
    const get = api.get;
    api.get = vi.fn(<T,>(path: string) => (path === '/api/settings' ? gate.promise.then(() => get<T>(path)) : get<T>(path))) as typeof api.get;
    const { router, container } = renderApp('/', api);
    await waitFor(() => expect(container.querySelectorAll('.skeleton-shimmer').length).toBeGreaterThan(0));
    await act(async () => gate.resolve());
    await waitFor(() => expect(router.state.location.pathname).toBe('/welcome'));
  });
});

describe('expert mode', () => {
  it('every parameter, custom plan, Docker image, vLLM fields, file picker', async () => {
    const api = benchApi();
    const pickFile = vi.fn(async () => 'C:\\llama\\llama-server.exe');
    (window as { gpubench?: unknown }).gpubench = { pickFile, platform: 'win32', setTitleBarTheme: async () => undefined };
    renderApp('/', api);
    await screen.findAllByText('≈ 1 min 35 s');
    await userEvent.click(screen.getByRole('switch', { name: 'Modalità esperto' }));
    expect(await screen.findByRole('heading', { name: 'Parametri avanzati' })).toBeTruthy();
    expect(screen.getByText('Scegli la durata «Personalizzato» per decidere tu cosa misurare.')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Anteprima comando' })).toBeTruthy();

    await userEvent.type(screen.getByLabelText('Contesto (token)'), '8192');
    await userEvent.type(screen.getByLabelText('Livelli in GPU'), 'x');
    expect(screen.getByText('Valore non valido: lo ignoro finché non lo correggi.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Avvia benchmark' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.clear(screen.getByLabelText('Livelli in GPU'));
    await choose('Flash attention', 'Attivo');
    await choose('Tipo di cache KV', 'q8_0');
    for (const [label, value] of [
      ['Batch', '2048'],
      ['Micro-batch', '512'],
      ['Thread CPU', '8'],
      ['Slot paralleli', '2'],
    ] as const) {
      await userEvent.type(screen.getByLabelText(label), value);
    }
    fireEvent.change(screen.getByLabelText('Argomenti extra'), { target: { value: '--metrics' } });
    fireEvent.change(screen.getByLabelText('Variabili d’ambiente'), { target: { value: 'bad line' } });
    expect(screen.getByText('Usa NOME=valore, una per riga.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Variabili d’ambiente'), { target: { value: 'A=1' } });
    await userEvent.click(screen.getByRole('button', { name: 'Sfoglia…' }));
    await waitFor(() => expect((screen.getByLabelText('Eseguibile personalizzato') as HTMLInputElement).value).toBe('C:\\llama\\llama-server.exe'));
    pickFile.mockResolvedValueOnce(null as never);
    await userEvent.click(screen.getByRole('button', { name: 'Sfoglia…' }));

    await userEvent.click(screen.getByRole('radio', { name: /Personalizzato/ }));
    expect(screen.getByLabelText('Caricamenti a freddo')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Lunghezze dei prompt'), { target: { value: '256' } });
    fireEvent.change(screen.getByLabelText('Utenti contemporanei'), { target: { value: '' } });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Esegui anche llama-bench' }));
    await waitFor(() => {
      const last = posted(api, '/api/runs/plan').at(-1)!.body as StartRunRequest;
      expect(last.profile).toBe('custom');
      expect(last.scenario?.steps.map((s) => s.kind)).toEqual(['load', 'load', 'latency', 'llama-bench']);
      expect(last.params).toMatchObject({ contextSize: 8192, flashAttention: 'on', kvCacheType: 'q8_0', batchSize: 2048, extraArgs: ['--metrics'], env: { A: '1' } });
      expect(last.engine.executable).toBe('C:\\llama\\llama-server.exe');
    });
    // Unchecking llama-bench and emptying the plan blocks the start.
    await userEvent.click(screen.getByRole('checkbox', { name: 'Esegui anche llama-bench' }));
    for (const label of ['Caricamenti a freddo', 'Caricamenti a caldo', 'Lunghezze dei prompt']) fireEvent.change(screen.getByLabelText(label), { target: { value: '' } });
    expect((screen.getByRole('button', { name: 'Avvia benchmark' }) as HTMLButtonElement).disabled).toBe(true);

    await choose('Cambia motore', /llama\.cpp \(Docker\)/);
    expect((screen.getByLabelText('Immagine Docker') as HTMLInputElement).placeholder).toBe('ghcr.io/ggml-org/llama.cpp:server-cuda');
    await choose('Cambia motore', /vLLM \(Docker\)/);
    await userEvent.type(screen.getByLabelText('Contesto massimo (token)'), '4096');
    await userEvent.type(screen.getByLabelText('Memoria GPU da usare'), '2');
    expect(screen.getAllByText('Valore non valido: lo ignoro finché non lo correggi.').length).toBeGreaterThan(0);
    await userEvent.clear(screen.getByLabelText('Memoria GPU da usare'));
    await userEvent.type(screen.getByLabelText('Memoria GPU da usare'), '0,8');
    await userEvent.type(screen.getByLabelText('Richieste contemporanee'), '4');
    await userEvent.type(screen.getByLabelText('Tipo di dati'), 'bfloat16');
    await userEvent.type(screen.getByLabelText('Quantizzazione'), 'awq');
    await userEvent.type(screen.getByLabelText('Immagine Docker'), 'vllm/vllm-openai:latest');

    // Switching expert mode off folds the command and goes back to the simple choices.
    await userEvent.click(screen.getByRole('switch', { name: 'Modalità esperto' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Parametri avanzati' })).toBeNull());
    expect(screen.queryByRole('region', { name: 'Anteprima comando' })).toBeNull();
  });

  it('vLLM native path and an external endpoint', async () => {
    const api = benchApi({ engines: benchApi().world.engines.map((e) => (e.kind === 'vllm-native' ? { ...e, supported: true, available: true, installed: true, version: '0.12' } : e)) });
    api.settings.expertMode = true;
    renderApp('/', api);
    await screen.findAllByText('≈ 1 min 35 s');
    await choose('Cambia motore', 'vLLM');
    await userEvent.type(await screen.findByLabelText('Percorso di vLLM'), '/opt/vllm/bin/vllm');
    await choose('Cambia motore', /Server esterno/);
    expect(screen.getByText('Server già acceso: misuro soltanto')).toBeTruthy();
    expect(screen.getByText('Il modello già caricato sul server.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Avvia benchmark' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText('Indirizzo del server'), 'nope');
    expect(screen.getByText('Valore non valido: lo ignoro finché non lo correggi.')).toBeTruthy();
    await userEvent.clear(screen.getByLabelText('Indirizzo del server'));
    await userEvent.type(screen.getByLabelText('Indirizzo del server'), 'http://127.0.0.1:8080');
    await userEvent.type(screen.getByLabelText('Nome del modello'), 'demo');
    await userEvent.type(screen.getByLabelText('Chiave API'), 'sk-1');
    await choose('Tipo di server', 'vLLM');
    expect(screen.getByText('Modello «demo» del server')).toBeTruthy();
    await start();
    expect(await h1('Test in corso')).toBeTruthy();
    expect(posted(api, '/api/runs')[0]!.body).toMatchObject({ engine: { kind: 'external', baseUrl: 'http://127.0.0.1:8080', apiKey: 'sk-1', flavor: 'vllm' }, model: { name: 'demo' } });
    // The secret never ends up in the settings file.
    await waitFor(() => expect(api.settings.lastEngine).toEqual({ kind: 'external', baseUrl: 'http://127.0.0.1:8080', flavor: 'vllm' }));
  });

  it('an external endpoint without a model name, restored outside expert mode', async () => {
    const api = benchApi();
    api.settings.lastEngine = { kind: 'external', baseUrl: 'http://h:1' };
    api.settings.lastProfile = 'custom';
    renderApp('/', api);
    // Without expert mode: llama.cpp and the Quick profile.
    expect(await screen.findByRole('radio', { name: /Rapido/ })).toBeTruthy();
    expect((screen.getByRole('radio', { name: /Rapido/ }) as HTMLInputElement).getAttribute('aria-checked')).toBe('true');
    await userEvent.click(screen.getByRole('switch', { name: 'Modalità esperto' }));
    await waitFor(() => expect(screen.getByText('Server già acceso: misuro soltanto')).toBeTruthy());
    await start();
    expect(await h1('Test in corso')).toBeTruthy();
    expect((posted(api, '/api/runs')[0]!.body as StartRunRequest).model).toEqual({});
  });
});
