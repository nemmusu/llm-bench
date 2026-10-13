import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { summarize } from '../../../../src/core/bench/stats';
import { deltaWords } from '../../../../src/renderer/components/bench/compare-words';
import { formFromScenario, scenarioFromForm, DEFAULT_SCENARIO_FORM } from '../../../../src/renderer/components/bench/expert-form';
import { noteText } from '../../../../src/renderer/components/bench/notes';
import { relevantPhases } from '../../../../src/renderer/components/bench/phases';
import { LongConversations } from '../../../../src/renderer/components/bench/result-sessions';
import { contextSweepOf, kvCapacityText, sessionsGlossary, sessionsOf, sessionsRows, sessionsSentences, sessionsTable } from '../../../../src/renderer/components/bench/sessions-view';
import { createFormatters } from '../../../../src/renderer/i18n';
import { renderApp, renderUi } from '../helpers';
import { IDS, seeded, seededRuns } from './fixtures';
import { BEFORE_POINTS, NOW_KV, NOW_POINTS, sessionsPoint, TEAM_IDS, teamRuns, withSessions } from './sessions-fixtures';
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

const it_ = createFormatters('it');
const en = createFormatters('en');

describe('Conversazioni lunghe: words and table', () => {
  it('a table by sessions, ascending, units in the headers, the depth in the first-answer header', () => {
    const t = sessionsTable([...NOW_POINTS].reverse(), it_);
    expect(t.head).toEqual([
      'Sessioni insieme',
      'Lettura del contesto di 200.000 token (token/s)',
      'Attesa prima risposta a 200.000 token',
      'Attesa in coda, la più lunga',
      'Attesa risposte successive',
      'Contesto riusato (%)',
      'Velocità di scrittura con 200.000 token (token/s)',
      'Errori (richieste)',
    ]);
    expect(t.rows).toEqual([
      ['1', '1.763', '1 min 53 s', '0 ms', '1,00 s', '99,7%', '31,7', '0'],
      ['2', '1.332', '2 min 47 s', '1 min 48 s (stima)', '5,40 s', '97,5%', '18,4', '0'],
    ]);
    expect(t.estimated).toBe(true);
    expect(t.depth).toBe(200_000);
  });

  it('columns empty for every level are left out; the engine-measured queue has no mark', () => {
    const p = sessionsPoint({ sessions: 1, queueEstimated: false, aggregatePrefillTps: undefined, laterTurns: { ttftMs: summarize([900]), decodeTps: summarize([]) } });
    delete (p as { aggregatePrefillTps?: number }).aggregatePrefillTps;
    const t = sessionsTable([p], en);
    expect(t.columns).toEqual(['sessions', 'firstWait', 'queue', 'laterWait', 'write', 'errors']);
    expect(t.head[1]).toBe('First answer wait at 200,000 tokens');
    expect(t.rows[0]).toEqual(['1', '1 min 53 s', '0 ms', '900 ms', '31.7', '0']);
    expect(t.estimated).toBe(false);
    // Write speed: the later messages when they have one, else the first.
    expect(sessionsRows([p])[0]?.write).toBe(31.7);
    const empty = sessionsPoint({ sessions: 1, firstTurn: { ttftMs: summarize([]), prefillTps: summarize([]), queueWaitMs: summarize([]), decodeTps: summarize([]) } });
    delete (empty as { laterTurns?: unknown }).laterTurns;
    expect(sessionsRows([empty])[0]).toEqual({ sessions: 1, queueEstimated: true, errors: 0, read: 1763 });
    expect(sessionsTable([empty], it_).columns).toEqual(['sessions', 'read', 'errors']);
    // A column one level lacks shows a dash there.
    const mixed = sessionsTable([empty, NOW_POINTS[1]!], it_);
    expect(mixed.rows[0]).toEqual(['1', '1.763', '–', '–', '–', '–', '–', '0']);
  });

  it('numbers in sentences: what the first message waits, what the cache saves, how long the queue is', () => {
    expect(sessionsSentences(NOW_POINTS, it_)).toEqual([
      'Con 1 sessione il primo messaggio aspetta 1 min 53 s per leggere 200.000 token; dal secondo il server riusa il 99,7% del contesto e l’attesa scende a 1,00 s.',
      'Con 2 sessioni la seconda aspetta in coda 1 min 48 s (stima) prima che il server inizi a leggerla; dal secondo messaggio l’attesa è di 5,40 s.',
    ]);
    const unknown = sessionsPoint({ sessions: 1, laterTurns: { ttftMs: summarize([1000]), decodeTps: summarize([30]) } });
    const only = sessionsPoint({ sessions: 1 });
    delete (only as { laterTurns?: unknown }).laterTurns;
    const many = (n: number) => {
      const p = sessionsPoint({ sessions: n, queueEstimated: false, firstTurn: { ...NOW_POINTS[1]!.firstTurn } });
      delete (p as { laterTurns?: unknown }).laterTurns;
      return p;
    };
    const noFirst = sessionsPoint({ sessions: 1, firstTurn: { ...only.firstTurn, ttftMs: summarize([]) } });
    const noQueue = sessionsPoint({ sessions: 2, firstTurn: { ...only.firstTurn, queueWaitMs: summarize([]) } });
    expect(sessionsSentences([unknown], it_)[0]).toContain('(il motore non dice quanto contesto riusa)');
    expect(sessionsSentences([only], it_)).toEqual(['Con 1 sessione il primo messaggio aspetta 1 min 53 s per leggere 200.000 token.']);
    expect(sessionsSentences([many(3), many(4), many(6)], it_)).toEqual([
      'Con 3 sessioni la terza aspetta in coda 1 min 48 s prima che il server inizi a leggerla.',
      'Con 4 sessioni la quarta aspetta in coda 1 min 48 s prima che il server inizi a leggerla.',
      'Con 6 sessioni l’ultima aspetta in coda 1 min 48 s prima che il server inizi a leggerla.',
    ]);
    expect(sessionsSentences([noFirst, noQueue], it_)).toEqual([]);
    expect(sessionsSentences(NOW_POINTS, en)[1]).toBe('With 2 sessions the second one waits 1 min 48 s (estimate) in the queue before the server starts reading it; from the second message the wait is 5.40 s.');
  });

  it('glossary, KV capacity in words, and runs saved before the step existed', () => {
    expect(sessionsGlossary(it_).map((g) => g.term)).toEqual(['Lettura del contesto', 'Attesa prima risposta', 'Attesa in coda', 'Contesto riusato', 'Velocità di scrittura']);
    expect(kvCapacityText(NOW_KV, it_)).toBe('889.820 token (bastano per 4 conversazioni da 200.000)');
    expect(kvCapacityText({ tokens: 300_000, maxConcurrencyAtTokens: { tokens: 200_000, concurrency: 1.5 } }, it_)).toBe('300.000 token (bastano per 1 conversazione da 200.000)');
    expect(kvCapacityText({ tokens: 100_000, maxConcurrencyAtTokens: { tokens: 200_000, concurrency: 0.5 } }, it_)).toBe('100.000 token (meno di una conversazione da 200.000)');
    expect(kvCapacityText({ tokens: 8192 }, en)).toBe('8,192 tokens');
    const old = seeded(IDS.vllm);
    expect(sessionsOf(old)).toEqual([]);
    expect(contextSweepOf(old)).toEqual([]);
  });

  it('the new run notes say what happened in plain words', () => {
    expect(noteText({ code: 'sessions_depth_reduced', params: { requested: 32768, depth: 15600, contextSize: 16384 } }, it_).body).toBe(
      'Ogni conversazione ha 16.384 token di contesto: il primo messaggio sarà di 15.600 token invece di 32.768.',
    );
    expect(noteText({ code: 'sessions_depth_unknown' }, it_).title).toBe('Conversazioni lunghe saltate');
    expect(noteText({ code: 'sessions_budget', params: { sessions: 2, seconds: 300 } }, en)).toMatchObject({ tone: 'info', title: 'Long conversations stopped early' });
  });
});

