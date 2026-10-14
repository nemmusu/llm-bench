/**
 * Confronta as a person uses it: pick from Risultati, Configurazioni or the start screen, compare two
 * to four items at the same measured context, change "Confronta a", open "Cosa cambia tra loro", use a
 * preset, swap a configuration, remove one, share; the old two-run links keep working.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RunResult } from '../../../../src/contract/results';
import { summarize } from '../../../../src/core/bench/stats';
import { setCompareSelection } from '../../../../src/renderer/lib/compare-selection';
import { validateCompareSearch } from '../../../../src/renderer/routes/compare';
import { renderApp } from '../helpers';
import { tunedRun } from '../tune/tune-fixtures';
import { exerciseFormatters } from './charts';
import { IDS, seeded, seededRuns } from './fixtures';
import { apiError, benchApi, deferred, localModel } from './world';

const charts = vi.hoisted(() => ({ options: [] as Record<string, unknown>[] }));
vi.mock('echarts/core', () => ({
  use: vi.fn(),
  init: vi.fn(() => ({ setOption: vi.fn((o: Record<string, unknown>) => charts.options.push(o)), resize: vi.fn(), dispose: vi.fn() })),
}));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({ AxisPointerComponent: {}, DataZoomComponent: {}, GridComponent: {}, LegendComponent: {}, MarkAreaComponent: {}, MarkLineComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

beforeAll(() => {
  Object.assign(Element.prototype, { hasPointerCapture: () => false, releasePointerCapture: () => undefined, scrollIntoView: () => undefined });
});

afterEach(() => {
  charts.options.length = 0;
});

async function choose(combobox: string | RegExp, option: string | RegExp) {
  const trigger = await screen.findByRole('combobox', { name: combobox });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
  fireEvent.click(await screen.findByRole('option', { name: option }));
}

const TABLE = 'Confronto misura per misura';
const table = () => screen.findByRole('table', { name: TABLE });
const row = (name: RegExp) => within(screen.getByRole('table', { name: TABLE })).getByRole('row', { name });

/** Qwen3 8B measured a second way (cache q8_0, 32K of context): two configurations of one model on this card. */
function q8(): RunResult {
  const run = structuredClone(seeded(IDS.full));
  Object.assign(run, { id: '01K6ZB2B3C4D5E6F7G8H9J0KMN', createdAt: '2026-10-07T08:10:00.000Z', finishedAt: '2026-10-07T08:10:00.000Z' });
  const head = run.launch.argv.slice(0, run.launch.argv.indexOf('-c'));
  run.launch.argv = [...head, '-c', '32768', '-ngl', 'all', '-fa', 'on', '-ctk', 'q8_0', '-ctv', 'q8_0', '--fit', 'off', '--no-webui'];
  run.launch.params = { contextSize: 32768, flashAttention: 'on', kvCacheType: 'q8_0', extraArgs: [], env: {} };
  run.metrics.latency = run.metrics.latency.map((p) => ({ ...p, decodeTps: { ...p.decodeTps, median: p.decodeTps.median * 1.06 } }));
  return run;
}

function world(extra: RunResult[] = []) {
  return benchApi({
    runs: [...seededRuns(), q8(), ...extra],
    local: [localModel('qwen3-8b', { weakKey: seeded(IDS.full).model.weakKey }), localModel('st', { format: 'safetensors', repo: 'Qwen/Qwen3-8B-FP8', file: undefined })],
  });
}

