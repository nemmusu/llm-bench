/**
 * The comparison as data: two to four things (a run, or one combination of a "Trova le impostazioni
 * migliori" run) side by side. Speeds are compared where every one of them really measured them,
 * never estimated ("Confronta a"): each at its own largest context with the context full ("Contesto
 * massimo", as the tune ranking: only those with the same context compare), or one grid depth for
 * all. The best number of each row is marked and every other one says how far it is, in words
 * ("2,2 volte più lento", "−16%").
 */
import { configParamsOf, sweepDepths } from '../../../contract/configs';
import type { LaunchParams } from '../../../contract/engines';
import { fillsContext, nominalDepth, spilledRun, type ConcurrencyPoint, type EngineIdentity, type LatencyPoint, type RunResult, type SessionsPoint, type TuneCombination } from '../../../contract/results';
import type { Formatters } from '../../i18n';
import { contextShort, contextWords, firstTokenWords, notMeasuredAt, tokensK, usersWords, type ContextBasis } from '../../lib/speed-at';
import { AT_MAX, type CompareAt } from '../configs/depths';
import { deltaWords, REREAD_SHARE, type DeltaKind } from '../bench/compare-words';
import type { DeltaView } from '../bench/delta';
import { SAME_THRESHOLD } from '../bench/delta';
import { engineLabelOf, MIB_PER_GB, modelLabelOf, prefillStat, vramFigure } from '../bench/format';
import { contextSweepOf, sessionsOf, soloPoint, writeStat } from '../bench/sessions-view';
import { KV_PRECISION, recommendedIndex } from '../tune/tune-logic';
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
  /** Its point with its largest context full (the deepest one, when it fills maxContext): where "Contesto massimo" reads it. */
  full?: DepthPoint;
  /** How the engine was started (a combination: its own settings and command). */
  params: LaunchParams;
  argv: readonly string[];
  spill: boolean;
}

export interface DepthPoint {
  /**
   * The grid depth (32 624 tokens of a 32K context count as 32K; a sweep's point with the context full
   * stands at the context: 261 200 or 255 000 tokens of a 256K context are "256K").
   */
  depth: number;
  point: LatencyPoint;
  basis: ContextBasis;
}

const byPrompt = (points: readonly LatencyPoint[]): DepthPoint[] => points.map((point) => ({ depth: nominalDepth(point.promptTokens), point, basis: 'prompt' }));

/** A context sweep at `context` tokens by grid depth, its deepest point with the context full at the context (sweepDepths). */
function bySweep(points: readonly LatencyPoint[], context: number | undefined): DepthPoint[] {
  const depths = sweepDepths(points.map((p) => p.promptTokens), context);
  return points.map((point, i) => ({ depth: depths[i]!, point, basis: 'depth' }));
}

/** Speed points of a run: the latency step (prompt lengths) first, then the context sweep for the depths it adds. */
function runPoints(run: RunResult, context: number | undefined): DepthPoint[] {
  const out = new Map<number, DepthPoint>();
  for (const p of [...byPrompt(run.metrics.latency), ...bySweep(contextSweepOf(run), context)]) if (!out.has(p.depth)) out.set(p.depth, p);
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
    points: (combo?.sweep.length ? bySweep(combo.sweep, combo.maxContext) : own ? runPoints(run, maxContext) : []).sort((a, b) => a.depth - b.depth),
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
  // Points go shallow to deep: the last one is the deepest.
  const deepest = item.points[item.points.length - 1];
  if (deepest && maxContext !== undefined && fillsContext(deepest.point.promptTokens, maxContext)) item.full = deepest;
  return item;
}

/** "A", "B", "C", "D": how items are named next to their color. */
export const LETTERS = ['A', 'B', 'C', 'D'] as const;

/** "A · Qwen3 8B · Q4_K_M". */
export function itemName(item: Pick<CompareItem, 'run'>, i: number): string {
  return `${LETTERS[i]} · ${modelLabelOf(item.run.model)}`;
}

/** Longest model name in a chart legend: four of them fit side by side in half a 1366 px window. */
export const LEGEND_NAME = 24;

