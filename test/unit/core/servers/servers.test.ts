import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { StartServerRequest } from '../../../../src/contract/api';
import type { ServerPreset } from '../../../../src/contract/servers';
import type { ExitInfo } from '../../../../src/core/deps';
import type { EngineAdapter, EngineInstance, LaunchPlan } from '../../../../src/core/engines/types';
import { systemClock } from '../../../../src/core/node-deps';
import { ServerKeys } from '../../../../src/core/servers/api-key';
import { ServerNotices } from '../../../../src/core/servers/notices';
import { ServerPresets } from '../../../../src/core/servers/presets';
import { createServerRoutes } from '../../../../src/core/servers/routes';
import { modelLabelOf, ServeService, type ServeServiceDeps } from '../../../../src/core/servers/service';
import { AppError } from '../../../../src/contract/errors';
import { errorResponse } from '../../../../src/core/server/http-error';
import type { CoreContext } from '../../../../src/core/context';
import { fakePorts, tick } from './helpers';

function fakeInstance(opts: { failReady?: boolean; stopFails?: boolean; port: number; log?: string[] }) {
  let resolveExit!: (e: ExitInfo) => void;
  const exited = new Promise<ExitInfo>((r) => (resolveExit = r));
  let stopped = 0;
  const instance = {
    baseUrl: `http://127.0.0.1:${opts.port}`,
    t0: 0,
    logs: (async function* () {})(),
    waitReady: () => (opts.failReady ? Promise.reject(new Error('oom')) : Promise.resolve({ tReady: 1, phases: [] })),
    client: {} as never,
    stop: async () => {
      stopped++;
      if (opts.stopFails) throw new Error('already gone');
      resolveExit({ code: 0, signal: null });
      return { code: 0, signal: null };
    },
    exited,
    logTail: () => opts.log ?? [],
  } satisfies EngineInstance;
  return { instance, stopped: () => stopped, crash: () => resolveExit({ code: 1, signal: null }) };
}

/** settings.serverPresets in memory. */
function memoryStore(initial: ServerPreset[] = []) {
  let presets = initial;
  return {
    get: async () => ({ serverPresets: presets }),
    update: async (p: { serverPresets: ServerPreset[] }) => {
      presets = p.serverPresets;
    },
  };
}

interface SetupOptions {
  failReady?: boolean;
  stopFails?: boolean;
  build?: string;
  blocked?: AppError;
  contextSize?: number;
  apiName?: string;
  busy?: number[];
  vram?: (number | undefined)[];
  log?: string[];
  presets?: ServerPreset[];
  failModel?: string;
  /** prepare() waits for it (a start caught while it is being prepared). */
  gate?: Promise<void>;
}

