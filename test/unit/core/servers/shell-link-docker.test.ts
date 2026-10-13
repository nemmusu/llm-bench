import { describe, expect, it, vi } from 'vitest';
import type { ShellDocker } from '../../../../src/contract/servers';
import { defaultSettings } from '../../../../src/contract/settings';
import { ServerKeys } from '../../../../src/core/servers/api-key';
import { ServerNotices } from '../../../../src/core/servers/notices';
import type { ServeService } from '../../../../src/core/servers/service';
import { attachShell, shellStateOf, type ShellLinkDeps } from '../../../../src/core/servers/shell-link';
import { tick } from './helpers';

function link(docker?: ShellLinkDeps['docker']) {
  const posted: { type: string; [k: string]: unknown }[] = [];
  let onMessage!: (e: { data: unknown }) => void;
  attachShell({
    channel: { postMessage: (m) => posted.push(m as { type: string }), on: (_ev, cb) => (onMessage = cb) },
    serve: { list: () => [], autoStart: async () => undefined } as unknown as ServeService,
    presets: { list: async () => [] },
    keys: new ServerKeys({ random: (n) => Buffer.alloc(n, 9) }),
    notices: new ServerNotices({ now: () => 0 }),
    settings: { get: async () => defaultSettings(), subscribe: () => () => {} },
    hub: { subscribe: () => () => {} },
    shutdown: new AbortController().signal,
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    ...(docker ? { docker } : {}),
  });
  return { posted, send: (data: unknown) => onMessage({ data }) };
}

describe('Docker in the tray', () => {
  it('the state carries Docker when it is known', () => {
    const d: ShellDocker = { state: 'not-responding', control: true };
    expect(shellStateOf([], [], defaultSettings(), d).docker).toEqual(d);
    expect('docker' in shellStateOf([], [], defaultSettings())).toBe(false);
  });

  it("Docker's changes are sent, its commands carried out, a stuck Docker announced", async () => {
    let state: ShellDocker | undefined = { state: 'running', control: true };
    const changed = new Set<() => void>();
    const stuck = new Set<() => void>();
    const docker = {
      shell: () => state,
      subscribe: (fn: () => void) => (changed.add(fn), () => changed.delete(fn)),
      onStuck: (fn: () => void) => (stuck.add(fn), () => stuck.delete(fn)),
      start: vi.fn(() => true),
      restart: vi.fn(() => true),
    };
    const t = link(docker);
    await tick();
    expect(t.posted.filter((m) => m.type === 'shell-state').at(-1)).toMatchObject({ state: { docker: { state: 'running', control: true } } });
    state = { state: 'not-responding', control: true };
    changed.forEach((fn) => fn());
    await tick();
    expect(t.posted.filter((m) => m.type === 'shell-state').at(-1)).toMatchObject({ state: { docker: { state: 'not-responding' } } });
    stuck.forEach((fn) => fn());
    expect(t.posted.at(-1)).toEqual({ type: 'shell-notice', notice: { kind: 'docker-stuck' } });
    t.send({ type: 'tray', action: 'docker-restart' });
    t.send({ type: 'tray', action: 'docker-start' });
    expect(docker.restart).toHaveBeenCalledTimes(1);
    expect(docker.start).toHaveBeenCalledTimes(1);
  });

  it('without Docker control (tests of the rest) its commands do nothing', async () => {
    const t = link();
    t.send({ type: 'tray', action: 'docker-restart' });
    t.send({ type: 'tray', action: 'docker-start' });
    await tick();
    expect(t.posted.filter((m) => m.type === 'shell-notice')).toEqual([]);
  });
});
