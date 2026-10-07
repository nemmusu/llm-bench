/**
 * A run that spilled to shared system memory (Windows), with the real numbers of an RTX 5090 and a
 * 27B model: 4 666 MiB of shared memory, 3.5 tok/s against the usual 53.7. Said first on the result
 * page (with the ways out), at once on the live screen, marked in the lists, never "Provato" with its
 * speed; and before the start, what will really happen when it does not fit.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StartRunRequest } from '../../../../src/contract/api';
import type { RunResult, Spill } from '../../../../src/contract/results';
import { spillText } from '../../../../src/renderer/components/bench/spill';
import { createFormatters } from '../../../../src/renderer/i18n';
import { renderApp } from '../helpers';
import { IDS, seeded, seededRuns } from './fixtures';
import { activeRun, benchApi, deferred, FIT, localModel, planFor } from './world';

vi.mock('echarts/core', () => ({ use: vi.fn(), init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })) }));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({ AxisPointerComponent: {}, DataZoomComponent: {}, GridComponent: {}, LegendComponent: {}, MarkAreaComponent: {}, MarkLineComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

beforeAll(() => {
  Object.assign(Element.prototype, { hasPointerCapture: () => false, releasePointerCapture: () => undefined, scrollIntoView: () => undefined });
});
afterEach(() => vi.useRealTimers());

const h1 = (name: string | RegExp) => screen.findByRole('heading', { level: 1, name });
const posted = (api: ReturnType<typeof benchApi>, path: string) => api.calls.filter((c) => c.method === 'POST' && c.path === path);

const REAL_SPILL: Spill = {
  by: ['shared-memory', 'decode-collapse'],
  sharedPeakMiB: 4666,
  thresholdMiB: 1024,
  decodeTps: 3.5,
  normalDecodeTps: 53.7,
  normalRunIds: [IDS.quick],
  fixes: { kvCacheType: 'q4_0', maxContext: 200_704 },
};

/** The seeded Qwen3 8B run, as if it had spilled (its model is in the library: its presets work). */
function spilled(spill: Spill | null = REAL_SPILL): RunResult {
  const run = seeded(IDS.full);
  run.validity = ['shared_memory_spill', 'unstable'];
  run.metrics.vram.sharedPeakMiB = 4666;
  if (spill) run.metrics.spill = spill;
  else delete run.metrics.spill;
  return run;
}

function withLibrary(runs: RunResult[]) {
  const full = seeded(IDS.full);
  return benchApi({ runs, local: [localModel('qwen3-8b', { weakKey: full.model.weakKey })] });
}

