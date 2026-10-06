/**
 * Screens fed with unusual data (empty lists, missing GPU, sparse results) and the boot code.
 * The data hooks are swapped per test through `state`.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunResult } from '../../../src/contract/results';
import { getMockRun, MOCK_RUN_ID } from '../../../src/renderer/mock/runs';
import { mockSystem } from '../../../src/renderer/mock/system';
import { fakeApi, renderApp, renderUi } from './helpers';
import { Select } from '../../../src/renderer/components/ui/select';

const state = vi.hoisted(() => ({
  runs: undefined as unknown,
  run: undefined as unknown,
  system: undefined as unknown,
  downloads: undefined as unknown,
  engines: undefined as unknown,
}));

vi.mock('../../../src/renderer/lib/queries', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/renderer/lib/queries')>();
  const pick = <T,>(override: unknown, fallback: () => T) => (override === undefined ? fallback() : ({ data: override, isPending: false } as T));
  return {
    ...real,
    useRuns: () => pick(state.runs, real.useRuns),
    useRun: (id: string) => pick(state.run, () => real.useRun(id)),
    useSystem: () => pick(state.system, real.useSystem),
    useDownloads: () => pick(state.downloads, real.useDownloads),
    useEngines: () => pick(state.engines, real.useEngines),
  };
});
vi.mock('echarts/core', () => ({ use: vi.fn(), init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })) }));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({
  AxisPointerComponent: {},
  DataZoomComponent: {},
  GridComponent: {},
  LegendComponent: {},
  MarkAreaComponent: {},
  MarkLineComponent: {},
  TooltipComponent: {},
}));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

afterEach(() => {
  state.runs = state.run = state.system = state.downloads = state.engines = undefined;
  vi.restoreAllMocks();
});

const h1 = (name: string | RegExp) => screen.findByRole('heading', { level: 1, name });

/** A result with most optional data missing. */
function sparseRun(): RunResult {
  const base = getMockRun(MOCK_RUN_ID);
  return {
    ...base,
    status: 'cancelled',
    scenario: { profile: 'custom', seed: 1, steps: [{ kind: 'load', cache: 'warm', reps: 1 }] },
    model: { ...base.model, quant: undefined, facts: undefined },
    engine: { ...base.engine, variant: undefined, version: undefined },
    launch: { ...base.launch, env: {}, params: { gpuLayers: 20, flashAttention: 'off', extraArgs: [], env: {} } },
    metrics: {
      formulaVersion: 1,
      load: { phases: [] },
      latency: [],
      concurrency: [],
      llamaBench: [],
      vram: {},
      energy: {},
      thermals: { throttleReasons: [] },
    },
    validity: ['unstable', 'energy_unavailable', 'tokens_approximate', 'slow_shared_filesystem', 'output_not_exact', 'cold_probably_cached', 'vram_approximate'],
    telemetry: undefined,
  };
}

describe('boot', () => {
  it('mounts the app into #root and refuses a page without it', async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, '', '/?token=t#/');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 500 }));
    const { boot } = await import('../../../src/renderer/main');
    await waitFor(() => expect(document.getElementById('root')!.childElementCount).toBeGreaterThan(0));
    const empty = document.implementation.createHTMLDocument('x');
    await expect(boot(empty)).rejects.toThrow('#root missing');
    // The booted app stays mounted on its own root: detach it so later tests start clean.
    document.body.innerHTML = '';
  });
});

describe('Select', () => {
  it('opens and picks an option', async () => {
    Object.assign(Element.prototype, { hasPointerCapture: () => false, releasePointerCapture: () => undefined, scrollIntoView: () => undefined });
    const onChange = vi.fn();
    renderUi(
      <Select
        aria-label="Lingua"
        value="it"
        onValueChange={onChange}
        options={[
          { value: 'it', label: 'Italiano' },
          { value: 'en', label: 'English', description: 'Inglese' },
        ]}
      />,
    );
    const trigger = screen.getByRole('combobox', { name: 'Lingua' });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Enter' });
    const option = await screen.findByRole('option', { name: /English/ });
    fireEvent.keyDown(option, { key: 'Enter' });
    fireEvent.click(option);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('en'));
  });
});

