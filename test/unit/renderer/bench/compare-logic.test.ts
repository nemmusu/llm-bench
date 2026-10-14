/**
 * Confronta as data: the shared speed ↔ context words, the picks (address and tray), the items of a
 * comparison, the equal-depth rule, the winners and the words, the best configuration of a model.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigEntry } from '../../../../src/contract/configs';
import { CALIBRATED_PROMPTS_NOTE, contextTokensOf, promptsCalibrated, type RunResult } from '../../../../src/contract/results';
import { kpisOf } from '../../../../src/renderer/components/bench/kpis';
import { summarize } from '../../../../src/core/bench/stats';
import { modelsOf, rankConfigs, rankingDepth, refOfConfig } from '../../../../src/renderer/components/compare/best-config';
import { speedSeries, usersLinesOption, usersSeries } from '../../../../src/renderer/components/compare/compare-charts';
import { diffRows, paramText } from '../../../../src/renderer/components/compare/compare-diff';
import { entryOfConfig, entryOfRun, entryOfSummary } from '../../../../src/renderer/components/compare/compare-entries';
import {
  compareRows,
  defaultDepth,
  depthChoices,
  engineName,
  itemName,
  itemOf,
  itemShortName,
  judge,
  leadSentences,
  pointAtDepth,
  rowLead,
  sessionsDepth,
  usersChoice,
  usersPoint,
  type CompareRow,
} from '../../../../src/renderer/components/compare/compare-model';
import { barOption } from '../../../../src/renderer/components/charts/builders';
import { configEngineLabel } from '../../../../src/renderer/components/configs/engine-label';
import { depthLinesOption } from '../../../../src/renderer/components/charts/depth-lines';
import { readChartTokens } from '../../../../src/renderer/components/charts/echarts';
import { escapeHtml, tooltipHtml, yOf } from '../../../../src/renderer/components/charts/tooltip';
import { createFormatters } from '../../../../src/renderer/i18n';
import {
  COMPARE_MAX,
  idsOf,
  oldestFirst,
  parseIds,
  parseToken,
  refToken,
  sameRef,
  setCompareSelection,
  toggleEntry,
  useCompareSelection,
} from '../../../../src/renderer/lib/compare-selection';
import {
  axisName,
  contextShort,
  contextWords,
  firstTokenWords,
  headerAt,
  headerAtMax,
  notMeasuredAt,
  liveCaption,
  pointTooltip,
  speedAt,
  tokensK,
  tooltipHead,
  tpsText,
  usersWords,
} from '../../../../src/renderer/lib/speed-at';
import { users as usersAt, point, tunedRun } from '../tune/tune-fixtures';
import { IDS, seeded, summaries } from './fixtures';
import { NOW_POINTS, sessionsPoint, teamRuns, withSessions } from './sessions-fixtures';

const it_ = createFormatters('it');
const en = createFormatters('en');
const K = 1024;

describe('speed ↔ context words (speed-at)', () => {
  it('says which way the text went and how much was in the context', () => {
    expect(tpsText('write', 54.63, it_)).toBe('54,6 tok/s');
    expect(tpsText('read', 2244.4, it_)).toBe('2.244 tok/s');
    expect(tokensK(512, it_)).toBe('512 token');
    expect(tokensK(32 * K, it_)).toBe('32K');
    expect(tokensK(4864, it_)).toBe('4,8K');
    expect(speedAt(54.6, { kind: 'write', tokens: 32_768 }, it_)).toBe('54,6 tok/s · scrittura con 32.768 token già nel contesto');
    expect(speedAt(2244, { kind: 'read', tokens: 512 }, it_)).toBe('2.244 tok/s · lettura di un prompt da 512 token');
    expect(speedAt(1450, { kind: 'read', tokens: 131_072, basis: 'depth' }, it_)).toBe('1.450 tok/s · lettura del contesto fino a 131.072 token');
    expect(contextWords({ kind: 'write', tokens: 512, basis: 'prompt' }, it_)).toBe('scrittura con 512 token già nel contesto');
    expect(speedAt(54.6, { kind: 'write', tokens: 32_768 }, en)).toBe('54.6 tok/s · writing with 32,768 tokens already in context');
    expect(speedAt(2244, { kind: 'read', tokens: 512 }, en)).toBe('2,244 tok/s · reading a 512-token prompt');
  });

  it('short forms for cells and headers, axis names and tooltips', () => {
    expect(contextShort({ kind: 'write', tokens: 32 * K }, it_)).toBe('a 32K di contesto');
    expect(contextShort({ kind: 'write', tokens: 512, basis: 'prompt' }, it_)).toBe('a 512 token di contesto');
    expect(contextShort({ kind: 'read', tokens: 8 * K }, it_)).toBe('prompt da 8K');
    expect(contextShort({ kind: 'read', tokens: 32 * K, basis: 'depth' }, it_)).toBe('a 32K di contesto');
    expect(headerAt('Generazione (tok/s)', 32 * K, it_)).toBe('Generazione (tok/s) a 32K');
    expect(headerAt('Generation (tok/s)', 512, en)).toBe('Generation (tok/s) at 512 tokens');
    expect(headerAtMax('Generazione (tok/s)', it_)).toBe('Generazione (tok/s) al contesto massimo');
    expect(headerAtMax('Generation (tok/s)', en)).toBe('Generation (tok/s) at the largest context');
    expect(notMeasuredAt(256 * K, it_)).toBe('non misurata a 256K');
    expect(notMeasuredAt(64 * K, en)).toBe('not measured at 64K');
    expect(axisName('depth', it_)).toBe('Token già nel contesto');
    expect(axisName('prompt', it_)).toBe('Lunghezza del prompt (token)');
    expect(tooltipHead(32_768, 'depth', it_)).toBe('a 32.768 token di contesto');
    expect(tooltipHead(512, 'prompt', it_)).toBe('prompt da 512 token');
    expect(pointTooltip(32_768, 'depth', { write: 54.6, read: 2244 }, it_)).toBe('a 32.768 token di contesto: scrittura 54,6 tok/s, lettura 2.244 tok/s');
    expect(pointTooltip(512, 'prompt', { read: 2244 }, it_)).toBe('prompt da 512 token: lettura 2.244 tok/s');
    expect(pointTooltip(512, 'prompt', {}, it_)).toBe('prompt da 512 token');
    expect(firstTokenWords(512, 'prompt', it_)).toBe('dopo un prompt da 512 token');
    expect(firstTokenWords(32_768, 'depth', it_)).toBe('con 32.768 token di contesto');
    expect(usersWords(4, 512, it_)).toBe('con 4 utenti insieme, prompt da 512 token ciascuno');
    expect(usersWords(4, undefined, it_)).toBe('con 4 utenti insieme');
    expect(usersWords(1, 512, it_)).toBe('con 1 utente da solo, prompt da 512 token');
    expect(usersWords(1, undefined, it_)).toBe('con 1 utente da solo');
  });

  it('what a live gauge was measured on', () => {
    expect(liveCaption(undefined, it_)).toBeUndefined();
    expect(liveCaption({ kind: 'latency', promptTokens: 4096 }, it_)).toBe('prompt da 4.096 token');
    expect(liveCaption({ kind: 'tune-probe', promptTokens: 1024 }, it_)).toBe('prompt da 1.024 token');
    expect(liveCaption({ kind: 'latency' }, it_)).toBeUndefined();
    expect(liveCaption({ kind: 'context-sweep', depth: 32_768, promptTokens: 32_000 }, it_)).toBe('contesto riempito a 32.768 token');
    expect(liveCaption({ kind: 'context-sweep', promptTokens: 8192 }, it_)).toBe('contesto riempito a 8.192 token');
    expect(liveCaption({ kind: 'context-sweep' }, it_)).toBeUndefined();
    expect(liveCaption({ kind: 'concurrency', concurrency: 8 }, it_)).toBe('in tutto, con 8 utenti');
    expect(liveCaption({ kind: 'concurrency' }, it_)).toBeUndefined();
    expect(liveCaption({ kind: 'sessions', promptTokens: 2048 }, it_)).toBe('contesto riempito a 2.048 token');
    expect(liveCaption({ kind: 'sessions' }, it_)).toBeUndefined();
  });
});

describe('the tokens a speed was measured on', () => {
  it('the engine\'s own count for calibrated text prompts, else the exact prompt LLM Bench built', () => {
    const p = { promptTokens: 4096, promptTokensReported: 4031.5 };
    expect(contextTokensOf(p, true)).toBe(4032);
    expect(contextTokensOf(p, false)).toBe(4096);
    expect(contextTokensOf({ promptTokens: 512 }, true)).toBe(512);
    expect(promptsCalibrated({ notes: [{ code: 'text_prompts_calibrated' }] })).toBe(true);
    expect(promptsCalibrated({ notes: [] })).toBe(false);
    expect(promptsCalibrated({})).toBe(false);
    const run = seeded(IDS.quick);
    run.metrics.latency = run.metrics.latency.map((q) => ({ ...q, promptTokensReported: 503 }));
    expect(kpisOf(run).promptTokens).toBe(512);
    expect(kpisOf({ ...run, notes: [{ code: CALIBRATED_PROMPTS_NOTE }] }).promptTokens).toBe(503);
  });
});

describe('the picks (address and tray)', () => {
  afterEach(() => {
    setCompareSelection([]);
    vi.restoreAllMocks();
  });

  it('address tokens: a run, or a run and one of its combinations; at most four, each once', () => {
    expect(refToken({ runId: 'A' })).toBe('A');
    expect(refToken({ runId: 'A', combo: 2 })).toBe('A~2');
    expect(parseToken(' A~2 ')).toEqual({ runId: 'A', combo: 2 });
    expect(parseToken('A')).toEqual({ runId: 'A' });
    expect(parseToken('a b')).toBeUndefined();
    expect(parseIds(undefined)).toEqual([]);
    expect(parseIds('A,B~1,A,,x y,C,D,E')).toEqual([{ runId: 'A' }, { runId: 'B', combo: 1 }, { runId: 'C' }, { runId: 'D' }]);
    expect(idsOf([{ runId: 'A' }, { runId: 'B', combo: 1 }])).toBe('A,B~1');
    expect(sameRef({ runId: 'A' }, { runId: 'A', combo: 0 })).toBe(false);
  });

  it('adds, takes away, refuses a fifth; oldest first', () => {
    const e = (runId: string, createdAt?: string) => ({ runId, label: runId, ...(createdAt ? { createdAt } : {}) });
    let list = toggleEntry([], e('A')).list;
    list = toggleEntry(list, e('B')).list;
    expect(toggleEntry(list, e('A')).list.map((x) => x.runId)).toEqual(['B']);
    const four = [e('1'), e('2'), e('3'), e('4')];
    expect(toggleEntry(four, e('5'))).toEqual({ list: four, full: true });
    expect(COMPARE_MAX).toBe(4);
    expect(oldestFirst([e('new', '2026-10-07T00:00:00Z'), e('none'), e('old', '2026-10-01T00:00:00Z')]).map((x) => x.runId)).toEqual(['old', 'new', 'none']);
  });

  it('one list for every page, kept in the window storage', () => {
    const { result } = renderHook(() => useCompareSelection());
    act(() => void expect(result.current.toggle({ runId: 'A', label: 'Qwen' })).toBe('added'));
    expect(result.current.has({ runId: 'A' })).toBe(true);
    expect(JSON.parse(localStorage.getItem('gpubench.compare')!)).toEqual([{ runId: 'A', label: 'Qwen' }]);
    act(() => void expect(result.current.toggle({ runId: 'A', label: 'Qwen' })).toBe('removed'));
    act(() => setCompareSelection(['1', '2', '3', '4'].map((runId) => ({ runId, label: runId }))));
    act(() => void expect(result.current.toggle({ runId: '5', label: '5' })).toBe('full'));
    act(() => result.current.remove({ runId: '2' }));
    expect(result.current.items.map((x) => x.runId)).toEqual(['1', '3', '4']);
    // Storage refused (private window): the list still works for this window.
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    act(() => result.current.clear());
    expect(result.current.items).toEqual([]);
  });

  it('reads back what a previous window left, ignoring anything broken', async () => {
    const load = async (raw: string | null) => {
      if (raw === null) localStorage.removeItem('gpubench.compare');
      else localStorage.setItem('gpubench.compare', raw);
      vi.resetModules();
      const mod = await import('../../../../src/renderer/lib/compare-selection');
      return renderHook(() => mod.useCompareSelection()).result.current.items;
    };
    expect(await load(JSON.stringify([{ runId: 'A', label: 'a' }, { runId: 1 }, null, { runId: 'B' }, ...['C', 'D', 'E', 'F'].map((runId) => ({ runId, label: runId }))]))).toEqual([
      { runId: 'A', label: 'a' },
      { runId: 'C', label: 'C' },
      { runId: 'D', label: 'D' },
      { runId: 'E', label: 'E' },
    ]);
    expect(await load('{"not":"a list"}')).toEqual([]);
    expect(await load('{broken')).toEqual([]);
    expect(await load(null)).toEqual([]);
    localStorage.removeItem('gpubench.compare');
  });

  it('what the tray says about a test, a combination and a configuration', () => {
    const s = summaries([seeded(IDS.full)])[0]!;
    expect(entryOfSummary(s, it_)).toEqual({ runId: IDS.full, label: 'Qwen3 8B · Q4_K_M', detail: 'llama.cpp b11438 (CUDA 13.4) · 06/10', createdAt: s.createdAt });
    const run = tunedRun();
    expect(entryOfRun(run, 2, it_)).toMatchObject({ runId: run.id, combo: 2, detail: 'llama.cpp b11438 (CUDA 13.4) · combinazione 3 · 07/10' });
    expect(entryOfRun(seeded(IDS.full), undefined, it_)).not.toHaveProperty('combo');
    const entry = config({ sources: [source('R1', 1, [{ depth: 512, decodeTps: 50 }]), source('R2', undefined, [])] });
    expect(entryOfConfig(entry, 512, it_)).toMatchObject({ runId: 'R1', combo: 1, label: 'Qwen3 8B · Q4_K_M', detail: 'llama.cpp b11438 (CUDA 13.4) · Contesto predefinito · cache KV q4_0', createdAt: '2026-10-01T00:00:00.000Z' });
  });
});

/** A configuration as GET /api/configs returns it. */
function config(over: Partial<ConfigEntry> = {}): ConfigEntry {
  return {
    id: 'c1',
    engineKind: 'llamacpp-native',
    engineLabel: 'llama.cpp b11438 (cuda-13.4)',
    engineRelease: 'b11438',
    model: { key: 'sha256:q8', name: 'Qwen3 8B', quant: 'Q4_K_M', weakKey: 'w' },
    gpu: { key: 'g', name: 'RTX 5090', hostId: 'h', hostLabel: 'PC' },
    params: { cacheTypeK: 'q4_0', cacheTypeV: 'q4_0', other: [] },
    points: [],
    tags: [],
    sources: [source('R1')],
    latest: '2026-10-01T00:00:00.000Z',
    ...over,
  };
}

