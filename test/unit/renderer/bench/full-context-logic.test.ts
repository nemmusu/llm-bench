/**
 * "Every speed of a one-user search is read at its largest context, with the context full", outside
 * the tune result page: what each place picks and how it says it (pure logic).
 */
import { describe, expect, it } from 'vitest';
import type { CurrentStep } from '../../../../src/contract/events';
import type { RunResult, RunSummary, TuneCombination, TuneRecheck } from '../../../../src/contract/results';
import { createFormatters } from '../../../../src/renderer/i18n';
import { decodeHistory } from '../../../../src/renderer/components/bench/history';
import { tuneHeadline } from '../../../../src/renderer/components/bench/kpis';
import { fillsLaunch, fullCaption, nowText } from '../../../../src/renderer/components/bench/live-now';
import { presetOf } from '../../../../src/renderer/components/bench/rerun';
import { compareRows, defaultDepth, depthChoices, fullDepth, itemOf } from '../../../../src/renderer/components/compare/compare-model';
import { AT_MAX, defaultAt, depthFor, fullPoint, maxPoint, pointFor } from '../../../../src/renderer/components/configs/depths';
import { provenanceText } from '../../../../src/renderer/components/presets/format';
import { recheckRows } from '../../../../src/renderer/components/tune/tune-recheck';
import { reportOf } from '../../../../src/renderer/lib/export/report';
import { sheetOf } from '../../../../src/renderer/lib/export/sheet';
import { IDS, seeded, summaries } from './fixtures';
import { K, ninferTune, ninferTuneFull, NVFP4, RK8 } from './full-context-fixtures';
import { combo, point } from '../tune/tune-fixtures';

const it_ = createFormatters('it');
const en = createFormatters('en');
const NOW = new Date('2026-10-14T16:00:00.000Z');

describe('speed history next to a result', () => {
  const base = summaries()[0]!;
  const run = (id: string, day: number, decodeTps: number, decodeTokens: number | undefined): RunSummary => {
    const s: RunSummary = { ...base, id, createdAt: `2026-10-${String(day).padStart(2, '0')}T10:00:00.000Z`, status: 'completed', decodeTps, validity: [], modelWeakKey: 'm', gpuName: 'g' };
    if (decodeTokens === undefined) delete s.decodeTokens;
    else s.decodeTokens = decodeTokens;
    return s;
  };
  const list = [run('a', 1, 180, 512), run('b', 2, 80, 256 * K), run('c', 3, 182, 512), run('d', 4, 81, 261_900), run('e', 5, 50, undefined), run('f', 6, 52, undefined)];

  it('only the runs measured with as much text in the context: a search at 256K never sits next to a test at 512 tokens', () => {
    expect(decodeHistory(list[3]!, list)).toEqual([80, 81]);
    expect(decodeHistory(list[2]!, list)).toEqual([180, 182]);
    expect(decodeHistory(list[5]!, list)).toEqual([50, 52]);
  });
});

describe('"Contesto massimo" of Configurazioni', () => {
  const pts = [{ depth: K }, { depth: 64 * K }, { depth: 256 * K }];

  it('a configuration at its largest context with the context full; a server whose context is unknown at the deepest it measured', () => {
    expect(fullPoint({ points: pts, contextSize: 256 * K })).toEqual({ depth: 256 * K });
    expect(fullPoint({ points: [...pts].reverse(), contextSize: 256 * K })).toEqual({ depth: 256 * K });
    expect(fullPoint({ points: pts.slice(0, 2), contextSize: 256 * K })).toBeUndefined();
    expect(fullPoint({ points: pts })).toBeUndefined();
    expect(fullPoint({ points: [], contextSize: 8 * K })).toBeUndefined();
    expect(maxPoint({ points: pts })).toEqual({ depth: 256 * K });
    expect(maxPoint({ points: pts.slice(0, 2), contextSize: 256 * K })).toBeUndefined();
    expect(pointFor({ points: pts, contextSize: 256 * K }, AT_MAX)).toEqual({ depth: 256 * K });
    expect(pointFor({ points: pts, contextSize: 256 * K }, 64 * K)).toEqual({ depth: 64 * K });
    expect(pointFor({ points: pts }, undefined)).toBeUndefined();
    expect(depthFor({ points: pts as never, contextSize: 256 * K }, AT_MAX)).toBe(256 * K);
    expect(depthFor({ points: pts as never }, 4 * K)).toBe(4 * K);
  });

  it('starts at "Contesto massimo" when some configuration filled its context; else at the depth most of them measured', () => {
    const full = { points: [{ depth: K, n: 1 }, { depth: 32 * K, n: 1 }], contextSize: 32 * K };
    const short = { points: [{ depth: K, n: 1 }], contextSize: 32 * K };
    expect(defaultAt([full, short], [K])).toBe(AT_MAX);
    expect(defaultAt([short, { ...short }], [K])).toBe(K);
  });
});

