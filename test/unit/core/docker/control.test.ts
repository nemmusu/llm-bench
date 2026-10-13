import { describe, expect, it } from 'vitest';
import type { ServerInfo, StartServerRequest } from '../../../../src/contract/api';
import { AppError } from '../../../../src/contract/errors';
import type { ServerEvent } from '../../../../src/contract/events';
import type { ServerNotice } from '../../../../src/contract/servers';
import type { Clock } from '../../../../src/core/deps';
import { DockerControl, type DockerControlDeps } from '../../../../src/core/docker/control';
import type { DockerEnvironment, DockerStatusDetail, RestartProgress, StartProgress } from '../../../../src/core/docker/environment';
import { recordingLog, steppingClock } from './helpers';

type Ev = ServerEvent & Record<string, unknown>;
const tick = () => new Promise((r) => setTimeout(r, 5));

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

function server(id: string, kind: ServerInfo['engineKind'], over: Partial<ServerInfo> = {}): ServerInfo {
  const request: StartServerRequest = { engine: { kind }, model: { localId: 'm' }, port: 8080, network: 'local' } as StartServerRequest;
  return {
    id,
    baseUrl: 'http://127.0.0.1:8080',
    openaiUrl: 'http://127.0.0.1:8080/v1',
    modelName: 'm',
    modelLabel: `Model ${id}`,
    engineLabel: 'vLLM v0.12',
    engineKind: kind,
    startedAt: '2026-10-13T10:00:00.000Z',
    command: { argv: [], powershell: '', bash: '' },
    params: {},
    port: 8080,
    network: 'local',
    lanUrls: [],
    request,
    ...over,
  } as ServerInfo;
}