function source(runId: string, combo?: number, points: ConfigEntry['sources'][number]['points'] = []): ConfigEntry['sources'][number] {
  return { runId, ...(combo === undefined ? {} : { combo }), date: '2026-10-01T00:00:00.000Z', profile: 'standard', points };
}

/** A run with a context sweep (depths in tokens: generation 100 − depth/1K, reading 5000 − depth/100). */
function swept(base: RunResult, id: string, depths: number[]): RunResult {
  const run = structuredClone(base);
  run.id = id;
  run.metrics.contextSweep = depths.map((d) => point(d, 100 - d / K, 5000 - d / 100));
  return run;
}

describe('the items of a comparison', () => {
  it('a run: its prompt lengths and its context sweep, users, memory, context', () => {
    const run = swept(seeded(IDS.full), 'x', [512, 32_624]);
    const item = itemOf(run);
    expect(item.ref).toEqual({ runId: 'x' });
    expect(item.points.map((p) => [p.depth, p.basis])).toEqual([
      [128, 'prompt'],
      [512, 'prompt'],
      [1024, 'prompt'],
      [2048, 'prompt'],
      [4096, 'prompt'],
      [8192, 'prompt'],
      [32_768, 'depth'],
    ]);
    // The latency step wins where both measured.
    expect(pointAtDepth(item, 512)?.basis).toBe('prompt');
    expect(item.concurrency.map((p) => p.level)).toEqual([1, 2, 4, 8, 16]);
    expect(item.usersPrompt).toBe(512);
    expect(item.maxContext).toBe(8192);
    expect(item.vramMiB).toBeGreaterThan(0);
    expect(item.kvTokens).toBeUndefined();
    expect(item.spill).toBe(false);
    expect(item.combo).toBeUndefined();
  });

  it('a tune run: its recommended combination, or the one asked for', () => {
    const run = tunedRun();
    run.tuning!.attempts[6] = { ...run.tuning!.attempts[6]!, combination: 3, kvTokens: 70_000 };
    expect(itemOf(run)).toMatchObject({ ref: { runId: run.id, combo: 2 }, comboIndex: 2, maxContext: 64 * K, vramMiB: 30500 });
    const q4 = itemOf(run, { runId: run.id, combo: 3 });
    expect(q4).toMatchObject({ comboIndex: 3, kvTokens: 70_000 });
    expect(q4.points.every((p) => p.basis === 'depth')).toBe(true);
    expect(q4.vramMiB).toBeDefined();
    // A combination that is not there: the recommended one.
    expect(itemOf(run, { runId: run.id, combo: 99 }).comboIndex).toBe(2);
    // A combination of a run without a search means nothing.
    expect(itemOf(seeded(IDS.full), { runId: IDS.full, combo: 1 }).ref).toEqual({ runId: IDS.full });
    // A search that measured nothing: the run's own numbers, no combination.
    const empty = tunedRun({ combinations: [], recommended: undefined, multi: { users: 4, perUserContext: 8192, promptTokens: 7900, outputTokens: 128, turns: 3 } });
    empty.metrics.concurrency = [usersAt(4)];
    const bare = itemOf(empty);
    expect(bare.combo).toBeUndefined();
    expect(bare.usersPrompt).toBe(7900);
    // Another combination measured without a sweep: none of the run's own numbers (they belong to the recommended one).
    const other = tunedRun({ combinations: [tunedRun().tuning!.combinations[2]!, { ...tunedRun().tuning!.combinations[3]!, sweep: [] }], recommended: 0 });
    expect(itemOf(other, { runId: other.id, combo: 1 })).toMatchObject({ points: [], concurrency: [], sessions: [] });
    // Nothing known about memory or context.
    const unknown = structuredClone(seeded(IDS.quick));
    unknown.metrics.vram = {};
    unknown.launch = { ...unknown.launch, argv: ['llama-server'], params: { extraArgs: [], env: {} } };
    expect(itemOf(unknown)).not.toHaveProperty('vramMiB');
    expect(itemOf(unknown)).not.toHaveProperty('maxContext');
    // A combination measured without a sweep (users at once): the run's points.
    const multi = tunedRun({ combinations: [{ ...tunedRun().tuning!.combinations[2]!, sweep: [], concurrency: [usersAt(1, { promptTokens: 4000 }), usersAt(4, { promptTokens: 4000 })] }], recommended: 0 });
    const m = itemOf(multi);
    expect(m.usersPrompt).toBe(4000);
    expect(m.points.length).toBe(multi.metrics.latency.length);
  });

  it('names: the letter and the model; engines and forks never look the same', () => {
    const item = itemOf(seeded(IDS.full));
    expect(itemName(item, 1)).toBe('B · Qwen3 8B · Q4_K_M');
    expect(itemShortName(item, 3)).toBe('D · Qwen3 8B');
    const engine = seeded(IDS.full).engine;
    expect(engineName(engine, it_)).toBe('llama.cpp b11438 (CUDA 13.4)');
    expect(engineName({ ...engine, name: 'PrismML fork', customEngine: { id: 'prism', name: 'PrismML fork', base: 'llamacpp' } }, it_)).toBe('PrismML fork (llama.cpp) b11438 (CUDA 13.4)');
    expect(engineName({ kind: 'command', name: 'Mio server', customEngine: { id: 'mio', name: 'Mio server', base: 'openai-server' } }, it_)).toBe('Mio server (server OpenAI)');
    expect(engineName({ kind: 'sglang-docker', name: 'Fast', customEngine: { id: 'f', name: 'Fast', base: 'sglang' } }, en)).toBe('Fast (SGLang)');
    // SGLang itself, and in Configurazioni its Docker image said like the others'.
    expect(engineName({ kind: 'sglang-docker', name: 'SGLang', version: 'v0.5.2' }, it_)).toBe('SGLang v0.5.2');
    expect(configEngineLabel({ engineLabel: 'SGLang v0.5.2', engineKind: 'sglang-docker' })).toBe('SGLang v0.5.2 · Docker');
    expect(configEngineLabel({ engineLabel: 'llama.cpp b11438 (cuda-13.4)', engineKind: 'llamacpp-native' })).toBe('llama.cpp b11438 (CUDA 13.4)');
  });
});

