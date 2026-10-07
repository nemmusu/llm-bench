import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configParamsOf, gpuKeyOf, type ConfigEntry } from '../../../../src/contract/configs';
import { launchParamsSchema, type LaunchParams } from '../../../../src/contract/engines';
import type { ConcurrencyPoint, LatencyPoint, RunResult, RunSummary, TuneCombination, Tuning } from '../../../../src/contract/results';
import { comboSources, ConfigsIndex, depthPointsOf, mergeSources, queryConfigs, sourcesOf, type RunSources } from '../../../../src/core/store/configs-index';
import { RunsRepo, summaryOf } from '../../../../src/core/store/runs-repo';
import { hardware, latencyPoint, makeRun, modelIdentity, stat } from './fixtures';
import { cleanQ4, legacySpill } from './real-5090-runs';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const P = (over: Partial<LaunchParams> = {}): LaunchParams => launchParamsSchema.parse(over);
const HERE = { hostId: 'host-a', gpuUuid: 'GPU-aaaa', gpuName: 'NVIDIA GeForce RTX 5090' };
const HERE_KEY = gpuKeyOf(HERE);

/** A normal run started with these llama-server arguments (after the model). */
function run(id: string, createdAt: string, args: string[], over: Partial<RunResult> = {}): RunResult {
  return makeRun({
    id,
    createdAt,
    launch: { ...makeRun().launch, argv: ['llama-server', '-m', 'C:\\models\\q.gguf', '--port', String(40000 + id.length), ...args], params: P() },
    ...over,
  });
}

function point(depth: number, decode: number, prefill = 8000, ttft = 50): LatencyPoint {
  return { ...latencyPoint(depth, decode, prefill), ttftMs: stat(ttft) };
}

function concurrency(level: number, aggregateTps: number, perRequestDecodeTpsP50: number): ConcurrencyPoint {
  return { level, requests: level * 4, aggregateTps, perRequestDecodeTpsP50, ttftP50Ms: 80, ttftP95Ms: 120, errors: 0 };
}

function combo(params: Partial<LaunchParams>, sweep: LatencyPoint[], over: Partial<TuneCombination> = {}): TuneCombination {
  const p = P(params);
  return {
    params: p,
    kvType: p.kvCacheType === 'q8_0' ? 'q8_0' : 'f16',
    maxContext: p.contextSize ?? 4096,
    vramPeakMiB: 30000,
    sweep,
    command: { argv: ['llama-server', '-m', 'x.gguf', '-c', String(p.contextSize ?? 4096), ...p.extraArgs], powershell: '', bash: '' },
    outcome: 'ok',
    tags: [],
    ...over,
  };
}

function tuning(combinations: TuneCombination[]): Tuning {
  return { budget: 'fast', maxLaunches: 20, dimensions: [], capacity: [], depths: [1024, 4096], attempts: [], combinations, fastestByDepth: [] };
}

describe('depth points', () => {
  it('takes the medians per prompt length, the engine prefill first, the first point of a depth, nothing empty', () => {
    const engine = { ...point(4096, 150, 7000), prefillTpsEngine: stat(9000) };
    const empty = { ...point(8192, 0), decodeTps: stat(), prefillTps: stat(), ttftMs: stat() };
    expect(depthPointsOf([engine, point(512, 200, 8000, 40), point(512, 1), empty])).toEqual([
      { depth: 512, decodeTps: 200, prefillTps: 8000, ttftMs: 40 },
      { depth: 4096, decodeTps: 150, prefillTps: 9000, ttftMs: 50 },
    ]);
  });
});

