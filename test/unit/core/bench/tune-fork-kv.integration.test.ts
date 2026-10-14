/**
 * A llama.cpp fork with its own KV caches, end to end through the core's HTTP API: the real core, the
 * real llama.cpp adapter and process runner, the fake llama-server as a TurboQuant-like fork (turbo.mjs:
 * its --help lists turbo4, turbo3, turbo2, turbo1.5, turbo3_tcq) with a memory model that stores each
 * type at its bits per value (TURBO_PROFILE), and the fake nvidia-smi. Saved as a custom engine, its
 * check lists the types; "Veloce" searches the two most compact after q4_0 and finds more context than
 * q4_0; a launch with turbo3 runs with -ctk turbo3 -ctv turbo3 and flash attention on.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ActiveRunResponse, RunPlan } from '../../../../src/contract/api';
import type { CustomEngine, CustomEngineInfo } from '../../../../src/contract/custom-engines';
import type { LocalModel } from '../../../../src/contract/models';
import type { RunResult } from '../../../../src/contract/results';
import { boot, type BootEnv } from '../../../../src/core/bootstrap';
import { buildGguf, llamaLikeGguf } from '../../../fakes/fake-hub/model-files.mjs';
import { TURBO_PROFILE } from '../../../fakes/fake-engine/profiles.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const TURBO = path.join(ROOT, 'test', 'fakes', 'fake-engine', 'turbo.mjs');
const SMI = path.join(ROOT, 'test', 'fakes', 'fake-nvidia-smi', 'fake-nvidia-smi.mjs');

let dir: string;
let core: Awaited<ReturnType<typeof boot>>;
const token = 'tune-fork-kv-token';

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
  dir = mkdtempSync(path.join(os.tmpdir(), 'gb-tune-fork-kv-'));
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
      FAKE_ENGINE_PROFILE: JSON.stringify(TURBO_PROFILE),
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

describe('a llama.cpp fork with its own KV caches (fake TurboQuant-like llama-server)', () => {
  it('lists the fork’s types, estimates turbo3 by its size and finds more context than q4_0 with them', async () => {
    const saved = await api<CustomEngine>('POST', '/api/engines/custom', { name: 'TurboQuant', base: 'llamacpp', run: { mode: 'native', path: TURBO } });
    const [info] = await api<CustomEngineInfo[]>('GET', '/api/engines/custom');
    expect(info!.check.kvCacheTypes).toEqual(['f32', 'f16', 'bf16', 'q8_0', 'q4_0', 'q4_1', 'iq4_nl', 'q5_0', 'q5_1', 'turbo4', 'turbo3', 'turbo2', 'turbo1.5', 'turbo3_tcq']);

    const [model] = await api<LocalModel[]>('GET', '/api/models/local');
    const engine = { kind: 'llamacpp-native', customEngineId: saved.id };
    const request = (params: Record<string, unknown>) => ({ engine, model: { localId: model!.id }, profile: 'quick', params: { extraArgs: [], env: {}, contextSize: 32768, ...params } });
    // The estimate follows the type's size: turbo3 (3.125 bits) takes less than q4_0 (4.5), more than turbo2.
    const kvOf = async (kv: string) => (await api<RunPlan>('POST', '/api/runs/plan', request({ kvCacheType: kv }))).fit!;
    const [q4, t3, t2] = [await kvOf('q4_0'), await kvOf('turbo3'), await kvOf('turbo2')];
    expect(t3.kvMiB).toBeLessThan(q4.kvMiB);
    expect(t2.kvMiB).toBeLessThan(t3.kvMiB);
    expect(t3.notes).not.toContain('kv.type-unknown');
    const plan = await api<RunPlan>('POST', '/api/runs/plan', request({ kvCacheType: 'turbo3' }));
    const argv = plan.command.argv;
    expect(argv.slice(argv.indexOf('-ctk'), argv.indexOf('-ctk') + 4)).toEqual(['-ctk', 'turbo3', '-ctv', 'turbo3']);
    expect(argv[argv.indexOf('-fa') + 1]).toBe('on');

    const tune = { engine, model: { localId: model!.id }, profile: 'tune', tune: { budget: 'fast' }, allowSharedGpu: true };
    const { runId } = await api<{ runId: string }>('POST', '/api/runs', tune);
    await vi.waitFor(async () => expect((await api<ActiveRunResponse>('GET', '/api/runs/active')).active).toBeNull(), { timeout: 200_000, interval: 500 });
    const run = await api<RunResult>('GET', `/api/runs/${runId}`);
    expect(run.status).toBe('completed');
    const t = run.tuning!;
    // "Veloce": upstream's three, then the fork's two most compact; turbo2 reaches the model's whole
    // context, so turbo1.5 cannot add any (its capacity is not searched, its speed still is).
    expect(t.capacity.map((c) => [c.kvType, c.measuredMax, c.skipped])).toEqual([
      ['f16', 8192, undefined],
      ['q8_0', 16384, undefined],
      ['q4_0', 32768, undefined],
      ['turbo2', 40960, undefined],
      ['turbo1.5', 40960, 'no-gain'],
    ]);
    expect(t.attempts.filter((a) => a.kvType === 'turbo1.5').every((a) => a.stage !== 'capacity')).toBe(true);
    // The fork's caches ran with flash attention, K = V.
    for (const a of t.attempts.filter((x) => x.kvType === 'turbo2')) {
      const args = a.command.argv;
      expect(args[args.indexOf('-ctk') + 1]).toBe('turbo2');
      expect(args[args.indexOf('-ctv') + 1]).toBe('turbo2');
      expect(args[args.indexOf('-fa') + 1]).toBe('on');
    }
    expect(t.combinations[t.recommended!]).toMatchObject({ kvType: 'turbo2', maxContext: 40960, outcome: 'ok' });
  }, 260_000);
});
