import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { customEngineSchema, type CustomEngine } from '../../../../src/contract/custom-engines';
import { customInfo, fail, libApi, renderLib, world } from './fake';

vi.mock('echarts/core', () => ({ use: vi.fn(), init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })) }));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({ AxisPointerComponent: {}, DataZoomComponent: {}, GridComponent: {}, LegendComponent: {}, MarkAreaComponent: {}, MarkLineComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

afterEach(() => {
  delete (window as { gpubench?: unknown }).gpubench;
  vi.restoreAllMocks();
});

const team = customEngineSchema.parse({ id: 'team', name: 'SGLang del team', base: 'sglang', run: { mode: 'docker', image: 'team/sglang:v1' }, pulledImage: 'team/sglang:v1' }) as CustomEngine;
const fusion = customEngineSchema.parse({ id: 'fusion', name: 'NInfer fusion', base: 'ninfer', run: { mode: 'ninfer', path: '~/ninfer-fusion', distro: 'Ubuntu' } }) as CustomEngine;

function setup() {
  const w = world({ settings: { ...world().settings, customEngines: [team, fusion] } });
  w.custom = [customInfo(team), customInfo(fusion)];
  w.customFiles = {
    team: { kind: 'image', target: 'team/sglang:v1', sizeBytes: 9.5 * 1024 ** 3, command: 'docker rmi team/sglang:v1' },
    fusion: { kind: 'folder', target: '~/ninfer-fusion', distro: 'Ubuntu', command: 'wsl -d Ubuntu -- rm -rf ~/ninfer-fusion' },
  };
  return libApi(w);
}

const open = async (name: string) => {
  await userEvent.click(within(await screen.findByRole('region', { name })).getByRole('button', { name: 'Elimina' }));
  return screen.findByRole('dialog', { name: `Eliminare ${name}?` });
};

describe('deleting a custom engine', () => {
  it('removes the image LLM Bench pulled for it too, after saying which, how big and the command', async () => {
    const api = setup();
    renderLib('/engines', api);
    const dialog = await open('SGLang del team');
    expect(await within(dialog).findByText(/Per lui LLM Bench ha scaricato l’immagine Docker team\/sglang:v1, 9,5 GB/)).toBeTruthy();
    expect(dialog.textContent).toContain('docker rmi team/sglang:v1');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Rimuovi anche i file' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'DELETE' && c.path === '/api/engines/custom/team?files=1')).toBe(true));
    expect(await screen.findByText('Motore e file eliminati')).toBeTruthy();
  });

  it('or only forgets it, the files left where they are; a folder without a known size says just where it is', async () => {
    const api = setup();
    renderLib('/engines', api);
    const dialog = await open('NInfer fusion');
    expect(await within(dialog).findByText(/la cartella ~\/ninfer-fusion · Ubuntu\. Puoi eliminarla/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Dimentica soltanto' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'DELETE' && c.path === '/api/engines/custom/fusion')).toBe(true));
    expect(await screen.findByText('Motore eliminato')).toBeTruthy();
  });

  it('says why the files could not go (in use) and keeps the dialog open', async () => {
    const api = setup();
    api.on('DELETE /api/engines/custom/*', () => fail('ENGINE_IN_USE'));
    renderLib('/engines', api);
    const dialog = await open('SGLang del team');
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Rimuovi anche i file' }));
    expect(await within(dialog).findByText(/sta usando i motori/)).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Eliminare SGLang del team?' })).toBeTruthy();
  });

  it('with a folder of a known size, says how big', async () => {
    const api = setup();
    api.w.customFiles.fusion = { ...api.w.customFiles.fusion!, sizeBytes: 2 * 1024 ** 3 };
    renderLib('/engines', api);
    const dialog = await open('NInfer fusion');
    expect(await within(dialog).findByText(/la cartella ~\/ninfer-fusion · Ubuntu, 2,0 GB/)).toBeTruthy();
  });
});
