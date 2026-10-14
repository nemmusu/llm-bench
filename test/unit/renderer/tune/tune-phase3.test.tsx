/**
 * Phase 3 of "Trova le impostazioni migliori" in the UI: the "Più utenti" goal (options, result,
 * ranking with every user busy), "Ricontrollo rapido" (offered from the plan, before / after), the
 * other-build note on the server dialog, the calibrated estimate and the prefix-cache sentence.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { RunPlan, StartRunRequest } from '../../../../src/contract/api';
import type { ConcurrencyPoint, RunResult, SessionsPoint, TuneCombination, TuneRecheck, Tuning } from '../../../../src/contract/results';
import { phaseKey, relevantPhases } from '../../../../src/renderer/components/bench/phases';
import { FitSummary } from '../../../../src/renderer/components/bench/plan-card';
import { prefixCacheSentences } from '../../../../src/renderer/components/bench/sessions-view';
import { buildLabel } from '../../../../src/renderer/components/tune/tune-format';
import {
  bestValues,
  compareUsersRows,
  noisy,
  perUserStat,
  rankUsers,
  reaches,
  sameWithinNoise,
  sortRows,
  USERS_COLUMNS,
  usersLevel,
  usersNoise,
  type RankRow,
} from '../../../../src/renderer/components/tune/tune-logic';
import { DEFAULT_TUNE, parseUsers, recheckOffered, TuneOptions, tuneRequestOf } from '../../../../src/renderer/components/tune/tune-options';
import { recheckRows, recheckSentence } from '../../../../src/renderer/components/tune/tune-recheck';
import { usersSummary } from '../../../../src/renderer/components/tune/tune-users';
import { createFormatters } from '../../../../src/renderer/i18n';
import { renderApp, renderUi } from '../helpers';
import { seededRuns } from '../bench/fixtures';
import { benchApi, planFor, serverPlanFor } from '../bench/world';
import { attempt, combo, params, point, stat, TUNE_ID, tunedRun } from './tune-fixtures';

vi.mock('echarts/core', () => ({ use: vi.fn(), init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })) }));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({ AxisPointerComponent: {}, DataZoomComponent: {}, GridComponent: {}, LegendComponent: {}, MarkAreaComponent: {}, MarkLineComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

beforeAll(() => {
  Object.assign(Element.prototype, { hasPointerCapture: () => false, releasePointerCapture: () => undefined, scrollIntoView: () => undefined });
});

const f = createFormatters('it');
const en = createFormatters('en');
const h1 = (name: string | RegExp) => screen.findByRole('heading', { level: 1, name });

/** A level with every user at `perUser` tok/s (spread 2 %), prompts of 8.048 tokens, the pool split 8K each. */
function level(n: number, perUser: number, over: Partial<ConcurrencyPoint> = {}): ConcurrencyPoint {
  return {
    level: n,
    requests: n,
    aggregateTps: perUser * n,
    perRequestDecodeTpsP50: perUser,
    perRequestDecodeTps: stat(perUser, 0.02, n),
    ttftP50Ms: 200 * n,
    ttftP95Ms: 250 * n,
    errors: 0,
    promptTokens: 8048,
    outputTokens: 128,
    contextPerUser: 8192,
    contextShared: false,
    ...over,
  };
}

function conversations(over: Partial<SessionsPoint> = {}): SessionsPoint {
  return {
    sessions: 4,
    depth: 7280,
    turns: 3,
    outputTokens: 128,
    followupTokens: 256,
    firstTurn: { ttftMs: stat(800), prefillTps: stat(9000), queueWaitMs: stat(300), decodeTps: stat(45) },
    laterTurns: { ttftMs: stat(90), cachedShare: stat(0.95), decodeTps: stat(46) },
    queueEstimated: false,
    requests: 12,
    errors: 0,
    prefixCache: { queries: 89_000, hits: 59_000, hitRate: 0.66, source: 'metrics' },
    ...over,
  };
}

const multiParams = (over: object = {}) => params({ kvCacheType: 'q8_0', flashAttention: 'on', contextSize: 32768, parallel: 4, ...over });

