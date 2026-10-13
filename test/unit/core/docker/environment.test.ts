import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunOutput } from '../../../../src/core/deps';
import { DockerCli } from '../../../../src/core/docker/cli';
import {
  codeForState,
  containerOwnership,
  defaultLaunchDetached,
  desktopExecutables,
  DockerEnvironment,
  type StartProgress,
} from '../../../../src/core/docker/environment';
import { DOCKER_FIXTURES, fail, ok, recordingLog, scriptedProc, steppingClock } from './helpers';

const fx = (n: string) => readFileSync(path.join(DOCKER_FIXTURES, n), 'utf8');
const DOWN = fail(1, fx('win-version-daemon-down.stderr.txt'), fx('win-version-daemon-down.stdout.json'));
const running = (extra: Record<string, unknown> = {}): RunOutput =>
  ok(
    JSON.stringify({
      Client: { Version: '29.8.0', Context: 'desktop-linux' },
      Server: { Version: '29.8.0', Os: 'linux', Platform: { Name: 'Docker Desktop 4.47.0 (210443)' }, Components: [{ Name: 'Engine' }], ...extra },
    }),
  );

function env(handler: (args: string[]) => RunOutput | Promise<RunOutput>, o: Partial<ConstructorParameters<typeof DockerEnvironment>[0]> = {}) {
  const proc = scriptedProc(handler);
  const cli = new DockerCli({ proc, platform: 'win32', env: {}, override: ['docker'] });
  const clock = steppingClock();
  const e = new DockerEnvironment({ cli, clock, platform: 'win32', env: {}, ...o });
  return { proc, cli, clock, e };
}

describe('DockerEnvironment.status', () => {
  it('reports running with versions and context', async () => {
    const { e } = env(() => running());
    expect(await e.status()).toEqual({
      state: 'running',
      version: '29.8.0',
      clientVersion: '29.8.0',
      serverVersion: '29.8.0',
      context: 'desktop-linux',
      platform: 'Docker Desktop 4.47.0 (210443)',
    });
    expect(await e.dockerStatus()).toEqual({ state: 'running', version: '29.8.0' });
  });

  it('reports stopped from the real daemon-down capture', async () => {
    const { e } = env(() => DOWN);
    const s = await e.status();
    expect(s).toMatchObject({ state: 'stopped', version: '29.8.0', clientVersion: '29.8.0', context: 'desktop-linux' });
    expect(s.detail).toContain('dockerDesktopLinuxEngine');
  });

  it('reports not-installed, WSL integration, permission, starting, unsupported and unknown', async () => {
    expect((await env(() => fail(null, 'Error: spawn docker ENOENT')).e.status()).state).toBe('not-installed');
    expect(await env(() => ok(fx('wsl-shim.stdout.txt'))).e.status()).toMatchObject({ state: 'not-installed', reason: 'wsl-integration' });
    expect((await env(() => fail(1, 'permission denied while trying to connect to the Docker daemon socket')).e.status()).state).toBe('no-permission');
    expect((await env(() => fail(1, 'request returned 500 Internal Server Error for API route and version')).e.status()).state).toBe('starting');
    expect(await env(() => running({ Components: [{ Name: 'Podman Engine' }] })).e.status()).toMatchObject({ state: 'unsupported', reason: 'podman' });
    expect(await env(() => running({ Os: 'windows' })).e.status()).toMatchObject({ state: 'unsupported', reason: 'windows-containers' });
    const odd = await env(() => fail(3, 'something unexpected')).e.status();
    expect(odd).toMatchObject({ state: 'unknown', detail: 'something unexpected' });
    expect(await env(() => fail(3, '')).e.dockerStatus()).toEqual({ state: 'unknown' });
  });

  it('caches for a short window and shares an in-flight probe', async () => {
    const { e, proc, clock } = env(() => running());
    const versions = () => proc.calls.filter((c) => c.args[0] === 'version');
    await Promise.all([e.status(), e.status()]);
    expect(versions()).toHaveLength(1);
    await e.status();
    expect(versions()).toHaveLength(1);
    clock.t += 5000;
    await e.status();
    expect(versions()).toHaveLength(2);
    await e.status({ fresh: true });
    expect(versions()).toHaveLength(3);
    // Docker Desktop's own status is asked once a minute, in the background.
    expect(proc.calls.filter((c) => c.args[0] === 'desktop')).toHaveLength(1);
  });
});

