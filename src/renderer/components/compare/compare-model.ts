/**
 * The comparison as data: two to four things (a run, or one combination of a "Trova le impostazioni
 * migliori" run) side by side. Speeds are compared only at a context every one of them really
 * measured (the same grid depth; "Confronta a"), never estimated; the best number of each row is
 * marked and every other one says how far it is, in words ("2,2 volte più lento", "−16%").
 */
import { configParamsOf } from '../../../contract/configs';
import type { LaunchParams } from '../../../contract/engines';
import { nominalDepth, spilledRun, type ConcurrencyPoint, type EngineIdentity, type LatencyPoint, type RunResult, type SessionsPoint, type TuneCombination } from '../../../contract/results';
import type { Formatters } from '../../i18n';
import { contextWords, firstTokenWords, usersWords, type ContextBasis } from '../../lib/speed-at';
import { deltaWords, REREAD_SHARE, type DeltaKind } from '../bench/compare-words';
import type { DeltaView } from '../bench/delta';
import { SAME_THRESHOLD } from '../bench/delta';
import { engineLabelOf, MIB_PER_GB, modelLabelOf, prefillStat, vramFigure } from '../bench/format';
import { contextSweepOf, sessionsOf, soloPoint, writeStat } from '../bench/sessions-view';
import { recommendedIndex } from '../tune/tune-logic';
import type { CompareRef } from '../../lib/compare-selection';

/** One thing being compared, with every number the comparison can use. */
export interface CompareItem {
  ref: CompareRef;
  run: RunResult;
  /** The "Trova le impostazioni migliori" combination compared (its index in run.tuning.combinations). */
  comboIndex?: number;
  combo?: TuneCombination;
  /** Speed by context, one point per grid depth, shallow first. */
  points: DepthPoint[];
  /** Users at once, fewest first, and the prompt each user sent. */
  concurrency: ConcurrencyPoint[];
  usersPrompt?: number;
  sessions: SessionsPoint[];
  vramMiB?: number;
  /** The largest context it ran with (a tune combination: the largest that fit in the card). */
  maxContext?: number;
  /** Tokens its KV cache holds, as the engine said. */
  kvTokens?: number;
  /** How the engine was started (a combination: its own settings and command). */
  params: LaunchParams;
  argv: readonly string[];
  spill: boolean;
}

export interface DepthPoint {
  /** The grid depth (32 624 tokens of a 32K context count as 32K). */
  depth: number;
  point: LatencyPoint;
  basis: ContextBasis;
}

const byDepth = (points: readonly LatencyPoint[], basis: ContextBasis): DepthPoint[] => points.map((point) => ({ depth: nominalDepth(point.promptTokens), point, basis }));

/** Speed points of a run: the latency step (prompt lengths) first, then the context sweep for the depths it adds. */
function runPoints(run: RunResult): DepthPoint[] {
  const out = new Map<number, DepthPoint>();
  for (const p of [...byDepth(run.metrics.latency, 'prompt'), ...byDepth(contextSweepOf(run), 'depth')]) if (!out.has(p.depth)) out.set(p.depth, p);
  return [...out.values()];
}

/** The prompt each user sent: from the points, else from the scenario or the multi-user search. */
function usersPromptOf(run: RunResult, points: readonly ConcurrencyPoint[]): number | undefined {
  const fromPoints = points.find((p) => p.promptTokens !== undefined)?.promptTokens;
  if (fromPoints !== undefined) return fromPoints;
  const step = run.scenario.steps.find((s) => s.kind === 'concurrency');
  return step?.kind === 'concurrency' ? step.promptTokens : run.tuning?.multi?.promptTokens;
}

/**
 * The item for a run, or one of its tune combinations (default: the recommended one). A tune run
 * whose search measured nothing is compared with what its own metrics have.
 */