describe('the comparison', () => {
  it('three tests side by side: who is faster at the same context, "Confronta a", the charts, what changes, a preset', async () => {
    const { router } = renderApp(`/compare?ids=${IDS.moe},${IDS.gemma},${IDS.full}`, world());
    await table();
    expect(screen.getByRole('heading', { level: 1, name: 'Confronta' })).toBeTruthy();
    expect(screen.getByText('3 a confronto: chi va più veloce, sempre alla stessa lunghezza di contesto.')).toBeTruthy();
    // The cards: the letter, the model, the engine, the configuration in words, the date.
    for (const name of ['A · Qwen3 30B A3B · Q4_K_M', 'B · Gemma 4 31B · Q4_K_M', 'C · Qwen3 8B · Q4_K_M']) expect(screen.getByRole('columnheader', { name })).toBeTruthy();
    const c = screen.getByRole('columnheader', { name: 'C · Qwen3 8B · Q4_K_M' });
    expect(within(c).getByText('llama.cpp b11438 (CUDA 13.4)')).toBeTruthy();
    expect(within(c).getByText(/Q4_K_M · Contesto 8\.192 · cache KV f16 · flash attention/)).toBeTruthy();
    expect(within(c).getByText(/6 ott 2026, 12:42 · Completo · RTX 5090/)).toBeTruthy();
    // "In breve", in words, at the context they all measured.
    expect(screen.getByText('Scrive più in fretta A · Qwen3 30B A3B · Q4_K_M: 214,1 tok/s (scrittura con 512 token già nel contesto), +17% rispetto a C · Qwen3 8B · Q4_K_M (183,5 tok/s).')).toBeTruthy();
    const decode = row(/^Generazione \(tok\/s\)/);
    expect(decode.textContent).toContain('scrittura con 512 token già nel contesto');
    expect(within(decode).getByText('il più veloce')).toBeTruthy();
    expect(within(decode).getByText('3,7 volte più lento')).toBeTruthy();
    expect(row(/^Lettura prompt/).textContent).toContain('lettura di un prompt da 512 token');
    expect(row(/^Scrittura per utente/).textContent).toContain('con 4 utenti insieme, prompt da 512 token ciascuno');
    // The same number for everyone: nothing to point out.
    expect(within(row(/^Contesto massimo/)).getAllByText('uguale')).toHaveLength(3);

    // "Confronta a": only the lengths at least two of them measured.
    await choose('Confronta a', /^4K/);
    await waitFor(() => expect(router.state.location.search).toEqual({ ids: `${IDS.moe},${IDS.gemma},${IDS.full}`, at: 4096 }));
    await waitFor(() => expect(row(/^Generazione \(tok\/s\)/).textContent).toContain('scrittura con 4.096 token già nel contesto'));
    const at = screen.getByRole('combobox', { name: 'Confronta a' });
    at.focus();
    fireEvent.keyDown(at, { key: 'Enter' });
    expect(within(await screen.findByRole('option', { name: /^512 token/ })).getByText('misurato da tutti')).toBeTruthy();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });

    // Writing and reading side by side, one line per item, each value with its exact tokens; the total as a toggle; the numbers as tables.
    await waitFor(() => expect(charts.options.length).toBeGreaterThanOrEqual(3));
    for (const o of charts.options) expect(exerciseFormatters(o).join(' ')).toMatch(/tok\/s|token|utenti/);
    const speed = charts.options.find((o) => JSON.stringify(o).includes('Token già nel contesto'))!;
    expect(exerciseFormatters(speed).join(' ')).toContain('a 128 token di contesto');
    expect(exerciseFormatters(speed).join(' ')).toMatch(/tok\/s · 128 token/);
    await userEvent.click(screen.getByRole('radio', { name: 'In tutto' }));
    for (const b of screen.getAllByRole('button', { name: 'Mostra tabella' })) await userEvent.click(b);
    expect(screen.getByRole('table', { name: /Scrittura al crescere del contesto/ }).textContent).toContain('C · Qwen3 8B · Scrittura (tok/s)');
    expect(screen.getByRole('table', { name: /Lettura al crescere del contesto/ }).textContent).toContain('C · Qwen3 8B · Lettura (tok/s)');
    expect(screen.getByRole('table', { name: /Più utenti insieme/ }).textContent).toContain('In tutto (tok/s)');

    // "Cosa cambia tra loro": closed at first, only the differences until asked.
    const diffButton = screen.getByRole('button', { name: /Cosa cambia tra loro/ });
    expect(diffButton.textContent).toContain('impostazioni diverse');
    await userEvent.click(diffButton);
    const diff = screen.getByRole('table', { name: 'Cosa cambia tra loro' });
    expect(within(diff).getAllByText('(diverso)').length).toBeGreaterThan(0);
    expect(within(diff).queryByText('Driver')).toBeNull();
    await userEvent.click(screen.getByRole('switch', { name: 'Solo le differenze' }));
    expect(within(diff).getByText('Driver')).toBeTruthy();

    // A preset from a card: the Benchmark page with those settings.
    await userEvent.click(within(c).getByRole('button', { name: 'Usa questo preset' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });

  it('another configuration of the same model, one item removed, another added', async () => {
    const api = world();
    const { router } = renderApp(`/compare?ids=${IDS.gemma},${IDS.full}`, api);
    await table();
    // Qwen3 8B has two configurations on this card: the column can switch to the other one.
    await choose('Configurazione di Qwen3 8B', /cache KV q8_0/);
    await waitFor(() => expect(router.state.location.search).toEqual({ ids: `${IDS.gemma},01K6ZB2B3C4D5E6F7G8H9J0KMN` }));
    await waitFor(() => expect(screen.getByRole('columnheader', { name: 'B · Qwen3 8B · Q4_K_M' }).textContent).toContain('Contesto 32.768 · cache KV q8_0'));
    // "Aggiungi un altro": the list to pick from, with these two already picked.
    await userEvent.click(screen.getByRole('button', { name: 'Aggiungi un altro' }));
    await waitFor(() => expect(router.state.location.search).toEqual({ view: 'runs' }));
    expect(await screen.findByText('Scelti 2 su 4')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /^Confronta Mistral Small/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Confronta (3)' }));
    await waitFor(() => expect(router.state.location.search).toEqual({ ids: `${IDS.quick},${IDS.gemma},01K6ZB2B3C4D5E6F7G8H9J0KMN` }));
    // Removing one keeps the rest; below two, back to picking.
    await table();
    await userEvent.click(screen.getByRole('button', { name: 'Togli A · Mistral Small 3.2 24B · Q4_K_M dal confronto' }));
    await waitFor(() => expect(router.state.location.search).toEqual({ ids: `${IDS.gemma},01K6ZB2B3C4D5E6F7G8H9J0KMN` }));
    await table();
    await userEvent.click(screen.getByRole('button', { name: /^Togli A · Gemma 4 31B/ }));
    await waitFor(() => expect(router.state.location.search).toEqual({ view: 'runs' }));
    expect(await screen.findByText('Scelto 1 su 4: scegline almeno un altro')).toBeTruthy();
  });

  it('a fork never looks like its engine; a spill and a tune combination say what they are; nothing in common', async () => {
    const fork = structuredClone(seeded(IDS.quick));
    Object.assign(fork, { id: 'FORK1', createdAt: '2026-10-08T10:00:00.000Z' });
    fork.engine = { ...fork.engine, name: 'PrismML fork', customEngine: { id: 'prism', name: 'PrismML fork', base: 'llamacpp' } };
    fork.validity = ['shared_memory_spill'];
    const tuned = tunedRun();
    renderApp(`/compare?ids=FORK1,${tuned.id}~3`, world([fork, tuned]));
    await table();
    const a = screen.getByRole('columnheader', { name: /^A · Mistral/ });
    expect(within(a).getByText('PrismML fork (llama.cpp) b11438 (CUDA 13.4)')).toBeTruthy();
    expect(within(a).getByText('Motore personalizzato')).toBeTruthy();
    expect(within(a).getByText('RAM condivisa')).toBeTruthy();
    expect(within(screen.getByRole('columnheader', { name: /^B · Qwen3 8B/ })).getByText(/combinazione 4/)).toBeTruthy();
    // 512 tokens against a sweep from 1K: no length in common, so no speed is compared.
    expect(screen.getByText('nessuna lunghezza in comune')).toBeTruthy();
    expect(screen.getByText(/Questi elementi non hanno misurato la velocità alla stessa lunghezza di contesto/)).toBeTruthy();
    expect(screen.queryByRole('row', { name: /^Generazione/ })).toBeNull();
  });

  it('older two-run links still open the comparison; a missing test can be taken out; loading', async () => {
    const api = world();
    const { router, container } = renderApp(`/compare?a=${IDS.moe}&b=${IDS.full}`, api);
    await table();
    expect(screen.getByRole('columnheader', { name: 'A · Qwen3 30B A3B · Q4_K_M' })).toBeTruthy();
    // The picks follow what is compared.
    await userEvent.click(screen.getByRole('link', { name: 'Risultati' }));
    expect(await screen.findByRole('region', { name: 'Da confrontare' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Confronta Qwen3 30B A3B/ }).getAttribute('aria-pressed')).toBe('true');
    // A test that is not there any more.
    act(() => void router.navigate({ to: '/compare', search: { ids: `${IDS.moe},nope,${IDS.full}` } }));
    expect(await screen.findByRole('heading', { name: 'Risultato non trovato' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Toglilo dal confronto' }));
    await waitFor(() => expect(router.state.location.search).toEqual({ ids: `${IDS.moe},${IDS.full}` }));
    await table();
    const slow = deferred<unknown>();
    api.world.routes[`GET /api/runs/${IDS.gemma}`] = () => slow.promise;
    act(() => void router.navigate({ to: '/compare', search: { ids: `${IDS.gemma},${IDS.full}` } }));
    await waitFor(() => expect(container.querySelectorAll('.skeleton-shimmer').length).toBeGreaterThan(0));
    await act(async () => slow.reject(apiError('NETWORK')));
    expect(await screen.findByRole('heading', { name: 'Connessione a internet non disponibile' })).toBeTruthy();
  });

  it('validates the address', () => {
    expect(validateCompareSearch({})).toEqual({});
    expect(validateCompareSearch({ ids: 'A,B~2,A,x y,C,D,E', at: '4096', view: 'models' })).toEqual({ ids: 'A,B~2,C,D', at: 4096, view: 'models' });
    expect(validateCompareSearch({ a: 'x', b: '' })).toEqual({ ids: 'x' });
    expect(validateCompareSearch({ a: 3, b: 'y', at: -1, view: 'other' })).toEqual({ ids: 'y' });
    expect(validateCompareSearch({ ids: 'A', a: 'B', at: 1.5 })).toEqual({ ids: 'A' });
  });
});

describe('unusual comparisons', () => {
  /** A Rapido that measured loads only (no speed at all). */
  function noSpeed(): RunResult {
    const run = structuredClone(seeded(IDS.quick));
    Object.assign(run, { id: 'NOSPEED1', createdAt: '2026-10-08T09:00:00.000Z' });
    run.model = { ...run.model, displayName: 'Phi 4', quant: undefined, weakKey: 'local/phi-4.gguf/x/1', sha256: undefined };
    // Every request of it failed to write: a first token and a reading speed, no generation.
    run.metrics.latency = run.metrics.latency.map((p) => ({ ...p, decodeTps: summarize([]) }));
    return run;
  }

  /** A spilled run of a model not tested otherwise, without a GPU in its record. */
  function spilled(): RunResult {
    const run = structuredClone(seeded(IDS.quick));
    Object.assign(run, { id: 'SPILL1', createdAt: '2026-10-08T10:00:00.000Z' });
    run.model = { ...run.model, displayName: 'Qwen3 27B', weakKey: 'local/qwen3-27b.gguf/Q4_K_M/2', sha256: undefined };
    run.validity = ['shared_memory_spill'];
    return run;
  }

  it('two tied for the best', async () => {
    const twin: RunResult = { ...seeded(IDS.full), id: 'TWIN1', createdAt: '2026-10-07T09:00:00.000Z' };
    renderApp(`/compare?ids=${IDS.full},TWIN1,${IDS.gemma}`, world([twin]));
    await table();
    expect(within(row(/^Generazione \(tok\/s\)/)).getAllByText('pari merito')).toHaveLength(2);
  });

  it('one setting different', async () => {
    const twin: RunResult = { ...seeded(IDS.full), id: 'TWIN1', createdAt: '2026-10-07T09:00:00.000Z' };
    twin.launch = { ...twin.launch, params: { ...twin.launch.params, threads: 8 } };
    renderApp(`/compare?ids=${IDS.full},TWIN1`, world([twin]));
    await table();
    expect(screen.getByRole('button', { name: /Cosa cambia tra loro/ }).textContent).toContain('1 impostazione diversa');
  });

  it('users at once whose prompt is not known', async () => {
    const strip = (r: RunResult): RunResult => ({ ...r, scenario: { ...r.scenario, steps: r.scenario.steps.filter((s) => s.kind !== 'concurrency') } });
    const api = world();
    api.world.runs = api.world.runs.map((r) => (r.id === IDS.moe || r.id === IDS.gemma ? strip(r) : r));
    renderApp(`/compare?ids=${IDS.moe},${IDS.gemma}`, api);
    await table();
    expect(row(/^Scrittura per utente/).textContent).toContain('con 4 utenti insieme');
    expect(row(/^Scrittura per utente/).textContent).not.toContain('prompt da');
  });

  it('a card without a card: a test saved with no GPU in it', async () => {
    const run = spilled();
    run.hardware = { ...run.hardware, gpus: [] };
    renderApp(`/compare?ids=SPILL1,${IDS.full}`, world([run]));
    await table();
    const a = screen.getByRole('columnheader', { name: /^A · Qwen3 27B/ });
    expect(within(a).getByText(/^8 ott 2026, \d\d:\d\d · Rapido$/)).toBeTruthy();
  });

  it('models without a speed or that spilled, a list for every card, picks to remove', async () => {
    const api = world([noSpeed(), spilled()]);
    const real = api.get.bind(api);
    api.world.routes['GET /api/configs'] = async (_b, path) => {
      delete api.world.routes['GET /api/configs'];
      const data = (await real(path)) as Record<string, unknown>;
      return { ...data, gpu: null };
    };
    renderApp('/compare?view=models', api);
    expect(await screen.findByText(/misurata su –/)).toBeTruthy();
    const phi = screen.getByRole('checkbox', { name: /^Phi 4/ }).closest('li')!;
    expect(within(phi).getByText('Velocità non misurata')).toBeTruthy();
    const q27 = screen.getByRole('checkbox', { name: /^Qwen3 27B/ }).closest('li')!;
    expect(within(q27).getByText('RAM condivisa')).toBeTruthy();
    await userEvent.click(screen.getByRole('checkbox', { name: /^Qwen3 27B/ }));
    await userEvent.click(within(screen.getByRole('list', { name: 'Scelti per il confronto' })).getByRole('button', { name: /^Togli Qwen3 27B/ }));
    expect(screen.getByText('Non hai ancora scelto niente da confrontare.')).toBeTruthy();
    // The tests: a spilled one says so; a model without a quantization is found by name.
    await userEvent.click(screen.getByRole('tab', { name: 'Test' }));
    const list = await screen.findByRole('list', { name: 'Test completati' });
    expect(within(within(list).getByRole('link', { name: /^Qwen3 27B/ }).closest('li')!).getByText('RAM condivisa')).toBeTruthy();
    await userEvent.type(screen.getByRole('textbox', { name: 'Cerca' }), 'phi');
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
  });

  it('one test in the address (an older "Confronta con…" link) joins the picks', async () => {
    renderApp(`/compare?a=${IDS.full}`, world());
    expect(await screen.findByText('Scelto 1 su 4: scegline almeno un altro')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Scelti per il confronto' }).textContent).toContain('Qwen3 8B · Q4_K_M');
  });

  it('a combination of a tune run from the address joins too; never more than four', async () => {
    const tuned = tunedRun();
    setCompareSelection([{ runId: IDS.full, label: 'Qwen3 8B' }]);
    renderApp(`/compare?ids=${tuned.id}~3&view=runs`, world([tuned]));
    expect(await screen.findByText('Scelti 2 su 4')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Scelti per il confronto' }).textContent).toContain('Qwen3 8B · Q4_K_M');
  });

  it('a fifth from the address is left out', async () => {
    setCompareSelection(['1', '2', '3', '4'].map((runId) => ({ runId, label: `Test ${runId}` })));
    renderApp(`/compare?a=${IDS.gemma}`, world());
    expect(await screen.findByText('Scelti 4 su 4')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Scelti per il confronto' }).textContent).not.toContain('Gemma');
  });
});

describe('picking what to compare', () => {
  it('"Confronta modelli": two models, each with its fastest configuration or another one', async () => {
    const { router } = renderApp('/compare', world());
    // Nothing picked yet: the models first.
    expect(await screen.findByText(/per ognuno uso la configurazione migliore misurata su RTX 5090/)).toBeTruthy();
    expect(screen.getByText('Non hai ancora scelto niente da confrontare.')).toBeTruthy();
    const qwen = screen.getByRole('checkbox', { name: /^Qwen3 8B · Q4_K_M/ });
    const card = qwen.closest('li')!;
    expect(within(card).getByText('2 configurazioni provate')).toBeTruthy();
    // The best as in Configurazioni: one measured with its context full (8K) before one that never filled its 32K; its speed with that context.
    expect(within(card).getByText('La più veloce al contesto massimo')).toBeTruthy();
    expect(within(card).getByText(/^[\d,]+ tok\/s con il contesto pieno a 8K$/)).toBeTruthy();
    await userEvent.click(qwen);
    await userEvent.click(screen.getByRole('checkbox', { name: /^Gemma 4 31B/ }));
    expect(screen.getByText('Scelti 2 su 4')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Scelti per il confronto' }).textContent).toContain('cache KV f16');
    // The other configuration of Qwen3 8B instead: it says why it has no speed at its largest context.
    const picker = screen.getByRole('combobox', { name: 'Configurazione di Qwen3 8B' });
    picker.focus();
    fireEvent.keyDown(picker, { key: 'Enter' });
    const other = await screen.findByRole('option', { name: /cache KV q8_0/ });
    expect(within(other).getByText('non misurata a 32K: misurata solo fino a 8K')).toBeTruthy();
    fireEvent.click(other);
    await waitFor(() => expect(screen.getByRole('list', { name: 'Scelti per il confronto' }).textContent).toContain('cache KV q8_0'));
    // Taking a model away, and a fifth refused.
    await userEvent.click(screen.getByRole('checkbox', { name: /^Gemma 4 31B/ }));
    expect(screen.getByText('Scelto 1 su 4: scegline almeno un altro')).toBeTruthy();
    for (const name of [/^Gemma 4 31B/, /^gpt-oss 20B/, /^Mistral Small/, /^Qwen3 30B A3B/]) await userEvent.click(screen.getByRole('checkbox', { name }));
    expect(await screen.findByText('Puoi confrontare al massimo 4 elementi insieme: togline uno dal confronto.')).toBeTruthy();
    await userEvent.click(screen.getByRole('checkbox', { name: /^Mistral Small/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Confronta (3)' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/compare'));
    expect(String((router.state.location.search as { ids?: string }).ids).split(',')).toHaveLength(3);
    expect(await table()).toBeTruthy();
  });

  it('"Test": every completed test with a search; empty and failing lists', async () => {
    const api = world();
    renderApp('/compare?view=runs', api);
    expect(await screen.findByText(/Premi «Confronta» sui test che vuoi mettere fianco a fianco/)).toBeTruthy();
    const list = screen.getByRole('list', { name: 'Test completati' });
    expect(within(list).queryByText(/Llama 3\.3 70B/)).toBeNull();
    const full = within(list).getAllByRole('link', { name: 'Qwen3 8B · Q4_K_M' })[0]!.closest('li')!;
    expect(within(full).getByText('scrittura con 512 token già nel contesto')).toBeTruthy();
    await userEvent.type(screen.getByRole('textbox', { name: 'Cerca' }), 'gemma');
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    await userEvent.clear(screen.getByRole('textbox', { name: 'Cerca' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Cerca' }), 'nessun modello così');
    expect(screen.getByText('Nessun risultato con questi filtri')).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: 'Modelli' }));
    expect(await screen.findByRole('list', { name: 'Modelli misurati su questa scheda' })).toBeTruthy();
  });

  it('empty and failing start screens', async () => {
    const api = benchApi({ runs: [] });
    renderApp('/compare', api);
    expect(await screen.findByRole('heading', { name: 'Ancora nessun modello misurato su questa scheda' })).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: 'Test' }));
    expect(await screen.findByRole('heading', { name: 'Ancora nessun test completato' })).toBeTruthy();
  });

  it('lists that cannot be read say so and retry', async () => {
    const api = world();
    let fail = true;
    api.world.routes['GET /api/configs'] = (_b, path) => {
      if (fail) throw apiError('INTERNAL', undefined, 500);
      delete api.world.routes['GET /api/configs'];
      return api.get(path);
    };
    api.world.routes['GET /api/runs'] = () => {
      throw apiError('INTERNAL', undefined, 500);
    };
    renderApp('/compare?view=models', api);
    expect(await screen.findByRole('heading', { name: 'Si è verificato un errore imprevisto' })).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Riprova' }));
    expect(await screen.findByText(/per ognuno uso la configurazione migliore/)).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: 'Test' }));
    expect(await screen.findByRole('heading', { name: 'Si è verificato un errore imprevisto' })).toBeTruthy();
    delete api.world.routes['GET /api/runs'];
    await userEvent.click(screen.getByRole('button', { name: 'Riprova' }));
    expect(await screen.findByRole('list', { name: 'Test completati' })).toBeTruthy();
  });

  it('the tray: on every page but Confronta, one at a time, emptied, full at four', async () => {
    const api = world();
    const { router } = renderApp('/results', api);
    await screen.findByText('10 risultati');
    for (const name of [/^Confronta Gemma 4 31B/, /^Confronta Qwen3 30B A3B/, /^Confronta gpt-oss 20B/, /^Confronta Mistral Small/]) await userEvent.click(screen.getAllByRole('button', { name })[0]!);
    const tray = screen.getByRole('region', { name: 'Da confrontare' });
    expect(within(tray).getByText('4 selezionati')).toBeTruthy();
    // On a narrow window the picks scroll sideways: their right edge fades while some are out of sight.
    const picks = within(tray).getByRole('list', { name: 'Scelti per il confronto' });
    expect(picks.dataset.more).toBeUndefined();
    Object.defineProperty(picks, 'scrollWidth', { configurable: true, value: 700 });
    Object.defineProperty(picks, 'clientWidth', { configurable: true, value: 400 });
    act(() => void picks.dispatchEvent(new Event('scroll')));
    expect(picks.dataset.more).toBe('end');
    expect(picks.className).toContain('mask-image');
    await userEvent.click(screen.getAllByRole('button', { name: /^Confronta Qwen3 8B/ })[0]!);
    expect(await screen.findByText('Puoi confrontare al massimo 4 elementi insieme: togline uno dal confronto.')).toBeTruthy();
    await userEvent.click(within(tray).getByRole('button', { name: /^Togli Gemma 4 31B/ }));
    expect(within(tray).getByText('3 selezionati')).toBeTruthy();
    // Still there on another page.
    await userEvent.click(screen.getByRole('link', { name: 'Benchmark' }));
    expect(await screen.findByRole('region', { name: 'Da confrontare' })).toBeTruthy();
    await userEvent.click(within(screen.getByRole('region', { name: 'Da confrontare' })).getByRole('button', { name: 'Svuota' }));
    expect(screen.queryByRole('region', { name: 'Da confrontare' })).toBeNull();
    // Not on the welcome screens.
    setCompareSelection([{ runId: IDS.full, label: 'Qwen3 8B' }]);
    act(() => void router.navigate({ to: '/welcome' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/welcome'));
    expect(screen.queryByRole('region', { name: 'Da confrontare' })).toBeNull();
  });

  it('Configurazioni: "Confronta" on a configuration stands for every test behind it', async () => {
    const again: RunResult = { ...seeded(IDS.full), id: '01K6ZA2B3C4D5E6F7G8H9J0KMN', createdAt: '2026-10-07T09:00:00.000Z' };
    const api = world([again]);
    renderApp('/results?view=configs', api);
    await screen.findByRole('table', { name: 'Configurazioni provate' });
    // The headers say the context every number of the column was measured at: each one's own, full.
    expect(screen.getByRole('columnheader', { name: /Generazione/ }).textContent).toContain('(tok/s) al contesto massimo');
    // The older test of the configuration is picked: the configuration counts as picked.
    setCompareSelection([{ runId: IDS.full, label: 'Qwen3 8B' }]);
    const toggle = await screen.findByRole('button', { name: /^Confronta Qwen3 8B · Q4_K_M · llama\.cpp b11438 \(CUDA 13\.4\) · Contesto 8\.192/ });
    await waitFor(() => expect(toggle.getAttribute('aria-pressed')).toBe('true'));
    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    await userEvent.click(toggle);
    const tray = screen.getByRole('region', { name: 'Da confrontare' });
    expect(within(tray).getByText(/Qwen3 8B · Q4_K_M/)).toBeTruthy();
  });

  it('a tune result: "Confronta" on each combination', async () => {
    const tuned = tunedRun();
    const { router } = renderApp(`/results/${tuned.id}`, world([tuned]));
    const toggles = await screen.findAllByRole('button', { name: /^Confronta Qwen3 8B · Q4_K_M · llama\.cpp b11438 \(CUDA 13\.4\) · combinazione/ });
    await userEvent.click(toggles[1]!);
    await userEvent.click(toggles[2]!);
    await userEvent.click(within(screen.getByRole('region', { name: 'Da confrontare' })).getByRole('button', { name: 'Confronta' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/compare'));
    expect(String((router.state.location.search as { ids?: string }).ids)).toMatch(new RegExp(`^${tuned.id}~\\d,${tuned.id}~\\d$`));
  });
});
