import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StartRunRequest } from '../../../../src/contract/api';
import type { RunLaunch } from '../../../../src/contract/events';
import type { Scenario } from '../../../../src/contract/results';
import { renderApp } from '../helpers';
import { activeRun, benchApi, planFor } from '../bench/world';
import { attempt, params, point, tuning, users } from './tune-fixtures';

vi.mock('echarts/core', () => ({ use: vi.fn(), init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })) }));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({ AxisPointerComponent: {}, DataZoomComponent: {}, GridComponent: {}, LegendComponent: {}, MarkAreaComponent: {}, MarkLineComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

const clipboard = { writeText: vi.fn(async (_text: string) => undefined) };
beforeAll(() => {
  Object.assign(Element.prototype, { hasPointerCapture: () => false, releasePointerCapture: () => undefined, scrollIntoView: () => undefined });
});
beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
  clipboard.writeText.mockClear();
});
afterEach(() => {
  delete (window as { gpubench?: unknown }).gpubench;
});

const RUN = '01M48PNN41KKD0ABVXTGK97Y6P';
const K = 1024;
const h1 = (name: string | RegExp) => screen.findByRole('heading', { level: 1, name });
const TUNE_SCENARIO: Scenario = { profile: 'tune', seed: 42, steps: [{ kind: 'context-sweep', depths: [], fractions: false, outputTokens: 128, reps: 2 }] };
const STANDARD: Scenario = {
  profile: 'standard',
  seed: 42,
  steps: [
    { kind: 'load', cache: 'warm', reps: 1 },
    { kind: 'latency', promptTokens: [512, 4096], outputTokens: 256, warmup: 1, reps: 5 },
    { kind: 'context-sweep', depths: [], fractions: false, outputTokens: 128, reps: 2 },
    { kind: 'concurrency', levels: [1, 2, 3, 4], promptTokens: 512, outputTokens: 128, requestsPerWorker: 4 },
  ],
};
const launch: RunLaunch = {
  params: params({ kvCacheType: 'q4_0', flashAttention: 'on', ubatchSize: 2048 }),
  contextSize: 49152,
  command: { argv: ['llama-server', '-c', '49152'], powershell: 'llama-server -c 49152 `\n  -ctk q4_0', bash: 'llama-server -c 49152 \\\n  -ctk q4_0' },
  engineLabel: 'llama.cpp b11438 (cuda-13.4)',
};

