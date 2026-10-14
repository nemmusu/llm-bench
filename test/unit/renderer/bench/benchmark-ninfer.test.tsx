import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StartRunRequest } from '../../../../src/contract/api';
import { launchParamsSchema } from '../../../../src/contract/engines';
import type { RunResult } from '../../../../src/contract/results';
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

const P = (over: object = {}) => launchParamsSchema.parse(over);
const posted = (api: ReturnType<typeof benchApi>, path: string) => api.calls.filter((c) => c.method === 'POST' && c.path === path);
const lastPlan = (api: ReturnType<typeof benchApi>) => posted(api, '/api/runs/plan').at(-1)?.body as StartRunRequest | undefined;

const q38 = localModel('q38', { format: 'ninfer', file: 'qwen3_8_27b_nvfp4.ninfer', files: ['qwen3_8_27b_nvfp4.ninfer'], quant: undefined, facts: { name: 'qwen3.8-27b' } });
const world = () => ({
  engines: [...ENGINES, { kind: 'ninfer-wsl' as const, available: true, installed: true, version: 'e31bc99b13f5', variant: 'Ubuntu-24.04', location: '/home/u/ninfer/build/apps/ninfer-serve', problems: [], supported: true }, { kind: 'ninfer-native' as const, available: false, installed: false, problems: [], supported: false }],
  local: [q38, localModel('qwen3-8b')],
});

async function chooseNinfer() {
  const trigger = await screen.findByRole('combobox', { name: 'Cambia motore' });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
  // Only the kind this system runs (Windows: in WSL) is offered.
  expect(screen.queryAllByRole('option').filter((o) => /RTX 5090 \(Linux\)/.test(o.textContent ?? ''))).toEqual([]);
  fireEvent.click(await screen.findByRole('option', { name: /NInfer \(WSL\)/ }));
}

describe('NInfer on the Benchmark page', () => {
  it('its built-in settings for a .ninfer model, NInfer\'s recommended first', async () => {
    const api = benchApi(world());
    renderApp('/', api);
    await screen.findByRole('button', { name: /Cambia modello:/ });
    await chooseNinfer();
    expect(await screen.findByRole('button', { name: /Cambia modello: qwen3.8-27b/ })).toBeTruthy();
    const settings = await screen.findByRole('radiogroup', { name: 'Impostazioni di NInfer' });
    expect(within(settings).getByRole('radio', { name: /Consigliata da NInfer: contesto 240K, KV fp8, 2 utenti, MTP 3/ }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText(/Quella del README di NInfer/)).toBeTruthy();
    await waitFor(() => expect(lastPlan(api)?.params).toMatchObject({ contextSize: 240_000, parallel: 2, ninfer: { kvCapacity: 240_000, kvDtype: 'fp8', spec: 'mtp', draftTokens: 3 } }));
    await userEvent.click(within(settings).getByRole('radio', { name: /Provata su RTX 5090/ }));
    expect(screen.getByText(/circa 27 GB di memoria video/)).toBeTruthy();
    await waitFor(() => expect(lastPlan(api)?.params).toMatchObject({ contextSize: 65_536, ninfer: { kvCapacity: 131_072, kvDtype: 'int8', vision: true } }));
    await userEvent.click(within(settings).getByRole('radio', { name: 'Scelte da LLM Bench' }));
    expect(screen.getByText(/Il contesto e gli utenti che servono al test/)).toBeTruthy();
    // LLM Bench chooses the rest in the core (core/engines/ninfer/defaults.ts); the reasoning switch is said (on).
    await waitFor(() => expect(lastPlan(api)?.params).toEqual({ extraArgs: [], env: {}, ninfer: { thinking: true } }));
    expect(lastPlan(api)?.engine).toMatchObject({ kind: 'ninfer-wsl' });
  });

  it('a NInfer result\'s preset brings its own settings as a choice', async () => {
    const base = seeded(IDS.quick);
    const run: RunResult = {
      ...base,
      engine: { kind: 'ninfer-wsl', name: 'NInfer', version: 'e31bc99b13f5', variant: 'Ubuntu-24.04' } as RunResult['engine'],
      model: { ...base.model, format: 'ninfer', source: 'local', displayName: 'q38-Q4_K_M', file: 'qwen3_8_27b_nvfp4.ninfer', weakKey: q38.identity.weakKey, sha256: undefined, path: undefined } as RunResult['model'],
      launch: { ...base.launch, argv: [], params: P({ contextSize: 32_768, parallel: 1, ninfer: { kvDtype: 'int8', spec: 'mtp', draftTokens: 2, prefixReuse: false, thinking: false } }) },
    };
    const api = benchApi({ ...world(), runs: [run] });
    const { router } = renderApp(`/results/${run.id}`, api);
    await userEvent.click(await screen.findByRole('button', { name: 'Usa questo preset' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    const settings = await screen.findByRole('radiogroup', { name: 'Impostazioni di NInfer' });
    const own = within(settings).getByRole('radio', { name: /Come nel test da cui viene il preset: --kv-dtype int8 --spec mtp --draft-tokens 2/ });
    expect(own.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('Le stesse impostazioni di NInfer del risultato che hai scelto.')).toBeTruthy();
    await waitFor(() => expect(lastPlan(api)?.params?.ninfer).toMatchObject({ kvDtype: 'int8', draftTokens: 2 }));
  });
});
