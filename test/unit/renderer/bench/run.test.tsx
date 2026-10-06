import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GpuSample } from '../../../../src/contract/hardware';
import { niceMax } from '../../../../src/renderer/routes/run';
import { renderApp } from '../helpers';
import { exerciseFormatters } from './charts';
import { IDS, summaries } from './fixtures';
import { apiError, benchApi, planFor } from './world';

const charts = vi.hoisted(() => ({ options: [] as Record<string, unknown>[] }));
vi.mock('echarts/core', () => ({
  use: vi.fn(),
  init: vi.fn(() => ({ setOption: vi.fn((o: Record<string, unknown>) => charts.options.push(o)), resize: vi.fn(), dispose: vi.fn() })),
}));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({ AxisPointerComponent: {}, DataZoomComponent: {}, GridComponent: {}, LegendComponent: {}, MarkAreaComponent: {}, MarkLineComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

afterEach(() => {
  charts.options.length = 0;
});

const RUN = '01M48PNN41KKD0ABVXTGK97Y6P';
const h1 = (name: string | RegExp) => screen.findByRole('heading', { level: 1, name });

function sample(t: number, over: Partial<GpuSample> = {}): GpuSample {
  return { t, gpu: 0, utilPct: 90, memUsedMiB: 9000, memTotalMiB: 32607, powerW: 420, tempC: 64, smClockMHz: 2600, memClockMHz: 14000, pcieGen: 5, pcieWidth: 16, throttle: [], ...over };
}

/** Starts a run from the Benchmark page, so the live screen has the start context. */
async function startFromHome() {
  const api = benchApi();
  api.world.plan = () =>
    planFor({
      estimatedSeconds: 600,
      scenario: {
        profile: 'standard',
        seed: 42,
        steps: [
          { kind: 'load', cache: 'cold', reps: 1 },
          { kind: 'load', cache: 'warm', reps: 3 },
          { kind: 'latency', promptTokens: [512, 4096], outputTokens: 256, warmup: 1, reps: 5 },
          { kind: 'concurrency', levels: [1, 4], promptTokens: 512, outputTokens: 128, requestsPerWorker: 4 },
          { kind: 'llama-bench', pp: 512, tg: 128, reps: 5 },
        ],
      },
    });
  const view = renderApp('/', api);
  await screen.findAllByText('≈ 10 min 00 s');
  await userEvent.click(screen.getByRole('button', { name: 'Avvia benchmark' }));
  expect(await h1('Test in corso')).toBeTruthy();
  return { ...view, api };
}

describe('live run', () => {
  it('follows the phases, gauges, telemetry and log, then opens the result', async () => {
    const { api, router } = await startFromHome();
    expect(screen.getByText('qwen3-8b model · Q4_K_M · llama.cpp · Rapido')).toBeTruthy();
    const steps = screen.getByRole('list', { name: 'Fasi del test' });
    expect(within(steps).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      expect.stringContaining('Preparazione'),
      expect.stringContaining('A freddo'),
      expect.stringContaining('A caldo'),
      expect.stringContaining('Lettura prompt'),
      expect.stringContaining('Generazione'),
      expect.stringContaining('Più utenti'),
      expect.stringContaining('Test standard'),
      expect.stringContaining('Pulizia'),
    ]);
    expect(screen.getByText('Fase 1 di 8')).toBeTruthy();
    expect(screen.getByText(/Mancano circa/)).toBeTruthy();
    expect(screen.getByText('I grafici compaiono appena la scheda video manda i primi dati.')).toBeTruthy();
    expect(screen.getByRole('meter', { name: 'Generazione' }).textContent).toContain('–');

    act(() => api.emit({ type: 'telemetry', samples: [sample(1000), sample(1250, { memUsedMiB: null, utilPct: null, powerW: null, tempC: null })] }));
    act(() => api.emit({ type: 'run.phase', runId: RUN, phase: 'cold-load', progress: 0.1, detail: '1' }));
    expect(screen.getByText('Caricamento 1 di 1')).toBeTruthy();
    expect(screen.getByText('Fase 2 di 8')).toBeTruthy();
    act(() => api.emit({ type: 'telemetry', samples: [sample(1500), sample(1750, { gpu: 1 })] }));
    act(() => api.emit({ type: 'run.phase', runId: RUN, phase: 'prefill', progress: 0.4, detail: '4096' }));
    expect(screen.getByText('Testo da 4096 token')).toBeTruthy();
    act(() => api.emit({ type: 'run.live', runId: RUN, decodeTps: 190.6, prefillTps: 8950, ttftMs: 57 }));
    expect(screen.getByRole('meter', { name: 'Generazione' }).textContent).toContain('190,6');
    expect(screen.getByRole('meter', { name: 'VRAM' }).textContent).toContain('8,8');
    act(() => api.emit({ type: 'run.phase', runId: RUN, phase: 'concurrency', progress: 0.7, detail: '4' }));
    expect(screen.getByText('4 utenti insieme')).toBeTruthy();
    act(() => api.emit({ type: 'run.phase', runId: RUN, phase: 'decode', progress: 0.8, detail: 'llama-bench' }));
    expect(screen.getByText(/Eseguo llama-bench/)).toBeTruthy();
    act(() => api.emit({ type: 'run.phase', runId: 'someone-else', phase: 'cleanup', progress: 1 }));
    expect(screen.queryByText(/Chiudo il motore/)).toBeNull();

    // The chart and its table.
    await waitFor(() => expect(charts.options.length).toBeGreaterThan(0));
    expect(exerciseFormatters(charts.options.at(-1)).join(' ')).toContain('%');
    await userEvent.click(screen.getByRole('button', { name: 'Mostra tabella' }));
    expect(screen.getByRole('table', { name: /Scheda video in tempo reale/ }).textContent).toContain('8,8');

    // The log is folded for beginners.
    expect(screen.getByText('0 righe')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Mostra il log del server' }));
    expect(screen.getByRole('region', { name: 'Log del server' }).textContent).toBe('Il motore non ha ancora scritto nulla.');
    act(() => api.emit({ type: 'run.log', runId: RUN, lines: ['ggml_cuda_init: found 1 CUDA devices', 'main: server is listening'] }));
    expect(screen.getByRole('region', { name: 'Log del server' }).textContent).toContain('server is listening');

    act(() => api.emit({ type: 'run.error', runId: RUN, error: { code: 'INTERNAL', message: 'x' } }));
    act(() => api.emit({ type: 'run.done', runId: RUN, summary: summaries()[0]! }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/results/${RUN}`));
  });

  it('cancels after confirmation; a refused cancel lets the user try again', async () => {
    const { api } = await startFromHome();
    let refuse = true;
    api.world.routes[`POST /api/runs/${RUN}/cancel`] = () => {
      if (refuse) throw apiError('RUN_NOT_FOUND', undefined, 404);
      return { ok: true };
    };
    await userEvent.click(screen.getByRole('button', { name: 'Annulla test' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Continua il test' }));
    await userEvent.click(screen.getByRole('button', { name: 'Annulla test' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Annulla il test' }));
    expect(await screen.findByText('Risultato non trovato')).toBeTruthy();
    refuse = false;
    await userEvent.click(screen.getByRole('button', { name: 'Annulla test' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Annulla il test' }));
    expect(await screen.findByRole('button', { name: 'Annullamento in corso…' })).toBeTruthy();
  });

  it('a reopened screen resumes from the core; a finished run opens its result', async () => {
    const api = benchApi({ active: { runId: IDS.full, phase: 'decode', progress: 0.5 } });
    const { router } = renderApp(`/run/${IDS.full}`, api);
    expect(await screen.findByText('Il test sta continuando: ecco dove è arrivato.')).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/Il modello sta scrivendo testo di prova/)).toBeTruthy());
    expect(screen.getByRole('progressbar', { name: 'Avanzamento del test' }).getAttribute('aria-valuetext')).toBe('50%');
    expect(screen.getByText(/Mancano circa/)).toBeTruthy();
    // No power limit known: the scale follows the readings.
    act(() => api.emit({ type: 'telemetry', samples: [sample(10, { powerW: 470 })] }));
    api.world.active = null;
    await waitFor(() => expect(router.state.location.pathname).toBe(`/results/${IDS.full}`), { timeout: 5000 });
  });

  it('without GPU data or power limit the gauges still read well', async () => {
    const api = benchApi({ active: { runId: RUN, phase: 'prepare', progress: 0 }, system: { ...benchApi().world.system, gpus: [] } });
    renderApp(`/run/${RUN}`, api);
    expect(await screen.findByText('Calcolo il tempo rimanente…')).toBeTruthy();
    expect(screen.getByRole('meter', { name: 'Potenza' }).textContent).toContain('500');
    act(() => api.emit({ type: 'telemetry', samples: [sample(10, { memTotalMiB: null, memUsedMiB: null })] }));
    expect(screen.getByRole('meter', { name: 'VRAM' }).textContent).toContain('–');
  });

  it('scales gauges to round numbers', () => {
    expect(niceMax(undefined, 50)).toBe(50);
    expect(niceMax(190, 50)).toBe(500);
    expect(niceMax(70, 50)).toBe(100);
    expect(niceMax(150, 50)).toBe(200);
  });
});
