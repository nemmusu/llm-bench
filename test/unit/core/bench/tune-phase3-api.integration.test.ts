/**
 * "Trova le impostazioni migliori", phase 3, end to end through the core's HTTP API (real core, real
 * llama.cpp adapter and process runner, the fake llama-server and the fake nvidia-smi):
 *  - goal 'multi' ("Più utenti") with MULTI_PROFILE: 4 users × 8K, the KV pool split per user wins,
 *    users 1…4 in order, the conversations' cache reuse, the server plan for 4 users;
 *  - "Ricontrollo rapido" of a tune made with another llama.cpp build (seeded in the results folder):
 *    the plan offers it, the server plan says so, a recheck that finds other numbers says so and keeps
 *    the recommendation, a recheck that no longer fits says so and the server plan stops using it.
 * The fake engine reads its profile from a file at every launch, so the "machine" changes between runs.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ActiveRunResponse, RunPlan, ServerPlan, SystemResponse } from '../../../../src/contract/api';
import { launchParamsSchema } from '../../../../src/contract/engines';
import type { LocalModel } from '../../../../src/contract/models';
import type { RunResult, RunSummary, Tuning } from '../../../../src/contract/results';
import { boot, type BootEnv } from '../../../../src/core/bootstrap';
import { buildGguf, llamaLikeGguf } from '../../../fakes/fake-hub/model-files.mjs';
import { MULTI_PROFILE, TUNE_PROFILE } from '../../../fakes/fake-engine/profiles.mjs';
import { combo, point } from './tune-helpers';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const CLI = path.join(ROOT, 'test', 'fakes', 'fake-engine', 'cli.mjs');
const SMI = path.join(ROOT, 'test', 'fakes', 'fake-nvidia-smi', 'fake-nvidia-smi.mjs');

let dir: string;
let profileFile: string;
let core: Awaited<ReturnType<typeof boot>>;
const token = 'tune3-test-token';
const engine = { kind: 'llamacpp-native', executable: CLI };

async function api<T>(method: string, route: string, body?: unknown): Promise<T> {
  const res = await fetch(`${core.url}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json()) as T;
  if (!res.ok) throw Object.assign(new Error(`${method} ${route}: ${res.status} ${JSON.stringify(json)}`), { body: json });
  return json;
}

const profile = (p: object) => writeFileSync(profileFile, JSON.stringify(p));

async function runToEnd(request: object): Promise<RunResult> {
  const { runId } = await api<{ runId: string }>('POST', '/api/runs', request);
  await vi.waitFor(async () => expect((await api<ActiveRunResponse>('GET', '/api/runs/active')).active).toBeNull(), { timeout: 240_000, interval: 500 });
  return api<RunResult>('GET', `/api/runs/${runId}`);
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'gb-tune3-api-'));
  writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ scanKnownLocations: false }));
  const gguf = path.join(dir, 'models', 'local', 'Qwen3-0.6B-Q4_K_M.gguf');
  mkdirSync(path.dirname(gguf), { recursive: true });
  writeFileSync(gguf, buildGguf({ ...llamaLikeGguf({ name: 'Qwen3 0.6B', sizeLabel: '0.6B' }), totalSize: 96 * 1024 }));
  const smiState = path.join(dir, 'fake-nvidia-smi.json');
  writeFileSync(smiState, JSON.stringify({ gpus: [{ memUsedMiB: 1600, powerW: 38, utilPct: 1, tempC: 39 }] }));
  profileFile = path.join(dir, 'engine-profile.json');
  profile(MULTI_PROFILE);
  const host: BootEnv = {
    env: {
      ...process.env,
      GPUBENCH_DATA_DIR: dir,
      GPUBENCH_MODELS_DIR: path.join(dir, 'models'),
      GPUBENCH_RESOURCES_DIR: path.join(ROOT, 'resources'),
      GPUBENCH_TOKEN: token,
      GPUBENCH_NVIDIA_SMI: JSON.stringify([process.execPath, SMI]),
      GPUBENCH_LLAMA_LAUNCHER: JSON.stringify([process.execPath]),
      GPUBENCH_GITHUB_API: 'http://127.0.0.1:9',
      GPUBENCH_HF_ENDPOINT: 'http://127.0.0.1:9',
      FAKE_NVIDIA_SMI_STATE: smiState,
      FAKE_ENGINE_PROFILE: profileFile,
    },
    argv: [],
    platform: process.platform,
    arch: process.arch,
    home: dir,
    dirname: path.join(ROOT, 'out', 'core'),
    appVersion: '0.0.0-test',
    stdout: () => undefined,
    stderr: () => undefined,
    onSignal: () => undefined,
    exit: () => undefined,
    takeCoverage: () => undefined,
  };
  core = await boot(host);
}, 60_000);

afterAll(async () => {
  await core?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('goal "Più utenti" through the API (fake llama-server, MULTI_PROFILE)', () => {
  it('finds the KV types that hold 4 users × 8K, the fastest settings with everyone busy, measures users 1…4 and the conversations', async () => {
    profile(MULTI_PROFILE);
    const [model] = await api<LocalModel[]>('GET', '/api/models/local');
    const request = { engine, model: { localId: model!.id }, profile: 'tune', tune: { budget: 'fast', goal: 'multi', users: 4, perUserContext: 8192 }, allowSharedGpu: true };
    const plan = await api<RunPlan>('POST', '/api/runs/plan', request);
    expect(plan).toMatchObject({ estimatedSeconds: plan.tuneSeconds!.fast, scenario: { profile: 'tune' } });
    expect(plan.previousTune).toBeUndefined();

    const run = await runToEnd(request);
    expect(run.status).toBe('completed');
    const t = run.tuning!;
    expect(t).toMatchObject({ goal: 'multi', multi: { users: 4, perUserContext: 8192, promptTokens: 8192 - 128 - 16, outputTokens: 128, turns: 3 } });
    expect(t.multi?.fittingUsers).toBeUndefined();
    // f16 cannot hold 4 × 8K; q8_0 and q4_0 can (the less precise one is known without a launch).
    expect(Object.fromEntries(t.capacity.map((c) => [c.kvType, c.measuredMax]))).toEqual({ f16: undefined, q8_0: 32768, q4_0: 32768 });
    expect(t.attempts.find((a) => a.kvType === 'f16' && a.stage === 'capacity')).toMatchObject({ outcome: 'oom', contextSize: 32768 });
    // Every launch has 4 slots and the whole context of the 4 users.
    for (const a of t.attempts.filter((x) => x.stage !== 'reference')) expect(a.params).toMatchObject({ parallel: 4, contextSize: 32768 });
    const layouts = t.attempts.filter((a) => a.stage === 'variant' && a.variant?.layout === 'split');
    expect(layouts.length).toBeGreaterThan(0);
    expect(layouts.every((a) => a.command.argv.includes('--no-kv-unified'))).toBe(true);
    expect(t.attempts.some((a) => a.command.argv.includes('--cache-reuse'))).toBe(true);


    const rec = t.combinations[t.recommended!]!;
    expect(rec).toMatchObject({ kvType: 'q8_0', maxContext: 32768, kvLayout: 'split', usersWithoutErrors: 4, params: { ubatchSize: 2048, parallel: 4 } });
    expect(rec.cacheReuse).toBeUndefined();
    expect(rec.sweep).toEqual([]);
    expect(rec.concurrency!.map((p) => p.level)).toEqual([1, 2, 3, 4]);
    expect(rec.concurrency!.every((p) => p.errors === 0 && p.promptTokens === 8048 && p.contextPerUser === 8192 && p.contextShared === false)).toBe(true);
    // The conversations: 4 at once, the later messages read from each slot's cache.
    expect(rec.sessions).toHaveLength(1);
    expect(rec.sessions![0]).toMatchObject({ sessions: 4, turns: 3, errors: 0, prefixCache: { source: 'cached-tokens' } });
    expect(rec.sessions![0]!.prefixCache!.hitRate).toBeGreaterThan(0.5);
    expect(t.fastestByDepth).toEqual([]);
    // The run is described by its recommendation: users 1…4 and the conversations.
    expect(run.metrics.concurrency).toEqual(rec.concurrency);
    expect(run.metrics.sessions).toEqual(rec.sessions);
    const [summary] = await api<RunSummary[]>('GET', '/api/runs');
    expect(summary).toMatchObject({ profile: 'tune', tuneGoal: 'multi', tuneUsers: 4, tunePerUserContext: 8192, tuneBudget: 'fast', engineBuild: 'b10997', parallelUsers: 4 });

    // "Avvia il server così" for 4 users: this recommendation; for one user there is no tune.
    const server = await api<ServerPlan>('POST', '/api/servers/plan', { engine, model: { localId: model!.id }, params: launchParamsSchema.parse({ parallel: 4 }) });
    expect(server).toMatchObject({ contextSize: 32768, tuned: { runId: run.id, goal: 'multi', users: 4, kvCacheType: 'q8_0' }, params: { parallel: 4, ubatchSize: 2048 } });
    expect(server.tuned?.otherBuild).toBeUndefined();
    expect(server.command.argv).toContain('--no-kv-unified');
    const single = await api<ServerPlan>('POST', '/api/servers/plan', { engine, model: { localId: model!.id } });
    expect(single.tuned).toBeUndefined();
    // The plan of the same question now knows the previous tune, with the same build.
    expect((await api<RunPlan>('POST', '/api/runs/plan', request)).previousTune).toMatchObject({ runId: run.id, budget: 'fast', build: 'b10997', currentBuild: 'b10997', sameBuild: true });
  }, 300_000);
});

describe('"Ricontrollo rapido" through the API', () => {
  /** A finished 'single' tune of this model here, made with llama.cpp b10000, written to the results folder. */
  async function seedOldTune(id: string, combos: Tuning['combinations']): Promise<void> {
    const sys = await api<SystemResponse>('GET', '/api/system');
    const [model] = await api<LocalModel[]>('GET', '/api/models/local');
    const any = (await api<RunSummary[]>('GET', '/api/runs'))[0]!;
    const template = await api<RunResult>('GET', `/api/runs/${any.id}`);
    const tuning: Tuning = {
      budget: 'fast',
      maxLaunches: 24,
      dimensions: [],
      capacity: [],
      depths: [1024],
      attempts: [],
      combinations: combos,
      recommended: 0,
      fastestByDepth: [],
    };
    const run: RunResult = {
      ...template,
      id,
      createdAt: '2026-10-01T10:00:00.000Z',
      finishedAt: '2026-10-01T10:05:00.000Z',
      hardware: { ...template.hardware, hostId: sys.hostId },
      model: model!.identity,
      engine: { ...template.engine, build: 'b10000' },
      tuning,
      metrics: { ...template.metrics, concurrency: [], sessions: [] },
    };
    const results = sys.paths.resultsDir;
    writeFileSync(path.join(results, `2026-10-01_10-00-00_${id}.json`), JSON.stringify(run));
  }

  const q4 = (decode: number) =>
    combo('q4_0', 40960, [point(1024, decode), point(16384, decode), point(40816, decode)], {
      params: launchParamsSchema.parse({ contextSize: 40960, kvCacheType: 'q4_0', flashAttention: 'on', ubatchSize: 2048, batchSize: 2048, parallel: 1 }),
      variant: { kv: 'q4_0', fa: 'on', ub: 2048, b: 2048 },
    });

  it('offers the recheck for an older build, re-checks the recommendation and the runner-up, says what moved and keeps the recommendation', async () => {
    profile(TUNE_PROFILE);
    // The previous run measured an absurdly slow engine: anything measured now moves beyond noise.
    const runnerUp = combo('q8_0', 32768, [point(1024, 5), point(16384, 5), point(32624, 5)], {
      params: launchParamsSchema.parse({ contextSize: 32768, kvCacheType: 'q8_0', flashAttention: 'on', ubatchSize: 512, batchSize: 2048, parallel: 1 }),
      variant: { kv: 'q8_0', fa: 'on', ub: 512, b: 2048 },
    });
    await seedOldTune('OLDTUNE1', [q4(5), runnerUp]);
    const [model] = await api<LocalModel[]>('GET', '/api/models/local');
    const single = { engine, model: { localId: model!.id }, profile: 'tune', allowSharedGpu: true };
    const plan = await api<RunPlan>('POST', '/api/runs/plan', { ...single, tune: { budget: 'fast' } });
    expect(plan.previousTune).toMatchObject({ runId: 'OLDTUNE1', build: 'b10000', currentBuild: 'b10997', sameBuild: false });
    const server = await api<ServerPlan>('POST', '/api/servers/plan', { engine, model: { localId: model!.id } });
    expect(server.tuned).toMatchObject({ runId: 'OLDTUNE1', contextSize: 40960, otherBuild: { build: 'b10000', current: 'b10997' } });
    // Two launches with a short sweep each: much shorter than a search.
    const recheckPlan = await api<RunPlan>('POST', '/api/runs/plan', { ...single, tune: { budget: 'recheck' } });
    expect(recheckPlan.estimatedSeconds).toBeGreaterThan(0);
    expect(recheckPlan.estimatedSeconds).toBeLessThan(recheckPlan.tuneSeconds!.fast);

    const run = await runToEnd({ ...single, tune: { budget: 'recheck' } });
    expect(run.status).toBe('completed');
    const t = run.tuning!;
    expect(t.budget).toBe('recheck');
    expect(t.attempts.map((a) => [a.stage, a.kvType, a.contextSize, a.outcome])).toEqual([
      ['recheck', 'q4_0', 40960, 'ok'],
      ['recheck', 'q8_0', 32768, 'ok'],
    ]);
    // The exact previous commands again, with the short sweep: 1K, the middle, the deepest prompt.
    expect(t.attempts[0]!.params).toMatchObject({ contextSize: 40960, kvCacheType: 'q4_0', ubatchSize: 2048 });
    expect(t.combinations[0]!.sweep.map((p) => p.promptTokens)).toEqual([1024, 16384, 40816]);
    expect(t.recheck).toMatchObject({ previousRunId: 'OLDTUNE1', previousBuild: 'b10000', currentBuild: 'b10997', result: 'changed', suggestFull: true });
    expect(t.recheck!.checks.map((c) => [c.role, c.fits, c.combination])).toEqual([
      ['recommended', true, 0],
      ['runner-up', true, 1],
    ]);
    expect(t.recheck!.checks[0]!.moved.filter((m) => m.metric === 'decode').map((m) => m.at)).toEqual([1024, 16384, 40960]);
    expect(t.recommended).toBe(0);
    const [summary] = await api<RunSummary[]>('GET', '/api/runs');
    expect(summary).toMatchObject({ id: run.id, tuneBudget: 'recheck', engineBuild: 'b10997' });
    // The server now takes the recheck: same build, the same settings as before.
    const after = await api<ServerPlan>('POST', '/api/servers/plan', { engine, model: { localId: model!.id } });
    expect(after.tuned).toMatchObject({ runId: run.id, contextSize: 40960, kvCacheType: 'q4_0' });
    expect(after.tuned?.otherBuild).toBeUndefined();
  }, 300_000);

  it('a recommendation that no longer fits: said so, no recommendation, the server goes back to the estimate', async () => {
    // A card with less memory: q4_0 at 40K runs out of memory now.
    profile({ ...TUNE_PROFILE, memory: { ...TUNE_PROFILE.memory, totalMiB: 12_000, spillMiB: 0 } });
    const [model] = await api<LocalModel[]>('GET', '/api/models/local');
    const req = { engine, model: { localId: model!.id }, profile: 'tune', allowSharedGpu: true, tune: { budget: 'recheck' } };
    const run = await runToEnd(req);
    const t = run.tuning!;
    expect(t.recheck).toMatchObject({ result: 'no-longer-fits', suggestFull: true });
    expect(t.recheck!.checks[0]).toMatchObject({ role: 'recommended', fits: false, outcome: 'oom' });
    expect(t.recommended).toBeUndefined();
    const server = await api<ServerPlan>('POST', '/api/servers/plan', { engine, model: { localId: model!.id } });
    expect(server.tuned).toBeUndefined();
    // Nothing to re-check for another question (goal 'multi' with 8 users).
    await expect(api('POST', '/api/runs', { ...req, tune: { budget: 'recheck', goal: 'multi', users: 8 } })).rejects.toMatchObject({ body: { error: { code: 'VALIDATION', params: { reason: 'recheck_nothing' } } } });
  }, 300_000);
});
