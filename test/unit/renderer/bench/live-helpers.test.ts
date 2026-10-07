import { describe, expect, it } from 'vitest';
import type { ActiveRun } from '../../../../src/contract/api';
import type { LivePoint, LoadProgress, RunLaunch } from '../../../../src/contract/events';
import { soloDecode, usersSentence, usersTable } from '../../../../src/renderer/components/bench/concurrency-users';
import { engineKindOfLabel, nowText } from '../../../../src/renderer/components/bench/live-now';
import { initialLive, liveReducer, mergePoint, pointKey, seedFromActive } from '../../../../src/renderer/components/bench/live-state';
import { clock, engineName, finishedStages, shortDuration, stageProgressText, trackLoad } from '../../../../src/renderer/components/bench/load-progress';
import { createFormatters } from '../../../../src/renderer/i18n';
import { relevantPhases } from '../../../../src/renderer/components/bench/phases';
import { attempt, point, stat, tuning, users } from '../tune/tune-fixtures';
import { activeRun } from './world';

const f = createFormatters('it');
const RUN = 'r1';
const SESSIONS: LivePoint = {
  stepKind: 'sessions',
  point: {
    sessions: 2,
    depth: 32768,
    turns: 3,
    outputTokens: 256,
    followupTokens: 256,
    firstTurn: { ttftMs: stat(4000), prefillTps: stat(8000), queueWaitMs: stat(100), decodeTps: stat(40) },
    queueEstimated: true,
    requests: 6,
    errors: 0,
  },
};

describe('what is measured now', () => {
  it('says the request in flight in words and numbers', () => {
    expect(nowText({ kind: 'latency', promptTokens: 4096, outputTokens: 512, rep: 3, reps: 10 }, f)).toBe('Prompt di 4096 token → 512 in uscita · ripetizione 3 di 10');
    expect(nowText({ kind: 'latency', promptTokens: 4096, rep: 1, reps: 2, warmup: true }, f)).toBe('Prompt di 4096 token · riscaldamento 1 di 2');
    expect(nowText({ kind: 'latency', rep: 2, warmup: true }, f)).toBe('riscaldamento 2');
    expect(nowText({ kind: 'latency', rep: 4 }, f)).toBe('ripetizione 4');
    expect(nowText({ kind: 'context-sweep', depth: 32768, outputTokens: 128 }, f)).toBe('Contesto riempito fino a 32.768 token · 128 token in uscita');
    expect(nowText({ kind: 'context-sweep', promptTokens: 8192 }, f)).toBe('Contesto riempito fino a 8192 token');
    expect(nowText({ kind: 'context-sweep' }, f)).toBe('Contesto riempito un po’ alla volta');
    expect(nowText({ kind: 'concurrency', concurrency: 8, promptTokens: 512 }, f)).toBe('8 utenti insieme · prompt di 512 token ciascuno');
    expect(nowText({ kind: 'concurrency' }, f)).toBe('Più utenti insieme');
    expect(nowText({ kind: 'sessions', concurrency: 2, promptTokens: 32768, turn: 2, turns: 3 }, f)).toBe('2 conversazioni insieme · contesto di 32.768 token ciascuna · messaggio 2 di 3');
    expect(nowText({ kind: 'sessions', turn: 1 }, f)).toBe('Conversazioni lunghe · messaggio 1 di 1');
    expect(nowText({ kind: 'load', label: 'cold', rep: 2, reps: 3 }, f)).toBe('Caricamento a freddo · ripetizione 2 di 3');
    expect(nowText({ kind: 'load', label: 'warm' }, f)).toBe('Caricamento a caldo');
    expect(nowText({ kind: 'load' }, f)).toBe('Caricamento del modello');
    expect(nowText({ kind: 'first-token' }, f)).toBe('Primo token dopo il caricamento');
    expect(nowText({ kind: 'llama-bench' }, f)).toBe('Test standard llama-bench');
    expect(nowText({ kind: 'tune-probe', promptTokens: 1024, outputTokens: 64 }, f)).toBe('Prova rapida · Prompt di 1024 token → 64 in uscita');
    expect(nowText({ kind: 'tune-screen' }, f)).toBe('Confronto con la migliore finora');
    expect(nowText({ kind: 'fidelity', promptTokens: 2048 }, f)).toBe('Confronto del testo generato · Prompt di 2048 token');
    expect(relevantPhases({ profile: 'full', seed: 1, steps: [{ kind: 'sessions', depth: 0, levels: [1, 2], turns: 3, followupTokens: 256, outputTokens: 256 }] })).toEqual(['prepare', 'sessions', 'cleanup']);
    expect(engineKindOfLabel('vLLM v0.12.0')).toBe('vllm-docker');
    expect(engineKindOfLabel('llama.cpp b11438')).toBe('llamacpp-native');
  });
});

