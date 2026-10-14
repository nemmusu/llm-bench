/**
 * "Avvia un server" with the same launch fields as the Benchmark page: NInfer's own in "Comandi
 * personalizzati" (kept as typed: a server keeps the user's prefix reuse and thinking), the image and
 * reasoning switches over any source, and the settings LLM Bench prepared from a tune.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { StartServerRequest } from '../../../../src/contract/api';
import { renderApp } from '../helpers';
import { tunedRun } from '../tune/tune-fixtures';
import { benchApi, ENGINES, localModel } from '../bench/world';

vi.mock('echarts/core', () => ({ use: vi.fn(), init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })) }));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({ AxisPointerComponent: {}, DataZoomComponent: {}, GridComponent: {}, LegendComponent: {}, MarkAreaComponent: {}, MarkLineComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

beforeAll(() => {
  Object.assign(Element.prototype, { hasPointerCapture: () => false, releasePointerCapture: () => undefined, scrollIntoView: () => undefined });
});

type Api = ReturnType<typeof benchApi>;
// The plans of the chosen settings ("Le migliori" also asks, in the background, what LLM Bench would choose: no params).
const lastPlan = (api: Api) => api.calls.filter((c) => c.method === 'POST' && c.path === '/api/servers/plan' && (c.body as StartServerRequest).params !== undefined).at(-1)!.body as StartServerRequest;

async function openFlow(api: Api) {
  renderApp('/servers/new', api);
  await screen.findByRole('heading', { level: 1, name: 'Avvia un server' });
  await screen.findByRole('region', { name: 'Comando esatto' });
}

const q38 = localModel('q38', { format: 'ninfer', file: 'qwen.ninfer', files: ['qwen.ninfer'], quant: undefined, facts: { name: 'qwen3.8-27b', components: ['text', 'vision', 'mtp'] } });

describe('Avvia un server: the launch fields', () => {
  it('NInfer: its own fields in "Comandi personalizzati", kept as typed; vision on for a model that has it', async () => {
    const api = benchApi({ local: [q38], engines: [...ENGINES, { kind: 'ninfer-wsl', available: true, installed: true, problems: [], supported: true }] });
    await openFlow(api);
    // "Scelte da LLM Bench" for a server says what a server gets; vision is said (NInfer starts without it).
    await userEvent.click(screen.getByRole('tab', { name: 'I tuoi preset' }));
    await userEvent.click(screen.getByRole('radio', { name: 'Scelte da LLM Bench' }));
    expect(screen.getByText(/^NInfer così com’è/)).toBeTruthy();
    await waitFor(() => expect(lastPlan(api).params).toEqual({ extraArgs: [], env: {}, ninfer: { vision: true } }), { timeout: 5000 });
    await userEvent.click(screen.getByRole('switch', { name: 'Immagini' }));
    await waitFor(() => expect(lastPlan(api).params).toEqual({ extraArgs: [], env: {}, ninfer: { vision: false } }), { timeout: 5000 });
    await userEvent.click(screen.getByRole('tab', { name: 'Comandi personalizzati' }));
    expect(screen.getByText('--max-concurrency')).toBeTruthy();
    expect(screen.queryByText('Contesto oltre il limite del modello (YaRN)')).toBeNull();
    const reuse = screen.getByRole('combobox', { name: 'Riusa il testo già letto' });
    reuse.focus();
    fireEvent.keyDown(reuse, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('option', { name: 'No' }));
    expect((screen.getByLabelText('Conversazioni tenute in GPU') as HTMLInputElement).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText('Cache KV condivisa (token)'), 'auto');
    await waitFor(() => expect(lastPlan(api).params?.ninfer).toMatchObject({ prefixReuse: false, kvCapacity: 'auto', vision: false }), { timeout: 5000 });
  });

  it('"Preparati da LLM Bench" under the user’s presets: one click fills "Comandi personalizzati"', async () => {
    const api = benchApi({ runs: [tunedRun()] });
    await openFlow(api);
    await userEvent.click(screen.getByRole('tab', { name: 'I tuoi preset' }));
    const list = await screen.findByRole('region', { name: 'Preparati da LLM Bench' });
    await userEvent.click(within(list).getByRole('button', { name: 'Usa «Più veloce in scrittura · Qualità migliore»' }));
    expect(screen.getByRole('tab', { name: 'Comandi personalizzati' }).getAttribute('data-state')).toBe('active');
    expect((screen.getByLabelText('Contesto (token)') as HTMLInputElement).value).toBe('24576');
    await waitFor(() => expect(lastPlan(api).params).toMatchObject({ contextSize: 24_576, kvCacheType: 'f16', flashAttention: 'on' }), { timeout: 5000 });
  });
});