describe('Confronta: a combination with its context full', () => {
  it('stands at its context: a prompt sent again shorter (255 000 of 256K) is "256K", like 261 900 would be', () => {
    const run = ninferTuneFull();
    expect(itemOf(run, { runId: run.id, combo: RK8 }).points.map((p) => [p.depth, p.basis])).toEqual([
      [K, 'depth'],
      [64 * K, 'depth'],
      [256 * K, 'depth'],
    ]);
    // A normal run's sweep too (its 512 and 4.096 prompts stay prompts).
    const gemma = seeded(IDS.gemma);
    gemma.metrics.contextSweep = [point(K, 30, 900), point(7500, 25, 800)];
    expect(itemOf(gemma).points.map((p) => [p.depth, p.basis])).toEqual([
      [512, 'prompt'],
      [K, 'depth'],
      [4 * K, 'prompt'],
      [8 * K, 'depth'],
    ]);
  });

  it('two combinations full at the same context start there, said as such; anything else starts as before', () => {
    const a = ninferTuneFull();
    const b = ninferTuneFull('01M4X46BTJW9EH2YHE32Q7FUL2');
    const rk = itemOf(a, { runId: a.id, combo: RK8 });
    const rk2 = itemOf(b, { runId: b.id, combo: RK8 });
    const nv = itemOf(a, { runId: a.id, combo: NVFP4 });
    expect(fullDepth([rk, rk2])).toBe(256 * K);
    expect(fullDepth([rk, nv])).toBeUndefined();
    expect(fullDepth([rk, itemOf(seeded(IDS.full))])).toBeUndefined();
    const choices = depthChoices([rk, rk2]);
    expect(defaultDepth(choices, fullDepth([rk, rk2]))).toBe(256 * K);
    // Not measured by every item: the everyday depth, as before.
    expect(defaultDepth(depthChoices([rk, rk2, nv]), 256 * K)).toBe(K);
    const rows = compareRows([rk, rk2], 256 * K, it_);
    expect(rows.find((r) => r.id === 'decode')).toMatchObject({ context: 'scrittura con 262.144 token già nel contesto', values: [80.1, 80.1] });
  });
});

describe('live screen of a search: the context full said as such', () => {
  const sweep: CurrentStep = { kind: 'context-sweep', depth: 255_000, outputTokens: 128, rep: 1, reps: 2 };
  const screen: CurrentStep = { kind: 'tune-screen', promptTokens: 262_000, outputTokens: 128 };

  it('the line of what is measured now, and the caption under the gauges', () => {
    expect(nowText(sweep, it_, 256 * K)).toBe('Contesto riempito fino a 255.000 token · contesto pieno · 128 token in uscita · ripetizione 1 di 2');
    expect(nowText(screen, it_, 256 * K)).toBe('Confronto con la migliore finora · Prompt di 262.000 token → 128 in uscita · contesto pieno');
    expect(nowText({ ...sweep, depth: 64 * K }, it_, 256 * K)).toBe('Contesto riempito fino a 65.536 token · 128 token in uscita · ripetizione 1 di 2');
    expect(nowText(sweep, it_)).toBe('Contesto riempito fino a 255.000 token · 128 token in uscita · ripetizione 1 di 2');
    expect(nowText(sweep, en, 256 * K)).toContain('· context full ·');
    expect(fullCaption(sweep, 256 * K, it_)).toBe('contesto pieno: 255.000 token');
    expect(fullCaption({ kind: 'tune-probe', promptTokens: K }, 256 * K, it_)).toBeUndefined();
    expect(fullCaption(undefined, 256 * K, it_)).toBeUndefined();
    expect(fillsLaunch({ kind: 'latency', promptTokens: 8 * K }, 8 * K)).toBe(false);
    expect(fillsLaunch({ kind: 'context-sweep' }, 8 * K)).toBe(false);
    expect(fillsLaunch(sweep, undefined)).toBe(false);
  });
});

