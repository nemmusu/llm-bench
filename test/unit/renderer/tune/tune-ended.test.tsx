/**
 * "Trova le impostazioni migliori" that ends early or meets a launch that spills: the live screen's
 * gauges per launch, a launch given up as too slow, and the words of a cancelled (or failed) search —
 * the bug report's run on an RTX 5090: the reference at 4K measured, f16 at 240K stuck, cancelled.
 */
import { act, screen, within } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { RunResult, Scenario, TuneAttempt, Tuning } from '../../../../src/contract/results';
import { capacitySentence, discardReason, outcomeText } from '../../../../src/renderer/components/tune/tune-format';
import { withRunEnd } from '../../../../src/renderer/components/tune/tune-logic';
import { capacityNote } from '../../../../src/renderer/components/tune/tune-sections';
import { createFormatters } from '../../../../src/renderer/i18n';
import { renderApp } from '../helpers';
import { seededRuns } from '../bench/fixtures';
import { activeRun, benchApi } from '../bench/world';
import { attempt, combo, point, tunedRun } from './tune-fixtures';

vi.mock('echarts/core', () => ({ use: vi.fn(), init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })) }));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({ AxisPointerComponent: {}, DataZoomComponent: {}, GridComponent: {}, LegendComponent: {}, MarkAreaComponent: {}, MarkLineComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

beforeAll(() => {
  Object.assign(Element.prototype, { hasPointerCapture: () => false, releasePointerCapture: () => undefined, scrollIntoView: () => undefined });
});

const K = 1024;
const BORDER = 245_760;
const RUN = '01M48PNN41KKD0ABVXTGK97Y6P';
const f = createFormatters('it');
const h1 = (name: string | RegExp) => screen.findByRole('heading', { level: 1, name });
const TUNE_SCENARIO: Scenario = { profile: 'tune', seed: 42, steps: [{ kind: 'context-sweep', depths: [], fractions: false, outputTokens: 128, reps: 2 }] };

/** The reference of the bug report: f16 at 4K, 53,4 tok/s, prompt reading 2 142 tok/s, 18,4 GB. */
const reference = attempt('reference', 'f16', 4 * K, 'ok', { atMs: 0, vramPeakMiB: 18_842, sharedPeakMiB: 124, points: [{ ...point(K, 53.4, 2142), outputTokens: 32 }] });
const pending = (a: TuneAttempt) => {
  const { outcome: _o, ...rest } = a;
  return rest;
};
const capacity: Tuning['capacity'] = [
  { kvType: 'f16', predictedMax: 247_552, inferred: false },
  { kvType: 'q8_0', predictedMax: 262_144, inferred: false },
  { kvType: 'q4_0', predictedMax: 262_144, inferred: false },
];

describe('the live screen, launch by launch', () => {
  it('the speed gauges wait for each launch’s first measurement; a launch given up as too slow shows at once, with why', async () => {
    const api = benchApi({ active: activeRun(RUN, { profile: 'tune', scenario: TUNE_SCENARIO, phase: 'tune-capacity', progress: 0.1 }) });
    renderApp(`/run/${RUN}`, api);
    await screen.findByText('Prove fatte');
    const decode = () => screen.getByRole('meter', { name: 'Generazione' });
    const prefill = () => screen.getByRole('meter', { name: 'Lettura prompt' });
    expect(decode().textContent).toContain('in attesa della prima misura');
    expect(prefill().textContent).toContain('in attesa della prima misura');

    // The reference's probe.
    const base: Tuning = { ...tunedRun().tuning!, attempts: [], combinations: [], recommended: undefined, fastestByDepth: [], capacity };
    act(() => api.emit({ type: 'run.tune', runId: RUN, tuning: base, current: pending(reference) as never }));
    act(() => api.emit({ type: 'run.live', runId: RUN, ttftMs: 480, tokens: 32, decodeTps: 53.4, prefillTps: 2142 }));
    expect(decode().getAttribute('aria-valuetext')).toBe('53,4 tok/s');
    expect(decode().textContent).not.toContain('in attesa');
    // The same launch again (a later update of the search): the numbers stay.
    act(() => api.emit({ type: 'run.tune', runId: RUN, tuning: base, current: pending(reference) as never }));
    expect(decode().getAttribute('aria-valuetext')).toBe('53,4 tok/s');

    // The next launch (240K): nothing measured on it yet, so nothing stale on the gauges.
    const border = attempt('capacity', 'f16', BORDER, 'ok', { atMs: 11_000 });
    act(() => api.emit({ type: 'run.tune', runId: RUN, tuning: { ...base, attempts: [reference] }, current: pending(border) as never }));
    expect(decode().getAttribute('aria-valuetext')).toBe('– tok/s');
    expect(decode().textContent).toContain('in attesa della prima misura');
    expect(prefill().textContent).toContain('in attesa della prima misura');

    act(() => api.emit({ type: 'run.step', runId: RUN, current: { kind: 'tune-probe', promptTokens: K, outputTokens: 32, rep: 1, reps: 1 } }));
    expect(screen.getByText('Prova rapida · Prompt di 1.024 token → 32 in uscita · ripetizione 1 di 1')).toBeTruthy();

    // Given up: past its deadline, it is in the list right away, saying why; its request is no longer "now".
    const tooSlow = { ...border, outcome: 'spill' as const, spill: 'too-slow' as const, error: { code: 'ENGINE_TIMEOUT' as const, message: 'late', params: { reason: 'deadline', ms: 30_000 } } };
    act(() => api.emit({ type: 'run.tune', runId: RUN, tuning: { ...base, attempts: [reference, tooSlow] } }));
    const rows = within(screen.getByRole('table', { name: 'Prove fatte' })).getAllByRole('row').slice(1);
    expect(rows[0]!.textContent).toContain('Troppo lento: probabilmente usa la RAM condivisa');
    expect(rows[0]!.textContent).toContain('240K');
    expect(screen.queryByText(/ripetizione 1 di 1/)).toBeNull();
  });
});

/** The bug report's run as GPU Bench 0.3.0 saved it: cancelled during the 240K probe, nothing else recorded. */
function cancelledRun(over: Partial<Tuning> = {}): RunResult {
  const run = tunedRun({ attempts: [reference], combinations: [], recommended: undefined, fastestByDepth: [], capacity, fidelity: undefined, ...over });
  return { ...run, status: 'cancelled', error: { code: 'CANCELLED', message: 'Run cancelled' } };
}

function open(run: RunResult) {
  return renderApp(`/results/${run.id}`, benchApi({ runs: [...seededRuns(), run] }));
}

describe('a search that was cancelled', () => {
  it('saved before the search said so: f16 holds at least 4K (its reference), q8_0 and q4_0 were never tried — not "nothing fit"', async () => {
    open(cancelledRun());
    await h1(/Qwen3 8B/);
    expect(screen.getByText('Test annullato prima della fine')).toBeTruthy();
    expect(screen.getByText('Ho fatto 1 prova prima che il test finisse. Qui sotto quello che avevo misurato fin lì.')).toBeTruthy();
    expect(screen.getByText('Con cache f16 arrivi almeno a 4K: la ricerca non è finita.')).toBeTruthy();
    const table = screen.getByRole('table', { name: 'Contesto massimo per tipo di cache' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]!.textContent).toContain('almeno 4K');
    expect(rows[0]!.textContent).toContain('Almeno 4K: la ricerca non è finita (test annullato).');
    expect(rows[1]!.textContent).toContain('Non provato (test annullato).');
    expect(rows[2]!.textContent).toContain('Non provato (test annullato).');
    expect(table.textContent).not.toContain('Nessun contesto');
  });

  it('as the search records it now: what was measured is "misurata in parte (test annullato)", the cut search says where it stopped', async () => {
    const partial = combo('f16', 4 * K, [{ ...point(K, 53.4, 2142), outputTokens: 32 }], { partial: 'cancelled' });
    open(
      cancelledRun({
        stoppedBy: 'cancelled',
        combinations: [partial],
        recommended: 0,
        capacity: [
          { kvType: 'f16', predictedMax: 247_552, measuredMax: 4 * K, inferred: false, bound: 'cancelled' },
          { kvType: 'q8_0', predictedMax: 262_144, inferred: false, bound: 'cancelled', failedAt: 262_144 },
          { kvType: 'q4_0', predictedMax: 262_144, inferred: false, skipped: 'cancelled' },
        ],
      }),
    );
    await h1(/Qwen3 8B/);
    const rec = screen.getByRole('region', { name: 'Combinazione consigliata' });
    expect(within(rec).getByText('Misurata in parte (test annullato)')).toBeTruthy();
    expect(screen.getByText(/^Ho fatto 1 prova prima che il test finisse\./)).toBeTruthy();
    const table = screen.getByRole('table', { name: 'Contesto massimo per tipo di cache' });
    expect(table.textContent).toContain('Ricerca non finita (test annullato): a 256K non entrava, sotto non provato.');
  });

  it('failed with an error: the same words, "interrotto"', async () => {
    open({ ...cancelledRun(), status: 'failed', error: { code: 'ENGINE_BAD_FLAG', message: 'bad flag' } });
    await h1(/Qwen3 8B/);
    expect(screen.getByText('Test interrotto da un errore')).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Contesto massimo per tipo di cache' }).textContent).toContain('Non provato (test interrotto da un errore).');
  });

  it('several launches before the error: how many', async () => {
    open({ ...cancelledRun({ attempts: [reference, attempt('capacity', 'q8_0', 256 * K, 'oom')] }), status: 'failed', error: { code: 'ENGINE_BAD_FLAG', message: 'bad flag' } });
    await h1(/Qwen3 8B/);
    expect(screen.getByText(/^Ho fatto 2 prove prima che il test finisse\./)).toBeTruthy();
  });
});

describe('the words, one by one', () => {
  it('withRunEnd: completed runs and runs that already say how they ended are left as they are', () => {
    const t = cancelledRun().tuning!;
    expect(withRunEnd(t, 'completed')).toBe(t);
    const said = { ...t, stoppedBy: 'cancelled' as const };
    expect(withRunEnd(said, 'cancelled')).toBe(said);
    const failed = { ...t, stoppedBy: 'failed' as const };
    expect(withRunEnd(failed, 'failed')).toBe(failed);
    // Known maxima and reasons stay; a type whose only launches failed is cut at the smallest one.
    const mixed = withRunEnd(
      {
        ...t,
        attempts: [reference, attempt('capacity', 'f16', BORDER, 'spill'), attempt('capacity', 'q8_0', 256 * K, 'oom'), attempt('capacity', 'q8_0', 128 * K, 'spill'), attempt('variant', 'q4_0', 64 * K, 'ok')],
        capacity: [...capacity, { kvType: 'auto', measuredMax: 8 * K, inferred: false }, { kvType: 'fp8', inferred: false, skipped: 'estimate' }],
      },
      'cancelled',
    );
    expect(mixed.stoppedBy).toBe('cancelled');
    expect(mixed.capacity.map((c) => [c.kvType, c.measuredMax, c.bound, c.failedAt, c.skipped])).toEqual([
      ['f16', 4 * K, 'cancelled', BORDER, undefined],
      ['q8_0', undefined, 'cancelled', 128 * K, undefined],
      ['q4_0', undefined, undefined, undefined, 'cancelled'],
      ['auto', 8 * K, undefined, undefined, undefined],
      ['fp8', undefined, undefined, undefined, 'estimate'],
    ]);
  });

  it('notes, outcomes and the summary sentence', () => {
    const base = { kvType: 'f16' as const, inferred: false };
    expect(capacityNote({ ...base, measuredMax: 4 * K, bound: 'failed' }, f)).toBe('Almeno 4K: la ricerca non è finita (test interrotto da un errore).');
    expect(capacityNote({ ...base, bound: 'failed', failedAt: BORDER }, f)).toBe('Ricerca non finita (test interrotto da un errore): a 240K non entrava, sotto non provato.');
    expect(capacityNote({ ...base, skipped: 'no-gain' }, f)).toBe('Non provato (non serviva): non avrebbe dato più contesto.');

    const tooSlow = attempt('capacity', 'f16', BORDER, 'spill', { spill: 'too-slow', error: { code: 'ENGINE_TIMEOUT', message: 'late', params: { reason: 'deadline', ms: 30_000 } } });
    expect(outcomeText(tooSlow, f)).toBe('Troppo lento: probabilmente usa la RAM condivisa');
    expect(outcomeText({ ...tooSlow, spill: 'shared-memory' }, f)).toBe('Usa la RAM condivisa (lento)');
    expect(discardReason(tooSlow, f)).toBe('Con contesto 240K era troppo lento: una richiesta non è finita in 30 s, molto più di quanto serviva alle altre. Probabilmente usa la RAM condivisa: l’ho fermato e ho provato meno contesto.');
    const stalled = { ...tooSlow, error: { ...tooSlow.error!, params: { reason: 'stalled', ms: 60_000 } } };
    expect(discardReason(stalled, f)).toBe('Con contesto 240K era troppo lento: il motore non ha mandato nulla per 1 min. Probabilmente usa la RAM condivisa: l’ho fermato e ho provato meno contesto.');

    // The best one cut short: only "at least"; another one cut short: no comparison with it.
    expect(capacitySentence({ capacity: [{ ...base, measuredMax: 4 * K, bound: 'cancelled' }] }, f)).toBe('Con cache f16 arrivi almeno a 4K: la ricerca non è finita.');
    expect(capacitySentence({ capacity: [{ ...base, measuredMax: 208 * K, bound: 'found' }, { kvType: 'q8_0', inferred: false, measuredMax: 128 * K, bound: 'cancelled' }] }, f)).toBe('Con cache f16 arrivi a 208K.');
  });
});
