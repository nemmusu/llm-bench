/**
 * A GGUF-NInfer artifact on the Benchmark page: with the official NInfer, LLM Bench says it needs NInfer-all
 * (by its name, or because an earlier run could not read it); with NInfer-all saved, it proposes it, and
 * NInfer-all starts from the model card's settings. The server flow chooses it by itself.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StartRunRequest, StartServerRequest } from '../../../../src/contract/api';
import { customEngineSchema } from '../../../../src/contract/custom-engines';
import type { RunResult } from '../../../../src/contract/results';
import { unreadableFor } from '../../../../src/renderer/components/engines/engine-suggestion';
import { renderApp } from '../helpers';
import { IDS, seeded } from './fixtures';
import { benchApi, ENGINES, localModel } from './world';

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

const posted = (api: ReturnType<typeof benchApi>, path: string) => api.calls.filter((c) => c.method === 'POST' && c.path === path);
const lastPlan = (api: ReturnType<typeof benchApi>) => posted(api, '/api/runs/plan').at(-1)?.body as StartRunRequest | undefined;

const gguf = localModel('gguf', {
  format: 'ninfer',
  displayName: 'Qwen3.8-27B-Coder390-EfficientThink-Q6_K-MTP',
  repo: 'nerkyor/Qwen3.8-27B-Coder390-GGUF-NInfer',
  file: 'Qwen3.8-27B-Coder390-EfficientThink-Q6_K-MTP.ninfer',
  files: ['Qwen3.8-27B-Coder390-EfficientThink-Q6_K-MTP.ninfer'],
  quant: 'Q6_K',
  facts: { noManifest: true, components: ['text', 'mtp'], paramsB: 27 },
});
const renamed = localModel('renamed', { format: 'ninfer', displayName: 'my-model', file: 'my-model.ninfer', files: ['my-model.ninfer'], quant: undefined, weakKey: 'local/my-model.ninfer' });
const ninferAll = customEngineSchema.parse({
  id: 'ninfer-all',
  name: 'NInfer-all',
  base: 'ninfer',
  template: 'ninfer-all',
  run: { mode: 'ninfer', path: '/home/u/ninfer-all', distro: 'Ubuntu-24.04', source: { url: 'https://github.com/iamwavecut/ninfer-all.git', branch: 'master' } },
  match: { names: ['GGUF-NInfer'], quants: [], layouts: ['gguf_blocks_v1'] },
});
const engines = [
  ...ENGINES,
  { kind: 'ninfer-wsl' as const, available: true, installed: true, version: 'e31bc99b13f5', variant: 'Ubuntu-24.04', location: '/home/u/ninfer/build/apps/ninfer-serve', problems: [], supported: true },
  { kind: 'ninfer-native' as const, available: false, installed: false, problems: [], supported: false },
];

async function chooseNinfer() {
  const trigger = await screen.findByRole('combobox', { name: 'Cambia motore' });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
  // NInfer itself (a variant of it is listed right under it).
  fireEvent.click((await screen.findAllByRole('option', { name: /^NInfer \(WSL\)/ })).find((o) => !/NInfer-all/.test(o.textContent ?? '')) as HTMLElement);
}

describe('a GGUF-NInfer artifact on the Benchmark page', () => {
  it('with the official NInfer: "Questo modello richiede NInfer-all", one click to add it for this model', async () => {
    const api = benchApi({ engines, local: [gguf] }, { onboardingDone: true, lastModelId: 'gguf' });
    const { router } = renderApp('/', api);
    await chooseNinfer();
    const callout = await screen.findByText('Questo modello richiede NInfer-all');
    const box = callout.closest('[role="note"], [role="status"], div') as HTMLElement;
    expect(screen.getByText(/Il NInfer ufficiale non legge i suoi pesi/)).toBeTruthy();
    // Its model card's settings are offered; the official NInfer starts from its own recommended ones.
    const settings = await screen.findByRole('radiogroup', { name: 'Impostazioni di NInfer' });
    expect(within(settings).getByRole('radio', { name: /Consigliata dalla scheda del modello: 100K per richiesta, KV rk8v4 condivisa da 400K, 4 utenti, MTP 3/ })).toBeTruthy();
    expect(within(settings).getByRole('radio', { name: /Consigliata da NInfer/ }).getAttribute('aria-checked')).toBe('true');
    await userEvent.click(within(box.parentElement ?? box).getByRole('button', { name: 'Aggiungi NInfer-all' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/engines'));
    expect(router.state.location.search).toMatchObject({ customTemplate: 'ninfer-all', model: gguf.identity.weakKey, modelName: 'Qwen3.8-27B-Coder390-EfficientThink-Q6_K-MTP Q6_K' });
  });

  it('a model an earlier run could not read is proposed NInfer-all too', async () => {
    const base = seeded(IDS.quick);
    const failed: RunResult = {
      ...base,
      id: 'FAILED-GGUF',
      status: 'failed',
      error: { code: 'ENGINE_MODEL_UNSUPPORTED', message: 'x', params: { engine: 'NInfer', reason: 'layout', value: 'gguf_blocks_v1' } },
      model: { ...base.model, format: 'ninfer', weakKey: renamed.identity.weakKey, sha256: undefined },
    };
    expect(unreadableFor(undefined, 'x')).toBeUndefined();
    renderApp('/', benchApi({ engines, local: [renamed], runs: [failed] }, { onboardingDone: true, lastModelId: 'renamed' }));
    await chooseNinfer();
    expect(await screen.findByText('Questo modello richiede NInfer-all')).toBeTruthy();
  });

  it('with NInfer-all saved: proposed, and once chosen it starts from the model card\'s settings', async () => {
    const api = benchApi({ engines, local: [gguf] }, { onboardingDone: true, lastModelId: 'gguf', customEngines: [ninferAll] });
    renderApp('/', api);
    await chooseNinfer();
    expect(await screen.findByText('Per questo modello c’è NInfer-all')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Usa NInfer-all' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Cambia motore' }).textContent).toBe('NInfer (WSL) · NInfer-all'));
    const settings = await screen.findByRole('radiogroup', { name: 'Impostazioni di NInfer' });
    expect(within(settings).getByRole('radio', { name: /Consigliata dalla scheda del modello/ }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText(/La cache KV rk8v4 c’è solo in alcune varianti di NInfer/)).toBeTruthy();
    await waitFor(() => expect(lastPlan(api)).toMatchObject({ engine: { kind: 'ninfer-wsl', customEngineId: 'ninfer-all' }, params: { contextSize: 102_400, parallel: 4, ninfer: { kvCapacity: 409_600, kvDtype: 'rk8v4', spec: 'mtp', draftTokens: 3 } } }));
  });

  it('"Avvia solo il server": NInfer-all chosen for the model by itself, with the card\'s settings', async () => {
    const api = benchApi({ engines, local: [gguf] }, { onboardingDone: true, customEngines: [ninferAll] });
    api.world.custom = [{ engine: ninferAll, kind: 'ninfer-wsl', config: { kind: 'ninfer-wsl', customEngineId: 'ninfer-all' }, check: { kind: 'ninfer-wsl', status: { kind: 'ninfer-wsl', available: true, installed: true, problems: [], supported: true }, flagCount: 40, missing: [] } }];
    renderApp('/servers/new', api);
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Motore' }).textContent).toContain('NInfer-all'));
    await waitFor(() => expect((posted(api, '/api/servers/plan').at(-1)?.body as StartServerRequest | undefined)?.engine).toEqual({ kind: 'ninfer-wsl', customEngineId: 'ninfer-all' }));
    await userEvent.click(screen.getByRole('tab', { name: 'I tuoi preset' }));
    expect(screen.getByRole('radio', { name: /Consigliata dalla scheda del modello/ }).getAttribute('aria-checked')).toBe('true');
    await waitFor(() => expect((posted(api, '/api/servers/plan').at(-1)?.body as StartServerRequest).params?.ninfer).toMatchObject({ kvDtype: 'rk8v4', kvCapacity: 409_600 }));
  });
});
