import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelUpdate } from '../../../../src/contract/models';
import { createFormatters } from '../../../../src/renderer/i18n';
import { bridge, job, libApi, localModel, renderLib, run, world } from './fake';

vi.mock('echarts/core', () => ({ use: vi.fn(), init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })) }));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({ AxisPointerComponent: {}, DataZoomComponent: {}, GridComponent: {}, LegendComponent: {}, MarkAreaComponent: {}, MarkLineComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

afterEach(() => {
  delete (window as { gpubench?: unknown }).gpubench;
  vi.restoreAllMocks();
});

const { bytes } = createFormatters('it');
const REPO = 'org/Model-GGUF';
const DIR = 'D:\\Linux\\models\\org\\Model-GGUF';
const PAGE = `/models/hub/${REPO}`;
/** A GGUF of the hub repo on the PC (the Linux library added as a folder). */
const mine = (id: string, over: Parameters<typeof localModel>[1] = {}) =>
  localModel(id, { repoDir: DIR, ...over, identity: { repo: REPO, source: 'hf', displayName: `Model ${id}`, ...over.identity } });
const news = (over: Partial<ModelUpdate> = {}): ModelUpdate => ({
  modelId: 'm1',
  repo: REPO,
  changed: [{ path: 'Model-Q8_0.gguf', label: 'Q8_0', oldBytes: 8.2e9, newBytes: 8e9 }],
  extras: [
    { kind: 'mmproj', path: 'mmproj-F16.gguf', sizeBytes: 9e8 },
    { kind: 'mtp', path: 'mtp-Model.gguf', sizeBytes: 3e8 },
  ],
  checkedAt: '2026-10-12T09:00:00.000Z',
  ...over,
});
const posted = (api: ReturnType<typeof libApi>) => api.calls.filter((c) => c.method === 'POST' && c.path === '/api/downloads').map((c) => c.body);

describe('library: updates and missing parts', () => {
  it('a changed file: "Aggiornamento disponibile", what changed, and "Aggiorna" fetches only it, next to the model', async () => {
    bridge();
    const api = libApi(
      world({
        local: [mine('m1'), localModel('m2')],
        modelUpdates: { checkedAt: '2026-10-12T09:00:00.000Z', checking: false, models: [news()] },
        onPc: { 'Model-Q8_0.gguf': 'update', 'mtp-Model.gguf': 'have' },
      }),
    );
    renderLib('/models', api);
    expect(await screen.findByText('Aggiornamento disponibile')).toBeTruthy();
    expect(screen.getByText(`Il file Q8_0 è cambiato (${bytes(8.2e9)} → ${bytes(8e9)})`)).toBeTruthy();
    expect(screen.getByText(/^Ultimo controllo /)).toBeTruthy();
    const row = (await screen.findByText('Model m1')).closest('li') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Aggiorna' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(`Il modello è già sul PC: scarico solo Model-Q8_0.gguf (${bytes(8e9)}).`)).toBeTruthy();
    expect(within(dialog).getByText(/Il file che hai resta finché quello nuovo non è scaricato e verificato/)).toBeTruthy();
    // The folder already holding the model, not the library's.
    expect(within(dialog).getByText(DIR)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: `Scarica · ${bytes(8e9)}` }));
    await waitFor(() => expect(posted(api)).toEqual([{ repo: REPO, revision: 'main', files: ['Model-Q8_0.gguf'], label: 'Model m1 · aggiornamento', into: 'm1' }]));
  });

  it('"Aggiungi la parte visione" fetches only the mmproj into the model’s folder; an extra already there has nothing to fetch', async () => {
    bridge();
    const api = libApi(world({ local: [mine('m1')], modelUpdates: { checking: false, models: [news({ changed: [] })] }, onPc: { 'mtp-Model.gguf': 'have' } }));
    renderLib('/models', api);
    expect(screen.queryByText('Aggiornamento disponibile')).toBeNull();
    await userEvent.click(await screen.findByRole('button', { name: `Aggiungi la parte visione (mmproj, ${bytes(9e8)}): Model m1` }));
    let dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(`Il modello è già sul PC: scarico solo la parte visione (mmproj) (${bytes(9e8)}).`)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: `Scarica · ${bytes(9e8)}` }));
    await waitFor(() => expect(posted(api)).toEqual([{ repo: REPO, revision: 'main', files: ['mmproj-F16.gguf'], label: 'Model m1 · visione', into: 'm1' }]));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // MTP: the core says the file is already there (another copy finished it): nothing to fetch.
    await userEvent.click(screen.getByRole('button', { name: `Aggiungi MTP (${bytes(3e8)}): Model m1` }));
    dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('È già tutto sul PC: non c’è niente da scaricare.')).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: 'Già sul PC' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('while the download into a model’s folder runs, its progress takes the place of the update', async () => {
    const other = `${DIR}-Other`;
    const api = libApi(
      world({
        local: [mine('m1'), mine('m3', { repoDir: other })],
        modelUpdates: { checking: false, models: [news(), news({ modelId: 'm3' })] },
        downloads: [
          job('up', { repo: REPO, dest: DIR, label: 'Model m1 · aggiornamento', state: 'running', bytesDone: 2e9, bytesTotal: 8e9 }),
          job('eye', { repo: REPO, dest: other, label: 'Model m3 · visione', state: 'verifying', bytesDone: 0, bytesTotal: 0 }),
          job('old', { repo: REPO, dest: DIR, state: 'done' }),
        ],
      }),
    );
    renderLib('/models', api);
    expect(await screen.findByRole('progressbar', { name: 'Model m1 · aggiornamento' })).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: 'Model m3 · visione' })).toBeTruthy();
    expect(screen.queryByText('Aggiornamento disponibile')).toBeNull();
  });

  it('"Controlla aggiornamenti" checks every repo and says what it found', async () => {
    const api = libApi(world({ local: [mine('m1'), mine('m3')] }));
    renderLib('/models', api);
    expect(await screen.findByText('Mai controllato')).toBeTruthy();
    const check = screen.getByRole('button', { name: 'Controlla aggiornamenti' });
    // While the core checks: the button says so and waits.
    let answer: () => void = () => undefined;
    api.on('POST /api/models/updates/check', (b) => new Promise((resolve) => (answer = () => resolve((api.w.checks.push(b), { ...api.w.modelUpdates, checkedAt: '2026-10-13T09:00:00.000Z' })))));
    await userEvent.click(check);
    const busy = await screen.findByRole('button', { name: 'Controllo…' });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    answer();
    expect(await screen.findByText('Nessun aggiornamento: i tuoi modelli sono uguali a quelli su Hugging Face')).toBeTruthy();
    expect(api.w.checks).toEqual([{}]);
    expect(await screen.findByText(/^Ultimo controllo /)).toBeTruthy();
    api.on('POST /api/models/updates/check', () => api.w.modelUpdates);
    api.w.modelUpdates = { checking: false, models: [news()] };
    await userEvent.click(check);
    expect(await screen.findByText('Ho trovato novità per 1 modello')).toBeTruthy();
    api.w.modelUpdates = { checking: false, models: [news(), news({ modelId: 'm3' })] };
    await userEvent.click(check);
    expect(await screen.findByText('Ho trovato novità per 2 modelli')).toBeTruthy();
  });
});

