/** Words and short numbers for the tune screens (pure: the caller passes the formatters). */
import type { EngineKind, LaunchParams } from '../../../contract/engines';
import type { TuneAttempt, TuneCombination, TuneKvType, Tuning } from '../../../contract/results';
import type { Formatters } from '../../i18n';
import type { useConfigLabel } from '../presets/config-label';
import { capacityLead, measuredCombinations, ratioOf, recommendedIndex, speedSegments } from './tune-logic';

type F = Pick<Formatters, 't' | 'number' | 'integer'>;
export type LabelFn = ReturnType<typeof useConfigLabel>;

const K = 1024;

/** Context depths the way people say them: 32768 → "32K", 49152 → "48K", 1048576 → "1M", 30000 → "29,3K". */
export function depthLabel(n: number, f: Pick<Formatters, 'number' | 'integer'>): string {
  if (n >= K * K && n % (K * K) === 0) return `${n / (K * K)}M`;
  if (n >= K && n % K === 0) return `${n / K}K`;
  if (n >= K) return `${f.number(n / K, 1)}K`;
  return f.integer(n);
}

/** An estimate as people say it: "45 s", "20 min", "1 h 05 min" (no false precision). */
export function roughDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`;
  const min = Math.round(seconds / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}

/** An engine build or image as people read it: "b10997", a digest shortened to "sha256:1a2b3c4d5e6f"; unknown in words. */
export function buildLabel(build: string | undefined, f: Pick<Formatters, 't'>): string {
  if (build === undefined) return f.t('tune.recheck.unknownBuild');
  const digest = /^sha256:([0-9a-f]{12})[0-9a-f]+$/.exec(build);
  return digest ? `sha256:${digest[1] as string}` : build;
}

/** "q4_0", "f16"; vLLM's automatic choice in words. */
export function kvName(kv: TuneKvType, f: Pick<Formatters, 't'>): string {
  return kv === 'auto' ? f.t('tune.kvAuto') : kv;
}

/** A launch's settings in words without the context (it has its own column): "Cache KV q4_0 · flash attention · ub 2048". */
export function settingsText(params: LaunchParams, engineKind: EngineKind, label: LabelFn): string {
  return label(params, engineKind, { context: false }).text;
}

/** A combination's settings plus its slower-by-design traits: "Cache KV q4_0 · flash attention · parte sulla CPU". */
export function comboText(combo: Pick<TuneCombination, 'params' | 'tags'>, engineKind: EngineKind, label: LabelFn): string {
  return label(combo.params, engineKind, { context: false, tags: combo.tags }).text;
}

/** ✓ caricato / memoria esaurita / usa la RAM condivisa (lento) / errore / scartata. */
export function outcomeText(a: Pick<TuneAttempt, 'outcome' | 'screen' | 'error'>, f: Pick<Formatters, 't'>): string {
  if (a.outcome === 'ok') return f.t(a.screen === 'lost' ? 'tune.outcome.lost' : 'tune.outcome.ok');
  if (a.outcome === 'error' && a.error) return f.t('tune.outcome.errorCode', { title: f.t(`errors.${a.error.code}.title`) });
  return f.t(`tune.outcome.${a.outcome}`);
}

/** Why a launch was discarded, in one plain sentence. */
export function discardReason(a: TuneAttempt, f: F & Pick<Formatters, 'bytes'>): string {
  const ctx = depthLabel(a.contextSize, f);
  if (a.outcome === 'oom') return f.t('tune.discard.oom', { ctx });
  if (a.outcome === 'spill') {
    if (a.spill === 'shared-memory' && a.sharedPeakMiB !== undefined) return f.t('tune.discard.sharedMemory', { ctx, size: f.bytes(a.sharedPeakMiB * K * K) });
    return f.t(a.spill === 'shared-memory' ? 'tune.discard.sharedMemoryNoSize' : 'tune.discard.decodeCollapse', { ctx });
  }
  if (a.outcome === 'error') return a.error ? f.t(`errors.${a.error.code}.title`) : f.t('tune.discard.error');
  return f.t('tune.discard.lost');
}

/** The live status of the launch in progress: "Cerco il contesto massimo con cache q4_0: provo 48K…". */
export function stageText(a: Pick<TuneAttempt, 'stage' | 'kvType' | 'contextSize' | 'params'>, engineKind: EngineKind, label: LabelFn, f: F): string {
  const kv = kvName(a.kvType, f);
  const ctx = depthLabel(a.contextSize, f);
  const settings = settingsText(a.params, engineKind, label);
  return f.t(`tune.stage.${a.stage}`, { kv, ctx, settings });
}

/** "Con q4_0 arrivi a 64K, il doppio di q8_0 (32K)." from the measured maxima. */
export function capacitySentence(tuning: Pick<Tuning, 'capacity'>, f: F): string | undefined {
  const lead = capacityLead(tuning);
  if (!lead) return undefined;
  const kv = kvName(lead.best.kvType, f);
  const ctx = depthLabel(lead.best.max, f);
  if (lead.allSame) return f.t('tune.summary.capacityAll', { ctx });
  if (!lead.next) return f.t('tune.summary.capacityOne', { kv, ctx });
  const r = ratioOf(lead.best.max, lead.next.max);
  const params = { kv, ctx, other: kvName(lead.next.kvType, f), otherCtx: depthLabel(lead.next.max, f) };
  if (r.kind === 'double') return f.t('tune.summary.capacityDouble', params);
  if (r.kind === 'triple') return f.t('tune.summary.capacityTriple', params);
  if (r.kind === 'times') return f.t('tune.summary.capacityTimes', { ...params, n: r.n });
  return f.t('tune.summary.capacityMore', { ...params, pct: r.pct });
}

/** "Fino a 32K la più veloce è f16 · flash attention (91 tok/s a 32K); a 64K: q4_0 (74 tok/s)." */
export function speedSentence(tuning: Pick<Tuning, 'combinations' | 'fastestByDepth'>, engineKind: EngineKind, label: LabelFn, f: F): string | undefined {
  const segments = speedSegments(tuning);
  if (!segments.length) return undefined;
  const names = distinctNames(tuning, engineKind, label);
  const parts = segments.map((s, i) => {
    const params = {
      from: depthLabel(s.from, f),
      to: depthLabel(s.to, f),
      // Winners are measured combinations: they all have a name.
      settings: names.get(s.combination)!,
      tps: f.number(s.decodeTps, 1),
    };
    const single = s.from === s.to;
    if (i === 0) return f.t(single ? 'tune.summary.firstAt' : 'tune.summary.firstUpTo', params);
    return f.t(single ? 'tune.summary.nextAt' : 'tune.summary.nextRange', params);
  });
  return `${parts.join('; ')}.`;
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * Short names that tell the measured combinations apart, for a sentence: their settings without the
 * parts every one of them shares ("cache KV q8_0" rather than "Cache KV q8_0 · flash attention · ub 2048").
 */
export function distinctNames(tuning: Pick<Tuning, 'combinations'>, engineKind: EngineKind, label: LabelFn): Map<number, string> {
  const parts = new Map(
    measuredCombinations(tuning).map((i) => {
      const c = tuning.combinations[i]!;
      return [i, label(c.params, engineKind, { context: false, tags: c.tags }).parts.map(lowerFirst)] as const;
    }),
  );
  const lists = [...parts.values()];
  // Called with at least one measured combination (a sentence has a winner).
  const shared = new Set(lists[0]!.filter((p) => lists.every((l) => l.includes(p))));
  return new Map(
    [...parts].map(([i, list]) => {
      const own = list.filter((p) => !shared.has(p));
      return [i, (own.length ? own : list).join(' · ')];
    }),
  );
}

/** Index of the recommended combination and its words, for the card. */
export function recommendedOf(tuning: Tuning): { index: number; combo: TuneCombination } | undefined {
  const index = recommendedIndex(tuning);
  return index === undefined ? undefined : { index, combo: tuning.combinations[index]! };
}