export function itemOf(run: RunResult, ref: CompareRef = { runId: run.id }): CompareItem {
  const index = run.tuning ? (ref.combo !== undefined && run.tuning.combinations[ref.combo] ? ref.combo : recommendedIndex(run.tuning)) : undefined;
  const combo = index === undefined ? undefined : run.tuning!.combinations[index]!;
  // The run's own measurements belong to its recommended combination only (or to a run without a search).
  const own = index === undefined || index === recommendedIndex(run.tuning!);
  const concurrency = [...(combo?.concurrency ?? (own ? run.metrics.concurrency : []))].sort((a, b) => a.level - b.level);
  const params = combo?.params ?? run.launch.params;
  const argv = combo?.command.argv ?? run.launch.argv;
  const vram = combo?.vramPeakMiB ?? vramFigure(run.metrics.vram)?.mib;
  const maxContext = combo?.maxContext ?? configParamsOf({ engineKind: run.engine.kind, params, argv, image: run.engine.image, modelContext: run.model.facts?.contextLength }).contextSize;
  const kvTokens = combo ? run.tuning!.attempts.find((a) => a.combination === index && a.kvTokens !== undefined)?.kvTokens : run.metrics.kvCapacity?.tokens;
  const usersPrompt = usersPromptOf(run, concurrency);
  const item: CompareItem = {
    ref: index === undefined ? { runId: run.id } : { runId: run.id, combo: index },
    run,
    points: (combo?.sweep.length ? byDepth(combo.sweep, 'depth') : own ? runPoints(run) : []).sort((a, b) => a.depth - b.depth),
    concurrency,
    sessions: combo?.sessions ?? (own ? sessionsOf(run) : []),
    params,
    argv,
    spill: spilledRun(run),
  };
  if (combo) Object.assign(item, { combo, comboIndex: index });
  if (usersPrompt !== undefined) item.usersPrompt = usersPrompt;
  if (vram !== undefined) item.vramMiB = vram;
  if (maxContext !== undefined) item.maxContext = maxContext;
  if (kvTokens !== undefined) item.kvTokens = kvTokens;
  return item;
}

/** "A", "B", "C", "D": how items are named next to their color. */
export const LETTERS = ['A', 'B', 'C', 'D'] as const;

/** "A · Qwen3 8B · Q4_K_M". */
export function itemName(item: Pick<CompareItem, 'run'>, i: number): string {
  return `${LETTERS[i]} · ${modelLabelOf(item.run.model)}`;
}

/** "A · Qwen3 8B": short enough for a chart legend. */
export function itemShortName(item: Pick<CompareItem, 'run'>, i: number): string {
  return `${LETTERS[i]} · ${item.run.model.displayName}`;
}

/**
 * "llama.cpp b11438 (CUDA 13.4)"; a custom engine (a fork) says what it is built on, so it never
 * looks like the engine itself: "PrismML fork (llama.cpp) b11460 (CUDA 13.4)".
 */
export function engineName(engine: EngineIdentity, f: Pick<Formatters, 't'>): string {
  const custom = engine.customEngine;
  if (!custom) return engineLabelOf(engine);
  const base = custom.base === 'openai-server' ? f.t('compare.openaiBase') : BASE_NAMES[custom.base];
  return engineLabelOf({ ...engine, name: `${custom.name} (${base})` });
}

const BASE_NAMES = { llamacpp: 'llama.cpp', vllm: 'vLLM', sglang: 'SGLang', ninfer: 'NInfer' } as const;

// ---- "Confronta a": the depths every item (or at least two) measured --------------------------------

export interface DepthChoice {
  depth: number;
  /** Items with a generation speed at this depth. */
  measured: number;
  total: number;
}

export function pointAtDepth(item: Pick<CompareItem, 'points'>, depth: number | undefined): DepthPoint | undefined {
  return item.points.find((p) => p.depth === depth);
}

/** Depths measured by at least two items, shallow first (a depth only one of them measured compares nothing). */
export function depthChoices(items: readonly Pick<CompareItem, 'points'>[]): DepthChoice[] {
  const counts = new Map<number, number>();
  for (const item of items) for (const p of item.points) counts.set(p.depth, (counts.get(p.depth) ?? 0) + 1);
  return [...counts]
    .filter(([, n]) => n >= 2)
    .map(([depth, measured]) => ({ depth, measured, total: items.length }))
    .sort((a, b) => a.depth - b.depth);
}

/** The headline prompt of a run: the depth "Confronta a" starts closest to. */
export const EVERYDAY_DEPTH = 512;

/**
 * The depth to start from: the one most items measured; among those, the closest to everyday prompts
 * (512 tokens, the result page's headline), the deeper on a tie.
 */
export function defaultDepth(choices: readonly DepthChoice[]): number | undefined {
  const top = Math.max(0, ...choices.map((c) => c.measured));
  const distance = (d: number) => Math.abs(Math.log2(d / EVERYDAY_DEPTH));
  const best = choices.filter((c) => c.measured === top).sort((a, b) => distance(a.depth) - distance(b.depth) || b.depth - a.depth)[0];
  return best?.depth;
}

