import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { launchParamsSchema } from '../../../../src/contract/engines';
import { AppError } from '../../../../src/contract/errors';
import { contextOf, fileStamp, parseRun, RunsRepo, summaryOf } from '../../../../src/core/store/runs-repo';
import { hardware, latencyPoint, makeRun, modelIdentity, stat } from './fixtures';
import { cleanQ4, legacySpill, tuneRun } from './real-5090-runs';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), 'gb-runs-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('parseRun', () => {
  it('accepts valid runs, drops unknown fields', () => {
    const run = parseRun({ ...makeRun(), extra: 'x' });
    expect(run?.id).toBe(makeRun().id);
    expect(run).not.toHaveProperty('extra');
  });
  it('skips non-objects, newer schemas and invalid content', () => {
    expect(parseRun(null)).toBeNull();
    expect(parseRun('x')).toBeNull();
    expect(parseRun({ ...makeRun(), schema: 2 })).toBeNull();
    expect(parseRun({ ...makeRun(), status: 'weird' })).toBeNull();
  });
});

describe('fileStamp', () => {
  it('UTC stamp, epoch for invalid dates', () => {
    expect(fileStamp('2026-10-06T09:08:07.000+02:00')).toBe('2026-10-06_07-08-07');
    expect(fileStamp('garbage')).toBe('1970-01-01_00-00-00');
  });
});

describe('context and parallel users in the summary', () => {
  const launch = (argv: string[], params: Record<string, number> = {}) => ({ ...makeRun().launch, argv, params: { ...makeRun().launch.params, ...params } });

  it('the context from the params (llama.cpp or vLLM), else from the command line', () => {
    expect(contextOf(launch(['llama-server'], { contextSize: 8192 }))).toBe(8192);
    expect(contextOf(launch(['vllm'], { maxModelLen: 4096 }))).toBe(4096);
    expect(contextOf(launch(['llama-server', '-m', 'x.gguf', '-c', '16384']))).toBe(16384);
    expect(contextOf(launch(['llama-server', '--ctx-size', '2048']))).toBe(2048);
    expect(contextOf(launch(['docker', 'run', 'img', '--max-model-len', '32768']))).toBe(32768);
    expect(contextOf(launch(['llama-server', '-c']))).toBeUndefined();
    expect(contextOf(launch(['llama-server', '-c', 'big']))).toBeUndefined();
    expect(contextOf(launch(['llama-server']))).toBeUndefined();
  });

  it('the most users served at once, with their combined speed; nothing for single-user tests', () => {
    const point = (level: number, aggregateTps: number) => ({ level, requests: level * 4, aggregateTps, perRequestDecodeTpsP50: 90, ttftP50Ms: 40, ttftP95Ms: 80, errors: 0 });
    const run = makeRun({ launch: launch(['llama-server'], { contextSize: 6144 }), metrics: { ...makeRun().metrics, concurrency: [point(1, 210), point(4, 640), point(2, 380)] } });
    expect(summaryOf(run, 'f')).toMatchObject({ contextSize: 6144, parallelUsers: 4, parallelTps: 640, parallelPerUserTps: 90 });
    const single = summaryOf(makeRun({ metrics: { ...makeRun().metrics, concurrency: [point(1, 210)] } }), 'f');
    expect(single).not.toHaveProperty('parallelUsers');
    expect(single).not.toHaveProperty('contextSize');
  });
});

