import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StartRunRequest, StartServerRequest } from '../../../../src/contract/api';
import type { RunResult } from '../../../../src/contract/results';
import { renderApp } from '../helpers';
import { exerciseFormatters } from './charts';
import { IDS, seeded, seededRuns } from './fixtures';
import { apiError, benchApi, deferred, localModel, serverInfo, serverPlanFor } from './world';

const charts = vi.hoisted(() => ({ options: [] as Record<string, unknown>[] }));
vi.mock('echarts/core', () => ({
  use: vi.fn(),
  init: vi.fn(() => ({ setOption: vi.fn((o: Record<string, unknown>) => charts.options.push(o)), resize: vi.fn(), dispose: vi.fn() })),
}));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({ AxisPointerComponent: {}, DataZoomComponent: {}, GridComponent: {}, LegendComponent: {}, MarkAreaComponent: {}, MarkLineComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

const clipboard = { writeText: vi.fn(async (_text: string) => undefined) };

beforeAll(() => {
  Object.assign(Element.prototype, { hasPointerCapture: () => false, releasePointerCapture: () => undefined, scrollIntoView: () => undefined });
});

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
  clipboard.writeText.mockReset();
  clipboard.writeText.mockResolvedValue(undefined);
});

afterEach(() => {
  charts.options.length = 0;
  delete (window as { gpubench?: unknown }).gpubench;
});

const h1 = (name: string | RegExp) => screen.findByRole('heading', { level: 1, name });
const tab = (name: string) => userEvent.click(screen.getByRole('tab', { name }));
const posted = (api: ReturnType<typeof benchApi>, path: string) => api.calls.filter((c) => c.method === 'POST' && c.path === path);

/** The full seeded run, with its model in the library. */
function withLibrary(runs: RunResult[] = seededRuns()) {
  const full = runs.find((r) => r.id === IDS.full)!;
  return benchApi({ runs, local: [localModel('qwen3-8b', { weakKey: full.model.weakKey })] });
}

