/**
 * Real child processes: test/fakes/fake-nvidia-smi/fake-nvidia-smi.mjs spawned through the real
 * ProcessRunner, parsed by the real sampler. Proves the fake speaks the same CSV as the captures and
 * that stop() really ends the -lms child.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { GpuSample } from '../../../../src/contract/hardware';
import { systemClock } from '../../../../src/core/node-deps';
import { createProcessRunner } from '../../../../src/core/process/runner';
import { createTelemetry, type Telemetry } from '../../../../src/core/telemetry/factory';
import type { TelemetrySession } from '../../../../src/core/telemetry/types';

const FAKE = fileURLToPath(new URL('../../../fakes/fake-nvidia-smi/fake-nvidia-smi.mjs', import.meta.url));
const platform = process.platform === 'win32' ? 'win32' : 'linux';

function telemetry(env: Record<string, string>, opts: { exitAfter?: number } = {}): Telemetry {
  const baseEnv = { ...process.env, ...env, ...(opts.exitAfter ? { FAKE_NVIDIA_SMI_EXIT_AFTER: String(opts.exitAfter) } : {}) };
  const proc = createProcessRunner({ clock: systemClock, platform, baseEnv });
  return createTelemetry({ clock: systemClock, proc, platform, env: baseEnv, endpoints: { nvidiaSmi: [process.execPath, FAKE] } });
}

function stateFile(state: unknown): string {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'gb-fake-smi-')), 'state.json');
  writeFileSync(file, JSON.stringify(state));
  return file;
}

async function until(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const sessions: TelemetrySession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.stop()));
});

describe('fake nvidia-smi through the real ProcessRunner', () => {
  it('detects, probes, snapshots and lists GPU users with the default RTX 5090 state', async () => {
    const t = telemetry({});
    expect(await t.status()).toMatchObject({ found: true, works: true, driverVersion: '617.14', cudaVersion: '13.4', gpuCount: 1 });
    expect(await t.probe()).toEqual([
      {
        index: 0,
        uuid: 'GPU-3d36b2ac-a47c-233d-3308-4c71f3bc4a30',
        name: 'NVIDIA GeForce RTX 5090',
        vendor: 'nvidia',
        memoryTotalMiB: 32607,
        memoryUsedMiB: 1600,
        driverVersion: '617.14',
        cudaVersion: '13.4',
        computeCapability: '12.0',
        powerLimitW: 575,
        pcieGenMax: 5,
        pcieWidthMax: 16,
      },
    ]);
    const [s] = await t.snapshot();
    expect(s).toMatchObject({ gpu: 0, memUsedMiB: 1600, powerW: 35, throttle: ['gpu_idle'] });
    expect(await t.otherGpuUsers([])).toEqual([]);
  });

  it('streams samples while another process raises VRAM in the state file, and stop() ends the child', async () => {
    const file = stateFile({ gpus: [{ memUsedMiB: 1600 }], apps: [{ pid: 4321, name: 'C:\\llama\\llama-server.exe' }] });
    const t = telemetry({ FAKE_NVIDIA_SMI_STATE: file });
    expect(await t.otherGpuUsers([])).toEqual([{ pid: 4321, name: 'llama-server.exe', knownLlm: true, kind: 'llm' }]);
    const batches: GpuSample[][] = [];
    const session = t.start(50, (b) => batches.push(b));
    sessions.push(session);
    await until(() => batches.length >= 2);
    // Read-modify-write like the fake engine does during a load.
    const state = JSON.parse(readFileSync(file, 'utf8')) as { gpus: Record<string, unknown>[] };
    state.gpus[0] = { ...state.gpus[0], memUsedMiB: 9000, powerW: 420, utilPct: 99 };
    writeFileSync(file, JSON.stringify(state));
    await until(() => session.latest()[0]?.memUsedMiB === 9000);
    expect(session.latest()[0]).toMatchObject({ powerW: 420, utilPct: 99 });
    const all = await session.stop();
    expect(all.length).toBeGreaterThanOrEqual(3);
    expect(all.every((s, i) => i === 0 || s.t >= all[i - 1]!.t)).toBe(true);
    const n = all.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(batches.flat()).toHaveLength(n);
  });

  it('restarts a stream that dies once', async () => {
    const t = telemetry({}, { exitAfter: 2 });
    let batches = 0;
    const session = t.start(50, () => batches++);
    sessions.push(session);
    // Each child prints 2 batches (initial + 1 interval) and exits(1): a 3rd batch proves the respawn.
    await until(() => batches >= 3, 20_000);
    const all = await session.stop();
    expect(all.length).toBeGreaterThanOrEqual(3);
  });

  it('falls back to power.draw / clocks_throttle_reasons on a legacy driver', async () => {
    const t = telemetry({ FAKE_NVIDIA_SMI_STATE: stateFile({ legacy: true, driver: '470.223.02', cuda: '11.4', gpus: [{ throttle: '0x0000000000000004' }] }) });
    expect(await t.status()).toMatchObject({ works: true, driverVersion: '470.223.02', cudaVersion: '11.4' });
    expect((await t.probe())[0]!.computeCapability).toBeUndefined();
    expect((await t.snapshot())[0]).toMatchObject({ powerW: 35, throttle: ['sw_power_cap'] });
  });

  it('reports a missing driver and an empty GPU list', async () => {
    const absent = telemetry({ FAKE_NVIDIA_SMI_MODE: 'absent' });
    expect(await absent.status()).toMatchObject({ found: true, works: false, error: { code: 'DRIVER_MISSING' } });
    expect(await absent.snapshot()).toEqual([]);
    const none = telemetry({ FAKE_NVIDIA_SMI_MODE: 'nodevices' });
    expect(await none.status()).toMatchObject({ works: false, error: { code: 'GPU_NOT_FOUND' } });
  });
});