describe('sources of a run', () => {
  it('a normal run is one source: its prompt lengths and context sweep, VRAM, context and most users', () => {
    const r = run('A1', '2026-10-01T10:00:00.000Z', ['-c', '8192', '-ub', '1024'], {
      metrics: {
        ...makeRun().metrics,
        latency: [point(512, 200), point(4096, 180)],
        contextSweep: [point(4096, 1), point(16384, 150)],
        concurrency: [concurrency(1, 200, 200), concurrency(4, 640, 160), concurrency(2, 380, 190)],
        vram: { processPeakMiB: 6000, deltaMiB: 7000, peakMiB: 8000 },
      },
    });
    const s = sourcesOf(r)!;
    expect(s).toMatchObject({
      engineKind: 'llamacpp-native',
      engineLabel: 'llama.cpp b11438 (CUDA 13.4)',
      engineRelease: 'b11438 CUDA 13.4',
      model: { format: 'gguf', name: 'Qwen3 4B Q4_K_M', quant: 'Q4_K_M', repo: 'Qwen/Qwen3-4B-GGUF' },
      gpu: { key: 'gpu:GPU-aaaa', name: 'NVIDIA GeForce RTX 5090', hostId: 'host-a', hostLabel: 'PC A' },
    });
    expect(s.sources).toEqual([
      {
        source: {
          runId: 'A1',
          date: '2026-10-01T10:00:00.000Z',
          profile: 'quick',
          contextSize: 8192,
          vramPeakMiB: 6000,
          parallel: { users: 4, totalTps: 640, perUserTps: 160 },
          points: [
            { depth: 512, decodeTps: 200, prefillTps: 8000, ttftMs: 50 },
            { depth: 4096, decodeTps: 180, prefillTps: 8000, ttftMs: 50 },
            { depth: 16384, decodeTps: 150, prefillTps: 8000, ttftMs: 50 },
          ],
        },
        params: { contextSize: 8192, ubatchSize: 1024, other: [] },
        tags: [],
      },
    ]);
  });

  it('VRAM falls back to the delta, then the peak; no context or users when unknown', () => {
    const vram = (v: RunResult['metrics']['vram']) => sourcesOf(run('V', '2026-10-01T10:00:00.000Z', [], { metrics: { ...makeRun().metrics, vram: v } }))!.sources[0]!.source;
    expect(vram({ deltaMiB: 4000, peakMiB: 5600 }).vramPeakMiB).toBe(4000);
    expect(vram({ peakMiB: 5600 }).vramPeakMiB).toBe(5600);
    const none = vram({});
    expect(none).not.toHaveProperty('vramPeakMiB');
    expect(none).not.toHaveProperty('contextSize');
    expect(none).not.toHaveProperty('parallel');
    const old = sourcesOf(run('O', '2026-10-01T10:00:00.000Z', [], { metrics: { ...makeRun().metrics, concurrency: [concurrency(8, 900, 0)] } }))!;
    expect(old.sources[0]!.source.parallel).toEqual({ users: 8, totalTps: 900 });
  });

  it('only completed runs that measured something count; a card-less run is this PC', () => {
    expect(sourcesOf(run('F', '2026-10-01T10:00:00.000Z', [], { status: 'failed' }))).toBeUndefined();
    expect(sourcesOf(run('E', '2026-10-01T10:00:00.000Z', [], { metrics: { ...makeRun().metrics, latency: [] } }))).toBeUndefined();
    const bare = sourcesOf(
      run('N', '2026-10-01T10:00:00.000Z', [], {
        hardware: hardware({ gpus: [] }),
        model: modelIdentity({ repo: undefined, quant: undefined, sha256: 'abc', revision: 'r1' }),
      }),
    )!;
    expect(bare.gpu).toEqual({ key: 'host:host-a:none', name: 'unknown', hostId: 'host-a', hostLabel: 'PC A' });
    expect(bare.model).toEqual({ format: 'gguf', weakKey: modelIdentity().weakKey, name: 'Qwen3 4B Q4_K_M', revision: 'r1', sha256: 'abc' });
  });

  it('a tune run gives one source per combination that loaded and was swept', () => {
    const r = run('T1', '2026-10-02T10:00:00.000Z', ['-c', '1024'], {
      scenario: { profile: 'tune', seed: 42, steps: [] },
      tuning: tuning([
        combo({ contextSize: 65536, kvCacheType: 'q8_0', flashAttention: 'on' }, [point(1024, 210), point(32768, 160)], { tags: ['draft'] }),
        combo({ contextSize: 131072, kvCacheType: 'q4_0' }, [point(1024, 200)], { outcome: 'oom' }),
        combo({ contextSize: 32768 }, []),
        combo({ contextSize: 32768, gpuLayers: 20, extraArgs: ['--n-cpu-moe', '4'] }, [point(1024, 90)], { vramPeakMiB: undefined }),
      ]),
    });
    const s = sourcesOf(r)!;
    expect(s.sources.map((x) => [x.source.combo, x.source.contextSize, x.source.vramPeakMiB, x.tags])).toEqual([
      [0, 65536, 30000, ['draft']],
      [3, 32768, undefined, ['cpu-offload']],
    ]);
    expect(s.sources[0]!.params).toEqual({ contextSize: 65536, cacheTypeK: 'q8_0', cacheTypeV: 'q8_0', flashAttention: 'on', other: [] });
    expect(s.sources[0]!.source.points.map((p) => p.depth)).toEqual([1024, 32768]);
    expect(comboSources(makeRun())).toEqual([]);
    expect(sourcesOf(run('T2', '2026-10-02T10:00:00.000Z', [], { tuning: tuning([]) }))).toBeUndefined();
  });

  it('a "Più utenti" combination is a source by its users at once (no sweep); the layout and cache reuse are part of it', () => {
    const users = (perUser: number) => [concurrency(1, 90, 90), concurrency(2, 160, 80), concurrency(4, 280, perUser)];
    const r = run('M1', '2026-10-02T10:00:00.000Z', [], {
      scenario: { profile: 'tune', seed: 42, steps: [] },
      tuning: tuning([
        combo({ contextSize: 32768, kvCacheType: 'q8_0', parallel: 4, extraArgs: ['--no-kv-unified', '--cache-reuse', '256'] }, [], { concurrency: users(70) }),
        combo({ contextSize: 32768, kvCacheType: 'q8_0', parallel: 4, extraArgs: ['--kv-unified'] }, [], { concurrency: users(0) }),
        combo({ contextSize: 32768, parallel: 4 }, [], { concurrency: [concurrency(1, 90, 90)] }),
        combo({ contextSize: 32768, parallel: 4 }, [], { concurrency: users(70), outcome: 'oom' }),
      ]),
    });
    const s = sourcesOf(r)!;
    expect(s.sources.map((x) => [x.source.combo, x.source.points, x.source.parallel])).toEqual([
      [0, [], { users: 4, totalTps: 280, perUserTps: 70 }],
      [1, [], { users: 4, totalTps: 280 }],
    ]);
    expect(s.sources[0]!.params).toEqual({ contextSize: 32768, cacheTypeK: 'q8_0', cacheTypeV: 'q8_0', parallel: 4, kvLayout: 'split', cacheReuse: 256, other: [] });
    expect(s.sources[1]!.params.kvLayout).toBe('unified');
  });
});

