/**
 * Spills of runs saved before the shared memory was measured, recognized when the runs are read,
 * with the real numbers of the bug report (see real-5090-runs.ts).
 */
import { describe, expect, it } from 'vitest';
import { launchParamsSchema } from '../../../../src/contract/engines';
import type { RunResult } from '../../../../src/contract/results';
import { flaggedSummary, inferSpills, legacyFixes, spillFactsOf, withInferredSpill } from '../../../../src/core/store/legacy-spill';
import { summaryOf } from '../../../../src/core/store/runs-repo';
import { hardware, makeRun } from './fixtures';
import { cleanQ4, FACTS_27B, legacySpill, point, tuneRun } from './real-5090-runs';

/** inferSpills over runs keyed by id. */
const infer = (...runs: RunResult[]) => inferSpills(new Map(runs.map((r) => [r.id, spillFactsOf(r)])));
/** A copy of a run with another id, date and changes. */
const as = (run: RunResult, id: string, createdAt: string, change: (r: RunResult) => void = () => undefined): RunResult => {
  const copy = structuredClone({ ...run, id, createdAt });
  change(copy);
  return copy;
};
const withDecode = (run: RunResult, id: string, createdAt: string, decode: number) => as(run, id, createdAt, (r) => void (r.metrics.latency = [point(512, decode, 2000, 300)]));

describe('what a run says about its speed and a spill nobody saw', () => {
  it('the legacy Rapido: generation on its shortest prompt, a candidate (no shared-memory reading, Windows, all on the GPU)', () => {
    expect(spillFactsOf(legacySpill())).toEqual({
      id: legacySpill().id,
      createdAt: '2026-10-05T21:10:00.000Z',
      hostId: 'host-a',
      gpuKey: 'gpu:GPU-aaaa',
      engineKind: 'llamacpp-native',
      weakKey: legacySpill().model.weakKey,
      decodeTps: 3.5,
      clean: true,
      legacy: true,
    });
  });

  it('a newer run reads the shared memory: clean, never a candidate', () => {
    expect(spillFactsOf(cleanQ4())).toMatchObject({ decodeTps: 54.6, clean: true, legacy: false });
  });

  it('a tune run counts with its reference launch, else its recommended combination; never a candidate', () => {
    expect(spillFactsOf(tuneRun())).toMatchObject({ decodeTps: 53.7, clean: true, legacy: false });
    const noRef = as(tuneRun(), 'T2', '2026-10-04T19:00:00.000Z', (r) => (r.tuning!.attempts = r.tuning!.attempts.filter((a) => a.stage !== 'reference')));
    expect(spillFactsOf(noRef)).toMatchObject({ decodeTps: 54.8, clean: true, legacy: false });
    // A reference that did not load, or measured nothing short: the recommendation.
    const failedRef = as(tuneRun(), 'T3', '2026-10-04T19:00:00.000Z', (r) => {
      r.tuning!.attempts[0]!.outcome = 'spill';
      r.tuning!.attempts.push({ ...r.tuning!.attempts[1]!, stage: 'reference', points: [point(8192, 50, 1500, 5000)] });
    });
    expect(spillFactsOf(failedRef).decodeTps).toBe(54.8);
    // Nothing recommended, a recommendation that failed or measured nothing short: nothing to compare.
    for (const change of [
      (r: RunResult) => delete r.tuning!.recommended,
      (r: RunResult) => (r.tuning!.combinations[0]!.outcome = 'oom'),
      (r: RunResult) => (r.tuning!.combinations[0]!.sweep = [point(262_144, 27.9, 875, 300_000)]),
    ]) {
      const t = as(noRef, 'T4', '2026-10-04T19:00:00.000Z', change);
      expect(spillFactsOf(t)).toMatchObject({ clean: false, legacy: false });
      expect(spillFactsOf(t)).not.toHaveProperty('decodeTps');
    }
    // Speculative decoding generates faster than the card alone: not the usual speed.
    const draft = as(noRef, 'T5', '2026-10-04T19:00:00.000Z', (r) => (r.tuning!.combinations[0]!.tags = ['draft']));
    expect(spillFactsOf(draft)).toMatchObject({ decodeTps: 54.8, clean: false });
    // Part of the model on the CPU: slow by design, compared with nothing.
    const offload = as(noRef, 'T6', '2026-10-04T19:00:00.000Z', (r) => (r.tuning!.combinations[0]!.tags = ['cpu-offload']));
    expect(spillFactsOf(offload)).toMatchObject({ clean: false, legacy: false });
  });

  it('never a candidate: CPU offload on purpose, an external endpoint, Linux, failed, already flagged, no short prompt', () => {
    const offload = as(legacySpill(), 'O', '2026-10-05T21:00:00.000Z', (r) => {
      r.launch.params = launchParamsSchema.parse({ ...r.launch.params, gpuLayers: 40 });
      r.launch.argv = ['llama-server', '-ngl', '40'];
    });
    expect(spillFactsOf(offload)).toMatchObject({ clean: false, legacy: false });
    expect(spillFactsOf(offload)).not.toHaveProperty('decodeTps');
    const external = as(legacySpill(), 'E', '2026-10-05T21:00:00.000Z', (r) => (r.engine = { kind: 'external', name: 'endpoint' }));
    expect(spillFactsOf(external)).toMatchObject({ decodeTps: 3.5, clean: true, legacy: false });
    const linux = as(legacySpill(), 'L', '2026-10-05T21:00:00.000Z', (r) => (r.hardware = hardware({ os: { platform: 'linux', release: '6.8', arch: 'x64', name: 'Ubuntu', isWsl: false } })));
    expect(spillFactsOf(linux)).toMatchObject({ legacy: false });
    const wsl = as(linux, 'W', '2026-10-05T21:00:00.000Z', (r) => (r.hardware.os.isWsl = true));
    expect(spillFactsOf(wsl)).toMatchObject({ legacy: true });
    for (const r of [
      as(legacySpill(), 'F', '2026-10-05T21:00:00.000Z', (x) => (x.status = 'failed')),
      as(legacySpill(), 'S', '2026-10-05T21:00:00.000Z', (x) => (x.validity = ['shared_memory_spill'])),
      as(legacySpill(), 'D', '2026-10-05T21:00:00.000Z', (x) => (x.metrics.latency = [point(16_384, 3.5, 30, 500_000)])),
    ]) {
      expect(spillFactsOf(r)).toMatchObject({ clean: false, legacy: false });
    }
    // A run without a card and without a hash.
    expect(spillFactsOf(makeRun({ hardware: hardware({ gpus: [] }) })).gpuKey).toBe('host:host-a:none');
  });
});

