/**
 * Spills of runs saved before GPU Bench measured the shared memory (no metrics.vram.sharedPeakMiB).
 * Nothing in such a file says that the model did not fit, yet a run that spilled generated ~10–15×
 * slower than every other run of the same model on that card: an RTX 5090 Rapido at 256K of f16 cache
 * made 3.5 tok/s where the clean runs made 54.6 and 53.7, and its numbers drove the expected durations,
 * the VRAM calibration and "Provato su questa GPU". RunsRepo recognizes them when it reads the runs,
 * so every consumer sees the flag; the files are never rewritten.
 *
 *  - candidates: completed runs that are not flagged and have no shared-memory reading, on Windows / WSL
 *    (WDDM spills instead of failing), not an external endpoint, every layer on the GPU, not a tune run
 *    (the search compares every launch with its own reference launch and reads its shared memory);
 *  - clean runs: completed, not spilled (flagged or found here), every layer on the GPU, no draft model
 *    (speculative decoding generates faster than the card alone). Tune runs count with their reference
 *    launch, else their recommended combination;
 *  - the speed compared: generation on the shortest prompt of at most 4K (SHALLOW_DEPTH);
 *  - a candidate spilled ("probabile": Spill.inferred, by ['decode-collapse']) when that speed is below
 *    SPILL_RATIO (0.4) × the median of the clean runs of the same model, engine kind, PC and card whose
 *    state is known (a shared-memory reading, or a tune run): three spilled Rapido and one clean run are
 *    three spills. Only when there is none, the other candidates are the clean runs: a run found to have
 *    spilled leaves them and the others are checked again (with as many spills as clean runs or more,
 *    nothing is flagged: in doubt, the numbers count).
 */
import { configParamsOf, configTagsOf, gpuKeyOf, type ConfigTag } from '../../contract/configs';
import type { EngineKind, LaunchParams } from '../../contract/engines';
import type { FitFixes } from '../../contract/models';
import { spilledRun, type RunResult, type RunSummary } from '../../contract/results';
import { shallowPoint, SPILL_RATIO, spillPossible } from '../bench/spill';
import { percentile } from '../bench/stats';
import { estimateFit, fitFixes, fitParamsFrom } from '../models/fit';

/** What a run says about its own speed and about a spill nobody saw: read once per file. */
export interface SpillFacts {
  id: string;
  createdAt: string;
  /** PC, card, engine kind and model: only runs sharing all four are compared. */
  hostId: string;
  gpuKey: string;
  engineKind: EngineKind;
  sha256?: string | undefined;
  weakKey: string;
  /** Generation on the shortest prompt of at most 4K, tok/s, with every layer on the GPU; absent = nothing to compare. */
  decodeTps?: number | undefined;
  /** Stands for the card's usual speed (unless found to have spilled): no draft model. */
  clean: boolean;
  /** Might have spilled unnoticed (see the candidates above). */
  legacy: boolean;
}

/** A run found to have spilled: its speed, the usual one and the clean runs it comes from (newest first). */
export interface InferredSpill {
  decodeTps: number;
  normalDecodeTps: number;
  normalRunIds: string[];
}

type Launch = { params: LaunchParams; argv: readonly string[] };

/** The speed a run is compared with and the tags of the launch that measured it. */
function measuredOf(run: RunResult): { tps: number; tags: ConfigTag[] } | undefined {
  const tags = (l: Launch, own: readonly ConfigTag[] = []): ConfigTag[] => [
    ...own,
    ...configTagsOf(configParamsOf({ engineKind: run.engine.kind, params: l.params, argv: l.argv, blockCount: run.model.facts?.blockCount })),
  ];
  const t = run.tuning;
  if (!t) {
    const p = shallowPoint([...run.metrics.latency, ...run.metrics.contextSweep]);
    return p && { tps: p.decodeTps.median, tags: tags(run.launch) };
  }
  // The reference launch: plain settings at a small context, the speed the search compares with.
  for (const a of t.attempts) {
    const p = a.stage === 'reference' && a.outcome === 'ok' ? shallowPoint(a.points) : undefined;
    if (p) return { tps: p.decodeTps.median, tags: tags({ params: a.params, argv: a.command.argv }) };
  }
  const combo = t.recommended !== undefined ? t.combinations[t.recommended] : undefined;
  const p = combo?.outcome === 'ok' ? shallowPoint(combo.sweep) : undefined;
  return p && combo && { tps: p.decodeTps.median, tags: tags({ params: combo.params, argv: combo.command.argv }, combo.tags) };
}

