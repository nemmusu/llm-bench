import { describe, expect, it } from 'vitest';
import type { LaunchParams } from '../../../../src/contract/engines';
import type { Tuning } from '../../../../src/contract/results';
import { createFormatters } from '../../../../src/renderer/i18n';
import { launchLabelOf } from '../../../../src/renderer/components/presets/config-label';
import {
  bestValues,
  capacityLead,
  compareContenders,
  deepestPoint,
  defaultDepth,
  defaultDir,
  depthOptions,
  discardedAttempts,
  lastPoint,
  measuredCombinations,
  pointAt,
  rankAt,
  ratioOf,
  reachOf,
  recommendedIndex,
  sameWithinNoise,
  sortRows,
  speedSegments,
} from '../../../../src/renderer/components/tune/tune-logic';
import {
  capacitySentence,
  comboText,
  depthLabel,
  discardReason,
  kvName,
  outcomeText,
  recommendedOf,
  settingsText,
  speedSentence,
  stageText,
} from '../../../../src/renderer/components/tune/tune-format';
import { attempt, combo, params, point, stat, tuning } from './tune-fixtures';

const f = createFormatters('it');
const label = (p: LaunchParams, k: Parameters<typeof launchLabelOf>[1], o?: Parameters<typeof launchLabelOf>[3]) => launchLabelOf(p, k, f, o);
const K = 1024;