/** A DockerEnvironment stand-in: its state, its start and restart as the test says. */
function fakeEnv(o: { state?: DockerStatusDetail['state']; platform?: string } = {}) {
  const listeners = new Set<(s: DockerStatusDetail) => void>();
  let current: DockerStatusDetail | undefined = o.state ? { state: o.state } : undefined;
  const calls: string[] = [];
  const env = {
    platform: o.platform ?? 'win32',
    peek: () => current,
    onChange: (fn: (s: DockerStatusDetail) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    status: async () => {
      calls.push('status');
      return current ?? { state: 'unknown' };
    },
    probe: async () => {
      calls.push('probe');
      return current ?? { state: 'unknown' };
    },
    startDesktop: async (_s: AbortSignal, on?: (p: StartProgress) => void): Promise<DockerStatusDetail> => {
      on?.({ state: 'starting', elapsedMs: 1200, slow: false, method: 'cli' });
      return { state: 'running' };
    },
    restartDesktop: async (_s: AbortSignal, on?: (p: RestartProgress) => void, opts?: { deep?: boolean }): Promise<DockerStatusDetail> => {
      calls.push(`restart:${opts?.deep === true}`);
      on?.({ step: 'restart', index: 1, steps: 3, elapsedMs: 500, state: 'starting', slow: false });
      return { state: 'running' };
    },
  };
  const set = (s: DockerStatusDetail['state']) => {
    current = { state: s };
    for (const fn of listeners) fn(current);
  };
  return { env: env as unknown as DockerEnvironment & typeof env, set, calls };
}

function setup(over: Partial<DockerControlDeps> = {}, envOver: Partial<ReturnType<typeof fakeEnv>['env']> = {}, o: Parameters<typeof fakeEnv>[0] = {}) {
  const events: Ev[] = [];
  const fe = fakeEnv(o);
  Object.assign(fe.env, envOver);
  let servers: ServerInfo[] = [];
  const started: StartServerRequest[] = [];
  const stopped: string[] = [];
  const notices: { kind: ServerNotice['kind']; preset: { id?: string; name: string } }[] = [];
  let resets = 0;
  const shutdown = new AbortController();
  const log = recordingLog();
  const deps: DockerControlDeps = {
    env: fe.env,
    publish: (e) => events.push(e as Ev),
    servers: {
      list: () => servers,
      start: async (req) => {
        started.push(req);
        if ((req as { fail?: boolean }).fail) throw new AppError('ENGINE_START_FAILED', 'no');
        const s = server(`new-${started.length}`, req.engine.kind);
        servers = [...servers, s];
        return s;
      },
      stop: async (id) => {
        stopped.push(id);
        servers = servers.filter((s) => s.id !== id);
      },
    },
    notices: { add: (kind, preset) => void notices.push({ kind, preset }) },
    resetApi: () => void resets++,
    clock: steppingClock(),
    log,
    shutdown: shutdown.signal,
    ...over,
  };
  const c = new DockerControl(deps);
  return {
    c,
    events,
    fe,
    started,
    stopped,
    notices,
    log,
    shutdown,
    resets: () => resets,
    setServers: (s: ServerInfo[]) => (servers = s),
    stages: (kind: string) => events.filter((e) => e.type === 'engine.install' && e.kind === kind).map((e) => e.stage),
  };
}

describe('DockerControl: state for the tray and the screens', () => {
  it('says every state change (docker.changed) and tells its subscribers; nothing to say before a state is known', () => {
    const t = setup();
    const heard: number[] = [];
    const off = t.c.subscribe(() => heard.push(1));
    expect(t.c.shell()).toBeUndefined();
    t.fe.set('not-responding');
    expect(t.events).toEqual([{ type: 'docker.changed', state: 'not-responding' }]);
    expect(t.c.shell()).toEqual({ state: 'not-responding', control: true });
    off();
    t.fe.set('running');
    expect(heard).toEqual([1]);
    expect(setup({}, {}, { state: 'stopped', platform: 'linux' }).c.shell()).toEqual({ state: 'stopped', control: false });
  });
});

describe('DockerControl.start', () => {
  it('starts once, with progress; forgets the API endpoint chosen before; says "starting" meanwhile', async () => {
    const gate = deferred<DockerStatusDetail>();
    const t = setup({}, { startDesktop: async (_s: AbortSignal, on?: (p: StartProgress) => void) => (on?.({ state: 'starting', elapsedMs: 61_000, slow: true, method: 'exe' }), gate.promise) }, { state: 'stopped' });
    expect(t.c.start()).toBe(true);
    expect(t.c.start()).toBe(false);
    expect(t.c.shell()).toEqual({ state: 'stopped', busy: 'starting', control: true });
    gate.resolve({ state: 'running' });
    await tick();
    expect(t.events.filter((e) => e.kind === 'docker-desktop')).toEqual([
      { type: 'engine.install', kind: 'docker-desktop', stage: 'starting', bytesDone: 61_000, state: 'starting', slow: true },
      { type: 'engine.install', kind: 'docker-desktop', stage: 'running', bytesDone: 0, state: 'running' },
    ]);
    expect(t.resets()).toBe(1);
    expect(t.c.shell()?.busy).toBeUndefined();
  });

  it('a failed start is an event; no start while a restart runs', async () => {
    const t = setup({}, { startDesktop: async () => Promise.reject(new AppError('DOCKER_NOT_RUNNING', 'timeout', { params: { reason: 'start-timeout' } })) });
    t.c.start();
    await tick();
    expect(t.events.at(-1)).toMatchObject({ kind: 'docker-desktop', stage: 'error', error: { code: 'DOCKER_NOT_RUNNING' } });
    const gate = deferred<DockerStatusDetail>();
    const r = setup({}, { restartDesktop: async () => gate.promise });
    expect(r.c.restart()).toBe(true);
    expect(r.c.start()).toBe(false);
    gate.resolve({ state: 'running' });
    await tick();
  });
});

describe('DockerControl.restart', () => {
  it('restarts, then starts our Docker servers again (same request); others are never touched', async () => {
    const t = setup({}, {}, { state: 'not-responding' });
    t.setServers([server('a', 'vllm-docker', { presetName: 'Chat' }), server('b', 'llamacpp-native'), server('c', 'sglang-docker')]);
    expect(t.c.restart()).toBe(true);
    expect(t.c.restart()).toBe(false);
    expect(t.c.shell()?.busy).toBe('restarting');
    await tick();
    expect(t.fe.calls).toContain('restart:false');
    expect(t.stopped).toEqual(['a', 'c']);
    expect(t.started.map((r) => r.engine.kind)).toEqual(['vllm-docker', 'sglang-docker']);
    const install = t.events.filter((e) => e.kind === 'docker-restart');
    expect(install[0]).toMatchObject({ stage: 'restart', step: 1, steps: 4, bytesDone: 500, state: 'starting', slow: false });
    expect(install.filter((e) => e.stage === 'servers').map((e) => [e.label, e.bytesDone, e.bytesTotal])).toEqual([
      ['Chat', 0, 2],
      ['Model c', 1, 2],
    ]);
    expect(install.at(-1)).toMatchObject({ stage: 'running', state: 'running', result: { restored: ['Chat', 'Model c'], failed: [] } });
    expect(t.resets()).toBe(1);
    expect(t.c.recovery()).toEqual({ servers: [], restoring: false });
    expect(t.c.shell()?.busy).toBeUndefined();
  });

  it('deep, and a server that does not start again: a notice, and the result says so', async () => {
    const t = setup({}, {}, { state: 'not-responding' });
    const s = server('a', 'vllm-docker', { presetId: 'p1', presetName: 'Chat' });
    const plain = server('y', 'vllm-docker');
    t.setServers([{ ...s, request: { ...s.request, fail: true } as StartServerRequest }, server('x', 'sglang-docker'), { ...plain, request: { ...plain.request, fail: true } as StartServerRequest }]);
    t.c.restart({ deep: true });
    await tick();
    expect(t.fe.calls).toContain('restart:true');
    expect(t.events.at(-1)).toMatchObject({ stage: 'running', result: { restored: ['Model x'], failed: ['Chat', 'Model y'] } });
    expect(t.notices).toEqual([
      { kind: 'docker-restore-failed', preset: { id: 'p1', name: 'Chat' } },
      { kind: 'docker-restore-failed', preset: { name: 'Model y' } },
    ]);
    expect(t.log.entries.find((x) => x.msg === 'server not started again after Docker came back')?.data).toEqual({ name: 'Chat', error: 'ENGINE_START_FAILED' });
  });

  it('a server whose old engine cannot be stopped is still started; without notices a failure is only logged', async () => {
    const t = setup({ notices: undefined }, {}, { state: 'not-responding' });
    const s = server('a', 'vllm-docker');
    t.setServers([s, { ...server('b', 'vllm-docker'), request: { ...s.request, fail: true } as StartServerRequest }]);
    const deps = (t.c as unknown as { o: DockerControlDeps }).o;
    const stop = deps.servers.stop;
    deps.servers.stop = async (id) => {
      await stop(id);
      throw new Error('already gone');
    };
    t.c.restart();
    await tick();
    expect(t.events.at(-1)).toMatchObject({ stage: 'running', result: { restored: ['Model a'], failed: ['Model b'] } });
    expect(t.notices).toEqual([]);
  });

  it('no servers: no extra step; a failed restart is an event and the servers stay to be started later', async () => {
    const none = setup();
    none.c.restart();
    await tick();
    expect(none.events.find((e) => e.stage === 'restart')).toMatchObject({ steps: 3 });
    const t = setup({}, { restartDesktop: async () => Promise.reject(new AppError('DOCKER_NOT_RESPONDING', 'still stuck', { params: { reason: 'needs-deep' } })) }, { state: 'not-responding' });
    t.setServers([server('a', 'vllm-docker')]);
    t.c.restart();
    await tick();
    expect(t.events.at(-1)).toMatchObject({ kind: 'docker-restart', stage: 'error', error: { code: 'DOCKER_NOT_RESPONDING', params: { reason: 'needs-deep' } } });
    expect(t.c.recovery().servers).toEqual([{ id: 'a', name: 'Model a', port: 8080 }]);
    // Again: a server lost before and still listed is started once.
    t.c.restart();
    await tick();
    expect(t.c.recovery().servers).toHaveLength(1);
  });
});

describe('servers Docker took down', () => {
  it('a Docker server that ended while Docker is not up is remembered; one ended by itself, or not in Docker, is not', async () => {
    const t = setup({}, {}, { state: 'running' });
    await t.c.serverEnded(server('ok', 'vllm-docker'));
    await t.c.serverEnded(server('native', 'llamacpp-native'));
    expect(t.c.recovery().servers).toEqual([]);
    t.fe.set('stopped');
    await t.c.serverEnded(server('a', 'vllm-docker', { presetId: 'p1', presetName: 'Chat', port: 8090 }));
    await t.c.serverEnded(server('a', 'vllm-docker', { presetId: 'p1', presetName: 'Chat', port: 8090 }));
    expect(t.c.recovery()).toEqual({ servers: [{ id: 'a', name: 'Chat', port: 8090, presetId: 'p1' }], restoring: false });
    const broken = setup({}, { status: async () => Promise.reject(new Error('x')) });
    await broken.c.serverEnded(server('b', 'sglang-docker'));
    expect(broken.c.recovery().servers).toHaveLength(1);
  });

  it('"Riavvia i server che erano attivi" starts them again; "Non ora" forgets them', async () => {
    const t = setup({}, {}, { state: 'stopped' });
    expect(t.c.restore()).toBe(false);
    await t.c.serverEnded(server('a', 'vllm-docker'));
    t.fe.set('running');
    expect(t.c.restore()).toBe(true);
    expect(t.c.recovery().restoring).toBe(true);
    expect(t.c.restore()).toBe(false);
    await tick();
    expect(t.started).toHaveLength(1);
    expect(t.events.at(-1)).toMatchObject({ kind: 'docker-restart', stage: 'running', result: { restored: ['Model a'], failed: [] } });
    expect(t.c.recovery()).toEqual({ servers: [], restoring: false });
    t.fe.set('stopped');
    await t.c.serverEnded(server('b', 'vllm-docker'));
    t.c.forget();
    expect(t.c.recovery().servers).toEqual([]);
    expect(t.events.at(-1)).toEqual({ type: 'docker.changed', state: 'stopped' });
    // Nothing known about Docker yet: nothing to say.
    const quiet = setup();
    quiet.c.forget();
    expect(quiet.events).toEqual([]);
  });

  it("a restart's own servers ending meanwhile are not lost", async () => {
    const gate = deferred<DockerStatusDetail>();
    const t = setup({}, { restartDesktop: async () => gate.promise }, { state: 'not-responding' });
    const a = server('a', 'vllm-docker');
    t.setServers([a]);
    t.c.restart();
    await t.c.serverEnded(a);
    expect(t.c.recovery().servers).toEqual([]);
    gate.resolve({ state: 'running' });
    await tick();
  });
});

describe('the watchdog', () => {
  it('in use (our Docker servers or a Docker run): a real check, and the tray told once per incident', async () => {
    const t = setup({}, {}, { state: 'not-responding' });
    const told: number[] = [];
    const off = t.c.onStuck(() => told.push(1));
    expect(t.c.inUse()).toBe(false);
    await t.c.tick();
    expect(t.fe.calls).toEqual(['status']);
    expect(told).toEqual([]);
    t.setServers([server('a', 'vllm-docker')]);
    expect(t.c.inUse()).toBe(true);
    await t.c.tick();
    await t.c.tick();
    expect(t.fe.calls.slice(1)).toEqual(['probe', 'probe']);
    expect(told).toEqual([1]);
    t.fe.set('running');
    t.fe.set('not-responding');
    await t.c.tick();
    expect(told).toEqual([1, 1]);
    off();
    const run = setup({ dockerRunActive: () => true });
    expect(run.c.inUse()).toBe(true);
  });

  it('looks every activeEveryMs while in use or changing, else every idleEveryMs, until shutdown; a failing look is logged', async () => {
    const asked: number[] = [];
    const shutdown = new AbortController();
    let n = 0;
    const clock: Clock = {
      now: () => 0,
      wall: () => 0,
      sleep: async (ms: number) => {
        asked.push(ms);
        if (++n >= 4) shutdown.abort();
      },
    };
    const t = setup({ clock, shutdown: shutdown.signal, activeEveryMs: 5, idleEveryMs: 50 }, { status: async () => Promise.reject(new Error('boom')) }, { state: 'running' });
    t.c.watch();
    await tick();
    expect(asked).toEqual([50, 50, 50, 50]);
    expect(t.log.entries.filter((x) => x.msg === 'docker watchdog failed')).toHaveLength(3);

    const busy = new AbortController();
    const seen: number[] = [];
    const states: DockerStatusDetail['state'][] = ['starting', 'not-responding', 'running'];
    const b = setup({
      shutdown: busy.signal,
      clock: {
        now: () => 0,
        wall: () => 0,
        sleep: async (ms: number) => {
          seen.push(ms);
          const next = states.shift();
          if (next) b.fe.set(next);
          else busy.abort();
        },
      },
    }, {}, { state: 'running' });
    b.setServers([]);
    b.c.watch();
    await tick();
    // Default periods: 60 s idle; 20 s while starting or not responding.
    expect(seen).toEqual([60_000, 20_000, 20_000, 60_000]);

    const aborted = new AbortController();
    aborted.abort();
    const a = setup({ shutdown: aborted.signal });
    a.c.watch();
    await tick();
    expect(a.fe.calls).toEqual([]);

    // The real clock's sleep rejects when shut down mid-wait: the loop just ends.
    const mid = new AbortController();
    const m = setup({
      shutdown: mid.signal,
      clock: {
        now: () => 0,
        wall: () => 0,
        sleep: async () => {
          mid.abort();
          throw new DOMException('Aborted', 'AbortError');
        },
      },
    });
    m.c.watch();
    await tick();
    expect(m.fe.calls).toEqual([]);
  });
});
