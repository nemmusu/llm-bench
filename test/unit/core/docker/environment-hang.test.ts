import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunOptions, RunOutput } from '../../../../src/core/deps';
import { DockerCli } from '../../../../src/core/docker/cli';
import { DOCKER_WSL_DISTRO, DockerEnvironment, type DockerStatusDetail, type RestartProgress } from '../../../../src/core/docker/environment';
import { DOCKER_FIXTURES, fail, ok, recordingLog, scriptedProc, steppingClock } from './helpers';

const fx = (n: string) => readFileSync(path.join(DOCKER_FIXTURES, n), 'utf8');
const DOWN = fail(1, fx('win-version-daemon-down.stderr.txt'), fx('win-version-daemon-down.stdout.json'));
const STARTING = fail(1, 'request returned 500 Internal Server Error for API route and version http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.51/version');
const HUNG: RunOutput = { code: null, stdout: '', stderr: '', timedOut: true };
const running = (platform = 'Docker Desktop 4.47.0 (210443)'): RunOutput =>
  ok(JSON.stringify({ Client: { Version: '29.8.0', Context: 'desktop-linux' }, Server: { Version: '29.8.0', Os: 'linux', Platform: { Name: platform }, Components: [{ Name: 'Engine' }] } }));
const desktop = (status: string) => ok(JSON.stringify({ Status: status, SessionID: 'x' }));

type Handler = (args: string[], cmd: string, opts?: RunOptions) => RunOutput | Promise<RunOutput>;

function env(handler: Handler, o: Partial<ConstructorParameters<typeof DockerEnvironment>[0]> = {}) {
  const proc = scriptedProc(handler);
  const cli = new DockerCli({ proc, platform: 'win32', env: {}, override: ['docker'] });
  const clock = steppingClock();
  const log = recordingLog();
  const e = new DockerEnvironment({ cli, clock, platform: 'win32', env: {}, log, proc, ...o });
  const seen: DockerStatusDetail['state'][] = [];
  e.onChange((s) => seen.push(s.state));
  return { proc, cli, clock, e, log, seen };
}

/** Lets a background `docker desktop status` finish. */
const settle = () => new Promise((r) => setTimeout(r, 5));

describe('not responding: docker version does not answer', () => {
  it('one slow answer keeps the last state; two in a row are "not-responding" until it answers again', async () => {
    let hang = true;
    const { e, seen } = env((a) => (a[0] === 'version' ? (hang ? HUNG : running()) : desktop('running')), { versionTimeoutMs: 1500 });
    expect(await e.status({ fresh: true })).toEqual({ state: 'unknown', reason: 'slow-answer' });
    const s = await e.status({ fresh: true });
    expect(s).toMatchObject({ state: 'not-responding', reason: 'version-timeout', detail: 'docker version did not answer' });
    expect(s.stuckForMs).toBe(0);
    hang = false;
    expect((await e.status({ fresh: true })).state).toBe('running');
    hang = true;
    // After a good answer one slow one is "slow", with the last state.
    expect(await e.status({ fresh: true })).toMatchObject({ state: 'running', reason: 'slow-answer' });
    expect(seen).toEqual(['unknown', 'not-responding', 'running']);
  });

  it('passes the short time limit to the CLI', async () => {
    const { e, proc } = env(() => running('Docker Engine - Community'), { versionTimeoutMs: 1234 });
    expect(e.platform).toBe('win32');
    await e.status();
    expect(proc.calls[0]?.opts?.timeoutMs).toBe(1234);
    const d = env(() => running('Docker Engine - Community'));
    await d.e.status();
    expect(d.proc.calls[0]?.opts?.timeoutMs).toBe(10_000);
  });
});