/** "Più utenti" 4 × 8K: q8_0 with the pool split per user (recommended), shared, q4_0 with a failed request, one without level 4. */
function multiTuning(over: Partial<Tuning> = {}): Tuning {
  const split = combo('q8_0', 32768, [], {
    params: multiParams({ ubatchSize: 2048, extraArgs: ['--no-kv-unified'] }),
    kvLayout: 'split',
    concurrency: [level(1, 60), level(2, 55), level(3, 50), level(4, 46)],
    sessions: [conversations()],
    usersWithoutErrors: 4,
    vramPeakMiB: 17400,
  });
  const shared = combo('q8_0', 32768, [], {
    params: multiParams(),
    kvLayout: 'unified',
    cacheReuse: 256,
    concurrency: [level(1, 60), level(4, 30, { contextShared: true, contextPerUser: 32768 })],
    sessions: [conversations({ prefixCache: undefined })],
  });
  const q4 = combo('q4_0', 32768, [], { params: multiParams({ kvCacheType: 'q4_0' }), kvLayout: 'split', concurrency: [level(4, 70, { errors: 1 })] });
  const partial = combo('q4_0', 32768, [], { params: multiParams({ kvCacheType: 'q4_0', ubatchSize: 512 }), concurrency: [level(1, 30)] });
  return {
    budget: 'fast',
    goal: 'multi',
    multi: { users: 4, perUserContext: 8192, promptTokens: 8048, outputTokens: 128, turns: 3 },
    maxLaunches: 24,
    dimensions: [{ key: 'kv', values: ['f16', 'q8_0', 'q4_0'] }],
    capacity: [{ kvType: 'f16', inferred: false }],
    depths: [],
    attempts: [attempt('capacity', 'f16', 32768, 'oom')],
    combinations: [split, shared, q4, partial],
    recommended: 0,
    fastestByDepth: [],
    ...over,
  };
}

function multiRun(over: Partial<Tuning> = {}): RunResult {
  const run = tunedRun();
  const t = multiTuning(over);
  const rec = t.recommended === undefined ? undefined : t.combinations[t.recommended];
  return { ...run, tuning: t, metrics: { ...run.metrics, concurrency: rec?.concurrency ?? [], sessions: rec?.sessions ?? [] } };
}

describe('"Più utenti": ranking logic', () => {
  it('per-user noise, the level measured, the order with every user busy', () => {
    const t = multiTuning();
    expect(usersLevel(t)).toBe(4);
    expect(usersLevel({ multi: { ...t.multi!, fittingUsers: 2 } })).toBe(2);
    expect(usersLevel({})).toBeUndefined();
    expect(perUserStat(level(4, 46))).toMatchObject({ median: 46, n: 4 });
    expect(perUserStat({ ...level(4, 46), perRequestDecodeTps: undefined })).toMatchObject({ median: 46, n: 1, cv: 0 });
    expect(usersNoise(level(4, 46))).toBeCloseTo(0.01, 9);
    expect(usersNoise({ ...level(4, 46), perRequestDecodeTps: undefined })).toBe(0);
    expect(noisy(10, 0.1)).toMatchObject({ median: 10, cv: 0.1, stddev: 1 });
    expect(sameWithinNoise(stat(100, 0), stat(108, 0), 0.1)).toBe(true);
    const rows = rankUsers(t);
    // The core's recommendation first, then by the rule; the one without level 4 at the bottom, unranked.
    expect(rows.map((r) => [r.index, r.rank])).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
      [3, undefined],
    ]);
    expect(rows.every((r, i) => (i < 3 ? reaches(r) : !reaches(r)))).toBe(true);
    // A failed request ranks last whatever its speed; no recommendation: the rule alone; a sweep-only combination is not a row.
    expect(rankUsers({ ...t, recommended: undefined }).map((r) => r.index)).toEqual([0, 1, 2, 3]);
    expect(rankUsers({ ...t, combinations: [...t.combinations, combo('f16', 4096, [point(1024, 90, 900)])] }).map((r) => r.index)).toEqual([0, 1, 2, 3]);
  });

  it('ties: per user, then the total, the slowest first token, the later messages, the more precise cache', () => {
    const row = (index: number, users: ConcurrencyPoint, o: { kv?: TuneCombination['kvType']; later?: number } = {}) =>
      ({ index, combo: combo(o.kv ?? 'q8_0', 1, []), users, ...(o.later !== undefined ? { sessions: conversations({ laterTurns: { ttftMs: stat(o.later), decodeTps: stat(1) } }) } : {}) }) as RankRow & { users: ConcurrencyPoint };
    expect(compareUsersRows(row(0, level(4, 50)), row(1, level(4, 40)))).toBeLessThan(0);
    expect(compareUsersRows(row(0, level(4, 50, { aggregateTps: 150 })), row(1, level(4, 50, { aggregateTps: 200 })))).toBeGreaterThan(0);
    expect(compareUsersRows(row(0, level(4, 50, { ttftP95Ms: 2000 })), row(1, level(4, 50, { ttftP95Ms: 1000 })))).toBeGreaterThan(0);
    expect(compareUsersRows(row(0, level(4, 50), { later: 300 }), row(1, level(4, 50), { later: 100 }))).toBeGreaterThan(0);
    expect(compareUsersRows(row(0, level(4, 50), { later: 100 }), row(1, level(4, 50)))).toBeLessThan(0);
    expect(compareUsersRows(row(0, level(4, 50), { kv: 'q4_0' }), row(1, level(4, 50)))).toBeGreaterThan(0);
    expect(compareUsersRows(row(1, level(4, 50)), row(0, level(4, 50)))).toBeGreaterThan(0);
    const tie = rankUsers({ multi: multiTuning().multi, combinations: [combo('q8_0', 1, [], { concurrency: [level(4, 50)] }), combo('q8_0', 1, [], { concurrency: [level(4, 50.2)] })] });
    expect(tie[1]!.tie).toBe(true);
  });

  it('columns: the best values within the noise, sorting by any column', () => {
    const rows = rankUsers(multiTuning());
    const best = bestValues(rows, USERS_COLUMNS);
    expect([...best.get('perUser')!]).toEqual([2]);
    expect([...best.get('total')!]).toEqual([2]);
    expect([...best.get('ttftP95')!]).toEqual([0, 1, 2]);
    expect([...best.keys()]).toEqual(['perUser', 'total', 'ttftP95']);
    const col = (key: string) => USERS_COLUMNS.find((c) => c.key === key);
    expect(sortRows(rows, col('perUser'), 'desc').map((r) => r.index)).toEqual([2, 0, 1, 3]);
    expect(sortRows(rows, col('vram'), 'asc').map((r) => r.index)).toEqual(expect.arrayContaining([0, 1, 2, 3]));
    expect(col('perUserContext')!.value(rows[1]!)).toBe(32768);
    // The KV layout and the cache reuse are in the configuration's words, not columns of their own.
    expect(USERS_COLUMNS.map((c) => c.key)).toEqual(['perUser', 'total', 'ttftP95', 'perUserContext', 'vram']);
  });
});