// ---- users at once: the same number of users with the same prompt each -----------------------------

export interface UsersChoice {
  users: number;
  /** The prompt every user sent (grid depth), when known. */
  prompt?: number;
  /** Items that measured this level with this prompt. */
  items: number[];
}

const usersKey = (users: number, prompt: number | undefined) => `${users}@${prompt === undefined ? '?' : nominalDepth(prompt)}`;

/** The level with more than one user that most items measured with the same prompt each (ties: more users). */
export function usersChoice(items: readonly Pick<CompareItem, 'concurrency' | 'usersPrompt'>[]): UsersChoice | undefined {
  const groups = new Map<string, UsersChoice>();
  items.forEach((item, i) => {
    for (const p of item.concurrency) {
      if (p.level < 2) continue;
      const key = usersKey(p.level, item.usersPrompt);
      const g = groups.get(key) ?? { users: p.level, ...(item.usersPrompt === undefined ? {} : { prompt: item.usersPrompt }), items: [] };
      g.items.push(i);
      groups.set(key, g);
    }
  });
  return [...groups.values()].filter((g) => g.items.length >= 2).sort((a, b) => b.items.length - a.items.length || b.users - a.users)[0];
}

/** An item's point at the chosen users level (only when it sent the same prompt). */
export function usersPoint(item: Pick<CompareItem, 'concurrency' | 'usersPrompt'>, i: number, choice: UsersChoice | undefined): ConcurrencyPoint | undefined {
  return choice?.items.includes(i) ? item.concurrency.find((p) => p.level === choice.users) : undefined;
}

// ---- long conversations: one conversation alone at the same first-message depth ----------------------

/** The first-message depth most items measured one long conversation alone at (ties: deeper). */
export function sessionsDepth(items: readonly Pick<CompareItem, 'sessions'>[]): number | undefined {
  const counts = new Map<number, number>();
  for (const item of items) {
    const solo = soloPoint(item.sessions);
    if (solo) counts.set(nominalDepth(solo.depth), (counts.get(nominalDepth(solo.depth)) ?? 0) + 1);
  }
  return [...counts].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0];
}

function soloAt(item: Pick<CompareItem, 'sessions'>, depth: number | undefined): SessionsPoint | undefined {
  const solo = soloPoint(item.sessions);
  return solo && nominalDepth(solo.depth) === depth ? solo : undefined;
}

// ---- the rows -------------------------------------------------------------------------------------

export type RowGroup = 'speed' | 'memory' | 'users' | 'sessions' | 'other';
export const ROW_GROUPS: readonly RowGroup[] = ['speed', 'memory', 'users', 'sessions', 'other'];

export interface CompareRow {
  id: string;
  group: RowGroup;
  /** "Generazione (tok/s)". */
  label: string;
  /** What every number of the row was measured on: "scrittura con 4.096 token già nel contesto". */
  context?: string;
  values: (number | undefined)[];
  higherIsBetter: boolean;
  kind: DeltaKind;
  format: (v: number) => string;
  /** The later messages read the whole context again on that item ("riletto da capo"). */
  reread?: boolean[];
  /** Items with the best value (more than one: equal within half a percent); empty below two values. */
  best: number[];
  /** Each other item against the best, in words ("2,2 volte più lento", "−16%"). */
  words: (DeltaView | undefined)[];
}

type RowInput = Omit<CompareRow, 'best' | 'words'>;
export type CompareFormatters = Pick<Formatters, 't' | 'number' | 'integer' | 'percent' | 'duration'>;

/** The best value(s) of a row and how far every other one is from it. */
export function judge(row: RowInput, f: Pick<Formatters, 't' | 'number' | 'percent'>): CompareRow {
  const known = row.values.flatMap((v, i) => (v === undefined ? [] : [{ v, i }]));
  if (known.length < 2) return { ...row, best: [], words: row.values.map(() => undefined) };
  const top = known.reduce((a, b) => ((row.higherIsBetter ? b.v > a.v : b.v < a.v) ? b : a)).v;
  const tied = (v: number) => (top === 0 ? v === 0 : Math.abs(v - top) / Math.abs(top) < SAME_THRESHOLD);
  const best = known.filter((k) => tied(k.v)).map((k) => k.i);
  return {
    ...row,
    best,
    words: row.values.map((v, i) => (v === undefined || best.includes(i) ? undefined : deltaWords(top, v, row, f))),
  };
}