describe('merging sources into configurations', () => {
  const at = (h: number) => `2026-10-0${h}T10:00:00.000Z`;

  it('a test that spilled to shared memory is its own entry, marked: the clean numbers of the same settings stay clean', () => {
    const args = ['-c', '262144', '-fa', 'auto'];
    const clean = run('C1', at(1), args, { metrics: { ...makeRun().metrics, latency: [point(512, 53.7)] } });
    const spilled = run('S1', at(2), args, { validity: ['shared_memory_spill'], metrics: { ...makeRun().metrics, latency: [point(512, 3.5)] } });
    const entries = mergeSources([clean, spilled].map((r) => sourcesOf(r)!));
    expect(entries.map((e) => [e.sources.map((s) => s.runId), e.spill, e.points[0]!.decodeTps])).toEqual([
      [['S1'], true, 3.5],
      [['C1'], undefined, 53.7],
    ]);
    expect(entries[0]!.sources[0]!.spill).toBe(true);
    expect(entries[0]!.id).not.toBe(entries[1]!.id);
  });

  it('merges the same settings in another order: medians per depth, every test, highest VRAM', () => {
    const a = run('R1', at(1), ['-c', '8192', '-ub', '1024', '-fa', 'on'], { metrics: { ...makeRun().metrics, latency: [point(512, 200, 8000, 40), point(4096, 180)], vram: { deltaMiB: 4000 } } });
    const b = run('R2', at(3), ['-fa', 'on', '-ub', '1024', '-c', '8192'], { metrics: { ...makeRun().metrics, latency: [point(512, 210, 9000, 44)], vram: { deltaMiB: 4500 }, concurrency: [concurrency(4, 600, 150)] } });
    const c = run('R3', at(2), ['--ubatch-size', '1024', '-c', '8192', '--flash-attn', 'on'], { metrics: { ...makeRun().metrics, latency: [point(512, 190, 7000)], concurrency: [concurrency(4, 640, 160), concurrency(2, 380, 190)] } });
    const other = run('R4', at(4), ['-c', '8192', '-ub', '2048', '-fa', 'on']);
    const entries = mergeSources([a, b, c, other].map((r) => sourcesOf(r)!));
    expect(entries.map((e) => e.sources.map((s) => s.runId))).toEqual([['R4'], ['R2', 'R3', 'R1']]);
    const merged = entries[1]!;
    expect(merged.id).toMatch(/^[0-9a-f]{16}$/);
    expect(merged.latest).toBe(at(3));
    expect(merged.contextSize).toBe(8192);
    expect(merged.points).toEqual([
      { depth: 512, n: 3, decodeTps: 200, prefillTps: 8000, ttftMs: 44 },
      { depth: 4096, n: 1, decodeTps: 180, prefillTps: 8000, ttftMs: 50 },
    ]);
    expect(merged.vramPeakMiB).toBe(4500);
    expect(merged.parallel).toEqual({ users: 4, totalTps: 620, perUserTps: 155 });
    expect(merged.params).toEqual({ contextSize: 8192, ubatchSize: 1024, flashAttention: 'on', other: [] });
    expect(merged.model).toEqual({ key: 'weak:' + modelIdentity().weakKey, name: 'Qwen3 4B Q4_K_M', weakKey: modelIdentity().weakKey, quant: 'Q4_K_M', repo: 'Qwen/Qwen3-4B-GGUF' });
    expect(entries[0]!).not.toHaveProperty('parallel');
  });

  it('says only what was measured', () => {
    const decodeOnly = { ...point(512, 120), prefillTps: stat(), ttftMs: stat() };
    const noDecode = { ...point(1024, 0), decodeTps: stat() };
    const sparse = run('P1', at(1), ['-c', '2048'], {
      model: modelIdentity({ quant: undefined, repo: undefined }),
      metrics: { ...makeRun().metrics, latency: [decodeOnly, noDecode], vram: {}, concurrency: [concurrency(2, 300, 0)] },
    });
    const [entry] = mergeSources([sourcesOf(sparse)!]);
    expect(entry!.points).toEqual([
      { depth: 512, n: 1, decodeTps: 120 },
      { depth: 1024, n: 1, prefillTps: 8000, ttftMs: 50 },
    ]);
    expect(entry!.parallel).toEqual({ users: 2, totalTps: 300 });
    expect(entry!.model).toEqual({ key: `weak:${modelIdentity().weakKey}`, name: 'Qwen3 4B Q4_K_M', weakKey: modelIdentity().weakKey });
    expect(entry!).not.toHaveProperty('vramPeakMiB');
  });

  it('a GGUF run before its hash joins the hashed runs of the same file', () => {
    const hashed = run('H1', at(2), ['-c', '4096'], { model: modelIdentity({ sha256: 'ff00' }) });
    const before = run('H0', at(1), ['-c', '4096']);
    const [entry, ...rest] = mergeSources([sourcesOf(before)!, sourcesOf(hashed)!]);
    expect(rest).toEqual([]);
    expect(entry!.model).toMatchObject({ key: 'sha256:ff00', sha256: 'ff00' });
    expect(entry!.sources.map((s) => s.runId)).toEqual(['H1', 'H0']);
  });

  it('orders ties by run and combination, takes the context from the sources when the launch did not say it', () => {
    const t = run('T9', at(5), [], {
      tuning: tuning([combo({ contextSize: 8192 }, [point(1024, 100)]), combo({ contextSize: 8192, flashAttention: 'auto' }, [point(1024, 120)])]),
    });
    const same = run('T8', at(5), [], { tuning: tuning([combo({ contextSize: 8192 }, [point(1024, 110)])]) });
    const [entry] = mergeSources([sourcesOf(same)!, sourcesOf(t)!]);
    expect(entry!.sources.map((s) => [s.runId, s.combo])).toEqual([
      ['T9', 0],
      ['T9', 1],
      ['T8', 0],
    ]);
    expect(entry!.points).toEqual([{ depth: 1024, n: 3, decodeTps: 110, prefillTps: 8000, ttftMs: 50 }]);
    // A combination whose params lack the context: the configuration's context is its largest maximum.
    const loose = run('L1', at(6), [], { tuning: tuning([{ ...combo({}, [point(1024, 100)]), command: { argv: [], powershell: '', bash: '' }, maxContext: 16384 }]) });
    expect(mergeSources([sourcesOf(loose)!])[0]!.contextSize).toBe(16384);
    const unknown = run('U1', at(6), []);
    expect(mergeSources([sourcesOf(unknown)!])[0]!).not.toHaveProperty('contextSize');
    // Same date, two configurations: a stable order by id.
    const twins = mergeSources([sourcesOf(run('W1', at(7), ['-c', '1024']))!, sourcesOf(run('W2', at(7), ['-c', '2048']))!]);
    expect(twins.map((e) => e.id)).toEqual([...twins.map((e) => e.id)].sort());
  });
});