describe('"Più utenti": result page', () => {
  it('sums up with numbers, recommends the most speed per user, ranks every configuration with units in the headers', async () => {
    const run = multiRun();
    renderApp(`/results/${run.id}`, benchApi({ runs: [...seededRuns(), run] }));
    await h1(/Qwen3 8B/);
    expect(screen.getByText(/^Con 4 utenti da 8K a testa la più veloce per utente è /)).toBeTruthy();
    const rec = screen.getByRole('region', { name: 'Combinazione consigliata' });
    expect(within(rec).getByText(/contesto diviso per utente/)).toBeTruthy();
    expect(within(rec).getByText('46,0 tok/s')).toBeTruthy();
    expect(within(rec).getByText('184 tok/s')).toBeTruthy();
    expect(within(rec).getByText('1,00 s')).toBeTruthy();
    expect(within(rec).getByText(/^8[.,]?192 token$/)).toBeTruthy();
    const table = screen.getByRole('table', { name: 'Classifica delle configurazioni con 4 utenti' });
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['#', 'Configurazione', 'Per utente (tok/s)', 'In tutto (tok/s)', 'Primo token più lento', 'Contesto per utente (token)', 'VRAM picco (GB)']);
    // The KV layout and the cache reuse: said by each configuration.
    expect(within(table).getAllByText(/contesto diviso per utente/).length).toBeGreaterThan(0);
    expect(within(table).getAllByText(/contesto condiviso/).length).toBeGreaterThan(0);
    expect(screen.queryByText('Nessuna combinazione è stata misurata fino in fondo.')).toBeNull();
    // The measurements of a row: users 1 … 4 in order.
    await userEvent.click(within(table).getAllByRole('button', { name: 'Misure' })[0]!);
    expect(screen.getByRole('table', { name: /^Utenti insieme con / })).toBeTruthy();
    expect(screen.getByText(/Utenti 1, 2, 3, 4 in quest’ordine/)).toBeTruthy();
    // The conversations of the recommendation, with what the engine counted in its prefix cache.
    expect(screen.getByText(/il motore ha trovato nella sua cache del prefisso il 66% dei token dei messaggi/)).toBeTruthy();
    expect(screen.getByText('Prove scartate')).toBeTruthy();
  });

  it('fewer users fitted, nothing measured', async () => {
    const run = multiRun({ multi: { ...multiTuning().multi!, users: 8, fittingUsers: 4 }, stoppedBy: 'budget' });
    renderApp(`/results/${run.id}`, benchApi({ runs: [...seededRuns(), run] }));
    await h1(/Qwen3 8B/);
    expect(screen.getByText(/^Con 8K a testa ci stanno al massimo 4 utenti \(ne avevi chiesti 8\): le misure sono con 4\./)).toBeTruthy();
    expect(screen.getByText('Mi sono fermato prima: tempo finito')).toBeTruthy();
    const none = multiTuning({ combinations: [], recommended: undefined });
    const label = () => ({ text: 'x', parts: ['x'] });
    expect(usersSummary(none, [], 'llamacpp-native', label, f)).toBe('Nessuna configurazione ha servito 4 utenti con 8K a testa: guarda le prove scartate qui sotto.');
    const empty = multiRun({ combinations: [], recommended: undefined });
    renderApp(`/results/${empty.id}`, benchApi({ runs: [...seededRuns(), empty] }));
    expect(await screen.findByText('Nessuna combinazione è stata misurata fino in fondo.')).toBeTruthy();
  });

  it('a configuration without memory figure or per-user context, and a layout not said', async () => {
    const plain = combo('q8_0', 32768, [], { concurrency: [level(4, 40, { contextPerUser: undefined })], vramPeakMiB: undefined });
    const run = multiRun({ combinations: [plain], recommended: 0 });
    renderApp(`/results/${run.id}`, benchApi({ runs: [...seededRuns(), run] }));
    await h1(/Qwen3 8B/);
    const rec = screen.getByRole('region', { name: 'Combinazione consigliata' });
    expect(within(rec).queryByText('VRAM picco')).toBeNull();
    expect(within(rec).queryByText('Contesto per utente')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Misure' }));
    // Measured with 4 users only: said so, never "1, 2, … 4".
    expect(screen.getByText(/^Solo 4 utenti insieme, un messaggio a testa\. · avviato con contesto/)).toBeTruthy();
  });
});