describe('summaryOf', () => {
  it('tune runs: the recommended combination (its context sweep, context, KV cache, VRAM) and how many were measured', () => {
    const sweep = [latencyPoint(1024, 150, 9000), latencyPoint(4096, 140, 8000), latencyPoint(40816, 100, 5000)];
    const params = launchParamsSchema.parse({ contextSize: 40960, kvCacheType: 'q4_0' });
    const combination = {
      params,
      kvType: 'q4_0' as const,
      maxContext: 40960,
      vramPeakMiB: 13950,
      sweep,
      command: { argv: [], powershell: '', bash: '' },
      outcome: 'ok' as const,
      tags: [],
    };
    const run = makeRun({
      scenario: { profile: 'tune', seed: 42, steps: [] },
      launch: { ...makeRun().launch, params },
      metrics: { ...makeRun().metrics, latency: [], contextSweep: sweep },
      tuning: { budget: 'fast', maxLaunches: 24, dimensions: [], capacity: [], depths: [], attempts: [], combinations: [combination, { ...combination, kvType: 'f16' }], recommended: 0, fastestByDepth: [] },
    });
    expect(summaryOf(run, 'f')).toMatchObject({ profile: 'tune', decodeTps: 150, prefillTps: 5000, contextSize: 40960, kvCacheType: 'q4_0', tunedCombinations: 2, vramPeakMiB: 13950 });
    // Raw, unparsed JSON of an older run has no context sweep at all.
    const old = makeRun({ metrics: { ...makeRun().metrics, latency: [] } });
    delete (old.metrics as Partial<typeof old.metrics>).contextSweep;
    expect(summaryOf(old, 'f')).not.toHaveProperty('decodeTps');
    expect(summaryOf(old, 'f')).not.toHaveProperty('tunedCombinations');
  });

  it('headline numbers from the 512 point, prefill from the largest, VRAM delta', () => {
    const s = summaryOf(makeRun({ metrics: { ...makeRun().metrics, score: { value: 812, referenceVersion: 1 } } }), 'f.json');
    expect(s).toMatchObject({
      id: makeRun().id,
      profile: 'quick',
      modelName: 'Qwen3 4B Q4_K_M',
      quant: 'Q4_K_M',
      engineKind: 'llamacpp-native',
      engineLabel: 'llama.cpp b11438 (CUDA 13.4)',
      gpuName: 'NVIDIA GeForce RTX 5090',
      gpuUuid: 'GPU-aaaa',
      hostId: 'host-a',
      decodeTps: 200,
      prefillTps: 12000,
      ttftMs: 51,
      coldLoadMs: 9000,
      warmLoadMs: 1500,
      vramPeakMiB: 4000,
      score: 812,
      file: 'f.json',
    });
    expect(s).not.toHaveProperty('modelSha256');
  });
  it('engine-reported prefill wins; partial runs have partial summaries', () => {
    const withEngine = makeRun();
    withEngine.metrics.latency = [{ ...latencyPoint(2048), prefillTpsEngine: stat(15000) }];
    expect(summaryOf(withEngine, 'f').prefillTps).toBe(15000);
    expect(summaryOf(withEngine, 'f').decodeTps).toBe(200);

    const failed = makeRun({
      status: 'failed',
      hardware: hardware({ gpus: [] }),
      model: modelIdentity({ sha256: 'abc', quant: undefined }),
      engine: { kind: 'external', name: 'endpoint', version: '1.2' },
      metrics: {
        formulaVersion: 1,
        load: { phases: [] },
        latency: [{ ...latencyPoint(128), decodeTps: stat(), ttftMs: stat(), prefillTps: stat() }],
        contextSweep: [],
        sessions: [],
        concurrency: [],
        llamaBench: [],
        vram: { peakMiB: 3000 },
        energy: {},
        thermals: { throttleReasons: [] },
      },
    });
    const s = summaryOf(failed, 'g');
    expect(s).toMatchObject({ gpuName: 'unknown', engineLabel: 'endpoint 1.2', modelSha256: 'abc', vramPeakMiB: 3000 });
    for (const k of ['gpuUuid', 'decodeTps', 'prefillTps', 'ttftMs', 'coldLoadMs', 'warmLoadMs', 'score', 'quant']) expect(s).not.toHaveProperty(k);
    const bare = makeRun({ engine: { kind: 'vllm-docker', name: 'vLLM' } });
    bare.metrics = { ...bare.metrics, latency: [], vram: {} };
    expect(summaryOf(bare, 'h')).toMatchObject({ engineLabel: 'vLLM' });
    expect(summaryOf(bare, 'h')).not.toHaveProperty('vramPeakMiB');
    // The engine's own VRAM wins over the total delta when it could be measured per process.
    const perProcess = makeRun();
    perProcess.metrics = { ...perProcess.metrics, vram: { peakMiB: 24000, deltaMiB: 21900, processPeakMiB: 3110, method: 'process' } };
    expect(summaryOf(perProcess, 'p').vramPeakMiB).toBe(3110);
  });
});