function setup(opts: SetupOptions = {}) {
  const made: ReturnType<typeof fakeInstance>[] = [];
  const markers: string[] = [];
  const prepared: StartServerRequest[] = [];
  const notified: string[] = [];
  let changes = 0;
  const vram = [...(opts.vram ?? [])];
  const ports = fakePorts(opts.busy);
  const presets = new ServerPresets({ store: memoryStore(opts.presets), now: () => Date.UTC(2026, 9, 13) });
  const notices = new ServerNotices({ now: () => Date.UTC(2026, 9, 13) });
  const adapter = (port: number) =>
    ({
      kind: 'llamacpp-native',
      start: async () => {
        const f = fakeInstance({ ...opts, port });
        made.push(f);
        return f.instance;
      },
    }) as unknown as EngineAdapter;
  const deps: ServeServiceDeps = {
    clock: systemClock,
    prepare: async (req, marker) => {
      await opts.gate;
      // Like BenchService.prepareServer: external endpoints are already running.
      if (req.engine.kind === 'external') throw new AppError('VALIDATION', 'external', { params: { reason: 'external' } });
      if (opts.failModel !== undefined && req.model.localId === opts.failModel) throw new AppError('MODEL_NOT_FOUND', 'gone');
      markers.push(marker);
      prepared.push(req);
      const plan: LaunchPlan = {
        kind: 'llamacpp-native',
        argv: ['llama-server', '-m', 'm.gguf', '--port', String(req.port), '--api-key', 'secret-key-123'],
        env: { HF_TOKEN: 'hf_x' },
        host: '127.0.0.1',
        port: req.port as number,
        params: { contextSize: 8192, extraArgs: [], env: {} },
        engine: { kind: 'llamacpp-native', name: 'llama.cpp', ...(opts.build ? { build: opts.build } : { version: '1.0' }) },
        modelFiles: [],
        modelBytes: 0,
        marker,
      };
      return {
        model: { identity: { displayName: 'Qwen3 4B', format: 'gguf', source: 'local', files: [], weakKey: 'k', facts: { blockCount: 36 } } },
        adapter: adapter(req.port as number),
        launch: plan,
        ...(opts.contextSize ? { contextSize: opts.contextSize } : {}),
        ...(opts.apiName ? { apiName: opts.apiName } : {}),
      };
    },
    plan: async (req) => ({
      command: { argv: ['llama-server'], powershell: 'llama-server', bash: 'llama-server' },
      needs: [],
      params: { contextSize: 32768, extraArgs: [], env: {} },
      contextSize: 32768,
      warnings: [],
      port: req.port as number,
      network: req.network ?? 'local',
    }),
    blockedBy: () => opts.blocked,
    displayCommand: (argv) => ({ powershell: `& ${argv.join(' ')}`, bash: argv.join(' ') }),
    redact: (argv, env) => ({ argv: argv.map((a) => (a === 'secret-key-123' ? '<API_KEY>' : a)), env: { ...env, HF_TOKEN: '<HF_TOKEN>' } }),
    onChange: () => changes++,
    ports,
    lanUrls: (port) => [`http://192.168.1.20:${port}/v1`],
    secrets: () => ['secret-key-123'],
    vramUsedMiB: async () => vram.shift(),
    presets,
    notices,
    notify: (name) => notified.push(name),
  };
  return { svc: new ServeService(deps), deps, made, markers, prepared, notified, presets, notices, ports, changes: () => changes };
}

const req: StartServerRequest = { engine: { kind: 'llamacpp-native' }, model: { localId: 'a' } };
const signal = () => new AbortController().signal;

function preset(o: Partial<ServerPreset> = {}): ServerPreset {
  return {
    id: 'p1',
    name: 'Chat veloce',
    engine: { kind: 'llamacpp-native' },
    model: { localId: 'a' },
    modelLabel: 'Qwen3 4B · Q4_K_M',
    params: { contextSize: 16384, extraArgs: ['--mlock'], env: {} },
    port: 8090,
    network: 'local',
    autoStart: false,
    createdAt: '2026-10-13T00:00:00.000Z',
    updatedAt: '2026-10-13T00:00:00.000Z',
    ...o,
  };
}

