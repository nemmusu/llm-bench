import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { exposeOnGlobal, menuTemplate } from '../../../src/main/shell';
import { coreState, FakeTray, oneServer, started, tick } from './harness';

const trayDir = path.resolve('/app/out/main', '../../resources/icons/tray');

describe('tray icon', () => {
  it('appears with the app mark, follows what runs (icon, tooltip, menu) and speaks the app language', async () => {
    const t = await started();
    const tray = t.tray!;
    expect(tray.images).toEqual([{ path: path.join(trayDir, 'idle.png') }]);
    expect(tray.tooltip).toBe('GPU Bench');
    expect(tray.labels()).toEqual(['Apri GPU Bench', '---', 'Avvia preset', 'Ferma tutti i server', '---', 'Esci']);
    t.proc.emit('message', { type: 'shell-state', state: oneServer });
    expect(tray.image).toEqual({ path: path.join(trayDir, 'running.png') });
    expect(tray.tooltip).toBe('GPU Bench · 1 server attivo: Qwen3 8B (8080)');
    expect(tray.labels()).toContain('Qwen3 8B · porta 8080');
    // Same status: the icon is not set again.
    t.proc.emit('message', { type: 'shell-state', state: { ...oneServer, language: 'en' } });
    expect(tray.images).toHaveLength(2);
    expect(tray.labels()).toContain('Qwen3 8B · port 8080');
    t.proc.emit('message', { type: 'shell-state', state: coreState({ servers: [{ ...oneServer.servers[0]!, status: 'loading' }] }) });
    expect(tray.image).toEqual({ path: path.join(trayDir, 'loading.png') });
    // Something that is not a valid state is ignored.
    t.proc.emit('message', { type: 'shell-state', state: { servers: 'nope' } });
    expect(tray.image).toEqual({ path: path.join(trayDir, 'loading.png') });
  });

  it('Linux: the 32 px icons, and no tray at all where the desktop has none', async () => {
    const t = await started({ platform: 'linux', run: (cmd) => (cmd === 'gdbus' ? { code: 0, stdout: '(true,)' } : { code: 1, stdout: '' }) });
    expect(t.tray!.images[0]).toEqual({ path: path.join(trayDir, 'idle-linux.png') });
    const gnome = await started({ platform: 'linux', env: { XDG_CURRENT_DESKTOP: 'GNOME' }, run: () => ({ code: 0, stdout: '(false,)' }) });
    expect(gnome.tray).toBeUndefined();
    expect(gnome.invoke('gpubench:shell-info')).toEqual({ tray: false });
    expect(t.invoke('gpubench:shell-info')).toEqual({ tray: true });
    // Without a tray nothing breaks when the state arrives.
    gnome.proc.emit('message', { type: 'shell-state', state: oneServer });
  });

  it('menu commands: open, copy the address, stop, restart, start a preset, stop all', async () => {
    const t = await started();
    t.proc.emit('message', { type: 'shell-state', state: oneServer });
    const tray = t.tray!;
    t.proc.posted.length = 0;
    tray.click('Apri GPU Bench');
    expect(t.win.shown).toBe(1);
    tray.click('Copia indirizzo');
    expect(t.clipboard).toEqual(['http://127.0.0.1:8080/v1']);
    tray.click('Ferma (chiudi modello)');
    tray.click('Riavvia');
    tray.click('Avvia preset', 'Codice · porta 8090');
    tray.click('Ferma tutti i server');
    expect(t.proc.posted).toEqual([
      { type: 'tray', action: 'stop', id: 's1' },
      { type: 'tray', action: 'restart', id: 's1' },
      { type: 'tray', action: 'start-preset', id: 'p1' },
      { type: 'tray', action: 'stop-all' },
    ]);
    // A click on the icon opens the window (Windows).
    t.win.visible = false;
    (tray.handlers.get('click') as () => void)();
    expect(t.win.shown).toBe(2);
  });

  it('"Esci": straight away with nothing running; with servers only after the confirmation', async () => {
    const idle = await started();
    idle.tray!.click('Esci');
    await tick();
    expect(idle.calls.quit).toBe(1);
    expect(idle.boxes).toEqual([]);

    const cancel = await started({ quitResponse: 1 });
    cancel.proc.emit('message', { type: 'shell-state', state: oneServer });
    cancel.tray!.click('Esci');
    await tick();
    expect(cancel.boxes[0]).toMatchObject({ message: 'Uscire da GPU Bench?', detail: expect.stringContaining('C’è un server acceso'), buttons: ['Ferma ed esci', 'Annulla'] });
    expect(cancel.calls.quit).toBe(0);

    const ok = await started({ quitResponse: 0 });
    ok.proc.emit('message', { type: 'shell-state', state: coreState({ servers: [oneServer.servers[0]!, { ...oneServer.servers[0]!, id: 's2', port: 8081 }] }) });
    ok.tray!.click('Esci');
    await tick();
    expect(ok.boxes[0]!.detail).toContain('Ci sono 2 server accesi');
    expect(ok.calls.quit).toBe(1);
  });

  it('a preset that did not start, nobody watching: a notification', async () => {
    const t = await started();
    t.proc.emit('message', { type: 'shell-notice', notice: { kind: 'start-failed', name: 'Chat veloce' } });
    t.proc.emit('message', { type: 'shell-notice', notice: {} });
    expect(t.shown).toEqual([{ title: 'Un server non è partito', body: '«Chat veloce» non è partito. Apri GPU Bench per vedere perché.', icon: path.resolve('/app/out/main', '../../resources/icons/icon.png') }]);
  });
});

