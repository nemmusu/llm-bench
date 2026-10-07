/**
 * "Trova le impostazioni migliori" end to end through the core's HTTP API: the real core (boot), the
 * real llama.cpp adapter and process runner, the fake llama-server with the TUNE_PROFILE memory model
 * and the fake nvidia-smi. POST /api/runs (profile 'tune') → live state → saved RunResult.tuning →
 * the server plan takes its recommendation.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ActiveRunResponse, ServerPlan } from '../../../../src/contract/api';
import type { LocalModel } from '../../../../src/contract/models';
import type { RunResult, RunSummary } from '../../../../src/contract/results';
import { boot, type BootEnv } from '../../../../src/core/bootstrap';
import { buildGguf, llamaLikeGguf } from '../../../fakes/fake-hub/model-files.mjs';
import { TUNE_PROFILE } from '../../../fakes/fake-engine/profiles.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const CLI = path.join(ROOT, 'test', 'fakes', 'fake-engine', 'cli.mjs');
const SMI = path.join(ROOT, 'test', 'fakes', 'fake-nvidia-smi', 'fake-nvidia-smi.mjs');

let dir: string;
let core: Awaited<ReturnType<typeof boot>>;
const token = 'tune-test-token';

async function api<T>(method: string, route: string, body?: unknown): Promise<T> {
  const res = await fetch(`${core.url}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json()) as T;
  if (!res.ok) throw new Error(`${method} ${route}: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'gb-tune-api-'));
  writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ scanKnownLocations: false }));
  const gguf = path.join(dir, 'models', 'local', 'Qwen3-0.6B-Q4_K_M.gguf');
  mkdirSync(path.dirname(gguf), { recursive: true });
  writeFileSync(gguf, buildGguf({ ...llamaLikeGguf({ name: 'Qwen3 0.6B', sizeLabel: '0.6B' }), totalSize: 96 * 1024 }));
  const smiState = path.join(dir, 'fake-nvidia-smi.json');
  writeFileSync(smiState, JSON.stringify({ gpus: [{ memUsedMiB: 1600, powerW: 38, utilPct: 1, tempC: 39 }] }));
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
      FAKE_ENGINE_PROFILE: JSON.stringify(TUNE_PROFILE),
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

describe('tune run through the API (fake llama-server with a memory model)', () => {
  it('finds each KV type’s largest context, the fastest settings, saves them, and the server plan uses them', async () => {
    const [model] = await api<LocalModel[]>('GET', '/api/models/local');
    const engine = { kind: 'llamacpp-native', executable: CLI };
    const request = { engine, model: { localId: model!.id }, profile: 'tune', tune: { budget: 'fast', fidelity: true }, allowSharedGpu: true };

    const plan = await api<{ estimatedSeconds: number; scenario: { profile: string } }>('POST', '/api/runs/plan', request);
    expect(plan).toMatchObject({ estimatedSeconds: 300, scenario: { profile: 'tune' } });

    const { runId } = await api<{ runId: string }>('POST', '/api/runs', request);
    // The live screen sees the search while it runs.
    let seen: NonNullable<ActiveRunResponse['active']> | undefined;
    await vi.waitFor(
      async () => {
        const { active } = await api<ActiveRunResponse>('GET', '/api/runs/active');
        if (active?.tuning && active.tuning.attempts.length > 0 && active.launch && active.points.length > 0) seen = active;
        expect(seen).toBeDefined();
      },
      { timeout: 60_000, interval: 200 },
    );
    expect(seen!.profile).toBe('tune');
    expect(seen!.launch!.command.argv).toContain('-ctk');
    await vi.waitFor(async () => expect((await api<ActiveRunResponse>('GET', '/api/runs/active')).active).toBeNull(), { timeout: 180_000, interval: 500 });

    const run = await api<RunResult>('GET', `/api/runs/${runId}`);
    expect(run.status).toBe('completed');
    const t = run.tuning!;
    const max = Object.fromEntries(t.capacity.map((c) => [c.kvType, c.measuredMax]));
    expect(max).toEqual({ f16: 16384, q8_0: 32768, q4_0: 40960 });
    const outcomes = new Set(t.attempts.map((a) => a.outcome));
    expect(outcomes).toEqual(new Set(['ok', 'oom', 'spill']));
    expect(t.attempts.find((a) => a.outcome === 'spill')).toMatchObject({ kvType: 'q8_0', contextSize: 40960, spill: 'decode-collapse' });
    // Quantized caches always ran with flash attention, K = V.
    for (const a of t.attempts.filter((x) => x.kvType !== 'f16')) {
      const argv = a.command.argv;
      expect(argv[argv.indexOf('-fa') + 1]).toBe('on');
      expect(argv[argv.indexOf('-ctk') + 1]).toBe(argv[argv.indexOf('-ctv') + 1]);
    }
    const rec = t.combinations[t.recommended!]!;
    expect(rec).toMatchObject({ kvType: 'q4_0', maxContext: 40960, outcome: 'ok', params: { ubatchSize: 2048, flashAttention: 'on', contextSize: 40960 } });
    expect(rec.sweep.map((p) => p.promptTokens)).toEqual([1024, 4096, 8192, 16384, 32768, 40816]);
    expect(t.fastestByDepth.at(-1)).toEqual({ depth: 40960, combination: t.recommended });
    expect(t.fidelity).toMatchObject({ referenceKv: 'f16', comparedKv: 'q4_0', tokens: 128, identical: 128 });
    // The run is described by its recommendation.
    expect(run.launch.params).toMatchObject({ contextSize: 40960, kvCacheType: 'q4_0' });
    expect(run.metrics.contextSweep).toEqual(rec.sweep);
    const [summary] = await api<RunSummary[]>('GET', '/api/runs');
    expect(summary).toMatchObject({ profile: 'tune', contextSize: 40960, kvCacheType: 'q4_0', tunedCombinations: t.combinations.length });

    // "Avvia solo il server" with no context chosen: the recommendation, said so.
    const server = await api<ServerPlan>('POST', '/api/servers/plan', { engine, model: { localId: model!.id } });
    expect(server).toMatchObject({ contextSize: 40960, tuned: { runId, contextSize: 40960, kvCacheType: 'q4_0' }, params: { kvCacheType: 'q4_0', ubatchSize: 2048 } });
  }, 240_000);
});
