// The Benchmark page with custom engines: the choice grouped under each base, the request naming the
// engine, and GPU Bench's suggestion for a model that needs one (a saved engine, or a built-in template).
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StartRunRequest } from '../../../../src/contract/api';
import { customEngineSchema, type CustomEngine } from '../../../../src/contract/custom-engines';
import { renderApp } from '../helpers';
import { benchApi, localModel } from './world';

vi.mock('echarts/core', () => ({ use: vi.fn(), init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })) }));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({ AxisPointerComponent: {}, DataZoomComponent: {}, GridComponent: {}, LegendComponent: {}, MarkAreaComponent: {}, MarkLineComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

beforeAll(() => {
  Object.assign(Element.prototype, { hasPointerCapture: () => false, releasePointerCapture: () => undefined, scrollIntoView: () => undefined });
});
afterEach(() => {
  delete (window as { gpubench?: unknown }).gpubench;
});

const engine = (o: Partial<CustomEngine> & Pick<CustomEngine, 'id' | 'name' | 'base' | 'run'>): CustomEngine => customEngineSchema.parse(o);
const prism = engine({ id: 'prismml', name: 'PrismML', base: 'llamacpp', run: { mode: 'native', path: '/prism/llama-server' }, match: { names: ['bonsai'], quants: [] } });
const server = engine({ id: 'srv', name: 'Il mio server', base: 'openai-server', run: { mode: 'command', template: 'srv --port {port}', api: 'completions' } });
const sglangNative = engine({ id: 'sgn', name: 'SG nativo', base: 'sglang', run: { mode: 'native', path: '/venv' } });
const bonsai = localModel('bonsai', { displayName: 'Ternary Bonsai 8B', file: 'Ternary-Bonsai-8B-PQ2_0.gguf', quant: 'PQ2_0', weakKey: 'local/bonsai' });
const posted = (api: ReturnType<typeof benchApi>, path: string) => api.calls.filter((c) => c.method === 'POST' && c.path === path);

async function choose(combobox: string, option: string | RegExp) {
  const trigger = screen.getByRole('combobox', { name: combobox });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
  fireEvent.click(await screen.findByRole('option', { name: option }));
}

describe('Benchmark with custom engines', () => {
  it('lists them under their base and sends only their id', async () => {
    const api = benchApi({}, { onboardingDone: true, customEngines: [prism, server, sglangNative] });
    api.world.engines.push({ kind: 'sglang-native', available: false, installed: false, problems: [], supported: false });
    api.world.custom = [
      { engine: prism, kind: 'llamacpp-native', config: { kind: 'llamacpp-native', customEngineId: 'prismml' }, check: { kind: 'llamacpp-native', status: { kind: 'llamacpp-native', available: true, installed: true, version: 'b7001', problems: [], supported: true }, flagCount: 400, missing: [] } },
    ];
    renderApp('/', api);
    await screen.findByRole('heading', { name: 'Pronto a misurare la tua RTX 5090' });
    const trigger = screen.getByRole('combobox', { name: 'Cambia motore' });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Enter' });
    const names = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(names.findIndex((n) => n?.startsWith('llama.cpp · PrismML'))).toBe(1);
    expect(names.some((n) => n?.startsWith('Programma con API OpenAI · Il mio server'))).toBe(true);
    // SGLang native does not run here (Windows): its custom engines cannot be chosen either.
    expect((await screen.findByRole('option', { name: /SGLang · SG nativo/ })).getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(await screen.findByRole('option', { name: /llama\.cpp · PrismML/ }));
    expect(await screen.findByText('/prism/llama-server')).toBeTruthy();
    expect(await screen.findByText('Installato · b7001')).toBeTruthy();
    await waitFor(() => expect(posted(api, '/api/runs/plan').some((c) => (c.body as StartRunRequest).engine.customEngineId === 'prismml')).toBe(true));
    expect((posted(api, '/api/runs/plan').at(-1)!.body as StartRunRequest).engine).toEqual({ kind: 'llamacpp-native', customEngineId: 'prismml' });

    // Expert mode: the engine's own fields are set on the Engines page.
    await userEvent.click(screen.getByRole('switch', { name: 'Modalità esperto' }));
    expect(await screen.findByText('Usi il motore personalizzato PrismML: eseguibile, immagine e argomenti si cambiano nella pagina Motori.')).toBeTruthy();
    expect(screen.queryByLabelText('Eseguibile llama-server')).toBeNull();

    // A program of the user's own: no "Trova le impostazioni migliori", every local model offered.
    await choose('Cambia motore', /Il mio server/);
    expect(await screen.findByText('srv --port {port}')).toBeTruthy();
    expect(screen.queryByRole('radio', { name: /Trova le impostazioni migliori/ })).toBeNull();
    // Back to a plain engine.
    await choose('Cambia motore', /^llama\.cpp \(Docker\)/);
    await waitFor(() => expect((posted(api, '/api/runs/plan').at(-1)!.body as StartRunRequest).engine).toEqual({ kind: 'llamacpp-docker' }));
  });

  it('starts from the saved custom engine', async () => {
    const api = benchApi({}, { onboardingDone: true, customEngines: [prism], lastEngine: { kind: 'llamacpp-native', customEngineId: 'prismml' } });
    renderApp('/', api);
    await screen.findByRole('heading', { name: 'Pronto a misurare la tua RTX 5090' });
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Cambia motore' }).textContent).toBe('llama.cpp · PrismML'));
  });

  it('expert mode: SGLang installed on the PC takes the Python of its environment', async () => {
    const api = benchApi({}, { onboardingDone: true, expertMode: true, lastEngine: { kind: 'sglang-native' } });
    api.world.engines.push({ kind: 'sglang-native', available: true, installed: true, problems: [], supported: true });
    renderApp('/', api);
    const field = (await screen.findByLabelText('Python di SGLang')) as HTMLInputElement;
    await userEvent.type(field, '/venv/bin/python');
    expect(field.value).toBe('/venv/bin/python');
  });

  it('suggests the template a Bonsai model needs, and a saved engine once there is one', async () => {
    const api = benchApi({ local: [bonsai] }, { onboardingDone: true, lastModelId: 'bonsai' });
    const { router } = renderApp('/', api);
    expect(await screen.findByText('Questo modello richiede il fork PrismML di llama.cpp')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Scopri di più' }));
    expect(screen.getByText(/I modelli Bonsai di PrismML salvano i pesi in formati ternari/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Nascondi' }));
    expect(screen.queryByText(/I modelli Bonsai di PrismML salvano i pesi/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Indica dove si trova' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/engines'));
    expect(router.state.location.search).toEqual({ customTemplate: 'prismml-bonsai', model: 'local/bonsai', modelName: 'Ternary Bonsai 8B PQ2_0' });
  });

  it('proposes the saved engine whose rules match, and goes quiet once it is chosen', async () => {
    const api = benchApi({ local: [bonsai] }, { onboardingDone: true, lastModelId: 'bonsai', customEngines: [prism] });
    renderApp('/', api);
    const note = await screen.findByText('Per questo modello c’è PrismML');
    await userEvent.click(within(note.closest('[role="note"]') as HTMLElement).getByRole('button', { name: 'Usa PrismML' }));
    await waitFor(() => expect(screen.queryByText('Per questo modello c’è PrismML')).toBeNull());
    await waitFor(() => expect((posted(api, '/api/runs/plan').at(-1)!.body as StartRunRequest).engine).toEqual({ kind: 'llamacpp-native', customEngineId: 'prismml' }));
  });

  it('a suggested (curated) model is checked by its repo and file; no model, no suggestion', async () => {
    const api = benchApi({ local: [], curated: [{ ...benchApi().world.curated[0]!, repo: 'prism-ml/Ternary-Bonsai-8B-gguf', file: 'Ternary-Bonsai-8B-PQ2_0.gguf', label: 'Bonsai 8B · PQ2_0', quant: 'PQ2_0' }] });
    const { router } = renderApp('/', api);
    expect(await screen.findByText('Questo modello richiede il fork PrismML di llama.cpp')).toBeTruthy();
    // A model still to download has no library key: the link names it only in words.
    await userEvent.click(screen.getByRole('button', { name: 'Indica dove si trova' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/engines'));
    expect(router.state.location.search).not.toHaveProperty('model');
    expect(router.state.location.search).toMatchObject({ customTemplate: 'prismml-bonsai' });
  });
});
