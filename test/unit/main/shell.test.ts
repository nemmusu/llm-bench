import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MAX_SAVE_BYTES, startShell, titleBarColors } from '../../../src/main/shell';
import { started, tick, world } from './harness';

describe('title bar colours', () => {
  it('match the renderer canvas in both themes', () => {
    expect(titleBarColors(true).color).toBe('#0b0d12');
    expect(titleBarColors(false).color).toBe('#f4f5f8');
  });
});

describe('startShell', () => {
  it('quits at once when another LLM Bench is already open', () => {
    const w = world({ lock: false, env: { GPUBENCH_USER_DATA: '/tmp/ud' } });
    const s = startShell(w.e, w.h);
    expect(w.calls.quit).toBe(1);
    expect(w.calls.setPath).toEqual([['userData', '/tmp/ud']]);
    expect(s.core).toBeUndefined();
  });

  it('starts the core, passes the HF token, opens the window on the core URL', async () => {
    const t = await started({ tokenFile: Buffer.from('enc:hf_saved') });
    const fork = t.forks[0]!;
    expect(fork.modulePath).toBe(path.join('/app/out/main', '../core/index.cjs'));
    expect(fork.opts.env).toMatchObject({ GPUBENCH_TOKEN: t.s.token, GPUBENCH_DATA_DIR: '/user', GPUBENCH_RESOURCES_DIR: path.resolve('/app/out/main', '../../resources') });
    await vi.waitFor(() => expect(t.proc.posted).toContainEqual({ type: 'hf-token', token: 'hf_saved' }));
    expect(t.win.opts).toMatchObject({ backgroundColor: '#f4f5f8', titleBarOverlay: { color: '#f4f5f8', height: 40 } });
    // Core output is forwarded; non-ready messages are ignored.
    t.proc.stdout.emit('data', Buffer.from('o'));
    t.proc.stderr.emit('data', Buffer.from('e'));
    t.proc.emit('message', { type: 'ready' });
    t.proc.emit('message', null);
    expect(t.out.map(String)).toEqual(['o', 'e']);
    // Shown when ready unless hidden for tests.
    t.win.events.get('ready-to-show')!();
    expect(t.win.shown).toBe(1);
  });

  it('packaged app: resources in app-resources, dark theme, hidden window for tests', async () => {
    const t = await started({ packaged: true, dark: true, secure: false, tokenFile: Buffer.from('plain_token'), env: { GPUBENCH_HIDE_WINDOW: '1' } });
    expect(t.forks[0]!.opts.env).toMatchObject({ GPUBENCH_RESOURCES_DIR: path.join('/res', 'app-resources') });
    expect(t.win.opts).toMatchObject({ backgroundColor: '#0b0d12', icon: path.join('/res', 'app-resources', 'icons', 'icon.png') });
    await vi.waitFor(() => expect(t.proc.posted).toContainEqual({ type: 'hf-token', token: 'plain_token' }));
    t.win.events.get('ready-to-show')!();
    expect(t.win.shown).toBe(0);
  });

  it('sends no token when none is saved, then asks for the start-up presets', async () => {
    const t = await started();
    await vi.waitFor(() => expect(t.proc.posted).toEqual([{ type: 'hf-token', token: null }, { type: 'autostart' }]));
  });

  it('keeps navigation inside the app and opens only https links outside', async () => {
    const t = await started();
    const prevented: string[] = [];
    const nav = t.win.wc.get('will-navigate')!;
    nav({ preventDefault: () => prevented.push('a') }, 'http://127.0.0.1:4321/#/results');
    nav({ preventDefault: () => prevented.push('b') }, 'https://evil.example/');
    expect(prevented).toEqual(['b']);
    expect(t.win.openHandler!({ url: 'https://huggingface.co/x' })).toEqual({ action: 'deny' });
    expect(t.win.openHandler!({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' });
    expect(t.calls.openExternal).toEqual(['https://huggingface.co/x']);
  });

  it('IPC: connection, pickers, links, reveal and title bar', async () => {
    const t = await started();
    expect(t.invoke('gpubench:connection')).toEqual({ baseUrl: 'http://127.0.0.1:4321', token: t.s.token });
    expect(await t.invoke('gpubench:pick-file', { title: 'Scegli', filters: [{ name: 'exe', extensions: ['exe'] }] })).toBe('/picked');
    expect(await t.invoke('gpubench:pick-file')).toBe('/picked');
    expect(await t.invoke('gpubench:pick-folder', { title: 'Cartella' })).toBe('/picked');
    expect(await t.invoke('gpubench:pick-folder')).toBe('/picked');
    t.dialogs.open = { canceled: true, filePaths: [] };
    expect(await t.invoke('gpubench:pick-file')).toBeNull();
    expect(await t.invoke('gpubench:pick-folder')).toBeNull();
    t.dialogs.open = { canceled: false, filePaths: [] };
    expect(await t.invoke('gpubench:pick-file')).toBeNull();
    expect(await t.invoke('gpubench:pick-folder')).toBeNull();
    await t.invoke('gpubench:open-external', 'https://nvidia.com/drivers');
    await t.invoke('gpubench:open-external', 'javascript:alert(1)');
    await t.invoke('gpubench:open-external', 42);
    expect(t.calls.openExternal).toEqual(['https://nvidia.com/drivers']);
    t.invoke('gpubench:reveal', 'C:\\models\\x.gguf');
    t.invoke('gpubench:reveal', '');
    t.invoke('gpubench:reveal', 7);
    expect(t.calls.reveal).toEqual(['C:\\models\\x.gguf']);
    t.invoke('gpubench:titlebar-theme', { background: '#000', symbols: '#fff' });
    expect(t.win.overlay).toEqual({ color: '#000', symbolColor: '#fff', height: 40 });
  });

  it('IPC: title bar colours only on Windows', async () => {
    const t = await started({ platform: 'linux' });
    t.invoke('gpubench:titlebar-theme', { background: '#000', symbols: '#fff' });
    expect(t.win.overlay).toBeUndefined();
  });

  it('IPC: HF token saved encrypted (or plain when the OS has no keyring) and cleared', async () => {
    const t = await started();
    expect(await t.invoke('gpubench:hf-token-save', 'hf_abc')).toEqual({ ok: true, secure: true });
    expect(String(t.files.get(path.join('/user', 'hf-token.bin')))).toBe('enc:hf_abc');
    expect(t.proc.posted).toContainEqual({ type: 'hf-token', token: 'hf_abc' });
    expect(await t.invoke('gpubench:hf-token-save', 5)).toEqual({ ok: false, secure: false });
    expect(await t.invoke('gpubench:hf-token-save', 'x'.repeat(513))).toEqual({ ok: false, secure: false });
    await t.invoke('gpubench:hf-token-clear');
    expect(t.files.has(path.join('/user', 'hf-token.bin'))).toBe(false);
    expect(t.proc.posted).toContainEqual({ type: 'hf-token', token: null });
    const plain = await started({ secure: false });
    expect(await plain.invoke('gpubench:hf-token-save', 'hf_x')).toEqual({ ok: true, secure: false });
    // Linux without a keyring: Electron's built-in key is no protection, the UI must warn.
    const basic = await started({ platform: 'linux', backend: 'basic_text' });
    expect(await basic.invoke('gpubench:hf-token-save', 'hf_y')).toEqual({ ok: true, secure: false });
    const keyring = await started({ platform: 'linux', backend: 'gnome_libsecret' });
    expect(await keyring.invoke('gpubench:hf-token-save', 'hf_z')).toEqual({ ok: true, secure: true });
  });

  it('IPC: exports saved through the native dialog, inputs validated', async () => {
    const t = await started();
    expect(await t.invoke('gpubench:save-file', { defaultName: '../../r.csv', content: 'a;b', filters: [{ name: 'CSV', extensions: ['csv'] }] })).toBe('/saved.csv');
    expect(t.files.get('/saved.csv')).toBe('a;b');
    expect(await t.invoke('gpubench:save-file', { defaultName: 'r.json', content: '{}' })).toBe('/saved.csv');
    expect(await t.invoke('gpubench:save-file', undefined)).toBeNull();
    expect(await t.invoke('gpubench:save-file', { defaultName: 1, content: 'x' })).toBeNull();
    expect(await t.invoke('gpubench:save-file', { defaultName: 'x', content: 2 })).toBeNull();
    expect(await t.invoke('gpubench:save-file', { defaultName: 'x', content: 'y'.repeat(MAX_SAVE_BYTES + 1) })).toBeNull();
    t.dialogs.save = { canceled: true };
    expect(await t.invoke('gpubench:save-file', { defaultName: 'x', content: 'y' })).toBeNull();
    t.dialogs.save = { canceled: false };
    expect(await t.invoke('gpubench:save-file', { defaultName: 'x', content: 'y' })).toBeNull();
  });

  it('a second launch shows, restores and focuses the existing window (from the tray too)', async () => {
    const t = await started();
    t.appEvents.get('second-instance')!();
    expect(t.win.shown).toBe(1);
    t.win.minimized = true;
    t.appEvents.get('second-instance')!();
    expect(t.win.focused).toBe(2);
    expect(t.win.restored).toBe(1);
    // Already visible: not shown again.
    expect(t.win.shown).toBe(1);
    const early = world();
    startShell(early.e, early.h);
    expect(() => early.appEvents.get('second-instance')!()).not.toThrow();
  });

  it('the core failing at start-up explains it and exits', async () => {
    const w = world();
    startShell(w.e, w.h);
    w.readyResolve();
    await tick();
    w.proc.emit('exit', 3);
    await vi.waitFor(() => expect(w.calls.exit).toEqual([1]));
    expect(w.errors[0]).toContain('core exited with code 3');
  });

  it('a core crash later shows a message and relaunches the app', async () => {
    const t = await started();
    t.proc.emit('exit', 9);
    expect(t.errors[0]).toContain('codice 9');
    expect(t.calls.relaunch).toBe(1);
    expect(t.calls.exit).toEqual([1]);
    expect(t.s.core).toBeUndefined();
  });

  it('quitting asks the core to shut down, then quits (forcing it after a timeout)', async () => {
    const t = await started({ env: { NODE_V8_COVERAGE: '/cov' } });
    let prevented = 0;
    const beforeQuit = t.appEvents.get('before-quit')!;
    beforeQuit({ preventDefault: () => prevented++ });
    expect(t.proc.posted).toContainEqual({ type: 'shutdown' });
    t.proc.emit('exit', 0);
    await vi.waitFor(() => expect(t.calls.quit).toBe(1));
    expect(t.coverage()).toBe(1);
    expect(t.tray!.destroyed).toBe(true);
    // The second before-quit (from app.quit) goes through.
    beforeQuit({ preventDefault: () => prevented++ });
    expect(prevented).toBe(1);

    const slow = await started({ timeoutMs: 5 });
    slow.appEvents.get('before-quit')!({ preventDefault: () => {} });
    await vi.waitFor(() => expect(slow.proc.killed).toBe(true));
    await vi.waitFor(() => expect(slow.calls.quit).toBe(1));
    expect(slow.coverage()).toBe(0);

    const noCore = world();
    startShell(noCore.e, noCore.h);
    noCore.appEvents.get('before-quit')!({ preventDefault: () => {} });
    await vi.waitFor(() => expect(noCore.calls.quit).toBe(1));
  });

  it('closing the last window quits', async () => {
    const t = await started();
    t.appEvents.get('window-all-closed')!();
    expect(t.calls.quit).toBe(1);
  });

  it('a core exit during quit is expected', async () => {
    const t = await started();
    t.appEvents.get('before-quit')!({ preventDefault: () => {} });
    t.proc.emit('exit', 0);
    expect(t.errors).toEqual([]);
    expect(t.calls.relaunch).toBe(0);
  });

  it('uses the default shutdown grace period: 4 s, 20 s while servers run (they are stopped first)', async () => {
    for (const [servers, grace] of [
      [false, 4000],
      [true, 20_000],
    ] as const) {
      const w = world();
      delete w.h.shutdownTimeoutMs;
      vi.useFakeTimers();
      try {
        startShell(w.e, w.h);
        w.readyResolve();
        await vi.advanceTimersByTimeAsync(0);
        w.proc.emit('message', { type: 'ready', port: 1 });
        await vi.advanceTimersByTimeAsync(0);
        if (servers) {
          w.proc.emit('message', {
            type: 'shell-state',
            state: { servers: [{ id: 's', modelName: 'm', port: 8080, url: 'u', status: 'ready', network: 'local' }], presets: [], closeBehavior: 'tray-if-servers', launchAtLogin: false, language: 'it' },
          });
        }
        w.appEvents.get('before-quit')!({ preventDefault: () => {} });
        await vi.advanceTimersByTimeAsync(grace - 1);
        expect(w.proc.killed).toBe(false);
        await vi.advanceTimersByTimeAsync(2);
        expect(w.proc.killed).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    }
  });
});