describe('equal measured depth, never estimated', () => {
  const full = itemOf(seeded(IDS.full));
  const moe = itemOf(seeded(IDS.moe));
  const quick = itemOf(seeded(IDS.quick));

  it('"Confronta a" offers the depths at least two measured; it starts where most did, closest to 512', () => {
    const choices = depthChoices([full, moe, quick]);
    expect(choices).toEqual([
      { depth: 512, measured: 3, total: 3 },
      { depth: 4096, measured: 2, total: 3 },
    ]);
    expect(defaultDepth(choices)).toBe(512);
    expect(defaultDepth([])).toBeUndefined();
    // Equally far from 512: the deeper one.
    expect(defaultDepth([{ depth: 256, measured: 2, total: 2 }, { depth: 1024, measured: 2, total: 2 }])).toBe(1024);
    // Different grids that never meet: nothing to compare speeds at.
    expect(depthChoices([itemOf(swept(seeded(IDS.quick), 'a', [])), itemOf(swept(seeded(IDS.failed), 'b', [1024]))])).toEqual([]);
    // A 32K context's deepest prompt and another's count as the same grid depth.
    const a = itemOf(swept(seeded(IDS.failed), 'a', [32_496]));
    const b = itemOf(swept(seeded(IDS.failed), 'b', [32_624]));
    expect(depthChoices([a, b])).toEqual([{ depth: 32_768, measured: 2, total: 2 }]);
  });

  it('users at once: the same number of users with the same prompt each', () => {
    const team = itemOf(seeded(IDS.gemma));
    expect(usersChoice([full, moe, team])).toEqual({ users: 4, prompt: 512, items: [0, 1, 2] });
    // A different prompt per user is a different measurement.
    const other = itemOf(seeded(IDS.moe));
    other.usersPrompt = 2048;
    expect(usersChoice([full, other])).toBeUndefined();
    expect(usersChoice([full, quick])).toBeUndefined();
    // Two groups: the larger one wins, then more users.
    const big = { ...full, concurrency: [usersAt(8)], usersPrompt: 512 };
    expect(usersChoice([big, moe, moe])).toEqual({ users: 4, prompt: 512, items: [1, 2] });
    expect(usersChoice([big, big, moe, moe])).toEqual({ users: 8, prompt: 512, items: [0, 1] });
    const unknown = { ...full, concurrency: [usersAt(2)] } as typeof full;
    delete unknown.usersPrompt;
    expect(usersChoice([unknown, unknown])).toEqual({ users: 2, items: [0, 1] });
    expect(usersPoint(full, 0, usersChoice([full, moe]))?.level).toBe(4);
    expect(usersPoint(quick, 1, usersChoice([full, moe]))).toBeUndefined();
    expect(usersPoint(full, 0, undefined)).toBeUndefined();
  });

  it('long conversations: one conversation alone at the same first-message depth', () => {
    const { before, now } = teamRuns();
    expect(sessionsDepth([itemOf(before), itemOf(now)])).toBe(200_704);
    const shorter = withSessions(now, 'short', NOW_POINTS.map((p) => ({ ...p, depth: 32_000 })), undefined, now.createdAt);
    expect(sessionsDepth([itemOf(before), itemOf(shorter)])).toBeUndefined();
    const at = (depth: number) => itemOf(withSessions(now, String(depth), NOW_POINTS.map((p) => ({ ...p, depth })), undefined, now.createdAt));
    expect(sessionsDepth([at(32_496), at(32_624)])).toBe(32_768);
    // Two at 32K, two at 200K: as many, the deeper.
    expect(sessionsDepth([at(32_768), at(32_768), itemOf(before), itemOf(now)])).toBe(200_704);
    // Nearly equal depths are labelled with the grid depth they share, equal ones with their own.
    expect(compareRows([at(32_496), at(32_624)], undefined, it_).find((r) => r.id === 'firstWait')?.label).toBe('Attesa prima risposta a 32.768 token');
    expect(sessionsDepth([full, moe])).toBeUndefined();
  });
});

