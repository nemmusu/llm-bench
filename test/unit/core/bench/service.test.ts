import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../../../../src/contract/errors';
import type { FitEstimate } from '../../../../src/contract/models';
import { BenchService } from '../../../../src/core/bench/service';
import { isRunId } from '../../../../src/core/store/runs-id';
import { hardware, makeRun, modelIdentity } from '../store/fixtures';
import { deferred } from './fakes';
import { request, serviceSetup, TempDirs } from './service-helpers';

const tmp = new TempDirs();
afterEach(() => tmp.cleanup());

const fit = (over: Partial<FitEstimate> = {}): FitEstimate => ({
  level: 'good',
  needMiB: 4200,
  weightsMiB: 3000,
  kvMiB: 700,
  overheadMiB: 500,
  availableMiB: 30000,
  utilization: 0.14,
  contextSize: 8192,
  basis: 'file-size',
  notes: [],
  ...over,
});

describe('BenchService.start', () => {
  it('runs in the background, tracks the phase and saves the result', async () => {
    const s = serviceSetup(tmp, { deps: { telemetryIntervalMs: async () => 500 } });
    const svc = new BenchService(s.deps);
    const { runId } = await svc.start(request({ note: 'hello' }));
    expect(isRunId(runId)).toBe(true);
    expect(svc.active()).toMatchObject({ runId });
    await svc.whenIdle();
    expect(svc.active()).toBeUndefined();
    const list = await s.runs.list();
    expect(list.map((r) => r.id)).toEqual([runId]);
    const run = await s.runs.get(runId);
    expect(run?.status).toBe('completed');
    expect(run?.note).toBe('hello');
    expect(run?.telemetry?.intervalMs).toBe(500);
    expect(run?.launch.argv.some((a) => a.startsWith('gpubench-'))).toBe(true);
    expect(s.ev.ofType('run.done')[0]?.runId).toBe(runId);
    await svc.whenIdle();
  });

  it('reports the current phase and progress while running', async () => {
    const s = serviceSetup(tmp);
    const seen: (string | undefined)[] = [];
    const svc = new BenchService({
      ...s.deps,
      publish: (e) => {
        if (e.type === 'run.phase') seen.push(`${svc.active()?.phase}:${svc.active()?.progress === e.progress}`);
      },
    });
    await svc.start(request());
    await svc.whenIdle();
    expect(seen).toContain('decode:true');
  });

  it('one run at a time', async () => {
    const gate = deferred();
    const s = serviceSetup(tmp, { adapter: { gate: gate.promise } });
    const svc = new BenchService(s.deps);
    const { runId } = await svc.start(request());
    const err = await svc.start(request()).catch((e: unknown) => e);
    gate.resolve();
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).params).toEqual({ reason: 'run_in_progress', runId });
    await svc.whenIdle();
    await expect(svc.start(request())).resolves.toHaveProperty('runId');
    await svc.whenIdle();
  });

  it('resolution errors are thrown (nothing saved) and free the slot', async () => {
    const s = serviceSetup(tmp, { deps: { resolveModel: async () => Promise.reject(new AppError('MODEL_NOT_FOUND', 'gone')) } });
    const svc = new BenchService(s.deps);
    await expect(svc.start(request())).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' });
    expect(svc.active()).toBeUndefined();
    expect(await s.runs.list()).toEqual([]);
    await expect(svc.start(request({ profile: 'custom' }))).rejects.toMatchObject({ code: 'VALIDATION', params: { reason: 'scenario_required' } });
  });

  it('custom scenarios, injected ids, markers, fit, shared filesystems and engine helpers are passed through', async () => {
    const evicted: string[][] = [];
    const s = serviceSetup(tmp, {
      deps: {
        newRunId: () => 'RUN-X',
        newMarker: () => 'gpubench-fixed',
        fit: async () => fit(),
        slowSharedFilesystem: () => true,
        evictCache: async (files) => {
          evicted.push(files);
          return { guaranteed: true };
        },
        llamaBench: async () => [{ test: 'tg128', tps: 99, stddev: 1 }],
      },
    });
    const svc = new BenchService(s.deps);
    const scenario = {
      profile: 'quick',
      seed: 3,
      steps: [
        { kind: 'load', cache: 'cold', reps: 1 },
        { kind: 'latency', promptTokens: [32], outputTokens: 4, warmup: 0, reps: 1 },
        { kind: 'llama-bench', pp: 32, tg: 4, reps: 1 },
      ],
    };
    expect(await svc.start(request({ profile: 'custom', scenario }))).toEqual({ runId: 'RUN-X' });
    await svc.whenIdle();
    const run = await s.runs.get('RUN-X');
    expect(run?.scenario).toMatchObject({ profile: 'custom', seed: 3 });
    expect(run?.launch.argv).toContain('gpubench-fixed');
    expect(run?.metrics.vram.estimateMiB).toBe(4200);
    expect(run?.validity).toContain('slow_shared_filesystem');
    expect(run?.metrics.llamaBench).toEqual([{ test: 'tg128', tps: 99, stddev: 1 }]);
    expect(evicted).toHaveLength(1);
  });

  it('planning warnings are kept in the run log excerpt', async () => {
    const s = serviceSetup(tmp, { adapter: { kind: 'external' } });
    const svc = new BenchService(s.deps);
    const a = await svc.start(request({ engine: { kind: 'external', baseUrl: 'http://127.0.0.1:9' } }));
    await svc.whenIdle();
    expect((await s.runs.get(a.runId))?.logExcerpt).toContain('plan: load_not_measurable');
    const t = serviceSetup(tmp);
    const svc2 = new BenchService(t.deps);
    const b = await svc2.start(
      request({ profile: 'custom', scenario: { profile: 'custom', steps: [{ kind: 'concurrency', levels: [1, 4], promptTokens: 8, outputTokens: 2, requestsPerWorker: 1 }] } }),
    );
    await svc2.whenIdle();
    expect((await t.runs.get(b.runId))?.logExcerpt).toContain('plan: concurrency_level_skipped {"level":4,"parallel":1}');
  });

  it('a failing fit estimate does not block the run; a missing corpus fails it (and is retried next time)', async () => {
    const s = serviceSetup(tmp, { corpus: false, deps: { fit: async () => Promise.reject(new Error('no metadata')) } });
    const svc = new BenchService(s.deps);
    const { runId } = await svc.start(request());
    await svc.whenIdle();
    expect((await s.runs.get(runId))?.error?.code).toBe('INTERNAL');
    const second = await svc.start(request());
    await svc.whenIdle();
    expect((await s.runs.get(second.runId))?.status).toBe('failed');
  });

  it('reuses the loaded corpus across runs', async () => {
    const s = serviceSetup(tmp);
    const svc = new BenchService(s.deps);
    await svc.start(request());
    await svc.whenIdle();
    await svc.start(request());
    await svc.whenIdle();
    expect((await s.runs.list()).every((r) => r.status === 'completed')).toBe(true);
  });

  it('a save failure is swallowed by the service (already published as run.error)', async () => {
    const s = serviceSetup(tmp);
    const svc = new BenchService({ ...s.deps, runs: Object.assign(Object.create(s.runs) as typeof s.runs, { save: async () => Promise.reject(new AppError('DISK_FULL', 'full')) }) });
    await svc.start(request());
    await svc.whenIdle();
    expect(svc.active()).toBeUndefined();
    expect(s.ev.ofType('run.error')[0]?.error.code).toBe('DISK_FULL');
  });
});

