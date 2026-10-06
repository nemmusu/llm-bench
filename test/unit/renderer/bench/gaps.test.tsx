/** Less common paths of the benchmark flow: odd data, failures in the middle, late answers. */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StartRunRequest } from '../../../../src/contract/api';
import type { DownloadJob } from '../../../../src/contract/models';
import type { RunResult } from '../../../../src/contract/results';
import { diffRows } from '../../../../src/renderer/components/bench/compare-rows';
import { peakConcurrency } from '../../../../src/renderer/components/bench/format';
import { filterRuns, NO_FILTERS } from '../../../../src/renderer/components/bench/history';
import { kpisOf } from '../../../../src/renderer/components/bench/kpis';
import { initialLive, liveReducer } from '../../../../src/renderer/components/bench/live-state';
import { paramParts } from '../../../../src/renderer/components/bench/summary';
import { createFormatters } from '../../../../src/renderer/i18n';
import { reportToMarkdown } from '../../../../src/renderer/lib/export/markdown';
import { reportOf } from '../../../../src/renderer/lib/export/report';
import { ApiError } from '../../../../src/renderer/lib/api';
import { apiErrorData } from '../../../../src/renderer/lib/queries-runs';
import { processList } from '../../../../src/renderer/components/bench/start-flow';
import { renderApp } from '../helpers';
import { exerciseFormatters } from './charts';
import { IDS, seeded, summaries } from './fixtures';
import { apiError, benchApi, curatedModel, deferred, localModel, planFor, activeRun } from './world';

const charts = vi.hoisted(() => ({ options: [] as Record<string, unknown>[] }));
vi.mock('echarts/core', () => ({
  use: vi.fn(),
  init: vi.fn(() => ({ setOption: vi.fn((o: Record<string, unknown>) => charts.options.push(o)), resize: vi.fn(), dispose: vi.fn() })),
}));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({ AxisPointerComponent: {}, DataZoomComponent: {}, GridComponent: {}, LegendComponent: {}, MarkAreaComponent: {}, MarkLineComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

const it_ = createFormatters('it');
const clipboard = { writeText: vi.fn(async (_t: string) => undefined) };

beforeAll(() => {
  Object.assign(Element.prototype, { hasPointerCapture: () => false, releasePointerCapture: () => undefined, scrollIntoView: () => undefined });
});
beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
});
afterEach(() => {
  charts.options.length = 0;
});

const h1 = (name: string | RegExp) => screen.findByRole('heading', { level: 1, name });
const start = () => userEvent.click(screen.getByRole('button', { name: 'Avvia benchmark' }));
const posted = (api: ReturnType<typeof benchApi>, path: string) => api.calls.filter((c) => c.method === 'POST' && c.path === path);
const notInstalled = () => benchApi().world.engines.map((e) => (e.kind === 'llamacpp-native' ? { ...e, installed: false, available: false } : e));
const job = (over: Partial<DownloadJob> = {}): DownloadJob => ({ id: 'j', label: 'g', files: [], dest: 'x', state: 'running', bytesDone: 0, createdAt: '2026-10-06T00:00:00.000Z', ...over });

async function choose(combobox: string, option: string | RegExp) {
  const trigger = await screen.findByRole('combobox', { name: combobox });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
  fireEvent.click(await screen.findByRole('option', { name: option }));
}