describe('not responding: Docker Desktop stuck stopping', () => {
  it('its own status says "stopping" for too long while its cache answers version: not-responding until it moves on', async () => {
    let status = 'stopping';
    const { e, clock, seen } = env((a) => (a[0] === 'version' ? running() : desktop(status)), { stuckStoppingMs: 20_000 });
    expect((await e.status()).state).toBe('running');
    await settle();
    clock.t += 61_000;
    expect((await e.status()).state).toBe('running');
    await settle();
    // The background check found it stuck: the cached state changes at once (the tray hears it).
    expect(e.peek()).toMatchObject({ state: 'not-responding', reason: 'desktop-stuck', detail: 'Docker Desktop: engine stopping' });
    expect(seen).toEqual(['running', 'not-responding']);
    expect((await e.status({ fresh: true })).state).toBe('not-responding');
    status = 'running';
    clock.t += 61_000;
    await e.status();
    await settle();
    expect((await e.status({ fresh: true })).state).toBe('running');
  });

  it('Docker Desktop not answering about itself counts the same', async () => {
    const { e, clock } = env((a) => (a[0] === 'version' ? running() : HUNG));
    await e.status();
    await settle();
    clock.t += 61_000;
    await e.status();
    await settle();
    expect(e.peek()).toMatchObject({ state: 'not-responding', detail: 'docker desktop status did not answer' });
  });

  it('asks Docker Desktop once a minute at most, never without its plugin, and only on Windows with Docker Desktop', async () => {
    const plugin = env((a) => (a[0] === 'version' ? running() : fail(1, "docker: 'desktop' is not a docker command.")));
    await plugin.e.status();
    await settle();
    plugin.clock.t += 120_000;
    await plugin.e.status({ fresh: true });
    await plugin.e.probe();
    expect(plugin.proc.calls.filter((c) => c.args[0] === 'desktop')).toHaveLength(1);
    const engine = env(() => running('Docker Engine - Community'));
    await engine.e.status();
    await engine.e.probe();
    expect(engine.proc.calls.some((c) => c.args[0] === 'desktop')).toBe(false);
    const linux = env(() => running(), { platform: 'linux' });
    await linux.e.status();
    await linux.e.probe();
    expect(linux.proc.calls.some((c) => c.args[0] === 'desktop')).toBe(false);
  });

  it('a failing desktop status call is logged and ignored', async () => {
    const { e, log } = env((a) => (a[0] === 'version' ? running() : Promise.reject(new Error('spawn failed'))));
    await e.status();
    await settle();
    expect(log.entries.find((x) => x.msg === 'docker desktop status failed')?.data).toEqual({ error: 'Error: spawn failed' });
    expect((await e.status({ fresh: true })).state).toBe('running');
  });
});

describe('probe: a real check before Docker is used', () => {
  it('waits out a "stopping" that may be stuck, then says so', async () => {
    const { e, proc, clock } = env((a) => (a[0] === 'version' ? running() : a[0] === 'desktop' ? desktop('stopping') : ok('')), { stuckStoppingMs: 20_000 });
    const t0 = clock.t;
    const s = await e.probe();
    expect(s).toMatchObject({ state: 'not-responding', reason: 'desktop-stuck' });
    expect(clock.t - t0).toBeGreaterThanOrEqual(20_000);
    expect(proc.calls.filter((c) => c.args[0] === 'desktop')).toHaveLength(2);
  });

  it('a call the engine must answer: a timeout or the proxy deadline is "calls-failing"; an answer clears it', async () => {
    let ps: RunOutput = HUNG;
    const { e, proc } = env((a) => (a[0] === 'version' ? running('Docker Engine - Community') : ps));
    expect(await e.probe()).toMatchObject({ state: 'not-responding', reason: 'calls-failing', detail: ' (docker ps did not answer)' });
    expect(proc.calls.find((c) => c.args[0] === 'ps')?.args).toEqual(['ps', '-q', '--filter', 'label=gpubench=1']);
    ps = ok('');
    expect((await e.probe()).state).toBe('running');
    ps = fail(1, 'Error response from daemon: context deadline exceeded');
    expect((await e.probe()).detail).toContain('context deadline exceeded');
    // An odd failure that is not a hang says nothing about it.
    ps = fail(1, 'something else');
    expect((await e.probe()).state).toBe('not-responding');
  });

  it('returns the plain status when Docker is not up, or while we start or restart it', async () => {
    expect((await env(() => DOWN).e.probe()).state).toBe('stopped');
    expect((await env(() => running('Docker Engine - Community')).e.probe({ ...new AbortController() }.signal)).state).toBe('running');
    const timeouts = env((a) => (a[0] === 'version' ? HUNG : ok('')));
    await timeouts.e.status({ fresh: true });
    // Not responding because version itself hangs: no point asking more.
    expect(await timeouts.e.probe()).toMatchObject({ state: 'not-responding', reason: 'version-timeout' });
    expect(timeouts.proc.calls.some((c) => c.args[0] === 'ps')).toBe(false);
  });
});

