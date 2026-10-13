import { describe, expect, it, vi } from 'vitest';
import type { ServerInfo } from '../../../../src/contract/api';
import type { ServerEvent } from '../../../../src/contract/events';
import type { ServerPreset } from '../../../../src/contract/servers';
import { defaultSettings, type Settings } from '../../../../src/contract/settings';
import { ServerKeys } from '../../../../src/core/servers/api-key';
import { ServerNotices } from '../../../../src/core/servers/notices';
import type { ServeService } from '../../../../src/core/servers/service';
import { attachShell, shellStateOf } from '../../../../src/core/servers/shell-link';
import { tick } from './helpers';

function server(o: Partial<ServerInfo> = {}): ServerInfo {
  return {
    id: 'gpubench-1',
    baseUrl: 'http://127.0.0.1:8080',
    openaiUrl: 'http://127.0.0.1:8080/v1',
    modelName: 'Qwen3-8B-Q4_K_M',
    modelLabel: 'Qwen3 8B',
    engineLabel: 'llama.cpp b11460',
    engineKind: 'llamacpp-native',
    startedAt: '2026-10-13T10:00:00.000Z',
    command: { argv: [], powershell: '', bash: '' },
    params: { extraArgs: [], env: {} },
    port: 8080,
    network: 'local',
    lanUrls: [],
    request: { engine: { kind: 'llamacpp-native' }, model: { localId: 'a' }, port: 8080 },
    ...o,
  };
}

const preset = (id: string, name: string, port?: number): ServerPreset => ({
  id,
  name,
  engine: { kind: 'llamacpp-native' },
  model: { localId: 'a' },
  modelLabel: 'Qwen3 8B',
  params: { extraArgs: [], env: {} },
  ...(port !== undefined ? { port } : {}),
  network: 'local',
  autoStart: false,
  createdAt: 'x',
  updatedAt: 'x',
});

describe('the tray state', () => {
  it('servers (loading or ready, the network address when shared), presets (running or not), close behaviour, language', () => {
    const state = shellStateOf(
      [
        server({ presetId: 'p1', presetName: 'Chat' }),
        server({ id: 'gpubench-2', port: 8081, network: 'lan', lanUrls: ['http://192.168.1.20:8081/v1'], loading: { stage: 'weights', elapsedMs: 10 } as ServerInfo['loading'] }),
        server({ id: 'gpubench-3', port: 8082, network: 'lan', lanUrls: [] }),
      ],
      [preset('p1', 'Chat', 8080), preset('p2', 'Altro')],
      { ...defaultSettings(), closeBehavior: 'quit', launchAtLogin: true, language: 'en' },
    );
    expect(state).toEqual({
      servers: [
        { id: 'gpubench-1', modelName: 'Qwen3 8B', port: 8080, url: 'http://127.0.0.1:8080/v1', status: 'ready', network: 'local', presetName: 'Chat' },
        { id: 'gpubench-2', modelName: 'Qwen3 8B', port: 8081, url: 'http://192.168.1.20:8081/v1', status: 'loading', network: 'lan' },
        { id: 'gpubench-3', modelName: 'Qwen3 8B', port: 8082, url: 'http://127.0.0.1:8080/v1', status: 'ready', network: 'lan' },
      ],
      presets: [
        { id: 'p1', name: 'Chat', port: 8080, running: true },
        { id: 'p2', name: 'Altro', running: false },
      ],
      closeBehavior: 'quit',
      launchAtLogin: true,
      language: 'en',
    });
  });
});

function link(o: { servers?: ServerInfo[]; presets?: ServerPreset[] } = {}) {
  const posted: unknown[] = [];
  let onMessage!: (e: { data: unknown }) => void;
  const hubListeners = new Set<(e: ServerEvent) => void>();
  const settingsListeners = new Set<() => void>();
  let settings: Settings = defaultSettings();
  const servers = o.servers ?? [];
  const serve = {
    list: () => servers,
    autoStart: vi.fn(async () => undefined),
    stopAll: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    restart: vi.fn(async () => server()),
    startUnattended: vi.fn(async () => undefined),
  };
  const keys = new ServerKeys({ random: (n) => Buffer.alloc(n, 9) });
  const notices = new ServerNotices({ now: () => 0 });
  const warnings: string[] = [];
  const shutdown = new AbortController();
  const l = attachShell({
    channel: { postMessage: (m) => posted.push(m), on: (_ev, cb) => (onMessage = cb) },
    serve: serve as unknown as ServeService,
    presets: { list: async () => o.presets ?? [] },
    keys,
    notices,
    settings: {
      get: async () => settings,
      subscribe: (fn) => {
        settingsListeners.add(fn);
        return () => settingsListeners.delete(fn);
      },
    },
    hub: {
      subscribe: (fn) => {
        hubListeners.add(fn);
        return () => hubListeners.delete(fn);
      },
    },
    shutdown: shutdown.signal,
    log: { debug: () => {}, info: () => {}, warn: (m) => void warnings.push(m), error: () => {} },
  });
  return {
    l,
    posted,
    serve,
    keys,
    notices,
    warnings,
    shutdown,
    send: (data: unknown) => onMessage({ data }),
    publish: (e: ServerEvent) => hubListeners.forEach((fn) => fn(e)),
    setSettings: (s: Partial<Settings>) => {
      settings = { ...settings, ...s };
      settingsListeners.forEach((fn) => fn());
    },
  };
}