describe('ServeService', () => {
  it('starts an engine on the first free port from 8080, says what it is, and stops it', async () => {
    const { svc, made, markers, changes } = setup({ build: 'b11438', contextSize: 32768, vram: [1000, 6000] });
    expect(svc.busy()).toBe(false);
    const info = await svc.start(req, signal());
    expect(info).toMatchObject({
      baseUrl: 'http://127.0.0.1:8080',
      openaiUrl: 'http://127.0.0.1:8080/v1',
      modelName: 'Qwen3 4B',
      modelLabel: 'Qwen3 4B',
      engineLabel: 'llama.cpp b11438',
      engineKind: 'llamacpp-native',
      contextSize: 32768,
      params: { contextSize: 8192 },
      blockCount: 36,
      port: 8080,
      network: 'local',
      lanUrls: [],
      // The request it was started with, its port included: "Riavvia" and "Salva come preset" reuse it.
      request: { ...req, port: 8080, network: 'local' },
      vramMiB: 5000,
      command: { argv: ['llama-server', '-m', 'm.gguf', '--port', '8080', '--api-key', '<API_KEY>'] },
    });
    // The server's id is the ownership marker its engine was prepared with.
    expect(info.id).toMatch(/^gpubench-/);
    expect(markers).toEqual([info.id]);
    expect(svc.busy()).toBe(true);
    expect(svc.list()).toEqual([info]);
    // Listed, then ready.
    expect(changes()).toBe(2);
    await svc.stop(info.id);
    expect(made[0]!.stopped()).toBe(1);
    expect(svc.list()).toEqual([]);
    // Stopped by us: the exit is not counted as another change.
    await tick();
    expect(changes()).toBe(3);
    await expect(svc.stop(info.id)).rejects.toMatchObject({ code: 'VALIDATION', params: { reason: 'not_found' } });
    // Other programs see the model's own name when the engine was given one.
    const named = await setup({ apiName: 'Qwen3-4B-Q4_K_M' }).svc.start(req, signal());
    expect(named.modelName).toBe('Qwen3-4B-Q4_K_M');
  });

  it('VRAM taken is said only when both readings exist and it grew', async () => {
    expect((await setup({ vram: [undefined, 5000] }).svc.start(req, signal())).vramMiB).toBeUndefined();
    expect((await setup({ vram: [5000, undefined] }).svc.start(req, signal())).vramMiB).toBeUndefined();
    expect((await setup({ vram: [5000, 4000] }).svc.start(req, signal())).vramMiB).toBeUndefined();
    // The GPU cannot be read: the server starts anyway.
    const blind = setup();
    blind.deps.vramUsedMiB = async () => {
      throw new Error('nvidia-smi gone');
    };
    expect((await new ServeService(blind.deps).start(req, signal())).vramMiB).toBeUndefined();
    const late = setup({ vram: [1000] });
    const reads = [async () => 1000, async () => Promise.reject(new Error('gone'))];
    late.deps.vramUsedMiB = () => reads.shift()!();
    expect((await new ServeService(late.deps).start(req, signal())).vramMiB).toBeUndefined();
  });

  it('ports: the next free one, a chosen one, never one in use by us or by another program', async () => {
    const { svc, prepared } = setup({ busy: [8080] });
    // The user's own llama-server holds 8080: the suggestion skips it.
    const a = await svc.start(req, signal());
    expect(a.port).toBe(8081);
    const b = await svc.start({ ...req, port: 9000 }, signal());
    expect(b.port).toBe(9000);
    expect(prepared.map((r) => r.port)).toEqual([8081, 9000]);
    await expect(svc.start({ ...req, port: 8080 }, signal())).rejects.toMatchObject({ code: 'ENGINE_PORT_IN_USE', params: { port: 8080, reason: 'port_taken' } });
    await expect(svc.start({ ...req, port: 9000 }, signal())).rejects.toMatchObject({ code: 'ENGINE_PORT_IN_USE', params: { port: 9000, reason: 'port_ours', model: 'Qwen3 4B' } });
    // Two starts at once never get the same port.
    const [c, d] = await Promise.all([svc.start(req, signal()), svc.start(req, signal())]);
    expect([c.port, d.port].sort()).toEqual([8082, 8083]);
  });

  it('plans with the port it would use, warns about a chosen one in use, and lists the network addresses', async () => {
    const { svc } = setup({ busy: [8085] });
    expect(await svc.plan(req)).toMatchObject({ port: 8080, network: 'local', contextSize: 32768, warnings: [] });
    expect(await svc.plan({ ...req, port: 8085 })).toMatchObject({ port: 8085, warnings: [{ code: 'port_taken', params: { port: 8085 } }] });
    await svc.start({ ...req, port: 8086 }, signal());
    expect(await svc.plan({ ...req, port: 8086 })).toMatchObject({ warnings: [{ code: 'port_ours', params: { port: 8086, model: 'Qwen3 4B' } }] });
    const lan = await svc.plan({ ...req, port: 8087, network: 'lan' });
    expect(lan).toMatchObject({ network: 'lan', lanUrls: ['http://192.168.1.20:8087/v1'] });
    expect((await svc.plan(req)).lanUrls).toBeUndefined();
  });

  it('a port being prepared by another start is ours too', async () => {
    let open!: () => void;
    const { svc } = setup({ gate: new Promise<void>((r) => (open = r)) });
    const pending = svc.start({ ...req, port: 8088 }, signal());
    await tick();
    const planned = svc.plan({ ...req, port: 8088 });
    await expect(svc.start({ ...req, port: 8088 }, signal())).rejects.toMatchObject({ params: { reason: 'port_ours' } });
    open();
    expect((await planned).warnings).toEqual([{ code: 'port_ours', params: { port: 8088, model: '' } }]);
    await pending;
  });

  it('a server shared on the local network lists the addresses other devices use', async () => {
    const info = await setup().svc.start({ ...req, network: 'lan' }, signal());
    expect(info).toMatchObject({ network: 'lan', lanUrls: ['http://192.168.1.20:8080/v1'], request: { network: 'lan', port: 8080 } });
  });

  it('refuses to start while a benchmark runs', async () => {
    const { svc, made, markers } = setup({ blocked: new AppError('RUN_IN_PROGRESS', 'busy', { params: { runId: 'r1' } }) });
    await expect(svc.start(req, signal())).rejects.toMatchObject({ code: 'RUN_IN_PROGRESS', params: { runId: 'r1' } });
    expect(made).toEqual([]);
    expect(markers).toEqual([]);
  });

  it('forgets an engine that exits on its own, and stops everything at shutdown', async () => {
    const { svc, made, changes } = setup();
    const a = await svc.start(req, signal());
    expect(a.engineLabel).toBe('llama.cpp 1.0');
    expect(a.contextSize).toBeUndefined();
    made[0]!.crash();
    await tick();
    expect(svc.list()).toEqual([]);
    expect(changes()).toBe(3);
    await svc.start(req, signal());
    await svc.start(req, signal());
    await svc.stopAll();
    expect(made.slice(1).map((m) => m.stopped())).toEqual([1, 1]);
    expect(svc.busy()).toBe(false);
  });

  it('stops the engine when it never gets ready, and refuses external endpoints', async () => {
    const { svc, made } = setup({ failReady: true });
    await expect(svc.start(req, signal())).rejects.toThrow('oom');
    expect(made[0]!.stopped()).toBe(1);
    await expect(svc.start({ engine: { kind: 'external', baseUrl: 'http://h:1' }, model: {} }, signal())).rejects.toMatchObject({
      code: 'VALIDATION',
      params: { reason: 'external' },
    });
    // The port of a failed start is free again.
    expect(svc.list()).toEqual([]);
  });

  it('Riavvia: the same request on the same port, a new engine', async () => {
    const { svc, made, prepared } = setup();
    const a = await svc.start({ ...req, port: 8095, network: 'lan' }, signal());
    const b = await svc.restart(a.id, signal());
    expect(made[0]!.stopped()).toBe(1);
    expect(b.id).not.toBe(a.id);
    expect(b).toMatchObject({ port: 8095, network: 'lan' });
    expect(prepared[1]).toEqual(prepared[0]);
    expect(svc.list()).toEqual([b]);
    await expect(svc.restart('nope', signal())).rejects.toMatchObject({ params: { reason: 'not_found' } });
  });

  it('the log of a server, with every API key hidden', async () => {
    const { svc } = setup({ log: ["non-default args: {'api_key': ['secret-key-123']}", 'srv  listening'] });
    const a = await svc.start(req, signal());
    expect(svc.log(a.id)).toEqual({ lines: ["non-default args: {'api_key': ['<API_KEY>']}", 'srv  listening'] });
    expect(() => svc.log('nope')).toThrow(AppError);
  });

  it('settled() waits for the engines being stopped', async () => {
    const { svc } = setup();
    const a = await svc.start(req, signal());
    const stopping = svc.stop(a.id);
    await svc.settled();
    await stopping;
    await expect(svc.settled()).resolves.toBeUndefined();
  });
});

