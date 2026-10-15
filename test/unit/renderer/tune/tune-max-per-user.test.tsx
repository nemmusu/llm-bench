/**
 * "Più utenti" with the context per user "Massimo" (or one typed in "Altro…") in the UI: the options,
 * the live screen, the result (the largest context each user had per cache, the ranking), the presets
 * made from it and the comparison.
 */
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ConcurrencyPoint, RunResult, Tuning } from '../../../../src/contract/results';
import { tunePicks } from '../../../../src/contract/tune-picks';
import { phaseKey } from '../../../../src/renderer/components/bench/phases';
import { compareRows, itemOf } from '../../../../src/renderer/components/compare/compare-model';
import { TunePresetList } from '../../../../src/renderer/components/presets/tune-presets';
import { launchPerUser, stageText } from '../../../../src/renderer/components/tune/tune-format';
import { TuneLive } from '../../../../src/renderer/components/tune/tune-live';
import { perUserContextOf, rankUsers } from '../../../../src/renderer/components/tune/tune-logic';
import { parsePerUserContext, perUserSegment, TuneOptions, type TuneRequest } from '../../../../src/renderer/components/tune/tune-options';
import { perKvList, usersSummary } from '../../../../src/renderer/components/tune/tune-users';
import { createFormatters } from '../../../../src/renderer/i18n';
import { seededRuns } from '../bench/fixtures';
import { benchApi } from '../bench/world';
import { renderApp, renderUi } from '../helpers';
import { attempt, combo, params, stat, tunedRun } from './tune-fixtures';