describe('Benchmark: "Trova le impostazioni migliori"', () => {
  it('is a profile with a plain description, a time budget and (experts) the fidelity check; it sends tune', async () => {
    const api = benchApi({}, { onboardingDone: true, expertMode: true });
    api.world.plan = () => planFor({ scenario: TUNE_SCENARIO, estimatedSeconds: 300 });
    renderApp('/', api);
    await screen.findByRole('heading', { name: 'Pronto a misurare la tua RTX 5090' });
    await userEvent.click(screen.getByRole('radio', { name: /Trova le impostazioni migliori/ }));
    expect(screen.getByText(/Provo da solo le impostazioni/)).toBeTruthy();
    expect(screen.getByText('Le impostazioni che contano di più, poche prove.')).toBeTruthy();
    await userEvent.click(screen.getByRole('radio', { name: 'Accurata ~20 min' }));
    expect(screen.getByText('Più valori per ogni impostazione e più ripetizioni.')).toBeTruthy();
    await userEvent.click(screen.getByRole('switch', { name: 'Controllo di fedeltà' }));
    expect(screen.getByText(/È un’indicazione, non un test di qualità/)).toBeTruthy();
    await waitFor(() => expect(api.calls.some((c) => c.path === '/api/runs/plan' && (c.body as StartRunRequest).tune?.budget === 'thorough')).toBe(true));
    await userEvent.click(screen.getByRole('button', { name: 'Avvia benchmark' }));
    expect(await h1('Test in corso')).toBeTruthy();
    expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/runs')!.body).toMatchObject({ profile: 'tune', tune: { budget: 'thorough', fidelity: true } });
    const steps = screen.getByRole('list', { name: 'Fasi del test' });
    expect(within(steps).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      expect.stringContaining('Preparazione'),
      expect.stringContaining('Contesto massimo'),
      expect.stringContaining('Impostazioni'),
      expect.stringContaining('Contesto per gradi'),
      expect.stringContaining('Fedeltà'),
      expect.stringContaining('Pulizia'),
    ]);
  });

  it('beginners do not see the fidelity check and never send it', async () => {
    const api = benchApi();
    renderApp('/', api);
    await screen.findByRole('heading', { name: 'Pronto a misurare la tua RTX 5090' });
    await userEvent.click(screen.getByRole('radio', { name: /Trova le impostazioni migliori/ }));
    expect(screen.queryByRole('switch', { name: 'Controllo di fedeltà' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Avvia benchmark' }));
    expect(await h1('Test in corso')).toBeTruthy();
    expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/runs')!.body).toMatchObject({ tune: { budget: 'fast', fidelity: false } });
  });
});

describe('live screen of a tune run', () => {
  it('shows the stage in words, the attempts as they come, capacity per cache, the chart, the config and the loading line', async () => {
    const api = benchApi({ active: activeRun(RUN, { profile: 'tune', scenario: TUNE_SCENARIO, phase: 'tune-capacity', progress: 0.2 }) });
    renderApp(`/run/${RUN}`, api);
    expect(await screen.findByText('Prove fatte')).toBeTruthy();
    expect(screen.getByText('La prima prova parte tra poco.')).toBeTruthy();
    expect(screen.getByText('Qui compare il contesto massimo di ogni cache appena lo trovo.')).toBeTruthy();
    expect(screen.getByText('Il motore sta partendo: la configurazione compare appena è pronto.')).toBeTruthy();

    const t = tuning();
    const current = { ...attempt('capacity', 'q4_0', 48 * K, 'ok', { vramPeakMiB: 20000 }) } as Record<string, unknown>;
    delete current.outcome;
    const partial = { ...t, attempts: t.attempts.slice(0, 6), combinations: t.combinations.slice(0, 2), capacity: [{ ...t.capacity[0]! }, { ...t.capacity[1]! }, { kvType: 'q4_0' as const, predictedMax: 72 * K, inferred: false }] };
    act(() => api.emit({ type: 'run.tune', runId: RUN, tuning: partial, current: current as never }));
    expect(screen.getByText('Cerco il contesto massimo con cache q4_0: provo 48K…')).toBeTruthy();
    const attempts = screen.getByRole('table', { name: 'Prove fatte' });
    const rows = within(attempts).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(7);
    expect(rows[0]!.textContent).toContain('In corso');
    expect(rows[0]!.getAttribute('aria-current')).toBe('step');
    expect(rows[1]!.textContent).toContain('Usa la RAM condivisa (lento)');
    expect(rows[5]!.textContent).toContain('Memoria esaurita');
    expect(rows[6]!.textContent).toMatch(/Caricato.*4K.*f16.*Cache KV f16 · flash attention.*17,6.*88,0/);
    expect(screen.getByText('6 di 24 al massimo')).toBeTruthy();
    const capacity = screen.getByRole('heading', { name: 'Contesto massimo per cache' }).closest('div')!.parentElement!;
    expect(within(capacity).getByText('provo 48K…')).toBeTruthy();
    expect(within(capacity).getByText('24K')).toBeTruthy();
    expect(within(capacity).getByText('stima 72K')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Velocità al crescere del contesto (finora)' })).toBeTruthy();

    // The same launch's engine start, stage by stage.
    act(() => api.emit({ type: 'run.load', runId: RUN, stage: 'starting', elapsedMs: 0 }));
    act(() => api.emit({ type: 'run.load', runId: RUN, stage: 'weights', elapsedMs: 1500, done: 3, total: 7, fraction: 0.43, detail: 'load_tensors: offloading 3 layers', expectedMs: 45_000 }));
    expect(screen.getByText('Caricamento dei pesi · 3 di 7 strati (43%)')).toBeTruthy();
    expect(screen.getByText('· di solito circa 45 s')).toBeTruthy();
    expect(screen.getByText('load_tensors: offloading 3 layers')).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: 'Avvio del motore' }).getAttribute('aria-valuenow')).toBe('43');
    act(() => api.emit({ type: 'run.load', runId: RUN, stage: 'kv-cache', elapsedMs: 9000 }));
    expect(screen.getByRole('progressbar', { name: 'Avvio del motore' }).getAttribute('data-state')).toBe('indeterminate');
    expect(screen.getByRole('button', { name: 'Che cos’è «Preparazione della cache KV»?' })).toBeTruthy();
    const done = () => screen.getByRole('list', { name: 'Fasi dell’avvio e quanto sono durate' }).textContent;
    expect(done()).toBe('Avvio1,5 sPesi7,5 s');
    act(() => api.emit({ type: 'run.load', runId: RUN, stage: 'warmup', elapsedMs: 70_000 }));
    expect(done()).toBe('Avvio1,5 sPesi7,5 sCache KV1 min 01 s');
    expect(within(screen.getByRole('list', { name: 'Fasi dell’avvio e quanto sono durate' })).getByRole('button', { name: 'Che cos’è «Cache KV»?' })).toBeTruthy();
    act(() => api.emit({ type: 'run.load', runId: RUN, stage: 'ready', elapsedMs: 72_000 }));
    expect(screen.getByText('pronto in 1:12')).toBeTruthy();
    expect(screen.queryByRole('progressbar', { name: 'Avvio del motore' })).toBeNull();

    // The engine in use and its command, which can be copied (the server cannot start during a test).
    act(() => api.emit({ type: 'run.launch', runId: RUN, launch }));
    const config = screen.getByRole('heading', { name: 'Configurazione del server' }).closest('div')!.parentElement!;
    expect(within(config).getByText('llama.cpp b11438 (CUDA 13.4)')).toBeTruthy();
    expect(within(config).getByText('Contesto 49.152 · cache KV q4_0 · flash attention · ub 2048')).toBeTruthy();
    await userEvent.click(within(config).getByRole('button', { name: 'Copia comando' }));
    expect(clipboard.writeText).toHaveBeenCalledWith(launch.command.powershell);
    await userEvent.click(within(config).getByRole('button', { name: 'Mostra comando' }));
    expect(screen.getByRole('region', { name: 'Comando' }).textContent).toContain('-ctk q4_0');
    expect(within(config).getByText(/potrai avviare il server con queste impostazioni dalla pagina del risultato/)).toBeTruthy();

    // The quick checks of the attempt in progress fill "Misure finora".
    act(() => api.emit({ type: 'run.step', runId: RUN, current: { kind: 'tune-probe', promptTokens: 4 * K, outputTokens: 64, rep: 1, reps: 2 } }));
    expect(screen.getByText('Prova rapida · Prompt di 4096 token → 64 in uscita · ripetizione 1 di 2')).toBeTruthy();
    act(() => api.emit({ type: 'run.point', runId: RUN, live: { stepKind: 'tune-probe', point: point(4 * K, 61, 5000), attempt: 5 } }));
    act(() => api.emit({ type: 'run.point', runId: RUN, live: { stepKind: 'tune-probe', point: point(4 * K, 70, 5000), attempt: 6 } }));
    const probe = screen.getByRole('table', { name: 'Prova in corso' });
    expect(within(probe).getAllByRole('row')).toHaveLength(2);
    expect(probe.textContent).toContain('70,0');
    // Done: every combination measured, nothing in progress.
    act(() => api.emit({ type: 'run.tune', runId: RUN, tuning: t }));
    expect(screen.queryByText(/Cerco il contesto massimo/)).toBeNull();
    expect(screen.getByText('11 di 24 al massimo')).toBeTruthy();
    expect(screen.getAllByText('Più lenta: scartata').length).toBeGreaterThan(0);
  });

  it('a reopened screen gets the search, the engine and its loading from the core; copying on Linux uses bash', async () => {
    (window as { gpubench?: unknown }).gpubench = { platform: 'linux', setTitleBarTheme: async () => undefined };
    const api = benchApi({
      active: activeRun(RUN, {
        profile: 'tune',
        scenario: TUNE_SCENARIO,
        phase: 'fidelity',
        progress: 0.9,
        tuning: { ...tuning(), maxLaunches: 30 },
        launch: { ...launch, params: params({ contextSize: 8192 }), contextSize: undefined, engineLabel: 'vLLM v0.12.0' },
        loading: { stage: 'cuda-graphs', elapsedMs: 31_000, done: 30, total: 67, fraction: 0.45 },
      }),
    });
    renderApp(`/run/${RUN}`, api);
    expect(await screen.findByText('11 di 30 al massimo')).toBeTruthy();
    expect(screen.getByText('Preparazione dei CUDA graph · 30 di 67 (45%)')).toBeTruthy();
    expect(screen.getByText('vLLM')).toBeTruthy();
    expect(within(screen.getByRole('list', { name: 'Fasi del test' })).getByText('Fedeltà')).toBeTruthy();
    expect(screen.getByText('Contesto 8192 · cache KV auto')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Copia comando' }));
    expect(clipboard.writeText).toHaveBeenCalledWith(launch.command.bash);
  });
});

describe('live screen of any run', () => {
  it('says what is measured now and fills "Misure finora" per prompt, depth and number of users', async () => {
    const api = benchApi({ active: activeRun(RUN, { profile: 'standard', scenario: STANDARD, phase: 'decode', progress: 0.3 }) });
    renderApp(`/run/${RUN}`, api);
    expect(await screen.findByText('Le misure compaiono qui appena arriva la prima risposta del modello.')).toBeTruthy();
    act(() => api.emit({ type: 'run.step', runId: RUN, current: { kind: 'latency', promptTokens: 512, outputTokens: 256, rep: 1, reps: 1, warmup: true } }));
    expect(screen.getByText('Prompt di 512 token → 256 in uscita · riscaldamento 1 di 1')).toBeTruthy();
    const byPrompt = () => screen.getByRole('table', { name: 'Per lunghezza del prompt' });
    // Every prompt length of the plan is listed; the one in progress is highlighted.
    expect(within(byPrompt()).getAllByRole('row').map((r) => r.textContent)).toEqual([
      'Prompt (token)Lettura prompt (tok/s)Primo token (ms)Generazione (tok/s)Ripetizioni',
      '512–––in corso',
      '4096–––in attesa',
    ]);
    act(() => api.emit({ type: 'run.point', runId: RUN, live: { stepKind: 'latency', point: point(512, 190.4, 9000) } }));
    expect(within(byPrompt()).getAllByRole('row')[1]!.textContent).toBe('5129000' + '57' + '190,4' + '2 di 5');
    act(() => api.emit({ type: 'run.step', runId: RUN, current: { kind: 'context-sweep', depth: 32 * K, outputTokens: 128 } }));
    expect(screen.getByRole('table', { name: 'Contesto per gradi' }).textContent).toContain('32.768');
    act(() => api.emit({ type: 'run.point', runId: RUN, live: { stepKind: 'context-sweep', point: point(K, 180, 8800) } }));
    expect(screen.getByRole('table', { name: 'Contesto per gradi' }).textContent).toContain('2 di 2');
    act(() => api.emit({ type: 'run.step', runId: RUN, current: { kind: 'concurrency', concurrency: 2, promptTokens: 512 } }));
    act(() => api.emit({ type: 'run.point', runId: RUN, live: { stepKind: 'concurrency', point: users(1, { perRequestPrefillTpsP50: 2100 }) } }));
    const usersTable = screen.getByRole('table', { name: 'Più utenti insieme' });
    expect(within(usersTable).getAllByRole('row').map((r) => r.firstElementChild!.textContent)).toEqual(['Utenti', '1', '2', '3', '4']);
    expect(within(usersTable).getAllByRole('row')[2]!.getAttribute('aria-current')).toBe('step');
    expect(within(usersTable).getByText('Lettura per utente p50 (tok/s)')).toBeTruthy();
  });

  it('without a plan the tables list only what was measured', async () => {
    const api = benchApi({ active: activeRun(RUN, { phase: 'concurrency', progress: 0.3, scenario: { profile: 'quick', seed: 1, steps: [] } }) });
    renderApp(`/run/${RUN}`, api);
    await screen.findByText('Misure finora');
    act(() => api.emit({ type: 'run.step', runId: RUN, current: { kind: 'concurrency' } }));
    expect(screen.getByRole('table', { name: 'Più utenti insieme' })).toBeTruthy();
    act(() => api.emit({ type: 'run.step', runId: RUN, current: { kind: 'latency' } }));
    expect(screen.queryByRole('table', { name: 'Per lunghezza del prompt' })).toBeNull();
    act(() => api.emit({ type: 'run.step', runId: RUN, current: { kind: 'latency', promptTokens: 128 } }));
    expect(within(screen.getByRole('table', { name: 'Per lunghezza del prompt' })).getAllByRole('row')[1]!.textContent).toBe('128–––in corso');
    act(() => api.emit({ type: 'run.point', runId: RUN, live: { stepKind: 'latency', point: point(128, 50, 900) } }));
    expect(within(screen.getByRole('table', { name: 'Per lunghezza del prompt' })).getAllByRole('row')[1]!.textContent).toBe('128900142' + '50,0' + '2');
    act(() => api.emit({ type: 'run.step', runId: RUN, current: { kind: 'context-sweep' } }));
    expect(screen.queryByRole('table', { name: 'Contesto per gradi' })).toBeNull();
  });
});
