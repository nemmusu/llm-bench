import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bridge, fail, job, libApi, localModel, renderLib, sample, system, world } from './fake';

vi.mock('echarts/core', () => ({ use: vi.fn(), init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })) }));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({ AxisPointerComponent: {}, DataZoomComponent: {}, GridComponent: {}, LegendComponent: {}, MarkAreaComponent: {}, MarkLineComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

afterEach(() => {
  delete (window as { gpubench?: unknown }).gpubench;
  vi.restoreAllMocks();
});

describe('shell status area', () => {
  it('real GPU name and VRAM in use from the live snapshot', async () => {
    renderLib('/settings', libApi(world({ snapshot: [sample(1, { memUsedMiB: 4096 })] })));
    const status = await screen.findByRole('region', { name: 'Stato della GPU' });
    expect(await within(status).findByText('RTX 5090')).toBeTruthy();
    expect(await within(status).findByText('4,0 GB di 31,8 GB in uso')).toBeTruthy();
  });

  it('falls back to the system reading, then to no GPU', async () => {
    const api = libApi(world({ snapshot: [] }));
    renderLib('/settings', api);
    const status = await screen.findByRole('region', { name: 'Stato della GPU' });
    expect(await within(status).findByText('1,6 GB di 31,8 GB in uso')).toBeTruthy();
  });

  it('no NVIDIA GPU', async () => {
    renderLib('/settings', libApi(world({ system: system({ gpus: [] }), snapshot: [] })));
    expect(await screen.findByText('Nessuna GPU NVIDIA trovata')).toBeTruthy();
  });

  it('no GPU memory reading at all', async () => {
    renderLib('/settings', libApi(world({ system: system({ gpus: [{ ...system().gpus[0]!, memoryUsedMiB: undefined }] }), snapshot: [] })));
    expect(await screen.findByText('0,0 GB di 31,8 GB in uso')).toBeTruthy();
  });
});

describe('downloads panel', () => {
  it('reachable from the title bar: progress, pause, resume, cancel, retry, folder', async () => {
    const b = bridge();
    const api = libApi(
      world({
        downloads: [
          job('run', { label: 'Running one', bytesPerSec: undefined }),
          job('paused', { label: 'Paused one', state: 'paused', createdAt: '2026-10-06T11:00:00.000Z' }),
          job('failed', { label: 'Failed one', state: 'failed', error: { code: 'DOWNLOAD_FAILED', message: 'reset' } }),
          job('gated', { label: 'Gated one', state: 'failed', repo: 'google/gated', error: { code: 'HF_GATED', message: '403' } }),
          job('done', { label: 'Done one', state: 'done', bytesDone: 8e9 }),
          job('verify', { label: 'Verifying one', state: 'verifying', bytesTotal: undefined }),
          job('gone', { label: 'Cancelled one', state: 'cancelled' }),
        ],
      }),
    );
    renderLib('/settings', api);
    await userEvent.click(await screen.findByRole('button', { name: 'Download e installazioni: 2 in corso' }));
    const panel = await screen.findByRole('dialog', { name: 'Download e installazioni' });
    const list = within(panel).getByRole('list', { name: 'Download e installazioni' });
    const rows = within(list).getAllByRole('listitem');
    expect(within(rows[0]!).getByText('Running one')).toBeTruthy();
    expect(within(rows[0]!).getByText('mancano 2 min 00 s')).toBeTruthy();
    expect(within(panel).getByText('Controllo che il file sia integro…')).toBeTruthy();
    expect(within(panel).getByText('Download non riuscito')).toBeTruthy();
    const gated = rows.find((r) => within(r).queryByText('Gated one')) as HTMLElement;
    await userEvent.click(within(gated).getByRole('button', { name: 'Accetta la licenza su Hugging Face' }));
    expect(b.openExternal).toHaveBeenCalledWith('https://huggingface.co/google/gated');
    const running = rows[0]!;
    await userEvent.click(within(running).getByRole('button', { name: 'Pausa' }));
    await waitFor(() => expect(within(running).getByText('In pausa')).toBeTruthy());
    await userEvent.click(within(running).getByRole('button', { name: 'Riprendi' }));
    await waitFor(() => expect(within(running).getByText('In coda')).toBeTruthy());
    await userEvent.click(within(running).getByRole('button', { name: 'Annulla' }));
    await waitFor(() => expect(within(running).getByText('Annullato')).toBeTruthy());
    const failed = within(list).getAllByRole('listitem').find((r) => within(r).queryByText('Failed one')) as HTMLElement;
    await userEvent.click(within(failed).getByRole('button', { name: 'Riprova' }));
    const done = within(list).getAllByRole('listitem').find((r) => within(r).queryByText('Done one')) as HTMLElement;
    await userEvent.click(within(done).getByRole('button', { name: 'Mostra nella cartella' }));
    expect(b.revealPath).toHaveBeenCalledWith('C:\\Models\\org\\Model-GGUF');
    api.on('POST /api/downloads/*/*', () => fail('DOWNLOAD_NOT_FOUND', 404));
    const paused = within(list).getAllByRole('listitem').find((r) => within(r).queryByText('Paused one')) as HTMLElement;
    await userEvent.click(within(paused).getByRole('button', { name: 'Riprendi' }));
    expect(await within(paused).findByText('Download non trovato')).toBeTruthy();
    await userEvent.click(within(panel).getByRole('button', { name: 'Chiudi' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('installs in progress, an empty panel, events that update and finish downloads', async () => {
    const api = libApi(world({ local: [localModel('new', { identity: { repo: 'org/Model-GGUF', file: 'Model-Q8_0.gguf' } })] }));
    const { router } = renderLib('/settings', api);
    await userEvent.click(await screen.findByRole('button', { name: 'Download e installazioni' }));
    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByRole('heading', { name: 'Nessun download' })).toBeTruthy();
    act(() => {
      api.emit({ type: 'engine.install', kind: 'llamacpp-native', stage: 'download', bytesDone: 1, bytesTotal: 2 });
      api.emit({ type: 'engine.install', kind: 'docker-pull', image: 'vllm/vllm-openai:v1', stage: 'extract', bytesDone: 2, bytesTotal: 2 });
      api.emit({ type: 'engine.install', kind: 'docker-volume', stage: 'copy', bytesDone: 0 });
      api.emit({ type: 'engine.install', kind: 'mystery', stage: 'working', bytesDone: 0 });
    });
    const installs = await within(panel).findByRole('region', { name: 'Installazioni in corso' });
    expect(within(installs).getByText('Motore llama.cpp')).toBeTruthy();
    expect(within(installs).getByText('Immagine Docker vllm/vllm-openai:v1')).toBeTruthy();
    expect(within(installs).getByText('Copia del modello in Docker')).toBeTruthy();
    expect(within(installs).getByText('mystery')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download e installazioni: 4 in corso', hidden: true })).toBeTruthy();
    act(() => api.emit({ type: 'download.update', job: job('x', { label: 'Live one' }) }));
    expect(await within(panel).findByText('Live one')).toBeTruthy();
    act(() => api.emit({ type: 'download.update', job: job('x', { label: 'Live one', state: 'done', bytesDone: 8e9 }) }));
    expect(await screen.findByText('Download completato: Live one')).toBeTruthy();
    await userEvent.click(within(panel).getByRole('button', { name: 'Chiudi' }));
    await waitFor(() => expect(api.calls.some((c) => c.path === '/api/models/rescan')).toBe(true));
    const toastEl = screen.getByText('Download completato: Live one').closest('li') as HTMLElement;
    await userEvent.click(within(toastEl).getByRole('button', { name: 'Fai il benchmark' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    await waitFor(() => expect(api.w.settings.lastModelId).toBe('new'));
  });

  it('the benchmark action of a finished download works even if the model is not found', async () => {
    const api = libApi(world({ local: [] }));
    const { router } = renderLib('/settings', api);
    await screen.findByRole('button', { name: 'Download e installazioni' });
    act(() => api.emit({ type: 'download.update', job: job('y', { label: 'Other one', state: 'done' }) }));
    const toastEl = (await screen.findByText('Download completato: Other one')).closest('li') as HTMLElement;
    await userEvent.click(within(toastEl).getByRole('button', { name: 'Fai il benchmark' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(api.w.settings.lastModelId).toBeUndefined();
  });

  it('a resume answered after the download already finished does not bring it back', async () => {
    const api = libApi(world({ downloads: [job('p', { label: 'Quick one', state: 'paused' })] }));
    api.on('POST /api/downloads/*/*', () => {
      api.emit({ type: 'download.update', job: job('p', { label: 'Quick one', state: 'done', bytesDone: 8e9 }) });
      return job('p', { label: 'Quick one', state: 'running' });
    });
    renderLib('/settings', api);
    await userEvent.click(await screen.findByRole('button', { name: 'Download e installazioni' }));
    const panel = await screen.findByRole('dialog');
    await userEvent.click(within(panel).getByRole('button', { name: 'Riprendi' }));
    expect(await within(panel).findByText('Completato')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 50));
    expect(within(panel).getByText('Completato')).toBeTruthy();
  });
});
