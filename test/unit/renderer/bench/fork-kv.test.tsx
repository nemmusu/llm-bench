// A llama.cpp fork's own KV caches in the renderer: the choices of the expert panel and of the server
// form (with their size, or "stima non disponibile"), the custom engine's check, the VRAM verdict's note.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StartRunRequest } from '../../../../src/contract/api';
import { customEngineSchema, type CustomEngineCheck, type CustomEngineInfo } from '../../../../src/contract/custom-engines';
import type { FitEstimate } from '../../../../src/contract/models';
import { formFromParams } from '../../../../src/renderer/components/bench/expert-form';
import { customKvCacheTypes, kvCacheOptions } from '../../../../src/renderer/components/bench/kv-cache-options';
import { FitSummary } from '../../../../src/renderer/components/bench/plan-card';
import { CheckView } from '../../../../src/renderer/components/engines/custom-engine-check';
import { SettingsStep, type SettingsStepProps } from '../../../../src/renderer/components/servers/start/settings-step';
import { createFormatters } from '../../../../src/renderer/i18n';
import { renderApp, renderUi } from '../helpers';
import { benchApi } from './world';

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

const UPSTREAM = ['f32', 'f16', 'bf16', 'q8_0', 'q4_0', 'q4_1', 'iq4_nl', 'q5_0', 'q5_1'];
const TURBO = [...UPSTREAM, 'turbo4', 'turbo3', 'turbo2', 'turbo1.5', 'turbo3_tcq', 'fancy7'];
const it_ = createFormatters('it');
const turbo = customEngineSchema.parse({ id: 'turbo', name: 'TurboQuant', base: 'llamacpp', run: { mode: 'native', path: '/turbo/llama-server' } });
const status = { kind: 'llamacpp-native' as const, available: true, installed: true, version: 'b7001', problems: [], supported: true };
const check = (over: Partial<CustomEngineCheck> = {}): CustomEngineCheck => ({ kind: 'llamacpp-native', status, flagCount: 400, missing: [], ...over });
const info: CustomEngineInfo = { engine: turbo, kind: 'llamacpp-native', config: { kind: 'llamacpp-native', customEngineId: 'turbo' }, check: check({ kvCacheTypes: TURBO }) };

async function openSelect(name: string) {
  const trigger = screen.getByRole('combobox', { name });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
  return screen.findAllByRole('option');
}

describe('the KV cache choices', () => {
  it('upstream’s three, then the fork’s by size with their bits, an unknown one with "stima non disponibile"', () => {
    expect(kvCacheOptions(undefined, 'default', it_).map((o) => o.value)).toEqual(['default', 'f16', 'q8_0', 'q4_0']);
    const opts = kvCacheOptions(TURBO, 'default', it_);
    expect(opts.map((o) => [o.value, o.description])).toEqual([
      ['default', undefined],
      ['f16', undefined],
      ['q8_0', undefined],
      ['q4_0', undefined],
      ['turbo4', '4,25 bit per valore'],
      ['turbo3', '3,125 bit per valore'],
      ['turbo3_tcq', '3,125 bit per valore'],
      ['turbo2', '2,125 bit per valore'],
      ['turbo1.5', '2 bit per valore'],
      ['fancy7', 'stima non disponibile'],
    ]);
    // A type chosen with another fork stays visible.
    expect(kvCacheOptions(undefined, 'turbo3', it_).map((o) => o.value)).toEqual(['default', 'f16', 'q8_0', 'q4_0', 'turbo3']);
    expect(kvCacheOptions(undefined, 'q8_0', it_)).toHaveLength(4);
    expect(kvCacheOptions(['turbo3'], 'turbo3', createFormatters('en')).at(-1)).toMatchObject({ value: 'turbo3', description: '3.125 bits per value' });
  });

  it('the chosen custom engine’s list, from its check', () => {
    expect(customKvCacheTypes([info], turbo)).toEqual(TURBO);
    expect(customKvCacheTypes([info], undefined)).toBeUndefined();
    expect(customKvCacheTypes(undefined, turbo)).toBeUndefined();
    expect(customKvCacheTypes([{ ...info, check: check() }], turbo)).toBeUndefined();
  });

  it('the server form offers them', async () => {
    const props: SettingsStepProps = {
      engineKind: 'llamacpp-native',
      tab: 'custom',
      onTab: vi.fn(),
      best: 'auto',
      onBest: vi.fn(),
      autoTuned: undefined,
      provenance: undefined,
      configs: [],
      loadingConfig: false,
      presets: [],
      preset: undefined,
      onPreset: vi.fn(),
      othersCount: 0,
      form: formFromParams(undefined),
      invalid: [],
      onForm: vi.fn(),
      unsupported: undefined,
      kvCacheTypes: TURBO,
    };
    renderUi(<SettingsStep {...props} />, { withSettings: true });
    const options = await openSelect('Tipo di cache KV');
    expect(options.map((o) => o.textContent)).toContain('turbo33,125 bit per valore');
    fireEvent.click(options.find((o) => o.textContent?.startsWith('turbo3'))!);
    expect(props.onForm).toHaveBeenCalledWith({ kvCacheType: 'turbo3' });
  });
});