describe('not responding: starting for too long, a start that never ends, failing calls', () => {
  it('starting (not by us) longer than stuckStartingMs; an answer clears it', async () => {
    let up = false;
    const { e, clock } = env((a) => (a[0] === 'version' ? (up ? running('Docker Engine - Community') : STARTING) : ok('')), { stuckStartingMs: 60_000 });
    expect((await e.status({ fresh: true })).state).toBe('starting');
    clock.t += 61_000;
    expect(await e.status({ fresh: true })).toMatchObject({ state: 'not-responding', reason: 'starting-too-long' });
    up = true;
    expect((await e.status({ fresh: true })).state).toBe('running');
  });

  it('a deadline in docker version itself, then Docker Desktop closed: stopped, nothing stuck any more', async () => {
    let out = fail(1, 'Error response from daemon: context deadline exceeded');
    const { e } = env(() => out);
    expect(await e.status({ fresh: true })).toMatchObject({ state: 'not-responding', reason: 'calls-failing' });
    out = DOWN;
    expect((await e.status({ fresh: true })).state).toBe('stopped');
    out = fail(null, 'Error: spawn docker ENOENT');
    expect((await e.status({ fresh: true })).state).toBe('not-installed');
  });

  it('reportHang(): a call of ours got no answer; the cached state says it at once, once', async () => {
    const { e, seen, log } = env((a) => (a[0] === 'version' ? running('Docker Engine - Community') : HUNG));
    await e.status();
    e.reportHang('docker run did not answer');
    e.reportHang('again');
    expect(e.peek()).toMatchObject({ state: 'not-responding', reason: 'calls-failing', detail: 'docker run did not answer' });
    expect(seen).toEqual(['running', 'not-responding']);
    // The first report counts (its reason, its time); the next ones add nothing.
    expect(log.entries.filter((x) => x.msg === 'docker does not answer')).toHaveLength(1);
    expect(await e.dockerStatus()).toEqual({ state: 'not-responding', version: '29.8.0' });
    // Reported before anything was known: the next look says it.
    const early = env((a) => (a[0] === 'version' ? running('Docker Engine - Community') : HUNG));
    early.e.reportHang();
    expect(early.e.peek()).toBeUndefined();
    expect(await early.e.status()).toMatchObject({ state: 'not-responding', reason: 'calls-failing' });
    expect((await early.e.status()).detail).toBeUndefined();
  });

  it('a start asked while stuck is refused: only a restart helps', async () => {
    const { e } = env((a) => (a[0] === 'version' ? running('Docker Engine - Community') : ok()));
    await e.status();
    e.reportHang();
    await expect(e.startDesktop(new AbortController().signal)).rejects.toMatchObject({ code: 'DOCKER_NOT_RESPONDING', params: { reason: 'use-restart' } });
  });

  it('marks nothing while our own start runs', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started = false;
    const { e } = env(async (a) => {
      if (a[0] === 'desktop') {
        await gate;
        started = true;
        return ok();
      }
      return started ? running('Docker Engine - Community') : DOWN;
    });
    const p = e.startDesktop(new AbortController().signal);
    await settle();
    expect(e.busy()).toBe('starting');
    e.reportHang('ignored');
    expect((await e.status({ fresh: true })).state).toBe('starting');
    release();
    expect((await p).state).toBe('running');
    expect(e.busy()).toBeUndefined();
  });
});

