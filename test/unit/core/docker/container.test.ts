import { describe, expect, it } from 'vitest';
import { launchParamsSchema } from '../../../../src/contract/engines';
import { AppError } from '../../../../src/contract/errors';
import type { RunOutput } from '../../../../src/core/deps';
import { DockerCli } from '../../../../src/core/docker/cli';
import { containerName, dockerRunArgv, startContainer, stopOwned, type StartContainerOptions } from '../../../../src/core/docker/container';
import type { LaunchPlan } from '../../../../src/core/engines/types';
import type { InferenceClient } from '../../../../src/core/inference/types';
import { fail, manualProcess, ok, recordingLog, scriptedProc, silentLog, steppingClock } from './helpers';

const ID = 'a'.repeat(64);
const MARKER = 'gpubench-m1';
const plan: LaunchPlan = {
  kind: 'llamacpp-docker',
  argv: ['docker', 'run', '-d', 'img', '-m', '/models/x.gguf'],
  env: { HF_TOKEN: '<HF_TOKEN>' },
  host: '127.0.0.1',
  port: 9,
  params: launchParamsSchema.parse({}),
  engine: { kind: 'llamacpp-docker', name: 'llama.cpp', image: 'img' },
  modelFiles: [],
  modelBytes: 0,
  marker: MARKER,
};
const inspectJson = (o: { running?: boolean; exitCode?: number; oom?: boolean; labels?: Record<string, string> } = {}) =>
  ok(
    JSON.stringify([
      {
        Id: ID,
        Name: `/${MARKER}`,
        State: { Running: o.running ?? false, Status: o.running ? 'running' : 'exited', ExitCode: o.exitCode, OOMKilled: o.oom ?? false },
        Config: { Labels: o.labels ?? { gpubench: '1', 'gpubench.marker': MARKER } },
      },
    ]),
  );

function harness(handler: (args: string[]) => RunOutput | Promise<RunOutput>, over: Partial<StartContainerOptions> = {}) {
  const logs = manualProcess(0, 555);
  const proc = scriptedProc(handler, () => logs);
  const cli = new DockerCli({ proc, platform: 'linux', env: {}, override: ['docker'] });
  const clock = steppingClock(1000);
  let ready = false;
  const opts: StartContainerOptions = {
    cli,
    proc,
    clock,
    log: silentLog,
    plan,
    client: {} as InferenceClient,
    probe: async () => ready,
    phaseOf: (t) => (t.includes('load_tensors') ? 'load_tensors' : t.includes('warming up') ? 'warmup' : undefined),
    diagnose: (lines) => new AppError('ENGINE_EXITED', 'exited', { detail: lines.join('\n') }),
    signal: new AbortController().signal,
    pollMs: 10,
    ...over,
  };
  return { logs, proc, cli, clock, opts, setReady: () => (ready = true) };
}

const runOk = (args: string[]) => (args[0] === 'run' ? ok(`${ID}\n`) : args[0] === 'container' ? inspectJson({ running: true }) : ok());

describe('dockerRunArgv / containerName', () => {
  it('prefixes markers that lack it and sorts env names', () => {
    expect(containerName('abc')).toBe('gpubench-abc');
    expect(containerName('gpubench-abc')).toBe('gpubench-abc');
    const argv = dockerRunArgv({ docker: ['docker'], marker: 'x', hostPort: 1, containerPort: 2, volumes: [], envNames: ['B', 'A', 'B'], image: 'i', args: ['--a'] });
    expect(argv).toEqual(['docker', 'run', '-d', '--name', 'gpubench-x', '--label', 'gpubench=1', '--label', 'gpubench.marker=x', '--gpus', 'all', '-p', '127.0.0.1:1:2', '-e', 'A', '-e', 'B', 'i', '--a']);
  });
});