export function spillFactsOf(run: RunResult): SpillFacts {
  const gpu = run.hardware.gpus[0];
  const measured = run.status === 'completed' && !spilledRun(run) ? measuredOf(run) : undefined;
  const onGpu = measured !== undefined && !measured.tags.includes('cpu-offload');
  return {
    id: run.id,
    createdAt: run.createdAt,
    hostId: run.hardware.hostId,
    gpuKey: gpuKeyOf({ hostId: run.hardware.hostId, gpuUuid: gpu?.uuid, gpuName: gpu?.name }),
    engineKind: run.engine.kind,
    ...(run.model.sha256 ? { sha256: run.model.sha256 } : {}),
    weakKey: run.model.weakKey,
    ...(onGpu ? { decodeTps: measured.tps } : {}),
    clean: onGpu && !measured.tags.includes('draft'),
    legacy: onGpu && !run.tuning && run.metrics.vram.sharedPeakMiB === undefined && run.engine.kind !== 'external' && spillPossible(run.hardware.os),
  };
}

type Measured = SpillFacts & { decodeTps: number };

/** The legacy runs that spilled, by key (RunsRepo: the file). */
export function inferSpills<K>(facts: ReadonlyMap<K, SpillFacts>): Map<K, InferredSpill> {
  // A run measured before its file was hashed is the same model as the hashed runs with its weak key.
  const shaByWeak = new Map<string, string>();
  for (const f of facts.values()) if (f.sha256) shaByWeak.set(f.weakKey, f.sha256);
  const groups = new Map<string, [K, Measured][]>();
  for (const [k, f] of facts) {
    if (f.decodeTps === undefined) continue;
    const model = f.sha256 ?? shaByWeak.get(f.weakKey) ?? `weak:${f.weakKey}`;
    const key = JSON.stringify([f.hostId, f.gpuKey, f.engineKind, model]);
    groups.set(key, [...(groups.get(key) ?? []), [k, f as Measured]]);
  }
  const out = new Map<K, InferredSpill>();
  for (const members of groups.values()) {
    members.sort(([, a], [, b]) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
    const spilled = new Set<K>();
    const known = members.filter(([, g]) => g.clean && !g.legacy);
    const usual = (k: K): { tps: number; ids: string[] } | undefined => {
      const refs = (known.length ? known : members.filter(([o, g]) => o !== k && g.clean && !spilled.has(o))).map(([, g]) => g);
      return refs.length ? { tps: percentile(refs.map((g) => g.decodeTps), 50), ids: refs.map((g) => g.id) } : undefined;
    };
    // Flags only add up: a run found to have spilled leaves the clean runs, the others are checked again.
    for (let changed = true; changed; ) {
      changed = false;
      for (const [k, f] of members) {
        const normal = f.legacy && !spilled.has(k) ? usual(k) : undefined;
        if (normal && f.decodeTps < SPILL_RATIO * normal.tps) {
          spilled.add(k);
          changed = true;
        }
      }
    }
    for (const [k, f] of members) {
      if (!spilled.has(k)) continue;
      // The last run flagged had clean runs left, and nothing was flagged after it: never empty.
      const normal = usual(k)!;
      out.set(k, { decodeTps: f.decodeTps, normalDecodeTps: normal.tps, normalRunIds: normal.ids });
    }
  }
  return out;
}

/**
 * What would have fit, from the run itself (the model, the card's memory, what was in use before it
 * started) with the uncalibrated estimate: the calibration is built from the runs being read.
 */
export function legacyFixes(run: RunResult): FitFixes | undefined {
  const facts = run.model.facts;
  const gpu = run.hardware.gpus[0];
  if (!facts || !gpu) return undefined;
  const input = {
    facts,
    ...(run.model.sizeBytes ? { fileBytes: run.model.sizeBytes } : {}),
    gpu: { totalMiB: gpu.memoryTotalMiB, freeMiB: gpu.memoryTotalMiB - (run.metrics.vram.baselineMiB ?? 0) },
    engine: run.engine.kind,
  };
  const at = (p: LaunchParams) => estimateFit({ ...input, params: fitParamsFrom(p) });
  return fitFixes(run.engine.kind, run.launch.params, at(run.launch.params), at);
}

/** A summary flagged as spilled ('shared_memory_spill' comes first among the flags). */
export function flaggedSummary(s: RunSummary): RunSummary {
  return { ...s, validity: ['shared_memory_spill', ...s.validity] };
}

/** The run as it is shown and counted: flagged, with the spill's numbers and what would fit. */
export function withInferredSpill(run: RunResult, s: InferredSpill): RunResult {
  const fixes = legacyFixes(run);
  return {
    ...run,
    validity: ['shared_memory_spill', ...run.validity],
    metrics: {
      ...run.metrics,
      spill: { by: ['decode-collapse'], inferred: true, decodeTps: s.decodeTps, normalDecodeTps: s.normalDecodeTps, normalRunIds: s.normalRunIds, ...(fixes ? { fixes } : {}) },
    },
  };
}