describe('DockerEnvironment.startDesktop', () => {
  it('uses `docker desktop start --detach` and polls until running', async () => {
    let started = false;
    let polls = 0;
    const { e, proc } = env((args) => {
      if (args[0] === 'desktop') {
        started = true;
        return ok();
      }
      if (!started) return DOWN;
      polls++;
      return polls < 3 ? fail(1, 'request returned 500 Internal Server Error for API route and version') : running();
    });
    const progress: StartProgress[] = [];
    const s = await e.startDesktop(new AbortController().signal, (p) => progress.push(p));
    expect(s.state).toBe('running');
    expect(proc.calls.find((c) => c.args[0] === 'desktop')?.args).toEqual(['desktop', 'start', '--detach']);
    expect(progress.map((p) => p.state)).toEqual(['starting', 'starting', 'running']);
    expect(progress.every((p) => p.method === 'cli' && !p.slow)).toBe(true);
  });

  it('shares one start between callers and reports "starting" meanwhile', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started = false;
    const { e } = env(async (args) => {
      if (args[0] === 'desktop') {
        await gate;
        started = true;
        return ok();
      }
      return started ? running() : DOWN;
    });
    const ac = new AbortController();
    const a = e.startDesktop(ac.signal);
    const b = e.startDesktop(ac.signal);
    expect(b).toBe(a);
    await new Promise((r) => setTimeout(r, 5));
    const mid = await e.status({ fresh: true });
    expect(mid.state).toBe('starting');
    expect(mid.startingForMs).toBeGreaterThanOrEqual(0);
    release();
    expect((await a).state).toBe('running');
  });

  it('falls back to the Docker Desktop executable when the CLI plugin is missing', async () => {
    const launched: string[] = [];
    let up = false;
    const log = recordingLog();
    const { e } = env(
      (args) => {
        if (args[0] === 'desktop') return fail(1, "docker: 'desktop' is not a docker command.");
        return up ? running() : DOWN;
      },
      {
        env: { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
        exists: async (p) => p.includes('Programs'),
        launchDetached: async (cmd) => {
          launched.push(cmd);
          up = true;
        },
        log,
      },
    );
    const progress: StartProgress[] = [];
    await e.startDesktop(new AbortController().signal, (p) => progress.push(p));
    expect(launched).toEqual(['C:\\Users\\u\\AppData\\Local\\Programs\\DockerDesktop\\Docker Desktop.exe']);
    expect(progress[0]?.method).toBe('exe');
    expect(log.entries).toHaveLength(0);
  });

  it('logs an unexpected plugin failure and still launches the executable', async () => {
    const log = recordingLog();
    let up = false;
    const { e } = env((args) => (args[0] === 'desktop' ? fail(1, 'license not accepted') : up ? running() : DOWN), {
      env: { ProgramFiles: 'C:\\PF' },
      exists: async () => true,
      launchDetached: async () => {
        up = true;
      },
      log,
    });
    await e.startDesktop(new AbortController().signal);
    expect(log.entries[0]?.msg).toContain('launching the executable');
  });

  it('fails when Docker Desktop cannot be found', async () => {
    const { e } = env((args) => (args[0] === 'desktop' ? fail(1, "'desktop' is not a docker command") : DOWN), { exists: async () => false });
    await expect(e.startDesktop(new AbortController().signal)).rejects.toMatchObject({ code: 'DOCKER_NOT_INSTALLED', params: { reason: 'desktop-not-found' } });
  });

  it('times out, flags slow starts, and can be cancelled', async () => {
    const { e } = env((args) => (args[0] === 'desktop' ? ok() : fail(1, 'request returned 500 Internal Server Error')), {
      startTimeoutMs: 10_000,
      slowStartMs: 4000,
      startPollMs: 2000,
    });
    const progress: StartProgress[] = [];
    // Docker Desktop is up but its engine never got ready: only a restart helps.
    await expect(e.startDesktop(new AbortController().signal, (p) => progress.push(p))).rejects.toMatchObject({
      code: 'DOCKER_NOT_RESPONDING',
      params: { reason: 'start-timeout', timeoutMs: 10_000 },
    });
    expect(progress.some((p) => p.slow)).toBe(true);
    expect(await e.status({ fresh: true })).toMatchObject({ state: 'not-responding', reason: 'start-timeout' });

    const timeoutNoDetail = env((args) => (args[0] === 'desktop' ? ok() : fail(1, 'Docker Desktop is starting')), { startTimeoutMs: 1 });
    timeoutNoDetail.proc.calls.length = 0;
    const err = await timeoutNoDetail.e.startDesktop(new AbortController().signal).catch((x: unknown) => x);
    expect(err).toMatchObject({ code: 'DOCKER_NOT_RESPONDING' });

    const ac = new AbortController();
    const c = env((args) => (args[0] === 'desktop' ? ok() : DOWN));
    const p = c.e.startDesktop(ac.signal, () => ac.abort());
    await expect(p).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('returns at once when already running, and refuses impossible starts', async () => {
    expect((await env(() => running()).e.startDesktop(new AbortController().signal)).state).toBe('running');
    await expect(env(() => fail(null, 'spawn docker ENOENT')).e.startDesktop(new AbortController().signal)).rejects.toMatchObject({
      code: 'DOCKER_NOT_INSTALLED',
      params: { reason: 'missing' },
    });
    await expect(env(() => ok(fx('wsl-shim.stdout.txt'))).e.startDesktop(new AbortController().signal)).rejects.toMatchObject({
      params: { reason: 'wsl-integration' },
    });
    await expect(env(() => fail(1, 'Got permission denied')).e.startDesktop(new AbortController().signal)).rejects.toMatchObject({
      code: 'DOCKER_PERMISSION',
    });
    await expect(env(() => DOWN, { platform: 'linux' }).e.startDesktop(new AbortController().signal)).rejects.toMatchObject({
      code: 'DOCKER_NOT_RUNNING',
      params: { reason: 'manual-start', platform: 'linux' },
    });
  });
});

describe('DockerEnvironment.gpuCheck', () => {
  it('lists the GPUs seen inside the container', async () => {
    const { e, proc } = env((args) => (args[0] === 'run' ? ok('GPU 0: NVIDIA GeForce RTX 5090 (UUID: GPU-1)\n') : running()));
    expect(await e.gpuCheck('ghcr.io/ggml-org/llama.cpp:server-cuda', new AbortController().signal)).toEqual({
      image: 'ghcr.io/ggml-org/llama.cpp:server-cuda',
      gpus: ['GPU 0: NVIDIA GeForce RTX 5090 (UUID: GPU-1)'],
    });
    expect(proc.calls[0]?.args).toEqual(['run', '--rm', '--pull', 'never', '--gpus', 'all', '--entrypoint', 'nvidia-smi', 'ghcr.io/ggml-org/llama.cpp:server-cuda', '-L']);
    expect((await e.status()).state).toBe('running');
  });

  it('remembers a GPU failure in status() until a check succeeds', async () => {
    let gpu = false;
    const { e } = env((args) =>
      args[0] === 'run'
        ? gpu
          ? ok('GPU 0: X')
          : fail(125, 'docker: Error response from daemon: could not select device driver "" with capabilities: [[gpu]]')
        : running(),
    );
    await expect(e.gpuCheck('img')).rejects.toMatchObject({ code: 'DOCKER_NO_GPU' });
    expect(await e.status()).toMatchObject({ state: 'no-gpu', reason: 'gpu-check-failed' });
    expect((await e.status()).detail).toContain('could not select device driver');
    gpu = true;
    await e.gpuCheck('img');
    expect((await e.status()).state).toBe('running');
    e.noteGpuFailure('img');
    expect(await e.status()).toEqual(expect.objectContaining({ state: 'no-gpu' }));
    expect((await e.status()).detail).toBeUndefined();
  });

  it('treats an empty nvidia-smi output and other failures correctly', async () => {
    const empty = env((args) => (args[0] === 'run' ? ok('') : running()));
    await expect(empty.e.gpuCheck('img')).rejects.toMatchObject({ code: 'DOCKER_NO_GPU' });
    const missing = env((args) => (args[0] === 'run' ? fail(125, 'docker: Error response from daemon: No such image: img') : running()));
    await expect(missing.e.gpuCheck('img')).rejects.toMatchObject({ code: 'ENGINE_NOT_INSTALLED' });
    expect((await missing.e.status()).state).toBe('running');
    const old = env((args) => (args[0] === 'run' ? fail(125, 'nvidia-container-cli: requirement error: unsatisfied condition: cuda>=13.0') : running()));
    await expect(old.e.gpuCheck('img')).rejects.toMatchObject({ code: 'DRIVER_TOO_OLD' });
    expect((await old.e.status()).state).toBe('no-gpu');
    const weird = env((args) => (args[0] === 'run' ? fail(1, 'something') : running()));
    await expect(weird.e.gpuCheck('img')).rejects.toMatchObject({ code: 'DOCKER_NO_GPU' });
  });
});

describe('orphan cleanup and ownership', () => {
  const rows = [
    { ID: 'a', Names: 'gpubench-old', Labels: 'gpubench=1,gpubench.marker=old', State: 'exited' },
    { ID: 'b', Names: 'gpubench-live', Labels: 'gpubench=1,gpubench.marker=live', State: 'running' },
    { ID: 'c', Names: 'no-marker', Labels: 'gpubench=1', State: 'exited' },
    { ID: 'd', Names: 'lookalike', Labels: 'gpubench=yes,gpubench.marker=x', State: 'exited' },
    { ID: 'e', Names: 'gpubench-stuck', Labels: 'gpubench=1,gpubench.marker=stuck', State: 'exited' },
  ]
    .map((r) => JSON.stringify(r))
    .join('\n');

  it('removes only our labelled leftovers, never active runs or other containers', async () => {
    const log = recordingLog();
    const { e, proc } = env((args) => {
      if (args[0] === 'ps') return ok(rows);
      if (args[0] === 'rm' && args[2] === 'e') return fail(1, 'Error response from daemon: removal of container e is already in progress (permission denied while trying to connect)');
      return ok();
    }, { log });
    const res = await e.cleanupOrphans(['live']);
    expect(res.removed).toEqual([{ id: 'a', name: 'gpubench-old' }]);
    expect(proc.calls.filter((c) => c.args[0] === 'rm').map((c) => c.args[2])).toEqual(['a', 'e']);
    expect(log.entries[0]?.data).toMatchObject({ id: 'e', error: 'DOCKER_PERMISSION' });
    const plain = env((args) => (args[0] === 'ps' ? ok(rows) : Promise.reject(new Error('boom'))), { log });
    expect((await plain.e.cleanupOrphans()).removed).toEqual([]);
    expect(log.entries.at(-1)?.data).toMatchObject({ error: 'Error: boom' });
  });

  it('verifies containers by label and marker before stopping them', async () => {
    const inspect = (labels: Record<string, string>) => ok(JSON.stringify([{ Id: 'x', Name: '/gpubench-m', State: { Running: true }, Config: { Labels: labels } }]));
    const { cli, proc } = env((args) => {
      if (args[0] === 'container' && args[2] === 'ours') return inspect({ gpubench: '1', 'gpubench.marker': 'marker-1' });
      if (args[0] === 'container' && args[2] === 'gpubench-marker-2') return inspect({ gpubench: '1', 'gpubench.marker': 'other' });
      if (args[0] === 'container') return fail(1, 'Error: No such container');
      if (args[0] === 'stop') return Promise.reject(new Error('stop failed'));
      return ok();
    });
    const own = containerOwnership(cli);
    const rec = { pid: 1, startedAtWall: 0, exe: 'docker', marker: 'marker-1', runId: 'r', kind: 'container' as const, containerId: 'ours' };
    expect(await own.verify(rec)).toBe(true);
    expect(await own.verify({ ...rec, containerId: undefined, marker: 'marker-2' })).toBe(false);
    expect(await own.verify({ ...rec, containerId: 'gone' })).toBe(false);
    await own.stop(rec);
    expect(proc.calls.slice(-2).map((c) => c.args)).toEqual([
      ['stop', '-t', '10', 'ours'],
      ['rm', '-f', 'ours'],
    ]);
    await own.stop({ ...rec, containerId: undefined });
    expect(proc.calls.at(-1)?.args).toEqual(['rm', '-f', 'gpubench-marker-1']);
    const broken = env(() => Promise.reject(new Error('x')));
    expect(await containerOwnership(broken.cli).verify(rec)).toBe(false);
  });
});

describe('helpers', () => {
  it('maps states to error codes', () => {
    expect(codeForState('running')).toBeUndefined();
    expect(codeForState('not-installed')).toBe('DOCKER_NOT_INSTALLED');
    expect(codeForState('no-permission')).toBe('DOCKER_PERMISSION');
    expect(codeForState('no-gpu')).toBe('DOCKER_NO_GPU');
    expect(codeForState('unsupported')).toBe('DOCKER_UNSUPPORTED');
    expect(codeForState('stopped')).toBe('DOCKER_NOT_RUNNING');
    expect(codeForState('starting')).toBe('DOCKER_NOT_RUNNING');
    expect(codeForState('unknown')).toBe('DOCKER_NOT_RUNNING');
  });

  it('lists Docker Desktop executables', () => {
    expect(desktopExecutables({})).toEqual([]);
    expect(desktopExecutables({ PROGRAMFILES: 'C:\\PF' })).toEqual(['C:\\PF\\Docker\\Docker\\Docker Desktop.exe']);
  });

  it('launches a detached program, or reports a spawn error', async () => {
    await expect(defaultLaunchDetached(process.execPath, ['-e', ''])).resolves.toBeUndefined();
    await expect(defaultLaunchDetached(path.join(DOCKER_FIXTURES, 'no-such-program.exe'), [])).rejects.toThrow();
  });

  it('uses the real file system and launcher by default', async () => {
    const proc = scriptedProc(() => DOWN);
    const e = new DockerEnvironment({ cli: new DockerCli({ proc, platform: 'win32', env: {}, override: ['docker'] }), clock: steppingClock(), platform: 'win32', env: {} });
    expect(e.cli).toBeInstanceOf(DockerCli);
    const desktop = new DockerEnvironment({
      cli: new DockerCli({ proc: scriptedProc((a) => (a[0] === 'desktop' ? fail(1, "'desktop' is not a docker command") : DOWN)), platform: 'win32', env: {}, override: ['docker'] }),
      clock: steppingClock(),
      platform: 'win32',
      env: { ProgramFiles: path.join(DOCKER_FIXTURES, 'nowhere') },
    });
    await expect(desktop.startDesktop(new AbortController().signal)).rejects.toMatchObject({ code: 'DOCKER_NOT_INSTALLED' });
  });
});

describe('DockerEnvironment edge cases', () => {
  it('finds Docker Desktop with the real file system', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const os = await import('node:os');
    const pf = mkdtempSync(path.join(os.tmpdir(), 'gb-pf-'));
    try {
      mkdirSync(path.join(pf, 'Docker', 'Docker'), { recursive: true });
      writeFileSync(path.join(pf, 'Docker', 'Docker', 'Docker Desktop.exe'), '');
      const launched: string[] = [];
      let up = false;
      const proc = scriptedProc((a) => (a[0] === 'desktop' ? fail(1, "'desktop' is not a docker command") : up ? running() : DOWN));
      const e = new DockerEnvironment({
        cli: new DockerCli({ proc, platform: 'win32', env: {}, override: ['docker'] }),
        clock: steppingClock(),
        platform: 'win32',
        env: { ProgramFiles: pf },
        launchDetached: async (cmd) => {
          launched.push(cmd);
          up = true;
        },
      });
      await e.startDesktop(new AbortController().signal);
      expect(launched).toEqual([path.win32.join(pf, 'Docker', 'Docker', 'Docker Desktop.exe')]);
    } finally {
      rmSync(pf, { recursive: true, force: true });
    }
  });

  it('times out without a detail when the CLI says nothing', async () => {
    const { e } = env((args) => (args[0] === 'desktop' ? ok() : fail(3, '')), { startTimeoutMs: 1 });
    const err = (await e.startDesktop(new AbortController().signal).catch((x: unknown) => x)) as { code: string; detail?: string };
    expect(err.code).toBe('DOCKER_NOT_RUNNING');
    expect(err.detail).toBeUndefined();
  });
});

describe('DockerEnvironment: sparse version output', () => {
  it('handles a client without context and a server without platform', async () => {
    const { e } = env(() => ok(JSON.stringify({ Client: { Version: '5.2.0' }, Server: { Version: '5.2.0', Os: 'linux' } })));
    expect(await e.status()).toEqual({ state: 'running', version: '5.2.0', clientVersion: '5.2.0', serverVersion: '5.2.0' });
  });
});
