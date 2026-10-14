/**
 * Confronta with "Trova le impostazioni migliori" combinations, on the user's three real searches:
 * the speeds are read where the cards' contexts say ("Contesto massimo": each one's own largest context
 * full, only those with the same context compared), a depth beyond a context says it cannot get there,
 * the words say the same depth as the table, and the memory rows rank only what compares.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ConfigEntry } from '../../../../src/contract/configs';
import type { RunResult } from '../../../../src/contract/results';
import { bestConfigLabel, configOption, configSpeedWords, rankConfigs, rankingAt, refOfConfig } from '../../../../src/renderer/components/compare/best-config';
import {
  compareAtOf,
  compareRows,
  defaultAt,
  depthChoices,
  engineBase,
  fullDepth,
  itemOf,
  itemShortName,
  leadSentences,
  maxChoice,
  missingSpeed,
  pointAt,
  reservesMemory,
  rowLead,
  speedsWhere,
} from '../../../../src/renderer/components/compare/compare-model';
import { AT_MAX } from '../../../../src/renderer/components/configs/depths';
import { sheetOf } from '../../../../src/renderer/lib/export/sheet';
import { createFormatters } from '../../../../src/renderer/i18n';
import { validateCompareSearch } from '../../../../src/renderer/routes/compare';
import { renderApp } from '../helpers';
import { tunedRun } from '../tune/tune-fixtures';
import { LLAMA_ID, QWOPUS_ID, threeTunes, VLLM_ID, vllmTune } from './compare-fixtures';
import { IDS, seeded, seededRuns } from './fixtures';
import { benchApi } from './world';

vi.mock('echarts/core', () => ({ use: vi.fn(), init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })) }));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({ AxisPointerComponent: {}, DataZoomComponent: {}, GridComponent: {}, LegendComponent: {}, MarkAreaComponent: {}, MarkLineComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

beforeAll(() => {
  Object.assign(Element.prototype, { hasPointerCapture: () => false, releasePointerCapture: () => undefined, scrollIntoView: () => undefined });
});

const it_ = createFormatters('it');
const en = createFormatters('en');
const K = 1024;

const items = () => threeTunes().map((r) => itemOf(r));

describe('"Contesto massimo": each at its own largest context, full', () => {
  it('every item knows its point with the context full', () => {
    const [vllm, llama, qwopus] = items();
    expect(vllm!.full).toMatchObject({ depth: 212_992, point: { promptTokens: 212_848 } });
    expect(llama!.full?.depth).toBe(256 * K);
    expect(qwopus!.full?.depth).toBe(256 * K);
    expect(vllm!.kvTokens).toBe(214_491);
    // A run measured only with short prompts never filled its context.
    expect(itemOf(seeded(IDS.moe)).full).toBeUndefined();
    // A run whose last prompt fills its context (8K of 8K): that point.
    expect(itemOf(seeded(IDS.full)).full?.depth).toBe(8 * K);
  });

  it('starts there when every item has it with different contexts; at the shared depth when it is the same', () => {
    const list = items();
    const choices = depthChoices(list);
    expect(fullDepth(list)).toBeUndefined();
    expect(maxChoice(list)).toEqual({ measured: 3, total: 3 });
    expect(defaultAt(list, choices)).toBe(AT_MAX);
    expect(compareAtOf(list, choices, undefined)).toBe(AT_MAX);
    // Two 256K: the depth itself, said plainly.
    const two = list.slice(1);
    expect(fullDepth(two)).toBe(256 * K);
    expect(defaultAt(two, depthChoices(two))).toBe(256 * K);
    // A depth from the address is kept when someone measured it; an unknown one falls back.
    expect(compareAtOf(list, choices, 64 * K)).toBe(64 * K);
    expect(compareAtOf(list, choices, 3)).toBe(AT_MAX);
    // "Contesto massimo" from the address needs two items with it.
    const plain = [itemOf(seeded(IDS.moe)), itemOf(seeded(IDS.gemma))];
    expect(maxChoice(plain)).toBeUndefined();
    expect(compareAtOf(plain, depthChoices(plain), AT_MAX)).toBe(512);
    expect(pointAt(list[0]!, AT_MAX)).toBe(list[0]!.full);
    expect(pointAt(list[0]!, 64 * K)?.depth).toBe(64 * K);
  });

  it('a combination among them without the context full: the deepest depth they all measured', () => {
    const [vllm, llama] = threeTunes();
    const short = structuredClone(llama!);
    short.tuning!.combinations[0]!.sweep = short.tuning!.combinations[0]!.sweep.filter((p) => p.promptTokens <= 64 * K);
    const list = [itemOf(vllm!), itemOf(short)];
    expect(list[1]!.full).toBeUndefined();
    expect(defaultAt(list, depthChoices(list))).toBe(64 * K);
    // Plain runs keep the everyday depth (512, the result page's headline).
    const runs = [itemOf(seeded(IDS.moe)), itemOf(seeded(IDS.gemma))];
    expect(defaultAt(runs, depthChoices(runs))).toBe(512);
    // Nothing in common: nothing.
    expect(defaultAt([], [])).toBeUndefined();
  });

  it('the rows: one context words for all, only the largest context ranked, the smaller one apart', () => {
    const list = items();
    const rows = compareRows(list, AT_MAX, it_);
    const row = (id: string) => rows.find((r) => r.id === id)!;
    expect(row('decode')).toMatchObject({ context: 'con il contesto pieno, ognuno al suo contesto massimo', leadContext: 'con il contesto pieno a 256K', compared: [false, true, true], best: [2] });
    expect(row('decode').words).toEqual([undefined, '−2,5%', undefined].map((t) => (t ? expect.objectContaining({ text: t }) : undefined)));
    expect(row('prefill').best).toEqual([1]);
    expect(row('ttft').best).toEqual([1]);
    expect(rowLead(row('decode'), it_)).toMatchObject({ winner: 2, second: 1 });
    expect(leadSentences(list, rows, it_)).toEqual([
      'Scrive più in fretta C · Qwopus3.8-27B-Flash-V2-abliterated.Q4_K_M: 34,5 tok/s (con il contesto pieno a 256K), +2,6% rispetto a B · Qwen3.8-27B-UD-Q4_K_XL (33,6 tok/s).',
      'Legge più in fretta B · Qwen3.8-27B-UD-Q4_K_XL: 1.147 tok/s (con il contesto pieno a 256K), +6,7% rispetto a C · Qwopus3.8-27B-Flash-V2-abliterated.Q4_K_M (1.075 tok/s).',
      'A · nvidia/Qwen3.8-27B-NVFP4 · MODELOPT ha un contesto massimo più piccolo (208K): con il suo contesto pieno scrive a 45,5 tok/s, un numero che non si confronta con quelli con il contesto pieno a 256K.',
    ]);
    // In English too.
    expect(leadSentences(list, compareRows(list, AT_MAX, en), en)[2]).toBe(
      'A · nvidia/Qwen3.8-27B-NVFP4 · MODELOPT has a smaller largest context (208K): with its context full it writes at 45.5 tok/s, a number that does not compare with those with the context full at 256K.',
    );
    // The same context for all: said once, as it is.
    const two = list.slice(1);
    expect(compareRows(two, AT_MAX, it_)[0]).toMatchObject({ context: 'con il contesto pieno a 256K', compared: [true, true] });
  });

  it('equal speeds among some: "B, C scrivono alla stessa velocità", the smaller one still said apart', () => {
    const list = items();
    list[2]!.full = { ...list[2]!.full!, point: list[1]!.full!.point };
    const lead = leadSentences(list, compareRows(list, AT_MAX, it_), it_);
    expect(lead[0]).toBe('B, C scrivono alla stessa velocità: 33,6 tok/s (con il contesto pieno a 256K).');
    expect(lead[1]).toBe('B, C leggono alla stessa velocità: 1.147 tok/s (con il contesto pieno a 256K).');
    expect(lead[2]).toMatch(/^A · nvidia/);
  });

  it('a depth beyond a context says it cannot get there; one not measured says where', () => {
    const list = items();
    const at256 = compareRows(list, 256 * K, it_);
    expect(at256[0]!.missing).toEqual(['arriva solo a 208K', undefined, undefined]);
    expect(at256[0]!.context).toBe('scrittura con 262.144 token già nel contesto');
    const at8 = compareRows(list, 8 * K, it_);
    expect(at8[0]!.missing).toEqual([undefined, undefined, 'non misurata a 8K']);
    // At "Contesto massimo", never filled: its context, and how far it got.
    expect(missingSpeed({ points: [{ depth: 64 * K }], maxContext: 256 * K }, AT_MAX, it_)).toBe('non misurata a 256K: misurata solo fino a 64K');
    expect(missingSpeed({ points: [], maxContext: 256 * K }, AT_MAX, it_)).toBe('non misurata a 256K');
    expect(missingSpeed({ points: [] }, AT_MAX, it_)).toBe('non misurato');
    expect(missingSpeed({ points: [], maxContext: 256 * K }, AT_MAX, en)).toBe('not measured at 256K');
    // Where each column's speeds were read, said once on its card.
    expect(speedsWhere(list[0]!, AT_MAX, it_)).toBe('Velocità con il contesto pieno a 208K');
    expect(speedsWhere({ maxContext: 256 * K }, AT_MAX, it_)).toBe('Contesto pieno (256K) non misurato');
    expect(speedsWhere({}, AT_MAX, it_)).toBeUndefined();
    expect(speedsWhere(list[0]!, 64 * K, it_)).toBeUndefined();
    const [vllm, llama] = threeTunes();
    const short = structuredClone(llama!);
    short.tuning!.combinations[0]!.sweep = short.tuning!.combinations[0]!.sweep.filter((p) => p.promptTokens <= 64 * K);
    const mixed = compareRows([itemOf(vllm!), itemOf(short), itemOf(vllm!)], AT_MAX, it_);
    expect(mixed[0]!.missing).toEqual([undefined, 'non misurata a 256K: misurata solo fino a 64K', undefined]);
    // The two left share the context: compared, said as one.
    expect(mixed[0]).toMatchObject({ context: 'con il contesto pieno a 208K', compared: [true, false, true] });
  });

  it('memory: the largest context ranked only for combinations; VRAM not with vLLM/SGLang; the KV cache only between the same engine', () => {
    const list = items();
    const rows = compareRows(list, AT_MAX, it_);
    const row = (id: string) => rows.find((r) => r.id === id)!;
    expect(row('maxContext')).toMatchObject({ best: [1, 2], plain: false });
    expect(row('maxContext').words[0]?.text).toBe('−19%');
    expect(row('vram')).toMatchObject({ plain: true, best: [], context: 'vLLM e SGLang ne riservano subito una quota fissa' });
    expect(row('vram').help).toMatch(/^Quanta memoria della scheda/);
    expect(row('kvTokens')).toMatchObject({ values: [214_491, undefined, undefined], best: [], missing: [undefined, 'il motore non lo dice', 'il motore non lo dice'] });
    expect(row('kvTokens').help).toMatch(/può essere un po’ più grande del contesto massimo/);
    // Two engines saying it: no winner; the same engine: the highest.
    const vllm = itemOf(vllmTune());
    const ninfer = { ...itemOf(seeded(IDS.full)), kvTokens: 300_000 };
    ninfer.run = { ...ninfer.run, engine: { kind: 'ninfer-wsl', name: 'NInfer' } };
    expect(compareRows([vllm, ninfer], AT_MAX, it_).find((r) => r.id === 'kvTokens')).toMatchObject({ plain: true, best: [] });
    const smaller = { ...vllm, kvTokens: 100_000 };
    expect(compareRows([vllm, smaller], AT_MAX, it_).find((r) => r.id === 'kvTokens')).toMatchObject({ plain: false, best: [0] });
    expect(engineBase({ engine: { kind: 'vllm-docker', name: 'vLLM' } })).toBe('vllm');
    expect(engineBase({ engine: { kind: 'command', name: 'Fork', customEngine: { id: 'f', name: 'Fork', base: 'sglang' } } })).toBe('sglang');
    expect(reservesMemory({ engine: { kind: 'command', name: 'Fork', customEngine: { id: 'f', name: 'Fork', base: 'sglang' } } })).toBe(true);
    expect(reservesMemory({ engine: { kind: 'llamacpp-native', name: 'llama.cpp' } })).toBe(false);
  });

  it('each one at its best: where it writes and reads fastest, its largest context, its most precise cache', () => {
    const list = items();
    const row = (rows: ReturnType<typeof compareRows>, id: string) => rows.find((r) => r.id === id)!;
    const max = compareRows(list, AT_MAX, it_);
    // At "Contesto massimo" the speed rows already are each one's largest context: not twice.
    expect(max.find((r) => r.id === 'writeFull')).toBeUndefined();
    expect(row(max, 'writePeak')).toMatchObject({ group: 'best', plain: true, best: [], notes: ['a 1K di contesto', 'a 1K di contesto', 'a 1K di contesto'] });
    expect(row(max, 'writePeak').values.map((v) => it_.number(v!, 1))).toEqual(['55,8', '67,0', '68,8']);
    expect(row(max, 'readPeak').notes).toEqual(['a 4K di contesto', 'a 8K di contesto', 'a 16K di contesto']);
    expect(row(max, 'precise')).toMatchObject({ values: [112_640, 229_376, 245_760], notes: ['cache KV auto · combinazione 2', 'cache KV f16 · combinazione 2', 'cache KV f16 · combinazione 3'] });
    expect(row(max, 'precise').format(112_640)).toBe('contesto 112.640');
    // At one depth: each one's speed with its largest context full is still there, with its context.
    const at64 = compareRows(list, 64 * K, it_);
    expect(row(at64, 'writeFull')).toMatchObject({ notes: ['con il contesto pieno a 208K', 'con il contesto pieno a 256K', 'con il contesto pieno a 256K'], best: [] });
    expect(row(at64, 'readFull').values[0]).toBeCloseTo(1249.8, 0);
    // A run among them: no search, said so; never filled: why.
    const mixed = compareRows([list[0]!, itemOf(seeded(IDS.moe))], 512, it_);
    expect(row(mixed, 'precise').missing).toEqual([undefined, 'un test, non una ricerca']);
    expect(row(mixed, 'writeFull').missing).toEqual([undefined, 'non misurata a 8K: misurata solo fino a 4K']);
    expect(row(compareRows(list, AT_MAX, en), 'precise').notes?.[0]).toBe('KV cache auto · combination 2');
    // Token counts in each language; chart legends short enough to fit.
    expect(row(compareRows(list, AT_MAX, en), 'maxContext').format(212_992)).toBe('212,992 tokens');
    expect(itemShortName(list[0]!, 0)).toBe('A · nvidia/Qwen3.8-27B-NVFP4');
    expect(itemShortName(list[2]!, 2)).toBe('C · Qwopus3.8-27B-Flash-V2-…');
  });

  it('the sheet says the context of every number at "Contesto massimo", and why one is missing', () => {
    const list = items();
    const names = ['A', 'B', 'C'];
    const sheet = sheetOf({ run: list[0]!.run, compare: { items: list, names, at: AT_MAX, subject: 0 }, appVersion: '0.5.0', now: new Date('2026-10-14T10:00:00Z') }, it_);
    const table = sheet.sections.find((s) => s.title === 'Confronto con le altre configurazioni')!.table!;
    const decode = table.rows.find((r) => (r[0] as string).startsWith('Generazione'))!;
    expect(decode).toEqual(['Generazione (tok/s) · con il contesto pieno, ognuno al suo contesto massimo', '45,5 tok/s (208K, contesto più piccolo: non si confronta)', '33,6 tok/s (256K)', '34,5 tok/s (256K)', 'C: +2,6%']);
    const kv = table.rows.find((r) => (r[0] as string).startsWith('Contesto tenuto'))!;
    expect(kv.slice(1)).toEqual(['214.491 token', 'il motore non lo dice', 'il motore non lo dice', '–']);
    // Each one at its best says where; two with the best number are both named.
    expect(table.rows.find((r) => (r[0] as string).startsWith('Scrittura più veloce'))!.slice(1, 3)).toEqual(['55,8 tok/s (a 1K di contesto)', '67,0 tok/s (a 1K di contesto)']);
    expect(table.rows.find((r) => (r[0] as string).startsWith('Contesto massimo'))!.at(-1)).toBe('B, C: +23%');
    // A search's combination has no load time of its own: "–" next to a test's.
    const mixed = [list[0]!, itemOf(seeded(IDS.moe))];
    const other = sheetOf({ run: mixed[1]!.run, compare: { items: mixed, names: ['A', 'B'], at: 512, subject: 1 }, appVersion: '0.5.0', now: new Date('2026-10-14T10:00:00Z') }, it_);
    const warm = other.sections.find((s) => s.title === 'Confronto con le altre configurazioni')!.table!.rows.find((r) => (r[0] as string).startsWith('Caricamento a caldo'))!;
    expect(warm[1]).toBe('–');
  });
});

describe('the configurations of a model, ranked as in Configurazioni', () => {
  const config = (id: string, contextSize: number | undefined, points: { depth: number; decodeTps?: number }[], latest = '2026-10-01T00:00:00.000Z'): ConfigEntry =>
    ({
      id,
      engineKind: 'llamacpp-native',
      engineLabel: 'llama.cpp b1',
      engineRelease: 'b1',
      model: { key: 'm', name: 'M', weakKey: 'm' },
      gpu: { key: 'g', name: 'RTX 5090', hostId: 'h', hostLabel: 'H' },
      params: { contextSize, kvCacheType: id },
      ...(contextSize === undefined ? {} : { contextSize }),
      points: points.map((p) => ({ ...p, n: 1 })),
      tags: [],
      sources: [{ runId: `run-${id}`, date: latest, profile: 'tune', combo: 0, points }],
      latest,
    }) as unknown as ConfigEntry;

  it('at the largest context when one got there full: the larger context first, then the faster with it full', () => {
    const q8 = config('q8_0', 256 * K, [{ depth: K, decodeTps: 60 }, { depth: 256 * K, decodeTps: 34 }]);
    const q4 = config('q4_0', 256 * K, [{ depth: K, decodeTps: 62 }, { depth: 256 * K, decodeTps: 35 }]);
    const f16 = config('f16', 208 * K, [{ depth: K, decodeTps: 70 }, { depth: 208 * K, decodeTps: 45 }]);
    const short = config('short', 256 * K, [{ depth: K, decodeTps: 90 }]);
    const shorter = config('shorter', 128 * K, [{ depth: K, decodeTps: 95 }]);
    expect(rankingAt([q8, f16])).toBe(AT_MAX);
    expect(rankConfigs([f16, short, q8, shorter, q4])).toEqual({ configs: [q4, q8, f16, short, shorter], at: AT_MAX });
    // Their words: where the speed was measured, or why there is none.
    expect(bestConfigLabel(AT_MAX, 'Contesto 262.144 · cache KV q4_0', it_)).toBe('La più veloce al contesto massimo: Contesto 262.144 · cache KV q4_0');
    expect(bestConfigLabel(K, 'X', it_)).toBe('La più veloce a 1K: X');
    expect(bestConfigLabel(undefined, 'X', it_)).toBe('X');
    expect(bestConfigLabel(AT_MAX, 'X', en)).toBe('The fastest at the largest context: X');
    expect(configSpeedWords(q4, AT_MAX, it_)).toBe('35,0 tok/s con il contesto pieno a 256K');
    expect(configSpeedWords(short, AT_MAX, it_)).toBe('non misurata a 256K: misurata solo fino a 1K');
    expect(configSpeedWords(q4, K, it_)).toBe('62,0 tok/s a 1K');
    expect(configSpeedWords(q4, 64 * K, it_)).toBe('non misurata a 64K');
    expect(configSpeedWords(q4, undefined, it_)).toBeUndefined();
    expect(configSpeedWords(q4, AT_MAX, en)).toBe('35.0 tok/s with the context full at 256K');
    // A server whose context is not known: its deepest speed, at that depth; after the larger known context.
    const server = config('ext', undefined, [{ depth: 4 * K, decodeTps: 20 }]);
    expect(configSpeedWords(server, AT_MAX, it_)).toBe('20,0 tok/s a 4K');
    expect(rankConfigs([server, q4]).configs).toEqual([q4, server]);
    expect(rankConfigs([q4, server]).configs).toEqual([q4, server]);
    // As a picker's choices: the first says where it is the fastest, every one its speed (none where nothing is known).
    expect(configOption(q4, true, 'cache KV q4_0', AT_MAX, it_)).toEqual({ value: 'q4_0', label: 'La più veloce al contesto massimo: cache KV q4_0', text: 'cache KV q4_0', description: '35,0 tok/s con il contesto pieno a 256K' });
    expect(configOption(q4, false, 'cache KV q4_0', undefined, it_)).toEqual({ value: 'q4_0', label: 'cache KV q4_0', text: 'cache KV q4_0' });
    // The test to compare: the one that measured it where it is ranked.
    expect(refOfConfig(q4, AT_MAX)).toEqual({ runId: 'run-q4_0', combo: 0 });
  });
});

describe('the Compare page with three searches', () => {
  const world = () => benchApi({ runs: [...seededRuns(), ...threeTunes()] });

  it('opens at "Contesto massimo": each card says its context, the smaller one apart, the words as the table', async () => {
    const { router } = renderApp(`/compare?ids=${VLLM_ID},${LLAMA_ID},${QWOPUS_ID}`, world());
    const table = await screen.findByRole('table', { name: 'Confronto misura per misura' });
    const at = screen.getByRole('combobox', { name: 'Confronta a' });
    expect(at.textContent).toBe('Contesto massimo');
    const a = within(table).getByRole('columnheader', { name: /^A · nvidia\/Qwen3\.8-27B-NVFP4/ });
    expect(within(a).getByText('Velocità con il contesto pieno a 208K')).toBeTruthy();
    expect(within(within(table).getByRole('columnheader', { name: /^B · / })).getByText('Velocità con il contesto pieno a 256K')).toBeTruthy();
    const decode = within(table).getByRole('row', { name: /^Generazione \(tok\/s\)/ });
    expect(decode.textContent).toContain('con il contesto pieno, ognuno al suo contesto massimo');
    expect(within(decode).getByText('contesto più piccolo: non si confronta')).toBeTruthy();
    expect(within(decode).getByText('il più veloce')).toBeTruthy();
    expect(screen.getByText(/^Scrive più in fretta C · Qwopus.*\(con il contesto pieno a 256K\)/)).toBeTruthy();
    expect(screen.getByText(/^A · nvidia\/Qwen3\.8-27B-NVFP4 · MODELOPT ha un contesto massimo più piccolo \(208K\)/)).toBeTruthy();
    const kv = within(table).getByRole('row', { name: /^Contesto tenuto in memoria/ });
    expect(within(kv).getAllByText('il motore non lo dice')).toHaveLength(2);
    expect(within(kv).queryByText('il più alto')).toBeNull();
    expect(within(kv).getByRole('button', { name: /Contesto tenuto in memoria/ })).toBeTruthy();
    // "Confronta a" 64K: every number at 64K, the cards no longer say a context of their own.
    at.focus();
    fireEvent.keyDown(at, { key: 'Enter' });
    expect(within(await screen.findByRole('option', { name: /^Contesto massimo/ })).getByText('ognuno con il proprio contesto pieno')).toBeTruthy();
    expect(within(screen.getByRole('option', { name: /^256K/ })).getByText('non misurato da A')).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: /^64K/ }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ at: 64 * K }));
    await waitFor(() => expect(within(screen.getByRole('table', { name: 'Confronto misura per misura' })).getByRole('row', { name: /^Generazione \(tok\/s\)/ }).textContent).toContain('scrittura con 65.536 token già nel contesto'));
    expect(screen.queryByText('Velocità con il contesto pieno a 208K')).toBeNull();
    // 256K: A cannot get there.
    const at2 = screen.getByRole('combobox', { name: 'Confronta a' });
    at2.focus();
    fireEvent.keyDown(at2, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('option', { name: /^256K/ }));
    await waitFor(() => expect(screen.getAllByText('arriva solo a 208K').length).toBe(3));
    // And back to each one's largest context.
    const at3 = screen.getByRole('combobox', { name: 'Confronta a' });
    at3.focus();
    fireEvent.keyDown(at3, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('option', { name: /^Contesto massimo/ }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ at: AT_MAX }));
    expect(await screen.findByText('Velocità con il contesto pieno a 208K')).toBeTruthy();
  });

  it('a card that never filled its context says so at "Contesto massimo"', async () => {
    const [vllm, llama, qwopus] = threeTunes();
    const short: RunResult = structuredClone(llama!);
    short.tuning!.combinations[0]!.sweep = short.tuning!.combinations[0]!.sweep.filter((p) => p.promptTokens <= 64 * K);
    renderApp(`/compare?ids=${VLLM_ID},${LLAMA_ID},${QWOPUS_ID}&at=max`, benchApi({ runs: [vllm!, short, qwopus!] }));
    const table = await screen.findByRole('table', { name: 'Confronto misura per misura' });
    expect(within(within(table).getByRole('columnheader', { name: /^B · / })).getByText('Contesto pieno (256K) non misurato')).toBeTruthy();
    expect(within(within(table).getByRole('row', { name: /^Generazione \(tok\/s\)/ })).getByText('non misurata a 256K: misurata solo fino a 64K')).toBeTruthy();
  });

  it('the address keeps "max" and a depth; anything else is dropped', () => {
    expect(validateCompareSearch({ ids: 'A,B', at: 'max' })).toEqual({ ids: 'A,B', at: AT_MAX });
    expect(validateCompareSearch({ ids: 'A,B', at: '4096' })).toEqual({ ids: 'A,B', at: 4096 });
    expect(validateCompareSearch({ ids: 'A,B', at: 'big' })).toEqual({ ids: 'A,B' });
  });

  it('a search\'s own combinations side by side at their largest context', () => {
    const run = tunedRun();
    const two = [itemOf(run, { runId: run.id, combo: 0 }), itemOf(run, { runId: run.id, combo: 1 })];
    expect(compareRows(two, AT_MAX, it_)[0]?.id).toBe('decode');
  });
});
