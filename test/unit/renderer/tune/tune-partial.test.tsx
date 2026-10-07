/**
 * A "Trova le impostazioni migliori" that ran out of time (the 0.3.0 run on an RTX 5090: q8_0 at 256K
 * measured at 1K and 64K, f16 only checked at 1K): partly measured combinations, a recommendation, the
 * presets of that recommendation (never the run's own launch), what is known above each context.
 */
import { screen, within } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { RunResult, Tuning } from '../../../../src/contract/results';
import { capacityNote } from '../../../../src/renderer/components/tune/tune-sections';
import { roughDuration } from '../../../../src/renderer/components/tune/tune-format';
import { createFormatters } from '../../../../src/renderer/i18n';
import { renderApp } from '../helpers';
import { seededRuns } from '../bench/fixtures';
import { benchApi } from '../bench/world';
import { attempt, combo, point, tunedRun } from './tune-fixtures';

vi.mock('echarts/core', () => ({ use: vi.fn(), init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })) }));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({ AxisPointerComponent: {}, DataZoomComponent: {}, GridComponent: {}, LegendComponent: {}, MarkAreaComponent: {}, MarkLineComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

beforeAll(() => {
  Object.assign(Element.prototype, { hasPointerCapture: () => false, releasePointerCapture: () => undefined, scrollIntoView: () => undefined });
});

const K = 1024;
const h1 = (name: string | RegExp) => screen.findByRole('heading', { level: 1, name });

/** The real numbers of that run, partly measured when the time ran out. */
function outOfTime(): Partial<Tuning> {
  const q8 = combo('q8_0', 256 * K, [point(K, 54.8, 1787), point(64 * K, 46.5, 2049)], { partial: 'budget', vramPeakMiB: 26_478 });
  const f16 = combo('f16', 208 * K, [{ ...point(K, 55.9, 1810), outputTokens: 32 }], { partial: 'budget', vramPeakMiB: 30_100 });
  return {
    stoppedBy: 'budget',
    estimateSeconds: 2062,
    limitSeconds: 300,
    combinations: [f16, q8],
    recommended: 1,
    fastestByDepth: [
      { depth: K, combination: 0 },
      { depth: 64 * K, combination: 1 },
    ],
    depths: [K, 64 * K],
    capacity: [
      { kvType: 'f16', predictedMax: 247_552, measuredMax: 208 * K, inferred: false, bound: 'found', failedAt: 224 * K },
      { kvType: 'q8_0', predictedMax: 256 * K, measuredMax: 256 * K, inferred: false, bound: 'model' },
      { kvType: 'q4_0', predictedMax: 256 * K, measuredMax: 256 * K, inferred: true, skipped: 'no-gain', bound: 'model' },
    ],
    attempts: [
      attempt('reference', 'f16', 4 * K, 'ok'),
      attempt('capacity', 'f16', 208 * K, 'ok', { combination: 0 }),
      attempt('variant', 'q8_0', 256 * K, 'ok', { screen: 'kept', combination: 1, skipped: [{ depth: 262_000, predictedMs: 371_533 }] }),
    ],
    fidelity: undefined,
  };
}

function open(run: RunResult) {
  const api = benchApi({ runs: [...seededRuns(), run] });
  return { ...renderApp(`/results/${run.id}`, api), api };
}

describe('a search that ran out of time', () => {
  it('ranks what it measured, marked "misurata in parte", recommends one, and its presets are that one', async () => {
    open(tunedRun(outOfTime()));
    expect(await h1(/Qwen3 8B/)).toBeTruthy();
    const rec = screen.getByRole('region', { name: 'Combinazione consigliata' });
    expect(within(rec).getByText('Misurata in parte (tempo finito)')).toBeTruthy();
    expect(within(rec).getByText('256K')).toBeTruthy();
    expect(screen.getAllByText('Misurata in parte (tempo finito)').length).toBeGreaterThanOrEqual(3);
    // Why it stopped: how many launches in how much time, and the request left out.
    expect(screen.getByText('Mi sono fermato prima: tempo finito')).toBeTruthy();
    expect(screen.getByText(/Ho fatto 3 prove nel tempo previsto \(5 min 00 s\)/)).toBeTruthy();
    expect(screen.getByText('Non misurato a 256K: sarebbe finito dopo il tempo previsto (circa 6 min 12 s).')).toBeTruthy();
    // The header: the recommended combination, never the run's own launch.
    const config = document.querySelector('header span.block') ?? document.querySelector('span.block.text-sm');
    expect(config?.textContent).toMatch(/q8_0/);
    expect(screen.getAllByRole('button', { name: 'Usa questo preset' }).length).toBeGreaterThan(0);
    // What is known above each context.
    const capacity = screen.getByRole('region', { name: 'Contesto massimo per tipo di cache' });
    expect(within(capacity).getByText('Limite trovato: a 224K non entra più.')).toBeTruthy();
    expect(within(capacity).getByText('Arriva al contesto massimo del modello.')).toBeTruthy();
  });

  it('nothing measured: no preset in the header, no configuration words', async () => {
    const run = tunedRun({ ...outOfTime(), combinations: [], recommended: undefined, fastestByDepth: [], depths: [] });
    open(run);
    expect(await h1(/Qwen3 8B/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Usa questo preset' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Avvia il server così' })).toBeNull();
    // Only the engine: the run's own launch record (one of its launches) is not its configuration.
    expect(document.querySelector('span.block.text-sm')?.textContent).not.toMatch(/·/);
  });

  it('a search stopped by the launch cap, from before the time limit was saved', async () => {
    const t = outOfTime();
    const run = tunedRun({ ...t, stoppedBy: 'launches', limitSeconds: undefined, combinations: t.combinations!.map((c) => ({ ...c, partial: 'launches' as const })) });
    open(run);
    expect(await screen.findAllByText('Misurata in parte (troppe prove)')).toBeTruthy();
    expect(screen.getByText('Ho fatto 3 prove. Con «Accurata» provo più combinazioni.')).toBeTruthy();
  });
});

describe('capacity notes', () => {
  const f = createFormatters('it');
  const base = { kvType: 'f16' as const, inferred: false };
  it('"Limite trovato" against "Almeno …" (the estimate, the time), and the older runs', () => {
    expect(capacityNote({ ...base, measuredMax: 128 * K, predictedMax: 247_552, bound: 'estimate' }, f)).toBe('Almeno 128K: oltre non provato (la stima arriva a 241,8K).');
    expect(capacityNote({ ...base, measuredMax: 128 * K, bound: 'budget', failedAt: 240 * K }, f)).toBe('Almeno 128K: oltre non provato (tempo finito).');
    expect(capacityNote({ ...base, measuredMax: 128 * K }, f)).toBe('Misurato avviando il motore.');
    expect(capacityNote({ ...base, measuredMax: 128 * K, skipped: 'budget' }, f)).toBe('Non provata: tempo finito.');
    expect(capacityNote({ ...base, skipped: 'estimate' }, f)).toBe('Non provata: la stima della memoria la escludeva.');
    expect(capacityNote(base, f)).toBe('Nessun contesto è entrato tutto nella memoria video.');
  });

  it('the capacity table says "almeno" when larger contexts were left untried', async () => {
    const t = outOfTime();
    open(tunedRun({ ...t, capacity: [{ kvType: 'f16', predictedMax: 247_552, measuredMax: 128 * K, inferred: false, bound: 'estimate' }] }));
    const capacity = await screen.findByRole('region', { name: 'Contesto massimo per tipo di cache' });
    expect(within(capacity).getByText('almeno 128K')).toBeTruthy();
  });

  it('estimates read the way people say them', () => {
    expect(roughDuration(0.2)).toBe('1 s');
    expect(roughDuration(45)).toBe('45 s');
    expect(roughDuration(2062)).toBe('34 min');
    expect(roughDuration(5400)).toBe('1 h 30 min');
  });
});