describe('the rows: the best number marked, the others in words', () => {
  it('speeds at the compared depth, memory, users, the rest; a row nobody measured is left out', () => {
    const items = [itemOf(seeded(IDS.moe)), itemOf(seeded(IDS.gemma))];
    const rows = compareRows(items, 512, it_);
    expect(rows.map((r) => r.id)).toEqual(['decode', 'prefill', 'ttft', 'writePeak', 'readPeak', 'maxContext', 'vram', 'perUser', 'total', 'usersTtft', 'warm', 'cold', 'efficiency', 'score']);
    const row = (id: string) => rows.find((r) => r.id === id)!;
    // Each one at its best: where it writes fastest, said under the number, no winner.
    expect(row('writePeak')).toMatchObject({ plain: true, best: [], notes: ['a 512 token di contesto', 'a 512 token di contesto'] });
    expect(row('decode')).toMatchObject({ label: 'Generazione (tok/s)', context: 'scrittura con 512 token già nel contesto', best: [0] });
    expect(row('decode').words[1]?.text).toBe('3,7 volte più lento');
    expect(row('prefill').context).toBe('lettura di un prompt da 512 token');
    expect(row('ttft').context).toBe('dopo un prompt da 512 token');
    expect(row('ttft').format(58.4)).toBe('58 ms');
    // A run's context is how it was started, not something it found: side by side, no winner (only "the same").
    expect(row('maxContext')).toMatchObject({ best: [0, 1], plain: true, context: 'quello con cui è stato avviato' });
    expect(judge({ ...row('maxContext'), values: [8192, 4096] }, it_)).toMatchObject({ best: [], words: [undefined, undefined] });
    expect(row('vram')).toMatchObject({ plain: false });
    expect(row('vram').best).toHaveLength(1);
    expect(row('vram')).not.toHaveProperty('help');
    expect(row('decode').missing).toEqual([undefined, undefined]);
    expect(row('perUser').context).toBe('con 4 utenti insieme, prompt da 512 token ciascuno');
    expect(row('vram').format(6963)).toBe('6,8 GB');
    expect(row('warm').format(2140)).toBe('2,14 s');
    expect(row('efficiency').format(0.47)).toBe('0,47 tok/J');
    expect(row('score').format(1012)).toBe('1.012');
    expect(rows.find((r) => r.id === 'kvTokens')).toBeUndefined();
    // At a depth one of them did not measure: no number for it, never an estimate.
    const deeper = compareRows([...items, itemOf(seeded(IDS.quick))], 4096, it_);
    expect(deeper.find((r) => r.id === 'prefill')?.values[2]).toBeUndefined();
    // Why: its context is smaller than that depth.
    expect(deeper.find((r) => r.id === 'prefill')?.missing).toEqual([undefined, undefined, 'arriva solo a 1K']);
    // No compared depth: no speed rows, only each one at its best.
    expect(compareRows(items, undefined, it_)[0]?.id).toBe('writePeak');
    // A context sweep only: its reading is the context's, not a prompt's.
    const sweeps = [itemOf(swept(seeded(IDS.failed), 'a', [K])), itemOf(swept(seeded(IDS.failed), 'b', [K]))];
    expect(compareRows(sweeps, K, it_).find((r) => r.id === 'prefill')?.context).toBe('lettura del contesto fino a 1.024 token');
    expect(compareRows(sweeps, K, it_).find((r) => r.id === 'ttft')?.context).toBe('con 1.024 token di contesto');
  });

  it('tune combinations have no load times of their own', () => {
    const run = tunedRun();
    const rows = compareRows([itemOf(run, { runId: run.id, combo: 0 }), itemOf(run, { runId: run.id, combo: 1 })], 4 * K, it_);
    expect(rows.map((r) => r.id)).toEqual(['decode', 'prefill', 'ttft', 'writeFull', 'readFull', 'writePeak', 'readPeak', 'precise', 'maxContext', 'vram']);
    expect(rows[0]!.best).toEqual([0]);
    // The largest context that fits is what a search found: ranked.
    expect(rows.find((r) => r.id === 'maxContext')).toMatchObject({ plain: false, context: 'il più grande che entra nella scheda, trovato dalla ricerca' });
    expect(rows.find((r) => r.id === 'maxContext')?.words[0]?.text).toBe('−25%');
  });

  it('long conversations: reading, writing, the waits and the reuse at the same depth', () => {
    const { before, now } = teamRuns();
    const items = [itemOf(before), itemOf(now)];
    const rows = compareRows(items, undefined, it_);
    const row = (id: string) => rows.find((r) => r.id === id)!;
    expect(rows.filter((r) => r.group === 'sessions').map((r) => r.label)).toEqual([
      'Lettura del contesto a 200.000 token',
      'Velocità di scrittura a 200.000 token',
      'Attesa prima risposta a 200.000 token',
      'Attesa risposte successive a 200.000 token',
      'Contesto riusato a 200.000 token',
    ]);
    expect(row('sessionsRead')).toMatchObject({ best: [1] });
    expect(row('sessionsRead').words[0]?.text).toBe('2,2 volte più lento');
    expect(row('sessionsWrite').words[0]?.text).toBe('−14%');
    expect(row('firstWait').words[0]?.text).toBe('2,2 volte più tempo');
    expect(row('laterWait').reread).toEqual([true, false]);
    expect(row('kvTokens').words[0]?.text).toBe('2,2 volte di meno');
    expect(row('kvTokens').format(889_820)).toBe('889.820 token');
    expect(row('reuse').format(0.997)).toBe('99,7%');
    expect(rowLead(row('reuse'), it_)).toEqual({ winner: 1, tie: false, second: 0, diff: '99,7% contro 0%' });
    expect(rowLead(row('sessionsRead'), it_)).toEqual({ winner: 1, tie: false, second: 0, diff: '2,2 volte più veloce' });
    expect(rowLead(row('firstWait'), it_)).toMatchObject({ winner: 1, diff: '2,2 volte più breve' });
    // A third one without that conversation: "non misurato" there.
    const third = compareRows([itemOf(before), itemOf(now), itemOf(seeded(IDS.full))], undefined, it_);
    expect(third.find((r) => r.id === 'sessionsWrite')?.values[2]).toBeUndefined();
    expect(third.find((r) => r.id === 'firstWait')?.values[2]).toBeUndefined();
    // One side whose engine did not say what it reused: no number, no reread.
    const noShare = withSessions(now, 'ns', [sessionsPoint({ sessions: 1, laterTurns: { ttftMs: summarize([]), decodeTps: summarize([]) } })], undefined, now.createdAt);
    const plain = compareRows([itemOf(before), itemOf(noShare)], undefined, it_);
    expect(plain.find((r) => r.id === 'laterWait')).toMatchObject({ values: [246_250, undefined], reread: [true, false] });
    expect(plain.find((r) => r.id === 'reuse')?.values).toEqual([0, undefined]);
  });

  it('the best: ties within half a percent, lower is better for times, nothing below two numbers', () => {
    const base = { id: 'x', group: 'speed' as const, label: 'X', kind: 'speed' as const, format: String };
    expect(judge({ ...base, values: [10, undefined], higherIsBetter: true }, it_)).toMatchObject({ best: [], words: [undefined, undefined] });
    const tie = judge({ ...base, values: [100, 100.3, 80], higherIsBetter: true }, it_);
    expect(tie.best).toEqual([0, 1]);
    expect(tie.words[2]?.text).toBe('−20%');
    expect(rowLead(tie, it_)).toEqual({ winner: 0, tie: false, second: 2, diff: '+25%' });
    const zero = judge({ ...base, values: [0, 0], higherIsBetter: true }, it_);
    expect(zero.best).toEqual([0, 1]);
    expect(rowLead(zero, it_)).toEqual({ winner: 0, tie: true });
    const time = judge({ ...base, kind: 'time', values: [400, 100, undefined], higherIsBetter: false }, it_);
    expect(time).toMatchObject({ best: [1] });
    expect(time.words[0]?.text).toBe('4 volte più tempo');
    expect(rowLead(time, it_)).toMatchObject({ second: 0, diff: '4 volte più breve' });
    // Lower is better and the runner-up is the lowest of the others.
    expect(rowLead(judge({ ...base, kind: 'time', values: [300, 100, 200], higherIsBetter: false }, it_), it_)).toMatchObject({ second: 2 });
    expect(rowLead({ ...base, values: [1], higherIsBetter: true, best: [], words: [] }, it_)).toBeUndefined();
  });

  it('"In breve": who writes and who reads faster, against the runner-up, in one sentence each', () => {
    const items = [itemOf(seeded(IDS.moe)), itemOf(seeded(IDS.gemma)), itemOf(seeded(IDS.full))];
    const rows = compareRows(items, 512, it_);
    expect(leadSentences(items, rows, it_)).toEqual([
      'Scrive più in fretta A · Qwen3 30B A3B · Q4_K_M: 214,1 tok/s (scrittura con 512 token già nel contesto), +17% rispetto a C · Qwen3 8B · Q4_K_M (183,5 tok/s).',
      'Legge più in fretta C · Qwen3 8B · Q4_K_M: 8.952 tok/s (lettura di un prompt da 512 token), +46% rispetto a A · Qwen3 30B A3B · Q4_K_M (6.144 tok/s).',
    ]);
    const same = [itemOf(seeded(IDS.full)), itemOf(swept(seeded(IDS.full), 'twin', []))];
    expect(leadSentences(same, compareRows(same, 512, it_), it_)).toEqual([
      'Scrivono tutti alla stessa velocità: 183,5 tok/s (scrittura con 512 token già nel contesto).',
      'Leggono tutti alla stessa velocità: 8.952 tok/s (lettura di un prompt da 512 token).',
    ]);
    expect(leadSentences(items, compareRows(items, undefined, it_), it_)).toEqual([]);
  });
});