describe('BenchService.cancel / shutdown', () => {
  it('cancels only the active run, which is saved as cancelled', async () => {
    const gate = deferred();
    const s = serviceSetup(tmp, { adapter: { gate: gate.promise } });
    const svc = new BenchService(s.deps);
    expect(svc.cancel('nope')).toBe(false);
    const { runId } = await svc.start(request());
    expect(svc.cancel('other')).toBe(false);
    expect(svc.cancel(runId)).toBe(true);
    gate.resolve();
    await svc.whenIdle();
    expect((await s.runs.get(runId))?.status).toBe('cancelled');
  });

  it('core shutdown cancels the active run', async () => {
    const shutdown = new AbortController();
    const gate = deferred();
    const s = serviceSetup(tmp, { adapter: { gate: gate.promise }, deps: { shutdown: shutdown.signal } });
    const svc = new BenchService(s.deps);
    const { runId } = await svc.start(request());
    shutdown.abort();
    gate.resolve();
    await svc.whenIdle();
    expect((await s.runs.get(runId))?.status).toBe('cancelled');
    // Shutting down with no active run is harmless.
    const idle = new AbortController();
    new BenchService({ ...s.deps, shutdown: idle.signal });
    idle.abort();
  });
});

describe('BenchService.plan', () => {
  it('previews the exact command, fitted scenario, needs, fit and warnings', async () => {
    const s = serviceSetup(tmp, {
      telemetry: { users: [{ pid: 77, name: 'ollama', knownLlm: true }] },
      deps: {
        needs: async () => [{ kind: 'model', label: 'Qwen3 4B', bytes: 2.5e9 }],
        fit: async () => fit({ level: 'no', needMiB: 40000, availableMiB: 30000 }),
        slowSharedFilesystem: () => true,
      },
    });
    const svc = new BenchService(s.deps);
    const plan = await svc.plan(request({ profile: 'standard', params: { contextSize: 2048, parallel: 4 } }));
    expect(plan.command.argv[0]).toBe('llama-server');
    expect(plan.command.powershell).toContain('llama-server');
    expect(plan.command.bash).toContain('--port');
    expect(plan.needs).toEqual([{ kind: 'model', label: 'Qwen3 4B', bytes: 2.5e9 }]);
    expect(plan.fit?.level).toBe('no');
    expect(plan.scenario.steps.find((x) => x.kind === 'latency')).toBeUndefined();
    const codes = plan.warnings.map((w) => w.code);
    expect(codes).toEqual(['prompt_too_long', 'prompt_too_long', 'prompt_too_long', 'VRAM_BUSY', 'MODEL_TOO_LARGE', 'slow_shared_filesystem']);
    expect(plan.warnings.find((w) => w.code === 'VRAM_BUSY')?.params).toEqual({ names: 'ollama', pids: '77' });
    expect(plan.estimatedSeconds).toBeGreaterThan(0);
  });

  it('the previewed command is redacted like the stored one', async () => {
    const s = serviceSetup(tmp, { deps: { redact: (argv, env) => ({ argv: argv.map((a) => a.replace(/^gpubench-.*/, '<M>')), env }) } });
    const svc = new BenchService(s.deps);
    const plan = await svc.plan(request());
    expect(plan.command.argv).toContain('<M>');
    expect(plan.command.bash).toContain('<M>');
    const { runId } = await svc.start(request());
    await svc.whenIdle();
    expect((await s.runs.get(runId))?.launch.argv).toContain('<M>');
  });

  it('minimal plan: no needs, no fit, no telemetry; partial offload warning', async () => {
    const s = serviceSetup(tmp, { telemetry: { available: false } });
    const svc = new BenchService(s.deps);
    const plan = await svc.plan(request());
    expect(plan.needs).toEqual([]);
    expect(plan).not.toHaveProperty('fit');
    expect(plan.warnings).toEqual([]);
    const t = serviceSetup(tmp, { telemetry: { available: 'throw', users: 'throw' }, deps: { fit: async () => fit({ level: 'partial', maxGpuLayers: 20 }) } });
    expect((await new BenchService(t.deps).plan(request())).warnings).toEqual([{ code: 'partial_offload', params: { maxGpuLayers: 20 } }]);
    const u = serviceSetup(tmp, { telemetry: { users: 'throw' } });
    expect((await new BenchService(u.deps).plan(request())).warnings).toEqual([]);
  });

  it('estimates use past results of the same model on this PC', async () => {
    const s = serviceSetup(tmp);
    const svc = new BenchService(s.deps);
    const before = (await svc.plan(request({ profile: 'standard' }))).estimatedSeconds;
    await s.runs.save(makeRun({ id: 'old-failed', status: 'failed' }));
    await s.runs.save(makeRun({ id: 'elsewhere', hardware: hardware({ hostId: 'other' }) }));
    expect((await svc.plan(request({ profile: 'standard' }))).estimatedSeconds).toBe(before);
    await s.runs.save(makeRun({ id: 'past' }));
    const after = (await svc.plan(request({ profile: 'standard' }))).estimatedSeconds;
    expect(after).toBeLessThan(before);
    // A past run with no usable numbers changes nothing.
    const t = serviceSetup(tmp);
    const bare = makeRun({ id: 'bare' });
    bare.metrics = { ...bare.metrics, latency: [], load: { phases: [] } };
    await t.runs.save(bare);
    expect((await new BenchService(t.deps).plan(request({ profile: 'standard' }))).estimatedSeconds).toBe(before);
  });

  it('past results are matched by sha256 when the model has one', async () => {
    const s = serviceSetup(tmp, { deps: { resolveModel: async () => ({ identity: modelIdentity({ sha256: 'H', weakKey: 'new-name' }) }) } });
    const svc = new BenchService(s.deps);
    const before = (await svc.plan(request({ profile: 'standard' }))).estimatedSeconds;
    await s.runs.save(makeRun({ id: 'same-file', model: modelIdentity({ sha256: 'H' }) }));
    expect((await svc.plan(request({ profile: 'standard' }))).estimatedSeconds).toBeLessThan(before);
  });

  it('estimates fall back to defaults when the PC cannot be identified', async () => {
    const s = serviceSetup(tmp, { deps: { fingerprint: async () => Promise.reject(new Error('wmi')) } });
    const plan = await new BenchService(s.deps).plan(request());
    expect(plan.estimatedSeconds).toBeGreaterThan(0);
  });
});

describe('BenchService.here', () => {
  it('this PC + first GPU, cached', async () => {
    let calls = 0;
    const s = serviceSetup(tmp, {
      deps: {
        fingerprint: async () => {
          calls++;
          return hardware();
        },
      },
    });
    const svc = new BenchService(s.deps);
    expect(await svc.here()).toEqual({ hostId: 'host-a', gpuUuid: 'GPU-aaaa', gpuName: 'NVIDIA GeForce RTX 5090' });
    await svc.here();
    expect(calls).toBe(1);
    const noGpu = serviceSetup(tmp, { deps: { fingerprint: async () => hardware({ gpus: [] }) } });
    expect(await new BenchService(noGpu.deps).here()).toEqual({ hostId: 'host-a' });
  });
});