describe('pure edge cases', () => {
  it('helpers with missing values', () => {
    expect(apiErrorData('plain')).toEqual({ code: 'INTERNAL', message: 'plain' });
    expect(processList({ names: 'a, b', pids: '1' })).toBe('a (PID 1), b');
    expect(processList(undefined)).toBe('');
    expect(apiErrorData(new Error('e'))).toEqual({ code: 'INTERNAL', message: 'e' });
    expect(apiErrorData(new ApiError({ code: 'NETWORK', message: 'n' }, 0)).code).toBe('NETWORK');
    const run = seeded(IDS.full);
    expect(peakConcurrency({ metrics: { ...run.metrics, concurrency: [run.metrics.concurrency[4]!, run.metrics.concurrency[0]!] } })?.level).toBe(16);
    const [s] = summaries([seeded(IDS.full)]);
    expect(filterRuns([{ ...s!, quant: undefined }], { ...NO_FILTERS, q: 'qwen' }, 'x')).toHaveLength(1);
    const noEngine = { ...run.metrics, latency: run.metrics.latency.map((p) => ({ ...p, prefillTpsEngine: undefined })) };
    expect(kpisOf({ metrics: noEngine }).prefill).toBe(noEngine.latency[1]!.prefillTps);
    const live = liveReducer(initialLive(), { type: 'run.phase', runId: 'r', phase: 'prepare', progress: 0 }, 'r');
    expect(live.marks).toEqual([{ t: 0, phase: 'prepare' }]);
    expect(paramParts('llamacpp-native', { extraArgs: [], env: {}, batchSize: 1024 }, undefined, it_)).toContain('batch 1024/–');
    expect(reportToMarkdown(reportOf(seeded(IDS.failed), it_), { powershell: 'PS', bash: 'sh' })).not.toContain('> ');
    expect(reportOf(seeded(IDS.vllm), it_).sections.find((x) => x.title === 'Da sapere su questo risultato')!.callouts!.map((c) => c.title)).toContain('vLLM userà meno memoria del solito');
  });

  it('settings and missing data on either side of a comparison', () => {
    const full = seeded(IDS.full);
    const bare: RunResult = {
      ...full,
      engine: { kind: 'llamacpp-native', name: 'llama.cpp' },
      model: { ...full.model, quant: undefined, sizeBytes: undefined, sha256: undefined },
      hardware: { ...full.hardware, gpus: [] },
      launch: { ...full.launch, params: { extraArgs: ['--metrics'], env: { A: '1' } } },
    };
    for (const [a, b] of [
      [bare, full],
      [full, bare],
    ] as const) {
      const rows = diffRows(a, b, it_);
      expect(rows.find((r) => r.label === 'Argomenti extra')?.differs).toBe(true);
      expect(rows.find((r) => r.label === 'Variabili d’ambiente')?.differs).toBe(true);
      expect(rows.find((r) => r.label === 'Driver')?.differs).toBe(true);
    }
  });
});