describe('"Cosa cambia tra loro"', () => {
  it('every setting side by side, the different ones marked, the ones all left automatic out', () => {
    const full = seeded(IDS.full);
    const bare: RunResult = {
      ...full,
      engine: { kind: 'llamacpp-native', name: 'llama.cpp' },
      model: { ...full.model, quant: undefined, sizeBytes: undefined, sha256: undefined },
      hardware: { ...full.hardware, gpus: [] },
      launch: { ...full.launch, params: { extraArgs: ['--metrics'], env: { A: '1' }, ropeScaling: { type: 'yarn', factor: 4, originalContext: 32_768 } } },
    };
    const rows = diffRows([itemOf(seeded(IDS.vllm)), itemOf(full), itemOf(bare)], it_);
    const row = (label: string) => rows.find((r) => r.label === label)!;
    expect(row('Modello').differs).toBe(true);
    expect(row('Immagine Docker').values).toEqual(['sha256:6f1a8c2e', '–', '–']);
    expect(row('Scheda video').values[2]).toBe('–');
    expect(row('Argomenti extra').values[2]).toBe('--metrics');
    expect(row('Variabili d’ambiente').values[2]).toBe('A=1');
    expect(row('Estensione del contesto (RoPE)').values[2]).toBe('yarn ×4 (32768)');
    expect(row('Sistema operativo')?.differs ?? false).toBe(false);
    const same = diffRows([itemOf(full), itemOf(full)], it_);
    expect(same.filter((r) => r.differs)).toEqual([]);
    expect(same.find((r) => r.label === 'Argomenti extra')).toBeUndefined();
    expect(paramText('env', { extraArgs: [], env: {} }, 'auto')).toBe('auto');
    expect(paramText('ropeScaling', { extraArgs: [], env: {} }, 'auto')).toBe('auto');
    // NInfer's own settings, as on its command line.
    expect(paramText('ninfer', { extraArgs: [], env: {}, ninfer: { kvCapacity: 'auto', prefixReuse: false } }, 'auto')).toBe('--kv-capacity auto --no-prefix-reuse');
    expect(paramText('ninfer', { extraArgs: [], env: {}, ninfer: {} }, 'auto')).toBe('auto');
    const ninfer: RunResult = { ...full, engine: { kind: 'ninfer-wsl', name: 'NInfer', version: '0.4.1' }, launch: { ...full.launch, params: { contextSize: 32_768, extraArgs: [], env: {}, ninfer: { kvCapacity: 'auto' } } } };
    const withNinfer = diffRows([itemOf(full), itemOf(ninfer)], it_);
    expect(withNinfer.find((r) => r.label === 'Motore')?.values).toEqual(['llama.cpp b11438 (CUDA 13.4)', 'NInfer 0.4.1']);
    expect(withNinfer.find((r) => r.label === 'Impostazioni NInfer')).toMatchObject({ values: ['Automatico', '--kv-capacity auto'], differs: true });
  });
});