describe('Ricontrollo rapido: before and now at the context full first', () => {
  const previous = combo('q4_0', 256 * K, [point(K, 90, 9000), point(64 * K, 80, 7000), point(261_900, 70, 3000)]);
  const check = (now: TuneCombination, moved: TuneRecheck['checks'][number]['moved']): TuneRecheck['checks'][number] => ({ role: 'recommended', previous, combination: 0, fits: true, outcome: 'ok', moved });

  it('a context full sent shorter this time still lines up with the one before, its noise judged with the same rule', () => {
    const now = combo('q4_0', 256 * K, [point(K, 92, 9000), point(128 * K, 75, 5000), point(255_000, 63, 3010)]);
    const rows = recheckRows(check(now, [{ at: K, metric: 'decode', before: 90, after: 92 }]), now, it_);
    expect(rows.map((r) => [r.at, r.metric, r.before, r.after, r.moved])).toEqual([
      ['256K, contesto pieno', 'Generazione (tok/s)', '70,0', '63,0', true],
      ['256K, contesto pieno', 'Lettura prompt (tok/s)', '3.000', '3.010', false],
      ['256K, contesto pieno', 'Primo token (s)', expect.any(String), expect.any(String), true],
      ['1K', 'Generazione (tok/s)', '90,0', '92,0', true],
      ['1K', 'Lettura prompt (tok/s)', '9.000', '9.000', false],
      ['1K', 'Primo token (s)', '0,11', '0,11', false],
    ]);
  });

  it('the same grid depth both times: the core said what moved', () => {
    const now = combo('q4_0', 256 * K, [point(K, 90, 9000), point(262_000, 70, 3000)]);
    const rows = recheckRows(check(now, [{ at: 256 * K, metric: 'prefill', before: 3000, after: 3000 }]), now, en);
    expect(rows.map((r) => [r.at, r.moved])).toEqual([
      ['256K, context full', false],
      ['256K, context full', true],
      ['256K, context full', false],
      ['1K', false],
      ['1K', false],
      ['1K', false],
    ]);
  });
});

describe('the headline of a one-user search: its recommended combination with the context full', () => {
  it('full, or (time ran out) its deepest point; another combination on request; nothing for "Più utenti"', () => {
    expect(tuneHeadline(ninferTuneFull())).toMatchObject({ index: RK8, full: true, point: { promptTokens: 255_000 } });
    expect(tuneHeadline(ninferTune())).toMatchObject({ index: RK8, full: false, point: { promptTokens: 64 * K } });
    const unordered = ninferTune();
    unordered.tuning!.combinations[RK8]!.sweep.reverse();
    expect(tuneHeadline(unordered)).toMatchObject({ full: false, point: { promptTokens: 64 * K } });
    expect(tuneHeadline(ninferTuneFull(), NVFP4)).toMatchObject({ index: NVFP4, full: false });
    const multi = ninferTune();
    multi.tuning!.goal = 'multi';
    expect(tuneHeadline(multi)).toBeUndefined();
    expect(tuneHeadline(seeded(IDS.full))).toBeUndefined();
    const empty = ninferTune();
    empty.tuning!.combinations[RK8]!.sweep = [];
    expect(tuneHeadline(empty)).toBeUndefined();
    const none = ninferTune();
    none.tuning = { ...none.tuning!, combinations: [], recommended: undefined };
    expect(tuneHeadline(none)).toBeUndefined();
  });
});

