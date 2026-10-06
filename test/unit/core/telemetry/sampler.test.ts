import { describe, expect, it } from 'vitest';
import type { GpuSample } from '../../../../src/contract/hardware';
import type { NvidiaSmiLocation } from '../../../../src/core/telemetry/nvidia-smi';
import { DEFAULT_MAX_SAMPLES, NvidiaSmiTelemetry, TELEMETRY_OWNER } from '../../../../src/core/telemetry/sampler';
import { FakeClock, FakeRunner, fixture, memoryLogger, nvidiaSmiHandler, ok, tick, type RunHandler } from './fakes';

const loc: NvidiaSmiLocation = { argv: ['C:\\Windows\\System32\\nvidia-smi.exe'], path: 'C:\\Windows\\System32\\nvidia-smi.exe', source: 'known' };
const WIN_SNAPSHOT = fixture('nvidia-smi/win-snapshot.csv', { crlf: true });
const STREAM = fixture('nvidia-smi/handmade/multi-gpu-stream.csv').split('\n');
const TWO_GPU_SNAPSHOT = `${STREAM[0]!}\n${STREAM[1]!}\n`;

function setup(handler: RunHandler, opts: { maxSamples?: number; withLog?: boolean } = {}) {
  const clock = new FakeClock();
  const runner = new FakeRunner(handler, clock);
  const log = memoryLogger();
  const smi = new NvidiaSmiTelemetry({
    clock,
    proc: runner,
    location: loc,
    driver: { driverVersion: '617.14', cudaVersion: '13.4' },
    ...(opts.withLog === false ? {} : { log }),
    ...(opts.maxSamples ? { maxSamples: opts.maxSamples } : {}),
  });
  return { clock, runner, log, smi };
}

const sampleQueries = (r: FakeRunner) => r.calls.filter((c) => c.args.some((a) => a.startsWith('--query-gpu=index,utilization')));

describe('NvidiaSmiTelemetry.probe / available', () => {
  it('parses the real Windows probe and adds the CUDA version from detection', async () => {
    const { smi } = setup(nvidiaSmiHandler({ probe: ok(fixture('nvidia-smi/win-probe.csv', { crlf: true })) }));
    const [gpu] = await smi.probe();
    expect(gpu).toMatchObject({ name: 'NVIDIA GeForce RTX 5090', memoryTotalMiB: 32607, driverVersion: '617.14', cudaVersion: '13.4' });
    expect(await smi.available()).toBe(true);
  });

  it('remembers the fields an old driver accepted (one retry only the first time)', async () => {
    const { smi, runner } = setup(
      nvidiaSmiHandler({
        probe: (args) => (args.some((a) => a.includes('compute_cap')) ? ok('Field "compute_cap" is not a valid field to query.', 2) : ok('0, GPU-x, Old GPU, 4096, 5, 470.1, [N/A], 3, 16')),
      }),
    );
    expect((await smi.probe())[0]).toMatchObject({ name: 'Old GPU', pcieGenMax: 3 });
    await smi.probe();
    expect(runner.calls).toHaveLength(3);
    expect(runner.calls[2]!.args[0]).not.toContain('compute_cap');
  });

  it('returns [] when there is no GPU and throws (available=false) when the driver is missing', async () => {
    const none = setup(nvidiaSmiHandler({ probe: ok(fixture('nvidia-smi/win-no-devices.txt'), 6) }));
    expect(await none.smi.probe()).toEqual([]);
    expect(await none.smi.available()).toBe(false);
    const broken = setup(nvidiaSmiHandler({ probe: ok(fixture('nvidia-smi/handmade/driver-missing.txt'), 9) }));
    await expect(broken.smi.probe()).rejects.toMatchObject({ code: 'DRIVER_MISSING' });
    expect(await broken.smi.available()).toBe(false);
  });
});