describe('result overview', () => {
  it('stability counts prompt reading too, like the "unstable" warning (they never disagree)', async () => {
    const runs = seededRuns().map((r) =>
      r.id === IDS.full
        ? { ...r, metrics: { ...r.metrics, latency: r.metrics.latency.map((p) => ({ ...p, decodeTps: { ...p.decodeTps, cv: 0.01 }, prefillTps: { ...p.prefillTps, cv: 0.08 } })) } }
        : r,
    );
    renderApp(`/results/${IDS.full}`, withLibrary(runs));
    expect(await screen.findByText('Variabile')).toBeTruthy();
    expect(screen.queryByText('Ottima')).toBeNull();
  });

  it('explains the run: score, sentence, warnings with actions, KPIs and charts', async () => {
    const api = withLibrary();
    const { router } = renderApp(`/results/${IDS.full}`, api);
    expect(await h1(/Qwen3 8B/)).toBeTruthy();
    expect(screen.getByText('Q4_K_M', { selector: 'span' })).toBeTruthy();
    expect(screen.getByText('1.012')).toBeTruthy();
    expect(screen.getByText(/Scrive circa 128 parole al secondo/)).toBeTruthy();
    expect(screen.getByText('Ottima')).toBeTruthy();
    expect(screen.getByText(/llama-server\.exe \(PID 18244, 2,3 GB\)/)).toBeTruthy();
    const kpis = screen.getByRole('region', { name: 'Numeri principali' });
    expect(within(kpis).getByText(/misurato sul motore · stima 6,7 GB · su 31,8 GB/)).toBeTruthy();
    // Every speed with what it was measured on: the prompt it read, the context it wrote with, the users.
    expect(within(kpis).getByText('scrittura con 512 token già nel contesto')).toBeTruthy();
    expect(within(kpis).getByText(/^≈ \d+ parole\/s · variazione/)).toBeTruthy();
    expect(within(kpis).getByText('lettura di un prompt da 512 token')).toBeTruthy();
    expect(within(kpis).getByText('dopo un prompt da 512 token')).toBeTruthy();
    expect(within(kpis).getByText('con 16 utenti insieme, prompt da 512 token ciascuno')).toBeTruthy();
    expect(within(kpis).getByText(/disco ~/)).toBeTruthy();

    await waitFor(() => expect(charts.options.length).toBeGreaterThanOrEqual(3));
    for (const o of charts.options) exerciseFormatters(o);
    await userEvent.click(screen.getByRole('radio', { name: 'Lettura prompt' }));
    await waitFor(() => expect(charts.options.length).toBeGreaterThanOrEqual(4));
    exerciseFormatters(charts.options.at(-1));
    for (const b of screen.getAllByRole('button', { name: 'Mostra tabella' })) await userEvent.click(b);
    expect(screen.getByRole('table', { name: /Scheda video durante il test/ }).textContent).toContain('Generazione');

    await userEvent.click(screen.getByRole('button', { name: 'Attiva misure a freddo reali' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings'));
  });

  it('warning actions run the test again or open the right page', async () => {
    const api = withLibrary();
    const run = seeded(IDS.full);
    run.validity = ['gpu_shared', 'throttling', 'tokens_approximate', 'unstable'];
    run.sharedGpu = [];
    api.world.runs = [run];
    const { router } = renderApp(`/results/${IDS.full}`, api);
    await h1(/Qwen3 8B/);
    expect(screen.getByText(/altri programmi occupavano memoria video/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Apri Monitor GPU' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/monitor'));
    act(() => router.history.back());
    await userEvent.click(await screen.findByRole('button', { name: 'Apri Motori' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/engines'));
    act(() => router.history.back());
    await userEvent.click((await screen.findAllByRole('button', { name: 'Rifai il test' }))[0]!);
    expect(await h1('Test in corso')).toBeTruthy();
    expect(posted(api, '/api/runs')[0]!.body).toMatchObject({ model: { localId: 'qwen3-8b' }, profile: 'full', allowSharedGpu: false });
  });

  it('runs with little data, notes and an approximate VRAM figure', async () => {
    const vllm = seeded(IDS.vllm);
    const api = benchApi({ runs: [vllm] });
    renderApp(`/results/${IDS.vllm}`, api);
    expect(await h1(/Qwen3-8B-FP8/)).toBeTruthy();
    expect(screen.getByText('vLLM userà meno memoria del solito')).toBeTruthy();
    expect(screen.getByText(/approssimato · stima/)).toBeTruthy();
    expect(screen.getByText('Il punteggio si calcola solo con il profilo Standard sul modello di riferimento.')).toBeTruthy();
    await tab('Dettagli');
    expect(screen.getByRole('table', { name: 'Caricamento del modello' }).textContent).toContain('Avvio del contenitore');
    expect(screen.getByText('Totale meno la base (approssimata)')).toBeTruthy();
    await tab('Come è stato avviato');
    expect(screen.getByText('Immagine Docker')).toBeTruthy();
    expect(screen.getByText('vllm/vllm-openai:v0.12.0@sha256:6f1a8c2e')).toBeTruthy();
  });

  it('a nearly empty run still reads well', async () => {
    const base = seeded(IDS.quick);
    const bare: RunResult = {
      ...base,
      id: 'bare',
      hardware: { ...base.hardware, gpus: [] },
      model: { ...base.model, quant: undefined },
      scenario: { profile: 'custom', seed: 1, steps: [] },
      engine: { kind: 'llamacpp-native', name: 'llama.cpp' },
      launch: { ...base.launch, cwd: undefined, requestExample: undefined, env: { CUDA_VISIBLE_DEVICES: '0' } },
      metrics: { formulaVersion: 1, load: { phases: [] }, latency: [], contextSweep: [], sessions: [], concurrency: [], llamaBench: [], vram: {}, energy: {}, thermals: { throttleReasons: [] } },
      validity: [],
      notes: [{ code: 'MODEL_TOO_LARGE', params: { needMiB: 40000, availableMiB: 30000 } }],
      telemetry: undefined,
      logExcerpt: '',
    };
    const api = benchApi({ runs: [bare], local: [] });
    renderApp('/results/bare', api);
    expect(await h1(/Mistral/)).toBeTruthy();
    expect(screen.getByText('Il test si è fermato prima di misurare la velocità di scrittura.')).toBeTruthy();
    expect(screen.getByText('Il modello è troppo grande per questa scheda')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Scheda video durante il test' })).toBeNull();
    await tab('Dettagli');
    expect(screen.getByText('Nessuna misura di velocità in questo test.')).toBeTruthy();
    expect(screen.getAllByText('–').length).toBeGreaterThan(10);
    await tab('Log');
    expect(screen.getByText('Nessuna riga di log salvata.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Copia il log' }) as HTMLButtonElement).disabled).toBe(true);
    await tab('Come è stato avviato');
    expect(screen.getByText('CUDA_VISIBLE_DEVICES=0')).toBeTruthy();
    expect(await screen.findByText('Il modello di questo test non è più nella libreria: scegline uno nel Benchmark.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Avvia solo il server così' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Rifai questo benchmark' }));
    expect((await screen.findAllByText('Il modello di questo test non è più nella libreria: scegline uno nel Benchmark.')).length).toBeGreaterThan(1);
  });
});

describe('result details and log', () => {
  it('shows every statistic, sortable, and the per-chunk note', async () => {
    const run = seeded(IDS.full);
    run.metrics.latency[0]!.itlPerChunk = true;
    run.metrics.latency[0]!.prefillTpsEngine = undefined;
    run.metrics.latency[1]!.decodeTpsEngine = undefined;
    run.metrics.thermals.throttleReasons = ['sw_thermal_slowdown'];
    const api = withLibrary([run]);
    renderApp(`/results/${IDS.full}`, api);
    await h1(/Qwen3 8B/);
    await tab('Dettagli');
    expect(screen.getByText(/Pausa misurata tra blocchi/)).toBeTruthy();
    expect(screen.getByText('sw_thermal_slowdown')).toBeTruthy();
    expect(screen.getByRole('table', { name: 'llama-bench' }).textContent).toContain('pp512');
    expect(screen.getByRole('table', { name: 'Fasi del caricamento' }).textContent).toContain('load_tensors');
    for (const name of [/Lettura \(motore\)/, /Generazione \(motore\)/]) await userEvent.click(screen.getByRole('button', { name }));
    await tab('Log');
    await userEvent.click(screen.getByRole('button', { name: 'Copia il log' }));
    expect(clipboard.writeText).toHaveBeenCalledWith(run.logExcerpt);
    expect(await screen.findByText('Copiato')).toBeTruthy();
    clipboard.writeText.mockRejectedValueOnce(new Error('denied'));
    await userEvent.click(screen.getByRole('button', { name: 'Copia il log' }));
    expect(await screen.findByText('Non sono riuscito a copiare')).toBeTruthy();
  });

  it('exports in every format', async () => {
    const api = withLibrary();
    const saveFile = vi.fn(async (o: { defaultName: string }) => `C:\\out\\${o.defaultName}`);
    (window as { gpubench?: unknown }).gpubench = { saveFile, platform: 'win32', setTitleBarTheme: async () => undefined };
    renderApp(`/results/${IDS.full}`, api);
    await h1(/Qwen3 8B/);
    const pick = async (name: RegExp) => {
      const trigger = screen.getByRole('button', { name: 'Esporta' });
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
      fireEvent.click(await screen.findByRole('menuitem', { name }));
    };
    await pick(/CSV per Excel/);
    expect(await screen.findByText(/Esportazione pronta \(CSV per Excel \(italiano\)\): C:\\out\\gpubench_Qwen3-8B/)).toBeTruthy();
    expect((saveFile.mock.calls[0]![0] as unknown as { content: string }).content.startsWith('\uFEFF')).toBe(true);
    saveFile.mockResolvedValueOnce(null as never);
    await pick(/Markdown/);
    saveFile.mockRejectedValueOnce(new Error('disk'));
    await pick(/Pagina HTML/);
    expect(await screen.findByText('Non sono riuscito a salvare il file.')).toBeTruthy();
    expect(saveFile).toHaveBeenCalledTimes(3);
  });
});

describe('how it was started', () => {
  it('summary, command, re-run, reuse the settings', async () => {
    const api = withLibrary();
    const { router } = renderApp(`/results/${IDS.full}`, api);
    await h1(/Qwen3 8B/);
    await tab('Come è stato avviato');
    expect(screen.getAllByText('llama.cpp b11438 (CUDA 13.4)')).toHaveLength(2);
    expect(screen.getByText('flash attention')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Mostra comando' }));
    expect(screen.getByRole('region', { name: 'Comando' }).textContent).toContain('llama-server.exe');
    await userEvent.click(screen.getByRole('button', { name: 'Nascondi comando' }));
    expect(screen.getByText('Esempio di richiesta')).toBeTruthy();
    expect(screen.getByText('http://127.0.0.1:41873')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Usa queste impostazioni' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(await screen.findByText('Impostazioni copiate nel Benchmark')).toBeTruthy();
    expect(api.settings.expertMode).toBe(true);
    expect(((await screen.findByLabelText('Contesto (token)')) as HTMLInputElement).value).toBe('8192');
    expect(screen.getByRole('radio', { name: /Completo/ }).getAttribute('aria-checked')).toBe('true');
  });

  it('a plain run reused without expert mode; compare from here', async () => {
    const run = seeded(IDS.quick);
    run.launch.params = { extraArgs: [], env: {} };
    const api = benchApi({ runs: [run], local: [localModel('mistral', { weakKey: run.model.weakKey })] });
    const { router } = renderApp(`/results/${IDS.quick}`, api);
    await h1(/Mistral/);
    await tab('Come è stato avviato');
    await userEvent.click(screen.getByRole('button', { name: 'Usa queste impostazioni' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(api.settings.expertMode).toBe(false);
    act(() => router.history.back());
    // Into the comparison: the tray asks for at least one more, and opens the list to pick it from.
    const toggle = await screen.findByRole('button', { name: /^Confronta Mistral Small/ });
    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    const tray = screen.getByRole('region', { name: 'Da confrontare' });
    await userEvent.click(within(tray).getByRole('button', { name: 'Scegli gli altri' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/compare'));
    expect(router.state.location.search).toEqual({ view: 'runs' });
    expect(await screen.findByText('Scelto 1 su 4: scegline almeno un altro')).toBeTruthy();
  });

  it('starts only the server with the run’s exact settings: confirmation, address, stop', async () => {
    const api = withLibrary();
    const info = serverInfo('srv1', { contextSize: 8192 });
    const started = deferred<typeof info>();
    let fail = true;
    api.world.routes['POST /api/servers'] = () => {
      if (fail) throw apiError('ENGINE_START_FAILED', undefined, 500);
      api.world.servers = [info];
      return started.promise;
    };
    api.world.serverPlan = (body) => serverPlanFor({ contextSize: 8192, params: (body as StartServerRequest).params! });
    renderApp(`/results/${IDS.full}`, api);
    await h1(/Qwen3 8B/);
    await tab('Come è stato avviato');
    await userEvent.click(screen.getByRole('button', { name: 'Avvia solo il server così' }));
    // The confirmation says how much text it takes, and that it comes from the run's own settings.
    expect(await screen.findByText('8.192 token')).toBeTruthy();
    let dialog = screen.getByRole('dialog', { name: 'Avvia il server' });
    expect(within(dialog).getByText(/Viene dalle impostazioni scelte/)).toBeTruthy();
    expect(within(dialog).getByRole('region', { name: 'Comando esatto' }).textContent).toContain('llama-server');
    expect(posted(api, '/api/servers/plan')[0]!.body).toMatchObject({ engine: { kind: 'llamacpp-native' }, model: { localId: 'qwen3-8b' }, params: { contextSize: 8192 } });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Annulla' }));
    await userEvent.click(screen.getByRole('button', { name: 'Avvia solo il server così' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Avvia server' }));
    dialog = await screen.findByRole('dialog', { name: 'Il server non è partito' });
    expect(within(dialog).getByRole('heading', { name: 'Il motore non è partito' })).toBeTruthy();
    fail = false;
    await userEvent.click(within(dialog).getByRole('button', { name: 'Riprova' }));
    expect(await screen.findByText('Avvio il motore e carico il modello…')).toBeTruthy();
    await act(async () => started.resolve(info));
    dialog = await screen.findByRole('dialog', { name: 'Il server è pronto' });
    expect(within(dialog).getByText('Indirizzo compatibile OpenAI')).toBeTruthy();
    expect(within(dialog).getByText('Modello: Qwen3 8B · Contesto 8.192 token')).toBeTruthy();
    expect(posted(api, '/api/servers')[1]!.body).toMatchObject({ engine: { kind: 'llamacpp-native' }, model: { localId: 'qwen3-8b' }, params: { contextSize: 8192 } });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Copia l’indirizzo compatibile OpenAI' }));
    expect(clipboard.writeText).toHaveBeenCalledWith('http://127.0.0.1:5123/v1');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Copia l’indirizzo del server' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Ferma' }));
    expect(await screen.findByText('Server di Qwen3 8B fermato')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('failed, cancelled and missing results', () => {
  it('a failed run: what happened, what to do, the log', async () => {
    const api = benchApi();
    const { router } = renderApp(`/results/${IDS.failed}`, api);
    expect(await screen.findByRole('heading', { name: 'Memoria della scheda video insufficiente' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Apri il log' }));
    expect(screen.getByRole('region', { name: 'Log del server (estratto)' }).textContent).toContain('out of memory');
    await tab('Panoramica');
    await userEvent.click(screen.getByRole('button', { name: 'Scegli un altro modello' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });

  it('cancelled and GPU-busy runs offer to run again; an engine crash opens the log', async () => {
    const cancelled = seeded(IDS.cancelled);
    const busy: RunResult = { ...seeded(IDS.cancelled), id: 'busy', status: 'failed', error: { code: 'VRAM_BUSY', message: 'busy', params: { names: 'x' } } };
    const crashed: RunResult = { ...seeded(IDS.cancelled), id: 'crashed', status: 'failed', error: { code: 'ENGINE_EXITED', message: 'exit 3', detail: 'segfault' } };
    const api = benchApi({ runs: [cancelled, busy, crashed], local: [localModel('q14', { weakKey: cancelled.model.weakKey })] });
    const { router } = renderApp(`/results/${IDS.cancelled}`, api);
    expect(await screen.findByRole('heading', { name: 'Operazione annullata' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Apri il log' })).toBeNull();
    await waitFor(() => expect(api.calls.some((c) => c.path === '/api/models/local')).toBe(true));
    await userEvent.click(screen.getByRole('button', { name: 'Riprova' }));
    expect(await h1('Test in corso')).toBeTruthy();

    act(() => void router.navigate({ to: '/results/$runId', params: { runId: 'busy' } }));
    await userEvent.click(await screen.findByRole('button', { name: 'Continua comunque' }));
    await waitFor(() => expect((posted(api, '/api/runs').at(-1)!.body as StartRunRequest).allowSharedGpu).toBe(true));

    act(() => void router.navigate({ to: '/results/$runId', params: { runId: 'crashed' } }));
    await screen.findByRole('heading', { name: 'Il motore si è chiuso all’improvviso' });
    fireEvent.click(screen.getByText('Dettagli tecnici'));
    expect(screen.getByText('ENGINE_EXITED: exit 3 — segfault')).toBeTruthy();
    await userEvent.click(screen.getAllByRole('button', { name: 'Apri il log' })[0]!);
    expect(screen.getByRole('tab', { name: 'Log' }).getAttribute('aria-selected')).toBe('true');
  });

  it('retrying before the library is known does nothing', async () => {
    const cancelled = seeded(IDS.cancelled);
    const api = benchApi({ runs: [cancelled] });
    const gate = deferred<unknown>();
    api.world.routes['GET /api/models/local'] = () => gate.promise;
    renderApp(`/results/${IDS.cancelled}`, api);
    await userEvent.click(await screen.findByRole('button', { name: 'Riprova' }));
    expect(posted(api, '/api/runs')).toHaveLength(0);
    await act(async () => gate.resolve([]));
  });

  it('an unknown result, and a result that fails to load then loads', async () => {
    const api = benchApi();
    const { router } = renderApp('/results/nope', api);
    expect(await screen.findByRole('heading', { name: 'Risultato non trovato' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Torna ai risultati' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/results'));

    let fail = true;
    api.world.routes[`GET /api/runs/${IDS.gemma}`] = () => {
      if (fail) throw apiError('NETWORK', undefined, 503);
      return seeded(IDS.gemma);
    };
    act(() => void router.navigate({ to: '/results/$runId', params: { runId: IDS.gemma } }));
    expect(await screen.findByRole('heading', { name: 'Connessione a internet non disponibile' })).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Riprova' }));
    expect(await h1(/Gemma 4 31B/)).toBeTruthy();
  });

  it('shows a skeleton while loading', async () => {
    const api = benchApi();
    const gate = deferred<unknown>();
    api.world.routes[`GET /api/runs/${IDS.full}`] = () => gate.promise;
    const { container } = renderApp(`/results/${IDS.full}`, api);
    await waitFor(() => expect(container.querySelector('[aria-busy="true"]')).toBeTruthy());
    await act(async () => gate.resolve(seeded(IDS.full)));
    expect(await h1(/Qwen3 8B/)).toBeTruthy();
  });
});
