/**
 * The user's NInfer search across the app: every speed of a one-user search read at its largest
 * context with the context full, said as such (Results, Configurazioni, Confronta, the live screen).
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { RunResult } from '../../../../src/contract/results';
import { renderApp } from '../helpers';
import { attempt, point, tuning } from '../tune/tune-fixtures';
import { IDS, seeded, summaries } from './fixtures';
import { K, ninferTune, ninferTuneFull, tuneSummary } from './full-context-fixtures';
import { activeRun, benchApi } from './world';

vi.mock('echarts/core', () => ({ use: vi.fn(), init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })) }));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({ AxisPointerComponent: {}, DataZoomComponent: {}, GridComponent: {}, LegendComponent: {}, MarkAreaComponent: {}, MarkLineComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

beforeAll(() => {
  Object.assign(Element.prototype, { hasPointerCapture: () => false, releasePointerCapture: () => undefined, scrollIntoView: () => undefined });
});

async function choose(combobox: string, option: string | RegExp) {
  const trigger = screen.getByRole('combobox', { name: combobox });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
  fireEvent.click(await screen.findByRole('option', { name: option }));
}

const MODEL = /Qwen3\.8-27B-Coder390/;
const rowOf = (table: HTMLElement, text: RegExp) => within(table).getAllByRole('row').find((r) => text.test(r.textContent ?? ''))!;

describe('Risultati: a search reads its speeds where the Contesto column says', () => {
  it('"a 256K di contesto" with the context full; stopped earlier: its depth, marked, why on hover; other tests as before', async () => {
    const full = ninferTuneFull();
    const short = { ...ninferTune(), id: '01M4X46BTJW9EH2YHE32Q7SHRT', createdAt: '2026-10-13T11:54:04.558Z' };
    const api = benchApi({ runs: [full, short] });
    api.world.routes['GET /api/runs'] = () => [tuneSummary(full, true), tuneSummary(short, false), ...summaries()];
    renderApp('/results', api);
    const [fullRow, shortRow] = (await screen.findAllByRole('link', { name: MODEL })).map((a) => a.closest('tr')!);
    expect(within(fullRow!).getByText('80,1')).toBeTruthy();
    const at256 = within(fullRow!).getAllByText('a 256K di contesto');
    expect(at256).toHaveLength(2);
    expect(at256.every((e) => e.className.includes('text-fg-3') && !e.hasAttribute('title'))).toBe(true);
    expect(within(fullRow!).getByText('262.144')).toBeTruthy();
    const at64 = within(shortRow!).getAllByText('a 63,8K di contesto');
    expect(at64).toHaveLength(2);
    expect(at64[0]!.className).toContain('text-warning-text');
    expect(at64[1]!.getAttribute('title')).toBe('Misurata con il contesto riempito a 63,8K: la ricerca si è fermata prima di riempire il contesto massimo, 256K.');
    // A normal test keeps its own meaning: the headline prompt and the longest one.
    const mistral = screen.getByRole('link', { name: /Mistral Small/ }).closest('tr')!;
    expect(within(mistral).getByText('a 512 token di contesto').className).toContain('text-fg-3');
  });
});

describe('Configurazioni: "Contesto massimo" first', () => {
  /** The NInfer search (rk8v4 full at 256K), and an OpenAI server whose context is not known. */
  function world() {
    const quick = seeded(IDS.quick);
    const external: RunResult = {
      ...quick,
      id: '01K6ZE2B3C4D5E6F7G8H9J0KMN',
      model: { ...quick.model, weakKey: 'remote', displayName: 'Remote Llama' },
      engine: { kind: 'external', name: 'OpenAI server', version: '1' },
      launch: { ...quick.launch, argv: [], params: { extraArgs: [], env: {} } },
    };
    // A second server measured only how fast it reads (no generation speed).
    const reading: RunResult = structuredClone(external);
    reading.id = '01K6ZE2B3C4D5E6F7G8H9J0KMP';
    reading.model = { ...reading.model, weakKey: 'remote-2', displayName: 'Remote Phi' };
    reading.metrics.latency = reading.metrics.latency.map((p) => ({ ...p, decodeTps: { ...p.decodeTps, n: 0 } }));
    return benchApi({ runs: [ninferTuneFull(), external, reading] });
  }

  it('each configuration at its own context full; the others say where they were not measured and sink; any depth for all', async () => {
    renderApp('/results?view=configs', world());
    const table = await screen.findByRole('table', { name: 'Configurazioni provate' });
    expect(screen.getByRole('combobox', { name: 'Confronta a' }).textContent).toContain('Contesto massimo');
    expect(screen.getByRole('columnheader', { name: /Generazione/ }).textContent).toBe('Generazione(tok/s) al contesto massimo');
    expect(screen.getByRole('columnheader', { name: /Lettura prompt/ }).textContent).toBe('Lettura prompt(tok/s) al contesto massimo');
    const rows = within(table).getAllByRole('row').slice(1);
    // rk8v4 filled its 256K: on top, with its numbers there.
    expect(rows[0]!.textContent).toMatch(/rk8v4.*262\.144.*80,1/);
    expect(within(rowOf(table, /nvfp4/)).getByText('non misurata a 256K')).toBeTruthy();
    expect(within(rowOf(table, /bf16/)).getByText('non misurata a 64K')).toBeTruthy();
    expect(within(rowOf(table, /int8/)).getByText('non misurata a 128K')).toBeTruthy();
    // A server whose context is not known: the deepest it measured, said under the number.
    expect(within(rowOf(table, /Remote Llama/)).getByText('a 512 token di contesto')).toBeTruthy();
    expect(within(rowOf(table, /Remote Phi/)).getByText('non misurata a 512 token')).toBeTruthy();
    expect(rows.at(-1)!.textContent).not.toMatch(/rk8v4/);

    // The tests behind rk8v4 and nvfp4, each with its own context full.
    await userEvent.click(within(rowOf(table, /rk8v4/)).getByRole('button', { name: /^Mostra il test di/ }));
    let dialog = await screen.findByRole('dialog', { name: 'Test di questa configurazione' });
    expect(within(dialog).getByRole('columnheader', { name: /Generazione al contesto massimo/ })).toBeTruthy();
    expect(within(dialog).getByText('80,1')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Chiudi' }));
    await userEvent.click(within(rowOf(table, /nvfp4/)).getByRole('button', { name: /^Mostra il test di/ }));
    dialog = await screen.findByRole('dialog', { name: 'Test di questa configurazione' });
    expect(within(dialog).getByText('non misurata a 256K')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Chiudi' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // One depth for all: 64K, where rk8v4 and nvfp4 both measured.
    await choose('Confronta a', '64K token');
    expect(screen.getByRole('columnheader', { name: /Generazione/ }).textContent).toBe('Generazione(tok/s) a 64K');
    expect(within(rowOf(table, /nvfp4/)).getByText('74,7')).toBeTruthy();
    expect(within(rowOf(table, /bf16/)).getByText('non misurata a 64K')).toBeTruthy();
    await userEvent.click(within(rowOf(table, /nvfp4/)).getByRole('button', { name: /^Mostra il test di/ }));
    dialog = await screen.findByRole('dialog', { name: 'Test di questa configurazione' });
    expect(within(dialog).getByRole('columnheader', { name: /Generazione a 64K/ })).toBeTruthy();
    expect(within(dialog).getByText('74,7')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Chiudi' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // And back to each one's own context full.
    await choose('Confronta a', 'Contesto massimo');
    expect(screen.getByRole('columnheader', { name: /Generazione/ }).textContent).toBe('Generazione(tok/s) al contesto massimo');
  });
});

describe('Confronta: two combinations full at 256K', () => {
  it('start there, the depth said in every sentence, the option says the context is full', async () => {
    const a = ninferTuneFull();
    const b = ninferTuneFull('01M4X46BTJW9EH2YHE32Q7FUL2');
    b.createdAt = '2026-10-15T09:00:00.000Z';
    b.tuning!.combinations[2]!.sweep[2] = point(255_000, 70, 2300, 110_000);
    renderApp(`/compare?ids=${a.id}~2,${b.id}~2`, benchApi({ runs: [a, b] }));
    expect(await screen.findByText(/^Scrive più in fretta A · /)).toBeTruthy();
    expect(screen.getByText(/80,1 tok\/s \(scrittura con 262\.144 token già nel contesto\)/)).toBeTruthy();
    const select = screen.getByRole('combobox', { name: 'Confronta a' });
    expect(select.textContent).toContain('256K');
    select.focus();
    fireEvent.keyDown(select, { key: 'Enter' });
    expect((await screen.findByRole('option', { name: /256K/ })).textContent).toContain('misurato da tutti, con il contesto pieno');
    expect(screen.getByRole('option', { name: /^1K/ }).textContent).toContain('misurato da tutti');
  });
});

describe('live screen of a search: when the context is full', () => {
  it('the attempts say where each speed was measured; the final sweep says when it fills the context', async () => {
    const RUN = '01M48PNN41KKD0ABVXTGK97Y6Q';
    const scenario = { profile: 'tune' as const, seed: 42, steps: [{ kind: 'context-sweep' as const, depths: [], fractions: false, outputTokens: 128, reps: 2 }] };
    const api = benchApi({ active: activeRun(RUN, { profile: 'tune', scenario, phase: 'context-sweep', progress: 0.8 }) });
    renderApp(`/run/${RUN}`, api);
    await screen.findByText('Prove fatte');
    const t = tuning();
    const done = [
      attempt('capacity', 'q4_0', 64 * K, 'ok', { points: [point(K, 81, 9000)] }),
      attempt('variant', 'q4_0', 64 * K, 'ok', { points: [point(K, 80, 9800), point(32 * K, 68, 8000)] }),
      attempt('sweep', 'q4_0', 64 * K, 'ok', { points: [point(K, 80, 9800), point(64 * K - 144, 60, 6400)] }),
    ];
    const current = { ...attempt('sweep', 'q4_0', 64 * K, 'ok'), atMs: 5000 } as Record<string, unknown>;
    delete current.outcome;
    act(() => api.emit({ type: 'run.tune', runId: RUN, tuning: { ...t, attempts: done }, current: current as never }));
    const rows = within(screen.getByRole('table', { name: 'Prove fatte' })).getAllByRole('row').slice(1);
    expect(rows[1]!.textContent).toMatch(/60,0a 64K, contesto pieno$/);
    expect(rows[2]!.textContent).toMatch(/68,0a 32K di contesto$/);
    // The 1K check after the start: said once, in the column's header.
    expect(rows[3]!.textContent).toMatch(/Cache KV q4_0 · flash attention–81,0$/);

    // The sweep's deepest point: the line of what is measured now, its row and the gauges say the context is full.
    act(() => api.emit({ type: 'run.step', runId: RUN, current: { kind: 'context-sweep', depth: 64 * K - 144, outputTokens: 128, rep: 1, reps: 2 } }));
    expect(screen.getByText('Contesto riempito fino a 65.392 token · contesto pieno · 128 token in uscita · ripetizione 1 di 2')).toBeTruthy();
    act(() => api.emit({ type: 'run.live', runId: RUN, decodeTps: 60.2, prefillTps: 6400, ttftMs: 10_000 }));
    expect(screen.getAllByText('contesto pieno: 65.392 token')).toHaveLength(2);
    act(() => api.emit({ type: 'run.point', runId: RUN, live: { stepKind: 'context-sweep', point: point(64 * K - 144, 60.2, 6400), attempt: 3 } }));
    const measures = screen.getByRole('table', { name: 'Prova in corso' });
    expect(within(measures).getAllByRole('row')[1]!.firstElementChild!.textContent).toBe('65.392 · contesto pieno');
    // A shallower depth: as before.
    act(() => api.emit({ type: 'run.step', runId: RUN, current: { kind: 'context-sweep', depth: 32 * K, outputTokens: 128, rep: 1, reps: 2 } }));
    expect(screen.getByText('Contesto riempito fino a 32.768 token · 128 token in uscita · ripetizione 1 di 2')).toBeTruthy();
  });
});