describe('querying configurations', () => {
  const entry = (id: string, over: Partial<ConfigEntry> = {}): ConfigEntry => ({
    id,
    engineKind: 'llamacpp-native',
    engineLabel: 'llama.cpp b1',
    engineRelease: 'b1',
    model: { key: `m-${id}`, name: `Model ${id}`, weakKey: id },
    gpu: { key: HERE_KEY, name: 'NVIDIA GeForce RTX 5090', hostId: 'host-a', hostLabel: 'PC A' },
    params: { other: [] },
    contextSize: 8192,
    points: [{ depth: 512, n: 1, decodeTps: 100 }],
    tags: [],
    sources: [{ runId: id, date: '2026-10-01T10:00:00.000Z', profile: 'quick', points: [] }],
    latest: '2026-10-01T10:00:00.000Z',
    ...over,
  });
  const other = { key: 'gpu:GPU-other', name: 'NVIDIA GeForce RTX 3070', hostId: 'host-b', hostLabel: 'PC B' };
  const other2 = { key: 'gpu:GPU-other2', name: 'NVIDIA GeForce RTX 3070', hostId: 'host-c', hostLabel: 'PC C' };
  const third = { key: 'gpu:GPU-x', name: 'NVIDIA GeForce RTX 4090', hostId: 'host-d', hostLabel: 'PC D' };
  const all = [
    entry('a', { contextSize: 65536, model: { key: 'm-q', name: 'Qwen', quant: 'Q4_K_M', weakKey: 'q' } }),
    entry('b', { engineKind: 'vllm-docker', model: { key: 'm-q', name: 'Qwen', weakKey: 'q' } }),
    entry('c', { contextSize: undefined, model: { key: 'm-g', name: 'Gemma', weakKey: 'g' } }),
    entry('d', { gpu: other }),
    entry('e', { gpu: other2 }),
    entry('f', { gpu: third }),
  ];

  it('shows this PC’s card by default, with the menus of that card and every card listed', () => {
    const r = queryConfigs(all, {}, HERE);
    expect(r.gpu).toBe(HERE_KEY);
    expect(r.configs.map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(r.models).toEqual([
      { key: 'm-g', name: 'Gemma' },
      { key: 'm-q', name: 'Qwen', quant: 'Q4_K_M' },
    ]);
    expect(r.engines).toEqual(['llamacpp-native', 'vllm-docker']);
    expect(r.gpus.map((g) => [g.key, g.here, g.configs])).toEqual([
      [HERE_KEY, true, 3],
      ['gpu:GPU-other', false, 1],
      ['gpu:GPU-other2', false, 1],
      ['gpu:GPU-x', false, 1],
    ]);
  });

  it('filters by card, model, engine and minimum context', () => {
    expect(queryConfigs(all, { gpu: 'all' }, HERE).configs).toHaveLength(6);
    expect(queryConfigs(all, { gpu: 'all' }, HERE).gpu).toBeNull();
    expect(queryConfigs(all, { gpu: 'gpu:GPU-other' }, HERE).configs.map((e) => e.id)).toEqual(['d']);
    expect(queryConfigs(all, { model: 'm-q' }, HERE).configs.map((e) => e.id)).toEqual(['a', 'b']);
    expect(queryConfigs(all, { engine: 'vllm-docker' }, HERE).configs.map((e) => e.id)).toEqual(['b']);
    expect(queryConfigs(all, { minContext: 32768 }, HERE).configs.map((e) => e.id)).toEqual(['a']);
    expect(queryConfigs(all, { minContext: 1 }, HERE).configs.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('shows every card when this PC has no configuration yet', () => {
    const r = queryConfigs(all.slice(3), {}, { hostId: 'host-z' });
    expect(r.gpu).toBeNull();
    expect(r.configs).toHaveLength(3);
  });
});

describe('ConfigsIndex', () => {
  it('reads each run once until its file changes, and skips what it cannot read', async () => {
    const good = makeRun({ id: 'G1' });
    const failed = makeRun({ id: 'F1', status: 'failed' });
    const empty = makeRun({ id: 'E1', metrics: { ...makeRun().metrics, latency: [] } });
    const summaries: RunSummary[] = [summaryOf(good, 'g.json'), summaryOf(failed, 'f.json'), summaryOf(empty, 'e.json'), summaryOf(makeRun({ id: 'X1' }), 'x.json')];
    const byFile: Record<string, RunResult | undefined> = { 'g.json': good, 'e.json': empty, 'x.json': undefined };
    const repo = { list: vi.fn(async () => summaries), read: vi.fn(async (s: Pick<RunSummary, 'file'>) => byFile[s.file]) };
    const index = new ConfigsIndex(repo);
    const first = await index.query({}, HERE);
    expect(first.configs.map((e) => e.sources[0]!.runId)).toEqual(['G1']);
    expect(repo.read.mock.calls.map((c) => c[0].file).sort()).toEqual(['e.json', 'g.json', 'x.json']);
    repo.read.mockClear();
    await index.query({}, HERE);
    // The unreadable file is tried again; the others come from the cache.
    expect(repo.read.mock.calls.map((c) => c[0].file)).toEqual(['x.json']);
  });

  it('works on a real results folder', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'gb-configs-'));
    dirs.push(dir);
    const repo = new RunsRepo(() => dir);
    await repo.save(run('S1', '2026-10-01T10:00:00.000Z', ['-c', '4096']));
    await repo.save(run('S2', '2026-10-02T10:00:00.000Z', ['-c', '4096']));
    const index = new ConfigsIndex(repo);
    const r = await index.query({}, HERE);
    expect(r.configs).toHaveLength(1);
    expect(r.configs[0]!.sources.map((s) => s.runId)).toEqual(['S2', 'S1']);
    expect(await repo.read({ file: 'missing.json' })).toBeUndefined();
  });

  it('an older run found to have spilled when read is its own marked entry, also once a clean run arrives later', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'gb-configs-'));
    dirs.push(dir);
    const repo = new RunsRepo(() => dir);
    const index = new ConfigsIndex(repo);
    await repo.save(legacySpill());
    // Alone, nothing says it spilled: its numbers count.
    expect((await index.query({}, HERE)).configs.map((e) => e.spill ?? false)).toEqual([false]);
    await repo.save(cleanQ4());
    const r = await index.query({}, HERE);
    const spilled = r.configs.find((e) => e.sources[0]!.runId === legacySpill().id)!;
    expect(spilled.spill).toBe(true);
    expect(spilled.points[0]).toMatchObject({ depth: 512, decodeTps: 3.5 });
    expect(r.configs.find((e) => e.sources[0]!.runId === cleanQ4().id)).not.toHaveProperty('spill');
  });
});

describe('a run’s settings agree with its configuration', () => {
  it('normal runs are keyed by what really ran', () => {
    const r = run('K1', '2026-10-01T10:00:00.000Z', ['-c', '4096', '-ngl', '99'], { model: modelIdentity({ facts: { blockCount: 36, contextLength: 40960 } }) });
    expect((sourcesOf(r) as RunSources).sources[0]!.params).toEqual(configParamsOf({ engineKind: 'llamacpp-native', params: P({ contextSize: 4096 }) }));
  });
});