describe('model page: what the PC already has', () => {
  it('a downloaded quant is marked, its missing extras are ticked, and only they are fetched', async () => {
    bridge();
    const api = libApi(world({ onPc: { 'Model-Q8_0.gguf': 'have' } }));
    renderLib(PAGE, api);
    const q8 = await screen.findByRole('radio', { name: /Q8_0/ });
    await waitFor(() => expect(within(q8).getByText('Già scaricato')).toBeTruthy());
    await userEvent.click(q8);
    const mmproj = screen.getByRole('checkbox', { name: /mmproj-F16\.gguf/ });
    expect(mmproj.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText(`Il modello è già sul PC: scarico solo la parte visione (mmproj) (${bytes(9e8)}).`)).toBeTruthy();
    // Unticked: nothing left to fetch.
    await userEvent.click(mmproj);
    expect(screen.getByText('È già tutto sul PC.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Già scaricato' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(mmproj);
    await userEvent.click(screen.getByRole('button', { name: `Scarica Q8_0 · ${bytes(9e8)}` }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(`Il modello è già sul PC: scarico solo la parte visione (mmproj) (${bytes(9e8)}).`)).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: `Scarica · ${bytes(9e8)}` })).toBeTruthy();
  });

  it('files of the right size not verified yet are checked first; an extra already here says so', async () => {
    bridge();
    const parts = { 'Q4/Model-Q4_K_M-00001-of-00002.gguf': 'check', 'Q4/Model-Q4_K_M-00002-of-00002.gguf': 'check' } as const;
    const api = libApi(world({ onPc: parts }));
    renderLib(PAGE, api);
    // The best quant (Q4_K_M) is on the PC, unverified: the mmproj it lacks is ticked.
    await userEvent.click(await screen.findByRole('button', { name: `Scarica Q4_K_M · ${bytes(9e8)}` }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(`Prima controllo i file già presenti (${bytes(5e9)}): li riscarico solo se sono diversi.`)).toBeTruthy();
  });

  it('an extra already on the PC is labelled and never counted', async () => {
    const api = libApi(world({ onPc: { 'Model-Q8_0.gguf': 'have', 'mmproj-F16.gguf': 'have' } }));
    renderLib(PAGE, api);
    await userEvent.click(await screen.findByRole('radio', { name: /Q8_0/ }));
    await waitFor(() => expect(screen.getByText('È già tutto sul PC.')).toBeTruthy());
    expect(screen.getByText(/· già sul PC/)).toBeTruthy();
  });

  it('"Sul tuo PC": the copies of this repo, their update, a result of the previous version; checks this repo only', async () => {
    bridge();
    // A copy whose size the scan did not record.
    const noSize = mine('m4');
    delete noSize.identity.sizeBytes;
    const api = libApi(
      world({
        local: [
          noSize,
          mine('m1', { previous: { weakKey: 'org/Model-GGUF/m1-Q4_K_M.gguf/Q4_K_M/1', sha256: 'o'.repeat(64) }, auxiliary: [{ kind: 'mmproj', path: `${DIR}\\mmproj.gguf` }] }),
          mine('half', { incomplete: { have: 1, total: 2 } }),
          localModel('other'),
        ],
        modelUpdates: { checking: false, models: [news(), news({ modelId: 'other', repo: 'x/Other' })] },
      }),
    );
    api.on('GET /api/runs/tried', (_b, q) => (q.get('weakKey') === 'org/Model-GGUF/m1-Q4_K_M.gguf/Q4_K_M/1' ? [run('old', { decodeTps: 55 })] : []));
    renderLib(PAGE, api);
    const card = (await screen.findByRole('list', { name: 'Sul tuo PC' })).closest('[data-on-this-pc]') as HTMLElement;
    // The complete copy only (not the download stopped halfway, not another repo's model).
    expect(within(card).getByText('Model m1')).toBeTruthy();
    expect(within(card).queryByText('Model half')).toBeNull();
    expect(within(card).getByText('Visione (mmproj)')).toBeTruthy();
    expect(await within(card).findByText('Provato con la versione precedente · scrive 55 tok/s')).toBeTruthy();
    expect(within(card).getByText('Aggiornamento disponibile')).toBeTruthy();
    await userEvent.click(within(card).getByRole('button', { name: 'Controlla aggiornamenti' }));
    // Only this repo's models count.
    expect((await screen.findAllByText('Ho trovato novità per 1 modello')).length).toBeGreaterThan(0);
    expect(api.w.checks).toEqual([{ repo: REPO }]);
  });

  it('no copy on the PC: no "Sul tuo PC"', async () => {
    renderLib(PAGE, libApi());
    expect(await screen.findByRole('radio', { name: /Q8_0/ })).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Sul tuo PC' })).toBeNull();
  });
});