vi.mock('echarts/core', () => ({ use: vi.fn(), init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })) }));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({ AxisPointerComponent: {}, DataZoomComponent: {}, GridComponent: {}, LegendComponent: {}, MarkAreaComponent: {}, MarkLineComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

beforeAll(() => {
  Object.assign(Element.prototype, { hasPointerCapture: () => false, releasePointerCapture: () => undefined, scrollIntoView: () => undefined });
});

const it_ = createFormatters('it');
const en = createFormatters('en');
const h1 = (name: string | RegExp) => screen.findByRole('heading', { level: 1, name });
const label = () => ({ text: 'x', parts: ['x'] });

/** Two users at once, each at `perUser` tok/s, each prompt filling `ctx` tokens. */
function two(perUser: number, ctx: number, over: Partial<ConcurrencyPoint> = {}): ConcurrencyPoint {
  return {
    level: 2,
    requests: 2,
    aggregateTps: perUser * 2,
    perRequestDecodeTpsP50: perUser,
    perRequestDecodeTps: stat(perUser, 0.02, 2),
    ttftP50Ms: 400,
    ttftP95Ms: 500,
    errors: 0,
    promptTokens: ctx - 144,
    outputTokens: 128,
    ...over,
  };
}

/** "Massimo" with 2 users on llama.cpp: q4_0 32K each (recommended), q8_0 16K each (faster), f16 8K each. */
function maxTuning(over: Partial<Tuning> = {}): Tuning {
  const each = (kv: 'f16' | 'q8_0' | 'q4_0', perUser: number, tps: number) =>
    combo(kv, 2 * perUser, [], {
      params: params({ kvCacheType: kv, flashAttention: 'on', contextSize: 2 * perUser, parallel: 2 }),
      kvLayout: 'unified',
      perUserContext: perUser,
      concurrency: [two(tps, perUser)],
      sessions: [],
    });
  return {
    budget: 'fast',
    goal: 'multi',
    multi: { users: 2, perUserContext: 'max', outputTokens: 128, turns: 3 },
    maxLaunches: 24,
    dimensions: [{ key: 'kv', values: ['f16', 'q8_0', 'q4_0'] }],
    capacity: [
      { kvType: 'f16', predictedMax: 16384, measuredMax: 8192, inferred: false, bound: 'found', failedAt: 16384 },
      { kvType: 'q8_0', predictedMax: 32768, measuredMax: 16384, inferred: false, bound: 'found', failedAt: 24576 },
      { kvType: 'q4_0', predictedMax: 40960, measuredMax: 32768, inferred: false, bound: 'found', failedAt: 40960 },
    ],
    depths: [],
    attempts: [attempt('capacity', 'f16', 81920, 'oom', { params: params({ contextSize: 81920, parallel: 2 }) })],
    combinations: [each('q4_0', 32768, 40), each('f16', 8192, 70), each('q8_0', 16384, 60)],
    recommended: 0,
    fastestByDepth: [],
    ...over,
  };
}

function maxRun(over: Partial<Tuning> = {}): RunResult {
  const run = tunedRun();
  const t = maxTuning(over);
  const rec = t.recommended === undefined ? undefined : t.combinations[t.recommended];
  return { ...run, tuning: t, metrics: { ...run.metrics, concurrency: rec?.concurrency ?? [], sessions: [] } };
}

/** TuneOptions that keeps what it is told (like the Benchmark page), with every change recorded. */
function Options({ start, changes, trained }: { start: TuneRequest; changes: TuneRequest[]; trained?: number }) {
  const [value, setValue] = useState(start);
  return (
    <TuneOptions
      value={value}
      onChange={(v) => {
        changes.push(v);
        setValue(v);
      }}
      expert={false}
      trainedContext={trained}
    />
  );
}

describe('the context per user: "Massimo" and "Altro…"', () => {
  it('a typed context: tokens or K, from 1K to the model’s context', () => {
    expect(['98304', '96K', ' 96 k ', '98.304', '1024', '1023', '0K', '1,5K', 'x', '', '200K'].map((s) => parsePerUserContext(s, 131072))).toEqual([
      98304,
      98304,
      98304,
      98304,
      1024,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    // Without the model's context: up to what the request accepts.
    expect(parsePerUserContext('1024K')).toBe(1_048_576);
    expect(parsePerUserContext('1025K')).toBeUndefined();
    expect([8192, 'max' as const, 20000].map(perUserSegment)).toEqual(['8192', 'max', 'other']);
  });

  it('"Massimo" is a choice with its own words; "Altro…" opens a box that checks what is typed', async () => {
    const changes: TuneRequest[] = [];
    renderUi(<Options start={{ budget: 'fast', fidelity: false, goal: 'multi', users: 2, perUserContext: 8192 }} changes={changes} trained={131072} />);
    const group = screen.getByRole('radiogroup', { name: 'Contesto per utente (token)' });
    expect(within(group).getAllByRole('radio').map((r) => r.textContent)).toEqual(['Massimo', '4K', '8K', '16K', '32K', 'Altro…']);
    await userEvent.click(within(group).getByRole('radio', { name: 'Massimo' }));
    expect(changes.at(-1)).toMatchObject({ goal: 'multi', users: 2, perUserContext: 'max' });
    expect(screen.getByText(/Per ogni cache KV cerco il contesto più grande che può avere ognuno dei 2 utenti/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Che cos’è «Massimo»?' }));
    expect((await screen.findAllByText(/Ogni cache KV ha il suo massimo: le più compatte arrivano più in là/)).length).toBeGreaterThan(0);
    // "Altro…" from "Massimo": the box starts from 8K, the request with it.
    await userEvent.click(within(group).getByRole('radio', { name: 'Altro…' }));
    const box = screen.getByRole('textbox', { name: 'Contesto per utente a tua scelta' });
    expect((box as HTMLInputElement).value).toBe('8192');
    expect(changes.at(-1)).toMatchObject({ perUserContext: 8192 });
    expect(screen.getByText('Da 1K a 128K (131.072 token, il contesto del modello): scrivi i token (98304) o i K (96K).')).toBeTruthy();
    await userEvent.clear(box);
    await userEvent.type(box, '96K');
    expect(changes.at(-1)).toMatchObject({ perUserContext: 98304 });
    expect(box.getAttribute('aria-invalid')).toBeNull();
    // Past the model's context: said, and the request keeps the last good value.
    await userEvent.clear(box);
    await userEvent.type(box, '200K');
    expect(box.getAttribute('aria-invalid')).toBe('true');
    expect(changes.at(-1)).toMatchObject({ perUserContext: 98304 });
    // A size from the list again: the box goes away.
    await userEvent.click(within(group).getByRole('radio', { name: '16K' }));
    expect(changes.at(-1)).toMatchObject({ perUserContext: 16384 });
    expect(screen.queryByRole('textbox', { name: 'Contesto per utente a tua scelta' })).toBeNull();
    // From a typed size: "Altro…" keeps it.
    await userEvent.click(within(group).getByRole('radio', { name: 'Altro…' }));
    expect((screen.getByRole('textbox', { name: 'Contesto per utente a tua scelta' }) as HTMLInputElement).value).toBe('16384');
  });

  it('a size of its own is shown in "Altro…"; without the model’s context the box says from 1K up; in English too', () => {
    renderUi(<TuneOptions value={{ budget: 'fast', fidelity: false, goal: 'multi', users: 4, perUserContext: 20000 }} onChange={() => undefined} expert={false} />);
    expect(screen.getByRole('radio', { name: 'Altro…' }).getAttribute('aria-checked')).toBe('true');
    expect((screen.getByRole('textbox', { name: 'Contesto per utente a tua scelta' }) as HTMLInputElement).value).toBe('20000');
    expect(screen.getByText('Da 1K in su: scrivi i token (98304) o i K (96K).')).toBeTruthy();
  });

  it('English: Maximum and Other…', async () => {
    renderUi(<TuneOptions value={{ budget: 'fast', fidelity: false, goal: 'multi', users: 4, perUserContext: 'max' }} onChange={() => undefined} expert={false} trainedContext={40960} />, { lang: 'en' });
    expect(screen.getByRole('radio', { name: 'Maximum' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText(/For each KV cache I look for the largest context each of the 4 users can have/)).toBeTruthy();
    await userEvent.click(screen.getByRole('radio', { name: 'Other…' }));
    expect(screen.getByText('From 1K to 40K (40,960 tokens, the model’s context): type the tokens (98304) or the K (96K).')).toBeTruthy();
  });
});

describe('"Massimo": result page', () => {
  it('how much context each user can have, per cache; the largest first in the ranking, then the speed', async () => {
    const run = maxRun();
    renderApp(`/results/${run.id}`, benchApi({ runs: [...seededRuns(), run] }));
    await h1(/Qwen3 8B/);
    expect(screen.getByText(/^Con 2 utenti insieme ognuno può avere fino a 32K di contesto; con quel contesto la più veloce per utente è .+\. Il contesto più grande a testa, per cache: f16 8K, q8_0 16K, q4_0 32K\./)).toBeTruthy();
    const rec = screen.getByRole('region', { name: 'Combinazione consigliata' });
    expect(within(rec).getByText(/^32[.,]?768 token$/)).toBeTruthy();
    await userEvent.click(within(rec).getByRole('button', { name: 'Che cos’è «Consigliata»?' }));
    expect((await screen.findAllByText(/quella che dà a ognuno il contesto più grande/)).length).toBeGreaterThan(0);
    expect(screen.getByText(/^Ordinata per contesto per utente, dal più grande/)).toBeTruthy();
    const table = screen.getByRole('table', { name: 'Classifica delle configurazioni con 2 utenti' });
    const rows = within(table).getAllByRole('row').slice(1);
    // q4_0 32K, q8_0 16K, f16 8K: the context per user column says each one's.
    expect(rows.map((r) => within(r).getAllByRole('cell').find((c) => /^\d{1,2}[.,]\d{3}$/.test(c.textContent ?? ''))?.textContent)).toEqual(['32.768', '16.384', '8.192']);
  });

  it('the sentence when nothing served the users, or fewer fitted', () => {
    const none = maxTuning({ combinations: [], recommended: undefined, capacity: [] });
    expect(usersSummary(none, [], 'llamacpp-native', label, it_)).toBe('Nessuna configurazione ha servito 2 utenti insieme, nemmeno con il contesto più piccolo a testa: guarda le prove scartate qui sotto.');
    expect(usersSummary(none, [], 'llamacpp-native', label, en)).toBe('No configuration served 2 users at once, not even with the smallest context each: see the discarded attempts below.');
    // 16 asked, 3 fitted with 4K each.
    const fewer = maxTuning({ multi: { users: 16, perUserContext: 'max', outputTokens: 128, turns: 3, fittingUsers: 3 }, capacity: [{ kvType: 'q4_0', measuredMax: 4096, inferred: false }], combinations: [], recommended: undefined });
    expect(usersSummary(fewer, [], 'llamacpp-native', label, it_)).toBe(
      'Con 4K a testa ci stanno al massimo 3 utenti (ne avevi chiesti 16): le misure sono con 3. Nessuna configurazione ha servito 3 utenti insieme, nemmeno con il contesto più piccolo a testa: guarda le prove scartate qui sotto.',
    );
    const t = maxTuning({ multi: { users: 16, perUserContext: 'max', outputTokens: 128, turns: 3, fittingUsers: 2 } });
    // The most that fitted: no list per cache (every one had the smallest context).
    expect(usersSummary(t, rankUsers(t), 'llamacpp-native', label, en)).toMatch(
      /^With 32K each, at most 2 users fit \(you asked for 16\): the measurements are with 2\. With 2 users at once each one can have up to 32K of context; at that context the fastest per user is x\. (?!The largest)/,
    );
  });

  it('ranking logic: the largest context per user first, then the users’ rule; a context said by the combination wins over its points', () => {
    const t = maxTuning({ recommended: undefined });
    expect(rankUsers(t).map((r) => r.combo.perUserContext)).toEqual([32768, 16384, 8192]);
    // Without "Massimo": by speed only.
    expect(rankUsers({ ...t, multi: { ...t.multi!, perUserContext: 8192 } }).map((r) => r.combo.kvType)).toEqual(['f16', 'q8_0', 'q4_0']);
    const row = { combo: t.combinations[0]!, users: two(40, 32768, { contextPerUser: 65536 }) };
    expect(perUserContextOf(row)).toBe(32768);
    expect(perUserContextOf({ combo: { ...row.combo, perUserContext: undefined }, users: row.users })).toBe(65536);
    expect(perKvList({ capacity: [] }, it_)).toBeUndefined();
  });
});

describe('"Massimo": the live screen', () => {
  it('the phase, the launch in progress and the capacity are said per user', () => {
    expect(phaseKey('tune-capacity', { goal: 'multi', perUserMax: true })).toBe('tune.phases.usersCapacityMax');
    expect(phaseKey('tune-capacity', { goal: 'multi', perUserMax: false })).toBe('tune.phases.usersCapacity');
    expect([launchPerUser('llamacpp-native', 65536, 2), launchPerUser('ninfer-wsl', 65536, 2), launchPerUser('vllm-docker', 25600, 2), launchPerUser('sglang-native', 8192, 4), launchPerUser('trtllm-docker', 8192, 4), launchPerUser('command', 8192, undefined)]).toEqual([
      32768, 32768, 25600, 8192, 8192, 8192,
    ]);
    const a = attempt('capacity', 'q8_0', 32768, 'ok', { params: params({ contextSize: 32768, parallel: 2 }) });
    expect(stageText(a, 'llamacpp-native', label, it_, 'multi', true)).toBe('Cerco il contesto più grande per utente con cache q8_0: provo 16K a testa per 2 utenti…');
    expect(stageText(a, 'llamacpp-native', label, en, 'multi', true)).toBe('Looking for the largest context per user with q8_0 cache: trying 16K each for 2 users…');
    expect(stageText({ ...a, params: params({ contextSize: 32768 }) }, 'llamacpp-native', label, it_, 'multi', true)).toMatch(/provo 32K a testa per 1 utenti/);
    // Its screenings and the fixed context per user keep their words.
    expect(stageText({ ...a, stage: 'sweep' }, 'llamacpp-native', label, it_, 'multi', true)).toMatch(/^Misuro gli utenti insieme/);
    expect(stageText(a, 'llamacpp-native', label, it_, 'multi')).toBe('Controllo se con cache q8_0 ci stanno tutti gli utenti: provo 32K in tutto…');
    const t = maxTuning({ capacity: [{ kvType: 'f16', predictedMax: 16384, measuredMax: 8192, inferred: false }, { kvType: 'q8_0', predictedMax: 32768, inferred: false }], combinations: [], recommended: undefined });
    renderUi(<TuneLive tuning={t} current={{ ...a, stage: 'capacity' }} engineKind="llamacpp-native" />);
    const card = screen.getByRole('heading', { name: 'Contesto massimo per utente, per cache' }).closest('div')!.parentElement!;
    expect(within(card).getByText('8K a testa')).toBeTruthy();
    expect(within(card).getByText('provo 16K a testa…')).toBeTruthy();
    expect(within(card).getByText(/32K a testa/)).toBeTruthy();
  });
});

describe('"Massimo": presets and comparison', () => {
  it('the presets say how many users and the context of each', async () => {
    const run = maxRun();
    const picks = tunePicks(run.tuning!);
    expect(picks[0]).toMatchObject({ ids: ['max-context'], users: 2, perUserContext: 32768, maxContext: 65536 });
    // A search that measured fewer users: those; a one-user search: none.
    expect(tunePicks({ ...run.tuning!, multi: { ...run.tuning!.multi!, users: 8, fittingUsers: 2 } })[0]).toMatchObject({ users: 2 });
    expect(tunePicks(tunedRun().tuning!)[0]!.perUserContext).toBeUndefined();
    // A "Più utenti" run from before the context per user was recorded: the launch's context.
    const old = tunePicks({ ...run.tuning!, combinations: run.tuning!.combinations.map((c) => ({ ...c, perUserContext: undefined })) });
    expect(old[0]!.users).toBeUndefined();
    renderUi(<TunePresetList presets={{ run: { id: run.id, createdAt: run.createdAt }, picks: [...picks, old[0]!] }} onUse={() => undefined} />);
    expect(screen.getByText(/2 utenti da 32K a testa/)).toBeTruthy();
    expect(screen.getByText(/contesto 64K/)).toBeTruthy();
  });

  it('the comparison has a row for the context per user', () => {
    const run = maxRun();
    const items = [itemOf(run, { runId: run.id, combo: 0 }), itemOf(run, { runId: run.id, combo: 2 })];
    const row = compareRows(items, undefined, it_).find((r) => r.id === 'perUserContext')!;
    expect(row).toMatchObject({ label: 'Contesto per utente (token)', values: [32768, 16384], best: [0] });
    expect(row.format(32768)).toBe('32.768 token');
    expect(compareRows(items, undefined, en).find((r) => r.id === 'perUserContext')!.context).toBe('what each user has with all of them at once, in the “Several users” search');
    // Nothing to say for one-user runs.
    expect(compareRows([itemOf(tunedRun())], undefined, it_).some((r) => r.id === 'perUserContext')).toBe(false);
  });
});