describe('sparse data', () => {
  it('a result with almost nothing measured still reads well', async () => {
    state.run = sparseRun();
    renderApp(`/results/${MOCK_RUN_ID}`);
    expect(await h1(/Qwen3 8B/)).toBeTruthy();
    expect(screen.getByText('Annullato')).toBeTruthy();
    expect(screen.getByText(/più o meno alla velocità con cui leggi/)).toBeTruthy();
    expect(screen.getByText('Il punteggio si calcola solo con i profili standard.')).toBeTruthy();
    const kpis = screen.getByRole('region', { name: 'Numeri principali' });
    expect(within(kpis).getAllByText('–').length).toBeGreaterThan(4);
    for (const action of ['Rifai il test', 'Scopri di più', 'Copia il modello nello spazio Docker', 'Attiva misure a freddo reali']) {
      expect(screen.getAllByRole('button', { name: action }).length).toBeGreaterThan(0);
    }
    expect(screen.queryByRole('heading', { name: 'Scheda video durante il test' })).toBeNull();
    await userEvent.click(screen.getByRole('tab', { name: 'Come è stato avviato' }));
    expect(screen.getByText('20 livelli in GPU')).toBeTruthy();
    expect(screen.getByText('Nessuno')).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: 'Dettagli' }));
    expect(screen.getByRole('table', { name: 'Caricamento del modello' }).textContent).toContain('–');
  });

  it('a result with a single non-512 prompt length', async () => {
    const run = getMockRun(MOCK_RUN_ID);
    state.run = { ...run, metrics: { ...run.metrics, latency: [run.metrics.latency[3]!] } };
    renderApp(`/results/${MOCK_RUN_ID}`);
    expect((await screen.findAllByText('2048 token')).length).toBe(2);
  });

  it('shows a skeleton while a result loads', async () => {
    state.run = null;
    renderApp(`/results/${MOCK_RUN_ID}`);
    await waitFor(() => expect(document.querySelectorAll('.skeleton-shimmer').length).toBeGreaterThan(0));
  });

  it('empty history shows a friendly empty state', async () => {
    state.runs = [];
    renderApp('/results');
    expect(await screen.findByRole('heading', { name: 'Ancora nessun risultato' })).toBeTruthy();
    await userEvent.click(screen.getByRole('link', { name: 'Vai al Benchmark' }));
    expect(await h1('Benchmark')).toBeTruthy();
  });

  it('no downloads and no GPU', async () => {
    state.downloads = [];
    state.system = { ...mockSystem, gpus: [], otherGpuUsers: [] };
    renderApp('/models');
    await userEvent.click(await screen.findByRole('tab', { name: /Download/ }));
    expect(screen.getByRole('heading', { name: 'Nessun download in corso' })).toBeTruthy();
    expect(screen.getByText('Nessuna GPU NVIDIA trovata')).toBeTruthy();
  });

  it('benchmark and welcome without GPU data', async () => {
    state.system = { ...mockSystem, gpus: [] };
    state.engines = [];
    renderApp('/');
    expect(await h1('Benchmark')).toBeTruthy();
    expect(document.querySelectorAll('.skeleton-shimmer').length).toBeGreaterThan(0);
    expect(screen.getByText(/Installato · b11438/)).toBeTruthy();
    expect(screen.queryByRole('meter', { name: 'VRAM' })).toBeTruthy();
  });

  it('welcome without GPU data', async () => {
    state.system = { ...mockSystem, gpus: [] };
    renderApp('/welcome', fakeApi({ onboardingDone: false }));
    expect(await screen.findByText('Versione – · CUDA –')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Continua' }));
    expect(screen.getByText(/Per la tua GPU/)).toBeTruthy();
  });

  it('monitor without GPU users', async () => {
    state.system = { ...mockSystem, gpus: [], otherGpuUsers: [] };
    renderApp('/monitor');
    expect(await h1('Monitor GPU')).toBeTruthy();
    expect(screen.getAllByText('–').length).toBeGreaterThan(0);
  });

  it('results list filters by GPU and engine', async () => {
    Object.assign(Element.prototype, { hasPointerCapture: () => false, releasePointerCapture: () => undefined, scrollIntoView: () => undefined });
    renderApp('/results');
    const table = await screen.findByRole('table', { name: 'Risultati' });
    const gpu = screen.getByRole('combobox', { name: 'Scheda video' });
    gpu.focus();
    fireEvent.keyDown(gpu, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('option', { name: 'RTX 3070' }));
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(2));
    const engine = screen.getByRole('combobox', { name: 'Motore' });
    engine.focus();
    fireEvent.keyDown(engine, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('option', { name: 'vLLM (Docker)' }));
    await waitFor(() => expect(screen.getByText('Nessuna riga da mostrare.')).toBeTruthy());
  });

  it('settings change the language through the select', async () => {
    Object.assign(Element.prototype, { hasPointerCapture: () => false, releasePointerCapture: () => undefined, scrollIntoView: () => undefined });
    const api = fakeApi({ onboardingDone: true });
    renderApp('/settings', api);
    const lang = await screen.findByRole('combobox', { name: 'Lingua' });
    lang.focus();
    fireEvent.keyDown(lang, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('option', { name: 'English' }));
    expect(await h1('Settings')).toBeTruthy();
    await waitFor(() => expect(api.settings.language).toBe('en'));
    act(() => undefined);
  });
});