describe('"Confronta modelli": the best configuration of each model on this card', () => {
  const at = (depth: number, decodeTps: number) => ({ depth, decodeTps, n: 1 });

  it('the fastest at the depth most of its configurations measured; then the larger context, the newer test', () => {
    const a = config({ id: 'a', points: [at(512, 100), at(4096, 90)], contextSize: 8192, latest: '2026-10-01T00:00:00.000Z' });
    const b = config({ id: 'b', points: [at(512, 120)], contextSize: 8192, latest: '2026-10-02T00:00:00.000Z' });
    const c = config({ id: 'c', points: [at(512, 120.2)], contextSize: 32_768, latest: '2026-09-01T00:00:00.000Z' });
    const d = config({ id: 'd', points: [at(512, 119.9)], contextSize: 32_768, latest: '2026-10-03T00:00:00.000Z' });
    const deep = config({ id: 'deep', points: [at(4096, 200)], latest: '2026-10-04T00:00:00.000Z' });
    const old = config({ id: 'old', points: [at(4096, 200)], latest: '2026-08-04T00:00:00.000Z' });
    const spill = config({ id: 'spill', points: [at(512, 500)], spill: true });
    expect(rankingDepth([a, b, c, d, deep])).toBe(512);
    expect(rankConfigs([a, b, c, d, deep, old, spill])).toEqual({ configs: [d, c, b, a, deep, old, spill], at: 512 });
    // Equally many at 256 and 1024: the closer to 512 (both as close), then the deeper.
    expect(rankingDepth([config({ points: [at(256, 1)] }), config({ points: [at(1024, 1)] })])).toBe(1024);
    // Only spills: ranked among themselves.
    expect(rankConfigs([spill]).at).toBe(512);
    // Spills last whatever the order they come in; configurations without a number at the depth after those with one.
    expect(rankConfigs([d, spill]).configs).toEqual([d, spill]);
    expect(rankConfigs([spill, d]).configs).toEqual([d, spill]);
    expect(rankConfigs([deep, b]).configs).toEqual([b, deep]);
    expect(rankConfigs([b, deep]).configs).toEqual([b, deep]);
    // Equal speeds and no context known: the newer test.
    const n1 = config({ id: 'n1', points: [at(512, 100)], latest: '2026-01-01T00:00:00.000Z' });
    const n2 = config({ id: 'n2', points: [at(512, 100)], latest: '2026-02-01T00:00:00.000Z' });
    expect(rankConfigs([n1, n2]).configs).toEqual([n2, n1]);
    // A depth with only a first-token time does not count.
    expect(rankingDepth([config({ points: [{ depth: 2048, ttftMs: 100, n: 1 }, at(512, 1)] })])).toBe(512);
    // Nothing measured: no depth, newest first.
    const none = rankConfigs([config({ id: 'x', latest: '2026-01-01T00:00:00.000Z' }), config({ id: 'y', latest: '2026-02-01T00:00:00.000Z' })]);
    expect(none.at).toBeUndefined();
    expect(none.configs.map((e) => e.id)).toEqual(['y', 'x']);
  });

  it('every model, by name, with its ranked configurations; the test to compare for one', () => {
    const qwen = config({ id: 'q', points: [at(512, 100)] });
    const gemma = config({ id: 'g', model: { key: 'sha256:g', name: 'Gemma 4', weakKey: 'g' }, points: [at(512, 50)] });
    const qwen2 = config({ id: 'q2', points: [at(512, 150)] });
    const models = modelsOf([qwen, gemma, qwen2]);
    expect(models.map((m) => [m.name, m.quant, m.configs.map((e) => e.id)])).toEqual([
      ['Gemma 4', undefined, ['g']],
      ['Qwen3 8B', 'Q4_K_M', ['q2', 'q']],
    ]);
    // Same name, two keys: by key.
    expect(modelsOf([config({ model: { ...qwen.model, key: 'z' } }), qwen]).map((m) => m.key)).toEqual(['sha256:q8', 'z']);
    const multi = config({ sources: [source('new', undefined, []), source('old', 4, [{ depth: 512, decodeTps: 1 }])] });
    expect(refOfConfig(multi, 512)).toEqual({ runId: 'old', combo: 4 });
    expect(refOfConfig(multi, 4096)).toEqual({ runId: 'new' });
  });
});