describe('RunsRepo', () => {
  it('saves <stamp>_<id>.json atomically and never overwrites', async () => {
    const dir = tmp();
    const repo = new RunsRepo(() => dir);
    const run = makeRun();
    const f1 = await repo.save(run);
    expect(path.basename(f1)).toBe('2026-10-06_10-00-00_01K6Z0000000000000000000AA.json');
    const f2 = await repo.save(run);
    expect(path.basename(f2)).toBe('2026-10-06_10-00-00_01K6Z0000000000000000000AA_2.json');
    expect(JSON.parse(readFileSync(f1, 'utf8'))).toEqual(run);
    expect(readdirSync(dir).sort()).toEqual([path.basename(f1), path.basename(f2)].sort());
    expect((await repo.list()).map((x) => x.id)).toEqual([run.id, run.id]);
    const weird = await repo.save(makeRun({ id: '../../evil id' }));
    expect(path.dirname(weird)).toBe(path.resolve(dir));
    expect(path.basename(weird)).toBe('2026-10-06_10-00-00_______evil_id.json');
  });

  it('refuses to save an invalid run', async () => {
    await expect(new RunsRepo(() => tmp()).save({ ...makeRun(), status: 'nope' } as never)).rejects.toThrow();
  });

  it('lists newest first and skips anything unreadable', async () => {
    const dir = tmp();
    const repo = new RunsRepo(async () => dir);
    await repo.save(makeRun({ id: 'A', createdAt: '2026-10-01T00:00:00.000Z' }));
    await repo.save(makeRun({ id: 'B', createdAt: '2026-10-03T00:00:00.000Z' }));
    await repo.save(makeRun({ id: 'C', createdAt: '2026-10-03T00:00:00.000Z' }));
    await repo.save(makeRun({ id: 'D', createdAt: 'not a date' }));
    await repo.save(makeRun({ id: 'E', createdAt: 'still not a date' }));
    writeFileSync(path.join(dir, 'broken.json'), '{nope');
    writeFileSync(path.join(dir, 'array.json'), '[1,2]');
    writeFileSync(path.join(dir, 'newer.json'), JSON.stringify({ ...makeRun({ id: 'N' }), schema: 99 }));
    writeFileSync(path.join(dir, 'notes.txt'), 'hello');
    mkdirSync(path.join(dir, 'folder.json'));
    // Dangling link (a junction needs no privileges on Windows): listed by readdir, stat fails.
    symlinkSync(path.join(dir, 'gone'), path.join(dir, 'dangling.json'), 'junction');
    writeFileSync(path.join(dir, 'UPPER.JSON'), JSON.stringify(makeRun({ id: 'U', createdAt: '2026-09-01T00:00:00.000Z' })));
    const list = await repo.list();
    expect(list.map((s) => s.id)).toEqual(['C', 'B', 'A', 'U', 'E', 'D']);
    expect(list.find((s) => s.id === 'U')?.file).toBe('UPPER.JSON');
  });

  it('re-listing reuses unchanged files and notices changes and deletions', async () => {
    const dir = tmp();
    const repo = new RunsRepo(() => dir);
    const file = await repo.save(makeRun({ id: 'X', note: 'aaaa' }));
    // Whole-second mtimes survive utimes() exactly on every filesystem.
    const mtime = new Date(Date.UTC(2026, 0, 1));
    utimesSync(file, mtime, mtime);
    expect((await repo.list())[0]?.id).toBe('X');
    // Same size and mtime: served from the cache even though the content changed.
    const { size } = statSync(file);
    const changed = readFileSync(file, 'utf8').replace('"id":"X"', '"id":"Y"');
    writeFileSync(file, changed);
    utimesSync(file, mtime, mtime);
    expect(statSync(file).size).toBe(size);
    expect((await repo.list())[0]?.id).toBe('X');
    // A new mtime forces a re-read.
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    expect((await repo.list())[0]?.id).toBe('Y');
    rmSync(file);
    expect(await repo.list()).toEqual([]);
  });

  it('a missing folder is an empty list; the folder can change at runtime', async () => {
    const a = tmp();
    const b = tmp();
    let current = path.join(a, 'missing');
    const repo = new RunsRepo(() => current);
    expect(await repo.list()).toEqual([]);
    current = a;
    await repo.save(makeRun({ id: 'in-a' }));
    current = b;
    await repo.save(makeRun({ id: 'in-b' }));
    expect((await repo.list()).map((s) => s.id)).toEqual(['in-b']);
    expect(await repo.get('in-a')).toBeUndefined();
    current = a;
    expect((await repo.get('in-a'))?.id).toBe('in-a');
    expect(await repo.dir()).toBe(path.resolve(a));
  });

  it('get / delete by id', async () => {
    const dir = tmp();
    const repo = new RunsRepo(() => dir);
    const file = await repo.save(makeRun({ id: 'G' }));
    const mtime = new Date(Date.UTC(2026, 0, 1));
    utimesSync(file, mtime, mtime);
    expect((await repo.get('G'))?.model.displayName).toBe('Qwen3 4B Q4_K_M');
    expect(await repo.get('nope')).toBeUndefined();
    // Corrupted after being listed (same size + mtime keeps the cached summary): get gives undefined.
    const { size } = statSync(file);
    writeFileSync(file, 'x'.repeat(size));
    utimesSync(file, mtime, mtime);
    expect(await repo.get('G')).toBeUndefined();
    expect(await repo.delete('G')).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
    expect(await repo.delete('G')).toBe(false);
  });

  it('tried(): this PC + GPU first, then the same GPU elsewhere, then the rest', async () => {
    const dir = tmp();
    const repo = new RunsRepo(() => dir);
    const other = hardware({ hostId: 'host-b', gpus: [{ ...hardware().gpus[0]!, uuid: 'GPU-bbbb' }] });
    const otherGpu = hardware({ hostId: 'host-c', gpus: [{ ...hardware().gpus[0]!, uuid: 'GPU-cccc', name: 'RTX 3070' }] });
    const movedCard = hardware({ hostId: 'host-d', gpus: [{ ...hardware().gpus[0]!, name: 'renamed' }] });
    await repo.save(makeRun({ id: 'far', createdAt: '2026-10-05T00:00:00.000Z', hardware: otherGpu }));
    await repo.save(makeRun({ id: 'same-gpu', createdAt: '2026-10-04T00:00:00.000Z', hardware: other }));
    await repo.save(makeRun({ id: 'moved', createdAt: '2026-10-04T12:00:00.000Z', hardware: movedCard }));
    await repo.save(makeRun({ id: 'here-old', createdAt: '2026-10-01T00:00:00.000Z' }));
    await repo.save(makeRun({ id: 'here-new', createdAt: '2026-10-02T00:00:00.000Z', model: modelIdentity({ sha256: 'S', weakKey: 'other' }) }));
    await repo.save(makeRun({ id: 'unrelated', model: modelIdentity({ weakKey: 'zzz' }) }));
    const here = { hostId: 'host-a', gpuUuid: 'GPU-aaaa', gpuName: 'NVIDIA GeForce RTX 5090' };
    const ids = (await repo.tried({ sha256: 'S', weakKey: modelIdentity().weakKey }, here)).map((s) => s.id);
    expect(ids).toEqual(['here-new', 'here-old', 'moved', 'same-gpu', 'far']);
    // Without sha256 only the weak key matches; without a GPU identity only the host counts.
    expect((await repo.tried({ weakKey: modelIdentity().weakKey }, { hostId: 'host-b' })).map((s) => s.id)).toEqual([
      'same-gpu',
      'far',
      'moved',
      'here-old',
    ]);
  });

  it('exports and imports bundles, skipping known, invalid and newer runs', async () => {
    const srcDir = tmp();
    const src = new RunsRepo(() => srcDir);
    await src.save(makeRun({ id: 'R1' }));
    await src.save(makeRun({ id: 'R2' }));
    const bundle = await src.exportRuns(['R1', 'R2', 'missing']);
    expect(bundle.format).toBe('gpubench-export');
    expect(bundle.version).toBe(1);
    expect(bundle.runs.map((r) => r.id)).toEqual(['R1', 'R2']);

    const dstDir = tmp();
    const dst = new RunsRepo(() => dstDir);
    await dst.save(makeRun({ id: 'R2' }));
    const json = JSON.parse(JSON.stringify({ ...bundle, runs: [...bundle.runs, { junk: true }, { ...makeRun({ id: 'R9' }), schema: 5 }, bundle.runs[0]] }));
    expect(await dst.importBundle(json)).toEqual({ imported: 1, skipped: 4 });
    expect((await dst.list()).map((s) => s.id).sort()).toEqual(['R1', 'R2']);
  });

  it('rejects files that are not exports or come from a newer app', async () => {
    const dir = tmp();
    const repo = new RunsRepo(() => dir);
    await expect(repo.importBundle({ hello: 1 })).rejects.toMatchObject({ code: 'VALIDATION', params: { reason: 'not_export' } });
    const err = await repo.importBundle({ format: 'gpubench-export', version: 2, runs: [] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).params).toEqual({ reason: 'export_too_new', version: 2 });
  });
});

