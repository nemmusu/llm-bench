import { describe, expect, it } from 'vitest';
import { createDockerServices, dockerTimings } from '../../../../src/core/docker/services';
import { ok, routeFetch, scriptedProc, silentLog, steppingClock } from './helpers';

describe('GPUBENCH_DOCKER_TIMINGS', () => {
  it('takes known timings (ms, never negative) for Docker and its watchdog; ignores the rest', () => {
    expect(dockerTimings(undefined)).toEqual({ env: {}, control: {} });
    expect(dockerTimings('not json')).toEqual({ env: {}, control: {} });
    expect(dockerTimings('7')).toEqual({ env: {}, control: {} });
    expect(dockerTimings(JSON.stringify({ versionTimeoutMs: 1500, stuckStoppingMs: 0, restartWaitMs: -1, startPollMs: 'x', activeEveryMs: 500, other: 3, idleEveryMs: Infinity }))).toEqual({
      env: { versionTimeoutMs: 1500, stuckStoppingMs: 0 },
      control: { activeEveryMs: 500 },
    });
  });

  it("the environment gets the timings and wsl.exe's stand-in (the last-resort restart)", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const proc = scriptedProc((args, cmd) => {
      calls.push({ cmd, args });
      return ok();
    });
    const s = createDockerServices(
      {
        proc,
        platform: 'win32',
        env: {},
        endpoints: { githubApi: '', huggingface: '', dockerHub: 'https://hub.test', docker: ['docker'], wsl: ['node', 'fake-wsl.mjs'] },
        paths: { dataDir: '', cacheDir: '', enginesDir: '', resultsDir: '', modelsDir: '', resourcesDir: '', home: '/nonexistent' },
        clock: steppingClock(),
        fetch: routeFetch({}),
        log: silentLog,
      },
      { versionTimeoutMs: 1500, restartWaitMs: 0 },
    );
    await s.env.status();
    expect(calls[0]?.args).toEqual(['version', '--format', 'json']);
    expect(proc.calls[0]?.opts?.timeoutMs).toBe(1500);
    await s.env.restartDesktop(new AbortController().signal, undefined, { deep: true }).catch(() => undefined);
    expect(calls.find((c) => c.cmd === 'node')?.args).toEqual(['fake-wsl.mjs', '--terminate', 'docker-desktop']);
  });
});