describe('engine start, stage by stage', () => {
  const p = (stage: LoadProgress['stage'], elapsedMs: number, over: Partial<LoadProgress> = {}): LoadProgress => ({ stage, elapsedMs, ...over });

  it('times every stage and starts over with a new engine', () => {
    let t = trackLoad(undefined, p('starting', 0));
    t = trackLoad(t, p('weights', 1200, { done: 1, total: 7 }));
    t = trackLoad(t, p('weights', 5000, { done: 5, total: 7 }));
    t = trackLoad(t, p('compile', 9000));
    expect(finishedStages(t)).toEqual([
      { stage: 'starting', ms: 1200 },
      { stage: 'weights', ms: 7800 },
    ]);
    t = trackLoad(t, p('ready', 20_000));
    expect(finishedStages(t).map((s) => s.stage)).toEqual(['starting', 'weights', 'compile']);
    expect(t.current.stage).toBe('ready');
    // The next engine of the run.
    t = trackLoad(t, p('metadata', 300));
    expect(t.spans).toEqual([
      { stage: 'starting', startMs: 0, endMs: 300 },
      { stage: 'metadata', startMs: 300 },
    ]);
    // A clock that went back is a new engine too; the first line at 0 has no "starting" before it.
    t = trackLoad(t, p('container', 0));
    expect(t.spans).toEqual([{ stage: 'container', startMs: 0 }]);
    // Joined when already ready (screen reopened).
    expect(trackLoad(undefined, p('ready', 4000)).spans).toEqual([]);
  });

  it('writes the stage with its counts, and short durations', () => {
    expect(stageProgressText(p('weights', 1, { done: 3, total: 7, fraction: 0.43 }), 'vllm-docker', f)).toBe('Caricamento dei pesi · 3 di 7 parti (43%)');
    expect(stageProgressText(p('weights', 1, { done: 49, total: 65 }), 'llamacpp-native', f)).toBe('Caricamento dei pesi · 49 di 65 strati');
    expect(stageProgressText(p('cuda-graphs', 1, { done: 30, total: 67 }), 'vllm-native', f)).toBe('Preparazione dei CUDA graph · 30 di 67');
    expect(stageProgressText(p('kv-cache', 1, { done: 1, total: 2 }), 'vllm-native', f)).toBe('Preparazione della cache KV · 1 di 2');
    expect(stageProgressText(p('warmup', 1, { done: 0, total: 0 }), 'llamacpp-native', f)).toBe('Riscaldamento');
    expect(engineName('vllm-native')).toBe('vLLM');
    expect(engineName('external')).toBeUndefined();
    expect(engineName('llamacpp-docker')).toBe('llama.cpp');
    expect(clock(18_400)).toBe('0:18');
    expect(clock(125_000)).toBe('2:05');
    expect(clock(-5)).toBe('0:00');
    expect(shortDuration(400, f)).toBe('0,4 s');
    expect(shortDuration(45_000, f)).toBe('45 s');
    expect(shortDuration(65_000, f)).toBe('1 min 05 s');
  });
});