describe('the result page of a run that spilled', () => {
  it('says it first, with the numbers; the VRAM tile adds the shared memory; the stability is never "Ottima"', async () => {
    renderApp(`/results/${IDS.full}`, withLibrary([spilled()]));
    await h1(/Qwen3 8B/);
    const warning = screen.getByRole('alert', { name: 'Il modello non è entrato tutto nella memoria della scheda' });
    expect(warning.textContent).toContain('Windows ha usato 4,6 GB di RAM condivisa, per questo va circa 15 volte più lento del normale (3,5 tok/s invece di 53,7).');
    expect(warning.textContent).toContain('Questi numeri non sono quelli veri della scheda.');
    // Not once more among the other warnings.
    expect(screen.getAllByText('Il modello non è entrato tutto nella memoria della scheda')).toHaveLength(1);
    expect(screen.getByText('Misure poco stabili')).toBeTruthy();
    expect(screen.getByText(/\+ 4,6 GB nella RAM condivisa/)).toBeTruthy();
    expect(screen.getByText('Falsata dalla RAM condivisa')).toBeTruthy();
    expect(screen.queryByText('Ottima')).toBeNull();
  });

  it('"Riprova con cache q4_0" and "Riprova con meno contesto" start the same test with what fits', async () => {
    const api = withLibrary([spilled()]);
    const { router } = renderApp(`/results/${IDS.full}`, api);
    await h1(/Qwen3 8B/);
    await userEvent.click(screen.getByRole('button', { name: 'Riprova con cache q4_0' }));
    expect(await h1('Test in corso')).toBeTruthy();
    expect((posted(api, '/api/runs')[0]!.body as StartRunRequest).params).toMatchObject({ kvCacheType: 'q4_0', flashAttention: 'on' });
    act(() => void router.navigate({ to: '/results/$runId', params: { runId: IDS.full } }));
    await userEvent.click(await screen.findByRole('button', { name: 'Riprova con meno contesto (196K)' }));
    await waitFor(() => expect(posted(api, '/api/runs')).toHaveLength(2));
    expect((posted(api, '/api/runs')[1]!.body as StartRunRequest).params).toMatchObject({ contextSize: 200_704 });
  });

  it('"Trova le impostazioni migliori": the Benchmark page with the search and this model', async () => {
    const api = withLibrary([spilled()]);
    const { router } = renderApp(`/results/${IDS.full}`, api);
    await h1(/Qwen3 8B/);
    await userEvent.click(screen.getByRole('button', { name: 'Trova le impostazioni migliori' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(await screen.findByRole('radio', { name: /Trova le impostazioni migliori/, checked: true })).toBeTruthy();
    // No banner: the spilled numbers are not a preset.
    expect(screen.queryByRole('region', { name: 'Preset' })).toBeNull();
  });

  it('before the library is known the search does nothing (it needs the model)', async () => {
    const api = withLibrary([spilled()]);
    const gate = deferred<unknown>();
    api.world.routes['GET /api/models/local'] = () => gate.promise;
    const { router } = renderApp(`/results/${IDS.full}`, api);
    await h1(/Qwen3 8B/);
    await userEvent.click(screen.getByRole('button', { name: 'Trova le impostazioni migliori' }));
    expect(router.state.location.pathname).toBe(`/results/${IDS.full}`);
    await act(async () => gate.resolve([]));
  });

  it('without fixes only the search is offered; a spill seen only from the flag reads like any warning', async () => {
    const noFix = spilled({ ...REAL_SPILL, fixes: undefined } as Spill);
    delete noFix.metrics.spill!.fixes;
    renderApp(`/results/${IDS.full}`, withLibrary([noFix]));
    await h1(/Qwen3 8B/);
    expect(screen.queryByRole('button', { name: 'Riprova con cache q4_0' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Riprova con meno contesto/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Trova le impostazioni migliori' })).toBeTruthy();
  });

  it('a flag without its details (another app version): the plain warning', async () => {
    const api = withLibrary([spilled(null)]);
    renderApp(`/results/${IDS.full}`, api);
    await h1(/Qwen3 8B/);
    expect(screen.queryByRole('alert', { name: /non è entrato/ })).toBeNull();
    expect(screen.getByText(/Windows ha messo una parte del modello nella RAM condivisa del PC/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Trova le impostazioni migliori' }));
    expect(await h1('Test in corso')).toBeTruthy();
  });

  it('the words of each way it was seen', () => {
    const f = createFormatters('it');
    expect(spillText({ by: ['shared-memory'], sharedPeakMiB: 4666 }, f)).toBe('Windows ha usato 4,6 GB di RAM condivisa: in questi casi tutto va circa 10–15 volte più lento del normale.');
    // Barely slower than usual: no "1 volta più lento".
    expect(spillText({ by: ['shared-memory'], sharedPeakMiB: 4666, decodeTps: 50, normalDecodeTps: 53.7 }, f)).toContain('in questi casi');
    expect(spillText({ by: ['decode-collapse'], decodeTps: 3.5, normalDecodeTps: 53.7 }, f)).toBe(
      'Genera 3,5 tok/s invece dei soliti 53,7, circa 15 volte più lento: Windows ha messo una parte del modello nella RAM condivisa.',
    );
    expect(spillText({ by: ['decode-collapse'], decodeTps: 3.5, normalDecodeTps: 53.7 }, createFormatters('en'))).toContain('about 15 times slower');
  });
});

describe('the live screen', () => {
  it('shows the spill the moment it is seen, with "Annulla test"; the time left comes from the core', async () => {
    const api = benchApi();
    renderApp('/', api);
    await screen.findAllByText(/≈ 1 min 35 s/);
    await userEvent.click(screen.getByRole('button', { name: 'Avvia benchmark' }));
    expect(await h1('Test in corso')).toBeTruthy();
    // The id the fake core gives every run it starts.
    const id = api.world.active!.runId;
    expect(screen.queryByRole('alert', { name: /RAM condivisa/ })).toBeNull();
    act(() => api.emit({ type: 'run.spill', runId: id, spill: { by: ['shared-memory'], sharedPeakMiB: 4666, thresholdMiB: 1024 } }));
    const banner = screen.getByRole('alert', { name: 'Sta usando la RAM condivisa: i numeri saranno molto più bassi' });
    expect(banner.textContent).toContain('Windows ne ha messo 4,6 GB nella RAM del PC');
    await userEvent.click(within(banner).getByRole('button', { name: 'Annulla test' }));
    expect(await screen.findByRole('alertdialog', { name: 'Vuoi annullare il test?' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Continua il test' }));
    // Another run's events change nothing; the core's time left wins over the estimate.
    act(() => api.emit({ type: 'run.spill', runId: 'other', spill: { by: ['decode-collapse'], decodeTps: 1, normalDecodeTps: 50 } }));
    act(() => api.emit({ type: 'run.phase', runId: id, phase: 'decode', progress: 0.5, remainingSeconds: 1200 }));
    expect(await screen.findByText(/Mancano circa (19 min 59 s|20 min 00 s)/)).toBeTruthy();
  });

  it('a reopened screen: the spill and the time left the core knows', async () => {
    const run = '01M48PNN41KKD0ABVXTGK97Y6Q';
    const api = benchApi({ active: activeRun(run, { phase: 'decode', progress: 0.4, remainingSeconds: 90, spill: { by: ['decode-collapse'], decodeTps: 3.5, normalDecodeTps: 53.7 } }) });
    renderApp(`/run/${run}`, api);
    const banner = await screen.findByRole('alert', { name: /Sta usando la RAM condivisa/ });
    expect(banner.textContent).toContain('Genera 3,5 tok/s invece dei soliti 53,7');
    expect(await screen.findByText(/Mancano circa 1 min 3\d s/)).toBeTruthy();
  });
});

describe('lists and badges', () => {
  it('Risultati: the run is marked "RAM condivisa"; Configurazioni keeps its numbers apart, marked', async () => {
    const api = withLibrary([...seededRuns().filter((r) => r.id !== IDS.full), spilled()]);
    renderApp('/results', api);
    expect(await screen.findByText('RAM condivisa')).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: 'Configurazioni' }));
    expect(await screen.findByText('RAM condivisa')).toBeTruthy();
  });

  it('Ultimi risultati marks it; "Provato su questa GPU" never shows its speed, only that it spilled', async () => {
    const only = spilled();
    const api = withLibrary([only]);
    renderApp('/', api);
    const recent = await screen.findByRole('heading', { name: 'Ultimi risultati' });
    const card = recent.closest('div')!.parentElement!;
    expect(await within(card).findByText('RAM condivisa')).toBeTruthy();
    // The selected model (its only run spilled).
    expect(await screen.findByText('Provato: usava la RAM condivisa')).toBeTruthy();
    expect(screen.queryByText(/Provato su questa GPU ·/)).toBeNull();
  });

  it('with a clean run too, "Provato" quotes the clean one', async () => {
    const clean = seeded(IDS.full);
    const dirty = { ...spilled(), id: '01K70SPILL0000000000000000', createdAt: '2026-10-07T10:00:00.000Z' };
    renderApp('/', withLibrary([clean, dirty]));
    expect(await screen.findByText(/^Provato su questa GPU · /)).toBeTruthy();
    expect(screen.queryByText('Provato: usava la RAM condivisa')).toBeNull();
    // The model picker too.
    await userEvent.click(screen.getByRole('button', { name: /^Cambia modello:/ }));
    const picker = await screen.findByRole('dialog', { name: 'Scegli un modello' });
    expect(within(picker).getByText(/^Provato · /)).toBeTruthy();
  });

  it('the model picker says when its only runs spilled', async () => {
    renderApp('/', withLibrary([spilled()]));
    await userEvent.click(await screen.findByRole('button', { name: /^Cambia modello:/ }));
    const picker = await screen.findByRole('dialog', { name: 'Scegli un modello' });
    expect(within(picker).getByText('Provato: RAM condivisa')).toBeTruthy();
  });
});

describe('before the start', () => {
  const spillPlan = (params: Record<string, unknown>) =>
    planFor({
      fit: { ...FIT, level: 'partial', needMiB: 34_100, availableMiB: 31_000, maxGpuLayers: 57, fixes: { kvCacheType: 'q4_0', maxContext: 131_072 } },
      warnings: [{ code: 'spill_risk', params: { needMiB: 34_100, availableMiB: 31_000, ...params } }],
    });

  it('every layer on the GPU and not enough VRAM: what Windows will do, and the settings that fit, one click away', async () => {
    const api = benchApi();
    api.world.plan = () => spillPlan({ kvCacheType: 'q4_0', maxContext: 131_072 });
    renderApp('/', api);
    const title = await screen.findByText('Il modello non entra tutto nella scheda video');
    const callout = title.closest('[role="note"]') as HTMLElement;
    expect(callout.textContent).toContain('Servono circa 33,3 GB, ne hai 30,3 GB liberi. Windows metterà il resto nella RAM condivisa: tutto sarà molto più lento (circa 10–15 volte)');
    expect(within(callout).getByRole('button', { name: 'Contesto massimo che entra: 128K' })).toBeTruthy();
    await userEvent.click(within(callout).getByRole('button', { name: 'Usa cache q4_0' }));
    expect(await screen.findByText('Impostazioni aggiornate nei parametri avanzati.')).toBeTruthy();
    // Expert mode on: the next plan carries the cache.
    await waitFor(() => expect(posted(api, '/api/runs/plan').some((c) => (c.body as StartRunRequest).params?.kvCacheType === 'q4_0')).toBe(true));
    expect(posted(api, '/api/runs/plan').at(-1)!.body).toMatchObject({ params: { kvCacheType: 'q4_0', flashAttention: 'on' } });
    await userEvent.click(screen.getAllByRole('button', { name: 'Contesto massimo che entra: 128K' })[0]!);
    await waitFor(() => expect(posted(api, '/api/runs/plan').at(-1)!.body).toMatchObject({ params: { contextSize: 131_072, kvCacheType: 'q4_0' } }));
  });

  it('Linux runs out of memory instead; a warning without fixes has no buttons', async () => {
    const api = benchApi();
    api.world.plan = () =>
      planFor({ fit: { ...FIT, level: 'partial', needMiB: 34_100, availableMiB: 31_000 }, warnings: [{ code: 'oom_risk', params: { needMiB: 34_100, availableMiB: 31_000 } }] });
    renderApp('/', api);
    const title = await screen.findByText('Il modello non entra nella scheda video');
    const callout = title.closest('[role="note"]') as HTMLElement;
    expect(callout.textContent).toContain('il motore si fermerà per memoria esaurita');
    expect(within(callout).queryByRole('button')).toBeNull();
  });

  it('"Trova le impostazioni migliori": each budget says how long it takes for this model', async () => {
    const api = benchApi();
    api.world.plan = (body) => planFor({ ...((body as StartRunRequest).profile === 'tune' ? { tuneSeconds: { fast: 2062, thorough: 5400 }, estimatedSeconds: 2062 } : {}) });
    renderApp('/', api);
    await userEvent.click(await screen.findByRole('radio', { name: /Trova le impostazioni migliori/ }));
    expect(await screen.findByText('circa 34 min per questo modello')).toBeTruthy();
    expect(screen.getByText('circa 1 h 30 min per questo modello')).toBeTruthy();
  });
});