describe('startContainer', () => {
  it('maps daemon timestamps with the smallest delivery delay and reports phases up to ready', async () => {
    // Time only moves when the test says so; sleeps just yield, so the catch-up wait is real.
    const clock = { t: 1000, now: () => clock.t, wall: () => 0, sleep: () => new Promise<void>((r) => setTimeout(r, 1)) };
    const h = harness(runOk, { clock });
    const inst = await startContainer({ ...h.opts, secretEnv: { HF_TOKEN: 'hf_real' }, runTimeoutMs: 5000, logCatchUpMs: 10_000, readyTimeoutMs: 60_000 });
    expect(h.proc.calls[0]).toMatchObject({ cmd: 'docker', args: ['run', '-d', 'img', '-m', '/models/x.gguf'], opts: { env: { HF_TOKEN: 'hf_real' }, timeoutMs: 5000 } });
    expect(inst.containerId).toBe(ID);
    expect(inst.containerName).toBe(MARKER);
    expect(inst.containerOverheadMs()).toBeUndefined();
    // The daemon clock runs one hour ahead of ours: only the delivery delays matter (40 ms, then 5 ms).
    const D = Date.parse('2026-10-06T11:00:00Z');
    const ts = (ms: number) => new Date(D + ms).toISOString().replace('Z', '000Z');
    h.logs.push(`${ts(10)} build: 10997`, 1050);
    h.logs.push(`${ts(50)} load_tensors: loading model tensors`, 1055);
    h.logs.push('no timestamp here', 1060);
    h.logs.push(`${ts(70)} load_tensors: again (not a new phase)`, 1075);
    await new Promise((r) => setTimeout(r, 5));
    clock.t = 1100;
    h.setReady();
    const pending = inst.waitReady();
    await new Promise((r) => setTimeout(r, 20));
    // Printed before ready, delivered after it.
    h.logs.push(`${ts(90)} warming up the model`, 1095);
    await new Promise((r) => setTimeout(r, 5));
    h.logs.push(`${ts(400)} after ready`, 1405);
    const r = await pending;
    expect(r.tReady).toBe(1100);
    expect(r.phases).toEqual([
      { name: 'container', t: 1000 },
      { name: 'engine_start', t: 1015 },
      { name: 'load_tensors', t: 1055 },
      { name: 'warmup', t: 1095 },
    ]);
    expect(inst.containerOverheadMs()).toBe(15);
  });

  it('skips engine_start when the first line is a phase, and waits for no late lines once the log ends', async () => {
    const h = harness(runOk);
    const inst = await startContainer(h.opts);
    h.logs.push('2026-10-06T10:00:00.000000000Z load_tensors: x', 1000);
    await new Promise((r) => setTimeout(r, 5));
    h.setReady();
    const r = await inst.waitReady();
    expect(r.phases.map((p) => p.name)).toEqual(['container', 'load_tensors']);
    h.logs.exit();
    await inst.stop();
  });

  it('returns without phases when the engine printed nothing', async () => {
    const h = harness(runOk);
    const inst = await startContainer({ ...h.opts, logCatchUpMs: 50 });
    h.setReady();
    expect((await inst.waitReady()).phases).toEqual([{ name: 'container', t: 1000 }]);
  });

  it('stops only after verifying the container is ours, and settles once the follower ends', async () => {
    const h = harness(runOk);
    const inst = await startContainer({ ...h.opts, stopTimeoutSec: 3 });
    const exit = await inst.stop();
    expect(exit).toEqual({ code: null, signal: null });
    const cmds = h.proc.calls.map((c) => c.args.slice(0, 2).join(' '));
    expect(cmds).toEqual(['run -d', 'container inspect', 'stop -t', 'rm -f', 'container inspect']);
    expect(h.proc.calls[2]?.args).toEqual(['stop', '-t', '3', ID]);
    expect(h.logs.stopped()).toBe(1);
  });

  it('diagnoses an early exit from the log, or a host OOM kill', async () => {
    const h = harness((args) => (args[0] === 'run' ? ok(ID) : args[0] === 'container' ? inspectJson({ exitCode: 1 }) : ok()));
    const inst = await startContainer(h.opts);
    h.logs.push('2026-10-06T10:00:00Z error: invalid argument: --bogus', 1000);
    h.logs.exit();
    await expect(inst.waitReady()).rejects.toMatchObject({ code: 'ENGINE_EXITED', detail: 'error: invalid argument: --bogus' });
    expect(await inst.exited).toEqual({ code: 1, signal: null });

    const oom = harness((args) => (args[0] === 'run' ? ok(ID) : args[0] === 'container' ? inspectJson({ oom: true, exitCode: 137 }) : ok()));
    const inst2 = await startContainer(oom.opts);
    oom.logs.exit();
    await expect(inst2.waitReady()).rejects.toMatchObject({ code: 'ENGINE_OOM', params: { where: 'host', code: '137' } });

    const noCode = harness((args) => (args[0] === 'run' ? ok(ID) : args[0] === 'container' ? inspectJson({}) : ok()));
    const inst3 = await startContainer(noCode.opts);
    noCode.logs.exit();
    await expect(inst3.waitReady()).rejects.toThrow(AppError);
    const gone = harness((args) => (args[0] === 'run' ? ok(ID) : args[0] === 'container' ? fail(1, 'No such container') : ok()));
    const inst4 = await startContainer(gone.opts);
    gone.logs.exit();
    expect(await inst4.exited).toEqual({ code: null, signal: null });
  });

  it('cleans up after a failed `docker run`, reporting GPU problems', async () => {
    const seen: (string | undefined)[] = [];
    const h = harness(
      (args) => {
        if (args[0] === 'run') return fail(125, 'docker: Error response from daemon: could not select device driver "" with capabilities: [[gpu]]');
        if (args[0] === 'container') return inspectJson({});
        return ok();
      },
      { onNoGpu: (d) => seen.push(d) },
    );
    await expect(startContainer(h.opts)).rejects.toMatchObject({ code: 'DOCKER_NO_GPU' });
    expect(h.proc.calls.map((c) => c.args.slice(0, 2).join(' '))).toEqual(['run -d', 'container inspect', 'rm -f']);
    expect(seen[0]).toContain('could not select device driver');
    // Without a callback, and leaving foreign containers alone.
    const h2 = harness((args) => (args[0] === 'run' ? fail(125, 'could not select device driver "" with capabilities: [[gpu]]') : args[0] === 'container' ? inspectJson({ labels: {} }) : ok()));
    await expect(startContainer(h2.opts)).rejects.toMatchObject({ code: 'DOCKER_NO_GPU' });
    expect(h2.proc.calls.some((c) => c.args[0] === 'rm')).toBe(false);
    // A bogus success without an id, inspect failing.
    const h3 = harness((args) => (args[0] === 'run' ? ok('WARNING: something') : Promise.reject(new Error('x'))));
    await expect(startContainer(h3.opts)).rejects.toMatchObject({ code: 'ENGINE_START_FAILED' });
  });

  it('reports cancellation before or during `docker run`', async () => {
    const pre = new AbortController();
    pre.abort();
    await expect(startContainer({ ...harness(runOk).opts, signal: pre.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    const ac = new AbortController();
    const h = harness((args) => {
      if (args[0] === 'run') {
        ac.abort();
        return fail(null, 'killed');
      }
      return fail(1, 'No such container');
    });
    await expect(startContainer({ ...h.opts, signal: ac.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('stops the container when its log cannot be followed', async () => {
    const proc = scriptedProc(runOk, () => {
      throw new Error('spawn failed');
    });
    const cli = new DockerCli({ proc, platform: 'linux', env: {}, override: ['docker'] });
    const h = harness(runOk);
    await expect(startContainer({ ...h.opts, cli, proc })).rejects.toMatchObject({ code: 'ENGINE_START_FAILED' });
    expect(proc.calls.map((c) => c.args[0])).toEqual(['run', 'container', 'stop', 'rm']);
    expect(proc.calls[2]?.args).toEqual(['stop', '-t', '10', ID]);
  });
});

describe('stopOwned', () => {
  const cliFor = (handler: (args: string[]) => RunOutput | Promise<RunOutput>) => {
    const proc = scriptedProc(handler);
    return { proc, cli: new DockerCli({ proc, platform: 'linux', env: {}, override: ['docker'] }) };
  };

  it('does nothing for a container that is gone', async () => {
    const { proc, cli } = cliFor(() => fail(1, 'No such container'));
    await stopOwned(cli, ID, MARKER, 10);
    expect(proc.calls).toHaveLength(1);
  });

  it('refuses containers without our label or marker', async () => {
    const log = recordingLog();
    const { proc, cli } = cliFor(() => inspectJson({ running: true, labels: { gpubench: '1', 'gpubench.marker': 'other' } }));
    await stopOwned(cli, ID, MARKER, 10, log);
    await stopOwned(cli, ID, MARKER, 10);
    expect(proc.calls.every((c) => c.args[0] === 'container')).toBe(true);
    expect(log.entries[0]?.msg).toContain('not ours');
  });

  it('skips stop for exited containers and logs failures', async () => {
    const log = recordingLog();
    const { proc, cli } = cliFor((args) => (args[0] === 'container' ? inspectJson({ running: false }) : fail(1, 'Cannot connect to the Docker daemon')));
    await stopOwned(cli, ID, MARKER, 10, log);
    expect(proc.calls.map((c) => c.args[0])).toEqual(['container', 'rm']);
    expect(log.entries[0]).toMatchObject({ msg: 'docker rm failed', data: { error: 'DOCKER_NOT_RUNNING' } });
    const running = cliFor((args) => (args[0] === 'container' ? inspectJson({ running: true }) : Promise.reject(new Error('boom'))));
    await stopOwned(running.cli, ID, MARKER, 10, log);
    expect(log.entries.slice(1).map((e) => e.msg)).toEqual(['docker stop failed', 'docker rm failed']);
    expect(log.entries[2]?.data).toMatchObject({ error: 'Error: boom' });
    await stopOwned(running.cli, ID, MARKER, 10);
  });
});

describe('startContainer defaults', () => {
  it('polls with the default interval when none is given', async () => {
    const h = harness(runOk);
    const inst = await startContainer({ ...h.opts, pollMs: undefined, logCatchUpMs: 10 });
    h.setReady();
    expect((await inst.waitReady()).tReady).toBeGreaterThanOrEqual(1000);
  });
});