const recheckTuning = (over: Partial<TuneRecheck> = {}): Tuning => {
  const before = combo('q4_0', 65536, [point(1024, 80, 900), point(32768, 68, 800)], { params: params({ kvCacheType: 'q4_0', flashAttention: 'on', contextSize: 65536, ubatchSize: 2048 }) });
  const now = combo('q4_0', 65536, [point(1024, 40, 900), point(32768, 67.5, 800), point(65392, 60, 700)], { params: before.params });
  const runnerUp = combo('q8_0', 32768, [point(1024, 90, 950)]);
  const recheck: TuneRecheck = {
    previousRunId: TUNE_ID,
    previousCreatedAt: '2026-10-01T10:00:00.000Z',
    previousBuild: 'b10997',
    currentBuild: 'sha256:0123456789abcdef0123456789',
    checks: [
      { role: 'recommended', previous: before, combination: 0, fits: true, outcome: 'ok', moved: [{ at: 1024, metric: 'decode', before: 80, after: 40 }] },
      { role: 'runner-up', previous: runnerUp, fits: false, outcome: 'oom', moved: [] },
    ],
    result: 'changed',
    suggestFull: true,
    ...over,
  };
  return { ...tunedRun().tuning!, budget: 'recheck', dimensions: [], capacity: [], attempts: [attempt('recheck', 'q4_0', 65536, 'ok'), attempt('recheck', 'q8_0', 32768, 'oom')], combinations: [now], recommended: 0, fastestByDepth: [], recheck };
};