describe('a legacy run far slower than the clean runs of the same model here spilled', () => {
  it('the bug report: 3,5 tok/s against 54,6 and 53,7 (median 54,15), about 15 times slower', () => {
    const found = infer(legacySpill(), cleanQ4(), tuneRun());
    expect([...found.keys()]).toEqual([legacySpill().id]);
    // Newest first.
    expect(found.get(legacySpill().id)).toEqual({ decodeTps: 3.5, normalDecodeTps: expect.closeTo(54.15, 6), normalRunIds: [cleanQ4().id, tuneRun().id] });
  });

  it('nothing clean to compare with: no inference (alone, or the others are on another card, PC, engine or model)', () => {
    expect(infer(legacySpill()).size).toBe(0);
    const elsewhere = [
      as(cleanQ4(), 'card', '2026-10-06T10:00:00.000Z', (r) => (r.hardware.gpus[0]!.uuid = 'GPU-bbbb')),
      as(cleanQ4(), 'pc', '2026-10-06T10:00:00.000Z', (r) => (r.hardware.hostId = 'host-b')),
      as(cleanQ4(), 'docker', '2026-10-06T10:00:00.000Z', (r) => (r.engine = { ...r.engine, kind: 'llamacpp-docker' })),
      as(cleanQ4(), 'model', '2026-10-06T10:00:00.000Z', (r) => (r.model = { ...r.model, weakKey: 'another' })),
    ];
    expect(infer(legacySpill(), ...elsewhere).size).toBe(0);
    // Only runs that cannot stand for the usual speed: a draft model, or one that spilled itself.
    const draft = as(cleanQ4(), 'draft', '2026-10-06T10:00:00.000Z', (r) => (r.launch.argv = [...r.launch.argv, '-md', 'small.gguf']));
    const flagged = as(cleanQ4(), 'flagged', '2026-10-06T10:00:00.000Z', (r) => (r.validity = ['shared_memory_spill']));
    expect(infer(legacySpill(), draft, flagged).size).toBe(0);
  });

  it('no inference for CPU offload or external endpoints, nor for a run just a little slower (0.4× is the limit)', () => {
    const offload = as(legacySpill(), 'offload', '2026-10-05T21:00:00.000Z', (r) => (r.launch.argv = [...r.launch.argv.slice(0, -1), '30']));
    const external = as(legacySpill(), 'external', '2026-10-05T21:00:00.000Z', (r) => (r.engine = { kind: 'external', name: 'endpoint' }));
    const ext2 = as(cleanQ4(), 'external-clean', '2026-10-06T10:00:00.000Z', (r) => (r.engine = { kind: 'external', name: 'endpoint' }));
    expect(infer(offload, external, ext2, cleanQ4(), tuneRun()).size).toBe(0);
    expect(infer(withDecode(legacySpill(), 'slowish', '2026-10-05T21:00:00.000Z', 0.41 * 54.15), cleanQ4(), tuneRun()).size).toBe(0);
    expect(infer(withDecode(legacySpill(), 'slow', '2026-10-05T21:00:00.000Z', 0.39 * 54.15), cleanQ4(), tuneRun()).size).toBe(1);
  });

  it('three spilled Rapido and a clean run that read the shared memory: three spills, against the clean run only', () => {
    const spills = [3.4, 3.6, 3.5].map((d, i) => withDecode(legacySpill(), `spill-${i}`, `2026-10-0${i + 1}T10:00:00.000Z`, d));
    const okLegacy = withDecode(legacySpill(), 'ok-legacy', '2026-10-04T10:00:00.000Z', 40);
    const found = infer(...spills, okLegacy, cleanQ4());
    expect([...found.keys()].sort()).toEqual(['spill-0', 'spill-1', 'spill-2']);
    for (const f of found.values()) expect(f).toMatchObject({ normalDecodeTps: 54.6, normalRunIds: [cleanQ4().id] });
  });

  it('only older runs: the other clean ones are the usual speed; a run found to have spilled leaves them', () => {
    const okLegacy = withDecode(legacySpill(), 'ok-legacy', '2026-10-03T10:00:00.000Z', 55);
    expect(infer(legacySpill(), okLegacy).get(legacySpill().id)).toEqual({ decodeTps: 3.5, normalDecodeTps: 55, normalRunIds: ['ok-legacy'] });
    // Two spills, two clean runs: each spill against the three others (median 54), then without the other spill.
    const runs = [3.4, 3.6, 55, 53].map((d, i) => withDecode(legacySpill(), `r${i}`, `2026-10-0${i + 1}T10:00:00.000Z`, d));
    const found = infer(...runs);
    expect([...found.keys()].sort()).toEqual(['r0', 'r1']);
    expect(found.get('r0')).toEqual({ decodeTps: 3.4, normalDecodeTps: 54, normalRunIds: ['r3', 'r2'] });
    // As many spills as clean runs or more, with nothing else to go by: in doubt, nothing is flagged.
    const doubt = [3.4, 3.6, 3.5, 55].map((d, i) => withDecode(legacySpill(), `d${i}`, `2026-10-0${i + 1}T10:00:00.000Z`, d));
    expect(infer(...doubt).size).toBe(0);
  });

  it('a run measured before its file was hashed is the same model as the hashed runs with its weak key', () => {
    const hashed = as(cleanQ4(), 'hashed', '2026-10-06T10:00:00.000Z', (r) => (r.model = { ...r.model, sha256: 'abc' }));
    expect(infer(legacySpill(), hashed).size).toBe(1);
    // Same weak key but two different files (hashes): not the same model.
    const other = as(legacySpill(), 'other-file', '2026-10-05T21:00:00.000Z', (r) => (r.model = { ...r.model, sha256: 'def' }));
    expect(infer(other, hashed).size).toBe(0);
    // Unreadable dates sort last, and do not stop the check.
    expect(infer(as(legacySpill(), 'nodate', 'garbage'), as(cleanQ4(), 'nodate-clean', 'garbage too')).size).toBe(1);
  });
});