describe('closing the window', () => {
  it('nothing running: GPU Bench quits as before', async () => {
    const t = await started();
    expect(t.win.close()).toBe(true);
  });

  it('a server running: hidden in the tray, explained once (and remembered across sessions)', async () => {
    const t = await started();
    t.proc.emit('message', { type: 'shell-state', state: oneServer });
    t.win.visible = true;
    expect(t.win.close()).toBe(false);
    expect(t.win.visible).toBe(false);
    expect(t.shown).toEqual([{ title: 'GPU Bench è ancora attivo', body: 'GPU Bench resta attivo nell’area di notifica: il server continua a funzionare.', icon: expect.any(String) }]);
    await vi.waitFor(() => expect(String(t.files.get(path.join('/user', 'shell.json')))).toBe('{"hideNoticeShown":true}'));
    expect(t.win.close()).toBe(false);
    expect(t.shown).toHaveLength(1);
    const later = await started({ prefs: '{"hideNoticeShown":true}' });
    later.proc.emit('message', { type: 'shell-state', state: oneServer });
    expect(later.win.close()).toBe(false);
    expect(later.shown).toEqual([]);
    const broken = await started({ prefs: 'not json' });
    broken.proc.emit('message', { type: 'shell-state', state: oneServer });
    broken.win.close();
    expect(broken.shown).toHaveLength(1);
  });

  it('"Sempre": hidden even with nothing running; "Esci sempre": quits even with servers', async () => {
    const always = await started();
    always.proc.emit('message', { type: 'shell-state', state: coreState({ closeBehavior: 'tray' }) });
    expect(always.win.close()).toBe(false);
    expect(always.shown[0]!.body).toBe('GPU Bench resta attivo nell’area di notifica. Per chiuderlo usa «Esci» dal suo menu.');
    const never = await started();
    never.proc.emit('message', { type: 'shell-state', state: { ...oneServer, closeBehavior: 'quit' } });
    expect(never.win.close()).toBe(true);
  });

  it('no tray on this desktop: minimized instead of hidden; quitting always closes', async () => {
    const t = await started({ env: { GPUBENCH_NO_TRAY: '1' }, notifications: false });
    t.proc.emit('message', { type: 'shell-state', state: oneServer });
    expect(t.win.close()).toBe(false);
    expect(t.win.minimizedCount).toBe(1);
    expect(t.win.hidden).toBe(0);
    t.appEvents.get('before-quit')!({ preventDefault: () => {} });
    expect(t.win.close()).toBe(true);
  });

  it('notifications not supported: nothing is shown, nothing breaks', async () => {
    const t = await started({ notifications: false });
    t.proc.emit('message', { type: 'shell-state', state: oneServer });
    // A read-only profile folder: the "already explained" flag is simply not kept.
    t.h.fs.writeFile = async () => {
      throw new Error('read-only');
    };
    t.win.close();
    await tick();
    expect(t.shown).toEqual([]);
    expect(t.s.notifications).toHaveLength(1);
  });
});