describe('benchmark: unusual data', () => {
  it('a local model with a hash but no quant, size or parameters; a failing fit', async () => {
    const api = benchApi({ local: [localModel('raw', { quant: undefined, sizeBytes: undefined, sha256: 'feed', facts: undefined })], curated: [] });
    api.world.routes['POST /api/models/fit'] = () => {
      throw apiError('MODEL_INVALID');
    };
    renderApp('/', api);
    expect(await screen.findByRole('button', { name: 'Cambia modello: raw-Q4_K_M' })).toBeTruthy();
    await waitFor(() => expect(api.calls.some((c) => c.path === '/api/runs/tried?weakKey=local%2Fraw.gguf%2FQ4_K_M%2F5&sha256=feed')).toBe(true));
    await userEvent.click(screen.getByRole('button', { name: /Cambia modello/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByText(/miliardi/)).toBeNull();
    expect(within(dialog).queryByText('Entra perfettamente')).toBeNull();
  });

  it('llama.cpp reported installed, but the plan says otherwise: the plan wins', async () => {
    const api = benchApi();
    api.world.plan = () => {
      throw apiError('ENGINE_NOT_INSTALLED');
    };
    renderApp('/', api);
    // A plan that cannot be made says why; nothing is guessed to be missing.
    expect(await screen.findByRole('heading', { name: 'Il motore non è installato' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /Anteprima comando/ }));
    expect(screen.getByText('Il comando non è disponibile: controlla le scelte qui sopra.')).toBeTruthy();
    expect(screen.getByText('Installato · b11438')).toBeTruthy();
    api.world.plan = () => planFor({ needs: [{ kind: 'engine', label: 'llama.cpp', bytes: 1024 * 1024 }] });
    await userEvent.click(screen.getByRole('radio', { name: /Standard/ }));
    expect(await screen.findByText('Verrà installato prima del test: 1,0 MB')).toBeTruthy();
  });

  it('a Docker engine whose image is missing: pulled first, with progress', async () => {
    const image = 'ghcr.io/ggml-org/llama.cpp:server-cuda';
    const engines = benchApi().world.engines.map((e) => (e.kind === 'llamacpp-docker' ? { ...e, problems: ['ENGINE_NOT_INSTALLED'] } : e));
    const api = benchApi({ engines });
    api.settings.lastEngine = { kind: 'llamacpp-docker' };
    let fail = true;
    api.world.routes['POST /api/engines/llamacpp-docker/install'] = () => {
      if (fail) throw apiError('DOCKER_NOT_RUNNING');
      return { ok: true };
    };
    renderApp('/', api);
    expect(await screen.findByText('Immagine da scaricare prima del test')).toBeTruthy();
    expect(await screen.findByText('Immagine da scaricare prima del test: 2,7 GB')).toBeTruthy();
    expect(screen.getByText('· verrà scaricata prima del test')).toBeTruthy();
    await start();
    const confirm = await screen.findByRole('dialog', { name: 'Prima di iniziare scarico quello che manca' });
    expect(within(confirm).getByText(`Scarico l’immagine ${image}`)).toBeTruthy();
    expect(within(confirm).getByText('Il motore pronto per Docker. Succede solo la prima volta.')).toBeTruthy();
    await userEvent.click(within(confirm).getByRole('button', { name: 'Scarica e avvia' }));
    expect(await screen.findByRole('heading', { name: 'Docker non è avviato' })).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Riprova' }));
    await waitFor(() => expect(posted(api, '/api/engines/llamacpp-docker/install')).toHaveLength(2));
    expect(posted(api, '/api/engines/llamacpp-docker/install')[1]!.body).toEqual({ image });
    api.world.engines = benchApi().world.engines;
    act(() => api.emit({ type: 'engine.install', kind: 'llamacpp-native', stage: 'download', bytesDone: 1 }));
    act(() => api.emit({ type: 'engine.install', kind: 'llamacpp-docker', image, stage: 'download', bytesDone: 1024 ** 3, bytesTotal: 2 * 1024 ** 3 }));
    await waitFor(() => expect(screen.getByRole('progressbar', { name: image }).getAttribute('aria-valuetext')).toBe('1,0 GB di 2,0 GB'));
    act(() => api.emit({ type: 'engine.install', kind: 'llamacpp-docker', image, stage: 'done', bytesDone: 2, bytesTotal: 2 }));
    expect(await h1('Test in corso')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Fasi del test' }).textContent).toContain('Installazione');
  });

  it('a GPU whose driver version is unknown', async () => {
    const system = benchApi().world.system;
    const { driverVersion: _unknown, ...gpu } = system.gpus[0]!;
    renderApp('/', benchApi({ system: { ...system, gpus: [gpu] } }));
    expect(await screen.findByText(/RTX 5090 · 32 GB · driver –/)).toBeTruthy();
  });

  it('a custom executable is not something to install: the plan error is shown', async () => {
    const api = benchApi();
    api.settings.expertMode = true;
    api.settings.lastEngine = { kind: 'llamacpp-native', executable: 'C:\\x\\llama-server.exe' };
    api.world.plan = () => {
      throw apiError('ENGINE_NOT_INSTALLED');
    };
    renderApp('/', api);
    expect(await screen.findByRole('heading', { name: 'Il motore non è installato' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Eseguibile personalizzato'), { target: { value: 'C:\\y\\llama-server.exe' } });
    expect((screen.getByLabelText('Eseguibile personalizzato') as HTMLInputElement).value).toBe('C:\\y\\llama-server.exe');
  });

  it('a vLLM repo need without a size says so; a GPU-busy warning without names', async () => {
    const api = benchApi();
    api.settings.lastEngine = { kind: 'vllm-docker' };
    api.settings.lastModelId = 'curated:vllm-4b';
    api.world.plan = () => planFor({ needs: [{ kind: 'model', label: 'Qwen/Qwen3-4B-AWQ' }], warnings: [{ code: 'VRAM_BUSY' }] });
    renderApp('/', api);
    expect(await screen.findByText('Verrà scaricato prima del test')).toBeTruthy();
    expect(screen.getByText('Prima scarico vllm-4b · Q4_K_M.')).toBeTruthy();
    api.world.routes['POST /api/downloads'] = () => job({ state: 'done' });
    await start();
    expect(screen.getByText('dimensione da verificare')).toBeTruthy();
    await userEvent.click(await screen.findByRole('button', { name: 'Scarica e avvia' }));
    const busy = await screen.findByRole('dialog', { name: 'La scheda video è già occupata' });
    expect(within(busy).getByText('Programmi non identificati')).toBeTruthy();
  });
});

describe('start before the preview is ready', () => {
  it('fetches the preview of these exact choices first', async () => {
    const api = benchApi();
    const plans: ReturnType<typeof deferred<ReturnType<typeof planFor>>>[] = [];
    api.world.plan = () => {
      const d = deferred<ReturnType<typeof planFor>>();
      plans.push(d);
      return d.promise as never;
    };
    renderApp('/', api);
    await waitFor(() => expect(plans).toHaveLength(1));
    // No preview yet: the start asks for one and waits.
    await start();
    expect(await screen.findByRole('dialog', { name: 'Avvio del test…' })).toBeTruthy();
    await waitFor(() => expect(plans).toHaveLength(2));
    await act(async () => plans[1]!.resolve(planFor()));
    expect(await h1('Test in corso')).toBeTruthy();
    expect(screen.getByText('Fase 1 di 4')).toBeTruthy();
  });

  it('a changed choice, a preview still loading, a preview that fails, a close while waiting', async () => {
    const api = benchApi();
    let plans = 0;
    let mode: 'ok' | 'hang' | 'fail' = 'ok';
    const hanging = deferred<ReturnType<typeof planFor>>();
    api.world.plan = () => {
      plans++;
      if (mode === 'hang') return hanging.promise as never;
      if (mode === 'fail') throw apiError('INTERNAL');
      return planFor();
    };
    api.world.routes['POST /api/runs'] = () => {
      throw apiError('ENGINE_PORT_IN_USE');
    };
    renderApp('/', api);
    await screen.findAllByText('≈ 1 min 35 s');
    // Changed just now (the preview of the new choice is not asked yet): the start fetches it.
    await userEvent.click(screen.getByRole('radio', { name: /Completo/ }));
    await start();
    expect(await screen.findByRole('dialog', { name: 'Il test non è partito' })).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    // The new preview is loading (the old one is still on screen): same.
    mode = 'hang';
    await userEvent.click(screen.getByRole('radio', { name: /Standard/ }));
    await waitFor(() => expect(plans).toBeGreaterThanOrEqual(3));
    mode = 'fail';
    await start();
    expect(await screen.findByRole('dialog', { name: 'Il test non è partito' })).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    // Closing while the preview is fetched: its late answer starts nothing.
    mode = 'hang';
    const runsBefore = posted(api, '/api/runs').length;
    await start();
    expect(await screen.findByRole('dialog', { name: 'Avvio del test…' })).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    await act(async () => hanging.resolve(planFor()));
    expect(posted(api, '/api/runs')).toHaveLength(runsBefore);
  });
});

describe('start flow: failures in the middle', () => {
  it('engine and model together: one waits, the install without sizes ends at 100%', async () => {
    const api = benchApi({ engines: notInstalled(), local: [], curated: [curatedModel('gemma-12b')], installBytes: null });
    api.world.routes['POST /api/engines/llamacpp-native/install'] = () => ({ ok: true });
    api.world.routes['POST /api/downloads'] = () => job({ id: 'd1' });
    renderApp('/', api);
    await screen.findByText('Verrà scaricato prima del test: 2,3 GB');
    await start();
    await userEvent.click(await screen.findByRole('button', { name: 'Scarica e avvia' }));
    const dialog = await screen.findByRole('dialog', { name: 'Preparo il test' });
    expect(within(dialog).getByText('In attesa')).toBeTruthy();
    expect(within(dialog).getByRole('progressbar', { name: 'gemma-12b · Q4_K_M' }).getAttribute('aria-valuetext')).toBe('0%');
    act(() => api.emit({ type: 'engine.install', kind: 'llamacpp-native', stage: 'extract', bytesDone: 0 }));
    act(() => api.emit({ type: 'engine.install', kind: 'llamacpp-native', stage: 'done', bytesDone: 0 }));
    await waitFor(() => expect(within(dialog).getByRole('progressbar', { name: 'llama.cpp' }).getAttribute('aria-valuetext')).toBe('100%'));
    await waitFor(() => expect(posted(api, '/api/downloads')).toHaveLength(1));
    // Other events while downloading are ignored; a fresh plan that fails keeps the one from before.
    api.world.plan = () => {
      throw apiError('INTERNAL');
    };
    act(() => api.emit({ type: 'runs.changed' }));
    act(() => api.emit({ type: 'download.update', job: job({ id: 'd1', state: 'done', bytesDone: 1 }) }));
    expect(await h1('Test in corso')).toBeTruthy();
    expect((posted(api, '/api/runs')[0]!.body as StartRunRequest).model).toEqual({ repo: 'org/gemma-12b-GGUF', file: 'gemma-12b.gguf', revision: 'b'.repeat(40) });
    expect(screen.getByText('Fase 3 di 6')).toBeTruthy();
  });

  it('the engine is installed, then the model download fails: each row says how it went', async () => {
    const api = benchApi({ engines: notInstalled(), local: [], curated: [curatedModel('gemma-12b')] });
    api.world.routes['POST /api/engines/llamacpp-native/install'] = () => ({ ok: true });
    api.world.routes['POST /api/downloads'] = () => {
      throw apiError('DISK_FULL');
    };
    renderApp('/', api);
    await screen.findByText('Verrà scaricato prima del test: 2,3 GB');
    await start();
    await userEvent.click(await screen.findByRole('button', { name: 'Scarica e avvia' }));
    act(() => api.emit({ type: 'engine.install', kind: 'llamacpp-native', stage: 'done', bytesDone: 1, bytesTotal: 1 }));
    expect(await screen.findByRole('heading', { name: 'Spazio su disco esaurito' })).toBeTruthy();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Pronto')).toBeTruthy();
    expect(within(dialog).getByText('Non riuscito')).toBeTruthy();
  });

  it('a rescan that crashes, a cancel that fails, a fresh plan that arrives after closing', async () => {
    const api = benchApi({ local: [], curated: [curatedModel('gemma-12b')] });
    api.world.routes['POST /api/downloads'] = () => job({ id: 'd2', state: 'done' });
    api.world.routes['POST /api/models/rescan'] = () => {
      throw new TypeError('Failed to fetch');
    };
    renderApp('/', api);
    await screen.findByText('Verrà scaricato prima del test: 2,3 GB');
    await start();
    await userEvent.click(await screen.findByRole('button', { name: 'Scarica e avvia' }));
    expect(await screen.findByRole('heading', { name: 'Si è verificato un errore imprevisto' })).toBeTruthy();
    await userEvent.click(within(screen.getByRole('dialog')).getAllByRole('button', { name: 'Chiudi' }).at(-1)!);

    // Running download, cancel refused by the core: the dialog still closes.
    api.world.routes['POST /api/downloads'] = () => job({ id: 'd3' });
    api.world.routes['POST /api/downloads/d3/cancel'] = () => {
      throw apiError('DOWNLOAD_NOT_FOUND');
    };
    await start();
    await userEvent.click(await screen.findByRole('button', { name: 'Scarica e avvia' }));
    await waitFor(() => expect(posted(api, '/api/downloads')).toHaveLength(2));
    await userEvent.click(screen.getByRole('button', { name: 'Annulla' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // A download answer that arrives after closing is ignored too.
    const late = deferred<DownloadJob>();
    api.world.routes['POST /api/downloads'] = () => late.promise;
    await start();
    await userEvent.click(await screen.findByRole('button', { name: 'Scarica e avvia' }));
    await waitFor(() => expect(posted(api, '/api/downloads')).toHaveLength(3));
    await userEvent.keyboard('{Escape}');
    await act(async () => late.resolve(job({ id: 'd5' })));
    expect(screen.queryByRole('dialog')).toBeNull();

    // Download done, rescan fine, but the fresh plan comes back after the user closed the dialog.
    delete api.world.routes['POST /api/models/rescan'];
    const plan = deferred<ReturnType<typeof planFor>>();
    api.world.routes['POST /api/downloads'] = () => {
      api.world.plan = () => plan.promise as never;
      return job({ id: 'd4', state: 'done' });
    };
    await start();
    await userEvent.click(await screen.findByRole('button', { name: 'Scarica e avvia' }));
    await waitFor(() => expect(posted(api, '/api/runs/plan').length).toBeGreaterThan(0));
    await userEvent.keyboard('{Escape}');
    await act(async () => plan.resolve(planFor()));
    expect(posted(api, '/api/runs')).toHaveLength(0);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('no plan can be made (Hugging Face unreachable): the guessed needs are fetched, then the run starts', async () => {
    const api = benchApi({ local: [], curated: [curatedModel('gemma-12b')] });
    api.world.plan = () => {
      throw apiError('NETWORK', undefined, 0);
    };
    api.world.routes['POST /api/downloads'] = () => job({ id: 'd7', state: 'done' });
    renderApp('/', api);
    expect(await screen.findByRole('heading', { name: 'Connessione a internet non disponibile' })).toBeTruthy();
    expect(screen.getByText('Verrà scaricato prima del test: 2,3 GB')).toBeTruthy();
    await start();
    await userEvent.click(await screen.findByRole('button', { name: 'Scarica e avvia' }));
    expect(await h1('Test in corso')).toBeTruthy();
    expect(posted(api, '/api/downloads')[0]!.body).toMatchObject({ repo: 'org/gemma-12b-GGUF', files: ['gemma-12b.gguf'] });
    // Without a plan the live screen takes the scenario from the core's active run.
    expect(await screen.findByText('Fase 2 di 5')).toBeTruthy();
  });

  it('own server: the list cannot be read, or stopping fails', async () => {
    const api = benchApi();
    let owned = true;
    api.world.routes['POST /api/runs'] = () => {
      if (owned) throw apiError('VRAM_BUSY', { reason: 'own_server' });
      api.world.active = activeRun('01M48PNN41KKD0ABVXTGK97Y6P');
      return { runId: '01M48PNN41KKD0ABVXTGK97Y6P' };
    };
    api.world.routes['GET /api/servers'] = () => {
      throw apiError('INTERNAL');
    };
    renderApp('/', api);
    await screen.findAllByText('≈ 1 min 35 s');
    await start();
    expect(await screen.findByRole('dialog', { name: 'La scheda video è già occupata' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Annulla' }));
    api.world.routes['GET /api/servers'] = () => [{ id: 's9', baseUrl: 'http://h:1', openaiUrl: 'http://h:1/v1', modelName: 'M', engineLabel: 'e', startedAt: new Date().toISOString(), command: { argv: [], powershell: '', bash: '' } }];
    api.world.routes['DELETE /api/servers/s9'] = () => {
      throw apiError('VALIDATION');
    };
    await start();
    owned = false;
    await userEvent.click(await screen.findByRole('button', { name: 'Ferma il server e avvia' }));
    expect(await h1('Test in corso')).toBeTruthy();
  });
});

describe('live run: odd ids and late polls', () => {
  it('a run id that is not a ULID, another run finishing, a poll after events', async () => {
    const api = benchApi({ active: activeRun('plain', { phase: 'prepare', progress: 0 }) });
    const { router } = renderApp('/run/plain', api);
    expect(await h1('Test in corso')).toBeTruthy();
    act(() => api.emit({ type: 'telemetry', samples: [{ t: 0, gpu: 0, utilPct: null, memUsedMiB: null, memTotalMiB: null, powerW: null, tempC: null, smClockMHz: null, memClockMHz: null, pcieGen: null, pcieWidth: null, throttle: [] }] }));
    act(() => api.emit({ type: 'run.phase', runId: 'plain', phase: 'warm-load', progress: 0.2 }));
    act(() => api.emit({ type: 'run.done', runId: 'another', summary: summaries()[0]! }));
    // The next poll says the same run moved on: the events already know better.
    api.world.active = activeRun('plain', { phase: 'prepare', progress: 0.1 });
    await new Promise((r) => setTimeout(r, 2300));
    expect(router.state.location.pathname).toBe('/run/plain');
    expect(screen.getByText(/Ricarico il modello/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Mostra tabella' }));
    expect(screen.getByRole('table', { name: /Scheda video in tempo reale/ }).textContent).toContain('–');
  });
});

describe('results and result: odd data', () => {
  it('a run without VRAM data', async () => {
    const run = { ...seeded(IDS.cancelled), metrics: { ...seeded(IDS.cancelled).metrics, vram: {} } };
    renderApp('/results', benchApi({ runs: [run] }));
    expect(await screen.findByText('1 risultato')).toBeTruthy();
    const row = screen.getByRole('link', { name: /Qwen3 14B/ }).closest('tr')!;
    expect(within(row).getAllByText('–').length).toBeGreaterThan(1);
  });

  it('external, Docker without digest, variable stability, sparse telemetry', async () => {
    const base = seeded(IDS.gemma);
    const ext: RunResult = {
      ...base,
      id: 'ext',
      engine: { kind: 'external', name: 'OpenAI-compatible server', variant: 'openai' },
      model: { ...base.model, displayName: 'demo', source: 'external', format: 'remote' },
      launch: { ...base.launch, argv: [], cwd: undefined },
      hardware: { ...base.hardware, gpus: [], os: { ...base.hardware.os, powerPlan: undefined } },
      metrics: { ...base.metrics, latency: base.metrics.latency.map((p) => ({ ...p, decodeTps: { ...p.decodeTps, cv: 0.03 } })) },
      telemetry: { intervalMs: 250, t: [0, 250, 500, 750, 1000], utilPct: [null, 50, 60, 70, 80], memUsedMiB: [null, 1, 2, 3, 4], powerW: [null, 100, 200, 300, 400], tempC: [null, 50, 50, 50, 50], smClockMHz: [null, 1, 1, 1, 1], marks: [{ t: 500, label: 'decode' }] },
    };
    const docker: RunResult = {
      ...base,
      id: 'dock',
      engine: { kind: 'llamacpp-docker', name: 'llama.cpp', version: 'server-cuda', image: 'ghcr.io/ggml-org/llama.cpp:server-cuda' },
      metrics: { ...base.metrics, latency: base.metrics.latency.map((p) => ({ ...p, decodeTps: { ...p.decodeTps, cv: 0.09 } })) },
    };
    const api = benchApi({ runs: [ext, docker] });
    const { router } = renderApp('/results/ext', api);
    expect(await h1(/^demo/)).toBeTruthy();
    expect(screen.getByText('Buona')).toBeTruthy();
    await waitFor(() => expect(charts.options.length).toBeGreaterThanOrEqual(3));
    for (const o of charts.options) exerciseFormatters(o);
    for (const b of screen.getAllByRole('button', { name: 'Mostra tabella' })) await userEvent.click(b);
    expect(screen.getByRole('table', { name: /Scheda video durante il test/ }).textContent).toContain('–');
    await userEvent.click(screen.getByRole('tab', { name: 'Dettagli' }));
    expect(screen.getByRole('table', { name: 'Sistema' }).textContent).toContain('Piano energetico–');
    await userEvent.click(screen.getByRole('tab', { name: 'Come è stato avviato' }));
    await userEvent.click(screen.getByRole('button', { name: 'Mostra comando' }));
    expect(screen.getByText('Il server era già acceso: GPU Bench non ha avviato nessun comando.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Avvia solo il server così' })).toBeNull();

    act(() => void router.navigate({ to: '/results/$runId', params: { runId: 'dock' } }));
    expect(await screen.findByText('Variabile')).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: 'Come è stato avviato' }));
    expect(screen.getByText('ghcr.io/ggml-org/llama.cpp:server-cuda')).toBeTruthy();
  });

  it('the server dialog can be left running', async () => {
    const full = seeded(IDS.full);
    const api = benchApi({ runs: [full], local: [localModel('q', { weakKey: full.model.weakKey })] });
    api.world.routes['POST /api/servers'] = () => ({ id: 's', baseUrl: 'http://h:1', openaiUrl: 'http://h:1/v1', modelName: 'Q', engineLabel: 'e', startedAt: new Date().toISOString(), command: { argv: [], powershell: '', bash: '' } });
    renderApp(`/results/${IDS.full}`, api);
    await h1(/Qwen3 8B/);
    await userEvent.click(screen.getByRole('tab', { name: 'Come è stato avviato' }));
    await userEvent.click(screen.getByRole('button', { name: 'Avvia solo il server così' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Avvia server' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Lascia acceso' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('compare a full run with a quick one: missing numbers have no difference', async () => {
    const { router } = renderApp(`/compare?a=${IDS.full}&b=${IDS.quick}`, benchApi());
    const table = await screen.findByRole('table', { name: 'Confronta' });
    const cold = within(table).getByRole('row', { name: /Caricamento a freddo/ });
    expect(within(cold).getAllByText('–')).toHaveLength(2);
    act(() => void router.navigate({ to: '/compare', search: { a: IDS.quick, b: IDS.full } }));
    await waitFor(() => expect(within(screen.getByRole('table', { name: 'Confronta' })).getAllByRole('row', { name: /Caricamento a freddo/ })).toHaveLength(1));
    await choose('Risultato A', /Gemma/);
    await waitFor(() => expect(within(screen.getByRole('table', { name: 'Confronta' })).getByRole('row', { name: /Caricamento a freddo/ }).textContent).toContain('%'));
  });
});