describe('model label', () => {
  it('the model\'s own name and its quantization, once', () => {
    expect(modelLabelOf({ displayName: 'qwen3-8b-q4_k_m', quant: 'Q4_K_M', facts: { name: 'Qwen3 8B' } })).toBe('Qwen3 8B · Q4_K_M');
    expect(modelLabelOf({ displayName: 'Qwen3-8B-Q4_K_M', quant: 'Q4_K_M' })).toBe('Qwen3-8B-Q4_K_M');
    expect(modelLabelOf({ displayName: 'Qwen/Qwen3-8B' })).toBe('Qwen/Qwen3-8B');
  });
});

describe('ServeService with presets', () => {
  it('starts a preset with its port and name, once at a time', async () => {
    const { svc, prepared } = setup({ presets: [preset()] });
    const info = await svc.startPreset('p1', signal());
    expect(info).toMatchObject({ port: 8090, presetId: 'p1', presetName: 'Chat veloce' });
    expect(prepared[0]).toMatchObject({ params: { contextSize: 16384, extraArgs: ['--mlock'] }, port: 8090, network: 'local', presetId: 'p1' });
    await expect(svc.startPreset('p1', signal())).rejects.toMatchObject({ code: 'VALIDATION', params: { reason: 'preset_running' } });
    await expect(svc.startPreset('nope', signal())).rejects.toMatchObject({ params: { reason: 'preset_not_found' } });
    // Restarting keeps the preset.
    expect(await svc.restart(info.id, signal())).toMatchObject({ presetId: 'p1', presetName: 'Chat veloce', port: 8090 });
  });

  it('a preset deleted while its server starts is shown without a name', async () => {
    const { svc, presets } = setup({ presets: [preset()] });
    const started = svc.start({ ...req, presetId: 'p1' }, signal());
    await presets.remove('p1');
    expect((await started).presetName).toBeUndefined();
  });

  it('unattended starts: a failure is a notice and a notification; a running preset is left alone', async () => {
    const { svc, notices, notified } = setup({ presets: [preset(), preset({ id: 'p2', name: 'Rotto', model: { localId: 'gone' }, port: 8091 })], failModel: 'gone' });
    expect(await svc.startUnattended('p2', 'tray-start-failed', signal())).toBeUndefined();
    expect(notices.list()).toEqual([expect.objectContaining({ kind: 'tray-start-failed', presetId: 'p2', name: 'Rotto', error: expect.objectContaining({ code: 'MODEL_NOT_FOUND' }) })]);
    expect(notified).toEqual(['Rotto']);
    const ok = await svc.startUnattended('p1', 'tray-start-failed', signal());
    expect(ok?.presetId).toBe('p1');
    expect(await svc.startUnattended('p1', 'tray-start-failed', signal())).toBeUndefined();
    expect(await svc.startUnattended('missing', 'tray-start-failed', signal())).toBeUndefined();
    // A cancelled start (the app quitting) is not a failure to report.
    const quitting = new AbortController();
    quitting.abort();
    expect(await svc.startUnattended('p2', 'autostart-failed', quitting.signal)).toBeUndefined();
    expect(notices.list()).toHaveLength(1);
  });

  it('a preset that starts fine clears its old failure', async () => {
    const { svc, notices } = setup({ presets: [preset()] });
    notices.add('autostart-failed', { id: 'p1', name: 'Chat veloce' }, new Error('x'));
    await svc.startPreset('p1', signal());
    expect(notices.list()).toEqual([]);
  });

  it('"Avvia all\'apertura": every marked preset, one after the other; stops when the app quits', async () => {
    const marked = [preset({ autoStart: true }), preset({ id: 'p2', name: 'Secondo', autoStart: true, port: 8091 }), preset({ id: 'p3', name: 'No', port: 8092 })];
    const { svc } = setup({ presets: marked });
    await svc.autoStart(signal());
    expect(svc.list().map((s) => s.presetName)).toEqual(['Chat veloce', 'Secondo']);
    const quit = setup({ presets: marked });
    const c = new AbortController();
    c.abort();
    await quit.svc.autoStart(c.signal);
    expect(quit.svc.list()).toEqual([]);
  });

  it('without presets there is nothing to start', async () => {
    const { presets: _p, notices: _n, notify: _f, ...rest } = setup().deps;
    const bare = new ServeService(rest);
    await expect(bare.startPreset('p1', signal())).rejects.toMatchObject({ params: { reason: 'preset_not_found' } });
    expect(await bare.startUnattended('p1', 'tray-start-failed', signal())).toBeUndefined();
    await bare.autoStart(signal());
    expect(bare.list()).toEqual([]);
  });
});