describe('restartDesktop', () => {
  /** A Docker Desktop that comes back after `restart` (or after stop + start), as the handler says. */
  function desktopWorld(o: { restart?: 'ok' | 'fail' | 'hang' | 'plugin'; comesBack?: boolean; status?: string } = {}) {
    let up = false;
    const calls: string[][] = [];
    const t = env(
      (a, cmd) => {
        calls.push([cmd, ...a]);
        if (cmd === 'wsl.exe' || cmd === 'fake-wsl') return a[0] === '--terminate' ? fail(1, 'There is no distribution with the supplied name.') : ok();
        if (a[0] === 'desktop' && a[1] === 'status') return desktop(o.status ?? 'running');
        if (a[0] === 'desktop' && a[1] === 'restart') {
          if (o.restart === 'plugin') return fail(1, "docker: 'desktop' is not a docker command.");
          if (o.restart === 'hang') return HUNG;
          if (o.restart === 'fail') return fail(1, 'Error: could not restart');
          up = o.comesBack !== false;
          return ok();
        }
        if (a[0] === 'desktop' && a[1] === 'stop') return ok();
        if (a[0] === 'desktop' && a[1] === 'start') {
          up = o.comesBack !== false;
          return ok();
        }
        return up ? running() : DOWN;
      },
      { restartWaitMs: 10_000, startPollMs: 2000 },
    );
    return { ...t, calls };
  }

  it("Docker Desktop's own restart, waited for until Docker answers", async () => {
    const { e, calls } = desktopWorld();
    const progress: RestartProgress[] = [];
    const s = await e.restartDesktop(new AbortController().signal, (p) => progress.push(p));
    expect(s.state).toBe('running');
    expect(calls.filter((c) => c[1] === 'desktop').map((c) => c.slice(1).join(' '))).toEqual(['desktop restart', 'desktop status --format json']);
    expect(progress[0]).toMatchObject({ step: 'restart', index: 1, steps: 3, state: 'starting', slow: false });
    expect(progress.at(-1)).toMatchObject({ step: 'restart', state: 'running' });
    expect(e.busy()).toBeUndefined();
  });

  it('a restart that fails or hangs: forced stop, then a start', async () => {
    for (const restart of ['fail', 'hang'] as const) {
      const { e, calls, log } = desktopWorld({ restart });
      const progress: RestartProgress[] = [];
      expect((await e.restartDesktop(new AbortController().signal, (p) => progress.push(p))).state).toBe('running');
      expect(calls.filter((c) => c[1] === 'desktop' && c[2] !== 'status').map((c) => c.slice(1).join(' '))).toEqual(['desktop restart', 'desktop stop --force', 'desktop start --detach']);
      expect([...new Set(progress.map((p) => p.step))]).toEqual(['restart', 'force-stop', 'start']);
      expect(log.entries.some((x) => x.msg === 'docker desktop restart failed')).toBe(true);
    }
  });

  it('not back after a restart and a forced start: the last resort is offered, never run unasked', async () => {
    const { e, calls } = desktopWorld({ comesBack: false });
    await expect(e.restartDesktop(new AbortController().signal)).rejects.toMatchObject({ code: 'DOCKER_NOT_RESPONDING', params: { reason: 'needs-deep' } });
    expect(calls.some((c) => c[0] === 'wsl.exe')).toBe(false);
  });

  it("deep: forced stop, Docker's own WSL machine only (never --shutdown), then a start", async () => {
    const { e, calls, log } = desktopWorld();
    const progress: RestartProgress[] = [];
    expect((await e.restartDesktop(new AbortController().signal, (p) => progress.push(p), { deep: true })).state).toBe('running');
    const wsl = calls.filter((c) => c[0] === 'wsl.exe');
    expect(wsl).toEqual([['wsl.exe', '--terminate', DOCKER_WSL_DISTRO]]);
    expect(DOCKER_WSL_DISTRO).toBe('docker-desktop');
    expect(calls.flat().some((x) => /shutdown/i.test(x))).toBe(false);
    expect([...new Set(progress.map((p) => p.step))]).toEqual(['force-stop', 'wsl-terminate', 'start']);
    expect(progress.every((p) => p.steps === 3)).toBe(true);
    expect(log.entries.find((x) => x.msg === 'wsl --terminate docker-desktop failed')?.data).toMatchObject({ code: 1 });
    // A fake wsl from the endpoints, and nothing to run it with: skipped.
    const fake = desktopWorld();
    const viaFake = new DockerEnvironment({ ...(fake.e as unknown as { o: ConstructorParameters<typeof DockerEnvironment>[0] }).o, wsl: ['fake-wsl', '--x'] });
    await viaFake.restartDesktop(new AbortController().signal, undefined, { deep: true });
    expect(fake.calls.filter((c) => c[0] === 'fake-wsl')).toEqual([['fake-wsl', '--x', '--terminate', 'docker-desktop']]);
    const noProc = desktopWorld();
    const without = new DockerEnvironment({ ...(noProc.e as unknown as { o: ConstructorParameters<typeof DockerEnvironment>[0] }).o, proc: undefined });
    expect((await without.restartDesktop(new AbortController().signal, undefined, { deep: true })).state).toBe('running');
  });

  it('deep and still not back: restart-failed (restart the PC)', async () => {
    const { e } = desktopWorld({ comesBack: false });
    await expect(e.restartDesktop(new AbortController().signal, undefined, { deep: true })).rejects.toMatchObject({ params: { reason: 'restart-failed' } });
  });

  it('waits while Docker Desktop still says "starting" (its cache may answer first)', async () => {
    let status = 'starting';
    let n = 0;
    const { e } = env((a) => {
      if (a[0] === 'desktop' && a[1] === 'status') {
        if (++n > 2) status = 'running';
        return desktop(status);
      }
      return a[0] === 'desktop' ? ok() : running();
    });
    const progress: RestartProgress[] = [];
    await e.restartDesktop(new AbortController().signal, (p) => progress.push(p));
    expect(progress.filter((p) => p.state === 'starting').length).toBeGreaterThanOrEqual(2);
    expect(progress.at(-1)?.state).toBe('running');
  });

  it('old Docker Desktop (no CLI plugin): said plainly', async () => {
    await expect(desktopWorld({ restart: 'plugin' }).e.restartDesktop(new AbortController().signal)).rejects.toMatchObject({
      code: 'DOCKER_NOT_RESPONDING',
      params: { reason: 'no-desktop-cli' },
    });
  });

  it('Linux, not installed, no permission: refused', async () => {
    await expect(env(() => DOWN, { platform: 'linux' }).e.restartDesktop(new AbortController().signal)).rejects.toMatchObject({
      code: 'DOCKER_NOT_RESPONDING',
      params: { reason: 'manual-restart', platform: 'linux' },
    });
    await expect(env(() => fail(null, 'spawn docker ENOENT')).e.restartDesktop(new AbortController().signal)).rejects.toMatchObject({ code: 'DOCKER_NOT_INSTALLED' });
    await expect(env(() => fail(1, 'Got permission denied')).e.restartDesktop(new AbortController().signal)).rejects.toMatchObject({ code: 'DOCKER_PERMISSION' });
  });

  it('one restart at a time; a start asked meanwhile waits for it; "starting" while it runs; cancellable', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let up = false;
    const { e } = env(async (a) => {
      if (a[0] === 'desktop' && a[1] === 'restart') {
        await gate;
        up = true;
        return ok();
      }
      if (a[0] === 'desktop') return desktop('running');
      return up ? running() : DOWN;
    });
    const ac = new AbortController();
    const a = e.restartDesktop(ac.signal);
    expect(e.restartDesktop(ac.signal)).toBe(a);
    expect(e.startDesktop(ac.signal)).toBe(a);
    await settle();
    expect(e.busy()).toBe('restarting');
    expect(await e.status({ fresh: true })).toMatchObject({ state: 'starting', restarting: true });
    expect((await e.status({ fresh: true })).startingForMs).toBeGreaterThanOrEqual(0);
    release();
    expect((await a).state).toBe('running');

    const cancelled = env((x) => (x[0] === 'desktop' ? ok() : DOWN));
    const c = new AbortController();
    const p = cancelled.e.restartDesktop(c.signal, () => c.abort());
    await expect(p).rejects.toMatchObject({ code: 'CANCELLED' });
    const midCommand = env(async (x) => {
      if (x[0] === 'desktop' && x[1] === 'restart') {
        c2.abort();
        return ok();
      }
      return DOWN;
    });
    const c2 = new AbortController();
    await expect(midCommand.e.restartDesktop(c2.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    const midWsl = env(async (x, cmd) => {
      if (cmd === 'wsl.exe') c3.abort();
      return x[0] === 'desktop' ? ok() : DOWN;
    });
    const c3 = new AbortController();
    await expect(midWsl.e.restartDesktop(c3.signal, undefined, { deep: true })).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('forgets a stuck engine when the restart begins, and reports slow restarts', async () => {
    let up = false;
    const { e } = env(
      (a) => {
        if (a[0] === 'desktop' && a[1] === 'restart') {
          up = true;
          return ok();
        }
        if (a[0] === 'desktop') return desktop('running');
        return up ? running('Docker Engine - Community') : running('Docker Engine - Community');
      },
      { slowStartMs: -1 },
    );
    await e.status();
    e.reportHang();
    expect(e.peek()?.state).toBe('not-responding');
    const progress: RestartProgress[] = [];
    expect((await e.restartDesktop(new AbortController().signal, (p) => progress.push(p))).state).toBe('running');
    expect(progress.some((p) => p.slow)).toBe(true);
  });
});

describe('edges of probe and restart', () => {
  const bare = ok(JSON.stringify({ Client: { Version: '29.8.0' }, Server: { Version: '29.8.0', Os: 'linux' } }));

  it('a server without a platform name; a cancelled wait; unsubscribing; Docker Desktop on Linux', async () => {
    const plain = env((a) => (a[0] === 'version' ? bare : ok('')));
    const heard: string[] = [];
    const off = plain.e.onChange((s) => heard.push(s.state));
    off();
    expect((await plain.e.probe(new AbortController().signal)).state).toBe('running');
    expect(heard).toEqual([]);
    // Docker Desktop named, but not on Windows: its own status is never asked.
    const linux = env((a) => (a[0] === 'version' ? running() : ok('')), { platform: 'linux' });
    expect((await linux.e.probe()).state).toBe('running');
    // A probe cancelled while it waits out a "stopping": it still answers with what it knows.
    const ac = new AbortController();
    ac.abort();
    const stopping = env((a) => (a[0] === 'version' ? running() : a[0] === 'desktop' ? desktop('stopping') : ok('')));
    expect((await stopping.e.probe(ac.signal)).state).toBe('running');
  });

  it('a restart without a platform name; cancelled while waiting for Docker; a wait cut short', async () => {
    let up = false;
    const plain = env((a) => {
      if (a[0] === 'desktop') {
        up = true;
        return ok();
      }
      return up ? bare : DOWN;
    });
    expect((await plain.e.restartDesktop(new AbortController().signal)).state).toBe('running');
    const ac = new AbortController();
    const waiting = env((a) => (a[0] === 'desktop' ? ok() : DOWN), {
      clock: {
        ...steppingClock(),
        sleep: async () => {
          ac.abort();
          throw new DOMException('Aborted', 'AbortError');
        },
      },
    });
    await expect(waiting.e.restartDesktop(ac.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});

describe('a slow answer during our own start or restart', () => {
  it('is "starting", never the old "running" (the restart must not end early)', async () => {
    let calls = 0;
    const { e } = env((a) => {
      if (a[0] === 'desktop' && a[1] === 'status') return desktop('running');
      if (a[0] === 'desktop') return ok();
      calls++;
      // running (before, and the restart's first look), then a slow answer while it waits, then running again.
      return calls === 3 ? HUNG : running();
    });
    expect((await e.status()).state).toBe('running');
    const states: string[] = [];
    await e.restartDesktop(new AbortController().signal, (p) => states.push(p.state));
    expect(states.slice(0, 2)).toEqual(['starting', 'starting']);
    expect(states.at(-1)).toBe('running');

    let n = 0;
    const start = env((a) => (a[0] === 'desktop' ? ok() : ++n === 1 ? DOWN : n === 2 ? HUNG : running('Docker Engine - Community')));
    const progress: string[] = [];
    await start.e.startDesktop(new AbortController().signal, (p) => progress.push(p.state));
    expect(progress).toEqual(['starting', 'running']);
  });
});

describe('openDesktop', () => {
  it('runs Docker Desktop (its window comes up), only on Windows', async () => {
    const launched: string[] = [];
    const win = env(() => running(), { env: { LOCALAPPDATA: 'C:\\L' }, exists: async () => true, launchDetached: async (cmd) => void launched.push(cmd) });
    await win.e.openDesktop();
    expect(launched).toEqual(['C:\\L\\Programs\\DockerDesktop\\Docker Desktop.exe']);
    await expect(env(() => running(), { exists: async () => false }).e.openDesktop()).rejects.toMatchObject({ code: 'DOCKER_NOT_INSTALLED', params: { reason: 'desktop-not-found' } });
    await expect(env(() => running(), { platform: 'linux' }).e.openDesktop()).rejects.toMatchObject({ code: 'DOCKER_UNSUPPORTED' });
  });
});

describe('start that never ends', () => {
  it('still "stopped" at the time limit stays DOCKER_NOT_RUNNING (Docker Desktop may be waiting for the user)', async () => {
    const { e } = env((a) => (a[0] === 'desktop' ? ok() : DOWN), { startTimeoutMs: 1 });
    await expect(e.startDesktop(new AbortController().signal)).rejects.toMatchObject({ code: 'DOCKER_NOT_RUNNING', params: { reason: 'start-timeout' } });
    expect((await e.status({ fresh: true })).state).toBe('stopped');
  });
});
