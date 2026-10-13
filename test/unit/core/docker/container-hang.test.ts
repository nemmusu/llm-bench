import { describe, expect, it } from 'vitest';
import { launchParamsSchema } from '../../../../src/contract/engines';
import { AppError } from '../../../../src/contract/errors';
import type { RunOutput } from '../../../../src/core/deps';
import { DockerCli } from '../../../../src/core/docker/cli';
import { startContainer, throttledProbe, type StartContainerOptions } from '../../../../src/core/docker/container';
import type { LaunchPlan } from '../../../../src/core/engines/types';
import type { InferenceClient } from '../../../../src/core/inference/types';
import { fail, manualProcess, ok, scriptedProc, silentLog, steppingClock } from './helpers';

const plan: LaunchPlan = {
  kind: 'vllm-docker',
  argv: ['docker', 'run', '-d', 'img'],
  env: {},
  host: '127.0.0.1',
  port: 9,
  params: launchParamsSchema.parse({}),
  engine: { kind: 'vllm-docker', name: 'vLLM', image: 'img' },
  modelFiles: [],
  modelBytes: 0,
  marker: 'gpubench-h1',
};

function opts(run: RunOutput | (() => RunOutput), over: Partial<StartContainerOptions> = {}): StartContainerOptions & { calls: string[][] } {
  const proc = scriptedProc((args) => (args[0] === 'run' ? (typeof run === 'function' ? run() : run) : fail(1, 'Error: No such container')));
  const calls = proc.calls as unknown as string[][];
  return {
    cli: new DockerCli({ proc, platform: 'win32', env: {}, override: ['docker'] }),
    proc,
    clock: steppingClock(),
    log: silentLog,
    plan,
    client: {} as InferenceClient,
    probe: async () => false,
    phaseOf: () => undefined,
    diagnose: () => new AppError('ENGINE_EXITED', 'exited'),
    signal: new AbortController().signal,
    ...over,
    calls,
  };
}

describe("readiness probes through Docker Desktop's port forwarder", () => {
  it('while the engine prints nothing new, at most one probe per idleMs; a new line lets the next one through', async () => {
    let t = 0;
    const calls: number[] = [];
    const p = throttledProbe(
      async () => {
        calls.push(t);
        return t >= 2000;
      },
      () => t,
      500,
    );
    const signal = new AbortController().signal;
    for (; t < 1000; t += 50) await p.probe(signal);
    expect(calls).toEqual([0, 500]);
    p.line();
    await p.probe(signal);
    expect(calls).toEqual([0, 500, 1000]);
    t = 2000;
    expect(await p.probe(signal)).toBe(true);
    // Without a pause (Linux: no forwarder in between) every probe goes out.
    const every = throttledProbe(async () => true, () => 0, 0);
    expect(await every.probe(signal)).toBe(true);
    expect(await every.probe(signal)).toBe(true);
  });

  it('a container on Windows probes sparingly until its log moves', async () => {
    let probes = 0;
    const logs = manualProcess(0, 7);
    const proc = scriptedProc((args) => (args[0] === 'run' ? ok(`${'b'.repeat(64)}\n`) : ok('[]')), () => logs);
    const clock = steppingClock();
    let ready = false;
    const inst = await startContainer({
      ...opts(ok(), { pollMs: 50 }),
      proc,
      cli: new DockerCli({ proc, platform: 'win32', env: {}, override: ['docker'] }),
      clock,
      probe: async () => {
        probes++;
        if (probes === 3) {
          logs.push('INFO: Uvicorn running on http://0.0.0.0:8000');
          ready = true;
        }
        return ready && probes > 3;
      },
    });
    const r = await inst.waitReady();
    // 1 probe at once, then one per 500 ms of silence, then one right after the line.
    expect(probes).toBe(4);
    expect(r.tReady).toBeGreaterThanOrEqual(1000);
  });
});

describe('docker run that gets no answer from Docker', () => {
  it('timed out: DOCKER_NOT_RESPONDING, Docker told, nothing else asked of it', async () => {
    const hangs: (string | undefined)[] = [];
    const o = opts({ code: null, stdout: '', stderr: '', timedOut: true }, { onHang: (d) => hangs.push(d) });
    await expect(startContainer(o)).rejects.toMatchObject({ code: 'DOCKER_NOT_RESPONDING', params: { reason: 'timeout' } });
    expect(hangs).toEqual([' (docker run did not answer)']);
    // No cleanup call to an engine that does not answer.
    expect((o.proc as unknown as { calls: { args: string[] }[] }).calls.map((c) => c.args[0])).toEqual(['run']);
  });

  it("Docker Desktop's proxy gave up (context deadline exceeded), with or without someone to tell", async () => {
    const deadline = fail(125, 'docker: Error response from daemon: request returned 500 Internal Server Error: context deadline exceeded');
    const hangs: (string | undefined)[] = [];
    await expect(startContainer(opts(deadline, { onHang: (d) => hangs.push(d) }))).rejects.toMatchObject({ code: 'DOCKER_NOT_RESPONDING', params: { reason: 'deadline' } });
    expect(hangs[0]).toContain('context deadline exceeded');
    await expect(startContainer(opts(deadline))).rejects.toMatchObject({ code: 'DOCKER_NOT_RESPONDING' });
  });

  it('cancelled meanwhile: CANCELLED, not a hang', async () => {
    const ac = new AbortController();
    const hangs: (string | undefined)[] = [];
    const o = opts(
      () => {
        ac.abort();
        return { code: null, stdout: '', stderr: '', timedOut: true };
      },
      { onHang: (d) => hangs.push(d), signal: ac.signal },
    );
    await expect(startContainer(o)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(hangs).toEqual([]);
  });
});