const reread = (p: SessionsPoint | undefined): boolean => {
  const share = p?.laterTurns?.cachedShare;
  return share !== undefined && share.n > 0 && share.median < REREAD_SHARE;
};

/**
 * Every row of the comparison: speeds at `depth` (generation, prompt reading, first token), memory and
 * context, users at once, long conversations and the rest. A row nobody measured is left out.
 */
export function compareRows(items: readonly CompareItem[], depth: number | undefined, f: CompareFormatters): CompareRow[] {
  const { t, number, integer, percent, duration } = f;
  const tps1 = (v: number) => `${number(v, 1)} tok/s`;
  const tps0 = (v: number) => `${integer(v)} tok/s`;
  const sec = (v: number) => `${number(v / 1000, 2)} s`;
  const ms = (v: number) => `${integer(v)} ms`;
  const rows: RowInput[] = [];
  if (depth !== undefined) {
    const at = items.map((it) => pointAtDepth(it, depth));
    const basis: ContextBasis = at.some((p) => p?.basis === 'prompt') ? 'prompt' : 'depth';
    rows.push(
      { id: 'decode', group: 'speed', label: t('compare.rows.decode'), context: contextWords({ kind: 'write', tokens: depth }, f), values: at.map((p) => p?.point.decodeTps.median), higherIsBetter: true, kind: 'speed', format: tps1 },
      { id: 'prefill', group: 'speed', label: t('compare.rows.prefill'), context: contextWords({ kind: 'read', tokens: depth, basis }, f), values: at.map((p) => (p ? prefillStat(p.point).median : undefined)), higherIsBetter: true, kind: 'speed', format: tps0 },
      { id: 'ttft', group: 'speed', label: t('compare.rows.ttft'), context: firstTokenWords(depth, basis, f), values: at.map((p) => p?.point.ttftMs.median), higherIsBetter: false, kind: 'time', format: ms },
    );
  }
  rows.push(
    { id: 'maxContext', group: 'memory', label: t('compare.rows.maxContext'), context: t('compare.rows.maxContextHint'), values: items.map((it) => it.maxContext), higherIsBetter: true, kind: 'amount', format: (v) => `${integer(v)} token` },
    { id: 'vram', group: 'memory', label: t('compare.rows.vram'), values: items.map((it) => it.vramMiB), higherIsBetter: false, kind: 'amount', format: (v) => `${number(v / MIB_PER_GB, 1)} GB` },
    { id: 'kvTokens', group: 'memory', label: t('compare.rows.kvTokens'), context: t('compare.rows.kvTokensHint'), values: items.map((it) => it.kvTokens), higherIsBetter: true, kind: 'amount', format: (v) => `${integer(v)} token` },
  );
  const users = usersChoice(items);
  if (users) {
    const at = items.map((it, i) => usersPoint(it, i, users));
    const context = usersWords(users.users, users.prompt, f);
    rows.push(
      { id: 'perUser', group: 'users', label: t('compare.rows.perUser'), context, values: at.map((p) => p?.perRequestDecodeTpsP50), higherIsBetter: true, kind: 'speed', format: tps1 },
      { id: 'total', group: 'users', label: t('compare.rows.total'), context, values: at.map((p) => p?.aggregateTps), higherIsBetter: true, kind: 'speed', format: tps0 },
      { id: 'usersTtft', group: 'users', label: t('compare.rows.usersTtft'), context, values: at.map((p) => p?.ttftP95Ms), higherIsBetter: false, kind: 'time', format: ms },
    );
  }
  const sd = sessionsDepth(items);
  if (sd !== undefined) {
    const at = items.map((it) => soloAt(it, sd));
    // The exact depth when every one of them used it (200 000 tokens), else the grid depth they share.
    const exact = new Set(at.flatMap((p) => (p ? [p.depth] : [])));
    const d = { depth: integer(exact.size === 1 ? [...exact][0]! : sd) };
    const later = (p: SessionsPoint | undefined) => (p?.laterTurns && p.laterTurns.ttftMs.n > 0 ? p.laterTurns.ttftMs.median : undefined);
    const share = (p: SessionsPoint | undefined) => (p?.laterTurns?.cachedShare && p.laterTurns.cachedShare.n > 0 ? p.laterTurns.cachedShare.median : undefined);
    rows.push(
      { id: 'sessionsRead', group: 'sessions', label: t('longConversations.compare.readAt', d), values: at.map((p) => p?.aggregatePrefillTps), higherIsBetter: true, kind: 'speed', format: tps0 },
      { id: 'sessionsWrite', group: 'sessions', label: t('longConversations.compare.writeAt', d), values: at.map((p) => (p ? writeStat(p).median : undefined)), higherIsBetter: true, kind: 'speed', format: tps1 },
      { id: 'firstWait', group: 'sessions', label: t('longConversations.compare.firstWaitAt', d), values: at.map((p) => p?.firstTurn.ttftMs.median), higherIsBetter: false, kind: 'time', format: duration },
      { id: 'laterWait', group: 'sessions', label: t('longConversations.compare.laterWaitAt', d), values: at.map(later), higherIsBetter: false, kind: 'time', format: duration, reread: at.map(reread) },
      { id: 'reuse', group: 'sessions', label: t('longConversations.compare.reuseAt', d), values: at.map(share), higherIsBetter: true, kind: 'amount', format: (v) => percent(v, 1) },
    );
  }
  const load = (pick: (r: RunResult) => number | undefined) => items.map((it) => (it.combo ? undefined : pick(it.run)));
  rows.push(
    { id: 'warm', group: 'other', label: t('compare.rows.warm'), values: load((r) => r.metrics.load.warmMs?.median), higherIsBetter: false, kind: 'time', format: sec },
    { id: 'cold', group: 'other', label: t('compare.rows.cold'), values: load((r) => r.metrics.load.coldMs?.median), higherIsBetter: false, kind: 'time', format: sec },
    { id: 'efficiency', group: 'other', label: t('compare.rows.efficiency'), values: load((r) => r.metrics.energy.tokensPerJoule), higherIsBetter: true, kind: 'amount', format: (v) => `${number(v, 2)} tok/J` },
    { id: 'score', group: 'other', label: t('compare.rows.score'), values: load((r) => r.metrics.score?.value), higherIsBetter: true, kind: 'amount', format: integer },
  );
  // A number nobody measured says nothing.
  return rows.filter((r) => r.values.some((v) => v !== undefined)).map((r) => judge(r, f));
}