describe('charts with every item on them', () => {
  const tk = readChartTokens();

  it('speed by depth (null where an item did not measure), users with the same prompt', () => {
    const items = [itemOf(seeded(IDS.full)), itemOf(seeded(IDS.quick)), itemOf(seeded(IDS.moe))];
    const s = speedSeries(items, ['A', 'B', 'C'], 'decode');
    expect(s.depths).toEqual([128, 512, 1024, 2048, 4096, 8192]);
    expect(s.series[1]!.values).toEqual([null, items[1]!.points[0]!.point.decodeTps.median, null, null, null, null]);
    expect(speedSeries(items, ['A', 'B', 'C'], 'prefill').series[0]!.values[0]).toBeGreaterThan(1000);
    const choice = usersChoice(items)!;
    const u = usersSeries(items, ['A', 'B', 'C'], choice, 'perUser');
    expect(u.levels).toEqual([1, 2, 4, 8, 16]);
    expect(u.series.map((x) => x.item)).toEqual([0, 2]);
    expect(u.series[1]!.values[1]).toBeNull();
    expect(usersSeries(items, ['A', 'B', 'C'], choice, 'total').series[0]!.values[0]).toBe(items[0]!.concurrency[0]!.aggregateTps);
    const option = usersLinesOption(tk, u.levels, u.series, { format: (v) => `${v} t`, head: (n) => `con ${n}`, xName: 'Utenti', axis: String }) as {
      tooltip: { formatter: (p: unknown) => string };
      yAxis: { axisLabel: { formatter: (v: number) => string } };
    };
    const html = option.tooltip.formatter([
      { dataIndex: 2, seriesName: 'A <b>', color: '#f00', value: 12 },
      { dataIndex: 2, seriesName: 'C', color: '#0f0', value: null },
    ]);
    expect(html).toContain('con 4');
    expect(html).toContain('A &lt;b&gt;');
    expect(html).toContain('12 t');
    expect(html).toContain('–');
    expect(option.yAxis.axisLabel.formatter(5)).toBe('5');
  });

  it('tooltips that say the context: a head with one line per series, or one sentence', () => {
    const opts = { format: (v: number) => `${v} t`, depthLabel: String, xName: 'X' };
    const series = [{ name: 'A', values: [1, null] }];
    const head = depthLinesOption(tk, [512, 1024], series, { ...opts, tooltipHead: (d) => `a ${d}`, connectNulls: true }) as {
      tooltip: { formatter: (p: unknown) => string };
      series: { connectNulls: boolean }[];
    };
    expect(head.series[0]!.connectNulls).toBe(true);
    expect(head.tooltip.formatter([{ dataIndex: 1, seriesName: 'A', color: '#f00', value: [1, 7] }])).toContain('a 1024');
    expect(head.tooltip.formatter([{ dataIndex: 0, seriesName: 'A', color: '#f00', value: undefined }])).toContain('–');
    const text = depthLinesOption(tk, [512], series, { ...opts, tooltipText: (d) => `prompt ${d} & co` }) as { tooltip: { formatter: (p: unknown) => string } };
    expect(text.tooltip.formatter([{ dataIndex: 0 }])).toContain('prompt 512 &amp; co');
    const plain = depthLinesOption(tk, [512], series, opts) as { tooltip: { valueFormatter: (v: unknown) => string }; series: { connectNulls: boolean }[] };
    expect(plain.tooltip.valueFormatter(3)).toBe('3 t');
    expect(plain.tooltip.valueFormatter(null)).toBe('–');
    expect(plain.series[0]!.connectNulls).toBe(false);
    const bars = barOption(tk, ['512'], [3], { name: 'N', format: (v) => `${v} t`, tooltipText: (i) => `riga ${i}` }) as { tooltip: { formatter: (p: unknown) => string } };
    expect(bars.tooltip.formatter([{ dataIndex: 0 }])).toContain('riga 0');
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
    expect(tooltipHtml(tk, 'h', [{ name: 'n', value: 'v' }])).not.toContain('border-radius:4px');
    expect(yOf([1, 2])).toBe(2);
    expect(yOf(null)).toBeNull();
    expect(yOf('3')).toBe(3);
  });
});

describe('a comparison row as the page sees it', () => {
  it('keeps every field the cells need', () => {
    const row: CompareRow = compareRows([itemOf(seeded(IDS.moe)), itemOf(seeded(IDS.gemma))], 512, it_)[0]!;
    expect(Object.keys(row).sort()).toEqual(['best', 'context', 'format', 'group', 'higherIsBetter', 'id', 'kind', 'label', 'missing', 'values', 'words']);
  });
});