describe('the custom engine’s check and the VRAM verdict', () => {
  it('names the fork’s own KV caches; nothing for a build with upstream’s only', () => {
    const { rerender } = renderUi(<CheckView check={check({ kvCacheTypes: TURBO })} baseLabel="llama.cpp" run={turbo.run} />);
    expect(screen.getByText('Cache KV in più rispetto a llama.cpp: turbo4, turbo3, turbo2, turbo1.5, turbo3_tcq, fancy7')).toBeTruthy();
    rerender(<CheckView check={check({ kvCacheTypes: UPSTREAM })} baseLabel="llama.cpp" run={turbo.run} />);
    expect(screen.queryByText(/Cache KV in più/)).toBeNull();
  });

  it('a KV type of unknown size: "stima non disponibile", counted as f16', () => {
    const fit: FitEstimate = { level: 'good', needMiB: 6000, weightsMiB: 4000, kvMiB: 1500, overheadMiB: 500, availableMiB: 31_583, utilization: 0.19, contextSize: 8192, basis: 'file-size', notes: ['kv.type-unknown'], totalMiB: 32_607 };
    renderUi(<FitSummary fit={fit} />);
    expect(screen.getByText('Cache KV di un tipo che LLM Bench non conosce: stima non disponibile, la sua memoria è calcolata come con f16.')).toBeTruthy();
  });
});

describe('the Benchmark with a fork that has its own KV caches', () => {
  it('expert mode offers turbo3 and the run asks for it', async () => {
    const api = benchApi({}, { onboardingDone: true, expertMode: true, customEngines: [turbo], lastEngine: { kind: 'llamacpp-native', customEngineId: 'turbo' } });
    api.world.custom = [info];
    renderApp('/', api);
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Cambia motore' }).textContent).toBe('llama.cpp · TurboQuant'));
    // The engine's check (GET /api/engines/custom) brings its list.
    expect(await screen.findByText('Installato · b7001')).toBeTruthy();
    const options = await openSelect('Tipo di cache KV');
    const turbo3 = options.find((o) => o.textContent?.startsWith('turbo3'))!;
    expect(within(turbo3).getByText('3,125 bit per valore')).toBeTruthy();
    fireEvent.click(turbo3);
    const posted = () => api.calls.filter((c) => c.method === 'POST' && c.path === '/api/runs/plan').map((c) => c.body as StartRunRequest);
    await waitFor(() => expect(posted().at(-1)?.params?.kvCacheType).toBe('turbo3'));
    expect(screen.getByRole('combobox', { name: 'Tipo di cache KV' }).textContent).toBe('turbo3');
  });
});