describe('the run as it is shown and counted', () => {
  it('flagged first, with the spill "probabile" and what would have fit (the run’s own estimate)', () => {
    const run = legacySpill();
    const shown = withInferredSpill(run, { decodeTps: 3.5, normalDecodeTps: 54.15, normalRunIds: ['a', 'b'] });
    expect(shown.validity).toEqual(['shared_memory_spill']);
    const fixes = legacyFixes(run)!;
    // f16 at 256K needs ~33 GB of a 32 GB card with 1,6 GB in use: the q4_0 cache fits, or about 190K of f16.
    expect(fixes.kvCacheType).toBe('q4_0');
    expect(fixes.maxContext).toBeGreaterThan(160_000);
    expect(fixes.maxContext).toBeLessThan(262_144);
    expect(shown.metrics.spill).toEqual({ by: ['decode-collapse'], inferred: true, decodeTps: 3.5, normalDecodeTps: 54.15, normalRunIds: ['a', 'b'], fixes });
    // The run itself is untouched.
    expect(run.validity).toEqual([]);
    expect(run.metrics).not.toHaveProperty('spill');
    expect(flaggedSummary(summaryOf(run, 'f.json')).validity).toEqual(['shared_memory_spill']);
  });

  it('no fixes when they cannot be computed: no model facts, no card, nothing that would fit better', () => {
    const run = legacySpill();
    expect(legacyFixes({ ...run, model: { ...run.model, facts: undefined } })).toBeUndefined();
    expect(legacyFixes({ ...run, hardware: hardware({ gpus: [] }) })).toBeUndefined();
    const s = { decodeTps: 3.5, normalDecodeTps: 54.15, normalRunIds: [] };
    expect(withInferredSpill({ ...run, model: { ...run.model, facts: undefined } }, s).metrics.spill).not.toHaveProperty('fixes');
    // A small context that fits: the estimate offers no fix (only "Trova le impostazioni migliori" remains).
    const small = { ...run, launch: { ...run.launch, params: launchParamsSchema.parse({ contextSize: 4096 }) } };
    expect(legacyFixes(small)).toBeUndefined();
    // Without the file size (the weights from the parameters) or what was in use before (the whole card), it still works.
    const bare = { ...run, model: { ...run.model, sizeBytes: undefined, facts: { ...FACTS_27B, paramsB: 27, quant: 'Q4_K_M' } }, metrics: { ...run.metrics, vram: {} } };
    expect(legacyFixes(bare)).toMatchObject({ kvCacheType: 'q4_0' });
  });
});