describe('live state', () => {
  const launch: RunLaunch = { params: { extraArgs: [], env: {}, contextSize: 8192 }, command: { argv: ['x'], powershell: 'x', bash: 'x' }, engineLabel: 'llama.cpp b1' };
  const lat = (n: number, attemptIndex?: number): LivePoint => ({ stepKind: 'latency', point: point(n, 50, 900), ...(attemptIndex === undefined ? {} : { attempt: attemptIndex }) });

  it('keeps the latest point per prompt length / level / attempt', () => {
    expect(pointKey(lat(512))).toBe('latency:512:');
    expect(pointKey(lat(512, 3))).toBe('latency:512:3');
    expect(pointKey({ stepKind: 'concurrency', point: users(4) })).toBe('concurrency:4');
    expect(pointKey(SESSIONS)).toBe('sessions:2');
    const first = mergePoint([], lat(512));
    const again = mergePoint(first, { stepKind: 'latency', point: point(512, 60, 900) });
    expect(again).toHaveLength(1);
    expect(again[0]!.stepKind === 'latency' && again[0]!.point.decodeTps.median).toBe(60);
    expect(mergePoint(again, lat(1024))).toHaveLength(2);
  });

  it('folds launch, step, point, load and tune events of this run only', () => {
    let s = initialLive();
    const other = (e: Parameters<typeof liveReducer>[1]) => expect(liveReducer(s, e, RUN)).toBe(s);
    other({ type: 'run.launch', runId: 'x', launch });
    other({ type: 'run.step', runId: 'x', current: { kind: 'llama-bench' } });
    other({ type: 'run.point', runId: 'x', live: lat(1) });
    other({ type: 'run.load', runId: 'x', stage: 'weights', elapsedMs: 1 });
    other({ type: 'run.tune', runId: 'x', tuning: tuning() });
    s = liveReducer(s, { type: 'run.launch', runId: RUN, launch }, RUN);
    s = liveReducer(s, { type: 'run.step', runId: RUN, current: { kind: 'latency', promptTokens: 512 } }, RUN);
    s = liveReducer(s, { type: 'run.point', runId: RUN, live: lat(512) }, RUN);
    s = liveReducer(s, { type: 'run.load', runId: RUN, stage: 'weights', elapsedMs: 500 }, RUN);
    const current = { ...attempt('capacity', 'q4_0', 4096, 'ok') } as Partial<ReturnType<typeof attempt>>;
    delete current.outcome;
    s = liveReducer(s, { type: 'run.tune', runId: RUN, tuning: tuning(), current: current as never }, RUN);
    expect(s.launch).toBe(launch);
    expect(s.current?.promptTokens).toBe(512);
    expect(s.points).toHaveLength(1);
    expect(s.load?.current.stage).toBe('weights');
    expect(s.load?.current).not.toHaveProperty('type');
    expect(s.tuneCurrent?.kvType).toBe('q4_0');
    s = liveReducer(s, { type: 'run.tune', runId: RUN, tuning: tuning() }, RUN);
    expect(s.tuneCurrent).toBeUndefined();
  });

  it('a reopened screen takes from the core what the events have not brought', () => {
    const active: ActiveRun = activeRun(RUN, {
      phase: 'decode',
      progress: 0.5,
      launch,
      current: { kind: 'latency', promptTokens: 512 },
      points: [lat(512), lat(1024)],
      tuning: tuning(),
      loading: { stage: 'kv-cache', elapsedMs: 3000 },
    });
    const s = seedFromActive(initialLive(), active);
    expect(s.phase).toBe('decode');
    expect(s.progress).toBe(0.5);
    expect(s.launch).toBe(launch);
    expect(s.current?.promptTokens).toBe(512);
    expect(s.points).toHaveLength(2);
    expect(s.tuning?.combinations).toHaveLength(6);
    expect(s.load?.current.stage).toBe('kv-cache');
    // Fresher event data wins; known points are not doubled; phase marks keep the event phase.
    const fresh = { ...s, marks: [{ t: 0, phase: 'prefill' as const }], phase: 'prefill' as const };
    const again = seedFromActive(fresh, { ...active, phase: 'cleanup', launch: { ...launch, engineLabel: 'other' } });
    expect(again.phase).toBe('prefill');
    expect(again.launch).toBe(launch);
    expect(again.points).toBe(fresh.points);
    expect(seedFromActive(initialLive(), activeRun(RUN)).launch).toBeUndefined();
  });
});

describe('what each user gets', () => {
  it('lists every level in order, only the columns some level has', () => {
    const old = usersTable([users(2), users(1)], f);
    expect(old.columns).toEqual([
      'Utenti',
      'Scrittura per utente p50 (tok/s)',
      'Rispetto a 1 utente (%)',
      'Primo token p50 (ms)',
      'Primo token p95 (ms)',
      'Totale scrittura (tok/s)',
      'Richieste',
      'Errori',
    ]);
    expect(old.rows.map((r) => r.level)).toEqual([1, 2]);
    expect(old.rows[1]!.cells).toEqual(['2', '47,5', '95', '340', '390', '95', '8', '0']);
    const rich = usersTable(
      [
        users(4, {
          promptTokens: 512,
          outputTokens: 128,
          contextPerUser: 8192,
          contextShared: true,
          perRequestPrefillTpsP50: 1900,
          perRequestDecodeTpsP5: 38.2,
          aggregatePrefillTps: 6100,
        }),
      ],
      f,
      [1, 2, 3, 4],
    );
    expect(rich.columns).toContain('Contesto per utente (token)');
    expect(rich.columns).not.toContain('Rispetto a 1 utente (%)');
    expect(rich.rows.map((r) => r.level)).toEqual([1, 2, 3, 4]);
    expect(rich.rows[0]!.cells.every((c, i) => i === 0 || c === '–')).toBe(true);
    expect(rich.rows[3]!.cells).toEqual(['4', '512', '128', '8192 condiviso', '1900', '42,5', '38,2', '380', '440', '170', '6100', '16', '0']);
    expect(usersTable([users(2, { contextPerUser: 4096, contextShared: false })], f).rows[0]!.cells[1]).toBe('4096');
    expect(soloDecode([users(2)])).toBeUndefined();
  });

  it('reads one level in a sentence, numbers only', () => {
    const solo = soloDecode([users(1)]);
    expect(usersSentence(users(4, { perRequestPrefillTpsP50: 1900 }), solo, f)).toBe(
      'Con 4 utenti ognuno legge a 1900 tok/s e scrive a 42,5 tok/s (85% di quando è da solo); il primo token arriva in 0,38 s (0,44 s nel caso peggiore). In tutto 170 tok/s.',
    );
    expect(usersSentence(users(1), solo, f)).toBe('Con 1 utente scrive a 50,0 tok/s; il primo token arriva in 0,32 s (0,37 s nel caso peggiore). In tutto 50 tok/s.');
    expect(usersSentence(users(2), undefined, f)).toContain('Con 2 utenti ognuno scrive a 47,5 tok/s;');
  });
});