describe('Conversazioni lunghe on the result page', () => {
  it('sentences, table, glossary and the context held in memory', async () => {
    const { now } = teamRuns();
    renderUi(<LongConversations run={now} />);
    const region = screen.getByRole('region', { name: 'Conversazioni lunghe' });
    expect(within(region).getByText('889.820 token (bastano per 4 conversazioni da 200.000)')).toBeTruthy();
    expect(within(region).getByText(/la seconda aspetta in coda 1 min 48 s \(stima\)/)).toBeTruthy();
    const table = within(region).getByRole('table', { name: 'Conversazioni lunghe, per numero di sessioni insieme' });
    expect(within(region).getByRole('region', { name: 'Conversazioni lunghe, per numero di sessioni insieme' }).tabIndex).toBe(0);
    expect(within(table).getByRole('columnheader', { name: 'Attesa prima risposta a 200.000 token' })).toBeTruthy();
    expect(within(table).getByRole('row', { name: /^2 1\.332/ }).textContent).toContain('97,5%');
    expect(within(region).getByText(/Attesa in coda stimata/)).toBeTruthy();
    expect(within(region).getByText('Contesto riusato')).toBeTruthy();
    expect(within(region).getByText(/circa metà del tempo/)).toBeTruthy();
    await userEvent.click(within(region).getAllByRole('button', { name: /Conversazioni lunghe|Contesto tenuto in memoria/ })[0]!);
  });

  it('only the KV capacity, or nothing at all', () => {
    const kvOnly = withSessions(seeded(IDS.vllm), 'kv', [], { tokens: 164_816 }, '2026-10-07T08:00:00.000Z');
    const { unmount } = renderUi(<LongConversations run={kvOnly} />);
    expect(screen.getByText('164.816 token')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Conversazioni lunghe' })).toBeNull();
    unmount();
    const engineQueue = withSessions(seeded(IDS.vllm), 'q', NOW_POINTS.map((p) => ({ ...p, queueEstimated: false })), undefined, '2026-10-07T08:00:00.000Z');
    renderUi(<LongConversations run={engineQueue} />);
    expect(screen.queryByText(/Attesa in coda stimata/)).toBeNull();
    expect(screen.queryByText(/Contesto tenuto in memoria/)).toBeNull();
    const { container } = renderUi(<LongConversations run={seeded(IDS.quick)} />);
    expect(container.textContent).toBe('');
  });

  it('is part of the overview', async () => {
    const { now } = teamRuns();
    renderApp(`/results/${now.id}`, benchApi({ runs: [...seededRuns(), now] }));
    expect(await screen.findByRole('region', { name: 'Conversazioni lunghe' })).toBeTruthy();
  });
});

describe('differences in words', () => {
  const words = (a: number, b: number, higherIsBetter: boolean, kind: 'speed' | 'amount' | 'time', f = it_) => deltaWords(a, b, { higherIsBetter, kind }, f);

  it('"N volte" from a ratio of 2 (or ½), percentages below, good or bad by the metric', () => {
    expect(words(795, 1763, true, 'speed')).toMatchObject({ text: '2,2 volte più veloce', direction: 'up', good: true });
    expect(words(27.4, 31.7, true, 'speed')).toMatchObject({ text: '+16%', good: true });
    expect(words(399_806, 889_820, true, 'amount')).toMatchObject({ text: '2,2 volte di più', good: true });
    expect(words(247_000, 113_000, false, 'time')).toMatchObject({ text: '2,2 volte più breve', direction: 'down', good: true });
    expect(words(100, 54, false, 'time')).toMatchObject({ text: '−46%', good: true });
    expect(words(1763, 795, true, 'speed')).toMatchObject({ text: '2,2 volte più lento', good: false });
    expect(words(800, 100, true, 'amount')).toMatchObject({ text: '8 volte di meno', good: false });
    expect(words(10, 25, false, 'time')).toMatchObject({ text: '2,5 volte più tempo', good: false });
    expect(words(10, 20, true, 'speed')?.text).toBe('2 volte più veloce');
    expect(words(10, 125, true, 'speed', en)?.text).toBe('13 times faster');
    expect(words(100, 100.2, true, 'speed')?.direction).toBe('same');
    expect(deltaWords(undefined, 5, { higherIsBetter: true, kind: 'speed' }, it_)).toBeUndefined();
  });
});

describe('Compare page with long conversations', () => {
  it('the waits and the reuse in words at the same depth, and the sheet about one of them with the whole comparison', async () => {
    const { before, now } = teamRuns();
    const saveFile = vi.fn(async (o: { defaultName: string }) => `C:\\out\\${o.defaultName}`);
    (window as { gpubench?: unknown }).gpubench = { saveFile, platform: 'win32', setTitleBarTheme: async () => undefined };
    renderApp(`/compare?ids=${TEAM_IDS.before},${TEAM_IDS.now}`, benchApi({ runs: [...seededRuns(), before, now] }));
    const table = await screen.findByRole('table', { name: 'Confronto misura per misura' });
    const read = within(table).getByRole('row', { name: /Lettura del contesto a 200\.000 token/ });
    expect(read.textContent).toContain('2,2 volte più lento');
    expect(read.textContent).toContain('il più veloce');
    const later = within(table).getByRole('row', { name: /Attesa risposte successive a 200\.000 token/ });
    expect(later.textContent).toContain('4 min 06 s · riletto da capo');
    expect(later.textContent).toContain('1,00 s');
    expect(within(table).getByRole('row', { name: /Contesto tenuto in memoria/ }).textContent).toContain('2,2 volte di meno');
    await userEvent.click(screen.getByRole('button', { name: 'Scheda da condividere' }));
    const dialog = await screen.findByRole('dialog', { name: 'Scheda da condividere' });
    expect(within(dialog).getByText(/con il confronto con tutti gli altri/)).toBeTruthy();
    // The newest by default; the others go in the comparison table.
    expect(within(dialog).getByRole('combobox', { name: 'La scheda parla di' }).textContent).toContain('B · Qwen3-8B-FP8');
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Nome del servizio' }), 'Assistente del team');
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Indirizzo' }), 'http://admin:segreta@gpu:8000/v1?api_key=sk-abcdefghijklmnop');
    await userEvent.click(within(dialog).getByRole('radio', { name: /Pagina HTML/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salva la scheda' }));
    expect(await screen.findByText(/Scheda salvata: C:\\out\\llmbench_scheda_Assistente-del-team_/)).toBeTruthy();
    const saved = saveFile.mock.calls[0]![0] as unknown as { content: string; defaultName: string };
    expect(saved.defaultName).toMatch(/\.html$/);
    expect(saved.content).toContain('Confronto con le altre configurazioni');
    expect(saved.content).toContain('B · Qwen3-8B-FP8 (questa scheda)');
    expect(saved.content).toContain('B · Qwen3-8B-FP8: 2,2 volte più veloce');
    expect(saved.content).toContain('riletto da capo (4 min 06 s)');
    expect(saved.content).toContain('http://gpu:8000/v1?api_key=&lt;REDACTED&gt;');
    expect(saved.content).not.toContain('segreta');
    expect(saved.content).not.toContain('sk-abcdefghijklmnop');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('a sheet about the older one: it is "questa scheda", the newer one still wins its rows', async () => {
    const { before, now } = teamRuns();
    const saveFile = vi.fn(async (o: { defaultName: string }) => `C:\\out\\${o.defaultName}`);
    (window as { gpubench?: unknown }).gpubench = { saveFile, platform: 'win32', setTitleBarTheme: async () => undefined };
    renderApp(`/compare?ids=${TEAM_IDS.now},${TEAM_IDS.before}`, benchApi({ runs: [...seededRuns(), before, now] }));
    await screen.findByRole('table', { name: 'Confronto misura per misura' });
    await userEvent.click(screen.getByRole('button', { name: 'Scheda da condividere' }));
    const dialog = await screen.findByRole('dialog', { name: 'Scheda da condividere' });
    const about = within(dialog).getByRole('combobox', { name: 'La scheda parla di' });
    about.focus();
    fireEvent.keyDown(about, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('option', { name: 'A · Qwen3-8B-FP8' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salva la scheda' }));
    await waitFor(() => expect(saveFile).toHaveBeenCalled());
    const md = (saveFile.mock.calls[0]![0] as unknown as { content: string }).content;
    expect(md).toContain('A · Qwen3-8B-FP8 (questa scheda)');
    expect(md).toMatch(/\| Lettura del contesto a 200\.000 token \| 1\.763 tok\/s \| 795 tok\/s \| A · Qwen3-8B-FP8: 2,2 volte più veloce \|/);
  });
});

describe('Scheda da condividere from the result page', () => {
  it('opens from the export menu; a cancelled save keeps the dialog, a failed one says so', async () => {
    const { now } = teamRuns();
    const saveFile = vi.fn(async (o: { defaultName: string }) => `C:\\out\\${o.defaultName}`);
    (window as { gpubench?: unknown }).gpubench = { saveFile, platform: 'win32', setTitleBarTheme: async () => undefined };
    renderApp(`/results/${now.id}`, benchApi({ runs: [...seededRuns(), now] }));
    await userEvent.click(await screen.findByRole('button', { name: 'Esporta' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /Scheda da condividere/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Scheda da condividere' });
    expect(within(dialog).getByText(/i comandi sono già oscurati/)).toBeTruthy();
    saveFile.mockResolvedValueOnce(null as never);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salva la scheda' }));
    expect(screen.getByRole('dialog', { name: 'Scheda da condividere' })).toBeTruthy();
    saveFile.mockRejectedValueOnce(new Error('disk'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salva la scheda' }));
    expect(await screen.findByText('Non sono riuscito a salvare la scheda.')).toBeTruthy();
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Note' }), 'Scrivere a Marta se non risponde.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salva la scheda' }));
    expect(await screen.findByText(/Scheda salvata: .*\.md/)).toBeTruthy();
    const md = (saveFile.mock.calls[2]![0] as unknown as { content: string }).content;
    expect(md).toContain('## Il servizio');
    expect(md).toContain('Scrivere a Marta se non risponde.');
    await userEvent.click(await screen.findByRole('button', { name: 'Esporta' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /Scheda da condividere/ }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Annulla' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('expert form: long conversations', () => {
  it('round trip: sessions "2" = 1 and 2, empty depth = the whole context, messages each', () => {
    const { scenario, invalid } = scenarioFromForm({ ...DEFAULT_SCENARIO_FORM, sessions: '2', sessionsDepth: '32.768', sessionsTurns: '3' });
    expect(invalid).toEqual([]);
    expect(scenario.steps.at(-1)).toEqual({ kind: 'sessions', depth: 32768, levels: [1, 2], turns: 3, followupTokens: 256, outputTokens: 256 });
    expect(formFromScenario(scenario)).toMatchObject({ sessions: '2', sessionsDepth: '32768', sessionsTurns: '3', llamaBench: false });
    const auto = scenarioFromForm({ ...DEFAULT_SCENARIO_FORM, sessions: '1, 4', sessionsTurns: '' }).scenario.steps.at(-1);
    expect(auto).toMatchObject({ kind: 'sessions', depth: 0, levels: [1, 4], turns: 4 });
    expect(formFromScenario({ profile: 'custom', seed: 1, steps: [auto!] })).toMatchObject({ sessions: '1, 4', sessionsDepth: '' });
    expect(scenarioFromForm(DEFAULT_SCENARIO_FORM).scenario.steps.some((s) => s.kind === 'sessions')).toBe(false);
    expect(scenarioFromForm({ ...DEFAULT_SCENARIO_FORM, sessions: 'due', sessionsDepth: '0', sessionsTurns: 'x' }).invalid).toEqual(['sessions', 'sessionsDepth', 'sessionsTurns']);
    // Steps the form does not edit (the context sweep) are not mistaken for llama-bench.
    expect(formFromScenario({ profile: 'custom', seed: 1, steps: [{ kind: 'context-sweep', depths: [], fractions: false, outputTokens: 128, reps: 2 }] }).llamaBench).toBe(false);
  });

  it('the custom test plan shows the fields with their hints', async () => {
    renderApp('/', benchApi({}, { onboardingDone: true, expertMode: true, lastProfile: 'custom' }));
    const field = await screen.findByRole('textbox', { name: 'Conversazioni lunghe insieme' });
    expect(field.getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByText(/il primo messaggio legge tutto il contesto, i successivi riusano quanto già letto/)).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Contesto di ogni conversazione (token)' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Messaggi per conversazione' })).toBeTruthy();
  });
});

describe('live screen phases', () => {
  it('long conversations and the context sweep have their own phase', () => {
    expect(
      relevantPhases({
        profile: 'custom',
        seed: 1,
        steps: [
          { kind: 'context-sweep', depths: [1024], fractions: false, outputTokens: 8, reps: 1 },
          { kind: 'sessions', depth: 0, levels: [1], turns: 2, followupTokens: 8, outputTokens: 8 },
        ],
      }),
    ).toEqual(['prepare', 'context-sweep', 'sessions', 'cleanup']);
  });
});

describe('before and after data', () => {
  it('is what the team page said', () => {
    expect(BEFORE_POINTS[0]?.firstTurn.ttftMs.median).toBe(247_000);
    expect(NOW_POINTS[1]?.firstTurn.ttftMs.median).toBe(167_000);
  });
});
