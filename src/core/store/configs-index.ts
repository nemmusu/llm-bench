/**
 * Configurations index (Risultati → Configurazioni): every completed run, grouped by configuration
 * (contract/configs.ts). A source is a normal run (its latency prompt lengths and its context sweep
 * are its depths) or one combination of a "Trova le impostazioni migliori" run that loaded and was
 * swept. Sources with the same key merge: median per depth, highest VRAM peak, every test listed. A
 * run that spilled to shared system memory forms its own entry (marked), never merged with clean ones.
 */
import {
  ALL_GPUS,
  configIdOf,
  configKeyOf,
  configParamsOf,
  configTagsOf,
  engineReleaseOf,
  gpuKeyOf,
  modelKeyOf,
  type ConfigEntry,
  type ConfigGpu,
  type ConfigParams,
  type ConfigsQuery,
  type ConfigsResponse,
  type ConfigSource,
  type ConfigTag,
  type DepthPoint,
} from '../../contract/configs';
import { ENGINE_KINDS, type EngineKind, type LaunchParams } from '../../contract/engines';
import { nominalDepth, spilledRun, type LatencyPoint, type RunResult, type RunSummary, type TuneCombination } from '../../contract/results';
import { engineLabelOf, type HereIdentity, type RunsRepo } from './runs-repo';

/** One measured configuration of one run: the run itself, or one of its tune combinations. */
export interface RunConfigSource {
  source: ConfigSource;
  params: ConfigParams;
  tags: ConfigTag[];
}

/** What a run contributes: its identity (shared by all its sources) and its sources. */
export interface RunSources {
  engineKind: EngineKind;
  engineLabel: string;
  engineRelease: string;
  model: { format: string; repo?: string; revision?: string; sha256?: string; weakKey: string; name: string; quant?: string };
  gpu: { key: string; name: string; hostId: string; hostLabel: string };
  sources: RunConfigSource[];
}