const states = (posted: unknown[]) => posted.filter((m) => (m as { type: string }).type === 'shell-state');

describe('the core ⇄ main link', () => {
  it('sends the state at once, then only when it changes (many changes, one message)', async () => {
    const t = link({ servers: [server()], presets: [preset('p1', 'Chat')] });
    await tick();
    expect(states(t.posted)).toEqual([{ type: 'shell-state', state: expect.objectContaining({ servers: [expect.objectContaining({ port: 8080 })], closeBehavior: 'tray-if-servers' }) }]);
    t.publish({ type: 'servers.changed' });
    t.publish({ type: 'servers.changed' });
    t.publish({ type: 'runs.changed' });
    await tick();
    // Nothing changed: nothing sent.
    expect(states(t.posted)).toHaveLength(1);
    t.setSettings({ closeBehavior: 'tray', language: 'en' });
    await tick();
    expect(states(t.posted)).toHaveLength(2);
    expect((states(t.posted)[1] as { state: { language: string } }).state.language).toBe('en');
    await t.l.push();
    expect(states(t.posted)).toHaveLength(2);
  });

  it('announces each unattended failure once', async () => {
    const t = link();
    await tick();
    t.notices.add('autostart-failed', { id: 'p1', name: 'Chat' }, new Error('x'));
    t.publish({ type: 'servers.changed' });
    await tick();
    t.publish({ type: 'servers.changed' });
    await tick();
    expect(t.posted.filter((m) => (m as { type: string }).type === 'shell-notice')).toEqual([{ type: 'shell-notice', notice: { kind: 'start-failed', name: 'Chat' } }]);
  });

  it('a state that cannot be read is logged, not thrown', async () => {
    const t = link();
    await tick();
    (t.serve as { list: () => ServerInfo[] }).list = () => {
      throw new Error('broken');
    };
    t.publish({ type: 'servers.changed' });
    await tick();
    expect(t.warnings).toEqual(['tray state not sent']);
  });

  it('carries out the tray commands, the start-up presets and the saved key', async () => {
    const t = link({ servers: [server({ presetId: 'p1', presetName: 'Chat' }), server({ id: 'gpubench-2' })] });
    t.send({ type: 'autostart' });
    t.send({ type: 'tray', action: 'stop', id: 'gpubench-1' });
    t.send({ type: 'tray', action: 'restart', id: 'gpubench-1' });
    t.send({ type: 'tray', action: 'restart', id: 'gone' });
    t.send({ type: 'tray', action: 'stop-all' });
    t.send({ type: 'tray', action: 'start-preset', id: 'p1' });
    // Commands without their target, and messages for bootstrap.ts or of unknown shape, are ignored.
    t.send({ type: 'tray', action: 'stop' });
    t.send({ type: 'tray', action: 'restart' });
    t.send({ type: 'tray', action: 'start-preset' });
    t.send({ type: 'shutdown' });
    t.send({ type: 'hf-token', token: null });
    t.send({ type: 'nope' });
    t.send(null);
    t.send({ type: 'server-api-key', key: 'gpub-saved-key-0123456789', storage: 'encrypted' });
    await tick();
    expect(t.serve.autoStart).toHaveBeenCalledTimes(1);
    expect(t.serve.stop).toHaveBeenCalledWith('gpubench-1');
    expect(t.serve.restart).toHaveBeenCalledTimes(1);
    expect(t.serve.restart).toHaveBeenCalledWith('gpubench-1', t.shutdown.signal);
    expect(t.serve.stopAll).toHaveBeenCalledTimes(1);
    expect(t.serve.startUnattended).toHaveBeenCalledWith('p1', 'tray-start-failed', t.shutdown.signal);
    expect(t.keys.current()).toEqual({ key: 'gpub-saved-key-0123456789', storage: 'encrypted' });
  });

  it('failures of tray commands: logged, a failed restart becomes a notice (not while quitting)', async () => {
    const t = link({ servers: [server({ presetId: 'p1', presetName: 'Chat' }), server({ id: 'gpubench-2' })] });
    t.serve.stop.mockRejectedValueOnce(new Error('gone'));
    t.serve.autoStart.mockRejectedValueOnce(new Error('broken'));
    t.serve.restart.mockRejectedValue(new Error('oom'));
    t.send({ type: 'tray', action: 'stop', id: 'gpubench-1' });
    t.send({ type: 'autostart' });
    t.send({ type: 'tray', action: 'restart', id: 'gpubench-1' });
    t.send({ type: 'tray', action: 'restart', id: 'gpubench-2' });
    await tick();
    expect(t.warnings).toEqual(['tray: stop failed', 'tray: autostart failed']);
    expect(t.notices.list().map((n) => [n.kind, n.name, n.presetId])).toEqual([
      ['tray-start-failed', 'Qwen3 8B', undefined],
      ['tray-start-failed', 'Chat', 'p1'],
    ]);
    t.shutdown.abort();
    t.send({ type: 'tray', action: 'restart', id: 'gpubench-2' });
    await tick();
    expect(t.notices.list()).toHaveLength(2);
  });
});