/** "A · Qwen3 8B": short enough for a chart legend (a longer name ends with "…"; the cards above say it whole). */
export function itemShortName(item: Pick<CompareItem, 'run'>, i: number): string {
  const name = item.run.model.displayName;
  return `${LETTERS[i]} · ${name.length > LEGEND_NAME ? `${name.slice(0, LEGEND_NAME - 1)}…` : name}`;
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

/** The depth of every item's largest context full, when every item has one and it is the same for all (two 256K combinations: "256K"). */
export function fullDepth(items: readonly Pick<CompareItem, 'full'>[]): number | undefined {
  const depths = new Set(items.map((it) => it.full?.depth));
  const [only] = depths;
  return depths.size === 1 ? only : undefined;
}

/** "Contesto massimo" is a choice when at least two items were measured with their largest context full. */
export function maxChoice(items: readonly Pick<CompareItem, 'full'>[]): { measured: number; total: number } | undefined {
  const measured = items.filter((it) => it.full).length;
  return measured >= 2 ? { measured, total: items.length } : undefined;
}

/**
 * The depth to start from among plain depths: `full` (the context full of every item, see fullDepth)
 * when every item measured it; else the one most items measured, among those the closest to everyday
 * prompts (512 tokens, the result page's headline), the deeper on a tie.
 */
export function defaultDepth(choices: readonly DepthChoice[], full?: number): number | undefined {
  if (choices.some((c) => c.depth === full && c.measured === c.total)) return full;
  const top = Math.max(0, ...choices.map((c) => c.measured));
  const distance = (d: number) => Math.abs(Math.log2(d / EVERYDAY_DEPTH));
  const best = choices.filter((c) => c.measured === top).sort((a, b) => distance(a.depth) - distance(b.depth) || b.depth - a.depth)[0];
  return best?.depth;
}

/**
 * Where the comparison starts, coherent with the contexts the cards show:
 *  - every item with its largest context full, the same for all: that depth ("256K");
 *  - every item with its largest context full, different ones: "Contesto massimo" (each at its own);
 *  - a "Trova le impostazioni migliori" combination among them (its card says its context): the
 *    deepest depth every item measured, the closest to the contexts shown;
 *  - else plain runs: defaultDepth (closest to everyday prompts, as their result pages).
 */
export function defaultAt(items: readonly Pick<CompareItem, 'full' | 'combo'>[], choices: readonly DepthChoice[]): CompareAt | undefined {
  const full = fullDepth(items);
  if (full !== undefined && choices.some((c) => c.depth === full && c.measured === c.total)) return full;
  if (items.length > 0 && items.every((it) => it.full)) return AT_MAX;
  const all = choices.filter((c) => c.measured === c.total);
  if (items.some((it) => it.combo) && all.length) return all[all.length - 1]!.depth;
  return defaultDepth(choices);
}

/** "Confronta a" from the address when it is one of the choices, else the default. */
export function compareAtOf(items: readonly Pick<CompareItem, 'full' | 'combo'>[], choices: readonly DepthChoice[], at: CompareAt | undefined): CompareAt | undefined {
  if (at === AT_MAX ? maxChoice(items) : choices.some((c) => c.depth === at)) return at;
  return defaultAt(items, choices);
}

/** An item's point where the comparison reads it: its own largest context full, or the depth. */
export function pointAt(item: Pick<CompareItem, 'points' | 'full'>, at: CompareAt | undefined): DepthPoint | undefined {
  return at === AT_MAX ? item.full : pointAtDepth(item, at);
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

export type RowGroup = 'speed' | 'best' | 'memory' | 'users' | 'sessions' | 'other';
export const ROW_GROUPS: readonly RowGroup[] = ['speed', 'best', 'memory', 'users', 'sessions', 'other'];

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
  /** What "Chi va più veloce" says the numbers were measured on, when not `context` ("con il contesto pieno a 256K"). */
  leadContext?: string;
  /** What the row's number means, in a few sentences (a help tip next to the label). */
  help?: string;
  /** The later messages read the whole context again on that item ("riletto da capo"). */
  reread?: boolean[];
  /**
   * Items whose number is not compared with the others (false): at "Contesto massimo", a smaller
   * context than the largest one (speeds at different contexts do not compare). Default: all.
   */
  compared?: boolean[];
  /** No winner: the numbers are shown side by side, not ranked (what they mean differs between engines). */
  plain?: boolean;
  /** What each number was measured at, under it ("a 1K di contesto"): a row whose items each have their own depth. */
  notes?: (string | undefined)[];
  /** Why an item has no number ("non misurata a 256K", "arriva solo a 208K", "il motore non lo dice"); default "non misurato". */
  missing?: (string | undefined)[];
  /** Items with the best value (more than one: equal within half a percent); empty below two values. */
  best: number[];
  /** Each other item against the best, in words ("2,2 volte più lento", "−16%"). */
  words: (DeltaView | undefined)[];
}

type RowInput = Omit<CompareRow, 'best' | 'words'>;
export type CompareFormatters = Pick<Formatters, 't' | 'number' | 'integer' | 'percent' | 'duration'>;

/**
 * The best value(s) of a row and how far every other one is from it. A `plain` row has no winner: only
 * "the same for all" is said (every value equal).
 */
export function judge(row: RowInput, f: Pick<Formatters, 't' | 'number' | 'percent'>): CompareRow {
  const known = row.values.flatMap((v, i) => (v === undefined || row.compared?.[i] === false ? [] : [{ v, i }]));
  const none = { ...row, best: [], words: row.values.map(() => undefined) };
  if (known.length < 2) return none;
  const top = known.reduce((a, b) => ((row.higherIsBetter ? b.v > a.v : b.v < a.v) ? b : a)).v;
  const tied = (v: number) => (top === 0 ? v === 0 : Math.abs(v - top) / Math.abs(top) < SAME_THRESHOLD);
  const best = known.filter((k) => tied(k.v)).map((k) => k.i);
  if (row.plain) return best.length === known.length ? { ...none, best } : none;
  return {
    ...row,
    best,
    words: row.values.map((v, i) => (v === undefined || best.includes(i) || row.compared?.[i] === false ? undefined : deltaWords(top, v, row, f))),
  };
}

const reread = (p: SessionsPoint | undefined): boolean => {
  const share = p?.laterTurns?.cachedShare;
  return share !== undefined && share.n > 0 && share.median < REREAD_SHARE;
};

/** The engine a run's numbers come from: "vllm", "llamacpp", "sglang", "ninfer"… (a fork: the engine it is built on). */
export function engineBase(run: Pick<RunResult, 'engine'>): string {
  return run.engine.customEngine?.base ?? run.engine.kind.split('-')[0]!;
}

/** vLLM, SGLang and TensorRT-LLM reserve a share of the card's memory when they start (gpu-memory-utilization / mem-fraction / kv_cache_free_gpu_memory_fraction). */
export function reservesMemory(run: Pick<RunResult, 'engine'>): boolean {
  const base = engineBase(run);
  return base === 'vllm' || base === 'sglang' || base === 'trtllm';
}

/**
 * Why an item has no speed where the comparison reads it: at "Contesto massimo", its largest context
 * was never filled ("non misurata a 256K · misurata solo fino a 64K"); at a depth beyond its context,
 * it cannot get there ("arriva solo a 208K"); else it was not measured there ("non misurata a 64K").
 */
export function missingSpeed(item: { points: readonly { depth: number }[]; maxContext?: number | undefined }, at: CompareAt, f: CompareFormatters): string {
  if (at !== AT_MAX) return item.maxContext !== undefined && item.maxContext < at ? f.t('compare.reachesOnly', { ctx: tokensK(item.maxContext, f) }) : notMeasuredAt(at, f);
  if (item.maxContext === undefined) return f.t('compare.notMeasured');
  const head = notMeasuredAt(item.maxContext, f);
  return item.points.length ? f.t('compare.onlyUpTo', { head, depth: tokensK(Math.max(...item.points.map((p) => p.depth)), f) }) : head;
}

/** "Velocità": generation, prompt reading and first token where the comparison reads them. */
function speedRows(items: readonly CompareItem[], at: CompareAt, f: CompareFormatters): RowInput[] {
  const { t, number, integer } = f;
  const points = items.map((it) => pointAt(it, at));
  const missing = items.map((it, i) => (points[i] ? undefined : missingSpeed(it, at, f)));
  let ctx: { write: string; read: string; first: string };
  let extra: Pick<RowInput, 'compared' | 'leadContext'> = {};
  if (at === AT_MAX) {
    // Each at its own context, full: only those with the largest one compare (as the tune ranking).
    const depths = points.flatMap((p) => (p ? [p.depth] : []));
    const top = Math.max(0, ...depths);
    const full = t('compare.rows.atFull', { ctx: tokensK(top, f) });
    const words = new Set(depths).size > 1 ? t('compare.rows.atMax') : full;
    ctx = { write: words, read: words, first: words };
    extra = { compared: points.map((p) => p?.depth === top), leadContext: full };
  } else {
    const basis: ContextBasis = points.some((p) => p?.basis === 'prompt') ? 'prompt' : 'depth';
    ctx = { write: contextWords({ kind: 'write', tokens: at }, f), read: contextWords({ kind: 'read', tokens: at, basis }, f), first: firstTokenWords(at, basis, f) };
  }
  const common = { group: 'speed' as const, missing, ...extra };
  return [
    { ...common, id: 'decode', label: t('compare.rows.decode'), context: ctx.write, values: points.map((p) => p?.point.decodeTps.median), higherIsBetter: true, kind: 'speed', format: (v) => `${number(v, 1)} tok/s` },
    { ...common, id: 'prefill', label: t('compare.rows.prefill'), context: ctx.read, values: points.map((p) => (p ? prefillStat(p.point).median : undefined)), higherIsBetter: true, kind: 'speed', format: (v) => `${integer(v)} tok/s` },
    { ...common, id: 'ttft', label: t('compare.rows.ttft'), context: ctx.first, values: points.map((p) => p?.point.ttftMs.median), higherIsBetter: false, kind: 'time', format: f.duration },
  ];
}

/**
 * Where an item's speeds were read, said once on its column: at "Contesto massimo" each column has its
 * own context ("Velocità con il contesto pieno a 208K"), or that it never filled it; nothing at one depth for all.
 */
export function speedsWhere(item: Pick<CompareItem, 'full' | 'maxContext'>, at: CompareAt | undefined, f: CompareFormatters): string | undefined {
  if (at !== AT_MAX) return undefined;
  if (item.full) return f.t('compare.card.speedsFull', { ctx: tokensK(item.full.depth, f) });
  return item.maxContext === undefined ? undefined : f.t('compare.card.speedsNotFull', { ctx: tokensK(item.maxContext, f) });
}

/** The point where an item writes (or reads) fastest, among everything it measured. */
export function peakPoint(item: Pick<CompareItem, 'points'>, kind: 'write' | 'read'): DepthPoint | undefined {
  const speed = (p: DepthPoint) => (kind === 'write' ? p.point.decodeTps.median : prefillStat(p.point).median);
  return item.points.reduce<DepthPoint | undefined>((best, p) => (best === undefined || speed(p) > speed(best) ? p : best), undefined);
}

/**
 * The combination of an item's search with the most precise KV cache that was measured (the best
 * quality of answers its search tried), with its largest context; undefined for a run without a search.
 */
export function preciseCombo(item: Pick<CompareItem, 'run'>): { index: number; combo: TuneCombination } | undefined {
  const list = item.run.tuning?.combinations.flatMap((combo, index) => (combo.sweep.length || combo.concurrency?.length ? [{ index, combo }] : [])) ?? [];
  return list.sort((a, b) => KV_PRECISION(a.combo.kvType) - KV_PRECISION(b.combo.kvType) || b.combo.maxContext - a.combo.maxContext || a.index - b.index)[0];
}

/**
 * "Il meglio di ognuno": what each item does at its best, every number with its own context (side by
 * side, no winner: each at a different depth). Its speeds with its largest context full (when the
 * table compares at one depth), where it writes and reads fastest, and for a search the most precise
 * KV cache it measured.
 */
function bestRows(items: readonly CompareItem[], at: CompareAt | undefined, f: CompareFormatters): RowInput[] {
  const { t, number, integer } = f;
  const tps1 = (v: number) => `${number(v, 1)} tok/s`;
  const tps0 = (v: number) => `${integer(v)} tok/s`;
  const rows: RowInput[] = [];
  const common = { group: 'best' as const, higherIsBetter: true, kind: 'speed' as const, plain: true };
  if (at !== AT_MAX && items.some((it) => it.full)) {
    const full = (it: CompareItem) => (it.full ? t('compare.rows.atFull', { ctx: tokensK(it.full.depth, f) }) : undefined);
    const missing = items.map((it) => (it.full ? undefined : missingSpeed(it, AT_MAX, f)));
    rows.push(
      { ...common, id: 'writeFull', label: t('compare.rows.writeFull'), values: items.map((it) => it.full?.point.decodeTps.median), notes: items.map(full), missing, format: tps1 },
      { ...common, id: 'readFull', label: t('compare.rows.readFull'), values: items.map((it) => (it.full ? prefillStat(it.full.point).median : undefined)), notes: items.map(full), missing, format: tps0 },
    );
  }
  const write = items.map((it) => peakPoint(it, 'write'));
  const read = items.map((it) => peakPoint(it, 'read'));
  rows.push(
    { ...common, id: 'writePeak', label: t('compare.rows.writePeak'), values: write.map((p) => p?.point.decodeTps.median), notes: write.map((p) => p && contextShort({ kind: 'write', tokens: p.depth, basis: p.basis }, f)), format: tps1 },
    { ...common, id: 'readPeak', label: t('compare.rows.readPeak'), values: read.map((p) => (p ? prefillStat(p.point).median : undefined)), notes: read.map((p) => p && contextShort({ kind: 'read', tokens: p.depth, basis: p.basis }, f)), format: tps0 },
  );
  if (items.some((it) => it.run.tuning)) {
    const precise = items.map(preciseCombo);
    rows.push({
      ...common,
      id: 'precise',
      label: t('compare.rows.precise'),
      context: t('compare.rows.preciseHint'),
      kind: 'amount',
      values: precise.map((p) => p?.combo.maxContext),
      notes: precise.map((p) => p && t('compare.rows.preciseNote', { kv: p.combo.kvType, n: p.index + 1 })),
      missing: items.map((it) => (it.run.tuning ? undefined : t('compare.rows.preciseNone'))),
      format: (v) => t('compare.rows.preciseContext', { ctx: integer(v) }),
    });
  }
  return rows;
}

/**
 * Every row of the comparison: speeds where it compares (`at`: generation, prompt reading, first
 * token), memory and context, users at once, long conversations and the rest. A row nobody measured is
 * left out.
 */
export function compareRows(items: readonly CompareItem[], at: CompareAt | undefined, f: CompareFormatters): CompareRow[] {
  const { t, number, integer, percent, duration } = f;
  const tps1 = (v: number) => `${number(v, 1)} tok/s`;
  const tps0 = (v: number) => `${integer(v)} tok/s`;
  const sec = (v: number) => `${number(v / 1000, 2)} s`;
  const rows: RowInput[] = [];
  if (at !== undefined) rows.push(...speedRows(items, at, f));
  rows.push(...bestRows(items, at, f));
  const allCombos = items.every((it) => it.combo);
  const reserves = items.some((it) => reservesMemory(it.run));
  rows.push(
    {
      id: 'maxContext',
      group: 'memory',
      label: t('compare.rows.maxContext'),
      context: t(allCombos ? 'compare.rows.maxContextFound' : 'compare.rows.maxContextHint'),
      values: items.map((it) => it.maxContext),
      higherIsBetter: true,
      kind: 'amount',
      format: (v) => t('speedAt.tokens', { n: integer(v) }),
      // The largest that fits is something a search found; a run's context is just how it was started.
      plain: !allCombos,
    },
    {
      id: 'vram',
      group: 'memory',
      label: t('compare.rows.vram'),
      ...(reserves ? { context: t('compare.rows.vramReserved'), help: t('compare.rows.vramHelp') } : {}),
      values: items.map((it) => it.vramMiB),
      higherIsBetter: false,
      kind: 'amount',
      format: (v) => `${number(v / MIB_PER_GB, 1)} GB`,
      // vLLM and SGLang take their share of the card up front, whatever the model needs: no winner.
      plain: reserves,
    },
    {
      id: 'kvTokens',
      group: 'memory',
      label: t('compare.rows.kvTokens'),
      context: t('compare.rows.kvTokensHint'),
      help: t('compare.rows.kvTokensHelp'),
      values: items.map((it) => it.kvTokens),
      higherIsBetter: true,
      kind: 'amount',
      format: (v) => t('speedAt.tokens', { n: integer(v) }),
      // Only some engines say it, each its own way: ranked only between numbers of the same engine.
      plain: new Set(items.flatMap((it) => (it.kvTokens === undefined ? [] : [engineBase(it.run)]))).size > 1,
      missing: items.map((it) => (it.kvTokens === undefined ? t('compare.notReported') : undefined)),
    },
  );
  const users = usersChoice(items);
  if (users) {
    const at = items.map((it, i) => usersPoint(it, i, users));
    const context = usersWords(users.users, users.prompt, f);
    rows.push(
      { id: 'perUser', group: 'users', label: t('compare.rows.perUser'), context, values: at.map((p) => p?.perRequestDecodeTpsP50), higherIsBetter: true, kind: 'speed', format: tps1 },
      { id: 'total', group: 'users', label: t('compare.rows.total'), context, values: at.map((p) => p?.aggregateTps), higherIsBetter: true, kind: 'speed', format: tps0 },
      { id: 'usersTtft', group: 'users', label: t('compare.rows.usersTtft'), context, values: at.map((p) => p?.ttftP95Ms), higherIsBetter: false, kind: 'time', format: duration },
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
  const others = row.values.flatMap((v, i) => (v === undefined || row.best.includes(i) || row.compared?.[i] === false ? [] : [{ v, i }]));
  if (!others.length) return { winner, tie: true };
  const second = others.reduce((a, b) => ((row.higherIsBetter ? b.v > a.v : b.v < a.v) ? b : a));
  const top = row.values[winner]!;
  // Against nothing (0% of the context reused) there is no ratio: both numbers, in words.
  const words = deltaWords(second.v, top, row, f);
  return { winner, tie: false, second: second.i, diff: words ? words.text : f.t('compare.vsZero', { value: row.format(top), other: row.format(second.v) }) };
}

/**
 * "Chi va più veloce": who writes faster and who reads faster where the table compares them, in one
 * sentence each against the runner-up, with the same context words as the table. At "Contesto
 * massimo", an item with a smaller context than the others is said apart: its speed with its own
 * context full does not compare with theirs. Nothing when fewer than two items measured it.
 */
export function leadSentences(items: readonly CompareItem[], rows: readonly CompareRow[], f: CompareFormatters): string[] {
  const out: string[] = [];
  for (const id of ['decode', 'prefill'] as const) {
    const row = rows.find((r) => r.id === id);
    const lead = row && rowLead(row, f);
    if (!lead) continue;
    const value = row.format(row.values[lead.winner]!);
    const context = row.leadContext ?? row.context!;
    const apart = row.values.some((v, i) => v !== undefined && row.compared?.[i] === false);
    out.push(
      lead.tie
        ? apart
          ? f.t(`compare.lead.${id}TieSome`, { names: row.best.map((i) => LETTERS[i]).join(', '), value, context })
          : f.t(`compare.lead.${id}Tie`, { value, context })
        : f.t(`compare.lead.${id}`, { name: itemName(items[lead.winner]!, lead.winner), value, context, diff: lead.diff, other: itemName(items[lead.second]!, lead.second), otherValue: row.format(row.values[lead.second]!) }),
    );
  }
  // At "Contesto massimo": who has a smaller context than the others, with its own speed.
  const decode = rows.find((r) => r.id === 'decode');
  decode?.values.forEach((v, i) => {
    if (v === undefined || decode.compared?.[i] !== false) return;
    out.push(f.t('compare.lead.apart', { name: itemName(items[i]!, i), ctx: tokensK(items[i]!.full!.depth, f), value: decode.format(v), top: decode.leadContext! }));
  });
  return out;
}
