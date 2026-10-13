import { describe, expect, it } from 'vitest';
import { launchParamsSchema } from '../../../../src/contract/engines';
import { AppError } from '../../../../src/contract/errors';
import type { RunOutput } from '../../../../src/core/deps';
import { DockerCli } from '../../../../src/core/docker/cli';
import { startContainer, type StartContainerOptions } from '../../../../src/core/docker/container';
import type { LaunchPlan } from '../../../../src/core/engines/types';
import type { InferenceClient } from '../../../../src/core/inference/types';
import { fail, scriptedProc, silentLog, steppingClock } from './helpers';

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