describe('the share sheet and the exports of a search', () => {
  const sheet = (run: RunResult, combo?: number) => sheetOf({ run, combo, appVersion: '0.4.0', now: NOW }, it_);
  const speed = (r: ReturnType<typeof sheetOf>) => r.sections.find((s) => s.title === 'Velocità e tempi di attesa');

  it('the recommended combination with its context full: its settings, its command, its speeds', () => {
    const run = ninferTuneFull();
    const r = sheet(run);
    expect(speed(r)?.table?.head).toEqual(['Contesto riempito (token)', 'Lettura (token/s)', 'Attesa prima risposta', 'Scrittura (token/s)']);
    expect(speed(r)?.table?.rows[0]?.[0]).toBe('255.000 (contesto pieno)');
    expect(speed(r)?.table?.rows[0]?.slice(1)).toEqual(['2.400', expect.any(String), '80,1']);
    expect(speed(r)?.after).toBeUndefined();
    expect(r.sentence).toMatch(/: con il contesto pieno \(256K\) legge il testo a 2\.400 token\/s e scrive a 80,1 token\/s\.$/);
    const setup = r.sections.find((s) => s.title === 'Modello e configurazione');
    expect(setup?.code?.bash).toBe(run.tuning!.combinations[RK8]!.command.bash);
    expect(setup?.table?.rows.find((x) => x[0] === 'Configurazione')?.[1]).toContain('rk8v4');
  });

  it('a search that stopped before filling it says how full the context was, and the largest', () => {
    const r = sheet(ninferTune());
    // Calibrated text prompts: the tokens the engine counted.
    expect(speed(r)?.table?.rows[0]?.[0]).toBe('65.326');
    expect(speed(r)?.after).toEqual(['La ricerca si è fermata prima di riempire il contesto massimo (256K): questi numeri sono con il contesto riempito a 64K.']);
    expect(r.sentence).toMatch(/: con il contesto riempito a 64K \(il massimo è 256K\) legge il testo a 3\.150 token\/s e scrive a 83,0 token\/s\.$/);
    // Another combination compared: the sheet is about that one.
    expect(sheet(ninferTuneFull(), NVFP4).sections.find((s) => s.title === 'Modello e configurazione')?.table?.rows.find((x) => x[0] === 'Configurazione')?.[1]).toContain('nvfp4');
  });

  it('the Markdown/HTML report says where its speeds were read', () => {
    const rows = (run: RunResult) => reportOf(run, it_).sections.find((s) => s.title === 'Numeri principali')?.table?.rows ?? [];
    expect(rows(ninferTuneFull()).slice(0, 3)).toEqual([
      ['Generazione (tok/s) al contesto massimo', '80,1'],
      ['Lettura prompt (tok/s) al contesto massimo', '2.400'],
      ['Primo token (ms) al contesto massimo', '106.250'],
    ]);
    expect(rows(ninferTune())[0]).toEqual(['Generazione (tok/s) a 64K', '83,0']);
  });
});

describe('a preset from a combination quotes it where it filled its context', () => {
  it('"scrive 80 tok/s a 256K token, 256K di contesto", the deepest by default', () => {
    const run = ninferTuneFull();
    const at = presetOf(run, [], undefined, { combo: RK8, at: 256 * K }).provenance;
    expect(at).toMatchObject({ combo: RK8, decodeTps: 80.1, depth: 256 * K, contextSize: 256 * K });
    expect(provenanceText(at, it_)).toBe('Preset da «Qwen3.8-27B-Coder390-EfficientThink-Q6_K-MTP · combinazione 3» del 14/10: scrive 80 tok/s a 256K token, 256K di contesto');
    expect(presetOf(run, [], undefined, { combo: RK8 }).provenance).toMatchObject({ depth: 256 * K });
    // A normal run's context sweep sent shorter: found at its context too.
    const gemma = seeded(IDS.gemma);
    gemma.metrics.contextSweep = [point(K, 30, 900), point(7500, 25, 800)];
    expect(presetOf(gemma, [], undefined, { at: 8 * K }).provenance).toMatchObject({ decodeTps: 25, depth: 8 * K });
  });
});