describe('ServeService when stopping fails', () => {
  it('still reports the start failure and never throws from stopAll', async () => {
    const failing = setup({ failReady: true, stopFails: true });
    await expect(failing.svc.start(req, signal())).rejects.toThrow('oom');
    const stuck = setup({ stopFails: true });
    await stuck.svc.start(req, signal());
    await expect(stuck.svc.stopAll()).resolves.toBeUndefined();
    expect(stuck.svc.busy()).toBe(false);
  });
});

describe('server routes', () => {
  function app(o: SetupOptions = {}) {
    const s = setup(o);
    const keys = new ServerKeys({ random: (n) => Buffer.alloc(n, 7) });
    let changed = 0;
    const shutdown = new AbortController();
    const hono = new Hono();
    hono.onError((e, c) => errorResponse(c, e));
    createServerRoutes({ serve: s.svc, presets: s.presets, keys, notices: s.notices, changed: () => changed++ })(hono, { shutdown: shutdown.signal } as CoreContext);
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await hono.request(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> & unknown[] };
    };
    return { ...s, call, shutdown, changed: () => changed };
  }

  it('lists, plans, starts, restarts, reads the log of and stops servers; stops them on shutdown', async () => {
    const { call, svc, shutdown } = app();
    expect((await call('GET', '/api/servers')).body).toEqual([]);
    const info = (await call('POST', '/api/servers', req)).body as unknown as { id: string };
    expect(info.id).toMatch(/^gpubench-/);
    expect((await call('GET', `/api/servers/${info.id}/log`)).body).toEqual({ lines: [] });
    const again = (await call('POST', `/api/servers/${info.id}/restart`)).body as unknown as { id: string; port: number };
    expect(again.port).toBe(8080);
    expect((await call('DELETE', `/api/servers/${again.id}`)).body).toEqual({ ok: true });
    expect((await call('DELETE', '/api/servers/nope')).status).toBe(400);
    expect((await call('POST', '/api/servers/plan', req)).body).toMatchObject({ contextSize: 32768, port: 8080 });
    expect((await call('POST', '/api/servers/plan', { model: {} })).status).toBe(400);
    expect((await call('POST', '/api/servers/plan', { ...req, port: 80 })).status).toBe(400);
    await call('POST', '/api/servers', req);
    shutdown.abort();
    await tick();
    expect(svc.busy()).toBe(false);
  });

  it('presets: save, change, start, remove; the UI and the tray hear about it', async () => {
    const { call, changed } = app();
    const input = { name: 'Chat', engine: { kind: 'llamacpp-native' }, model: { localId: 'a' }, modelLabel: 'Qwen3 4B', params: { contextSize: 8192 }, port: 8100 };
    const saved = (await call('POST', '/api/servers/presets', input)).body as unknown as ServerPreset;
    expect(saved).toMatchObject({ name: 'Chat', port: 8100, network: 'local', autoStart: false });
    expect((await call('PUT', `/api/servers/presets/${saved.id}`, { autoStart: true })).body).toMatchObject({ autoStart: true });
    expect((await call('GET', '/api/servers/presets')).body).toHaveLength(1);
    expect((await call('POST', `/api/servers/presets/${saved.id}/start`)).body).toMatchObject({ port: 8100, presetName: 'Chat' });
    expect((await call('DELETE', `/api/servers/presets/${saved.id}`)).body).toEqual({ ok: true });
    expect(changed()).toBe(3);
    expect((await call('POST', '/api/servers/presets', { name: '' })).status).toBe(400);
    expect((await call('PUT', '/api/servers/presets/nope', {})).status).toBe(400);
  });

  it('the API key and the notices', async () => {
    const { call, notices } = app();
    const key = (await call('GET', '/api/servers/api-key')).body;
    expect(key).toEqual({ key: `gpub-${Buffer.alloc(24, 7).toString('base64url')}`, storage: 'memory' });
    expect((await call('GET', '/api/servers/api-key')).body).toEqual(key);
    expect((await call('POST', '/api/servers/api-key/regenerate')).body).toMatchObject({ storage: 'memory' });
    const n = notices.add('autostart-failed', { id: 'p1', name: 'Chat' }, new AppError('MODEL_NOT_FOUND', 'gone'));
    expect((await call('GET', '/api/servers/notices')).body).toEqual([n]);
    expect((await call('DELETE', `/api/servers/notices/${n.id}`)).body).toEqual({ ok: true });
    expect((await call('GET', '/api/servers/notices')).body).toEqual([]);
  });
});