describe('"Ricontrollo rapido": result', () => {
  it('what moved, before and now per measure, and the full search right there', async () => {
    const run = { ...tunedRun(), id: 'RECHECK1', tuning: recheckTuning() };
    const api = benchApi({ runs: [...seededRuns(), run] });
    renderApp('/results/RECHECK1', api);
    await h1(/Qwen3 8B/);
    expect(screen.getByText(/^Con sha256:0123456789ab alcuni numeri sono cambiati rispetto al test del .* fatto con b10997/)).toBeTruthy();
    const table = screen.getByRole('table', { name: /^Prima e ora: / });
    const rows = within(table).getAllByRole('row').slice(1);
    // Two depths measured both times × three measures.
    expect(rows).toHaveLength(6);
    expect(rows[0]!.textContent).toContain('1K');
    expect(rows[0]!.textContent).toContain('Generazione (tok/s)');
    expect(rows[0]!.textContent).toContain('80,0');
    expect(rows[0]!.textContent).toContain('40,0');
    expect(rows[0]!.textContent).toContain('2 volte più lento');
    expect(rows[0]!.textContent).toContain('oltre il rumore');
    expect(rows[3]!.textContent).toContain('entro il rumore');
    expect(screen.getByText('Non è partita: Memoria esaurita.')).toBeTruthy();
    expect(screen.getByText('Seconda migliore finora')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Fai la ricerca completa' }));
    expect(await h1('Test in corso')).toBeTruthy();
    expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/runs')!.body).toMatchObject({ profile: 'tune', tune: { budget: 'fast', fidelity: false } });
  });

  it('the same numbers: said so, no action; words for every result', async () => {
    const run = { ...tunedRun(), id: 'RECHECK2', tuning: recheckTuning({ result: 'same', suggestFull: false, previousBuild: undefined }) };
    renderApp('/results/RECHECK2', benchApi({ runs: [...seededRuns(), run] }));
    await h1(/Qwen3 8B/);
    expect(screen.getByText(/^Con sha256:0123456789ab i numeri sono quelli del test del .* fatto con una versione sconosciuta/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Fai la ricerca completa' })).toBeNull();
    const r = recheckTuning().recheck!;
    expect(recheckSentence({ ...r, result: 'no-longer-fits' }, f)).toMatch(/^Con sha256:0123456789ab la configurazione consigliata dal test del .* non sta più nella memoria video/);
    expect(recheckSentence({ ...r, result: 'incomplete' }, f)).toBe('Il ricontrollo non è arrivato in fondo: fai una ricerca completa.');
    expect(recheckSentence({ ...r, result: 'same' }, en)).toMatch(/^With sha256:0123456789ab the numbers are those of the/);
  });

  it('"Più utenti" rechecked: before and now per level; a check not measured again says why', async () => {
    const t = multiTuning();
    const prev = t.combinations[0]!;
    const now = { ...prev, concurrency: [level(1, 61), level(2, 54), level(3, 51), level(4, 30)] };
    const recheck: TuneRecheck = {
      previousRunId: 'X',
      previousCreatedAt: '2026-10-01T10:00:00.000Z',
      checks: [
        { role: 'recommended', previous: prev, combination: 0, fits: true, outcome: 'ok', moved: [{ at: 4, metric: 'perUserDecode', before: 46, after: 30 }] },
        { role: 'runner-up', previous: t.combinations[1]!, fits: false, moved: [] },
      ],
      result: 'changed',
      suggestFull: true,
    };
    const rows = recheckRows(recheck.checks[0]!, now, f);
    expect(rows.map((r) => `${r.at} ${r.metric} ${r.before}→${r.after} ${r.moved ? '!' : ''}`)).toEqual([
      '1 Generazione per utente (tok/s) 60,0→61,0 ',
      '1 In tutto (tok/s) 60→61 ',
      '1 Primo token più lento 250 ms→250 ms ',
      '2 Generazione per utente (tok/s) 55,0→54,0 ',
      '2 In tutto (tok/s) 110→108 ',
      '2 Primo token più lento 500 ms→500 ms ',
      '3 Generazione per utente (tok/s) 50,0→51,0 ',
      '3 In tutto (tok/s) 150→153 ',
      '3 Primo token più lento 750 ms→750 ms ',
      '4 Generazione per utente (tok/s) 46,0→30,0 !',
      '4 In tutto (tok/s) 184→120 ',
      '4 Primo token più lento 1,00 s→1,00 s ',
    ]);
    expect(recheckRows(recheck.checks[1]!, undefined, f)).toEqual([]);
    // A level measured only now is left out; a value that was 0 has no ratio.
    const zero = { ...recheck.checks[0]!, previous: { ...prev, concurrency: [level(1, 60, { aggregateTps: 0 })] } };
    const extra = recheckRows(zero, { ...now, concurrency: [level(1, 61), level(5, 20)] }, f);
    expect(extra.map((r) => [r.at, r.change])).toEqual([
      ['1', '+1,7%'],
      ['1', '–'],
      ['1', '0%'],
    ]);
    const run = { ...tunedRun(), id: 'RECHECK3', tuning: { ...t, budget: 'recheck' as const, combinations: [now], recheck } };
    const api = benchApi({ runs: [...seededRuns(), run] });
    renderApp('/results/RECHECK3', api);
    await h1(/Qwen3 8B/);
    expect(screen.getByRole('table', { name: /^Prima e ora: / })).toBeTruthy();
    expect(screen.getByText('Utenti insieme')).toBeTruthy();
    expect(screen.getByText('Non provata: tempo finito.')).toBeTruthy();
    // The full search asks the same question again.
    await userEvent.click(screen.getByRole('button', { name: 'Fai la ricerca completa' }));
    expect(await h1('Test in corso')).toBeTruthy();
    expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/runs')!.body).toMatchObject({ tune: { budget: 'fast', goal: 'multi', users: 4, perUserContext: 8192 } });
  });
});

describe('Benchmark: what the search is for, and the quick recheck', () => {
  it('"Più utenti" with users and context per user; a quick recheck when the last search used another build', async () => {
    const api = benchApi({}, { onboardingDone: true, expertMode: true });
    const previousTune: RunPlan['previousTune'] = { runId: TUNE_ID, createdAt: '2026-10-01T10:00:00.000Z', budget: 'fast', build: 'b10997', currentBuild: 'b11438', sameBuild: false };
    api.world.plan = (body) => planFor({ estimatedSeconds: (body as StartRunRequest).tune?.budget === 'recheck' ? 180 : 300, ...((body as StartRunRequest).tune?.goal === 'multi' ? { previousTune } : {}) });
    renderApp('/', api);
    await screen.findByRole('heading', { name: 'Pronto a misurare la tua RTX 5090' });
    await userEvent.click(screen.getByRole('radio', { name: /Trova le impostazioni migliori/ }));
    expect(screen.getByRole('radio', { name: 'Un utente, contesto massimo' })).toBeTruthy();
    expect(screen.queryByRole('radio', { name: /^Ricontrollo rapido/ })).toBeNull();
    await userEvent.click(screen.getByRole('radio', { name: 'Più utenti' }));
    expect(screen.getByText(/misuro la velocità di ognuno con tutti al lavoro/)).toBeTruthy();
    // Experts: no fidelity check for several users.
    expect(screen.queryByRole('switch', { name: 'Controllo di fedeltà' })).toBeNull();
    const usersBox = screen.getByRole('textbox', { name: 'Utenti insieme' });
    await userEvent.clear(usersBox);
    await userEvent.type(usersBox, '1');
    expect(usersBox.getAttribute('aria-invalid')).toBe('true');
    await userEvent.type(usersBox, '2');
    expect(usersBox.getAttribute('aria-invalid')).toBeNull();
    await userEvent.click(screen.getByRole('radio', { name: '16K' }));
    await waitFor(() => expect(api.calls.some((c) => c.path === '/api/runs/plan' && (c.body as StartRunRequest).tune?.users === 12 && (c.body as StartRunRequest).tune?.perUserContext === 16384)).toBe(true));
    const recheck = await screen.findByRole('radio', { name: /^Ricontrollo rapido/ });
    await userEvent.click(recheck);
    expect(screen.getByText(/L’ultima ricerca è stata fatta con b10997; ora usi b11438/)).toBeTruthy();
    await waitFor(() => expect(api.calls.some((c) => c.path === '/api/runs/plan' && (c.body as StartRunRequest).tune?.budget === 'recheck')).toBe(true));
    await userEvent.click(screen.getByRole('button', { name: 'Avvia benchmark' }));
    expect(await h1('Test in corso')).toBeTruthy();
    expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/runs')!.body).toMatchObject({ tune: { budget: 'recheck', fidelity: false, goal: 'multi', users: 12, perUserContext: 16384 } });
  });

  it('"Più utenti": only N users at once, or 1 … N; the live screen lists the phases this search has, in its own words', async () => {
    const api = benchApi({}, { onboardingDone: true });
    api.world.plan = () => planFor({ estimatedSeconds: 300, scenario: { profile: 'tune', seed: 42, steps: [{ kind: 'context-sweep', depths: [], fractions: false, outputTokens: 128, reps: 2 }] } });
    renderApp('/', api);
    await screen.findByRole('heading', { name: 'Pronto a misurare la tua RTX 5090' });
    await userEvent.click(screen.getByRole('radio', { name: /Trova le impostazioni migliori/ }));
    await userEvent.click(screen.getByRole('radio', { name: 'Più utenti' }));
    // 1 … N is the default; the choice names the users typed.
    expect(screen.getByRole('radio', { name: 'Da 1 a 4 utenti' }).getAttribute('aria-checked')).toBe('true');
    const usersBox = screen.getByRole('textbox', { name: 'Utenti insieme' });
    await userEvent.clear(usersBox);
    await userEvent.type(usersBox, '2');
    await userEvent.click(screen.getByRole('radio', { name: 'Solo 2 utenti insieme' }));
    await userEvent.click(screen.getByRole('button', { name: 'Che cos’è «Come misuro gli utenti»?' }));
    expect((await screen.findAllByText(/Solo N insieme: misuro subito tutti gli N utenti al lavoro/)).length).toBeGreaterThan(0);
    await waitFor(() => expect(api.calls.some((c) => c.path === '/api/runs/plan' && (c.body as StartRunRequest).tune?.usersMode === 'exact')).toBe(true));
    await userEvent.click(screen.getByRole('button', { name: 'Avvia benchmark' }));
    expect(await h1('Test in corso')).toBeTruthy();
    expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/runs')!.body).toMatchObject({ tune: { goal: 'multi', users: 2, usersMode: 'exact' } });
    const steps = screen.getByRole('list', { name: 'Fasi del test' });
    expect(within(steps).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      expect.stringContaining('Preparazione'),
      expect.stringContaining('Utenti che ci stanno'),
      expect.stringContaining('Impostazioni'),
      expect.stringContaining('Pulizia'),
    ]);
  });

  it('the phases and their words of every kind of search', () => {
    const tune = { profile: 'tune' as const, seed: 1, steps: [] };
    expect(relevantPhases(tune, {}, { tune: { goal: 'multi' } })).toEqual(['prepare', 'tune-capacity', 'tune-variants', 'concurrency', 'cleanup']);
    expect(relevantPhases(tune, {}, { tune: { goal: 'multi', usersMode: 'exact' } })).toEqual(['prepare', 'tune-capacity', 'tune-variants', 'cleanup']);
    expect(relevantPhases(tune, {}, { tune: { goal: 'multi', budget: 'recheck' } })).toEqual(['prepare', 'tune-capacity', 'concurrency', 'cleanup']);
    expect(relevantPhases(tune, {}, { tune: { budget: 'recheck' } })).toEqual(['prepare', 'tune-capacity', 'context-sweep', 'cleanup']);
    expect(relevantPhases(tune, {}, { fidelity: true })).toEqual(['prepare', 'tune-capacity', 'tune-variants', 'context-sweep', 'fidelity', 'cleanup']);
    expect(['tune-capacity', 'tune-variants', 'concurrency'].map((p) => phaseKey(p as never, { goal: 'multi' }))).toEqual(['tune.phases.usersCapacity', 'tune.phases.usersVariants', 'phases.concurrency']);
    expect(phaseKey('tune-capacity', { goal: 'multi', budget: 'recheck' })).toBe('tune.phases.recheck');
    expect(phaseKey('tune-capacity', { budget: 'recheck' })).toBe('tune.phases.recheck');
    expect(phaseKey('tune-capacity')).toBe('phases.tune-capacity');
    expect(phaseKey('tune-variants', { goal: 'single' })).toBe('phases.tune-variants');
  });

  it('the request: recheck only when offered, defaults of the goal, users typed', () => {
    const previous = { runId: 'x', createdAt: 'y', budget: 'fast' as const, sameBuild: false };
    expect(recheckOffered(undefined)).toBe(false);
    expect(recheckOffered({ ...previous, sameBuild: true })).toBe(false);
    expect(recheckOffered(previous)).toBe(true);
    expect(tuneRequestOf({ ...DEFAULT_TUNE, budget: 'recheck' }, { expert: true, previous: undefined })).toEqual({ budget: 'fast', fidelity: false });
    expect(tuneRequestOf({ budget: 'recheck', fidelity: true }, { expert: true, previous })).toEqual({ budget: 'recheck', fidelity: false });
    expect(tuneRequestOf({ budget: 'thorough', fidelity: true }, { expert: true, previous })).toEqual({ budget: 'thorough', fidelity: true });
    expect(tuneRequestOf({ budget: 'fast', fidelity: true, goal: 'multi' }, { expert: true, previous })).toEqual({ budget: 'fast', fidelity: false, goal: 'multi', users: 4, perUserContext: 8192 });
    // Users 1 … N is the default and is not sent; only N is.
    expect(tuneRequestOf({ budget: 'fast', fidelity: false, goal: 'multi', usersMode: 'ramp' }, { expert: false, previous })).toEqual({ budget: 'fast', fidelity: false, goal: 'multi', users: 4, perUserContext: 8192 });
    expect(tuneRequestOf({ budget: 'fast', fidelity: false, goal: 'multi', users: 2, usersMode: 'exact' }, { expert: false, previous })).toMatchObject({ users: 2, usersMode: 'exact' });
    expect(tuneRequestOf({ budget: 'fast', fidelity: false, usersMode: 'exact' }, { expert: false, previous })).toEqual({ budget: 'fast', fidelity: false });
    expect(['3', ' 32 ', '1', '33', 'x', '2.5', ''].map(parseUsers)).toEqual([3, 32, undefined, undefined, undefined, undefined, undefined]);
  });

  it('back to one user keeps the budget; the options box alone', async () => {
    const changes: unknown[] = [];
    renderUi(<TuneOptions value={{ budget: 'thorough', fidelity: false, goal: 'multi', users: 6, perUserContext: 4096 }} onChange={(v) => changes.push(v)} expert={false} />);
    await userEvent.click(screen.getByRole('radio', { name: 'Un utente, contesto massimo' }));
    expect(changes.at(-1)).toEqual({ budget: 'thorough', fidelity: false });
    expect((screen.getByRole('textbox', { name: 'Utenti insieme' }) as HTMLInputElement).value).toBe('6');
  });

  it('a recheck asked when none is offered reads as Veloce', () => {
    renderUi(<TuneOptions value={{ budget: 'recheck', fidelity: false }} onChange={() => undefined} expert previous={{ runId: 'x', createdAt: 'y', budget: 'fast', sameBuild: true }} />);
    expect(screen.getByRole('radio', { name: /^Veloce/ }).getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByRole('radio', { name: /^Ricontrollo rapido/ })).toBeNull();
  });
});

describe('outside the tune pages', () => {
  it('the server summary says when the tune ran with another build, and for how many users', async () => {
    const api = benchApi({ runs: [...seededRuns(), tunedRun()] });
    api.world.serverPlan = () =>
      serverPlanFor({ contextSize: 32768, tuned: { runId: TUNE_ID, createdAt: '2026-10-07T09:00:00.000Z', contextSize: 32768, kvCacheType: 'q8_0', goal: 'multi', users: 4, otherBuild: { build: 'b10997', current: 'b11438' } } });
    renderApp('/', api);
    await screen.findAllByText('≈ 1 min 35 s');
    await userEvent.click(screen.getByRole('button', { name: 'Avvia solo il server' }));
    expect(await screen.findByText(/Contesto 32K e cache q8_0 per 4 utenti dal test «Trova le impostazioni migliori» del 07\/10\./)).toBeTruthy();
    expect(screen.getByText('Il test è stato fatto con b10997; ora usi b11438: fai un ricontrollo rapido.')).toBeTruthy();
  });

  it('"stima tarata su N misure" next to the fit verdict', async () => {
    const api = benchApi();
    api.world.plan = () =>
      planFor({ fit: { level: 'good', needMiB: 7000, weightsMiB: 5000, kvMiB: 1500, overheadMiB: 500, availableMiB: 30000, utilization: 0.23, contextSize: 8192, basis: 'file-size', notes: [], calibration: { samples: 5, errorPct: 3.2, scope: 'model', rawNeedMiB: 7600 } } });
    renderApp('/', api);
    expect(await screen.findByText('stima tarata su 5 misure di questa scheda (scarto tipico 3,2%)')).toBeTruthy();
    renderUi(<FitSummary fit={{ level: 'good', needMiB: 7000, weightsMiB: 5000, kvMiB: 1500, overheadMiB: 500, availableMiB: 30000, utilization: 0.23, contextSize: 8192, basis: 'file-size', notes: [], calibration: { samples: 2, errorPct: 10, scope: 'architecture', rawNeedMiB: 7600 } }} />);
    // No card total known (older estimates): no "how it is judged" help.
    expect(screen.queryByRole('button', { name: 'Che cos’è «Come giudico la memoria»?' })).toBeNull();
    expect(screen.getByText(/^stima tarata su 2 misure di questa scheda \(scarto tipico 10(,0)?\s?%\)$/)).toBeTruthy();
  });

  it('builds as people read them; prefix-cache sentences from the engine’s own counters only', () => {
    expect(buildLabel('b10997', f)).toBe('b10997');
    expect(buildLabel('sha256:0123456789abcdef0123', f)).toBe('sha256:0123456789ab');
    expect(buildLabel('vllm/vllm-openai:v0.12.0', f)).toBe('vllm/vllm-openai:v0.12.0');
    expect(buildLabel(undefined, en)).toBe('an unknown version');
    const p = conversations();
    expect(
      prefixCacheSentences(
        [
          { ...p, sessions: 2, prefixCache: { hitRate: 0.5, source: 'metrics-gauge' } },
          { ...p, sessions: 3, prefixCache: { hitRate: 0.9, queries: 10, hits: 9, source: 'cached-tokens' } },
          { ...p, sessions: 4, prefixCache: undefined },
          p,
        ],
        f,
      ),
    ).toEqual([
      'Con 2 sessioni insieme il motore dice di aver riusato dalla cache del prefisso il 50% di quello che gli è arrivato.',
      'Con 4 sessioni insieme il motore ha trovato nella sua cache del prefisso il 66% dei token dei messaggi (59.000 su 89.000).',
    ]);
  });
});