const median = (values: readonly number[]): number => {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/**
 * Depth points of latency points: medians of decode, prefill (the engine's figure when it reports
 * one) and TTFT, at the nominal depth (the deepest prompt of a 32K context is "32K", so sweeps of
 * different contexts line up); the first point of a depth wins, points without any measurement are dropped.
 */
export function depthPointsOf(points: readonly LatencyPoint[]): ConfigSource['points'] {
  const out = new Map<number, ConfigSource['points'][number]>();
  for (const p of points) {
    const depth = nominalDepth(p.promptTokens);
    if (out.has(depth)) continue;
    const prefill = p.prefillTpsEngine ?? p.prefillTps;
    const point = {
      depth,
      ...(p.decodeTps.n > 0 ? { decodeTps: p.decodeTps.median } : {}),
      ...(prefill.n > 0 ? { prefillTps: prefill.median } : {}),
      ...(p.ttftMs.n > 0 ? { ttftMs: p.ttftMs.median } : {}),
    };
    if (Object.keys(point).length > 1) out.set(depth, point);
  }
  return [...out.values()].sort((a, b) => a.depth - b.depth);
}

type Launch = { params: LaunchParams; argv: readonly string[] };

function paramsOf(run: RunResult, launch: Launch): ConfigParams {
  const facts = run.model.facts;
  return configParamsOf({
    engineKind: run.engine.kind,
    params: launch.params,
    argv: launch.argv,
    image: run.engine.image,
    blockCount: facts?.blockCount,
    modelContext: facts?.contextLength,
  });
}

const union = (...lists: readonly ConfigTag[][]): ConfigTag[] => [...new Set(lists.flat())];

/** A normal run as one source: its prompt lengths and context sweep are its depths. */
function runSource(run: RunResult): RunConfigSource[] {
  const m = run.metrics;
  const points = depthPointsOf([...m.latency, ...m.contextSweep]);
  if (!points.length) return [];
  const params = paramsOf(run, run.launch);
  const vram = m.vram.processPeakMiB ?? m.vram.deltaMiB ?? m.vram.peakMiB;
  const busiest = m.concurrency.filter((p) => p.level > 1).sort((a, b) => b.level - a.level)[0];
  const source: ConfigSource = {
    runId: run.id,
    date: run.createdAt,
    profile: run.scenario.profile,
    points,
    ...(spilledRun(run) ? { spill: true } : {}),
    ...(params.contextSize !== undefined ? { contextSize: params.contextSize } : {}),
    ...(vram !== undefined ? { vramPeakMiB: vram } : {}),
    ...(busiest
      ? {
          parallel: {
            users: busiest.level,
            totalTps: busiest.aggregateTps,
            ...(busiest.perRequestDecodeTpsP50 > 0 ? { perUserTps: busiest.perRequestDecodeTpsP50 } : {}),
          },
        }
      : {}),
  };
  return [{ source, params, tags: configTagsOf(params) }];
}

/**
 * The tune combinations of a run as sources: one per combination that loaded and was swept, with
 * its own params (and command line), its largest context, VRAM peak and sweep points.
 */
export function comboSources(run: RunResult): RunConfigSource[] {
  const out: RunConfigSource[] = [];
  (run.tuning?.combinations ?? []).forEach((combo: TuneCombination, index) => {
    if (combo.outcome !== 'ok') return;
    const points = depthPointsOf(combo.sweep);
    // "Più utenti" combinations have no sweep: their users at once are what they measured.
    const busiest = (combo.concurrency ?? []).filter((p) => p.level > 1).sort((a, b) => b.level - a.level)[0];
    if (!points.length && !busiest) return;
    const params = paramsOf(run, { params: combo.params, argv: combo.command.argv });
    const source: ConfigSource = {
      runId: run.id,
      combo: index,
      date: run.createdAt,
      profile: run.scenario.profile,
      points,
      contextSize: combo.maxContext,
      ...(combo.vramPeakMiB !== undefined ? { vramPeakMiB: combo.vramPeakMiB } : {}),
      ...(busiest
        ? { parallel: { users: busiest.level, totalTps: busiest.aggregateTps, ...(busiest.perRequestDecodeTpsP50 > 0 ? { perUserTps: busiest.perRequestDecodeTpsP50 } : {}) } }
        : {}),
    };
    out.push({ source, params, tags: union(combo.tags, configTagsOf(params)) });
  });
  return out;
}

/** Everything a completed run measured, by configuration; undefined when it measured nothing at any depth. */
export function sourcesOf(run: RunResult): RunSources | undefined {
  if (run.status !== 'completed') return undefined;
  // A tune run's own launch record is one of its launches: its combinations are the measurements.
  const sources = run.tuning ? comboSources(run) : runSource(run);
  if (!sources.length) return undefined;
  const gpu = run.hardware.gpus[0];
  const m = run.model;
  return {
    engineKind: run.engine.kind,
    engineLabel: engineLabelOf(run.engine),
    engineRelease: engineReleaseOf(run.engine),
    model: {
      format: m.format,
      weakKey: m.weakKey,
      name: m.displayName,
      ...(m.repo ? { repo: m.repo } : {}),
      ...(m.revision ? { revision: m.revision } : {}),
      ...(m.sha256 ? { sha256: m.sha256 } : {}),
      ...(m.quant ? { quant: m.quant } : {}),
    },
    gpu: {
      key: gpuKeyOf({ hostId: run.hardware.hostId, gpuUuid: gpu?.uuid, gpuName: gpu?.name }),
      name: gpu?.name ?? 'unknown',
      hostId: run.hardware.hostId,
      hostLabel: run.hardware.hostLabel,
    },
    sources,
  };
}

/** Newest first; the same run twice in a group can only be two of its combinations. */
const newestFirst = (a: ConfigSource, b: ConfigSource): number =>
  Date.parse(b.date) - Date.parse(a.date) || b.runId.localeCompare(a.runId) || a.combo! - b.combo!;

interface Group {
  key: string;
  modelKey: string;
  params: ConfigParams;
  /** Each source with the run it belongs to (the newest one names the entry). */
  items: { item: RunConfigSource; run: RunSources }[];
}

function mergePoints(items: readonly RunConfigSource[]): DepthPoint[] {
  const byDepth = new Map<number, ConfigSource['points']>();
  for (const it of items) for (const p of it.source.points) byDepth.set(p.depth, [...(byDepth.get(p.depth) ?? []), p]);
  const med = (list: ConfigSource['points'], pick: (p: ConfigSource['points'][number]) => number | undefined) => {
    const values = list.map(pick).filter((v): v is number => v !== undefined);
    return values.length ? median(values) : undefined;
  };
  return [...byDepth.entries()]
    .sort(([a], [b]) => a - b)
    .map(([depth, list]) => {
      const decode = med(list, (p) => p.decodeTps);
      const prefill = med(list, (p) => p.prefillTps);
      const ttft = med(list, (p) => p.ttftMs);
      return {
        depth,
        n: list.length,
        ...(decode !== undefined ? { decodeTps: decode } : {}),
        ...(prefill !== undefined ? { prefillTps: prefill } : {}),
        ...(ttft !== undefined ? { ttftMs: ttft } : {}),
      };
    });
}

function mergeParallel(items: readonly RunConfigSource[]): ConfigEntry['parallel'] {
  const all = items.map((i) => i.source.parallel).filter((p) => p !== undefined);
  if (!all.length) return undefined;
  const users = Math.max(...all.map((p) => p.users));
  const top = all.filter((p) => p.users === users);
  const perUser = top.map((p) => p.perUserTps).filter((v): v is number => v !== undefined);
  return { users, totalTps: median(top.map((p) => p.totalTps)), ...(perUser.length ? { perUserTps: median(perUser) } : {}) };
}

/**
 * Sources with the same configuration merged into one entry each, newest first. A GGUF run before
 * its file was hashed counts as the same model as the hashed runs with its weak key.
 */
export function mergeSources(runs: readonly RunSources[]): ConfigEntry[] {
  const shaByWeak = new Map<string, string>();
  for (const r of runs) if (r.model.sha256) shaByWeak.set(r.model.weakKey, r.model.sha256);
  const groups = new Map<string, Group>();
  for (const run of runs) {
    const modelKey = modelKeyOf({ ...run.model, sha256: run.model.sha256 ?? shaByWeak.get(run.model.weakKey) });
    for (const item of run.sources) {
      // A test that spilled is its own entry: its numbers never mix with the card's real ones.
      const spill = item.source.spill === true;
      const key = configKeyOf({ engineKind: run.engineKind, engineRelease: run.engineRelease, model: modelKey, gpu: run.gpu.key, params: item.params }) + (spill ? '|spill' : '');
      const g = groups.get(key) ?? { key, modelKey, params: item.params, items: [] };
      g.items.push({ item, run });
      groups.set(key, g);
    }
  }
  const entries = [...groups.values()].map((g): ConfigEntry => {
    const sorted = [...g.items].sort((a, b) => newestFirst(a.item.source, b.item.source));
    const n = sorted[0]!.run;
    const items = sorted.map((s) => s.item);
    const sources = items.map((i) => i.source);
    const contexts = sources.map((s) => s.contextSize).filter((v): v is number => v !== undefined);
    const vram = sources.map((s) => s.vramPeakMiB).filter((v): v is number => v !== undefined);
    const parallel = mergeParallel(items);
    // The context is part of the key when the launch said it; otherwise the largest a source reports.
    const contextSize = g.params.contextSize ?? (contexts.length ? Math.max(...contexts) : undefined);
    return {
      id: configIdOf(g.key),
      engineKind: n.engineKind,
      engineLabel: n.engineLabel,
      engineRelease: n.engineRelease,
      model: {
        key: g.modelKey,
        name: n.model.name,
        weakKey: n.model.weakKey,
        ...(n.model.quant ? { quant: n.model.quant } : {}),
        ...(g.modelKey.startsWith('sha256:') ? { sha256: g.modelKey.slice('sha256:'.length) } : {}),
        ...(n.model.repo ? { repo: n.model.repo } : {}),
      },
      gpu: n.gpu,
      params: g.params,
      ...(contextSize !== undefined ? { contextSize } : {}),
      points: mergePoints(items),
      ...(vram.length ? { vramPeakMiB: Math.max(...vram) } : {}),
      ...(parallel ? { parallel } : {}),
      tags: union(...items.map((i) => i.tags)),
      ...(sources[0]!.spill ? { spill: true } : {}),
      sources,
      latest: sources[0]!.date,
    };
  });
  return entries.sort((a, b) => Date.parse(b.latest) - Date.parse(a.latest) || a.id.localeCompare(b.id));
}

/**
 * GET /api/configs: the entries of one card (the `gpu` filter; by default this PC's card, or every
 * card when this one has none yet), then model, engine and minimum context. The menus (models,
 * engines) list what the chosen card has, before the other filters.
 */
export function queryConfigs(entries: readonly ConfigEntry[], q: ConfigsQuery, here: HereIdentity): ConfigsResponse {
  const hereKey = gpuKeyOf({ hostId: here.hostId, gpuUuid: here.gpuUuid, gpuName: here.gpuName });
  const gpuMap = new Map<string, ConfigGpu>();
  for (const e of entries) {
    const g = gpuMap.get(e.gpu.key);
    if (g) g.configs++;
    else gpuMap.set(e.gpu.key, { ...e.gpu, here: e.gpu.key === hereKey, configs: 1 });
  }
  const gpus = [...gpuMap.values()].sort((a, b) => Number(b.here) - Number(a.here) || a.name.localeCompare(b.name) || a.hostLabel.localeCompare(b.hostLabel));
  const gpu = q.gpu === ALL_GPUS ? null : (q.gpu ?? (gpuMap.has(hereKey) ? hereKey : null));
  const onGpu = gpu === null ? entries : entries.filter((e) => e.gpu.key === gpu);
  const models = new Map<string, ConfigsResponse['models'][number]>();
  for (const e of onGpu) if (!models.has(e.model.key)) models.set(e.model.key, { key: e.model.key, name: e.model.name, ...(e.model.quant ? { quant: e.model.quant } : {}) });
  const engines = new Set(onGpu.map((e) => e.engineKind));
  return {
    configs: onGpu.filter(
      (e) => (!q.model || e.model.key === q.model) && (!q.engine || e.engineKind === q.engine) && (!q.minContext || (e.contextSize ?? 0) >= q.minContext),
    ),
    gpus,
    models: [...models.values()].sort((a, b) => a.name.localeCompare(b.name)),
    engines: ENGINE_KINDS.filter((k) => engines.has(k)),
    gpu,
  };
}

/**
 * The index over the results folder. RunsRepo hands back the same summary object for a file that
 * did not change, so each run is read (and its sources computed) once, until its file changes.
 */
export class ConfigsIndex {
  private readonly cache = new WeakMap<RunSummary, RunSources | null>();
  private readonly runs: Pick<RunsRepo, 'list' | 'read'>;

  constructor(runs: Pick<RunsRepo, 'list' | 'read'>) {
    this.runs = runs;
  }

  async sources(): Promise<RunSources[]> {
    const todo = (await this.runs.list()).filter((s) => s.status === 'completed');
    const out: RunSources[] = [];
    // A few files at a time: a shared folder over the network is slow.
    for (let i = 0; i < todo.length; i += 8) {
      await Promise.all(
        todo.slice(i, i + 8).map(async (s) => {
          let hit = this.cache.get(s);
          if (hit === undefined) {
            const run = await this.runs.read(s);
            // A file that could not be read now is tried again next time.
            if (!run) return;
            hit = sourcesOf(run) ?? null;
            this.cache.set(s, hit);
          }
          if (hit) out.push(hit);
        }),
      );
    }
    return out;
  }

  async query(q: ConfigsQuery, here: HereIdentity): Promise<ConfigsResponse> {
    return queryConfigs(mergeSources(await this.sources()), q, here);
  }
}
