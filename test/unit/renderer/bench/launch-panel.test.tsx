/**
 * The launch settings on the Benchmark page, as a person uses them: each engine's own fields, NInfer's
 * fields and its card as one, the image and reasoning switches, "Solo N utenti", and the settings LLM
 * Bench prepared from the latest "Trova le impostazioni migliori".
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StartRunRequest } from '../../../../src/contract/api';
import type { CustomEngineInfo } from '../../../../src/contract/custom-engines';
import { renderApp, renderUi } from '../helpers';
import { LaunchFields } from '../../../../src/renderer/components/bench/launch-fields-panel';
import { EMPTY_PARAMS_FORM } from '../../../../src/renderer/components/bench/expert-form';
import { NinferPresetPicker, autoText } from '../../../../src/renderer/components/engines/ninfer-presets';
import { createFormatters } from '../../../../src/renderer/i18n';
import { ninferPresetsFor } from '../../../../src/contract/ninfer';
import { tunedRun } from '../tune/tune-fixtures';
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

async function choose(combobox: string, option: string | RegExp) {
  const trigger = screen.getByRole('combobox', { name: combobox });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
  fireEvent.click(await screen.findByRole('option', { name: option }));
}

const q38 = localModel('q38', { format: 'ninfer', file: 'qwen3_8_27b_nvfp4.ninfer', files: ['qwen3_8_27b_nvfp4.ninfer'], quant: undefined, facts: { name: 'qwen3.8-27b', components: ['text', 'vision', 'mtp', 'dflash2'] } });
const ninferWorld = () => ({
  engines: [...ENGINES, { kind: 'ninfer-wsl' as const, available: true, installed: true, version: 'e31bc99b13f5', variant: 'Ubuntu-24.04', location: '/home/u/ninfer/build/apps/ninfer-serve', problems: [], supported: true }],
  local: [q38],
});

describe('the advanced parameters of each engine', () => {
  it('SGLang: its own words, its flags, its memory default; nothing of llama.cpp', async () => {
    const api = benchApi({}, { onboardingDone: true, expertMode: true });
    renderApp('/', api);
    await screen.findByRole('heading', { name: 'Parametri avanzati' });
    expect(screen.getByLabelText('Livelli in GPU')).toBeTruthy();
    expect(screen.getByText('-ngl')).toBeTruthy();
    await choose('Cambia motore', /SGLang \(Docker\)/);
    await waitFor(() => expect(screen.queryByLabelText('Livelli in GPU')).toBeNull());
    expect((screen.getByLabelText('Memoria GPU da usare') as HTMLInputElement).placeholder).toBe('0,85');
    expect(screen.getByText('--mem-fraction-static')).toBeTruthy();
    expect(screen.getByText('--chunked-prefill-size')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Token del prompt per passo'), '4096');
    await choose('Tipo di cache KV', 'fp8 (e5m2)');
    await waitFor(() => expect(lastPlan(api)?.params).toMatchObject({ batchSize: 4096, kvCacheType: 'fp8' }));
    // llama-bench is llama.cpp's own: not offered here.
    await userEvent.click(screen.getByRole('radio', { name: /Personalizzato/ }));
    expect(screen.queryByRole('checkbox', { name: 'Esegui anche llama-bench' })).toBeNull();
  });

  it('a fork that lacks a flag: its field is disabled and says why', async () => {
    const fork: CustomEngineInfo = {
      engine: { id: 'prism', name: 'PrismML', base: 'llamacpp-fork', run: { mode: 'native', executable: 'C:\\prism\\llama-server.exe' }, extraArgs: [], env: {} } as unknown as CustomEngineInfo['engine'],
      kind: 'llamacpp-native',
      config: { kind: 'llamacpp-native', customEngineId: 'prism' },
      check: { kind: 'llamacpp-native', status: { kind: 'llamacpp-native', available: true, installed: true, problems: [], supported: true }, flagCount: 80, missing: [{ flag: '-ub', setting: 'ubatchSize', effect: 'default' }, { flag: '--rope-scaling', setting: 'ropeScaling', effect: 'default' }] },
    };
    renderUi(<LaunchFields base="llamacpp" form={EMPTY_PARAMS_FORM} invalid={[]} onForm={() => undefined} use="server" missing={fork.check.missing} />);
    expect((screen.getByLabelText('Micro-batch (token)') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText('Questa versione non ha -ub: vale il suo valore predefinito.')).toBeTruthy();
    expect(screen.getByText('Questa versione non ha --rope-scaling: il contesto non può andare oltre quello del modello.')).toBeTruthy();
    expect(screen.getByText(/Vuoto: lo sceglie LLM Bench\./)).toBeTruthy();
  });
});

describe('NInfer: its card and its fields as one', () => {
  it('the preset fills the empty fields; a field changed makes it "Personalizzate"; a pick empties them again', async () => {
    const api = benchApi(ninferWorld(), { onboardingDone: true, expertMode: true });
    renderApp('/', api);
    await screen.findByRole('button', { name: /Cambia modello:/ });
    await choose('Cambia motore', /NInfer \(WSL\)/);
    const card = await screen.findByRole('radiogroup', { name: 'Impostazioni di NInfer' });
    expect(within(card).getByRole('radio', { name: /Consigliata da NInfer/ }).getAttribute('aria-checked')).toBe('true');
    // NInfer's own fields, with the preset's values where they are empty; no llama.cpp or vLLM field.
    const ctx = screen.getByLabelText('Contesto per richiesta (token)') as HTMLInputElement;
    expect(ctx.placeholder).toBe('240.000');
    expect(screen.getAllByText(/Vuoto: da «Consigliata da NInfer»\./).length).toBeGreaterThan(3);
    expect(screen.queryByLabelText('Memoria GPU da usare')).toBeNull();
    expect(screen.queryByLabelText('Livelli in GPU')).toBeNull();
    expect(screen.getByText('--kv-capacity')).toBeTruthy();
    // Only the prediction heads the model has (MTP, DFlash2), and its vision switch.
    const spec = screen.getByRole('combobox', { name: 'Previsione dei token' });
    spec.focus();
    fireEvent.keyDown(spec, { key: 'Enter' });
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['MTP (scelta sopra)', 'Nessuna', 'MTP', 'DFlash2']);
    fireEvent.click(screen.getByRole('option', { name: 'Nessuna' }));
    expect(screen.getByRole('switch', { name: 'Immagini' })).toBeTruthy();
    // One field differs from every preset: the card says so, and what runs is the preset with that change.
    await waitFor(() => expect(within(card).getByRole('radio', { name: /^Personalizzate:/ }).getAttribute('aria-checked')).toBe('true'));
    expect(screen.getByText('Come le hai impostate nei parametri avanzati qui sotto.')).toBeTruthy();
    expect((screen.getByLabelText('Token previsti per passo') as HTMLInputElement).disabled).toBe(true);
    await waitFor(() => expect(lastPlan(api)?.params).toMatchObject({ contextSize: 240_000, parallel: 2, ninfer: { kvDtype: 'fp8', spec: 'off', thinking: true, vision: true } }));
    // "Personalizzate" itself changes nothing; a preset empties the fields again.
    await userEvent.click(within(card).getByRole('radio', { name: /^Personalizzate:/ }));
    await userEvent.click(within(card).getByRole('radio', { name: /Provata su RTX 5090/ }));
    await waitFor(() => expect(within(card).getByRole('radio', { name: /Provata su RTX 5090/ }).getAttribute('aria-checked')).toBe('true'));
    expect((screen.getByLabelText('Contesto per richiesta (token)') as HTMLInputElement).placeholder).toBe('65.536');
    await waitFor(() => expect(lastPlan(api)?.params?.ninfer).toMatchObject({ kvDtype: 'int8', spec: 'mtp' }));
    // Users above 8: NInfer cannot.
    await userEvent.type(screen.getByLabelText('Richieste servite insieme'), '9');
    expect(screen.getByText('Da 1 a 8: NInfer serve al massimo 8 richieste insieme.')).toBeTruthy();
    // Reasoning off: said explicitly (a test turns it off by itself otherwise).
    await userEvent.clear(screen.getByLabelText('Richieste servite insieme'));
    await userEvent.click(screen.getByRole('switch', { name: 'Ragionamento' }));
    await waitFor(() => expect(lastPlan(api)?.params?.ninfer).toMatchObject({ thinking: false }));
  });

  it('"Scelte da LLM Bench" says what it chose, or will choose', () => {
    const f = createFormatters('it');
    expect(autoText(undefined, 'test', f)).toMatch(/^Il contesto e gli utenti che servono al test, la cache KV più precisa/);
    expect(autoText(undefined, 'server', f)).toMatch(/^NInfer così com’è/);
    expect(autoText({ source: 'fit', kvDtype: 'int8', fits: true, spec: 'mtp', draftTokens: 3 }, 'test', f)).toBe('Il contesto e gli utenti che servono al test, cache KV int8 (la più precisa che entra in questa scheda), MTP 3.');
    expect(autoText({ source: 'fit', kvDtype: 'nvfp4', fits: false, spec: 'off' }, 'test', f)).toBe('Il contesto e gli utenti che servono al test, cache KV nvfp4 (anche la più compatta potrebbe non entrare), senza previsione dei token.');
    expect(autoText({ source: 'tuned', createdAt: '2026-10-01T10:00:00.000Z', kvDtype: 'int8', spec: 'mtp', draftTokens: 4 }, 'test', f)).toMatch(/^Dalle impostazioni migliori trovate il .*: cache KV int8, MTP 4; il contesto/);
    expect(autoText({ source: 'fit' }, 'test', f)).toBe(autoText(undefined, 'test', f));
  });

  it('the card on its own: the result’s settings, "Scelte da LLM Bench"', async () => {
    const onChange = vi.fn();
    renderUi(<NinferPresetPicker presets={ninferPresetsFor({ name: 'qwen3.8-27b' })} run={{ kvDtype: 'int8' }} value="auto" onChange={onChange} use="server" />);
    expect(screen.getByText(/^NInfer così com’è/)).toBeTruthy();
    expect(screen.queryByRole('radio', { name: /^Personalizzate/ })).toBeNull();
    await userEvent.click(screen.getByRole('radio', { name: /Come nel test/ }));
    expect(onChange).toHaveBeenCalledWith('run');
    cleanup();
    renderUi(<NinferPresetPicker presets={[]} value="custom" onChange={onChange} />);
    expect(screen.getByRole('radio', { name: 'Personalizzate: –' }).getAttribute('aria-checked')).toBe('true');
  });
});

describe('the image and reasoning switches, and "Solo N utenti"', () => {
  it('a GGUF with its image part: both switches; off goes in the request', async () => {
    const vision = { ...localModel('vl'), auxiliary: [{ kind: 'mmproj' as const, path: 'C:\\models\\mmproj.gguf' }] };
    const api = benchApi({ local: [vision] });
    renderApp('/', api);
    await screen.findByRole('button', { name: /Cambia modello:/ });
    expect(screen.getByText('Se questo modello non ragiona, non cambia nulla.')).toBeTruthy();
    await userEvent.click(screen.getByRole('switch', { name: 'Immagini' }));
    expect(screen.getByText('Spento: solo testo, meno memoria video.')).toBeTruthy();
    await userEvent.click(screen.getByRole('switch', { name: 'Ragionamento' }));
    await waitFor(() => expect(lastPlan(api)?.params).toMatchObject({ vision: false, reasoning: false }));
  });

  it('one number: from 1 up to it, or only that many at once', async () => {
    const api = benchApi({}, { onboardingDone: true, expertMode: true });
    renderApp('/', api);
    await screen.findByRole('heading', { name: 'Parametri avanzati' });
    await userEvent.click(screen.getByRole('radio', { name: /Personalizzato/ }));
    fireEvent.change(screen.getByLabelText('Caricamenti a freddo'), { target: { value: 'x' } });
    expect(screen.getByText('Valore non valido: correggilo per poter avviare.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Caricamenti a freddo'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Utenti contemporanei'), { target: { value: '2' } });
    await userEvent.click(screen.getByRole('radio', { name: 'Solo 2 utenti insieme' }));
    await waitFor(() => expect(lastPlan(api)?.scenario?.steps.find((s) => s.kind === 'concurrency')).toMatchObject({ levels: [2] }));
    await userEvent.click(screen.getByRole('radio', { name: 'Da 1 a 2' }));
    await waitFor(() => expect(lastPlan(api)?.scenario?.steps.find((s) => s.kind === 'concurrency')).toMatchObject({ levels: [1, 2] }));
    fireEvent.change(screen.getByLabelText('Conversazioni lunghe insieme'), { target: { value: '3' } });
    await userEvent.click(screen.getByRole('radio', { name: 'Solo 3 conversazioni insieme' }));
    await waitFor(() => expect(lastPlan(api)?.scenario?.steps.find((s) => s.kind === 'sessions')).toMatchObject({ levels: [3] }));
  });
});

describe('"Preparati da LLM Bench"', () => {
  it('the latest tune of this model: its answers, one click into the advanced parameters', async () => {
    const api = benchApi({ runs: [tunedRun()] });
    renderApp('/', api);
    const list = await screen.findByRole('region', { name: 'Preparati da LLM Bench' });
    expect(within(list).getByText('Contesto massimo · Più veloce in lettura')).toBeTruthy();
    expect(within(list).getByText('Più veloce in scrittura · Qualità migliore')).toBeTruthy();
    expect(within(list).getByText(/Dalla tua «Trova le impostazioni migliori» del/)).toBeTruthy();
    await userEvent.click(within(list).getByRole('button', { name: 'Usa «Contesto massimo · Più veloce in lettura»' }));
    expect(await screen.findByRole('heading', { name: 'Parametri avanzati' })).toBeTruthy();
    expect((screen.getByLabelText('Contesto (token)') as HTMLInputElement).value).toBe('65536');
    expect((screen.getByLabelText('Micro-batch (token)') as HTMLInputElement).value).toBe('2048');
    await waitFor(() => expect(lastPlan(api)?.params).toMatchObject({ contextSize: 65_536, kvCacheType: 'q4_0', ubatchSize: 2048 }));
    // Expert mode already on: it stays, the fields change.
    await userEvent.click(within(list).getByRole('button', { name: 'Usa «Più veloce in scrittura · Qualità migliore»' }));
    await waitFor(() => expect((screen.getByLabelText('Contesto (token)') as HTMLInputElement).value).toBe('24576'));
  });
});
