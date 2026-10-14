import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DownloadJob } from '../../../../src/contract/models';
import { jobDetails } from '../../../../src/renderer/components/library/downloads-panel';
import { en } from '../../../../src/renderer/i18n/en';
import { it as itStrings } from '../../../../src/renderer/i18n/it';
import { bridge, fail, job, libApi, renderLib, world } from './fake';

vi.mock('echarts/core', () => ({ use: vi.fn(), init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })) }));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({ AxisPointerComponent: {}, DataZoomComponent: {}, GridComponent: {}, LegendComponent: {}, MarkAreaComponent: {}, MarkLineComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

afterEach(() => {
  delete (window as { gpubench?: unknown }).gpubench;
  vi.restoreAllMocks();
});

async function openPanel(): Promise<HTMLElement> {
  await userEvent.click(await screen.findByRole('button', { name: /^Download e installazioni/ }));
  return screen.findByRole('dialog', { name: 'Download e installazioni' });
}

const rowOf = (panel: HTMLElement, label: string) => within(panel).getAllByRole('listitem').find((r) => within(r).queryByText(label)) as HTMLElement;

describe('pannello download: pulizia', () => {
  it('pulisce i completati (gli attivi restano), toglie una riga alla volta e alla fine mostra il pannello vuoto', async () => {
    const api = libApi(
      world({
        downloads: [
          job('run', { label: 'Running one' }),
          job('paused', { label: 'Paused one', state: 'paused' }),
          job('done', { label: 'Done one', state: 'done', bytesDone: 8e9 }),
          job('failed', { label: 'Failed one', state: 'failed', error: { code: 'DOWNLOAD_FAILED', message: 'reset' } }),
          job('gone', { label: 'Cancelled one', state: 'cancelled' }),
        ],
      }),
    );
    renderLib('/settings', api);
    const panel = await openPanel();
    // The sheet starts below the title bar: the window's own buttons stay free.
    expect(panel.className).toContain('top-10');
    expect(within(panel).getByText('I file scaricati restano sul PC.')).toBeTruthy();
    // Only finished rows can leave the list one by one.
    expect(within(rowOf(panel, 'Running one')).queryByRole('button', { name: /^Togli dall’elenco/ })).toBeNull();
    expect(within(rowOf(panel, 'Paused one')).queryByRole('button', { name: /^Togli dall’elenco/ })).toBeNull();
    await userEvent.click(within(panel).getByRole('button', { name: 'Togli dall’elenco: Failed one' }));
    await waitFor(() => expect(within(panel).queryByText('Failed one')).toBeNull());
    expect(api.calls.some((c) => c.method === 'DELETE' && c.path === '/api/downloads/failed')).toBe(true);

    await userEvent.click(within(panel).getByRole('button', { name: 'Pulisci completati' }));
    await waitFor(() => expect(within(panel).queryByText('Done one')).toBeNull());
    expect(within(panel).queryByText('Cancelled one')).toBeNull();
    expect(within(panel).getByText('Running one')).toBeTruthy();
    expect(within(panel).getByText('Paused one')).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: 'Pulisci completati' })).toBeNull();
    expect(api.w.downloads.map((d) => d.id)).toEqual(['run', 'paused']);

    // Once both are cancelled the list can be cleared again, down to the empty panel.
    await userEvent.click(within(rowOf(panel, 'Running one')).getByRole('button', { name: 'Annulla' }));
    await userEvent.click(within(rowOf(panel, 'Paused one')).getByRole('button', { name: 'Annulla' }));
    await userEvent.click(await within(panel).findByRole('button', { name: 'Pulisci completati' }));
    expect(await within(panel).findByRole('heading', { name: 'Nessun download' })).toBeTruthy();
    expect(api.w.downloads).toEqual([]);
  });

  it('dice quando non riesce a togliere una riga o a pulire l’elenco', async () => {
    const api = libApi(world({ downloads: [job('done', { label: 'Done one', state: 'done' })] }));
    api.on('DELETE /api/downloads/*', () => fail('DOWNLOAD_NOT_FOUND', 404));
    api.on('POST /api/downloads/clear', () => fail('INTERNAL', 500));
    renderLib('/settings', api);
    const panel = await openPanel();
    await userEvent.click(within(panel).getByRole('button', { name: 'Togli dall’elenco: Done one' }));
    expect(await within(rowOf(panel, 'Done one')).findByText('Download non trovato')).toBeTruthy();
    await userEvent.click(within(panel).getByRole('button', { name: 'Pulisci completati' }));
    expect(await within(panel).findByText('Si è verificato un errore imprevisto')).toBeTruthy();
    expect(within(panel).getByText('Done one')).toBeTruthy();
  });

  it('apre il modello di un download completato e chiude il pannello', async () => {
    bridge();
    const api = libApi(
      world({
        downloads: [
          job('done', { label: 'Done one', state: 'done' }),
          job('norepo', { label: 'No repo', state: 'done', repo: undefined, createdAt: '2026-10-05T10:00:00.000Z' }),
        ],
      }),
    );
    const { router } = renderLib('/settings', api);
    const panel = await openPanel();
    expect(within(rowOf(panel, 'No repo')).queryByRole('button', { name: 'Apri il modello' })).toBeNull();
    expect(within(rowOf(panel, 'No repo')).getByRole('button', { name: 'Mostra nella cartella' })).toBeTruthy();
    await userEvent.click(within(rowOf(panel, 'Done one')).getByRole('button', { name: 'Apri il modello' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/models/hub/org/Model-GGUF'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Download e installazioni' })).toBeNull());
  });

  it('due download con lo stesso nome: la seconda riga dice cosa li distingue, il nome intero al passaggio del mouse', async () => {
    const long = 'Qwen3.8-27B-Coder390-EfficientThink-Optimized-GGUF';
    const api = libApi(
      world({
        downloads: [
          job('q4', { label: long, state: 'done', files: [{ path: 'Qwen3.8-27B-Q4_K_M.gguf', sizeBytes: 17.8 * 1024 ** 3 }] }),
          job('mm', { label: long, state: 'done', files: [{ path: 'mmproj-F16.gguf', sizeBytes: 0.9 * 1024 ** 3 }], createdAt: '2026-10-05T10:00:00.000Z' }),
        ],
      }),
    );
    renderLib('/settings', api);
    const panel = await openPanel();
    const [first, second] = within(panel).getAllByRole('listitem') as [HTMLElement, HTMLElement];
    expect(within(first).getByText(long).getAttribute('title')).toBe(long);
    expect(within(first).getByText(/^GGUF · Q4_K_M · 17,8 GB · 6 ott 2026$/)).toBeTruthy();
    expect(within(first).getByText(/^GGUF · Q4_K_M/).getAttribute('title')).toBe('Qwen3.8-27B-Q4_K_M.gguf');
    expect(within(second).getByText(/^GGUF · parte visione · 922 MB · 5 ott 2026$/)).toBeTruthy();
  });
});