describe('RunsRepo: older runs that spilled unnoticed (saved before the shared memory was measured)', () => {
  it('the bug report: flagged in every list, the run "probabile" with its numbers and fixes; the files untouched', async () => {
    const dir = tmp();
    const repo = new RunsRepo(() => dir);
    const files = [await repo.save(legacySpill()), await repo.save(cleanQ4()), await repo.save(tuneRun())];
    const before = files.map((f) => readFileSync(f, 'utf8'));
    const here = { hostId: 'host-a', gpuUuid: 'GPU-aaaa', gpuName: 'NVIDIA GeForce RTX 5090' };
    const list = await repo.list();
    const flagged = (l: { id: string; validity: string[] }[]) => l.filter((s) => s.validity.includes('shared_memory_spill')).map((s) => s.id);
    expect(flagged(list)).toEqual([legacySpill().id]);
    expect(flagged(await repo.tried({ weakKey: legacySpill().model.weakKey }, here))).toEqual([legacySpill().id]);
    // ConfigsIndex keys on the summary object: the same one while nothing changes.
    const again = await repo.list();
    expect(again.find((s) => s.id === legacySpill().id)).toBe(list.find((s) => s.id === legacySpill().id));
    expect(again.find((s) => s.id === cleanQ4().id)).toBe(list.find((s) => s.id === cleanQ4().id));

    const run = (await repo.get(legacySpill().id))!;
    expect(run.validity).toEqual(['shared_memory_spill']);
    expect(run.metrics.spill).toMatchObject({ by: ['decode-collapse'], inferred: true, decodeTps: 3.5, normalRunIds: [cleanQ4().id, tuneRun().id], fixes: { kvCacheType: 'q4_0' } });
    expect(run.metrics.spill!.normalDecodeTps).toBeCloseTo(54.15, 6);
    const viaSummary = (await repo.read(list.find((s) => s.id === legacySpill().id)!))!;
    expect(viaSummary.metrics.spill?.inferred).toBe(true);
    expect((await repo.get(cleanQ4().id))!.metrics).not.toHaveProperty('spill');
    // Exports carry the files as they are: another PC finds the spill again by itself.
    const bundle = await repo.exportRuns([legacySpill().id]);
    expect(bundle.runs[0]!.validity).toEqual([]);
    expect(bundle.runs[0]!.metrics).not.toHaveProperty('spill');
    expect(files.map((f) => readFileSync(f, 'utf8'))).toEqual(before);
  });

  it('checked again when the runs change: a clean run arrives, it is deleted', async () => {
    const dir = tmp();
    const repo = new RunsRepo(() => dir);
    await repo.save(legacySpill());
    // Nothing to compare with yet: its numbers count.
    const alone = await repo.list();
    expect(alone[0]!.validity).toEqual([]);
    expect((await repo.get(legacySpill().id))!.metrics).not.toHaveProperty('spill');
    await repo.save(cleanQ4());
    const withClean = await repo.list();
    expect(withClean.find((s) => s.id === legacySpill().id)!.validity).toEqual(['shared_memory_spill']);
    expect(await repo.delete(cleanQ4().id)).toBe(true);
    const back = await repo.list();
    // The very same object as before the clean run: unchanged files keep their summaries.
    expect(back[0]).toBe(alone[0]);
  });
});