describe('noise-aware comparison', () => {
  it('ties within max(2 %, 2 × CV) of the larger median', () => {
    expect(sameWithinNoise(stat(100), stat(101.5))).toBe(true);
    expect(sameWithinNoise(stat(100), stat(103))).toBe(false);
    // Noisy repetitions widen the tie.
    expect(sameWithinNoise(stat(100, 0.03), stat(105))).toBe(true);
    expect(sameWithinNoise(stat(0), stat(0))).toBe(true);
  });

  it('ranks by generation, then prompt reading, first token, cache precision, order', () => {
    const c = (index: number, kvType: 'f16' | 'q8_0' | 'q4_0', decode: number, prefill: number, ttft: number) => ({ index, kvType, point: point(K, decode, prefill, ttft) });
    expect(compareContenders(c(0, 'f16', 90, 1000, 100), c(1, 'f16', 80, 1000, 100))).toBeLessThan(0);
    expect(compareContenders(c(0, 'f16', 90, 900, 100), c(1, 'f16', 90.5, 1000, 100))).toBeGreaterThan(0);
    expect(compareContenders(c(0, 'f16', 90, 1000, 120), c(1, 'f16', 90, 1000, 100))).toBeGreaterThan(0);
    expect(compareContenders(c(0, 'q4_0', 90, 1000, 100), c(1, 'f16', 90, 1000, 100))).toBeGreaterThan(0);
    expect(compareContenders(c(3, 'f16', 90, 1000, 100), c(1, 'f16', 90, 1000, 100))).toBeGreaterThan(0);
  });

  it('points line up on the grid (a 32K context’s deepest prompt is 32K)', () => {
    const t = tuning();
    expect(pointAt(t.combinations[1]!, 32 * K)?.promptTokens).toBe(32 * K - 144);
    expect(pointAt(t.combinations[0]!, 32 * K)).toBeUndefined();
    expect(deepestPoint({ sweep: [] })).toBeUndefined();
    expect(deepestPoint(t.combinations[2]!)?.promptTokens).toBe(64 * K - 144);
    expect(reachOf(t.combinations[0]!)).toBe(24 * K);
    expect(measuredCombinations(t)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('ranking at a depth', () => {
  it('puts the core’s winner first, then the rest by the rules; shorter ones at the bottom, deepest first', () => {
    const t = tuning();
    const at16 = rankAt(t, 16 * K);
    expect(at16.map((r) => r.index)).toEqual([0, 1, 2, 3, 4]);
    expect(at16.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5]);
    const at64 = rankAt(t, 64 * K);
    expect(at64.map((r) => r.index)).toEqual([2, 3, 4, 1, 0]);
    expect(at64[3]!.point).toBeUndefined();
    // Without the core's list the rules decide (and the pinned winner may come second in the input).
    const own = rankAt({ ...t, fastestByDepth: [{ depth: 64 * K, combination: 3 }] }, 64 * K);
    expect(own.map((r) => r.index).slice(0, 2)).toEqual([3, 2]);
    // Two that stop at the same depth keep their order.
    const same = rankAt({ ...t, combinations: [t.combinations[0]!, t.combinations[0]!, t.combinations[2]!], fastestByDepth: [] }, 64 * K);
    expect(same.map((r) => r.index)).toEqual([2, 0, 1]);
  });

  it('offers depths measured by two combinations and starts at the deepest one everybody reached', () => {
    const t = tuning();
    const options = depthOptions(t);
    expect(options).toEqual([K, 4 * K, 8 * K, 16 * K, 32 * K, 64 * K]);
    expect(defaultDepth(t, options)).toBe(16 * K);
    const one = { combinations: [t.combinations[0]!] };
    expect(depthOptions(one)).toEqual([K, 4 * K, 8 * K, 16 * K, 24 * K]);
    expect(defaultDepth(t, [64 * K])).toBe(64 * K);
    expect(defaultDepth({ combinations: [t.combinations[2]!, combo('f16', 2 * K, [point(2 * K, 1, 1)])] }, [K, 4 * K])).toBe(K);
    expect(defaultDepth(t, [])).toBeUndefined();
  });

  it('sorts by any column, keeping those that do not reach the depth at the bottom', () => {
    const rows = rankAt(tuning(), 64 * K);
    expect(defaultDir('rank')).toBe('asc');
    expect(defaultDir('ttft')).toBe('asc');
    expect(defaultDir('vram')).toBe('asc');
    expect(defaultDir('decode')).toBe('desc');
    const ids = (key: Parameters<typeof sortRows>[1], dir: Parameters<typeof sortRows>[2]) => sortRows(rows, key, dir).map((r) => r.index);
    expect(ids('rank', 'asc')).toEqual([2, 3, 4, 1, 0]);
    expect(ids('rank', 'desc')).toEqual([4, 3, 2, 0, 1]);
    expect(ids('decode', 'asc')).toEqual([4, 3, 2, 1, 0]);
    expect(ids('prefill', 'desc')).toEqual([2, 3, 4, 1, 0]);
    expect(ids('ttft', 'asc')).toEqual([2, 3, 4, 1, 0]);
    // No VRAM figure for one combination: it goes last among those reaching the depth.
    expect(ids('vram', 'asc')).toEqual([4, 2, 3, 1, 0]);
    expect(ids('vram', 'desc')).toEqual([2, 4, 3, 0, 1]);
    expect(ids('maxContext', 'desc')).toEqual([2, 3, 4, 1, 0]);
  });

  it('marks the best value of each column, ties included', () => {
    const best = bestValues(rankAt(tuning(), 64 * K));
    expect([...best.decode]).toEqual([2]);
    expect([...best.prefill]).toEqual([2]);
    expect([...best.ttft]).toEqual([2]);
    const pair = { combinations: [combo('f16', 8 * K, [point(K, 90, 9000)]), combo('q8_0', 8 * K, [point(K, 89.5, 8000)])], fastestByDepth: [] };
    expect([...bestValues(rankAt(pair, K)).decode]).toEqual([0, 1]);
    expect(bestValues([]).decode.size).toBe(0);
  });

  it('recommends the core’s pick, else the fastest among those reaching the largest context', () => {
    const t = tuning();
    expect(recommendedIndex(t)).toBe(2);
    expect(recommendedIndex({ ...t, recommended: undefined })).toBe(2);
    expect(recommendedIndex({ ...t, recommended: 42 })).toBe(2);
    expect(recommendedIndex({ combinations: [], recommended: undefined })).toBeUndefined();
    expect(recommendedOf({ ...t, combinations: [] , recommended: undefined })).toBeUndefined();
    expect(recommendedOf(t)?.index).toBe(2);
  });
});

describe('summary from the numbers', () => {
  it('says which cache reaches further, by how much', () => {
    const cap = (a: number, b?: number, c?: number): Pick<Tuning, 'capacity'> => ({
      capacity: [
        { kvType: 'q4_0', measuredMax: a, inferred: false },
        { kvType: 'q8_0', ...(b === undefined ? {} : { measuredMax: b }), inferred: false },
        { kvType: 'f16', ...(c === undefined ? {} : { measuredMax: c }), inferred: false },
      ],
    });
    expect(capacityLead({ capacity: [] })).toBeUndefined();
    expect(capacitySentence({ capacity: [] }, f)).toBeUndefined();
    expect(capacitySentence(cap(64 * K, 32 * K, 24 * K), f)).toBe('Con cache q4_0 arrivi a 64K, il doppio di q8_0 (32K).');
    expect(capacitySentence(cap(96 * K, 32 * K), f)).toBe('Con cache q4_0 arrivi a 96K, il triplo di q8_0 (32K).');
    expect(capacitySentence(cap(128 * K, 32 * K), f)).toBe('Con cache q4_0 arrivi a 128K, 4 volte q8_0 (32K).');
    expect(capacitySentence(cap(48 * K, 32 * K), f)).toBe('Con cache q4_0 arrivi a 48K, il 50% in più di q8_0 (32K).');
    expect(capacitySentence(cap(32 * K, 32 * K, 32 * K), f)).toBe('Con tutte le cache arrivi a 32K.');
    expect(capacitySentence(cap(32 * K), f)).toBe('Con cache q4_0 arrivi a 32K.');
    // Same maximum: the more precise cache is named.
    expect(capacityLead({ capacity: [{ kvType: 'q4_0', measuredMax: 8 * K, inferred: false }, { kvType: 'f16', measuredMax: 8 * K, inferred: false }] })?.best.kvType).toBe('f16');
    expect(ratioOf(2, 1)).toEqual({ kind: 'double' });
    expect(ratioOf(4.02, 1)).toEqual({ kind: 'times', n: 4 });
    expect(ratioOf(1.5, 1)).toEqual({ kind: 'percent', pct: 50 });
  });

  it('says which combination is fastest at each depth', () => {
    const t = tuning();
    expect(speedSegments(t)).toEqual([
      { from: K, to: 16 * K, combination: 0, decodeTps: 78 },
      { from: 32 * K, to: 32 * K, combination: 1, decodeTps: 72 },
      { from: 64 * K, to: 64 * K, combination: 2, decodeTps: 60 },
    ]);
    expect(speedSentence(t, 'llamacpp-native', label, f)).toBe(
      'Fino a 16K la più veloce è Cache KV f16 · flash attention (78,0 tok/s a 16K); a 32K Cache KV q8_0 · flash attention fa 72,0 tok/s; a 64K Cache KV q4_0 · flash attention · ub 2048 · b 4096 fa 60,0 tok/s.',
    );
    // Computed when the core sent no list; unknown combinations and missing points are skipped.
    expect(speedSegments({ ...t, fastestByDepth: [] }).map((s) => s.combination)).toEqual([0, 1, 2]);
    expect(speedSegments({ ...t, fastestByDepth: [{ depth: K, combination: 99 }, { depth: 64 * K, combination: 0 }] })).toEqual([]);
    expect(speedSentence({ combinations: [], fastestByDepth: [] }, 'llamacpp-native', label, f)).toBeUndefined();
    const two = { combinations: [t.combinations[2]!], fastestByDepth: [{ depth: 32 * K, combination: 0 }, { depth: 64 * K, combination: 0 }] };
    expect(speedSentence(two, 'llamacpp-native', label, f)).toMatch(/^Fino a 64K la più veloce è .* \(60,0 tok\/s a 64K\)\.$/);
    const single = { combinations: [t.combinations[0]!, t.combinations[1]!], fastestByDepth: [{ depth: K, combination: 1 }, { depth: 4 * K, combination: 0 }, { depth: 8 * K, combination: 0 }] };
    expect(speedSentence(single, 'llamacpp-native', label, f)).toBe(
      'A 1K la più veloce è Cache KV q8_0 · flash attention (90,0 tok/s); da 4K a 8K Cache KV f16 · flash attention (84,0 tok/s a 8K).',
    );
  });
});

describe('words for the tune screens', () => {
  it('writes depths like people say them', () => {
    expect(depthLabel(32 * K, f)).toBe('32K');
    expect(depthLabel(48 * K, f)).toBe('48K');
    expect(depthLabel(K * K, f)).toBe('1M');
    expect(depthLabel(30000, f)).toBe('29,3K');
    expect(depthLabel(512, f)).toBe('512');
    expect(kvName('auto', f)).toBe('automatica');
    expect(kvName('q4_0', f)).toBe('q4_0');
  });

  it('labels settings without the context, and the slower-by-design traits', () => {
    const c = combo('q4_0', 64 * K, [], { tags: ['cpu-offload'], params: params({ ubatchSize: 2048 }) });
    expect(settingsText(c.params, 'llamacpp-native', label)).toBe('Cache KV q4_0 · flash attention · ub 2048');
    expect(comboText(c, 'llamacpp-native', label)).toBe('Cache KV q4_0 · flash attention · ub 2048 · parte sulla CPU');
  });

  it('says how each launch went and why it was dropped', () => {
    const t = tuning();
    expect(t.attempts.map((a) => outcomeText(a, f))).toEqual([
      'Caricato',
      'Memoria esaurita',
      'Caricato',
      'Usa la RAM condivisa (lento)',
      'Usa la RAM condivisa (lento)',
      'Usa la RAM condivisa (lento)',
      'Caricato',
      'Caricato',
      'Più lenta: scartata',
      'Errore: Il motore non riconosce un parametro',
      'Errore',
    ]);
    const dropped = discardedAttempts(t);
    expect(dropped.map((d) => d.index)).toEqual([1, 3, 4, 5, 8, 9, 10]);
    expect(dropped.map((d) => discardReason(d.attempt, f))).toEqual([
      'Con contesto 32K la memoria video non bastava: il motore non è partito.',
      'Con contesto 48K non stava tutto nella memoria video: Windows ha spostato 2,0 GB nella RAM condivisa, molto più lenta.',
      'Con contesto 40K la generazione è crollata rispetto al riferimento: segno che una parte stava nella RAM condivisa.',
      'Con contesto 36K non stava tutto nella memoria video: Windows ha usato la RAM condivisa, molto più lenta.',
      'Più lenta dell’impostazione migliore trovata fin lì: non l’ho tenuta.',
      'Il motore non riconosce un parametro',
      'Il motore si è fermato con un errore.',
    ]);
    expect(lastPoint(t.attempts[0]!)?.decodeTps.median).toBe(88);
    expect(lastPoint(t.attempts[1]!)).toBeUndefined();
  });

  it('tells the stage of the launch in progress', () => {
    const a = attempt('capacity', 'q4_0', 48 * K, 'ok');
    expect(stageText(a, 'llamacpp-native', label, f)).toBe('Cerco il contesto massimo con cache q4_0: provo 48K…');
    for (const stage of ['reference', 'variant', 'sweep', 'offload', 'fidelity'] as const) {
      expect(stageText({ ...a, stage }, 'llamacpp-native', label, f)).not.toContain('tune.stage');
    }
    expect(stageText({ ...a, stage: 'variant' }, 'llamacpp-native', label, f)).toBe('Provo un’impostazione diversa a 48K: Cache KV q4_0 · flash attention…');
  });
});