describe('jobDetails', () => {
  const i18n = { t: ((k: string) => (k === 'downloads.visionPart' ? 'vision part' : k)) as never, bytes: (n: number) => `${n} B`, date: () => 'D' };
  const of = (files: DownloadJob['files']) => jobDetails(job('x', { files }), i18n);

  it('format, what was fetched, size and date for each kind of download', () => {
    expect(of([{ path: 'm-UD-Q4_K_XL-00001-of-00002.gguf', sizeBytes: 2 }, { path: 'm-UD-Q4_K_XL-00002-of-00002.gguf', sizeBytes: 3 }])).toBe('GGUF · UD-Q4_K_XL · 5 B · D');
    expect(of([{ path: 'plain.gguf' }, { path: 'mmproj-model.gguf', sizeBytes: 1 }])).toBe('GGUF · plain · vision part · 1 B · D');
    expect(of([{ path: 'FP8/config.json' }, { path: 'FP8/model.safetensors', sizeBytes: 4 }])).toBe('safetensors · FP8 · 4 B · D');
    expect(of([{ path: 'config.json' }, { path: 'model.safetensors' }])).toBe('safetensors · D');
    expect(of([{ path: 'A/model.safetensors' }, { path: 'B/model.safetensors' }])).toBe('safetensors · D');
    expect(of([{ path: 'qwen-nvfp4.ninfer', sizeBytes: 7 }, { path: 'qwen.sha256sums' }])).toBe('NInfer · qwen-nvfp4 · 7 B · D');
    expect(of([{ path: 'weights.bin' }])).toBe('D');
  });
});

describe('testi della pulizia', () => {
  it('ci sono in inglese e in italiano', () => {
    expect(en.downloads.clear).toBe('Clear finished');
    expect(en.downloads.clearHint).toBe('Downloaded files stay on the PC.');
    expect(en.downloads.remove).toBe('Remove from the list: {name}');
    expect(en.downloads.openModel).toBe('Open the model');
    expect(en.downloads.visionPart).toBe('vision part');
    expect(itStrings.downloads.clear).toBe('Pulisci completati');
    expect(itStrings.downloads.openModel).toBe('Apri il modello');
  });
});