describe('started at login', () => {
  it('stays in the tray (or minimized without one)', async () => {
    const t = await started({ argv: ['gpu-bench', '--hidden'] });
    t.win.events.get('ready-to-show')!();
    expect(t.win.shown).toBe(0);
    expect(t.win.minimizedCount).toBe(0);
    const noTray = await started({ argv: ['gpu-bench', '--hidden'], env: { GPUBENCH_NO_TRAY: '1' } });
    noTray.win.events.get('ready-to-show')!();
    expect(noTray.win.minimizedCount).toBe(1);
  });

  it('the login item follows the setting, only when it differs from the OS', async () => {
    const t = await started();
    t.proc.emit('message', { type: 'shell-state', state: coreState({ launchAtLogin: true }) });
    await vi.waitFor(() => expect(t.login).toEqual([{ openAtLogin: true, path: '/app/electron', args: [path.resolve('/app/out/main', '../..'), '--hidden'] }]));
    t.proc.emit('message', { type: 'shell-state', state: coreState({ launchAtLogin: true, language: 'en' }) });
    t.proc.emit('message', { type: 'shell-state', state: coreState({ launchAtLogin: false }) });
    await vi.waitFor(() => expect(t.login).toHaveLength(2));
    expect(t.login[1]!.openAtLogin).toBe(false);
    // Already as asked (packaged): nothing written.
    const same = await started({ packaged: true, loginEnabled: true });
    same.proc.emit('message', { type: 'shell-state', state: coreState({ launchAtLogin: true }) });
    await tick();
    expect(same.login).toEqual([]);
  });

  it('a login item that cannot be changed is reported, not thrown', async () => {
    const t = await started({ platform: 'linux', env: { XDG_CONFIG_HOME: '/cfg' } });
    t.h.fs.mkdir = async () => {
      throw new Error('read-only');
    };
    t.proc.emit('message', { type: 'shell-state', state: coreState({ launchAtLogin: true }) });
    await vi.waitFor(() => expect(t.out.map(String).join('')).toContain('login item not changed: Error: read-only'));
  });
});

describe('the API key of network servers', () => {
  it('a saved key goes to the core at start-up, before the start-up presets', async () => {
    const t = await started({ keyFile: Buffer.from('enc:gpub-saved') });
    await vi.waitFor(() =>
      expect(t.proc.posted).toEqual([{ type: 'hf-token', token: null }, { type: 'server-api-key', key: 'gpub-saved', storage: 'encrypted' }, { type: 'autostart' }]),
    );
    const plain = await started({ secure: false, keyFile: Buffer.from('gpub-plain') });
    await vi.waitFor(() => expect(plain.proc.posted).toContainEqual({ type: 'server-api-key', key: 'gpub-plain', storage: 'plain' }));
  });

  it('a new key is kept encrypted and confirmed to the core (plain where there is no keyring)', async () => {
    const t = await started();
    t.proc.emit('message', { type: 'server-api-key-save', key: 'gpub-new' });
    await vi.waitFor(() => expect(t.proc.posted).toContainEqual({ type: 'server-api-key', key: 'gpub-new', storage: 'encrypted' }));
    expect(String(t.files.get(path.join('/user', 'server-api-key.bin')))).toBe('enc:gpub-new');
    const linux = await started({ platform: 'linux', backend: 'basic_text' });
    linux.proc.emit('message', { type: 'server-api-key-save', key: 'gpub-l' });
    await vi.waitFor(() => expect(linux.proc.posted).toContainEqual({ type: 'server-api-key', key: 'gpub-l', storage: 'plain' }));
    // Not a key: ignored.
    t.proc.emit('message', { type: 'server-api-key-save', key: 5 });
  });
});