export type RowLead = { winner: number; tie: true } | { winner: number; tie: false; second: number; diff: string };

/**
 * The best item of a row against the runner-up (the best of the others), with the difference in
 * words ("2,2 volte più veloce", "+16%"); `tie` when every measured item has the best value;
 * undefined below two values.
 */
export function rowLead(row: CompareRow, f: Pick<Formatters, 't' | 'number' | 'percent'>): RowLead | undefined {
  if (!row.best.length) return undefined;
  const winner = row.best[0]!;
  const others = row.values.flatMap((v, i) => (v === undefined || row.best.includes(i) ? [] : [{ v, i }]));
  if (!others.length) return { winner, tie: true };
  const second = others.reduce((a, b) => ((row.higherIsBetter ? b.v > a.v : b.v < a.v) ? b : a));
  const top = row.values[winner]!;
  // Against nothing (0% of the context reused) there is no ratio: both numbers, in words.
  const words = deltaWords(second.v, top, row, f);
  return { winner, tie: false, second: second.i, diff: words ? words.text : f.t('compare.vsZero', { value: row.format(top), other: row.format(second.v) }) };
}

/**
 * "In breve": who writes faster and who reads faster at the compared depth, in one sentence each,
 * against the runner-up. Nothing when fewer than two items measured it.
 */
export function leadSentences(items: readonly CompareItem[], rows: readonly CompareRow[], f: CompareFormatters): string[] {
  const out: string[] = [];
  for (const id of ['decode', 'prefill'] as const) {
    const row = rows.find((r) => r.id === id);
    const lead = row && rowLead(row, f);
    if (!lead) continue;
    const value = row.format(row.values[lead.winner]!);
    const context = row.context!;
    out.push(
      lead.tie
        ? f.t(`compare.lead.${id}Tie`, { value, context })
        : f.t(`compare.lead.${id}`, { name: itemName(items[lead.winner]!, lead.winner), value, context, diff: lead.diff, other: itemName(items[lead.second]!, lead.second), otherValue: row.format(row.values[lead.second]!) }),
    );
  }
  return out;
}