describe('NvidiaSmiTelemetry.snapshot', () => {
  it('stamps every row with Clock.now()', async () => {
    const { smi, clock } = setup(nvidiaSmiHandler({ sample: ok(WIN_SNAPSHOT) }));
    clock.t = 5000;
    expect(await smi.snapshot()).toEqual([expect.objectContaining({ t: 5000, gpu: 0, memUsedMiB: 1800, powerW: 56.26, throttle: ['reliability'] })]);
  });

  it('returns [] without GPUs and propagates other failures', async () => {
    expect(await setup(nvidiaSmiHandler({ sample: ok('No devices were found', 6) })).smi.snapshot()).toEqual([]);
    await expect(setup(nvidiaSmiHandler({ sample: ok('boom', 3) })).smi.snapshot()).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('serves a running stream session while it is fresh, else queries nvidia-smi', async () => {
    const { smi, runner, clock } = setup(nvidiaSmiHandler({ sample: ok(WIN_SNAPSHOT) }));
    const session = smi.start(250);
    await tick();
    expect(sampleQueries(runner)).toHaveLength(1);
    // Before the stream produced anything, snapshot() still has to query.
    await smi.snapshot();
    expect(sampleQueries(runner)).toHaveLength(2);
    runner.spawned[0]!.emit(STREAM[0]!);
    await tick();
    clock.advance(400);
    const live = await smi.snapshot();
    expect(live).toEqual([expect.objectContaining({ t: 1000, gpu: 0, memUsedMiB: 20480 })]);
    expect(sampleQueries(runner)).toHaveLength(2);
    clock.advance(200); // 600 ms old > 2 × 250 ms
    await smi.snapshot();
    expect(sampleQueries(runner)).toHaveLength(3);
    await session.stop();
  });
});

describe('NvidiaSmiTelemetry.otherGpuUsers', () => {
  it('lists the real WDDM desktop apps as not-LLM and excludes our own pids', async () => {
    const { smi } = setup(nvidiaSmiHandler({ apps: ok(fixture('nvidia-smi/win-compute-apps.csv', { crlf: true })) }));
    const users = await smi.otherGpuUsers([14064]);
    expect(users).toHaveLength(22);
    expect(users.some((u) => u.pid === 14064)).toBe(false);
    expect(users[0]).toEqual({ pid: 14824, name: 'CrossDeviceResume.exe', knownLlm: false });
    expect(users.every((u) => !u.knownLlm)).toBe(true);
  });

  it('dedupes multi-GPU processes and flags known LLM servers', async () => {
    const { smi, runner } = setup(nvidiaSmiHandler({ apps: ok(fixture('nvidia-smi/handmade/compute-apps-edge.csv')) }));
    expect(await smi.otherGpuUsers([])).toEqual([
      { pid: 4242, name: 'llama-server', knownLlm: true },
      { pid: 5151, name: 'LM Studio.exe', knownLlm: true },
      { pid: 6161, name: '[Insufficient Permissions]', knownLlm: false },
      { pid: 7171, name: 'python3', knownLlm: false },
    ]);
    expect(runner.calls[0]!.args).toEqual(['--query-compute-apps=pid,process_name,used_memory', '--format=csv,noheader,nounits']);
  });

  it('returns [] for the empty WSL list and without GPUs; throws when the driver is gone', async () => {
    expect(await setup(nvidiaSmiHandler({ apps: ok(fixture('nvidia-smi/wsl-compute-apps.csv')) })).smi.otherGpuUsers([])).toEqual([]);
    expect(await setup(nvidiaSmiHandler({ apps: ok('No devices were found', 6) })).smi.otherGpuUsers([])).toEqual([]);
    await expect(setup(nvidiaSmiHandler({ apps: ok(fixture('nvidia-smi/handmade/driver-missing.txt'), 9) })).smi.otherGpuUsers([])).rejects.toMatchObject({
      code: 'DRIVER_MISSING',
    });
  });
});

describe('NvidiaSmiTelemetry.start (streaming session)', () => {
  it('runs ONE nvidia-smi -lms child, groups lines per interval and returns everything on stop', async () => {
    const { smi, runner } = setup(nvidiaSmiHandler({ sample: ok(TWO_GPU_SNAPSHOT) }));
    const batches: GpuSample[][] = [];
    const session = smi.start(250, (s) => batches.push(s));
    expect(session.latest()).toEqual([]);
    await tick();
    expect(runner.spawned).toHaveLength(1);
    const child = runner.spawned[0]!;
    expect(child.spec.owner).toEqual(TELEMETRY_OWNER);
    expect(child.spec.cmd).toBe(loc.argv[0]);
    expect(child.spec.args).toEqual([
      '--query-gpu=index,utilization.gpu,memory.used,memory.total,power.draw.instant,power.draw,temperature.gpu,clocks.sm,clocks.mem,pcie.link.gen.current,pcie.link.width.current,clocks_event_reasons.active',
      '--format=csv,noheader,nounits',
      '-lms',
      '250',
    ]);
    STREAM.forEach((line, i) => child.emit(line, 'stdout', 2000 + i));
    child.emit('a warning on stderr', 'stderr');
    await tick();
    expect(batches.map((b) => b.map((s) => s.gpu))).toEqual([[0, 1], [0, 1]]);
    expect(batches[1]![0]).toMatchObject({ t: 2003, throttle: ['sw_power_cap', 'sw_thermal_slowdown'] });
    expect(session.latest().map((s) => [s.gpu, s.t])).toEqual([
      [0, 2006],
      [1, 2004],
    ]);
    const all = await session.stop();
    // The last (partial) batch is flushed when the stream ends.
    expect(all.map((s) => s.gpu)).toEqual([0, 1, 0, 1, 0]);
    expect(all[4]).toMatchObject({ powerW: 405.25, throttle: ['sw_power_cap', 'hw_thermal_slowdown', 'hw_power_brake_slowdown'] });
    expect(child.stopCalls).toBe(1);
    expect(await session.stop()).toEqual(all);
    expect(child.stopCalls).toBe(1);
  });

  it('splits batches on index wrap when the GPU count is unknown', async () => {
    const { smi, runner } = setup(nvidiaSmiHandler({ sample: ok('') }));
    const batches: number[][] = [];
    const session = smi.start(100, (s) => batches.push(s.map((x) => x.gpu)));
    await tick();
    for (const l of STREAM.slice(0, 5)) runner.spawned[0]!.emit(l);
    await tick();
    expect(batches).toEqual([[0, 1]]);
    await session.stop();
    expect(batches).toEqual([[0, 1], [0, 1]]);
  });

  it('clamps tiny intervals and shares one field resolution between sessions', async () => {
    const { smi, runner } = setup(nvidiaSmiHandler({ sample: ok(WIN_SNAPSHOT) }));
    const a = smi.start(10);
    const b = smi.start(333.4);
    await tick();
    expect(sampleQueries(runner)).toHaveLength(1);
    expect(runner.spawned.map((p) => p.spec.args.at(-1))).toEqual(['50', '333']);
    await Promise.all([a.stop(), b.stop()]);
  });

  it('restarts a child that dies unexpectedly once, then gives up', async () => {
    const { smi, runner, log } = setup(nvidiaSmiHandler({ sample: ok(WIN_SNAPSHOT) }));
    const session = smi.start(250);
    await tick();
    runner.spawned[0]!.emit(STREAM[0]!);
    runner.spawned[0]!.exit(1);
    await tick();
    expect(runner.spawned).toHaveLength(2);
    runner.spawned[1]!.emit(STREAM[3]!);
    runner.spawned[1]!.exit(null, 'SIGKILL');
    await tick();
    expect(runner.spawned).toHaveLength(2);
    expect(log.entries.map((e) => e.msg)).toEqual(['telemetry stream exited, restarting', 'telemetry stream exited, giving up']);
    expect((await session.stop()).map((s) => s.memUsedMiB)).toEqual([20480, 20512]);
  });

  it('does not spawn when field resolution fails, and retries resolution on the next start', async () => {
    let fail = true;
    const { smi, runner, log } = setup(nvidiaSmiHandler({ sample: () => (fail ? ok('', 9) : ok(WIN_SNAPSHOT)) }));
    const s1 = smi.start(250);
    await tick();
    expect(runner.spawned).toHaveLength(0);
    expect(await s1.stop()).toEqual([]);
    expect(log.entries[0]!.msg).toBe('telemetry stream not started');
    fail = false;
    const s2 = smi.start(250);
    await tick();
    expect(runner.spawned).toHaveLength(1);
    await s2.stop();
  });

  it('never spawns when stopped before the stream started', async () => {
    const { smi, runner } = setup(nvidiaSmiHandler({ sample: ok(WIN_SNAPSHOT) }));
    const session = smi.start(250);
    expect(await session.stop()).toEqual([]);
    await tick();
    expect(runner.spawned).toHaveLength(0);
  });

  it('survives a spawn error and a throwing subscriber; logging is optional', async () => {
    const clock = new FakeClock();
    const log = memoryLogger();
    const throwing = new FakeRunner(nvidiaSmiHandler({ sample: ok(WIN_SNAPSHOT) }), clock);
    throwing.spawn = () => {
      throw new Error('EINVAL');
    };
    const s1 = new NvidiaSmiTelemetry({ clock, proc: throwing, location: loc, log }).start(250);
    await tick();
    expect(await s1.stop()).toEqual([]);
    expect(log.entries[0]!.msg).toBe('telemetry stream spawn failed');

    const { smi, runner } = setup(nvidiaSmiHandler({ sample: ok(WIN_SNAPSHOT) }), { withLog: false });
    let calls = 0;
    const s2 = smi.start(250, () => {
      calls++;
      throw new Error('subscriber bug');
    });
    await tick();
    runner.spawned[0]!.emit(STREAM[0]!);
    runner.spawned[0]!.emit(STREAM[3]!);
    await tick();
    expect(calls).toBe(2);
    expect(await s2.stop()).toHaveLength(2);

    const quiet = setup(nvidiaSmiHandler({ sample: ok('', 9) }), { withLog: false });
    const s3 = quiet.smi.start(250);
    await tick();
    expect(await s3.stop()).toEqual([]);
    const dying = setup(nvidiaSmiHandler({ sample: ok(WIN_SNAPSHOT) }), { withLog: false });
    const s4 = dying.smi.start(250);
    await tick();
    dying.runner.spawned[0]!.exit(1);
    await tick();
    dying.runner.spawned[1]!.exit(1);
    await tick();
    expect(await s4.stop()).toEqual([]);
    const bad = new FakeRunner(nvidiaSmiHandler({ sample: ok(WIN_SNAPSHOT) }), clock);
    bad.spawn = () => {
      throw new Error('EINVAL');
    };
    const s5 = new NvidiaSmiTelemetry({ clock, proc: bad, location: loc }).start(250);
    await tick();
    expect(await s5.stop()).toEqual([]);
  });

  it('keeps at most maxSamples (oldest dropped)', async () => {
    expect(DEFAULT_MAX_SAMPLES).toBe(200_000);
    const { smi, runner } = setup(nvidiaSmiHandler({ sample: ok(WIN_SNAPSHOT) }), { maxSamples: 3 });
    const session = smi.start(250);
    await tick();
    for (let i = 0; i < 5; i++) runner.spawned[0]!.emit(`0, ${i}, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0x0`);
    await tick();
    expect((await session.stop()).map((s) => s.utilPct)).toEqual([2, 3, 4]);
  });
});