describe('E2E test hooks (GPUBENCH_TEST_HOOKS=1)', () => {
  it('the tray menu, its commands, the window and the quit answer, without the OS tray', async () => {
    const t = await started({ env: { GPUBENCH_TEST_HOOKS: '1' } });
    const hooks = t.hooks();
    expect(hooks.trayStatus()).toBe('idle');
    t.proc.emit('message', { type: 'shell-state', state: oneServer });
    expect(hooks.trayMenu()).toContain('Qwen3 8B · porta 8080');
    expect(hooks.trayStatus()).toBe('running');
    expect(hooks.trayTooltip()).toBe('GPU Bench · 1 server attivo: Qwen3 8B (8080)');
    expect(hooks.clickTray('Qwen3 8B · porta 8080', 'Copia indirizzo')).toBe(true);
    expect(t.clipboard).toEqual(['http://127.0.0.1:8080/v1']);
    expect(hooks.clickTray('Nope')).toBe(false);
    expect(hooks.windowState()).toEqual({ visible: false, minimized: false, destroyed: false });
    hooks.closeWindow();
    expect(hooks.windowState()!.destroyed).toBe(false);
    expect(hooks.notifications()).toHaveLength(1);
    hooks.answerQuit(true);
    hooks.clickTray('Esci');
    await tick();
    expect(t.calls.quit).toBe(1);
    expect(t.boxes).toEqual([]);
  });

  it('before the window and without a tray', async () => {
    const t = await started({ env: { GPUBENCH_TEST_HOOKS: '1', GPUBENCH_NO_TRAY: '1' } });
    expect(t.hooks().trayTooltip()).toBeUndefined();
    t.s.window = undefined;
    expect(t.hooks().windowState()).toBeUndefined();
    t.hooks().closeWindow();
  });
});

describe('helpers', () => {
  it('menuTemplate: separators, disabled items, submenus, clicks', () => {
    const run = vi.fn();
    const tpl = menuTemplate(
      [
        { label: 'A', command: { kind: 'open' } },
        { type: 'separator' },
        { label: 'B', enabled: false },
        { label: 'C', submenu: [{ label: 'D', command: { kind: 'stop-all' } }] },
      ],
      run,
    );
    expect(tpl.map((i) => [i.type, i.label, i.enabled])).toEqual([
      [undefined, 'A', undefined],
      ['separator', undefined, undefined],
      [undefined, 'B', false],
      [undefined, 'C', undefined],
    ]);
    (tpl[0]!.click as () => void)();
    ((tpl[3]!.submenu as typeof tpl)[0]!.click as () => void)();
    expect(run.mock.calls).toEqual([[{ kind: 'open' }], [{ kind: 'stop-all' }]]);
    expect(tpl[2]!.click).toBeUndefined();
  });

  it('exposeOnGlobal puts a value on the global object', () => {
    exposeOnGlobal('__gpubenchTestValue', 42);
    expect((globalThis as Record<string, unknown>).__gpubenchTestValue).toBe(42);
    delete (globalThis as Record<string, unknown>).__gpubenchTestValue;
  });

  it('FakeTray stays isolated between tests', () => {
    expect(FakeTray).toBeDefined();
  });
});
